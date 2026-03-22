/**
 * VANCE — Lean Prompt Composition
 *
 * Single-tier system prompt builder targeting ~800 tokens base.
 * Replaces the dual buildHaikuPrompt/buildSonnetPrompt in brain/loader.js.
 *
 * Reuses from brain/loader.js:
 *   - getSmartMemory() (MEMORY.md + projects.md caching)
 *   - buildLiveContext() (running task, priorities, user tasks)
 *   - buildProjectStateContext() (project state injection)
 */
const brain = require('./brain/loader');

// ─── Identity Block (~100 tokens) ───────────────────────────────────────

const IDENTITY = `You are Vance, a personal AI assistant — like JARVIS from Iron Man. Calm, confident, competent, proactive. Address the user as "sir" naturally.

Be concise. Lead with the answer or action, not reasoning.
Never use emojis. Never start with "Sure!" or "Of course!". Never pad responses.
Match the user's speed and energy. Short messages = short replies.
Use tools directly — don't explain what you're about to do, just do it.
If you don't know something, automatically search or look it up. Act first, don't ask permission.`;

// ─── Tool Routing Rules (~200 tokens) ────────────────────────────────────

const TOOL_ROUTING = `## TOOL ROUTING
- Quick shell commands, git, file reads, system checks → use system tools directly
- Code implementation (build, fix, add, refactor, debug) → run_claude_code (persistent sessions per project)
- Large/background coding work → start_coding_task (queued, git-isolated)
- User personal tasks/reminders → manage_tasks
- Never output raw code as implementation — always execute through coding tools
- After code changes: mention files updated, model used, preview link if applicable`;

// ─── Coding Protocol (~150 tokens) ───────────────────────────────────────

const CODING_PROTOCOL = `## CODING
run_claude_code maintains PERSISTENT SESSIONS per project — like Claude Code in VS Code.
- First call creates a session. Follow-ups RESUME with full context.
- ALWAYS pass project_id and project_directory so sessions persist.
- When user says "build X", "fix Y", "add Z" → call run_claude_code IMMEDIATELY.
- Craft detailed prompts with context, be specific.
- For background work while user chats → start_coding_task.`;

// ─── Voice Mode Addition ─────────────────────────────────────────────────

const VOICE_ADDITION = `

## VOICE MODE
You're in a live voice conversation. The mic is always on.
- Talk, don't write. No markdown, no bullets, no code blocks, no asterisks.
- Be brief. 1-3 sentences ideal. Lead with the answer.
- Sound human. Use contractions. Vary sentence length.
- Don't say "Certainly!", "Absolutely!", "Great question!" — sounds robotic.
- Don't repeat back what they said. Don't give disclaimers unless safety-critical.
- Don't say "Is there anything else?" — the conversation is always on.
- If something takes time: "Looking that up now" or "Give me a sec."`;

// ─── Build System Prompt ─────────────────────────────────────────────────

/**
 * Build the system prompt for a chat turn.
 *
 * @param {Object} context - Live context
 * @param {Object} [context.project] - Active project
 * @param {Array}  [context.memories] - Relevant memories
 * @param {Array}  [context.skills] - Matching skills
 * @param {Object} [context.preferences] - User preferences
 * @param {Object} [context.stats] - Memory/skill/project counts
 * @param {Object} [context.costs] - Today's cost summary
 * @param {Object} [context.runningTask] - Currently running task
 * @param {number} [context.queuedTaskCount] - Queued tasks
 * @param {Array}  [context.userTasks] - User's task board
 * @param {Array}  [context.priorities] - Active priorities
 * @param {string} [context.modeHint] - Router mode hint
 * @param {boolean} [context.isVoice] - Voice mode flag
 * @returns {string} System prompt
 */
function buildSystemPrompt(context = {}) {
  let prompt = IDENTITY + '\n\n' + TOOL_ROUTING + '\n\n' + CODING_PROTOCOL;

  // Mode hint from router
  if (context.modeHint) {
    prompt += `\n\n## MODE HINT: ${context.modeHint}`;
  }

  // Voice mode addition
  if (context.isVoice) {
    prompt += VOICE_ADDITION;
  }

  // Smart memory (MEMORY.md + projects.md — cached in loader.js)
  const smartMem = brain.getSmartMemory();
  if (smartMem.memoryMd) {
    prompt += `\n\n## LONG-TERM MEMORY\n${smartMem.memoryMd.slice(0, 1500)}`;
  }
  if (smartMem.projectsMd) {
    prompt += `\n\n## PROJECT REGISTRY\n${smartMem.projectsMd.slice(0, 1000)}`;
  }

  // Project state context (from loader.js)
  prompt += brain.buildProjectStateContext ? brain.buildProjectStateContext(context) : '';

  // Live context (from loader.js — running task, priorities, user tasks)
  prompt += buildLiveContextLean(context);

  return prompt;
}

/**
 * Trimmed-down live context injection (~200-400 tokens dynamic).
 * Replaces the verbose buildLiveContext from loader.js.
 */
function buildLiveContextLean(context = {}) {
  let prompt = '';
  const { project, memories, preferences, runningTask, queuedTaskCount, userTasks, priorities } = context;

  if (project) {
    prompt += `\n\n## ACTIVE PROJECT: "${project.name}"`;
    prompt += `\nDirectory: ${project.directory || 'not set'}`;
    if (project.description) prompt += `\nDescription: ${project.description}`;
  }

  if (memories?.length) {
    prompt += `\n\n## RELEVANT MEMORIES`;
    for (const m of memories.slice(0, 5)) {
      prompt += `\n- [${m.category}] ${m.content}`;
    }
  }

  if (preferences && Object.keys(preferences).length) {
    prompt += `\n\n## USER PREFERENCES`;
    for (const [key, val] of Object.entries(preferences)) {
      const value = typeof val === 'object' ? val.value : val;
      prompt += `\n- ${key}: ${value}`;
    }
  }

  if (runningTask) {
    const elapsed = runningTask.startedAt
      ? Math.round((Date.now() - new Date(runningTask.startedAt).getTime()) / 1000)
      : 0;
    const elapsedStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
    prompt += `\n\n## RUNNING TASK: "${runningTask.title}" (${runningTask.tier}, $${(runningTask.costUsd || 0).toFixed(2)}, ${elapsedStr})`;
    if (runningTask.lastMilestone) prompt += `\nLast milestone: ${runningTask.lastMilestone}`;
  }
  if (queuedTaskCount > 0) {
    prompt += `\n${queuedTaskCount} task${queuedTaskCount > 1 ? 's' : ''} queued.`;
  }

  if (priorities?.length) {
    prompt += `\n\n## PRIORITIES`;
    for (const p of priorities.slice(0, 5)) {
      prompt += `\n- ${p.title}${p.project ? ` (${p.project})` : ''}`;
    }
  }

  if (userTasks?.length) {
    prompt += `\n\n## USER TASKS (${userTasks.length})`;
    for (const t of userTasks.slice(0, 5)) {
      prompt += `\n- ${t.title}${t.dueAt ? ` (due: ${t.dueAt})` : ''}`;
    }
  }

  return prompt;
}

module.exports = {
  buildSystemPrompt,
  VOICE_ADDITION,
};
