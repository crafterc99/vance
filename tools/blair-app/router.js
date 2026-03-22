/**
 * BLAIR — Mode Router
 *
 * Simple keyword-based classifier that advises which execution mode
 * to use for each message. The brain still makes the final tool call.
 *
 * Replaces model-router.js (Haiku→Sonnet escalation) with a single
 * model (Sonnet) that gets mode hints in the prompt.
 *
 * 4 Execution Modes:
 *   conversation — Sonnet handles all chat
 *   tool — Direct tool execution (shell, file, memory, project ops)
 *   claude_code — Interactive coding via persistent sessions
 *   background_task — Queued autonomous tasks
 */

// ─── Mode Patterns ──────────────────────────────────────────────────────

const CLAUDE_CODE_PATTERNS = [
  /\b(build|implement|create|develop|code|write)\b.*\b(app|feature|component|page|module|system|api|endpoint|service|function|class)\b/i,
  /\b(fix|debug|repair|resolve)\b.*\b(bug|error|issue|crash|problem|failing)\b/i,
  /\b(add|implement)\b.*\b(to|for|in)\b/i,
  /\b(refactor|rewrite|redesign|optimize|upgrade|migrate)\b/i,
  /\b(set up|setup|scaffold|bootstrap|initialize|init)\b.*\b(project|app|repo|codebase)\b/i,
];

const BACKGROUND_PATTERNS = [
  /\b(in the background|while i|queue|background)\b/i,
  /\bstart\b.*\btask\b/i,
  /\bqueue\b.*\b(up|this|a|the)\b/i,
  /\bwork on\b.*\b(while)\b/i,
];

const TOOL_PATTERNS = [
  /\b(run|execute|check|open|search|find|list|show|get|what'?s)\b.*\b(shell|command|terminal|app|file|directory|disk|cpu|memory|battery|status|info)\b/i,
  /\b(open|launch|start)\b.*\b(safari|chrome|finder|terminal|vscode|code)\b/i,
  /\brun\b\s+["`']/i, // "run `ls`" etc.
  /\b(system|disk|battery|cpu|memory)\s+(info|status|usage|space)\b/i,
  /\b(search|grep|find)\b.*\b(files?|code|directory)\b/i,
];

// ─── Classifier ─────────────────────────────────────────────────────────

/**
 * Classify a user message into an execution mode.
 *
 * @param {string} message - User message
 * @param {Object} context - { hasActiveProject, projectId }
 * @returns {{ mode: string, reason: string }}
 */
function classifyMessage(message, context = {}) {
  if (!message || message.length < 3) {
    return { mode: 'conversation', reason: 'too short to classify' };
  }

  // Background task — check first (most specific)
  for (const p of BACKGROUND_PATTERNS) {
    if (p.test(message)) {
      return { mode: 'background_task', reason: 'background/queue language detected' };
    }
  }

  // Claude Code — coding intent
  for (const p of CLAUDE_CODE_PATTERNS) {
    if (p.test(message)) {
      return { mode: 'claude_code', reason: 'coding intent detected' };
    }
  }

  // Tool — explicit tool requests
  for (const p of TOOL_PATTERNS) {
    if (p.test(message)) {
      return { mode: 'tool', reason: 'direct tool request detected' };
    }
  }

  // Default — conversation
  return { mode: 'conversation', reason: 'general conversation' };
}

/**
 * Convert mode to a prompt hint string.
 */
function modeHint(mode, reason) {
  switch (mode) {
    case 'claude_code':
      return `This looks like a coding request (${reason}). Use run_claude_code or start_coding_task.`;
    case 'background_task':
      return `User wants this done in the background (${reason}). Use start_coding_task to queue it.`;
    case 'tool':
      return `This is a direct tool request (${reason}). Use the appropriate system tool.`;
    default:
      return null; // No hint needed for conversation
  }
}

// ─── Anthropic Tool Conversion ──────────────────────────────────────────

/**
 * Convert OpenAI-format tools to Anthropic Messages API format.
 */
function convertToolsToAnthropic(openaiTools) {
  return openaiTools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
}

/**
 * Strip date suffix from model ID for cost lookup.
 */
function costModelName(model) {
  return model.replace(/-\d{8}$/, '');
}

// Single model for all chat
const CHAT_MODEL = 'claude-sonnet-4-6';
const CHAT_MAX_TOKENS = 8192;

module.exports = {
  classifyMessage,
  modeHint,
  convertToolsToAnthropic,
  costModelName,
  CHAT_MODEL,
  CHAT_MAX_TOKENS,
};
