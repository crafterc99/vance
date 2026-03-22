/**
 * Browser Tool — Playwright-based web automation
 *
 * Actions:
 *   navigate    — Go to a URL, return page content
 *   screenshot  — Capture a screenshot of a page
 *   click       — Click an element by selector
 *   type        — Type text into an element
 *   extract     — Extract text/data from a page using selectors
 *   evaluate    — Run JavaScript in the page context
 *   pdf         — Save page as PDF
 */

const logger = require('../runtime/logger');

const description = 'Web browser automation via Playwright';
const actions = ['navigate', 'screenshot', 'click', 'type', 'extract', 'evaluate', 'pdf'];

let browser = null;
let context = null;

async function getBrowser() {
  if (browser) return browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: 'Vance/1.0 (Personal AI Assistant)',
      viewport: { width: 1280, height: 800 },
    });
    logger.log('browser-init', { status: 'launched' });
    return browser;
  } catch (e) {
    logger.log('browser-error', { error: `Failed to launch: ${e.message}` });
    throw new Error(`Browser launch failed: ${e.message}. Run 'npx playwright install chromium' to install.`);
  }
}

async function getPage(url) {
  await getBrowser();
  const page = await context.newPage();
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  return page;
}

/**
 * @param {object} input - { action, url, selector, text, script, path, waitFor }
 * @param {object} ctx - { wsSend }
 */
async function execute(input, ctx = {}) {
  const { action = 'navigate', url, selector, text, script, path: savePath, waitFor } = input;
  const { wsSend } = ctx;

  if (wsSend) wsSend({ type: 'tool-execution', tool: 'browser', status: 'running', action });

  switch (action) {
    case 'navigate': {
      if (!url) throw new Error('Missing required field: url');
      const page = await getPage(url);
      if (waitFor) await page.waitForSelector(waitFor, { timeout: 10000 }).catch(() => {});
      const title = await page.title();
      const content = await page.evaluate(() => {
        // Get readable text content, truncated
        const body = document.body;
        if (!body) return '';
        // Remove script/style tags
        const clone = body.cloneNode(true);
        clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
        return clone.innerText.slice(0, 8000);
      });
      const pageUrl = page.url();
      await page.close();
      return { title, url: pageUrl, content, contentLength: content.length };
    }

    case 'screenshot': {
      if (!url) throw new Error('Missing required field: url');
      const page = await getPage(url);
      if (waitFor) await page.waitForSelector(waitFor, { timeout: 10000 }).catch(() => {});
      const buffer = await page.screenshot({ fullPage: input.fullPage || false });
      const screenshotPath = savePath || `/tmp/vance-screenshot-${Date.now()}.png`;
      require('fs').writeFileSync(screenshotPath, buffer);
      await page.close();
      return { path: screenshotPath, size: buffer.length };
    }

    case 'click': {
      if (!url || !selector) throw new Error('Missing required fields: url, selector');
      const page = await getPage(url);
      await page.click(selector, { timeout: 10000 });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      const title = await page.title();
      const newUrl = page.url();
      await page.close();
      return { clicked: selector, title, url: newUrl };
    }

    case 'type': {
      if (!url || !selector || !text) throw new Error('Missing required fields: url, selector, text');
      const page = await getPage(url);
      await page.fill(selector, text, { timeout: 10000 });
      await page.close();
      return { typed: text.length + ' chars', selector };
    }

    case 'extract': {
      if (!url) throw new Error('Missing required field: url');
      const page = await getPage(url);
      if (waitFor) await page.waitForSelector(waitFor, { timeout: 10000 }).catch(() => {});

      let extracted;
      if (selector) {
        extracted = await page.$$eval(selector, els =>
          els.map(el => ({
            text: el.innerText?.slice(0, 500),
            href: el.href || null,
            src: el.src || null,
          })).slice(0, 50)
        ).catch(() => []);
      } else {
        // Extract all links and headings
        extracted = await page.evaluate(() => {
          const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => ({
            tag: h.tagName, text: h.innerText.slice(0, 200),
          }));
          const links = [...document.querySelectorAll('a[href]')].slice(0, 30).map(a => ({
            text: a.innerText.slice(0, 100), href: a.href,
          }));
          return { headings, links };
        });
      }
      await page.close();
      return { url, extracted };
    }

    case 'evaluate': {
      if (!url || !script) throw new Error('Missing required fields: url, script');
      const page = await getPage(url);
      const result = await page.evaluate(script);
      await page.close();
      return { result: typeof result === 'object' ? result : String(result) };
    }

    case 'pdf': {
      if (!url) throw new Error('Missing required field: url');
      const page = await getPage(url);
      const pdfPath = savePath || `/tmp/vance-page-${Date.now()}.pdf`;
      await page.pdf({ path: pdfPath, format: 'A4' });
      await page.close();
      return { path: pdfPath };
    }

    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
}

// Cleanup on process exit
process.on('exit', () => {
  if (browser) browser.close().catch(() => {});
});

module.exports = { execute, description, actions };
