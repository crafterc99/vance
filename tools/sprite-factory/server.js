#!/usr/bin/env node
/**
 * Sprite Factory — Local Web Server
 *
 * Provides a web UI for the entire sprite generation pipeline:
 * - Upload video → extract frames → smart select → build strip
 * - Generate sprites via Nano Banana Pro API
 * - Process, preview, and export to Soul Jam
 * - Train prompt quality with feedback loops
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3456;
const ASSETS_DIR = path.resolve(__dirname, '../../../soul-jam/public/assets/images');
const RAW_DIR = path.resolve(__dirname, '../../raw-sprites');
const TMP_DIR = path.resolve(__dirname, '../../.video-tmp');

// Import tools
const { NanaBananaClient } = require('../sprite-generator/nano-banana');
const { CHARACTERS, ANIMATIONS, buildPoseTransferPrompt, buildFilmToSpritePrompt, trainPrompt, loadTraining } = require('../sprite-generator/prompts');
const { processSprite, buildGrid, SOUL_JAM_ASSETS } = require('../sprite-processor/index');
const { smartSelect, detectBall, loadFeedback, recordFeedback } = require('../sprite-generator/smart-selector');
const { extract } = require('../sprite-generator/video-extractor');
const { buildRefStrip } = require('../sprite-generator/strip-builder');

// Serve static files
function serveStatic(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(fs.readFileSync(filePath));
}

// JSON response helper
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Parse JSON body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// Serve image as base64
function serveImage(res, imagePath) {
  if (!fs.existsSync(imagePath)) {
    json(res, { error: 'Image not found' }, 404);
    return;
  }
  const data = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(data);
}

// ─── API Routes ─────────────────────────────────────────────────────────

async function handleAPI(req, res, pathname) {
  // GET /api/characters
  if (pathname === '/api/characters' && req.method === 'GET') {
    return json(res, { characters: CHARACTERS, animations: ANIMATIONS });
  }

  // GET /api/sprites/:char
  if (pathname.startsWith('/api/sprites/') && req.method === 'GET') {
    const charName = pathname.split('/')[3];
    const anims = Object.keys(ANIMATIONS);
    const sprites = {};
    for (const anim of anims) {
      const file = `${charName}-${anim}.png`;
      const filePath = path.join(ASSETS_DIR, file);
      sprites[anim] = {
        exists: fs.existsSync(filePath),
        file,
        path: filePath,
        url: `/assets/${file}`,
      };
    }
    return json(res, { character: charName, sprites });
  }

  // POST /api/generate — Generate a single sprite
  if (pathname === '/api/generate' && req.method === 'POST') {
    const body = await parseBody(req);
    const { character, animation, model, customPrompt } = body;

    try {
      const client = new NanaBananaClient({ model: model || 'gemini-2.5-flash-image' });

      let prompt, poseRef, charRef;

      if (customPrompt) {
        prompt = customPrompt;
      } else {
        const data = buildPoseTransferPrompt(character, animation);
        prompt = data.prompt;
      }

      // Pose reference = Breezy's existing strip
      const anim = ANIMATIONS[animation];
      if (anim?.breezyFile) {
        poseRef = path.join(ASSETS_DIR, anim.breezyFile);
      }
      charRef = CHARACTERS[character] ? path.join(ASSETS_DIR, `${character === '99' ? '99' : character}full.png`) : null;

      const frames = anim?.frames || 6;
      let aspectRatio = '16:9';
      if (frames <= 3) aspectRatio = '3:1';
      else if (frames >= 6) aspectRatio = '21:9';

      const outputPath = path.join(RAW_DIR, `${character}-${animation}-raw.png`);
      fs.mkdirSync(RAW_DIR, { recursive: true });

      const result = await client.generateSprite(prompt, poseRef, charRef, {
        aspectRatio,
        resolution: '2K',
        model: model || 'gemini-2.5-flash-image',
        outputPath,
      });

      // Process through pipeline
      const processed = await processSprite(outputPath, `${character}-${animation}`, {
        frameCount: frames,
        targetSize: 180,
        outputDir: ASSETS_DIR,
      });

      return json(res, {
        success: true,
        raw: `/assets/${character}-${animation}-raw.png`,
        processed: `/assets/${character}-${animation}.png`,
        frames: processed.frameCount,
        prompt: prompt.substring(0, 200),
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // POST /api/feedback — Record generation feedback
  if (pathname === '/api/feedback' && req.method === 'POST') {
    const body = await parseBody(req);
    const result = trainPrompt(body.animation, body.rating, body.notes, body);
    return json(res, { success: true, totalIterations: result.totalIterations });
  }

  // GET /api/training — Get training data
  if (pathname === '/api/training' && req.method === 'GET') {
    const training = loadTraining();
    const frameFeedback = loadFeedback();
    return json(res, { prompts: training, frames: frameFeedback });
  }

  // GET /api/grid/:char — Build grid sheet
  if (pathname.startsWith('/api/grid/') && req.method === 'GET') {
    const charName = pathname.split('/')[3];
    try {
      const result = await buildGrid(charName);
      return json(res, { success: true, ...result });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // ─── Video Pipeline ──────────────────────────────────────────────────

  // POST /api/video/upload — Upload video file (multipart binary)
  if (pathname === '/api/video/upload' && req.method === 'POST') {
    try {
      const sessionId = Date.now().toString(36);
      const sessionDir = path.join(TMP_DIR, sessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const videoPath = path.join(sessionDir, 'input.mov');
      const writeStream = fs.createWriteStream(videoPath);
      await new Promise((resolve, reject) => {
        req.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
      const stats = fs.statSync(videoPath);
      return json(res, { sessionId, videoPath, size: stats.size });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // POST /api/video/from-path — Use existing video file on disk
  if (pathname === '/api/video/from-path' && req.method === 'POST') {
    const body = await parseBody(req);
    const { videoPath } = body;
    if (!videoPath || !fs.existsSync(videoPath)) {
      return json(res, { error: 'Video file not found: ' + videoPath }, 400);
    }
    const sessionId = Date.now().toString(36);
    const sessionDir = path.join(TMP_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    // Symlink to avoid copying large files
    const linkPath = path.join(sessionDir, 'input' + path.extname(videoPath));
    fs.copyFileSync(videoPath, linkPath);
    return json(res, { sessionId, videoPath: linkPath, size: fs.statSync(videoPath).size });
  }

  // POST /api/video/extract — Extract frames from uploaded video
  if (pathname === '/api/video/extract' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, fps } = body;
    const sessionDir = path.join(TMP_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) return json(res, { error: 'Session not found' }, 404);

    try {
      const videoFiles = fs.readdirSync(sessionDir).filter(f => /\.(mov|mp4|avi|mkv|webm)$/i.test(f));
      if (!videoFiles.length) return json(res, { error: 'No video in session' }, 400);

      const framesDir = path.join(sessionDir, 'frames');
      fs.mkdirSync(framesDir, { recursive: true });
      const result = await extract(path.join(sessionDir, videoFiles[0]), framesDir, { fps: fps || 10 });
      const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();
      return json(res, { frameCount: frames.length, framesDir, sessionId, frames: frames.map(f => `/api/video/frame/${sessionId}/${f}`) });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // GET /api/video/frame/:session/:file — Serve extracted frame
  if (pathname.startsWith('/api/video/frame/') && req.method === 'GET') {
    const parts = pathname.split('/');
    const sessionId = parts[4];
    const file = parts[5];
    const framePath = path.join(TMP_DIR, sessionId, 'frames', file);
    return serveImage(res, framePath);
  }

  // POST /api/video/smart-select — Smart select key frames
  if (pathname === '/api/video/smart-select' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, count, moveType } = body;
    const framesDir = path.join(TMP_DIR, sessionId, 'frames');
    if (!fs.existsSync(framesDir)) return json(res, { error: 'Frames not found' }, 404);

    try {
      const allFrames = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort().map(f => path.join(framesDir, f));
      const result = await smartSelect(allFrames, count || 6, { moveType });
      // Save selected to session
      const selectDir = path.join(TMP_DIR, sessionId, 'selected');
      fs.mkdirSync(selectDir, { recursive: true });
      result.selected.forEach((framePath, i) => {
        fs.copyFileSync(framePath, path.join(selectDir, `frame-${String(i).padStart(2,'0')}.png`));
      });
      return json(res, {
        count: result.selected.length,
        selectedIndices: result.selectedIndices,
        frames: result.selected.map((framePath, i) => {
          const analysis = result.analysis.find(a => a.path === framePath) || {};
          return {
            index: result.selectedIndices[i],
            url: `/api/video/frame/${sessionId}/${path.basename(framePath)}`,
            selectedUrl: `/api/video/selected/${sessionId}/frame-${String(i).padStart(2,'0')}.png`,
            scores: { ballFound: analysis.ball?.found || false, ballConfidence: analysis.ball?.confidence || 0, ballInflection: analysis.ballInflection || false, motion: analysis.motion || 0, sharpness: analysis.sharpness || 0, total: analysis.score || 0 },
          };
        }),
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // GET /api/video/selected/:session/:file — Serve selected frames
  if (pathname.startsWith('/api/video/selected/') && req.method === 'GET') {
    const parts = pathname.split('/');
    const sessionId = parts[4];
    const file = parts[5];
    return serveImage(res, path.join(TMP_DIR, sessionId, 'selected', file));
  }

  // POST /api/video/strip — Build reference strip from selected frames
  if (pathname === '/api/video/strip' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId } = body;
    const selectDir = path.join(TMP_DIR, sessionId, 'selected');
    if (!fs.existsSync(selectDir)) return json(res, { error: 'No selected frames' }, 404);

    try {
      const frames = fs.readdirSync(selectDir).filter(f => f.endsWith('.png')).sort().map(f => path.join(selectDir, f));
      const stripPath = path.join(TMP_DIR, sessionId, 'ref-strip.png');
      await buildRefStrip(frames, stripPath, { targetHeight: 512 });
      return json(res, { stripUrl: `/api/video/strip-image/${sessionId}`, frameCount: frames.length });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // GET /api/video/strip-image/:session — Serve built strip
  if (pathname.startsWith('/api/video/strip-image/') && req.method === 'GET') {
    const sessionId = pathname.split('/')[4];
    return serveImage(res, path.join(TMP_DIR, sessionId, 'ref-strip.png'));
  }

  // POST /api/video/generate — Film-to-sprite generation from video strip
  if (pathname === '/api/video/generate' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, character, animName, frameCount, model } = body;
    const stripPath = path.join(TMP_DIR, sessionId, 'ref-strip.png');
    if (!fs.existsSync(stripPath)) return json(res, { error: 'Build strip first' }, 400);

    try {
      const count = frameCount || 6;
      const data = buildFilmToSpritePrompt(character, animName || 'custom move', count);
      const client = new NanaBananaClient({ model: model || 'gemini-2.5-flash-image' });

      const charRef = CHARACTERS[character] ? path.join(ASSETS_DIR, `${character === '99' ? '99' : character}full.png`) : null;
      const outputPath = path.join(RAW_DIR, `${character}-${animName || 'custom'}-raw.png`);
      fs.mkdirSync(RAW_DIR, { recursive: true });

      await client.generateSprite(data.prompt, stripPath, charRef, {
        aspectRatio: count >= 6 ? '21:9' : '16:9',
        resolution: '2K',
        model: model || 'gemini-2.5-flash-image',
        outputPath,
      });

      const processed = await processSprite(outputPath, `${character}-${animName || 'custom'}`, {
        frameCount: count,
        targetSize: 180,
        outputDir: ASSETS_DIR,
      });

      return json(res, {
        success: true,
        raw: `/raw/${character}-${animName || 'custom'}-raw.png`,
        processed: `/assets/${character}-${animName || 'custom'}.png`,
        frames: processed.frameCount,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // POST /api/video/feedback — Frame selection feedback
  if (pathname === '/api/video/feedback' && req.method === 'POST') {
    const body = await parseBody(req);
    recordFeedback(body);
    return json(res, { success: true });
  }

  return json(res, { error: 'Not found' }, 404);
}

// ─── Server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // API routes
  if (pathname.startsWith('/api/')) {
    return handleAPI(req, res, pathname);
  }

  // Serve sprite assets
  if (pathname.startsWith('/assets/')) {
    const file = pathname.replace('/assets/', '');
    return serveImage(res, path.join(ASSETS_DIR, file));
  }

  // Serve raw sprites
  if (pathname.startsWith('/raw/')) {
    const file = pathname.replace('/raw/', '');
    return serveImage(res, path.join(RAW_DIR, file));
  }

  // Serve the web UI
  if (pathname === '/' || pathname === '/index.html') {
    return serveStatic(res, path.join(__dirname, 'index.html'), 'text/html');
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  Sprite Factory running at http://localhost:${PORT}\n`);
  console.log(`  Characters: ${Object.keys(CHARACTERS).join(', ')}`);
  console.log(`  Animations: ${Object.keys(ANIMATIONS).length}`);
  console.log(`  API Key: ${process.env.GEMINI_API_KEY ? 'set' : 'NOT SET — export GEMINI_API_KEY'}\n`);
});
