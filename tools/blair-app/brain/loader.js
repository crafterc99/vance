/**
 * BLAIR — Brain Loader
 *
 * Reads brain configuration files and builds the dynamic system prompt.
 * Brain files are markdown files that define Blair's personality, user profile,
 * operational guidelines, and self-improvement protocols.
 *
 * The system prompt is constructed fresh for every conversation turn,
 * pulling in live state from memory, skills, projects, and preferences.
 */
const fs = require('fs');
const path = require('path');

const BRAIN_DIR = path.resolve(__dirname);
const MEMORY_DIR = path.resolve(__dirname, '..', 'memory');
const projectState = require('../runtime/project-state');
const BRAIN_FILES = {
  personality: path.join(BRAIN_DIR, 'PERSONALITY.md'),
  userProfile: path.join(BRAIN_DIR, 'USER_PROFILE.md'),
  guidelines: path.join(BRAIN_DIR, 'GUIDELINES.md'),
  selfImprovement: path.join(BRAIN_DIR, 'SELF_IMPROVEMENT.md'),
  operatingModes: path.join(BRAIN_DIR, 'operating_modes.md'),
  memoryRules: path.join(BRAIN_DIR, 'memory_rules.md'),
  toolRules: path.join(BRAIN_DIR, 'tool_rules.md'),
  projectIntelligence: path.join(BRAIN_DIR, 'project_intelligence.md'),
};

// ─── Smart Memory Loading ────────────────────────────────────────

let cachedMemoryMd = '';
let cachedProjectsMd = '';
let memoryLoadedAt = 0;
const MEMORY_CACHE_TTL = 60000; // Reload every 60s

function loadSmartMemory() {
  const now = Date.now();
  if (now - memoryLoadedAt < MEMORY_CACHE_TTL && cachedMemoryMd) return;

  try {
    const memFile = path.join(MEMORY_DIR, 'MEMORY.md');
    const projFile = path.join(MEMORY_DIR, 'projects.md');
    cachedMemoryMd = fs.existsSync(memFile) ? fs.readFileSync(memFile, 'utf8') : '';
    cachedProjectsMd = fs.existsSync(projFile) ? fs.readFileSync(projFile, 'utf8') : '';
    memoryLoadedAt = now;
  } catch (e) {
    console.error('Smart memory load error:', e.message);
  }
}

function getSmartMemory() {
  loadSmartMemory();
  return { memoryMd: cachedMemoryMd, projectsMd: cachedProjectsMd };
}

function loadDailyNote(date) {
  const dateStr = date || new Date().toISOString().split('T')[0];
  const dailyFile = path.join(MEMORY_DIR, 'daily', `${dateStr}.md`);
  return fs.existsSync(dailyFile) ? fs.readFileSync(dailyFile, 'utf8') : null;
}

function invalidateMemoryCache() {
  memoryLoadedAt = 0;
}

// Pending brain updates (proposed but not yet approved)
const pendingUpdates = [];

function readBrainFile(key) {
  const filePath = BRAIN_FILES[key];
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function readAllBrainFiles() {
  const brain = {};
  for (const [key, filePath] of Object.entries(BRAIN_FILES)) {
    brain[key] = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  }
  return brain;
}

/**
 * Build the full system prompt for GPT.
 *
 * @param {Object} context - Live context to inject
 * @param {Object} context.project - Active project (name, directory, description, milestones)
 * @param {Array} context.memories - Relevant memories from search
 * @param {Array} context.skills - Relevant skills for current query
 * @param {Object} context.preferences - User preferences from learning system
 * @param {Object} context.stats - Memory/skill/project counts
 * @param {Object} context.costs - Today's cost summary
 */
function buildSystemPrompt(context = {}) {
  const tier = context.modelTier || 'haiku';

  // Haiku gets a lightweight prompt — fast, token-efficient
  if (tier === 'haiku') {
    return buildHaikuPrompt(context);
  }

  // Sonnet gets the full brain files for deep reasoning
  return buildSonnetPrompt(context);
}

function buildHaikuPrompt(context = {}) {
  let prompt = `You are Blair, a personal AI assistant — like JARVIS from Iron Man. Calm, confident, competent, proactive. Address the user as "sir" naturally.

You are running as the HAIKU tier (fast, default). You handle ALL conversation, tool execution, status queries, memory operations, and lightweight reasoning.

## KEY RULES
- Be concise. Lead with the answer or action, not reasoning.
- Never use emojis. Never start with "Sure!" or "Of course!". Never pad responses.
- Match the user's speed and energy. Short messages = short replies.
- Use tools directly — don't explain what you're about to do, just do it.
- NEVER ask "Want me to search?" or "Should I look that up?" — if you don't know something, automatically search using run_tool with the research tool or run_agent with the research agent. Act first, don't ask permission for information retrieval.
- For coding tasks, delegate to 'start_coding_task' or 'run_claude_code' — don't try to reason through complex code yourself.

## ESCALATION
You have an 'escalate_to_sonnet' tool. Call it ONLY when the request genuinely requires:
- Deep multi-step planning or architecture decisions
- Complex debugging or root-cause analysis
- Interpreting design specs, writing detailed proposals
- Research synthesis across many factors
- Sustained complex reasoning you cannot handle well

Do NOT escalate for: status checks, simple questions, tool execution, memory lookups, project management, conversational replies, or any straightforward command.

## TOOLS
- System: run_shell, read_file, write_file, list_directory, search_files, system_info, open_app, run_applescript
- Memory: remember, recall, create_skill, learn_preference, propose_brain_update
- Projects: create_project, add_milestone, get_cost_report
- Tasks: start_coding_task, get_task_status, list_tasks, control_task, merge_task
- Task Intelligence: add_user_task, complete_user_task, add_priority, get_task_dashboard
- Coding: run_claude_code (persistent sessions — like VS Code), start_coding_task (queued background tasks)
- Sessions: claude_code_session (list, cancel, reset sessions)
- Execution: run_tool (direct tool execution), run_agent (multi-step agent workflows)
- Budget: set_claude_budget

## CLAUDE CODE SESSIONS — HOW TO CODE
run_claude_code maintains PERSISTENT SESSIONS per project — exactly like prompting Claude Code in VS Code.
- First call creates a session. Follow-up calls RESUME with full context.
- Say "add dark mode" then later "now add tests for that" — it remembers.
- ALWAYS pass project_id and project_directory so sessions persist correctly.
- For quick inline work: use run_claude_code directly (immediate, streaming).
- For background work while user chats: use start_coding_task (queued, git-isolated).
- When the user says things like "build X", "fix Y", "add Z" — call run_claude_code IMMEDIATELY.
  Don't explain what you're going to do. Don't plan. Just execute.
- Craft detailed prompts like the user would in VS Code. Include context, be specific.

## PROACTIVE TASK INTELLIGENCE
Every user message is analyzed for actionable content. When you detect intent:
- Direct coding requests → call run_claude_code immediately with full context
- Large/background coding work → queue via start_coding_task
- User personal tasks ("I need to...", "remind me...") → add via add_user_task
- High-level goals/priorities → track via add_priority
- Reference the task dashboard when relevant: "That's queued behind the auth task, sir."

## CODE CHANGE RULES
- ALL code changes MUST go through Claude Code tools (run_claude_code or start_coding_task).
- NEVER output raw code as the implementation — always execute through tools.
- After every code change: update project state, check dev server, return preview link.
- Prefer run_claude_code for direct work. Use start_coding_task only for long background tasks.

## RESPONSE FORMAT FOR CODE CHANGES
After completing any code change, respond with:
CHANGE COMPLETE
Files Updated: [list files]
Model Used: [tier used]
Preview Link: [dev server URL if applicable]
Commit Summary: [short description]`;

  // Add smart memory (MEMORY.md + projects.md — always loaded)
  const smartMem = getSmartMemory();
  if (smartMem.memoryMd) {
    prompt += `\n\n## LONG-TERM MEMORY\n${smartMem.memoryMd.slice(0, 2000)}`;
  }
  if (smartMem.projectsMd) {
    prompt += `\n\n## PROJECT REGISTRY\n${smartMem.projectsMd.slice(0, 1500)}`;
  }

  // Add project state context
  prompt += buildProjectStateContext(context);

  // Add live context (same for both tiers)
  prompt += buildLiveContext(context);
  return prompt;
}

function buildSonnetPrompt(context = {}) {
  const brain = readAllBrainFiles();

  // Extract key sections from personality
  const personalityCore = extractSection(brain.personality, 'Identity', 'Voice & Tone') ||
    'You are Blair, a personal AI assistant modeled after JARVIS from Iron Man. Calm, confident, competent, proactive. Address the user as "sir" naturally.';

  const toneRules = extractSection(brain.personality, 'What You Never Do') ||
    'Never use emojis. Never start with "Sure!" or "Of course!". Never pad responses. Never say "I\'m just an AI".';

  const proactiveRules = extractSection(brain.personality, 'Proactive Behavior') || '';

  let prompt = `You are Blair, a personal AI assistant — like JARVIS from Iron Man.

You are running as the SONNET tier (deep reasoning). You were escalated from Haiku because this request requires sustained complex reasoning.

## PERSONALITY
${personalityCore}

## TONE RULES
${toneRules}

## RESPONSE FORMAT
- Be concise. Lead with the answer or action.
- Use data over prose. Numbers, percentages, lists.
- Status updates: 1-3 sentences max.
- Only elaborate for architecture plans or when user is exploring ideas.
- Never say: "I understand", "That's a great idea", "Let me think about that", "Would you like me to..."
- NEVER ask "Want me to search?" or "Should I look that up?" — if you don't know something, automatically search using run_tool with the research tool or run_agent with the research agent. Act first, don't ask permission.

## COMMUNICATION STYLE
- Match the user's speed and energy
- When they say "continue" — full speed, maximum autonomy
- When they redirect — pivot immediately, no defense of previous approach
- When they say "give me the link" — they want working output, not explanations

## PROACTIVE BEHAVIOR
${proactiveRules}
- Commit and push code after significant changes
- Suggest next steps after completing a task
- Flag potential issues before they become problems
- Report costs when notable
- Remember preferences and apply them without being asked

## TOOLS
- System: run_shell, read_file, write_file, list_directory, search_files, system_info, open_app, run_applescript
- Memory: remember, recall, create_skill, learn_preference, propose_brain_update
- Projects: create_project, add_milestone, get_cost_report
- Tasks: start_coding_task, get_task_status, list_tasks, control_task, merge_task
- Task Intelligence: add_user_task, complete_user_task, add_priority, get_task_dashboard
- Coding: run_claude_code (persistent sessions — like VS Code), start_coding_task (queued background tasks)
- Sessions: claude_code_session (list, cancel, reset sessions)
- Execution: run_tool (direct tool execution), run_agent (multi-step agent workflows)
- Budget: set_claude_budget

## CLAUDE CODE SESSIONS — HOW TO CODE
run_claude_code maintains PERSISTENT SESSIONS per project — exactly like prompting Claude Code in VS Code.
- First call creates a session. Follow-up calls RESUME with full context.
- Say "add dark mode" then later "now add tests for that" — it remembers.
- ALWAYS pass project_id and project_directory so sessions persist correctly.
- When the user says "build X", "fix Y", "add Z" — call run_claude_code IMMEDIATELY.
- Craft detailed prompts like the user would type in VS Code. Include context, be specific.
- For background work while user chats: use start_coding_task (queued, git-isolated).

## PROACTIVE TASK INTELLIGENCE
Every user message is analyzed for actionable content. When you detect intent:
- Direct coding requests → call run_claude_code immediately
- Large/background coding → queue via start_coding_task
- User personal tasks → add via add_user_task
- High-level goals/priorities → track via add_priority

## CODING RULES
- ALL code changes go through run_claude_code or start_coding_task — never output raw code
- For simple file edits, git commands, running tests — use the system tools directly

## RESPONSE FORMAT FOR CODE CHANGES
After completing any code change, respond with:
CHANGE COMPLETE
Files Updated: [list files]
Model Used: [tier used]
Preview Link: [dev server URL if applicable]
Commit Summary: [short description]`;

  // Add full brain context for Sonnet (all brain files)
  if (brain.userProfile) {
    prompt += `\n\n## USER PROFILE\n${brain.userProfile.substring(0, 1500)}`;
  }
  if (brain.guidelines) {
    prompt += `\n\n## GUIDELINES\n${brain.guidelines.substring(0, 1500)}`;
  }
  if (brain.selfImprovement) {
    prompt += `\n\n## SELF-IMPROVEMENT RULES\n${brain.selfImprovement.substring(0, 1000)}`;
  }
  if (brain.operatingModes) {
    prompt += `\n\n## OPERATING MODES\n${brain.operatingModes.substring(0, 800)}`;
  }
  if (brain.toolRules) {
    prompt += `\n\n## TOOL & AUTONOMY RULES\n${brain.toolRules.substring(0, 1000)}`;
  }
  if (brain.memoryRules) {
    prompt += `\n\n## MEMORY RULES\n${brain.memoryRules.substring(0, 800)}`;
  }
  if (brain.projectIntelligence) {
    prompt += `\n\n## PROJECT INTELLIGENCE\n${brain.projectIntelligence.substring(0, 1200)}`;
  }

  // Add smart memory (MEMORY.md + projects.md — always loaded)
  const smartMem = getSmartMemory();
  if (smartMem.memoryMd) {
    prompt += `\n\n## LONG-TERM MEMORY\n${smartMem.memoryMd}`;
  }
  if (smartMem.projectsMd) {
    prompt += `\n\n## PROJECT REGISTRY\n${smartMem.projectsMd}`;
  }

  // Add project state context
  prompt += buildProjectStateContext(context);

  // Add live context
  prompt += buildLiveContext(context);
  return prompt;
}

function buildProjectStateContext(context = {}) {
  let prompt = '';
  const { project } = context;
  if (!project) return prompt;

  const state = projectState.getProjectStatus(project.id);
  if (!state) return prompt;

  prompt += `\n\n## PROJECT STATE: "${state.project_name}"`;
  prompt += `\nDirectory: ${state.project_directory || 'not set'}`;
  if (state.dev_framework) prompt += `\nFramework: ${state.dev_framework}`;
  if (state.dev_server_command) prompt += `\nDev Command: ${state.dev_server_command}`;
  if (state.dev_port) prompt += `\nPort: ${state.dev_port}`;
  prompt += `\nDev Server: ${state.dev_server_running ? 'RUNNING' : 'STOPPED'}`;
  if (state.preview_available) prompt += `\nPreview: ${state.preview_available}`;
  else if (state.preview_url) prompt += `\nPreview URL (server not running): ${state.preview_url}`;
  if (state.last_updated_files?.length) {
    prompt += `\nLast Changed: ${state.last_updated_files.join(', ')}`;
  }
  if (state.last_edit_summary) prompt += `\nLast Edit: ${state.last_edit_summary}`;
  if (state.last_commit_time) prompt += `\nLast Commit: ${state.last_commit_time}`;

  return prompt;
}

function buildLiveContext(context = {}) {
  let prompt = '';
  const { project, memories, skills, preferences, stats, costs, runningTask, queuedTaskCount, userTasks, priorities } = context;

  if (stats) {
    prompt += `\n\n## CURRENT STATE
- Memories: ${stats.memoryCount || 0} stored
- Skills: ${stats.skillCount || 0} learned
- Projects: ${stats.projectCount || 0} active`;
    if (costs) {
      prompt += `\n- Today's spend: $${costs.todaySpend || '0.00'} (${costs.todayCalls || 0} calls)`;
    }
  }

  if (project) {
    prompt += `\n\n## ACTIVE PROJECT: "${project.name}"
Directory: ${project.directory || 'not set'}`;
    if (project.description) prompt += `\nDescription: ${project.description}`;
    if (project.milestones?.length) {
      const recent = project.milestones.slice(-5);
      prompt += `\nRecent milestones:\n${recent.map(m => `- [${m.status || 'completed'}] ${m.title}`).join('\n')}`;
    }
  }

  if (memories?.length) {
    prompt += `\n\n## RELEVANT MEMORIES`;
    for (const m of memories.slice(0, 5)) {
      prompt += `\n- [${m.category}] ${m.content}`;
    }
  }

  if (skills?.length) {
    prompt += `\n\n## RELEVANT SKILLS`;
    for (const s of skills.slice(0, 3)) {
      prompt += `\n- **${s.name}**: ${s.description}`;
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
    const elapsedStr = elapsed > 3600
      ? `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`
      : elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;

    prompt += `\n\n## RUNNING TASK
"${runningTask.title}" (${runningTask.tier}/${runningTask.model}, ${runningTask.status})
Branch: ${runningTask.branch || 'none'} | Cost: $${(runningTask.costUsd || 0).toFixed(2)}/$${runningTask.maxBudget}
Running: ${elapsedStr}
Milestones: ${runningTask.milestones?.slice(-3).map(m => m.detail).join(', ') || 'none yet'}`;
  }
  if (queuedTaskCount > 0) {
    prompt += `\n${queuedTaskCount} task${queuedTaskCount > 1 ? 's' : ''} queued behind current task.`;
  }

  if (priorities?.length) {
    prompt += `\n\n## ACTIVE PRIORITIES`;
    for (const p of priorities.slice(0, 5)) {
      prompt += `\n- [${p.id}] ${p.title} (score: ${p.score})${p.project ? ` — ${p.project}` : ''}`;
    }
  }

  if (userTasks?.length) {
    prompt += `\n\n## USER'S TASK BOARD (${userTasks.length} pending)`;
    for (const t of userTasks.slice(0, 8)) {
      prompt += `\n- [${t.id}] ${t.title} — ${t.priority?.level || 'medium'}${t.dueAt ? ` (due: ${t.dueAt})` : ''}`;
    }
  }

  if (pendingUpdates.length) {
    prompt += `\n\n## PENDING BRAIN UPDATES (awaiting approval)`;
    for (const u of pendingUpdates) {
      prompt += `\n- [${u.file}] ${u.summary}`;
    }
  }

  return prompt;
}

/**
 * Extract a section from a markdown file between two headers.
 */
function extractSection(markdown, startHeader, endHeader) {
  if (!markdown) return '';
  const lines = markdown.split('\n');
  let capturing = false;
  let result = [];

  for (const line of lines) {
    if (line.match(new RegExp(`^#{1,3}\\s+.*${escapeRegex(startHeader)}`, 'i'))) {
      capturing = true;
      continue;
    }
    if (endHeader && capturing && line.match(new RegExp(`^#{1,3}\\s+.*${escapeRegex(endHeader)}`, 'i'))) {
      break;
    }
    if (!endHeader && capturing && line.match(/^#{1,2}\s+/) && result.length > 0) {
      break;
    }
    if (capturing) {
      result.push(line);
    }
  }

  return result.join('\n').trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Propose a brain file update. Stored in pending until user approves.
 */
function proposeBrainUpdate(file, section, oldText, newText, reason) {
  const update = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    file,
    section,
    oldText: oldText || null,
    newText,
    reason,
    proposedAt: new Date().toISOString(),
    status: 'pending',
    summary: `${section}: ${reason}`,
  };
  pendingUpdates.push(update);
  return update;
}

/**
 * Approve a pending brain update and apply it.
 */
function approveBrainUpdate(updateId) {
  const idx = pendingUpdates.findIndex(u => u.id === updateId);
  if (idx === -1) return { error: 'Update not found' };

  const update = pendingUpdates[idx];
  const fileKey = Object.keys(BRAIN_FILES).find(k =>
    k.toLowerCase() === update.file.toLowerCase().replace('.md', '').replace('_', '')
      || BRAIN_FILES[k].toLowerCase().includes(update.file.toLowerCase())
  );

  if (!fileKey) return { error: `Unknown brain file: ${update.file}` };

  const filePath = BRAIN_FILES[fileKey];
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

  if (update.oldText && content.includes(update.oldText)) {
    content = content.replace(update.oldText, update.newText);
  } else {
    // Append to file
    content += '\n\n' + update.newText;
  }

  fs.writeFileSync(filePath, content);
  update.status = 'approved';
  pendingUpdates.splice(idx, 1);
  return { success: true, file: fileKey, update };
}

/**
 * Reject a pending brain update.
 */
function rejectBrainUpdate(updateId) {
  const idx = pendingUpdates.findIndex(u => u.id === updateId);
  if (idx === -1) return { error: 'Update not found' };
  const update = pendingUpdates[idx];
  update.status = 'rejected';
  pendingUpdates.splice(idx, 1);
  return { success: true, update };
}

/**
 * Get all pending updates.
 */
function getPendingUpdates() {
  return [...pendingUpdates];
}

/**
 * Get brain file contents for display/editing.
 */
function getBrainFiles() {
  const files = {};
  for (const [key, filePath] of Object.entries(BRAIN_FILES)) {
    files[key] = {
      path: filePath,
      exists: fs.existsSync(filePath),
      size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
      lastModified: fs.existsSync(filePath) ? fs.statSync(filePath).mtime.toISOString() : null,
    };
  }
  return files;
}

module.exports = {
  buildSystemPrompt,
  readBrainFile,
  readAllBrainFiles,
  proposeBrainUpdate,
  approveBrainUpdate,
  rejectBrainUpdate,
  getPendingUpdates,
  getBrainFiles,
  getSmartMemory,
  loadDailyNote,
  invalidateMemoryCache,
  buildProjectStateContext,
  buildLiveContext,
  BRAIN_FILES,
  MEMORY_DIR,
};
