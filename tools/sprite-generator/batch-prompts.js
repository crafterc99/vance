#!/usr/bin/env node
/**
 * Interactive batch prompt helper — copies prompts to clipboard one at a time.
 * Hit Enter after each generation to get the next prompt.
 *
 * Usage: node batch-prompts.js 99
 */
const { ANIMATIONS, buildPrompt } = require('./prompts');
const { execSync } = require('child_process');
const readline = require('readline');
const chalk = require('chalk');

const character = process.argv[2] || '99';
const allAnims = Object.keys(ANIMATIONS);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log(chalk.cyan.bold(`\n🏀 Batch Prompt Generator — ${character.toUpperCase()}`));
console.log(chalk.gray(`${allAnims.length} animations to generate\n`));
console.log(chalk.white('Workflow for each:'));
console.log(chalk.gray('  1. Prompt is auto-copied to clipboard'));
console.log(chalk.gray('  2. Paste into Higgsfield → Nano Banana Pro → Generate'));
console.log(chalk.gray('  3. Download result, save as shown'));
console.log(chalk.gray('  4. Press Enter for next prompt\n'));

let index = 0;

function nextPrompt() {
  if (index >= allAnims.length) {
    console.log(chalk.green.bold('\n✅ All done! All 12 prompts generated.'));
    console.log(chalk.white('\nNow drop all raw PNGs into raw-sprites/ and run:'));
    console.log(chalk.yellow('  npm run sprite:watch'));
    console.log(chalk.gray('  (or process individually with npm run sprite:process)\n'));
    rl.close();
    return;
  }

  const anim = allAnims[index];
  const data = buildPrompt(character, anim);

  // Copy to clipboard
  try {
    execSync('pbcopy', { input: data.prompt });
  } catch (e) { /* non-mac fallback */ }

  console.log(chalk.cyan.bold(`\n[${ index + 1}/${allAnims.length}] ${data.outputName}`));
  console.log(chalk.gray(`Frames: ${data.frames} | FPS: ${data.fps} | Loop: ${data.loop}`));
  console.log(chalk.green('✓ Copied to clipboard!'));
  console.log(chalk.white(`Save as: `) + chalk.yellow(`raw-sprites/${data.outputName}-raw.png`));

  index++;
  rl.question(chalk.gray('\nPress Enter for next prompt (or q to quit)... '), (answer) => {
    if (answer.toLowerCase() === 'q') {
      console.log(chalk.gray('\nStopped.'));
      rl.close();
      return;
    }
    nextPrompt();
  });
}

nextPrompt();
