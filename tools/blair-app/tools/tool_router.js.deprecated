/**
 * Tool Router — Central dispatcher for Vance execution tools
 *
 * Routes tool requests to the appropriate tool module.
 * All actions in Vance flow through this router.
 */

const fs = require('fs');
const path = require('path');

const TOOLS = {
  claude_code: require('./claude_code_tool'),
  browser: require('./browser_tool'),
  research: require('./research_tool'),
  memory: require('./memory_tool'),
  project: require('./project_tool'),
};

const logger = require('../runtime/logger');

/**
 * Execute a tool by name with a payload.
 *
 * @param {string} toolName - Tool identifier (claude_code, browser, research, memory, project)
 * @param {object} payload - Tool-specific input
 * @param {object} context - { wsSend, projectId } for broadcasting events
 * @returns {object} { success, result, error }
 */
async function execute_tool(toolName, payload, context = {}) {
  const startTime = Date.now();

  if (!TOOLS[toolName]) {
    const error = `Unknown tool: ${toolName}`;
    logger.log('tool-error', { tool: toolName, error });
    return { success: false, error };
  }

  logger.log('tool-start', { tool: toolName, payload: summarizePayload(payload) });

  if (context.wsSend) {
    context.wsSend({ type: 'tool-execution', tool: toolName, status: 'running' });
  }

  try {
    const result = await TOOLS[toolName].execute(payload, context);
    const duration = Date.now() - startTime;

    logger.log('tool-complete', { tool: toolName, duration, success: true });

    if (context.wsSend) {
      context.wsSend({ type: 'tool-execution', tool: toolName, status: 'complete', duration });
    }

    return { success: true, result, duration };
  } catch (e) {
    const duration = Date.now() - startTime;
    logger.log('tool-error', { tool: toolName, duration, error: e.message });

    if (context.wsSend) {
      context.wsSend({ type: 'tool-execution', tool: toolName, status: 'error', error: e.message });
    }

    return { success: false, error: e.message, duration };
  }
}

/**
 * List available tools with descriptions.
 */
function listTools() {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description || name,
    actions: tool.actions || [],
  }));
}

function summarizePayload(payload) {
  const summary = { ...payload };
  // Truncate large fields for logging
  for (const key of Object.keys(summary)) {
    if (typeof summary[key] === 'string' && summary[key].length > 200) {
      summary[key] = summary[key].slice(0, 200) + '...';
    }
  }
  return summary;
}

module.exports = { execute_tool, listTools, TOOLS };
