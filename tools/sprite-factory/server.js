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
const { CHARACTERS, ANIMATIONS, buildPoseTransferPrompt, buildFilmToSpritePrompt, buildSingleFramePrompt, trainPrompt, loadTraining } = require('../sprite-generator/prompts');
const { processSprite, buildGrid, cutFrames, upscaleNN, removeBackground, resizeFrame, buildStrip, SOUL_JAM_ASSETS } = require('../sprite-processor/index');
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

// ─── Concurrency Helper ─────────────────────────────────────────────────
async function runWithConcurrency(tasks, concurrency = 2, delayMs = 2000) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      if (i > 0) await new Promise(r => setTimeout(r, delayMs));
      results[i] = await tasks[i]();
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, tasks.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ─── API Routes ─────────────────────────────────────────────────────────

async function handleAPI(req, res, pathname) {
  // GET /api/characters
  if (pathname === '/api/characters' && req.method === 'GET') {
    // Auto-discover characters from *full.png files in assets
    if (fs.existsSync(ASSETS_DIR)) {
      const files = fs.readdirSync(ASSETS_DIR).filter(f => f.endsWith('full.png'));
      for (const f of files) {
        const name = f.replace('full.png', '');
        if (!CHARACTERS[name]) {
          CHARACTERS[name] = {
            description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
            style: '16-bit pixel art, GBA style',
          };
        }
      }
    }
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

  // POST /api/generate — Generate a single sprite (with batch support for 5+ frames)
  if (pathname === '/api/generate' && req.method === 'POST') {
    const body = await parseBody(req);
    const { character, animation, model, customPrompt } = body;

    try {
      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });

      // Auto-register character if they have a portrait but aren't in CHARACTERS yet
      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!CHARACTERS[character] && fs.existsSync(portraitPath)) {
        CHARACTERS[character] = {
          description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
          style: '16-bit pixel art, GBA style',
        };
      }

      const anim = ANIMATIONS[animation];
      const totalFrames = anim?.frames || 6;
      const charRef = fs.existsSync(portraitPath) ? portraitPath : null;
      const poseRef = anim?.breezyFile ? path.join(ASSETS_DIR, anim.breezyFile) : null;

      fs.mkdirSync(RAW_DIR, { recursive: true });

      // BATCH STRATEGY: For 5+ frames, split into batches of 3-4 to preserve quality
      const MAX_FRAMES_PER_BATCH = 4;

      if (totalFrames <= MAX_FRAMES_PER_BATCH || !poseRef) {
        // Small animation — generate all at once
        let prompt;
        if (customPrompt) {
          prompt = customPrompt;
        } else {
          const data = buildPoseTransferPrompt(character, animation);
          prompt = data.prompt;
        }

        const outputPath = path.join(RAW_DIR, `${character}-${animation}-raw.png`);
        await client.generateSprite(prompt, poseRef, charRef, {
          aspectRatio: '16:9',
          resolution: '2K',
          model: modelId,
          outputPath,
        });

        const processed = await processSprite(outputPath, `${character}-${animation}`, {
          frameCount: totalFrames,
          targetSize: 180,
          outputDir: ASSETS_DIR,
        });

        return json(res, {
          success: true,
          raw: `/raw/${character}-${animation}-raw.png`,
          processed: `/assets/${character}-${animation}.png`,
          frames: processed.frameCount,
          batched: false,
        });
      }

      // BATCH MODE: Split Breezy reference strip into sub-strips, generate each batch
      // First, cut the reference strip into individual frames
      const refFramesDir = path.join(RAW_DIR, `${character}-${animation}-ref-frames`);
      fs.mkdirSync(refFramesDir, { recursive: true });

      // Use sprite processor to cut the reference into frames
      const cutResult = await cutFrames(poseRef, refFramesDir, { frameCount: totalFrames });
      const refFramePaths = cutResult.frames;

      // Split frames into batches
      const batches = [];
      for (let i = 0; i < totalFrames; i += MAX_FRAMES_PER_BATCH) {
        const end = Math.min(i + MAX_FRAMES_PER_BATCH, totalFrames);
        batches.push({ start: i, end, count: end - i, frames: refFramePaths.slice(i, end) });
      }

      // Generate each batch — build a mini reference strip for each
      const batchOutputs = [];
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];

        // Build a mini reference strip from this batch's frames
        const miniStripPath = path.join(RAW_DIR, `${character}-${animation}-batch${b}-ref.png`);
        await buildRefStrip(batch.frames, miniStripPath, { targetHeight: 180 });

        // Build batch-specific prompt
        const frameDesc = anim.frameBreakdown || '';
        const batchPrompt = [
          `REPLICATE Image 1 EXACTLY. Keep every body position, pose, limb placement, and composition identical. ONLY replace the character's identity with Image 2.`,
          ``,
          `Image 1 shows ${batch.count} frames of a ${anim.action} animation (frames ${batch.start + 1}-${batch.end} of ${totalFrames}).`,
          `Copy these ${batch.count} frames frame-for-frame — same poses, same spacing — but with Image 2's character.`,
          ``,
          `CRITICAL — BODY POSITION:`,
          `- Body position, pose, and composition in EVERY frame must match Image 1 EXACTLY`,
          `- Same arm positions, leg positions, body angle, ball placement`,
          `- Treat Image 1 as motion capture — do NOT reinterpret`,
          ``,
          `OUTPUT:`,
          `- Single horizontal strip, EXACTLY ${batch.count} frames, equally-sized, no gaps, no borders`,
          `- LARGE detailed characters filling most of each frame's height — NOT tiny`,
          `- Style: 16-bit pixel art, GBA style, bold BLACK pixel outlines around character`,
          `- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds`,
          `- NO green on the character itself`,
          `- Same character size in every frame, feet on same baseline`,
        ].join('\n');

        const batchOutputPath = path.join(RAW_DIR, `${character}-${animation}-batch${b}-raw.png`);
        await client.generateSprite(batchPrompt, miniStripPath, charRef, {
          aspectRatio: '16:9',
          resolution: '2K',
          model: modelId,
          outputPath: batchOutputPath,
        });

        // Process this batch
        const batchProcessed = await processSprite(batchOutputPath, `${character}-${animation}-batch${b}`, {
          frameCount: batch.count,
          targetSize: 180,
          outputDir: RAW_DIR,
        });

        batchOutputs.push(batchProcessed);
      }

      // Combine all batch frame directories into final strip
      const allFramePaths = [];
      for (let b = 0; b < batchOutputs.length; b++) {
        const framesDir = batchOutputs[b].framesDir;
        if (fs.existsSync(framesDir)) {
          const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();
          frameFiles.forEach(f => allFramePaths.push(path.join(framesDir, f)));
        }
      }

      // Build final combined strip
      const finalStripPath = path.join(ASSETS_DIR, `${character}-${animation}.png`);
      await buildRefStrip(allFramePaths, finalStripPath, { targetHeight: 180 });

      return json(res, {
        success: true,
        processed: `/assets/${character}-${animation}.png`,
        frames: allFramePaths.length,
        batched: true,
        batchCount: batches.length,
        batchSizes: batches.map(b => b.count),
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // POST /api/generate-fbf — Frame-by-frame generation with SSE progress
  if (pathname === '/api/generate-fbf' && req.method === 'POST') {
    const body = await parseBody(req);
    const { character, animation, model } = body;

    // Setup SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    function sse(data) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    try {
      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });

      // Validate
      const anim = ANIMATIONS[animation];
      if (!anim) throw new Error(`Unknown animation: ${animation}`);
      if (!anim.breezyFile) throw new Error(`No Breezy reference for ${animation}`);

      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!fs.existsSync(portraitPath)) throw new Error(`Portrait not found: ${character}full.png`);

      const poseRefPath = path.join(ASSETS_DIR, anim.breezyFile);
      if (!fs.existsSync(poseRefPath)) throw new Error(`Breezy ref not found: ${anim.breezyFile}`);

      const totalFrames = anim.frames;
      fs.mkdirSync(RAW_DIR, { recursive: true });

      const fbfDir = path.join(RAW_DIR, `${character}-${animation}-fbf`);
      fs.mkdirSync(fbfDir, { recursive: true });

      sse({ type: 'start', animation, character, totalFrames });

      // Step 1: Cut Breezy reference strip into individual frames
      const refFramesDir = path.join(fbfDir, 'ref-frames');
      fs.mkdirSync(refFramesDir, { recursive: true });
      const cutResult = await cutFrames(poseRefPath, refFramesDir);
      const refFramePaths = cutResult.frames.slice(0, totalFrames);

      // Step 2: Upscale each frame to 512x512 with nearest-neighbor
      const upscaledDir = path.join(fbfDir, 'upscaled');
      fs.mkdirSync(upscaledDir, { recursive: true });
      const upscaledPaths = [];
      for (let i = 0; i < refFramePaths.length; i++) {
        const upPath = path.join(upscaledDir, `frame-${String(i).padStart(3, '0')}.png`);
        await upscaleNN(refFramePaths[i], upPath, { width: 512, height: 512 });
        upscaledPaths.push(upPath);
      }

      sse({ type: 'prep_done', framesReady: upscaledPaths.length });

      // Step 3: Generate each frame (concurrency = 2, ~2s delay)
      const rawOutputPaths = [];

      const tasks = upscaledPaths.map((upPath, i) => async () => {
        sse({ type: 'frame_start', frame: i, total: totalFrames });

        const promptData = buildSingleFramePrompt(character, animation, i, totalFrames);
        const outPath = path.join(fbfDir, `raw-frame-${String(i).padStart(3, '0')}.png`);

        let lastErr;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await client.generateSingleFrame(promptData.prompt, upPath, portraitPath, {
              model: modelId,
              outputPath: outPath,
            });
            rawOutputPaths[i] = outPath;
            sse({ type: 'frame_done', frame: i });
            return;
          } catch (err) {
            lastErr = err;
            if (attempt === 0) {
              sse({ type: 'frame_retry', frame: i, error: err.message });
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        }
        sse({ type: 'frame_error', frame: i, error: lastErr?.message });
      });

      await runWithConcurrency(tasks, 2, 2000);

      // Step 4: Process all raw frames — remove green BG, resize to 180x180
      const processedDir = path.join(fbfDir, 'processed');
      fs.mkdirSync(processedDir, { recursive: true });
      const processedPaths = [];

      for (let i = 0; i < totalFrames; i++) {
        const rawPath = rawOutputPaths[i];
        if (!rawPath || !fs.existsSync(rawPath)) {
          sse({ type: 'process_skip', frame: i });
          continue;
        }

        const cleanPath = path.join(processedDir, `clean-${String(i).padStart(3, '0')}.png`);
        await removeBackground(rawPath, cleanPath);

        const resizedPath = path.join(processedDir, `frame-${String(i).padStart(3, '0')}.png`);
        await resizeFrame(cleanPath, resizedPath, { width: 180, height: 180 });
        processedPaths.push(resizedPath);
      }

      // Step 5: Assemble horizontal strip
      const stripPath = path.join(ASSETS_DIR, `${character}-${animation}.png`);
      await buildStrip(processedPaths, stripPath, { frameWidth: 180, frameHeight: 180 });

      // Save individual frames for inspection
      const framesOutDir = path.join(ASSETS_DIR, `${character}-${animation}-frames`);
      fs.mkdirSync(framesOutDir, { recursive: true });
      processedPaths.forEach((p, i) => {
        fs.copyFileSync(p, path.join(framesOutDir, `frame-${i}.png`));
      });

      sse({
        type: 'complete',
        url: `/assets/${character}-${animation}.png`,
        frames: processedPaths.length,
        totalFrames,
        failed: totalFrames - processedPaths.length,
      });
    } catch (err) {
      sse({ type: 'error', message: err.message });
    }

    res.end();
    return;
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

  // ─── Character Creation (4-option picker) ──────────────────────────────

  // Build the character creation prompt
  function buildCharPrompt(extraInstructions) {
    const styleRef = path.join(ASSETS_DIR, '99full.png');
    const hasStyleRef = fs.existsSync(styleRef);

    const lines = [
      hasStyleRef
        ? 'Image 1 is the style reference — match this exact pixel art style. Image 2 is the person to convert.'
        : 'Convert the uploaded photo into 16-bit arcade pixel art.',
      '',
      'Create a FULL BODY standing character portrait showing the complete person from head to shoes.',
      'The character must be standing upright, facing forward, arms relaxed at sides, in a neutral standing pose.',
      'Show the ENTIRE body — head, torso, arms, hands, legs, feet/shoes. Do NOT crop or zoom in.',
      '',
      'ACCURACY IS CRITICAL:',
      '- Match the person\'s EXACT skin tone — do not lighten or darken it',
      '- Match their EXACT facial features, face shape, eyes, nose, mouth',
      '- Match their EXACT hairstyle, hair color, hair texture',
      '- Match their EXACT outfit, clothing colors, and shoes from the photo',
      '- Match their body type and proportions',
      '',
      'STYLE:',
      '- 16-bit arcade pixel art, GBA game style — chunky pixels, NOT high-resolution',
      '- Bold thick black pixel outlines around the entire character body',
      '- Limited color palette with high contrast arcade shading',
      '- Sharp pixel edges — NO anti-aliasing, NO blur, NO smooth gradients',
      '- The character should look like they belong in a retro basketball arcade game',
      '',
      'Output on a pure white background (#FFFFFF only).',
      'FULL BODY only. No environment. No extra elements. No cropping.',
    ];

    if (extraInstructions) {
      lines.push('', 'ADDITIONAL INSTRUCTIONS:', extraInstructions);
    }

    return { prompt: lines.join('\n'), hasStyleRef, styleRefPath: hasStyleRef ? styleRef : null };
  }

  // POST /api/character/create — Generate 4 options from photo
  if (pathname === '/api/character/create' && req.method === 'POST') {
    const body = await parseBody(req);
    const { name, photoBase64, photoPath, model, changeRequest, count } = body;
    if (!name) return json(res, { error: 'Character name required' }, 400);

    try {
      const charDir = path.join(TMP_DIR, 'characters', name);
      fs.mkdirSync(charDir, { recursive: true });

      // Save or use existing photo
      let originalPath = path.join(charDir, 'original.png');
      if (photoBase64) {
        const base64Data = photoBase64.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(originalPath, Buffer.from(base64Data, 'base64'));
      } else if (photoPath && fs.existsSync(photoPath)) {
        fs.copyFileSync(photoPath, originalPath);
      } else if (!fs.existsSync(originalPath)) {
        return json(res, { error: 'Photo required' }, 400);
      }

      const { prompt, hasStyleRef, styleRefPath } = buildCharPrompt(changeRequest);
      const client = new NanaBananaClient({ model: model || 'gemini-2.5-flash-image' });
      const numOptions = count || 4;

      const referenceImages = [];
      if (styleRefPath) referenceImages.push(styleRefPath);
      referenceImages.push(originalPath);

      // Generate N options with staggered concurrency to avoid rate limits
      const optionTasks = [];
      for (let i = 0; i < numOptions; i++) {
        const idx = i;
        optionTasks.push(async () => {
          try {
            const result = await client.generate(prompt, {
              referenceImages,
              aspectRatio: '3:4',
              resolution: '2K',
              model: model || 'gemini-2.5-flash-image',
            });
            const optPath = path.join(charDir, `option-${idx}.png`);
            fs.writeFileSync(optPath, result.imageBuffer);
            return { index: idx, url: `/api/character/image/${name}/option-${idx}.png` };
          } catch (err) {
            return { index: idx, error: err.message };
          }
        });
      }

      const options = await runWithConcurrency(optionTasks, 2, 3000);
      const successful = options.filter(o => !o.error);

      return json(res, {
        success: true,
        name,
        originalUrl: `/api/character/image/${name}/original.png`,
        options: successful,
        errors: options.filter(o => o.error),
        changeRequest: changeRequest || null,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // POST /api/character/confirm — Pick the best option and save as final
  if (pathname === '/api/character/confirm' && req.method === 'POST') {
    const body = await parseBody(req);
    const { name, optionIndex, feedback } = body;
    if (!name) return json(res, { error: 'Character name required' }, 400);

    try {
      const charDir = path.join(TMP_DIR, 'characters', name);
      const optPath = path.join(charDir, `option-${optionIndex}.png`);
      if (!fs.existsSync(optPath)) return json(res, { error: 'Option not found' }, 404);

      // Copy selected option to assets
      const pixelPath = path.join(ASSETS_DIR, `${name}full.png`);
      fs.copyFileSync(optPath, pixelPath);

      // Register character
      CHARACTERS[name] = {
        description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
        style: '16-bit pixel art, GBA style',
      };

      // Save training feedback
      const trainingFile = path.join(TMP_DIR, 'characters', 'training.json');
      let training = {};
      if (fs.existsSync(trainingFile)) training = JSON.parse(fs.readFileSync(trainingFile, 'utf8'));
      if (!training.sessions) training.sessions = [];
      training.sessions.push({
        name,
        selectedOption: optionIndex,
        feedback: feedback || '',
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(trainingFile, JSON.stringify(training, null, 2));

      return json(res, {
        success: true,
        name,
        pixelArtUrl: `/assets/${name}full.png`,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // POST /api/character/upload-photo — Raw binary photo upload for a character
  if (pathname === '/api/character/upload-photo' && req.method === 'POST') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const name = url.searchParams.get('name');
    if (!name) return json(res, { error: 'name query param required' }, 400);

    try {
      const charDir = path.join(TMP_DIR, 'characters', name);
      fs.mkdirSync(charDir, { recursive: true });
      const photoPath = path.join(charDir, 'original.png');
      const writeStream = fs.createWriteStream(photoPath);
      await new Promise((resolve, reject) => {
        req.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
      return json(res, { success: true, photoPath, size: fs.statSync(photoPath).size });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // GET /api/character/image/:name/:file — Serve character images
  if (pathname.startsWith('/api/character/image/') && req.method === 'GET') {
    const parts = pathname.split('/');
    const name = parts[4];
    const file = parts[5];
    return serveImage(res, path.join(TMP_DIR, 'characters', name, file));
  }

  // ─── Roster / Gallery ─────────────────────────────────────────────────

  // GET /api/roster — Full roster of all characters with their assets
  if (pathname === '/api/roster' && req.method === 'GET') {
    const roster = [];
    // Scan assets dir for *full.png files
    const files = fs.existsSync(ASSETS_DIR) ? fs.readdirSync(ASSETS_DIR) : [];
    const fullFiles = files.filter(f => f.endsWith('full.png'));

    for (const f of fullFiles) {
      const name = f.replace('full.png', '');
      const anims = Object.keys(ANIMATIONS);
      const sprites = {};
      let completedCount = 0;
      for (const anim of anims) {
        const spriteFile = `${name}-${anim}.png`;
        const exists = fs.existsSync(path.join(ASSETS_DIR, spriteFile));
        sprites[anim] = { exists, file: spriteFile, url: `/assets/${spriteFile}` };
        if (exists) completedCount++;
      }
      const gridFile = `${name}-spritesheet.png`;
      const hasGrid = fs.existsSync(path.join(ASSETS_DIR, gridFile));

      roster.push({
        name,
        portrait: `/assets/${f}`,
        portraitFile: f,
        sprites,
        completedAnims: completedCount,
        totalAnims: anims.length,
        hasGrid,
        gridUrl: hasGrid ? `/assets/${gridFile}` : null,
      });
    }

    return json(res, { roster, totalCharacters: roster.length });
  }

  // GET /api/roster/:char/download — Download all assets for a character as individual files list
  if (pathname.startsWith('/api/roster/') && pathname.endsWith('/download') && req.method === 'GET') {
    const charName = pathname.split('/')[3];
    const files = fs.existsSync(ASSETS_DIR) ? fs.readdirSync(ASSETS_DIR) : [];
    const charFiles = files.filter(f => f.startsWith(charName));
    const assets = charFiles.map(f => ({
      file: f,
      url: `/assets/${f}`,
      size: fs.statSync(path.join(ASSETS_DIR, f)).size,
    }));
    return json(res, { character: charName, assets });
  }

  // DELETE /api/character/:name — Remove a character
  if (pathname.startsWith('/api/character/') && req.method === 'DELETE') {
    const name = pathname.split('/')[3];
    // Don't delete core characters
    const protectedChars = ['breezy', '99'];
    if (protectedChars.includes(name)) {
      return json(res, { error: 'Cannot delete core character' }, 400);
    }
    // Remove portrait
    const portraitPath = path.join(ASSETS_DIR, `${name}full.png`);
    if (fs.existsSync(portraitPath)) fs.unlinkSync(portraitPath);
    // Remove from runtime characters
    delete CHARACTERS[name];
    return json(res, { success: true, deleted: name });
  }

  return json(res, { error: 'Not found' }, 404);
}

// ─── Server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
