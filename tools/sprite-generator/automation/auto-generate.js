#!/usr/bin/env node
/**
 * Automated Sprite Generator — Nano Banana Pro API
 *
 * Replaces browser automation with direct API calls to Google's Gemini
 * Nano Banana Pro (gemini-3-pro-image-preview).
 *
 * Two pipelines:
 *   A) generate <char> [anim]  — Generate from Breezy references (replication)
 *   B) film <char> <anim> <strip> — Generate from real footage reference strip
 *
 * Usage:
 *   node auto-generate.js generate 99                    # All 8 animations
 *   node auto-generate.js generate 99 jumpshot           # Single animation
 *   node auto-generate.js film 99 crossover ref-strip.png  # From video reference
 *   node auto-generate.js replicate 99                   # Alias for generate
 */
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const { NanaBananaClient } = require('../nano-banana');
const { ANIMATIONS, buildPrompt, CHARACTERS } = require('../prompts');

const DOWNLOADS_DIR = path.resolve(__dirname, '../../../raw-sprites');
const SOUL_JAM_ASSETS = path.resolve(__dirname, '../../../../soul-jam/public/assets/images');

// Character reference images
const CHAR_REFS = {
  '99': path.resolve(__dirname, '../../../../soul-jam/public/assets/images/99full.png'),
  breezy: path.resolve(__dirname, '../../../../soul-jam/public/assets/images/breezyfull.png'),
};

// Breezy's existing animation strips (used as pose references for replication)
function getBreezyRef(animName) {
  const anim = ANIMATIONS[animName];
  if (!anim || !anim.breezyFile) return null;
  const refPath = path.join(SOUL_JAM_ASSETS, anim.breezyFile);
  return fs.existsSync(refPath) ? refPath : null;
}

[DOWNLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── GENERATE ONE ANIMATION ─────────────────────────────────────────────

/**
 * Generate a single animation sprite via Nano Banana Pro API.
 *
 * @param {NanaBananaClient} client - API client
 * @param {string} characterName - Character (99, breezy)
 * @param {string} animName - Animation name
 * @param {object} opts - { charRef, poseRef, model, resolution }
 */
async function generateOne(client, characterName, animName, opts = {}) {
  const data = buildPrompt(characterName, animName);
  const rawPath = path.join(DOWNLOADS_DIR, `${data.outputName}-raw.png`);

  console.log(chalk.cyan(`\n  [${animName}] ${data.frames} frames`));

  // Determine reference images
  const charRef = opts.charRef || CHAR_REFS[characterName];
  const poseRef = opts.poseRef || getBreezyRef(animName);

  if (charRef && fs.existsSync(charRef)) {
    console.log(chalk.gray(`    Character ref: ${path.basename(charRef)}`));
  } else {
    console.log(chalk.yellow(`    No character ref found`));
  }

  if (poseRef) {
    console.log(chalk.gray(`    Pose ref: ${path.basename(poseRef)}`));
  } else {
    console.log(chalk.gray(`    No pose ref (prompt-only mode)`));
  }

  console.log(chalk.gray(`    Prompt: ${data.prompt.substring(0, 100)}...`));

  try {
    const startTime = Date.now();

    // Calculate aspect ratio based on frame count
    // For a horizontal strip with N frames, use wide aspect
    const frameCount = data.frames;
    let aspectRatio = '16:9';
    if (frameCount <= 3) aspectRatio = '3:1';
    else if (frameCount <= 5) aspectRatio = '16:9';
    else aspectRatio = '21:9';

    const result = await client.generateSprite(
      data.prompt,
      poseRef,      // Image 1: pose/layout reference
      charRef,      // Image 2: character reference
      {
        aspectRatio,
        resolution: opts.resolution || '2K',
        model: opts.model,
        outputPath: rawPath,
      }
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeKB = (result.imageBuffer.length / 1024).toFixed(0);
    console.log(chalk.green(`    Generated in ${elapsed}s (${sizeKB}KB)`));

    if (result.description) {
      console.log(chalk.gray(`    AI note: ${result.description.substring(0, 100)}`));
    }

    return rawPath;
  } catch (err) {
    console.log(chalk.red(`    API error: ${err.message.substring(0, 150)}`));
    return null;
  }
}

// ─── GENERATE + PROCESS ─────────────────────────────────────────────────

async function generateAndProcess(client, characterName, animName, opts = {}) {
  const rawPath = await generateOne(client, characterName, animName, opts);

  if (!rawPath || !fs.existsSync(rawPath)) {
    return { animName, success: false, error: 'Generation failed' };
  }

  try {
    const { processSprite } = require('../../sprite-processor/index');
    const anim = ANIMATIONS[animName];
    console.log(chalk.cyan(`    Processing -> ${anim.frames} frames x 180x180`));

    const result = await processSprite(rawPath, `${characterName}-${animName}`, {
      frameCount: anim.frames,
      targetSize: 180,
      outputDir: SOUL_JAM_ASSETS,
    });

    console.log(chalk.green.bold(`    ${characterName}-${animName}.png READY`));
    return { animName, success: true, output: result.outputPath };
  } catch (err) {
    console.log(chalk.yellow(`    Process error: ${err.message.substring(0, 80)}`));
    return { animName, success: false, raw: rawPath, error: err.message };
  }
}

// ─── GENERATE ALL ───────────────────────────────────────────────────────

async function generateAll(characterName, singleAnim, opts = {}) {
  const anims = singleAnim ? [singleAnim] : Object.keys(ANIMATIONS);

  console.log(chalk.cyan.bold(`\n  Nano Banana Pro Sprite Generator — ${characterName.toUpperCase()}`));
  console.log(chalk.gray(`  Animations: ${anims.length}`));
  console.log(chalk.gray(`  Model: ${opts.model || 'gemini-3-pro-image-preview'}`));
  console.log(chalk.gray(`  Resolution: ${opts.resolution || '2K'}`));
  console.log(chalk.gray(`  Pipeline: API-direct (no browser)\n`));

  let client;
  try {
    client = new NanaBananaClient({ model: opts.model });
  } catch (err) {
    console.error(chalk.red(`\n  ${err.message}`));
    process.exit(1);
  }

  const results = [];

  for (let i = 0; i < anims.length; i++) {
    const animName = anims[i];
    console.log(chalk.white.bold(`\n  ━━━ [${i + 1}/${anims.length}] ${characterName}-${animName} ━━━`));

    const result = await generateAndProcess(client, characterName, animName, opts);
    results.push(result);

    // Rate limiting pause between generations
    if (i < anims.length - 1) {
      console.log(chalk.gray('    Waiting 2s (rate limit)...'));
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Summary
  console.log(chalk.cyan.bold('\n\n  ═══════════ SUMMARY ═══════════\n'));
  const ok = results.filter(r => r.success);
  for (const r of results) {
    console.log(r.success
      ? chalk.green(`    ${r.animName}`)
      : chalk.red(`    ${r.animName} — ${r.error}`));
  }
  console.log(chalk.white(`\n    ${ok.length}/${results.length} successful\n`));

  if (ok.length > 0) {
    console.log(chalk.gray('  PreloadScene.ts additions:'));
    for (const r of ok) {
      console.log(chalk.yellow(`    this.load.spritesheet('${characterName}-${r.animName}', 'assets/images/${characterName}-${r.animName}.png', { frameWidth: 180, frameHeight: 180 });`));
    }
  }

  return results;
}

// ─── FILM-TO-SPRITE (Pipeline A) ────────────────────────────────────────

async function filmGenerate(characterName, animName, refStripPath, opts = {}) {
  if (!fs.existsSync(refStripPath)) {
    console.error(chalk.red(`Reference strip not found: ${refStripPath}`));
    process.exit(1);
  }

  console.log(chalk.cyan.bold(`\n  Film-to-Sprite — ${characterName}-${animName}`));
  console.log(chalk.gray(`  Reference strip: ${refStripPath}`));

  let client;
  try {
    client = new NanaBananaClient({ model: opts.model });
  } catch (err) {
    console.error(chalk.red(`\n  ${err.message}`));
    process.exit(1);
  }

  const result = await generateAndProcess(client, characterName, animName, {
    ...opts,
    poseRef: refStripPath,
  });

  if (result.success) {
    console.log(chalk.green.bold(`\n  Film-to-Sprite complete: ${result.output}`));
  } else {
    console.log(chalk.red(`\n  Failed: ${result.error}`));
  }

  return result;
}

// ─── CLI ────────────────────────────────────────────────────────────────
const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];
const arg3 = process.argv[5];

// Parse --flags
const getFlag = (name) => {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
};

const cliOpts = {
  model: getFlag('model'),
  resolution: getFlag('resolution'),
  charRef: getFlag('char-ref'),
};

if (!command) {
  console.log(chalk.cyan.bold('\n  Nano Banana Pro Sprite Generator\n'));
  console.log(chalk.white('  Commands:'));
  console.log(chalk.gray('    generate <char>              All 8 animations (replication from Breezy)'));
  console.log(chalk.gray('    generate <char> <anim>       Single animation'));
  console.log(chalk.gray('    replicate <char>             Alias for generate'));
  console.log(chalk.gray('    replicate <char> <anim>      Alias for generate single'));
  console.log(chalk.gray('    film <char> <anim> <strip>   Film-to-sprite from video reference strip'));
  console.log(chalk.white('\n  Options:'));
  console.log(chalk.gray('    --model <id>       Model (pro/flash/legacy or full ID)'));
  console.log(chalk.gray('    --resolution <r>   1K, 2K, 4K (default: 2K)'));
  console.log(chalk.gray('    --char-ref <path>  Custom character reference image'));
  console.log(chalk.white('\n  Characters:'));
  for (const [name, char] of Object.entries(CHARACTERS)) {
    console.log(chalk.gray(`    ${name}: ${char.description.substring(0, 60)}...`));
  }
  console.log(chalk.white('\n  Animations:'));
  for (const [name, anim] of Object.entries(ANIMATIONS)) {
    console.log(chalk.gray(`    ${name} (${anim.frames} frames)`));
  }
  console.log(chalk.white('\n  Env:'));
  console.log(chalk.gray('    GEMINI_API_KEY — Required. Get at https://aistudio.google.com/apikey'));
  process.exit(0);
}

// Resolve model shorthand
if (cliOpts.model) {
  const shortcuts = { pro: 'gemini-3-pro-image-preview', flash: 'gemini-3.1-flash-image-preview', legacy: 'gemini-2.5-flash-image' };
  cliOpts.model = shortcuts[cliOpts.model] || cliOpts.model;
}

(async () => {
  switch (command) {
    case 'generate':
    case 'replicate': {
      if (!arg1 || !CHARACTERS[arg1]) {
        console.error(chalk.red(`Available characters: ${Object.keys(CHARACTERS).join(', ')}`));
        process.exit(1);
      }
      if (arg2 && !ANIMATIONS[arg2]) {
        console.error(chalk.red(`Unknown animation: ${arg2}. Available: ${Object.keys(ANIMATIONS).join(', ')}`));
        process.exit(1);
      }
      await generateAll(arg1, arg2 || null, cliOpts);
      break;
    }

    case 'film': {
      if (!arg1 || !arg2 || !arg3) {
        console.error(chalk.red('Usage: film <character> <animation> <reference-strip-path>'));
        process.exit(1);
      }
      if (!CHARACTERS[arg1]) {
        console.error(chalk.red(`Unknown character: ${arg1}`));
        process.exit(1);
      }
      await filmGenerate(arg1, arg2, arg3, cliOpts);
      break;
    }

    default:
      console.error(chalk.red(`Unknown command: ${command}`));
      process.exit(1);
  }
})().catch(err => {
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});

module.exports = { generateOne, generateAll, filmGenerate, generateAndProcess };
