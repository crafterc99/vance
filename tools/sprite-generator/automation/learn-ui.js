#!/usr/bin/env node
/**
 * UI Learner — Opens Higgsfield and maps the actual DOM elements.
 * Run this ONCE after logging in to capture the exact selectors
 * for the current UI version. Saves a selector map to selectors.json.
 *
 * Usage: node learn-ui.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

const USER_DATA_DIR = path.resolve(__dirname, '../../.browser-profile');
const SELECTORS_FILE = path.resolve(__dirname, 'selectors.json');
const SCREENSHOTS_DIR = path.resolve(__dirname, '../../.screenshots');

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function learnUI() {
  console.log(chalk.cyan.bold('\n🔍 Learning Higgsfield UI...\n'));

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = await context.newPage();
  await page.goto('https://higgsfield.ai/create-image', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'learn-01-initial.png') });

  const selectors = {};

  // ─── Find prompt input ───────────────────────────────────────────────
  console.log(chalk.white('Looking for prompt input...'));
  const promptCandidates = await page.evaluate(() => {
    const results = [];
    // Textareas
    document.querySelectorAll('textarea').forEach((el, i) => {
      results.push({
        type: 'textarea',
        index: i,
        placeholder: el.placeholder,
        className: el.className.substring(0, 100),
        id: el.id,
        name: el.name,
        visible: el.offsetParent !== null,
        rect: el.getBoundingClientRect(),
      });
    });
    // Contenteditable
    document.querySelectorAll('[contenteditable="true"]').forEach((el, i) => {
      results.push({
        type: 'contenteditable',
        index: i,
        className: el.className.substring(0, 100),
        role: el.getAttribute('role'),
        visible: el.offsetParent !== null,
        rect: el.getBoundingClientRect(),
      });
    });
    // Inputs of type text
    document.querySelectorAll('input[type="text"]').forEach((el, i) => {
      results.push({
        type: 'input-text',
        index: i,
        placeholder: el.placeholder,
        className: el.className.substring(0, 100),
        visible: el.offsetParent !== null,
        rect: el.getBoundingClientRect(),
      });
    });
    return results;
  });
  selectors.promptInput = promptCandidates;
  console.log(chalk.gray(`  Found ${promptCandidates.length} candidates`));
  promptCandidates.forEach(c => {
    console.log(chalk.gray(`    ${c.type}${c.visible ? ' (visible)' : ' (hidden)'} placeholder="${c.placeholder || ''}" class="${c.className.substring(0, 50)}"`));
  });

  // ─── Find buttons ────────────────────────────────────────────────────
  console.log(chalk.white('\nLooking for buttons...'));
  const buttons = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('button, [role="button"]').forEach((el, i) => {
      const text = el.textContent?.trim().substring(0, 50);
      if (text) {
        results.push({
          index: i,
          text,
          className: el.className.substring(0, 100),
          ariaLabel: el.getAttribute('aria-label'),
          visible: el.offsetParent !== null,
          rect: el.getBoundingClientRect(),
        });
      }
    });
    return results;
  });
  selectors.buttons = buttons.filter(b => b.visible);
  console.log(chalk.gray(`  Found ${selectors.buttons.length} visible buttons`));
  selectors.buttons.slice(0, 20).forEach(b => {
    console.log(chalk.gray(`    "${b.text}" class="${b.className.substring(0, 40)}"`));
  });

  // ─── Find file inputs ────────────────────────────────────────────────
  console.log(chalk.white('\nLooking for file inputs...'));
  const fileInputs = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('input[type="file"]').forEach((el, i) => {
      results.push({
        index: i,
        accept: el.accept,
        multiple: el.multiple,
        className: el.className.substring(0, 100),
        name: el.name,
        id: el.id,
      });
    });
    return results;
  });
  selectors.fileInputs = fileInputs;
  console.log(chalk.gray(`  Found ${fileInputs.length} file inputs`));
  fileInputs.forEach(f => {
    console.log(chalk.gray(`    accept="${f.accept}" multiple=${f.multiple} id="${f.id}"`));
  });

  // ─── Find model/option selectors ─────────────────────────────────────
  console.log(chalk.white('\nLooking for model selectors...'));
  const modelOptions = await page.evaluate(() => {
    const results = [];
    // Look for text mentioning model names
    const body = document.body.innerText;
    const models = ['Nano Banana', 'FLUX', 'Soul', 'Seedream', 'GPT Image'];
    models.forEach(m => {
      if (body.includes(m)) results.push({ model: m, found: true });
    });

    // Look for select elements
    document.querySelectorAll('select').forEach((el, i) => {
      results.push({
        type: 'select',
        options: Array.from(el.options).map(o => o.text).slice(0, 10),
      });
    });

    // Look for dropdown-like elements
    document.querySelectorAll('[class*="select"], [class*="dropdown"], [class*="menu"]').forEach((el, i) => {
      if (i < 5) {
        results.push({
          type: 'dropdown-like',
          text: el.textContent?.trim().substring(0, 80),
          className: el.className.substring(0, 60),
        });
      }
    });

    return results;
  });
  selectors.modelOptions = modelOptions;
  console.log(chalk.gray(`  ${JSON.stringify(modelOptions, null, 2).substring(0, 500)}`));

  // ─── Find image upload zones ─────────────────────────────────────────
  console.log(chalk.white('\nLooking for drag/drop zones...'));
  const dropZones = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('[class*="drop"], [class*="upload"], [class*="drag"]').forEach((el, i) => {
      if (i < 5) {
        results.push({
          className: el.className.substring(0, 100),
          text: el.textContent?.trim().substring(0, 80),
          visible: el.offsetParent !== null,
        });
      }
    });
    return results;
  });
  selectors.dropZones = dropZones;
  console.log(chalk.gray(`  Found ${dropZones.length} potential upload zones`));

  // Save selectors
  fs.writeFileSync(SELECTORS_FILE, JSON.stringify(selectors, null, 2));
  console.log(chalk.green(`\n✓ Selectors saved to: ${SELECTORS_FILE}`));
  console.log(chalk.gray('  Screenshots saved to .screenshots/\n'));

  // Take a full-page screenshot
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'learn-02-full.png'), fullPage: true });

  // Close
  console.log(chalk.yellow('Browser is still open. Explore the UI, then close when done.'));
  await new Promise(resolve => context.on('close', resolve));
}

learnUI().catch(err => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
