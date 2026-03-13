/**
 * Research Tool — Web research pipeline
 *
 * Uses Playwright for web fetching + optional Firecrawl for clean extraction.
 * Falls back to Playwright-only if Firecrawl key is not set.
 *
 * Actions:
 *   search     — Search the web (DuckDuckGo) and return results
 *   fetch      — Fetch and extract content from a URL
 *   summarize  — Fetch a page and summarize with Claude
 *   multi      — Fetch multiple URLs and compile results
 */

const logger = require('../runtime/logger');

const description = 'Web research and content extraction';
const actions = ['search', 'fetch', 'summarize', 'multi'];

const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY || '';

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
      return fetchPage(url); // Summary done by the calling agent/model

    case 'multi':
      if (!urls || !urls.length) throw new Error('Missing required field: urls');
      return fetchMultiple(urls);

    default:
      throw new Error(`Unknown research action: ${action}`);
  }
}

/**
 * Search DuckDuckGo via HTML scraping (no API key needed)
 */
async function searchWeb(query, maxResults = 5) {
  if (!query) throw new Error('Missing required field: query');

  try {
    const browserTool = require('./browser_tool');
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const result = await browserTool.execute({
      action: 'extract',
      url: searchUrl,
      selector: '.result',
      waitFor: '.result',
    });

    const results = (result.extracted || []).slice(0, maxResults).map((item, i) => ({
      rank: i + 1,
      title: item.text?.split('\n')[0]?.trim() || 'No title',
      snippet: item.text?.split('\n').slice(1).join(' ').trim().slice(0, 300) || '',
      url: item.href || null,
    }));

    return { query, resultCount: results.length, results };
  } catch (e) {
    logger.log('research-error', { action: 'search', error: e.message });
    return { query, resultCount: 0, results: [], error: e.message };
  }
}

/**
 * Fetch and extract content from a URL.
 * Uses Firecrawl if available, falls back to Playwright.
 */
async function fetchPage(url) {
  // Try Firecrawl first (cleaner extraction)
  if (FIRECRAWL_KEY) {
    try {
      const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${FIRECRAWL_KEY}`,
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

  // Fallback to Playwright
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
