#!/usr/bin/env node
const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const { buildPrompt, buildCustomPrompt, listAnimations, CHARACTERS, ANIMATIONS } = require('./prompts');
const { HiggsFieldClient } = require('./higgsfield');

const SPRITE_PROCESSOR = path.resolve(__dirname, '../sprite-processor/cli.js');
const RAW_DIR = path.resolve(__dirname, '../../raw-sprites');
const SOUL_JAM_ASSETS = path.resolve(__dirname, '../../../soul-jam/public/assets/images');

const program = new Command();
program
  .name('sprite-gen')
  .description('Soul Jam sprite generator — prompt → generate → process → game-ready')
  .version('1.0.0');

// ─── GENERATE: Full end-to-end pipeline ─────────────────────────────────
program
  .command('generate')
  .description('Generate a sprite: build prompt → Higgsfield API → cut → process')
  .argument('<character>', 'Character name (breezy, 99)')
  .argument('<animation>', 'Animation name (idle-dribble, jumpshot, etc.)')
  .option('-f, --frames <n>', 'Override frame count', parseInt)
  .option('--dry-run', 'Show prompt without generating')
  .option('--skip-process', 'Generate only, skip sprite processing')
  .option('-s, --size <px>', 'Target frame size (default: 180)', parseInt, 180)
  .option('-t, --tolerance <n>', 'BG removal tolerance (default: 40)', parseInt, 40)
  .action(async (character, animation, opts) => {
    console.log(chalk.cyan.bold('\n🎮 Soul Jam Sprite Generator\n'));

    // Step 1: Build prompt
    let promptData;
    try {
      promptData = buildPrompt(character, animation, { frames: opts.frames });
    } catch (err) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }

    console.log(chalk.white.bold('Prompt:'));
    console.log(chalk.gray(promptData.prompt));
    console.log(chalk.gray(`\nFrames: ${promptData.frames} | FPS: ${promptData.fps} | Loop: ${promptData.loop}`));
    console.log(chalk.gray(`Output name: ${promptData.outputName}\n`));

    if (opts.dryRun) {
      console.log(chalk.yellow('Dry run — copy the prompt above into Higgsfield manually.'));
      console.log(chalk.yellow(`Then run: node ${SPRITE_PROCESSOR} process <downloaded-image> ${promptData.outputName} -f ${promptData.frames}`));
      return;
    }

    // Step 2: Generate via Higgsfield API
    let client;
    try {
      client = new HiggsFieldClient();
    } catch (err) {
      console.log(chalk.yellow('\n⚠ No Higgsfield API key found.'));
      console.log(chalk.white('Two options:\n'));
      console.log(chalk.cyan('Option A: Set up API access'));
      console.log(chalk.gray('  export HF_API_KEY=your-key'));
      console.log(chalk.gray('  export HF_API_SECRET=your-secret'));
      console.log(chalk.gray('  Get keys at: https://cloud.higgsfield.ai/\n'));
      console.log(chalk.cyan('Option B: Manual generation (use your free credits)'));
      console.log(chalk.white('  1. Copy the prompt above'));
      console.log(chalk.white('  2. Paste into Higgsfield web UI → select Nano Banana Pro'));
      console.log(chalk.white('  3. Download the result to:'));
      console.log(chalk.yellow(`     ${RAW_DIR}/${promptData.outputName}-raw.png`));
      console.log(chalk.white('  4. Then run:'));
      console.log(chalk.yellow(`     node ${SPRITE_PROCESSOR} process ${RAW_DIR}/${promptData.outputName}-raw.png ${promptData.outputName} -f ${promptData.frames}\n`));

      // Save the prompt to a file for easy copy
      fs.mkdirSync(RAW_DIR, { recursive: true });
      const promptFile = path.join(RAW_DIR, `${promptData.outputName}-prompt.txt`);
      fs.writeFileSync(promptFile, promptData.prompt);
      console.log(chalk.gray(`Prompt saved to: ${promptFile}`));
      return;
    }

    console.log(chalk.cyan('Submitting to Higgsfield API...'));
    try {
      const result = await client.generate(promptData.prompt, {
        model: 'nano-banana-pro',
        resolution: '2K',
        aspectRatio: `${promptData.frames}:1`, // wide aspect for horizontal strip
        onStatus: ({ phase }) => {
          process.stdout.write(chalk.gray(`  Status: ${phase}     \r`));
        },
      });

      // Download the image
      fs.mkdirSync(RAW_DIR, { recursive: true });
      const rawPath = path.join(RAW_DIR, `${promptData.outputName}-raw.png`);

      const imageUrl = result.images?.[0]?.url || result.output?.url;
      if (!imageUrl) {
        console.log(chalk.yellow('\nGeneration complete but no image URL found in response.'));
        console.log(chalk.gray('Response:'), JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan('\nDownloading generated image...'));
      await client.downloadImage(imageUrl, rawPath);
      console.log(chalk.green(`Downloaded: ${rawPath}`));

      if (opts.skipProcess) {
        console.log(chalk.yellow(`\nSkipped processing. Run manually:\n  node ${SPRITE_PROCESSOR} process ${rawPath} ${promptData.outputName} -f ${promptData.frames}`));
        return;
      }

      // Step 3: Process with sprite-processor
      console.log(chalk.cyan('\nProcessing sprite...'));
      const { processSprite } = require('../sprite-processor/index');
      const processResult = await processSprite(rawPath, promptData.outputName, {
        frameCount: promptData.frames,
        targetSize: opts.size,
        tolerance: opts.tolerance,
        outputDir: SOUL_JAM_ASSETS,
      });

      console.log(chalk.green.bold('\n✅ Sprite ready for Soul Jam!'));
      console.log(chalk.white(`   ${processResult.outputPath}`));
      console.log(chalk.gray(`\n   Add to PreloadScene.ts:`));
      console.log(chalk.yellow(`   this.load.spritesheet('${promptData.outputName}', 'assets/images/${promptData.outputName}.png', { frameWidth: ${processResult.frameSize}, frameHeight: ${processResult.frameSize} });`));
      console.log(chalk.gray(`\n   Animation config:`));
      console.log(chalk.yellow(`   this.anims.create({ key: '${promptData.outputName}-anim', frames: this.anims.generateFrameNumbers('${promptData.outputName}', { start: 0, end: ${processResult.frameCount - 1} }), frameRate: ${promptData.fps}, repeat: ${promptData.loop ? -1 : 0} });`));

    } catch (err) {
      console.error(chalk.red(`\nGeneration failed: ${err.message}`));
      process.exit(1);
    }
  });

// ─── PROMPT: Just build and show the prompt ─────────────────────────────
program
  .command('prompt')
  .description('Build and display a sprite prompt (for manual use)')
  .argument('<character>', 'Character name')
  .argument('<animation>', 'Animation name')
  .option('-f, --frames <n>', 'Override frame count', parseInt)
  .option('--copy', 'Copy prompt to clipboard (macOS)')
  .action(async (character, animation, opts) => {
    try {
      const data = buildPrompt(character, animation, { frames: opts.frames });
      console.log(chalk.cyan.bold('\nSprite Prompt:\n'));
      console.log(data.prompt);
      console.log(chalk.gray(`\nFrames: ${data.frames} | Name: ${data.outputName}`));

      if (opts.copy) {
        const { execSync } = require('child_process');
        execSync('pbcopy', { input: data.prompt });
        console.log(chalk.green('\n✓ Copied to clipboard!'));
      }

      // Also save to file
      fs.mkdirSync(RAW_DIR, { recursive: true });
      const promptFile = path.join(RAW_DIR, `${data.outputName}-prompt.txt`);
      fs.writeFileSync(promptFile, data.prompt);
      console.log(chalk.gray(`Saved to: ${promptFile}`));
    } catch (err) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
  });

// ─── CUSTOM: Custom prompt not from templates ───────────────────────────
program
  .command('custom')
  .description('Generate with a custom animation description')
  .argument('<character>', 'Character name')
  .argument('<description>', 'Animation description in quotes')
  .argument('<frames>', 'Number of frames', parseInt)
  .argument('<name>', 'Output name (e.g. "breezy-windmill-dunk")')
  .option('--copy', 'Copy prompt to clipboard')
  .action(async (character, description, frames, name, opts) => {
    try {
      const data = buildCustomPrompt(character, description, frames);
      data.outputName = name;

      console.log(chalk.cyan.bold('\nCustom Sprite Prompt:\n'));
      console.log(data.prompt);
      console.log(chalk.gray(`\nFrames: ${frames} | Name: ${name}`));

      if (opts.copy) {
        const { execSync } = require('child_process');
        execSync('pbcopy', { input: data.prompt });
        console.log(chalk.green('\n✓ Copied to clipboard!'));
      }

      fs.mkdirSync(RAW_DIR, { recursive: true });
      const promptFile = path.join(RAW_DIR, `${name}-prompt.txt`);
      fs.writeFileSync(promptFile, data.prompt);
      console.log(chalk.gray(`Saved to: ${promptFile}`));

      console.log(chalk.yellow(`\nNext steps:`));
      console.log(chalk.white(`  1. Generate using prompt above in Higgsfield`));
      console.log(chalk.white(`  2. Save image to: ${RAW_DIR}/${name}-raw.png`));
      console.log(chalk.white(`  3. Run: node ${SPRITE_PROCESSOR} process ${RAW_DIR}/${name}-raw.png ${name} -f ${frames}`));
    } catch (err) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
  });

// ─── LIST: Show available characters and animations ─────────────────────
program
  .command('list')
  .description('List all available characters and animations')
  .action(() => {
    console.log(chalk.cyan.bold('\nAvailable Characters:\n'));
    for (const [name, char] of Object.entries(CHARACTERS)) {
      console.log(chalk.white.bold(`  ${name}`));
      console.log(chalk.gray(`    ${char.description}`));
    }

    console.log(chalk.cyan.bold('\nAvailable Animations:\n'));
    for (const [name, anim] of Object.entries(ANIMATIONS)) {
      const loopStr = anim.loop ? 'loop' : 'once';
      console.log(chalk.white(`  ${name.padEnd(22)} ${String(anim.frames).padStart(2)} frames  ${String(anim.fps).padStart(2)} fps  ${loopStr}`));
    }

    console.log(chalk.gray(`\nUsage: sprite-gen generate <character> <animation>`));
    console.log(chalk.gray(`       sprite-gen prompt <character> <animation> --copy`));
  });

// ─── SCAN: Check what sprites a character already has ───────────────────
program
  .command('scan')
  .description('Show which sprites a character already has in Soul Jam')
  .argument('<character>', 'Character name')
  .action((character) => {
    console.log(chalk.cyan.bold(`\nSprite scan for: ${character}\n`));

    const allAnims = Object.keys(ANIMATIONS);
    const existing = [];
    const missing = [];

    for (const anim of allAnims) {
      const filename = `${character}-${anim}.png`;
      const filePath = path.join(SOUL_JAM_ASSETS, filename);
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        existing.push({ name: anim, file: filename, size: stats.size });
      } else {
        missing.push(anim);
      }
    }

    if (existing.length > 0) {
      console.log(chalk.green.bold('  Existing:'));
      for (const e of existing) {
        console.log(chalk.green(`    ✓ ${e.name.padEnd(22)} ${e.file} (${(e.size / 1024).toFixed(1)}KB)`));
      }
    }

    if (missing.length > 0) {
      console.log(chalk.yellow.bold('\n  Missing:'));
      for (const m of missing) {
        console.log(chalk.yellow(`    ✗ ${m}`));
      }
    }

    console.log(chalk.gray(`\n  ${existing.length}/${allAnims.length} animations present`));

    if (missing.length > 0) {
      console.log(chalk.gray(`\n  Generate missing sprites:`));
      for (const m of missing) {
        console.log(chalk.gray(`    sprite-gen generate ${character} ${m}`));
      }
    }
  });

program.parse();
