#!/usr/bin/env node
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SOUL_JAM_ASSETS = path.resolve(__dirname, '../../../soul-jam/public/assets/images');
const DEFAULT_FRAME_SIZE = 180;
const DEFAULT_BG_COLOR = { r: 0, g: 71, b: 255 }; // #0047FF

/**
 * Detect frames in a horizontal sprite strip by dividing width by frame height.
 * Returns { width, height, frameCount, frameWidth, frameHeight }
 */
async function detectFrames(imagePath, opts = {}) {
  const meta = await sharp(imagePath).metadata();
  const frameHeight = opts.frameHeight || meta.height;
  const frameWidth = opts.frameWidth || frameHeight; // assume square if not specified
  const cols = Math.round(meta.width / frameWidth);
  const rows = Math.round(meta.height / frameHeight);
  return {
    width: meta.width,
    height: meta.height,
    frameWidth,
    frameHeight,
    cols,
    rows,
    frameCount: cols * rows,
  };
}

/**
 * Cut a sprite sheet (strip or grid) into individual frame PNGs.
 */
async function cutFrames(imagePath, outputDir, opts = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const info = await detectFrames(imagePath, opts);
  const frames = [];

  for (let row = 0; row < info.rows; row++) {
    for (let col = 0; col < info.cols; col++) {
      const idx = row * info.cols + col;
      const outPath = path.join(outputDir, `frame-${String(idx).padStart(3, '0')}.png`);
      await sharp(imagePath)
        .extract({
          left: col * info.frameWidth,
          top: row * info.frameHeight,
          width: info.frameWidth,
          height: info.frameHeight,
        })
        .toFile(outPath);
      frames.push(outPath);
    }
  }

  console.log(`Cut ${frames.length} frames (${info.frameWidth}x${info.frameHeight}) from ${path.basename(imagePath)}`);
  return { frames, info };
}

/**
 * Remove a background color and replace with transparency.
 * Uses a tolerance value (0-255) to handle anti-aliasing and compression artifacts.
 */
async function removeBackground(imagePath, outputPath, opts = {}) {
  const bgColor = opts.bgColor || DEFAULT_BG_COLOR;
  const tolerance = opts.tolerance || 40;

  const image = sharp(imagePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  const output = Buffer.alloc(data.length);
  data.copy(output);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const dr = Math.abs(r - bgColor.r);
    const dg = Math.abs(g - bgColor.g);
    const db = Math.abs(b - bgColor.b);

    if (dr <= tolerance && dg <= tolerance && db <= tolerance) {
      output[i + 3] = 0; // set alpha to 0 (transparent)
    }
  }

  await sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(outputPath || imagePath);

  return outputPath || imagePath;
}

/**
 * Resize a frame to target dimensions, maintaining aspect ratio and centering.
 */
async function resizeFrame(imagePath, outputPath, opts = {}) {
  const targetW = opts.width || DEFAULT_FRAME_SIZE;
  const targetH = opts.height || DEFAULT_FRAME_SIZE;

  await sharp(imagePath)
    .resize(targetW, targetH, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(outputPath);

  return outputPath;
}

/**
 * Assemble individual frame PNGs into a horizontal sprite strip.
 */
async function buildStrip(framePaths, outputPath, opts = {}) {
  const frameW = opts.frameWidth || DEFAULT_FRAME_SIZE;
  const frameH = opts.frameHeight || DEFAULT_FRAME_SIZE;
  const count = framePaths.length;

  // Create transparent canvas
  const canvas = sharp({
    create: {
      width: frameW * count,
      height: frameH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  // Composite each frame at its position
  const composites = await Promise.all(
    framePaths.map(async (fp, i) => {
      const buf = await sharp(fp)
        .resize(frameW, frameH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
      return { input: buf, left: i * frameW, top: 0 };
    })
  );

  await canvas.composite(composites).png().toFile(outputPath);
  console.log(`Built strip: ${count} frames × ${frameW}x${frameH} → ${path.basename(outputPath)}`);
  return outputPath;
}

/**
 * Full pipeline: take a raw generated image, cut it, remove bg, resize, and build a Soul Jam-ready strip.
 *
 * @param {string} inputImage - path to the raw sprite strip/grid from Higgsfield
 * @param {string} outputName - name for the output (e.g. "breezy-crossover")
 * @param {object} opts - { frameCount, bgColor, tolerance, frameWidth, frameHeight, targetSize, outputDir }
 */
async function processSprite(inputImage, outputName, opts = {}) {
  const targetSize = opts.targetSize || DEFAULT_FRAME_SIZE;
  const outputDir = opts.outputDir || SOUL_JAM_ASSETS;
  const tempDir = path.join(__dirname, '.tmp', outputName);
  fs.mkdirSync(tempDir, { recursive: true });

  console.log(`\nProcessing: ${path.basename(inputImage)} → ${outputName}`);
  console.log(`Target: ${targetSize}x${targetSize} frames, output to ${outputDir}\n`);

  // Step 1: Detect and cut frames
  const cutOpts = {};
  if (opts.frameCount) {
    const meta = await sharp(inputImage).metadata();
    // If frameCount specified, calculate frame width from image width
    cutOpts.frameWidth = Math.round(meta.width / opts.frameCount);
    cutOpts.frameHeight = meta.height;
  }
  if (opts.frameWidth) cutOpts.frameWidth = opts.frameWidth;
  if (opts.frameHeight) cutOpts.frameHeight = opts.frameHeight;

  const { frames } = await cutFrames(inputImage, tempDir, cutOpts);

  // Step 2: Remove background from each frame
  const cleanFrames = [];
  for (let i = 0; i < frames.length; i++) {
    const cleanPath = path.join(tempDir, `clean-${String(i).padStart(3, '0')}.png`);
    await removeBackground(frames[i], cleanPath, {
      bgColor: opts.bgColor || DEFAULT_BG_COLOR,
      tolerance: opts.tolerance || 40,
    });
    cleanFrames.push(cleanPath);
    process.stdout.write(`  BG removal: ${i + 1}/${frames.length}\r`);
  }
  console.log(`  BG removal: ${frames.length}/${frames.length} done`);

  // Step 3: Resize frames to target
  const resizedFrames = [];
  for (let i = 0; i < cleanFrames.length; i++) {
    const resizedPath = path.join(tempDir, `resized-${String(i).padStart(3, '0')}.png`);
    await resizeFrame(cleanFrames[i], resizedPath, { width: targetSize, height: targetSize });
    resizedFrames.push(resizedPath);
  }
  console.log(`  Resized ${resizedFrames.length} frames to ${targetSize}x${targetSize}`);

  // Step 4: Build horizontal strip
  const outputPath = path.join(outputDir, `${outputName}.png`);
  await buildStrip(resizedFrames, outputPath, { frameWidth: targetSize, frameHeight: targetSize });

  // Step 5: Also save individual frames for inspection
  const framesDir = path.join(outputDir, `${outputName}-frames`);
  fs.mkdirSync(framesDir, { recursive: true });
  for (let i = 0; i < resizedFrames.length; i++) {
    fs.copyFileSync(resizedFrames[i], path.join(framesDir, `frame-${i}.png`));
  }
  console.log(`  Individual frames saved to ${outputName}-frames/`);

  // Cleanup temp
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(`\n✓ Done! Output: ${outputPath}`);
  console.log(`  Strip: ${resizedFrames.length} × ${targetSize}x${targetSize} = ${resizedFrames.length * targetSize}x${targetSize}px`);

  return {
    outputPath,
    framesDir,
    frameCount: resizedFrames.length,
    frameSize: targetSize,
  };
}

module.exports = {
  detectFrames,
  cutFrames,
  removeBackground,
  resizeFrame,
  buildStrip,
  processSprite,
  SOUL_JAM_ASSETS,
  DEFAULT_FRAME_SIZE,
  DEFAULT_BG_COLOR,
};
