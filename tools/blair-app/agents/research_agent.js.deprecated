/**
 * Research Agent — Search → Extract → Analyze → Store
 *
 * Multi-step research workflow that searches the web, extracts content
 * from relevant pages, and stores findings in vector memory.
 */

const toolRouter = require('../tools/tool_router');
const logger = require('../runtime/logger');

const description = 'Web research agent: search → extract → store findings';

/**
 * Run a research workflow.
 *
 * @param {object} input - { query, depth, maxPages, projectId, storeResults }
 * @param {object} context - { wsSend }
 * @returns {object} { success, findings, sources, stored }
 */
async function run(input, context = {}) {
  const { query, depth = 'standard', maxPages = 3, projectId, storeResults = true } = input;
  const { wsSend } = context;

  if (!query) throw new Error('Missing required field: query');

  const startTime = Date.now();
  const emit = (step, status, detail) => {
    if (wsSend) wsSend({ type: 'agent-step', agent: 'research', step, status, detail });
    logger.log('agent-step', { agent: 'research', step, status });
  };

  try {
    // Step 1: Check existing memory for prior research
    emit('memory-check', 'running', 'Checking existing knowledge...');
    let priorKnowledge = [];
    try {
      const memResult = await toolRouter.execute_tool('memory', {
        action: 'search', query, limit: 3, type: 'research',
      }, context);
      if (memResult.success && memResult.result) {
        priorKnowledge = memResult.result.vector || [];
      }
    } catch {}
    emit('memory-check', 'complete', `${priorKnowledge.length} prior entries found`);

    // Step 2: Search the web
    emit('search', 'running', `Searching: "${query}"...`);
    const searchResult = await toolRouter.execute_tool('research', {
      action: 'search', query, maxResults: depth === 'deep' ? 10 : 5,
    }, context);

    const searchResults = searchResult.success ? (searchResult.result?.results || []) : [];
    emit('search', 'complete', `${searchResults.length} results found`);

    if (!searchResults.length) {
      return {
        success: true,
        findings: priorKnowledge.length
          ? `No new web results, but found ${priorKnowledge.length} prior entries in memory.`
          : 'No results found.',
        sources: [],
        stored: false,
        duration: Date.now() - startTime,
      };
    }

    // Step 3: Fetch top pages
    emit('extract', 'running', `Extracting from top ${Math.min(maxPages, searchResults.length)} pages...`);
    const urlsToFetch = searchResults
      .filter(r => r.url)
      .slice(0, maxPages)
      .map(r => r.url);

    let pages = [];
    if (urlsToFetch.length) {
      const fetchResult = await toolRouter.execute_tool('research', {
        action: 'multi', urls: urlsToFetch,
      }, context);
      if (fetchResult.success) {
        pages = (fetchResult.result?.results || [])
          .filter(r => r.status === 'fulfilled' && r.data?.content)
          .map(r => r.data);
      }
    }
    emit('extract', 'complete', `Extracted ${pages.length} pages`);

    // Step 4: Compile findings
    const findings = pages.map(p => ({
      title: p.title,
      url: p.url,
      summary: p.content?.slice(0, 1500),
      source: p.source,
    }));

    // Step 5: Store in memory if requested
    let storedCount = 0;
    if (storeResults && findings.length) {
      emit('store', 'running', 'Storing findings in memory...');
      for (const finding of findings) {
        try {
          await toolRouter.execute_tool('memory', {
            action: 'store',
            content: `Research: ${query}\nSource: ${finding.title} (${finding.url})\n\n${finding.summary}`,
            type: 'research',
            projectId,
            tags: ['research', query.split(' ')[0]],
          }, context);
          storedCount++;
        } catch {}
      }
      emit('store', 'complete', `Stored ${storedCount} findings`);
    }

    const duration = Date.now() - startTime;
    logger.log('agent-complete', { agent: 'research', duration, findings: findings.length });

    return {
      success: true,
      query,
      findings,
      sources: findings.map(f => ({ title: f.title, url: f.url })),
      stored: storedCount,
      priorKnowledge: priorKnowledge.length,
      duration,
    };

  } catch (e) {
    logger.log('agent-error', { agent: 'research', error: e.message });
    return {
      success: false,
      query,
      findings: [],
      sources: [],
      stored: 0,
      error: e.message,
      duration: Date.now() - startTime,
    };
  }
}

module.exports = { run, description };
