/**
 * Research Tool — Web research pipeline
 *
 * Priority chain for search:
 *   1. Firecrawl /v1/search (if FIRECRAWL_API_KEY set) — best quality
 *   2. Bing via Playwright — reliable fallback, no API key needed
 *
 * Priority chain for page fetch:
 *   1. Firecrawl /v1/scrape (clean markdown extraction)
 *   2. Playwright navigate (raw text extraction)
 *
 * Actions:
 *   search     — Search the web and return results
 *   fetch      — Fetch and extract content from a URL
 *   summarize  — Fetch a page (summary done by calling model)
 *   multi      — Fetch multiple URLs and compile results
 */

const logger = require('../runtime/logger');

const description = 'Web research and content extraction (Firecrawl + Playwright)';
const actions = ['search', 'fetch', 'summarize', 'multi'];

function getFirecrawlKey() {
  return process.env.FIRECRAWL_API_KEY || '';
}

/**
 * @param {object} input - { action, query, url, urls, maxResults }
 * @param {object} ctx - { wsSend }
 */
async function execute(input, ctx = {}) {
  const { action = 'search', query, url, urls, maxResults = 5 } = input;
  const { wsSend } = ctx;

  if (wsSend) wsSend({ type: 'tool-execution', tool: 'research', status: 'running', action });

  switch (action) {
    case 'search':
      return searchWeb(query, maxResults);

    case 'fetch':
      if (!url) throw new Error('Missing required field: url');
      return fetchPage(url);

    case 'summarize':
      if (!url) throw new Error('Missing required field: url');
      return fetchPage(url);

    case 'multi':
      if (!urls || !urls.length) throw new Error('Missing required field: urls');
      return fetchMultiple(urls);

    default:
      throw new Error(`Unknown research action: ${action}`);
  }
}

// ─── Search ─────────────────────────────────────────────────────

async function searchWeb(query, maxResults = 5) {
  if (!query) throw new Error('Missing required field: query');

  // Try Firecrawl search first
  const fcKey = getFirecrawlKey();
  if (fcKey) {
    try {
      const results = await firecrawlSearch(query, maxResults, fcKey);
      if (results.resultCount > 0) return results;
      logger.log('research-firecrawl-empty', { query });
    } catch (e) {
      logger.log('research-firecrawl-error', { query, error: e.message });
    }
  }

  // Fallback to Bing via Playwright
  try {
    return await bingSearch(query, maxResults);
  } catch (e) {
    logger.log('research-error', { action: 'search', error: e.message });
    return { query, resultCount: 0, results: [], error: e.message };
  }
}

/**
 * Firecrawl /v1/search — high-quality web search with content extraction
 */
async function firecrawlSearch(query, maxResults, apiKey) {
  const res = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      limit: maxResults,
      lang: 'en',
      scrapeOptions: { formats: ['markdown'] },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firecrawl search ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();

  if (!data.success || !data.data?.length) {
    return { query, resultCount: 0, results: [], source: 'firecrawl' };
  }

  const results = data.data.slice(0, maxResults).map((item, i) => ({
    rank: i + 1,
    title: item.metadata?.title || item.title || 'Untitled',
    snippet: (item.markdown || item.content || '').slice(0, 500),
    url: item.url || item.metadata?.sourceURL || '',
    source: 'firecrawl',
  }));

  logger.log('research-search', { query, source: 'firecrawl', count: results.length });
  return { query, resultCount: results.length, results, source: 'firecrawl' };
}

/**
 * Bing search via Playwright — reliable fallback, no API key needed
 */
async function bingSearch(query, maxResults) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });

  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();
    await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded', timeout: 15000,
    });
    await page.waitForTimeout(1500);

    const results = await page.evaluate((max) => {
      return [...document.querySelectorAll('.b_algo')].slice(0, max).map(el => ({
        title: el.querySelector('h2')?.textContent?.trim() || '',
        snippet: el.querySelector('.b_caption p')?.textContent?.trim() ||
                 el.querySelector('.b_caption')?.textContent?.trim() || '',
        url: el.querySelector('h2 a')?.href || el.querySelector('a')?.href || '',
      }));
    }, maxResults);

    logger.log('research-search', { query, source: 'bing', count: results.length });
    return {
      query,
      resultCount: results.length,
      results: results.map((r, i) => ({ rank: i + 1, ...r, source: 'bing' })),
      source: 'bing',
    };
  } finally {
    await browser.close();
  }
}

// ─── Fetch ──────────────────────────────────────────────────────

/**
 * Fetch and extract content from a URL.
 * Firecrawl first (clean markdown), Playwright fallback (raw text).
 */
async function fetchPage(url) {
  const fcKey = getFirecrawlKey();
  if (fcKey) {
    try {
      const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${fcKey}`,
        },
        body: JSON.stringify({ url, formats: ['markdown'] }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success && data.data) {
          return {
            url,
            title: data.data.metadata?.title || '',
            content: (data.data.markdown || '').slice(0, 10000),
            source: 'firecrawl',
          };
        }
      }
    } catch (e) {
      logger.log('research-firecrawl-fallback', { url, error: e.message });
    }
  }

  // Playwright fallback
  try {
    const browserTool = require('./browser_tool');
    const result = await browserTool.execute({ action: 'navigate', url });
    return {
      url: result.url,
      title: result.title,
      content: result.content,
      source: 'playwright',
    };
  } catch (e) {
    logger.log('research-error', { action: 'fetch', url, error: e.message });
    throw new Error(`Failed to fetch ${url}: ${e.message}`);
  }
}

/**
 * Fetch multiple URLs in parallel.
 */
async function fetchMultiple(urls) {
  const results = await Promise.allSettled(
    urls.slice(0, 10).map(u => fetchPage(u))
  );

  return {
    total: urls.length,
    fetched: results.filter(r => r.status === 'fulfilled').length,
    results: results.map((r, i) => ({
      url: urls[i],
      status: r.status,
      data: r.status === 'fulfilled' ? r.value : { error: r.reason?.message },
    })),
  };
}

module.exports = { execute, description, actions };
