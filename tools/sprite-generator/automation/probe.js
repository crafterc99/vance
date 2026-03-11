#!/usr/bin/env node
/**
 * Probe Higgsfield pages to find Nano Banana Pro unlimited.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const USER_DATA_DIR = path.resolve(__dirname, '../../.browser-profile');
const SS_DIR = path.resolve(__dirname, '../../../.screenshots');
fs.mkdirSync(SS_DIR, { recursive: true });

const PAGES_TO_CHECK = [
  'https://higgsfield.ai/nano-banana-pro',
  'https://higgsfield.ai/image/nano_banana_pro',
  'https://higgsfield.ai/create-image',
];

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  for (let i = 0; i < PAGES_TO_CHECK.length; i++) {
    const url = PAGES_TO_CHECK[i];
    console.log(`\n=== Checking: ${url} ===`);
    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);

      const finalUrl = page.url();
      console.log('Redirected to:', finalUrl);

      await page.screenshot({ path: path.join(SS_DIR, `probe-page-${i + 1}.png`) });

      // Get key info
      const info = await page.evaluate(() => {
        const body = document.body ? document.body.innerText : '';
        // Look for model/credit info
        const creditInfo = [];
        const lines = body.split('\n');
        for (const line of lines) {
          const l = line.trim();
          if (l && (l.includes('credit') || l.includes('Credit') || l.includes('unlimited') || l.includes('Unlimited') ||
              l.includes('free') || l.includes('Free') || l.includes('Nano Banana') || l.includes('Generate') ||
              l.includes('2K') || l.includes('1K') || l.includes('4K') || l.includes('resolution'))) {
            creditInfo.push(l.substring(0, 120));
          }
        }
        return {
          title: document.title,
          url: window.location.href,
          creditInfo: creditInfo.slice(0, 30),
          buttons: Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null).map(b => (b.textContent || '').trim().substring(0, 50)).filter(t => t).slice(0, 20),
          textareas: document.querySelectorAll('textarea').length,
          fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map(f => ({ id: f.id, accept: f.accept })),
        };
      });

      console.log('Title:', info.title);
      console.log('Buttons:', info.buttons);
      console.log('File inputs:', info.fileInputs);
      console.log('Credit/model info:');
      info.creditInfo.forEach(c => console.log('  ', c));
    } catch (e) {
      console.log('Error:', e.message.substring(0, 100));
    }

    await page.close();
  }

  await context.close();
  console.log('\nDone! Check .screenshots/probe-page-*.png');
})().catch(e => { console.error(e.message); process.exit(1); });
