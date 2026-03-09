#!/usr/bin/env node
/**
 * File watcher — monitors raw-sprites/ folder for new images.
 * When you download a generated sprite from Higgsfield and drop it in,
 * this automatically processes it using the matching prompt file.
 *
 * Usage: node watcher.js
 *
 * Workflow:
 *   1. Run `sprite-gen prompt breezy jumpshot --copy`
 *      → creates raw-sprites/breezy-jumpshot-prompt.txt
 *   2. Generate in Higgsfield, download result
 *   3. Save as raw-sprites/breezy-jumpshot-raw.png (or drag & drop)
 *   4. Watcher auto-detects it and processes → game-ready sprite
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { processSprite } = require('../sprite-processor/index');

const RAW_DIR = path.resolve(__dirname, '../../raw-sprites');
const SOUL_JAM_ASSETS = path.resolve(__dirname, '../../../soul-jam/public/assets/images');
const PROCESSED_DIR = path.join(RAW_DIR, 'processed');

// Ensure directories exist
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(PROCESSED_DIR, { recursive: true });

console.log(chalk.cyan.bold('\n👀 Sprite Watcher Active\n'));
console.log(chalk.gray(`Watching: ${RAW_DIR}`));
console.log(chalk.gray(`Output:   ${SOUL_JAM_ASSETS}`));
console.log(chalk.gray('\nDrop raw sprite images here (named <character>-<animation>-raw.png)'));
console.log(chalk.gray('Matching prompt files will be used for frame counts.\n'));

// Track already-processed files
const processed = new Set();

// Initial scan for existing files
const existing = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('-raw.png'));
existing.forEach(f => processed.add(f));
if (existing.length > 0) {
  console.log(chalk.gray(`Found ${existing.length} existing raw files (skipping). Delete and re-add to reprocess.\n`));
}

// Watch for new files
fs.watch(RAW_DIR, { persistent: true }, async (eventType, filename) => {
  if (!filename || !filename.endsWith('-raw.png') || processed.has(filename)) return;

  // Wait a moment for file to finish writing
  await new Promise(r => setTimeout(r, 1000));

  const filePath = path.join(RAW_DIR, filename);
  if (!fs.existsSync(filePath)) return;

  processed.add(filename);

  // Parse name: "breezy-jumpshot-raw.png" → name="breezy-jumpshot"
  const name = filename.replace('-raw.png', '');
  console.log(chalk.cyan(`\n📥 New sprite detected: ${filename}`));

  // Look for matching prompt file to get frame count
  const promptFile = path.join(RAW_DIR, `${name}-prompt.txt`);
  let frameCount = null;

  if (fs.existsSync(promptFile)) {
    const promptText = fs.readFileSync(promptFile, 'utf8');
    const match = promptText.match(/(\d+)\s+frames/);
    if (match) {
      frameCount = parseInt(match[1]);
      console.log(chalk.gray(`  Found prompt file → ${frameCount} frames`));
    }
  }

  if (!frameCount) {
    console.log(chalk.yellow(`  No prompt file found. Attempting auto-detect...`));
    // Try to guess: image width / height = frame count for square frames
    const sharp = require('sharp');
    const meta = await sharp(filePath).metadata();
    frameCount = Math.round(meta.width / meta.height);
    console.log(chalk.gray(`  Auto-detected: ${meta.width}x${meta.height} → ~${frameCount} frames`));
  }

  try {
    console.log(chalk.cyan(`  Processing ${frameCount} frames...`));
    const result = await processSprite(filePath, name, {
      frameCount,
      targetSize: 180,
      tolerance: 40,
      outputDir: SOUL_JAM_ASSETS,
    });

    // Move raw file to processed folder
    const processedPath = path.join(PROCESSED_DIR, filename);
    fs.copyFileSync(filePath, processedPath);

    console.log(chalk.green.bold(`\n✅ ${name} ready!`));
    console.log(chalk.white(`   ${result.outputPath}`));
    console.log(chalk.gray(`   ${result.frameCount} frames × ${result.frameSize}x${result.frameSize}`));
    console.log(chalk.gray(`\n   PreloadScene.ts:`));
    console.log(chalk.yellow(`   this.load.spritesheet('${name}', 'assets/images/${name}.png', { frameWidth: ${result.frameSize}, frameHeight: ${result.frameSize} });`));

    // Play system notification sound
    try {
      require('child_process').execSync('afplay /System/Library/Sounds/Glass.aiff');
    } catch (e) { /* ignore */ }

  } catch (err) {
    console.error(chalk.red(`\n❌ Processing failed: ${err.message}`));
  }
});

// Keep alive
process.on('SIGINT', () => {
  console.log(chalk.gray('\nWatcher stopped.'));
  process.exit(0);
});
