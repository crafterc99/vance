/**
 * VANCE — Unified Chat Engine
 *
 * Single handleChat() for both text and voice.
 * Eliminates the ~70 lines of duplicated voice chat code from server.js.
 *
 * Uses:
 *   - router.js for mode classification
 *   - prompt.js for system prompt building
 *   - tools.js for tool execution
 *   - callClaudeStream() for API streaming
 */
const promptBuilder = require('./prompt');
const modeRouter = require('./router');
const { CLAUDE_TOOLS, executeFunction } = require('./tools');

// ─── Dependencies (injected at init) ────────────────────────────────────

let deps = {};
let callClaudeStream = null;

/**
 * Initialize the conversation engine with dependencies.
 * Called once at startup from server.js.
 */
function init(injected) {
  deps = injected;
  callClaudeStream = injected.callClaudeStream;
}

// ─── Context Builder ────────────────────────────────────────────────────

function buildChatContext(projectId) {
  const { loadProjects, loadMilestones, taskManager, taskIntelligence } = deps;
  const projects = loadProjects();
  const project = projects.find(p => p.id === projectId);
  const projectContext = project ? { ...project, milestones: loadMilestones(projectId) } : null;
  const runningTask = taskManager.getRunningTask();
  const queuedTasks = taskManager.getAllTasks({ status: 'queued' });
  const userTasks = taskIntelligence.getUserTasks();
  const priorities = taskIntelligence.getActivePriorities();
  return { projects, project, projectContext, runningTask, queuedTasks, userTasks, priorities };
}

// ─── System Prompt Builder ──────────────────────────────────────────────

function buildSystemPromptForChat(userMessage, ctx, opts = {}) {
  const { memory, costs, taskManager } = deps;
  const relevantMemories = memory.searchMemories(userMessage, 5);
  const preferences = memory.getPreferences();

  // Mode classification
  const classification = modeRouter.classifyMessage(userMessage, { hasActiveProject: !!ctx.project });
  const hint = modeRouter.modeHint(classification.mode, classification.reason);

  return promptBuilder.buildSystemPrompt({
    project: ctx.projectContext,
    memories: relevantMemories,
    preferences,
    runningTask: ctx.runningTask ? taskManager.taskSummary(ctx.runningTask) : null,
    queuedTaskCount: ctx.queuedTasks.length,
    userTasks: ctx.userTasks,
    priorities: ctx.priorities,
    modeHint: hint,
    isVoice: opts.isVoice || false,
  });
}

// ─── Main Chat Handler ──────────────────────────────────────────────────

/**
 * Handle a chat message — unified for text and voice.
 *
 * @param {string} userMessage - The user's message
 * @param {string} projectId - Active project ID
 * @param {Function} wsSend - WebSocket sender function
 * @param {Object} opts - { source: 'text'|'voice' }
 * @returns {string} The assistant's response text
 */
async function handleChat(userMessage, projectId, wsSend, opts = {}) {
  const { memory, costs, taskIntelligence, loadConversation, saveConversation } = deps;
  const isVoice = opts.source === 'voice';
  const costCategory = isVoice ? 'claude-voice' : 'claude-chat';

  const convId = isVoice ? (projectId || 'voice') : (projectId || 'general');
  const convMessages = loadConversation(convId);
  convMessages.push({ role: 'user', content: userMessage, timestamp: new Date().toISOString() });

  // Task intelligence: analyze every message
  try {
    const analysis = taskIntelligence.analyzeMessage(userMessage, projectId);
    if (analysis.hasAction) {
      for (const item of analysis.items) {
        if (item.type === 'user-task') {
          const created = taskIntelligence.addUserTask(item.title, {
            description: item.description, priority: item.priority,
            project: item.project, source: 'conversation',
          });
          wsSend({ type: 'task-intelligence', action: 'user-task-detected', task: created });
        } else if (item.type === 'vance-task') {
          wsSend({ type: 'task-intelligence', action: 'vance-task-detected', item });
        }
      }
    }
  } catch (e) {
    console.error('[TaskIntelligence] Analysis error:', e.message);
  }

  // Build context and system prompt
  const ctx = buildChatContext(projectId);
  const model = modeRouter.CHAT_MODEL;
  const systemPrompt = buildSystemPromptForChat(userMessage, ctx, { isVoice });

  wsSend({ type: 'thinking', tier: 'sonnet', label: 'SONNET' });
  wsSend({ type: 'model-tier', tier: 'sonnet', label: 'SONNET', reason: isVoice ? 'voice conversation' : 'single-tier Sonnet' });

  // Build API messages (last 20)
  const apiMessages = [];
  const recent = convMessages.slice(-20);
  for (const m of recent) {
    if (m.role === 'user') {
      apiMessages.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      apiMessages.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] });
    }
  }
  while (apiMessages.length && apiMessages[0].role !== 'user') apiMessages.shift();
  if (!apiMessages.length) apiMessages.push({ role: 'user', content: userMessage });

  try {
    let fullText = '';
    let rounds = 0;

    while (rounds < 8) {
      rounds++;
      let text = '';
      const toolUses = {};
      let hasToolUse = false;
      let stopReason = null;

      for await (const event of callClaudeStream(model, apiMessages, systemPrompt, CLAUDE_TOOLS)) {
        if (event.type === 'token') {
          text += event.content;
          wsSend({ type: 'stream-token', content: event.content });
        } else if (event.type === 'tool_use_start') {
          hasToolUse = true;
          toolUses[event.index] = { id: event.id, name: event.name, inputJson: '' };
          wsSend({ type: 'function-call', name: event.name });
        } else if (event.type === 'tool_input_delta') {
          if (toolUses[event.index]) toolUses[event.index].inputJson += event.delta;
        } else if (event.type === 'done') {
          stopReason = event.stopReason;
          const costModel = modeRouter.costModelName(model);
          costs.logCall(costCategory, costModel, {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
          });
        }
      }

      // No tool use — done
      if (!hasToolUse || stopReason === 'end_turn') {
        fullText = text;
        break;
      }

      // Build assistant message with content blocks
      const assistantContent = [];
      if (text) assistantContent.push({ type: 'text', text });
      for (const [, tu] of Object.entries(toolUses)) {
        let input = {};
        try { input = JSON.parse(tu.inputJson); } catch {}
        assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input });
      }
      apiMessages.push({ role: 'assistant', content: assistantContent });

      // Execute tools
      const toolResults = [];
      for (const [, tu] of Object.entries(toolUses)) {
        let input = {};
        try { input = JSON.parse(tu.inputJson); } catch {}
        wsSend({ type: 'status', text: `Running ${tu.name}...` });
        const result = await executeFunction(tu.name, input, wsSend, deps);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }

      if (toolResults.length) {
        apiMessages.push({ role: 'user', content: toolResults });
      }
      wsSend({ type: 'tool-done' });
    }

    wsSend({ type: 'stream-end', tier: 'sonnet', label: 'SONNET' });

    // Save to conversation
    convMessages.push({
      role: 'assistant', content: fullText,
      timestamp: new Date().toISOString(), tier: 'sonnet',
    });
    saveConversation(convId, convMessages);
    memory.learnPattern(userMessage, ctx.project ? 'project-work' : 'general');

    return fullText;

  } catch (err) {
    const errMsg = `I ran into an issue: ${err.message}`;
    wsSend({ type: 'error', message: errMsg });
    wsSend({ type: 'stream-end', tier: 'sonnet', label: 'SONNET' });
    convMessages.push({ role: 'assistant', content: errMsg, timestamp: new Date().toISOString() });
    saveConversation(convId, convMessages);
    return errMsg;
  }
}

module.exports = {
  init,
  handleChat,
  buildChatContext,
  buildSystemPromptForChat,
};
