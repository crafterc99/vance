/**
 * Logger — Structured logging for Vance execution layer
 *
 * Writes JSON-line logs to /logs directory.
 * Categories: tool, agent, error, system
 */

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.resolve(__dirname, '../logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

const LOG_FILE = path.join(LOGS_DIR, 'execution.jsonl');
const ERROR_FILE = path.join(LOGS_DIR, 'errors.jsonl');

// Keep log files under 5MB — rotate when exceeded
const MAX_LOG_SIZE = 5 * 1024 * 1024;

function rotateIfNeeded(filePath) {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_LOG_SIZE) {
      const rotated = filePath.replace('.jsonl', `-${Date.now()}.jsonl`);
      fs.renameSync(filePath, rotated);
    }
  } catch {}
}

/**
 * Write a structured log entry.
 * @param {string} event - Event type (tool-start, tool-complete, tool-error, agent-start, etc.)
 * @param {object} data - Event-specific data
 */
function log(event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...data,
  };

  const line = JSON.stringify(entry) + '\n';

  rotateIfNeeded(LOG_FILE);
  fs.appendFileSync(LOG_FILE, line);

  if (event.includes('error')) {
    rotateIfNeeded(ERROR_FILE);
    fs.appendFileSync(ERROR_FILE, line);
  }

  // Also print to stdout for launchd capture
  if (event.includes('error')) {
    console.error(`[${event}]`, data.error || data.message || '');
  }
}

/**
 * Read recent log entries.
 * @param {number} limit - Max entries to return
 * @param {string} filter - Optional event type filter
 */
function readLogs(limit = 50, filter = null) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
  let entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch {}
  }
  if (filter) {
    entries = entries.filter(e => e.event.includes(filter));
  }
  return entries.slice(-limit);
}

/**
 * Get execution stats.
 */
function getStats() {
  const logs = readLogs(1000);
  const toolRuns = logs.filter(l => l.event === 'tool-complete');
  const errors = logs.filter(l => l.event.includes('error'));
  const agents = logs.filter(l => l.event === 'agent-complete');

  return {
    totalToolRuns: toolRuns.length,
    totalErrors: errors.length,
    totalAgentRuns: agents.length,
    avgToolDuration: toolRuns.length
      ? Math.round(toolRuns.reduce((s, l) => s + (l.duration || 0), 0) / toolRuns.length)
      : 0,
  };
}

module.exports = { log, readLogs, getStats };
