#!/usr/bin/env node
/**
 * Fully Automated Sprite Generator via Higgsfield Browser Automation
 *
 * Drives Higgsfield's web UI using Playwright:
 *   1. Uses persistent browser profile (log in once, stays logged in)
 *   2. For each animation: uploads character ref + Breezy pose ref, enters prompt, generates
 *   3. Downloads results automatically
 *   4. Feeds into sprite processor pipeline
 *
 * Usage:
 *   node auto-generate.js login          # First time: log into Higgsfield
 *   node auto-generate.js generate 99    # Generate all animations for character 99
 *   node auto-generate.js generate 99 idle-dribble  # Generate single animation
 *   node auto-generate.js test           # Test connection & login state
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const sharp = require('sharp');
const { ANIMATIONS, buildPrompt, CHARACTERS } = require('../prompts');

const USER_DATA_DIR = path.resolve(__dirname, '../../.browser-profile');
const SCREENSHOTS_DIR = path.resolve(__dirname, '../../.screenshots');
const DOWNLOADS_DIR = path.resolve(__dirname, '../../../raw-sprites');
const REFS_DIR = path.resolve(__dirname, '../../../raw-sprites/references');
const SOUL_JAM_ASSETS = path.resolve(__dirname, '../../../../soul-jam/public/assets/images');

const BREEZY_SPRITE_MAP = {
  'idle-dribble': { file: 'breezy-static-dribble.png', frameW: 180, frameH: 180 },
  'dribble': { file: 'breezy-dribble.png', frameW: 180, frameH: 180 },
  'jumpshot': { file: 'breezy-jumpshot.png', frameW: 180, frameH: 180 },
  'stepback': { file: 'breezy-stepback.png', frameW: 180, frameH: 180 },
  'crossover': { file: 'breezy-crossover.png', frameW: 180, frameH: 180 },
  'defense-backpedal': { file: 'breezy-defense-backpedal.png', frameW: 180, frameH: 180 },
  'defense-shuffle': { file: 'breezy-defense-shuffle.png', frameW: 180, frameH: 180 },
  'steal': { file: 'breezy-steal.png', frameW: 180, frameH: 180 },
};

const DEFAULT_CHAR_REF = '/Users/crafterc/Downloads/hf_20260308_035112_1880e12f-0043-4740-aa86-a08758745e0b.png';

// Ensure directories exist
[SCREENSHOTS_DIR, DOWNLOADS_DIR, REFS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${name}.png`), fullPage: false });
}

async function launchBrowser(headed = true) {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: !headed,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return context;
}

// ─── LOGIN: Open browser for manual login ───────────────────────────────
async function login() {
  console.log(chalk.cyan.bold('\n🔐 Higgsfield Login\n'));
  console.log(chalk.white('A browser window will open. Log into Higgsfield.'));
  console.log(chalk.white('Once logged in, close the browser or press Ctrl+C.\n'));
  console.log(chalk.gray('Your session will be saved for future automation runs.\n'));

  const context = await launchBrowser(true);
  const page = await context.newPage();
  await page.goto('https://higgsfield.ai/create-image');

  console.log(chalk.yellow('Waiting for you to log in...'));
  console.log(chalk.gray('(Close browser when done)\n'));

  // Wait until browser is closed
  await new Promise(resolve => {
    context.on('close', resolve);
  });

  console.log(chalk.green('✓ Session saved! You can now run automation.\n'));
}

// ─── TEST: Verify logged-in state ───────────────────────────────────────
async function testConnection() {
  console.log(chalk.cyan('Testing Higgsfield connection...'));

  const context = await launchBrowser(true);
  const page = await context.newPage();

  await page.goto('https://higgsfield.ai/create-image', { waitUntil: 'networkidle' });
  await screenshot(page, 'test-connection');

  // Check if we see generate UI elements (not a login page)
  const hasPromptBox = await page.locator('textarea').count() > 0;
  const pageText = await page.textContent('body');
  const isLoggedIn = !pageText.includes('Sign in') || hasPromptBox;

  if (isLoggedIn) {
    console.log(chalk.green('✓ Logged in and ready!'));
  } else {
    console.log(chalk.red('✗ Not logged in. Run: node auto-generate.js login'));
  }

  await screenshot(page, 'test-final');
  await context.close();
  return isLoggedIn;
}

// ─── BUILD REFERENCE IMAGE ─────────────────────────────────────────────
async function buildReference(animName, charRefPath) {
  const breezyRef = BREEZY_SPRITE_MAP[animName];
  if (!breezyRef) return { charRef: charRefPath, poseRef: null };

  const breezyPath = path.join(SOUL_JAM_ASSETS, breezyRef.file);
  if (!fs.existsSync(breezyPath)) return { charRef: charRefPath, poseRef: null };

  return { charRef: charRefPath, poseRef: breezyPath };
}

// ─── GENERATE: Main automation ──────────────────────────────────────────
async function generateAnimation(context, characterName, animName, charRefPath) {
  const data = buildPrompt(characterName, animName);
  const refs = await buildReference(animName, charRefPath);

  console.log(chalk.cyan(`\n  Generating: ${data.outputName} (${data.frames} frames)`));

  const page = await context.newPage();

  try {
    // Navigate to Nano Banana Pro generation page
    await page.goto('https://higgsfield.ai/create-image', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await screenshot(page, `${data.outputName}-01-loaded`);

    // Try to find and select Nano Banana Pro model
    // Look for model selector - could be a dropdown, tabs, or buttons
    const modelSelectors = [
      'text=Nano Banana',
      'text=nano_banana_pro',
      '[data-model="nano_banana_pro"]',
      'button:has-text("Nano")',
    ];

    let modelFound = false;
    for (const sel of modelSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          await el.click();
          modelFound = true;
          console.log(chalk.gray(`    Selected model via: ${sel}`));
          break;
        }
      } catch (e) { /* try next */ }
    }

    if (!modelFound) {
      // Try clicking a model dropdown first
      try {
        const dropdown = page.locator('[class*="model"], [class*="select"], [aria-label*="model"]').first();
        if (await dropdown.isVisible({ timeout: 2000 })) {
          await dropdown.click();
          await page.waitForTimeout(500);
          const nanoBanana = page.locator('text=Nano Banana Pro').first();
          if (await nanoBanana.isVisible({ timeout: 2000 })) {
            await nanoBanana.click();
            modelFound = true;
          }
        }
      } catch (e) { /* continue anyway */ }
    }

    await screenshot(page, `${data.outputName}-02-model`);

    // Find the prompt input (textarea or contenteditable)
    const promptInput = page.locator('textarea, [contenteditable="true"], [role="textbox"]').first();
    await promptInput.waitFor({ state: 'visible', timeout: 10000 });
    await promptInput.click();
    await promptInput.fill('');
    await page.waitForTimeout(300);
    await promptInput.fill(data.prompt);
    console.log(chalk.gray(`    Entered prompt (${data.prompt.length} chars)`));
    await screenshot(page, `${data.outputName}-03-prompt`);

    // Upload character reference image
    if (refs.charRef && fs.existsSync(refs.charRef)) {
      try {
        // Look for image reference/upload button
        const refButtons = [
          'text=Add Reference',
          'text=Reference',
          'text=Upload',
          'button:has-text("Image")',
          '[class*="reference"]',
          '[class*="upload"]',
          '[aria-label*="reference"]',
          '[aria-label*="upload"]',
        ];

        let uploadTriggered = false;
        for (const sel of refButtons) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 2000 })) {
              await btn.click();
              uploadTriggered = true;
              console.log(chalk.gray(`    Opened upload via: ${sel}`));
              break;
            }
          } catch (e) { /* try next */ }
        }

        if (uploadTriggered) {
          await page.waitForTimeout(1000);

          // Look for file input
          const fileInput = page.locator('input[type="file"]').first();
          if (await fileInput.count() > 0) {
            await fileInput.setInputFiles(refs.charRef);
            console.log(chalk.gray(`    Uploaded character reference`));
            await page.waitForTimeout(2000);

            // If there's a Breezy pose reference too, try uploading that
            if (refs.poseRef && fs.existsSync(refs.poseRef)) {
              try {
                // Look for another upload button or "add more" option
                const addMore = page.locator('text=Add, text=More, [class*="add"]').first();
                if (await addMore.isVisible({ timeout: 2000 })) {
                  await addMore.click();
                  await page.waitForTimeout(500);
                }
                const fileInput2 = page.locator('input[type="file"]').first();
                await fileInput2.setInputFiles(refs.poseRef);
                console.log(chalk.gray(`    Uploaded pose reference (Breezy)`));
                await page.waitForTimeout(2000);
              } catch (e) {
                console.log(chalk.yellow(`    Could not upload pose ref: ${e.message}`));
              }
            }
          }
        } else {
          console.log(chalk.yellow('    No reference upload button found'));
        }
      } catch (e) {
        console.log(chalk.yellow(`    Reference upload skipped: ${e.message}`));
      }
    }

    await screenshot(page, `${data.outputName}-04-ready`);

    // Click Generate button
    const generateButtons = [
      'button:has-text("Generate")',
      'button:has-text("Create")',
      'button[type="submit"]',
      '[class*="generate"]',
      '[class*="submit"]',
    ];

    let generated = false;
    for (const sel of generateButtons) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click();
          generated = true;
          console.log(chalk.gray(`    Clicked generate via: ${sel}`));
          break;
        }
      } catch (e) { /* try next */ }
    }

    if (!generated) {
      console.log(chalk.red(`    Could not find Generate button! Check screenshot.`));
      await screenshot(page, `${data.outputName}-05-no-generate`);
      await page.close();
      return null;
    }

    // Wait for generation to complete
    console.log(chalk.gray('    Waiting for generation...'));
    await screenshot(page, `${data.outputName}-05-generating`);

    // Poll for completion - look for the generated image
    let imageFound = false;
    const maxWait = 120000; // 2 minutes
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await page.waitForTimeout(5000);
      await screenshot(page, `${data.outputName}-06-waiting`);

      // Look for generated image or download button
      const imgSelectors = [
        'img[class*="generated"]',
        'img[class*="result"]',
        '[class*="result"] img',
        '[class*="output"] img',
        'button:has-text("Download")',
        'a[download]',
      ];

      for (const sel of imgSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 })) {
            imageFound = true;
            break;
          }
        } catch (e) { /* continue */ }
      }

      if (imageFound) break;

      // Check for errors
      const errorSels = ['text=Error', 'text=Failed', 'text=failed', '[class*="error"]'];
      for (const sel of errorSels) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 500 })) {
            const errText = await el.textContent();
            console.log(chalk.red(`    Generation error: ${errText}`));
            break;
          }
        } catch (e) { /* continue */ }
      }
    }

    if (!imageFound) {
      console.log(chalk.red('    Generation timed out'));
      await screenshot(page, `${data.outputName}-07-timeout`);
      await page.close();
      return null;
    }

    console.log(chalk.green('    Generation complete!'));
    await screenshot(page, `${data.outputName}-07-done`);

    // Download the image
    const outputPath = path.join(DOWNLOADS_DIR, `${data.outputName}-raw.png`);

    // Try right-click save or download button
    try {
      // Method 1: Click download button
      const dlBtn = page.locator('button:has-text("Download"), a[download], [aria-label*="download"], [class*="download"]').first();
      if (await dlBtn.isVisible({ timeout: 3000 })) {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          dlBtn.click(),
        ]);
        await download.saveAs(outputPath);
        console.log(chalk.green(`    Downloaded: ${data.outputName}-raw.png`));
      } else {
        // Method 2: Get image URL directly and fetch it
        const imgEl = page.locator('[class*="result"] img, [class*="output"] img, img[class*="generated"]').first();
        if (await imgEl.isVisible({ timeout: 3000 })) {
          const imgUrl = await imgEl.getAttribute('src');
          if (imgUrl) {
            const response = await page.request.get(imgUrl);
            const buffer = await response.body();
            fs.writeFileSync(outputPath, buffer);
            console.log(chalk.green(`    Saved image from URL: ${data.outputName}-raw.png`));
          }
        }
      }
    } catch (e) {
      console.log(chalk.yellow(`    Auto-download failed: ${e.message}`));
      console.log(chalk.yellow('    Manually save the image from the browser to:'));
      console.log(chalk.yellow(`    ${outputPath}`));

      // Wait for manual save
      console.log(chalk.gray('    Waiting 30s for manual save...'));
      await page.waitForTimeout(30000);
    }

    await page.close();
    return fs.existsSync(outputPath) ? outputPath : null;

  } catch (err) {
    console.log(chalk.red(`    Error: ${err.message}`));
    await screenshot(page, `${data.outputName}-error`);
    await page.close();
    return null;
  }
}

async function generateAll(characterName, charRefPath, singleAnim) {
  const anims = singleAnim ? [singleAnim] : Object.keys(ANIMATIONS);

  console.log(chalk.cyan.bold(`\n🎮 Automated Sprite Generation — ${characterName.toUpperCase()}`));
  console.log(chalk.gray(`${anims.length} animation(s) to generate\n`));
  console.log(chalk.gray(`Character ref: ${charRefPath}`));
  console.log(chalk.gray(`Screenshots: ${SCREENSHOTS_DIR}\n`));

  const context = await launchBrowser(true);
  const results = [];

  for (let i = 0; i < anims.length; i++) {
    const animName = anims[i];
    console.log(chalk.white.bold(`\n[${i + 1}/${anims.length}] ${characterName}-${animName}`));

    const outputPath = await generateAnimation(context, characterName, animName, charRefPath);

    if (outputPath) {
      // Process the raw sprite
      try {
        const { processSprite } = require('../../sprite-processor/index');
        const anim = ANIMATIONS[animName];
        console.log(chalk.cyan(`  Processing sprite (${anim.frames} frames)...`));

        const result = await processSprite(outputPath, `${characterName}-${animName}`, {
          frameCount: anim.frames,
          targetSize: 180,
          tolerance: 40,
          outputDir: SOUL_JAM_ASSETS,
        });

        console.log(chalk.green.bold(`  ✅ ${characterName}-${animName} ready!`));
        results.push({ animName, success: true, output: result.outputPath });
      } catch (err) {
        console.log(chalk.yellow(`  Processing failed: ${err.message}`));
        results.push({ animName, success: false, raw: outputPath, error: err.message });
      }
    } else {
      results.push({ animName, success: false, error: 'Generation failed' });
    }

    // Brief pause between generations to avoid rate limiting
    if (i < anims.length - 1) {
      console.log(chalk.gray('  Cooling down 5s...'));
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  await context.close();

  // Summary
  console.log(chalk.cyan.bold('\n\n═══ GENERATION SUMMARY ═══\n'));
  const succeeded = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  for (const r of results) {
    if (r.success) {
      console.log(chalk.green(`  ✓ ${r.animName.padEnd(22)} → ${path.basename(r.output)}`));
    } else {
      console.log(chalk.red(`  ✗ ${r.animName.padEnd(22)} — ${r.error}`));
    }
  }

  console.log(chalk.white(`\n  ${succeeded.length}/${results.length} successful`));

  if (succeeded.length > 0) {
    console.log(chalk.gray('\n  Add to PreloadScene.ts:'));
    for (const r of succeeded) {
      const anim = ANIMATIONS[r.animName];
      console.log(chalk.yellow(`  this.load.spritesheet('${characterName}-${r.animName}', 'assets/images/${characterName}-${r.animName}.png', { frameWidth: 180, frameHeight: 180 });`));
    }
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────
const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

if (!command) {
  console.log(chalk.cyan.bold('\n🎮 Higgsfield Sprite Automation\n'));
  console.log(chalk.white('Commands:'));
  console.log(chalk.gray('  login                     Open browser to log into Higgsfield (first time only)'));
  console.log(chalk.gray('  test                      Verify login state'));
  console.log(chalk.gray('  generate <char>           Generate ALL animations for a character'));
  console.log(chalk.gray('  generate <char> <anim>    Generate a single animation'));
  console.log(chalk.gray('\nExamples:'));
  console.log(chalk.yellow('  node auto-generate.js login'));
  console.log(chalk.yellow('  node auto-generate.js generate 99'));
  console.log(chalk.yellow('  node auto-generate.js generate 99 idle-dribble'));
  process.exit(0);
}

(async () => {
  switch (command) {
    case 'login':
      await login();
      break;
    case 'test':
      await testConnection();
      break;
    case 'generate':
      if (!arg1) {
        console.error(chalk.red('Character name required. Usage: generate <char> [anim]'));
        process.exit(1);
      }
      if (!CHARACTERS[arg1]) {
        console.error(chalk.red(`Unknown character: ${arg1}. Available: ${Object.keys(CHARACTERS).join(', ')}`));
        process.exit(1);
      }
      const charRef = CHARACTERS[arg1].referenceImage || DEFAULT_CHAR_REF;
      await generateAll(arg1, charRef, arg2 || null);
      break;
    default:
      console.error(chalk.red(`Unknown command: ${command}`));
      process.exit(1);
  }
})().catch(err => {
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});
