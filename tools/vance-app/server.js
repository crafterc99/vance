#!/usr/bin/env node
/**
 * VANCE — Personal AI Operating System
 *
 * Tiered Claude-powered brain:
 *   Tier 1 (Haiku)  — all conversation, tool use, commands, memory
 *   Tier 2 (Sonnet) — deep reasoning, planning, debugging (escalated by Haiku)
 *   Tier 3 (Claude Code) — autonomous project implementation
 *
 * Features:
 * - Long-term memory (learn, recall, adapt)
 * - Skill creation and management
 * - Project management with milestones
 * - Autonomous coding tasks with git isolation
 * - Cost tracking across all API components
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync, exec } = require('child_process');
const crypto = require('crypto');
const WebSocket = require('ws');

// Load .env file (no external dependency)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  }
}

const memory = require('./memory');
const costs = require('./costs');
const brain = require('./brain/loader');
const taskManager = require('./task-manager');
const modelRouter = require('./model-router');
const vectorMemory = require('./vector-memory');
const toolRouter = require('./tools/tool_router');
const executionLogger = require('./runtime/logger');
const projectState = require('./runtime/project-state');
const VoiceSystem = require('./voice');
const ConversationHandler = require('./voice/conversationHandler');

// Agent modules (lazy-loaded for modularity)
const AGENTS = {
  coding: require('./agents/coding_agent'),
  research: require('./agents/research_agent'),
  browser: require('./agents/browser_agent'),
};

const PORT = process.env.VANCE_PORT || 4000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const DATA_DIR = path.resolve(__dirname, '../../.vance-data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');
const MILESTONES_DIR = path.join(DATA_DIR, 'milestones');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
fs.mkdirSync(MILESTONES_DIR, { recursive: true });

// ─── Data Helpers ────────────────────────────────────────────────────────

function loadProjects() {
  if (!fs.existsSync(PROJECTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
}
function saveProjects(p) { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(p, null, 2)); }

function loadConversation(id) {
  const f = path.join(CONVERSATIONS_DIR, `${id}.json`);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function saveConversation(id, msgs) {
  fs.writeFileSync(path.join(CONVERSATIONS_DIR, `${id}.json`), JSON.stringify(msgs, null, 2));
}

function loadMilestones(pid) {
  const f = path.join(MILESTONES_DIR, `${pid}.json`);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function addMilestone(pid, m) {
  const ms = loadMilestones(pid);
  ms.push({ ...m, id: crypto.randomUUID(), timestamp: new Date().toISOString() });
  fs.writeFileSync(path.join(MILESTONES_DIR, `${pid}.json`), JSON.stringify(ms, null, 2));
  return ms;
}

// ─── Tool Definitions (OpenAI format, converted to Anthropic at runtime) ─

const TOOLS = [
  // ─── System Tools (direct, fast, free) ────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Execute a shell command on the user\'s Mac. Returns stdout, stderr, and exit code. Use for: git operations, npm/node commands, system checks, file manipulation, process management, any terminal task. PREFER this over run_claude_code for quick/simple tasks.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          cwd: { type: 'string', description: 'Working directory (default: home)' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: 30, max: 300)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Use for checking code, configs, logs, any text file. Returns content with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path' },
          start_line: { type: 'number', description: 'Start line (1-indexed, default: 1)' },
          end_line: { type: 'number', description: 'End line (default: all)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories if needed. Use for creating/updating files, configs, scripts.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path' },
          content: { type: 'string', description: 'File content to write' },
          append: { type: 'boolean', description: 'Append instead of overwrite (default: false)' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories at a path. Shows names, sizes, types, and modification times.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: home)' },
          recursive: { type: 'boolean', description: 'List recursively (default: false, max 500 entries)' },
          pattern: { type: 'string', description: 'Glob pattern to filter (e.g. "*.js", "*.ts")' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for files by name or search file contents by text/regex. Like grep + find combined.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex to search for in file contents' },
          path: { type: 'string', description: 'Directory to search in (default: home)' },
          file_pattern: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.js")' },
          name_only: { type: 'boolean', description: 'Search file names instead of contents' },
          max_results: { type: 'number', description: 'Max results (default: 20)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: 'Get Mac system information: CPU usage, memory, disk space, battery, uptime, running apps, network. Use to check system health or status.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['all', 'cpu', 'memory', 'disk', 'battery', 'network', 'processes'], description: 'What info to get (default: all)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'Open an app, URL, or file on macOS. Use for opening browsers, editors, Finder, or any application.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'App name (e.g. "Safari"), URL (e.g. "https://github.com"), or file path' },
          args: { type: 'array', items: { type: 'string' }, description: 'Additional arguments' },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_applescript',
      description: 'Execute AppleScript on macOS. Use for: system notifications, window management, clipboard read/write, Finder automation, app control, volume/brightness, dialog boxes.',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'AppleScript code to execute' },
        },
        required: ['script'],
      },
    },
  },
  // ─── Claude Code (for complex multi-step coding) ──────────────────────
  {
    type: 'function',
    function: {
      name: 'run_claude_code',
      description: 'Execute a COMPLEX multi-step coding task using Claude Code AI. This spawns a full Claude session — use ONLY when the task requires AI reasoning across multiple files (e.g. "refactor the auth system", "add dark mode to the app", "debug why tests fail"). For simple tasks like reading files, running commands, or git operations, use the direct system tools instead.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The coding task to execute' },
          project_directory: { type: 'string', description: 'Working directory for the task' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Save something to long-term memory for future recall. Use for user preferences, project decisions, learned patterns.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'What to remember' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Keywords for retrieval' },
          importance: { type: 'number', description: 'Importance 1-10 (10 = critical)' },
          category: { type: 'string', enum: ['preference', 'project', 'technical', 'personal', 'decision', 'general'] },
        },
        required: ['content', 'tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Search long-term memory for relevant information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_skill',
      description: 'Create a new reusable skill/workflow that Vance can use in the future.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name' },
          description: { type: 'string', description: 'What this skill does' },
          steps: { type: 'array', items: { type: 'string' }, description: 'Step-by-step instructions' },
          triggers: { type: 'array', items: { type: 'string' }, description: 'Keywords that activate this skill' },
        },
        required: ['name', 'description', 'steps', 'triggers'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_project',
      description: 'Create a new project with a directory and tracking.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          directory: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_milestone',
      description: 'Record a project milestone achievement.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string', enum: ['completed', 'in-progress'] },
        },
        required: ['project_id', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_cost_report',
      description: 'Get API cost and usage report.',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['today', 'week', 'month', 'all'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'learn_preference',
      description: 'Learn a user preference or correction for future behavior.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Preference key' },
          value: { type: 'string', description: 'Preference value' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_brain_update',
      description: 'Propose an update to your own brain configuration files (personality, user profile, guidelines, or self-improvement). The update requires user approval before being applied.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', enum: ['personality', 'userProfile', 'guidelines', 'selfImprovement', 'modelRouting', 'operatingModes', 'projectPriorities', 'communicationStyle', 'memoryRules', 'toolRules'], description: 'Which brain file to update' },
          section: { type: 'string', description: 'Section or topic being updated' },
          old_text: { type: 'string', description: 'Existing text to replace (null for additions)' },
          new_text: { type: 'string', description: 'New text to add or replace with' },
          reason: { type: 'string', description: 'Why this update is needed' },
        },
        required: ['file', 'section', 'new_text', 'reason'],
      },
    },
  },
  // ─── Autonomous Task Management ─────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'start_coding_task',
      description: 'Queue an autonomous coding task. Creates a git branch, selects model/budget automatically (or override), and runs Claude Code in the background. Use for multi-file features, refactors, or anything > 5 min. The task runs autonomously while the user can keep chatting.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short human-readable title (e.g. "Add dark mode")' },
          prompt: { type: 'string', description: 'Full detailed prompt for Claude Code' },
          project_directory: { type: 'string', description: 'Working directory for the task' },
          project_id: { type: 'string', description: 'Vance project ID (optional)' },
          model: { type: 'string', enum: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'], description: 'Override model (auto-selected if omitted)' },
          max_budget: { type: 'number', description: 'Override max budget in USD (auto-set based on model if omitted)' },
          priority: { type: 'number', description: 'Priority 1-10 (10=highest, default 5)' },
        },
        required: ['title', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task_status',
      description: 'Get status of a specific task by ID, or the currently running task if no ID given. Returns status, model, cost, duration, milestones, branch.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID (omit for currently running task)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List all tasks, optionally filtered by status or project.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'], description: 'Filter by status' },
          project_id: { type: 'string', description: 'Filter by project' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_task',
      description: 'Pause, resume, or cancel a task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
          action: { type: 'string', enum: ['pause', 'resume', 'cancel'], description: 'Action to take' },
        },
        required: ['task_id', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'merge_task',
      description: 'Merge a completed task\'s git branch into the default branch (main/master). Optionally push to remote.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID of a completed task' },
          push: { type: 'boolean', description: 'Push to remote after merge (default: false)' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_claude_budget',
      description: 'Set daily and/or monthly spending limits for Claude Code tasks.',
      parameters: {
        type: 'object',
        properties: {
          daily: { type: 'number', description: 'Daily budget in USD' },
          monthly: { type: 'number', description: 'Monthly budget in USD' },
        },
        required: ['daily', 'monthly'],
      },
    },
  },
  // ─── Memory System Tools (daily notes, vector search, project files, self-curation) ──
  {
    type: 'function',
    function: {
      name: 'write_daily_note',
      description: 'Append an entry to today\'s daily note. Use to record meaningful work, decisions, or outcomes.',
      parameters: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: ['Summary', 'Tasks Worked On', 'Decisions', 'Open Loops', 'Follow-Up'], description: 'Section to append to' },
          content: { type: 'string', description: 'Content to add' },
        },
        required: ['section', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_daily_note',
      description: 'Read a daily note. Defaults to today. Use to review what happened on a specific day.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vector_search',
      description: 'Semantic search across stored memories, notes, decisions, and research. Use when keyword search isn\'t enough — this finds conceptually similar content.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language query' },
          type: { type: 'string', enum: ['daily-note', 'decision', 'research', 'task-outcome', 'memory', 'project-note'], description: 'Filter by content type' },
          project_id: { type: 'string', description: 'Filter by project' },
          limit: { type: 'number', description: 'Max results (default: 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vector_store',
      description: 'Store content in vector memory for future semantic search. Use for important decisions, research findings, task outcomes, project notes.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Content to store' },
          type: { type: 'string', enum: ['daily-note', 'decision', 'research', 'task-outcome', 'memory', 'project-note'], description: 'Content type' },
          project_id: { type: 'string', description: 'Associated project' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for filtering' },
        },
        required: ['content', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_decision',
      description: 'Record an important project or architecture decision for future reference. Stored in both file and vector memory.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Decision title' },
          content: { type: 'string', description: 'Decision details, rationale, and implications' },
          project_slug: { type: 'string', description: 'Project slug (optional)' },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_memory_section',
      description: 'Update a section in MEMORY.md (long-term curated memory). Use for stable truths, major decisions, recurring patterns.',
      parameters: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'Section name (e.g. "Core User Preferences", "Key Decisions")' },
          content: { type: 'string', description: 'New content for the section' },
        },
        required: ['section', 'content'],
      },
    },
  },

  // ─── Execution Layer Tools ───
  {
    type: 'function',
    function: {
      name: 'run_tool',
      description: 'Run an execution tool directly. Available tools: claude_code (autonomous coding), browser (web automation), research (web search & extraction), memory (unified memory ops), project (project management). Each tool has multiple actions — pass the action in the payload.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: ['claude_code', 'browser', 'research', 'memory', 'project'], description: 'Tool to run' },
          payload: { type: 'object', description: 'Tool-specific input (must include "action" field)' },
        },
        required: ['tool', 'payload'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_agent',
      description: 'Run a multi-step agent workflow. Agents orchestrate multiple tools autonomously. Available agents: coding (analyze → plan → execute → verify), research (search → extract → analyze → store), browser (navigate → interact → extract). Use agents for complex multi-step tasks.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: ['coding', 'research', 'browser'], description: 'Agent to run' },
          input: { type: 'object', description: 'Agent-specific input' },
        },
        required: ['agent', 'input'],
      },
    },
  },

  // ─── Project State Tools ───
  {
    type: 'function',
    function: {
      name: 'get_project_status',
      description: 'Get the full live state of a project: framework, dev server status, preview URL, last changes, last commit. Always call this before responding about a project or after making code changes.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_project_state',
      description: 'Update a project state after code changes. Records files changed, edit summary, and optionally starts the dev server.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files that were changed' },
          summary: { type: 'string', description: 'Short description of changes' },
          start_server: { type: 'boolean', description: 'Start dev server if not running' },
        },
        required: ['project_id', 'files', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_dev_server',
      description: 'Check if a dev server is running for a project and get the preview URL. Optionally start it.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
          start_if_stopped: { type: 'boolean', description: 'Auto-start dev server if not running (default: false)' },
        },
        required: ['project_id'],
      },
    },
  },
];

// ─── Claude Tools (Anthropic format) ─────────────────────────────────────

const CLAUDE_TOOLS = modelRouter.convertToolsToAnthropic(TOOLS);

// Escalation tool — only given to Haiku so it can escalate to Sonnet
const ESCALATION_TOOL = {
  name: 'escalate_to_sonnet',
  description: 'Escalate this request to Sonnet, a more powerful reasoning model. Call this when the request requires: deep multi-step planning, complex debugging/root-cause analysis, architectural decisions, interpreting design specs, writing detailed proposals, research synthesis, or any task requiring sustained reasoning across many factors. Do NOT escalate simple questions, status checks, tool execution, memory lookups, or straightforward commands — handle those yourself.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Brief reason why deeper reasoning is needed' },
    },
    required: ['reason'],
  },
};

// GPT streaming removed — Vance now uses Claude exclusively

// ─── Claude Streaming Call (Anthropic Messages API) ──────────────────────

/**
 * Stream Claude API response. Yields events:
 *   { type: 'token', content: '...' }
 *   { type: 'tool_use_start', index, id, name }
 *   { type: 'tool_input_delta', index, delta: '...' }
 *   { type: 'content_block_stop', index }
 *   { type: 'done', usage: { input_tokens, output_tokens }, stopReason }
 */
async function* callClaudeStream(model, messages, system, tools) {
  const body = {
    model,
    max_tokens: model.includes('haiku') ? 4096 : 8192,
    system,
    messages,
    stream: true,
  };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let inputTokens = 0, outputTokens = 0;
  let stopReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6);

      try {
        const event = JSON.parse(payload);
        switch (event.type) {
          case 'message_start':
            if (event.message?.usage) inputTokens = event.message.usage.input_tokens;
            break;

          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              yield {
                type: 'tool_use_start',
                index: event.index,
                id: event.content_block.id,
                name: event.content_block.name,
              };
            }
            break;

          case 'content_block_delta':
            if (event.delta?.type === 'text_delta') {
              yield { type: 'token', content: event.delta.text };
            } else if (event.delta?.type === 'input_json_delta') {
              yield { type: 'tool_input_delta', index: event.index, delta: event.delta.partial_json };
            }
            break;

          case 'content_block_stop':
            yield { type: 'content_block_stop', index: event.index };
            break;

          case 'message_delta':
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
            if (event.usage) outputTokens = event.usage.output_tokens;
            break;

          case 'message_stop':
            yield { type: 'done', usage: { input_tokens: inputTokens, output_tokens: outputTokens }, stopReason };
            break;
        }
      } catch {}
    }
  }
}

// ─── Shell Command Runner ────────────────────────────────────────────────

function runShell(command, cwd, timeoutSec = 30) {
  return new Promise((resolve) => {
    const timeout = Math.min(timeoutSec, 300) * 1000;
    const proc = spawn('bash', ['-c', command], {
      cwd: cwd || process.env.HOME,
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout,
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      // Truncate very large outputs
      const maxLen = 50000;
      if (stdout.length > maxLen) stdout = stdout.slice(0, maxLen) + `\n... (truncated, ${stdout.length} chars total)`;
      if (stderr.length > maxLen) stderr = stderr.slice(0, maxLen) + `\n... (truncated)`;
      resolve({ code, stdout, stderr });
    });
    proc.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
  });
}

// ─── System Info Collector ───────────────────────────────────────────────

async function getSystemInfo(category = 'all') {
  const info = {};

  const run = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim(); }
    catch { return 'unavailable'; }
  };

  if (category === 'all' || category === 'cpu') {
    info.cpu = {
      model: os.cpus()[0]?.model || 'unknown',
      cores: os.cpus().length,
      load: os.loadavg(),
    };
  }

  if (category === 'all' || category === 'memory') {
    const total = os.totalmem();
    const free = os.freemem();
    info.memory = {
      total: (total / 1e9).toFixed(1) + ' GB',
      used: ((total - free) / 1e9).toFixed(1) + ' GB',
      free: (free / 1e9).toFixed(1) + ' GB',
      percent: ((1 - free / total) * 100).toFixed(0) + '%',
    };
  }

  if (category === 'all' || category === 'disk') {
    const df = run('df -h / | tail -1');
    const parts = df.split(/\s+/);
    info.disk = { total: parts[1], used: parts[2], available: parts[3], percent: parts[4] };
  }

  if (category === 'all' || category === 'battery') {
    const batt = run('pmset -g batt 2>/dev/null');
    info.battery = batt;
  }

  if (category === 'all' || category === 'network') {
    const ip = run("ipconfig getifaddr en0 2>/dev/null || echo 'not connected'");
    const wifi = run("/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I 2>/dev/null | awk '/ SSID/ {print $2}'");
    info.network = { localIP: ip, wifi: wifi || 'not connected' };
  }

  if (category === 'all' || category === 'processes') {
    const topApps = run('ps -eo pid,pcpu,pmem,comm -r | head -11');
    info.processes = topApps;
  }

  if (category === 'all') {
    info.uptime = (os.uptime() / 3600).toFixed(1) + ' hours';
    info.hostname = os.hostname();
    info.user = os.userInfo().username;
    info.platform = `macOS ${run('sw_vers -productVersion 2>/dev/null')}`;
    info.nodeVersion = process.version;
  }

  return info;
}

// ─── File System Helpers ─────────────────────────────────────────────────

function resolvePath(p) {
  if (!p) return process.env.HOME;
  if (p.startsWith('~')) p = path.join(process.env.HOME, p.slice(1));
  return path.resolve(p);
}

function listDir(dirPath, recursive = false, pattern = null) {
  const resolved = resolvePath(dirPath);
  if (!fs.existsSync(resolved)) return { error: `Directory not found: ${resolved}` };

  const entries = [];
  const maxEntries = 500;

  function walk(dir, depth = 0) {
    if (entries.length >= maxEntries) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const item of items) {
      if (entries.length >= maxEntries) break;
      if (item.name.startsWith('.') && depth === 0 && item.name !== '.env') continue; // skip hidden at root

      const fullPath = path.join(dir, item.name);
      const relPath = path.relative(resolved, fullPath);

      if (pattern && !matchGlob(item.name, pattern)) {
        if (item.isDirectory() && recursive) walk(fullPath, depth + 1);
        continue;
      }

      try {
        const stat = fs.statSync(fullPath);
        entries.push({
          name: recursive ? relPath : item.name,
          type: item.isDirectory() ? 'dir' : 'file',
          size: item.isDirectory() ? '-' : formatSize(stat.size),
          modified: stat.mtime.toISOString().split('T')[0],
        });
      } catch {}

      if (item.isDirectory() && recursive) walk(fullPath, depth + 1);
    }
  }

  walk(resolved);
  return { path: resolved, count: entries.length, entries };
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function matchGlob(name, pattern) {
  const regex = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + regex + '$', 'i').test(name);
}

function searchFiles(query, searchPath, filePattern, nameOnly, maxResults = 20) {
  const resolved = resolvePath(searchPath);
  if (nameOnly) {
    // Find files by name
    try {
      const cmd = filePattern
        ? `find "${resolved}" -maxdepth 5 -name "${query}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -${maxResults}`
        : `find "${resolved}" -maxdepth 5 -name "*${query}*" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -${maxResults}`;
      return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();
    } catch (e) { return e.message; }
  }

  // Search file contents
  try {
    const globArg = filePattern ? `--include="${filePattern}"` : '';
    const cmd = `grep -rn ${globArg} --exclude-dir=node_modules --exclude-dir=.git "${query}" "${resolved}" 2>/dev/null | head -${maxResults}`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
    return result || 'No matches found.';
  } catch { return 'No matches found.'; }
}

// ─── Function Executor ───────────────────────────────────────────────────

async function executeFunction(name, args, wsSend) {
  switch (name) {
    // ─── System Tools ───
    case 'run_shell': {
      wsSend({ type: 'status', text: `$ ${args.command.substring(0, 60)}${args.command.length > 60 ? '...' : ''}` });
      const result = await runShell(args.command, args.cwd, args.timeout || 30);
      let output = '';
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += (output ? '\n' : '') + `[stderr] ${result.stderr}`;
      output += `\n[exit code: ${result.code}]`;
      return output;
    }

    case 'read_file': {
      const filePath = resolvePath(args.path);
      if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const start = Math.max(0, (args.start_line || 1) - 1);
        const end = args.end_line ? Math.min(args.end_line, lines.length) : lines.length;
        const slice = lines.slice(start, end);
        const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join('\n');
        if (numbered.length > 50000) return numbered.slice(0, 50000) + `\n... (truncated, ${lines.length} total lines)`;
        return `${filePath} (${lines.length} lines):\n${numbered}`;
      } catch (e) { return `Error reading file: ${e.message}`; }
    }

    case 'write_file': {
      const filePath = resolvePath(args.path);
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (args.append) {
          fs.appendFileSync(filePath, args.content);
        } else {
          fs.writeFileSync(filePath, args.content);
        }
        return `Written to ${filePath} (${args.content.length} chars${args.append ? ', appended' : ''})`;
      } catch (e) { return `Error writing file: ${e.message}`; }
    }

    case 'list_directory': {
      const result = listDir(args.path, args.recursive, args.pattern);
      if (result.error) return result.error;
      let output = `${result.path} (${result.count} items):\n`;
      for (const e of result.entries) {
        output += `  ${e.type === 'dir' ? '[DIR]' : '     '} ${e.name}  ${e.size}  ${e.modified}\n`;
      }
      return output;
    }

    case 'search_files': {
      wsSend({ type: 'status', text: `Searching for "${args.query}"...` });
      return searchFiles(args.query, args.path, args.file_pattern, args.name_only, args.max_results || 20);
    }

    case 'system_info': {
      const info = await getSystemInfo(args.category || 'all');
      return JSON.stringify(info, null, 2);
    }

    case 'open_app': {
      try {
        const target = args.target;
        // URL
        if (target.startsWith('http://') || target.startsWith('https://')) {
          execSync(`open "${target}"`, { timeout: 5000 });
          return `Opened URL: ${target}`;
        }
        // App name
        if (!target.includes('/') && !target.includes('.')) {
          execSync(`open -a "${target}"`, { timeout: 5000 });
          return `Opened app: ${target}`;
        }
        // File path
        const filePath = resolvePath(target);
        execSync(`open "${filePath}"`, { timeout: 5000 });
        return `Opened: ${filePath}`;
      } catch (e) { return `Error opening: ${e.message}`; }
    }

    case 'run_applescript': {
      try {
        const result = execSync(`osascript -e '${args.script.replace(/'/g, "'\\''")}'`, {
          encoding: 'utf8', timeout: 10000,
        });
        return result.trim() || 'AppleScript executed successfully.';
      } catch (e) { return `AppleScript error: ${e.stderr || e.message}`; }
    }

    // ─── Claude Code (complex AI tasks) ───
    case 'run_claude_code': {
      wsSend({ type: 'status', text: 'Executing code task...' });
      const result = await runClaudeCode(args.task, args.project_directory, wsSend);
      return result;
    }

    // ─── Memory & Brain Tools ───
    case 'remember': {
      const mem = memory.addMemory(args.content, args.tags, args.importance || 5, args.category || 'general');
      return `Remembered: "${args.content}" [tags: ${args.tags.join(', ')}]`;
    }

    case 'recall': {
      const results = memory.searchMemories(args.query, 5);
      if (!results.length) return 'No relevant memories found.';
      return results.map(m => `- [${m.category}] ${m.content} (importance: ${m.importance})`).join('\n');
    }

    case 'create_skill': {
      const skill = memory.createSkill(args.name, args.description, args.steps, args.triggers);
      return `Skill created: "${skill.name}" (triggers: ${args.triggers.join(', ')})`;
    }

    case 'create_project': {
      const projects = loadProjects();
      const id = args.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const dir = args.directory || path.join(process.env.HOME, 'Claude Test', args.name);
      projects.push({
        id, name: args.name, description: args.description || '',
        directory: dir, status: 'active', createdAt: new Date().toISOString(),
      });
      saveProjects(projects);
      fs.mkdirSync(dir, { recursive: true });
      wsSend({ type: 'project-created', project: projects[projects.length - 1] });
      return `Project "${args.name}" created at ${dir}`;
    }

    case 'add_milestone': {
      const ms = addMilestone(args.project_id, { title: args.title, status: args.status || 'completed' });
      wsSend({ type: 'milestone', title: args.title, projectId: args.project_id });
      return `Milestone recorded: "${args.title}"`;
    }

    case 'get_cost_report': {
      const stats = costs.getStats(args.period || 'all');
      let report = `Cost Report (${stats.period}):\n`;
      report += `Total: $${stats.totalCost} across ${stats.totalCalls} API calls\n`;
      report += `Tokens: ${stats.totalInput} input, ${stats.totalOutput} output\n\n`;
      if (stats.byComponent.length) {
        report += `By Component:\n${stats.byComponent.map(c => `  ${c.name}: $${c.cost}`).join('\n')}\n\n`;
      }
      if (stats.byModel.length) {
        report += `By Model:\n${stats.byModel.map(m => `  ${m.name}: $${m.cost}`).join('\n')}`;
      }
      return report;
    }

    case 'learn_preference': {
      memory.learnPreference(args.key, args.value);
      return `Learned preference: ${args.key} = ${args.value}`;
    }

    case 'propose_brain_update': {
      const update = brain.proposeBrainUpdate(
        args.file, args.section, args.old_text || null, args.new_text, args.reason
      );
      wsSend({ type: 'brain-update-proposed', update });
      return `Brain update proposed for ${args.file}/${args.section}: "${args.reason}". Awaiting user approval.`;
    }

    // ─── Autonomous Task Management ───
    case 'start_coding_task': {
      wsSend({ type: 'status', text: `Queuing task: ${args.title}` });
      const task = taskManager.createTask({
        title: args.title,
        prompt: args.prompt,
        projectDir: args.project_directory,
        projectId: args.project_id,
        model: args.model,
        maxBudget: args.max_budget,
        priority: args.priority,
      });

      // Auto-start if nothing running
      const started = taskManager.startNext();

      let response = `Task queued: "${task.title}" [${task.tier}/${task.model}, budget $${task.maxBudget}]`;
      if (started) {
        response = `Task started: "${task.title}" [${task.tier}/${task.model}, budget $${task.maxBudget}]`;
        if (task.branch) response += `\nBranch: ${task.branch}`;
      } else if (taskManager.getRunningTask()) {
        response += '\nQueued behind currently running task.';
      }
      return response;
    }

    case 'get_task_status': {
      const task = args.task_id
        ? taskManager.getTask(args.task_id)
        : taskManager.getRunningTask();

      if (!task) return args.task_id ? `No task found with ID: ${args.task_id}` : 'No task currently running.';

      const summary = taskManager.taskSummary(task);
      let report = `Task: "${summary.title}" [${summary.status}]\n`;
      report += `Model: ${summary.tier} (${summary.model})\n`;
      report += `Duration: ${summary.durationFormatted}\n`;
      report += `Cost: $${(summary.costUsd || 0).toFixed(2)} / $${summary.maxBudget} budget\n`;
      if (summary.branch) report += `Branch: ${summary.branch}\n`;
      if (summary.milestones.length) {
        report += `Milestones (${summary.milestonesCount}):\n`;
        for (const m of summary.milestones.slice(-5)) {
          report += `  - ${m.detail}\n`;
        }
      }
      if (summary.error) report += `Error: ${summary.error}\n`;
      return report;
    }

    case 'list_tasks': {
      const tasks = taskManager.getAllTasks({
        status: args.status,
        projectId: args.project_id,
      });
      if (!tasks.length) return 'No tasks found.';

      let output = `Tasks (${tasks.length}):\n`;
      for (const t of tasks) {
        const s = taskManager.taskSummary(t);
        output += `  [${s.id}] ${s.title} — ${s.status} (${s.tier}, $${(s.costUsd || 0).toFixed(2)})\n`;
      }
      return output;
    }

    case 'control_task': {
      let result;
      switch (args.action) {
        case 'pause': result = taskManager.pauseTask(args.task_id); break;
        case 'resume': result = taskManager.resumeTask(args.task_id); break;
        case 'cancel': result = taskManager.cancelTask(args.task_id); break;
        default: return `Unknown action: ${args.action}`;
      }
      if (result.error) return `Error: ${result.error}`;
      return `Task ${args.task_id} ${args.action}d successfully.`;
    }

    case 'merge_task': {
      const task = taskManager.getTask(args.task_id);
      if (!task) return `Task not found: ${args.task_id}`;
      if (task.status !== 'completed') return `Task must be completed to merge. Current status: ${task.status}`;
      if (!task.branch) return 'Task has no branch to merge.';
      if (!task.projectDir) return 'Task has no project directory.';

      try {
        const cwd = task.projectDir;
        // Determine default branch
        let defaultBranch = 'main';
        try {
          defaultBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', { cwd, encoding: 'utf8' }).trim().replace('origin/', '');
        } catch {}

        execSync(`git checkout ${defaultBranch}`, { cwd, stdio: 'pipe' });
        execSync(`git merge --no-ff ${task.branch} -m "Merge ${task.branch}: ${task.title}"`, { cwd, stdio: 'pipe' });

        let response = `Merged ${task.branch} into ${defaultBranch}.`;

        if (args.push) {
          execSync(`git push origin ${defaultBranch}`, { cwd, stdio: 'pipe', timeout: 30000 });
          response += ` Pushed to remote.`;
        }

        // Clean up branch
        try {
          execSync(`git branch -d ${task.branch}`, { cwd, stdio: 'pipe' });
        } catch {}

        return response;
      } catch (e) {
        return `Merge failed: ${e.message}`;
      }
    }

    case 'set_claude_budget': {
      costs.setBudget('claude', args.daily, args.monthly);
      return `Claude budget set: $${args.daily}/day, $${args.monthly}/month`;
    }

    // ─── Memory System Tools ───
    case 'write_daily_note': {
      const filePath = memory.appendDailyNote(args.section, args.content);
      memory.autoCurate('append-daily-note', { section: args.section, content: args.content.slice(0, 100) });
      return `Added to daily note (${args.section}): ${args.content.slice(0, 100)}`;
    }

    case 'read_daily_note': {
      const note = memory.readDailyNote(args.date);
      if (!note) return args.date ? `No daily note found for ${args.date}.` : 'No daily note for today yet.';
      return note;
    }

    case 'vector_search': {
      wsSend({ type: 'status', text: 'Searching memory...' });
      const results = await vectorMemory.search(args.query, {
        limit: args.limit || 5,
        type: args.type || null,
        projectId: args.project_id || null,
      });
      if (!results.length) return 'No relevant results found in vector memory.';
      return results.map((r, i) =>
        `${i + 1}. [${r.metadata.type}] (score: ${r.score.toFixed(2)}) ${r.content.slice(0, 300)}`
      ).join('\n\n');
    }

    case 'vector_store': {
      const result = await vectorMemory.store(args.content, {
        type: args.type,
        projectId: args.project_id || null,
        tags: args.tags || [],
      });
      return result.stored ? `Stored in vector memory (${args.type}).` : `Failed to store: ${result.error}`;
    }

    case 'record_decision': {
      const filePath = memory.recordDecision(args.title, args.content, args.project_slug);
      // Also store in vector memory for semantic search
      vectorMemory.store(
        `Decision: ${args.title}\n${args.content}`,
        { type: 'decision', projectId: args.project_slug || null, tags: ['decision'] }
      ).catch(() => {});
      return `Decision recorded: "${args.title}" → ${filePath}`;
    }

    case 'update_memory_section': {
      const check = memory.isSafeAutoCuration('update-memory-section', 'MEMORY.md');
      if (!check.safe) return `Cannot auto-update: ${check.reason}. Propose a brain update instead.`;
      const success = memory.updateMemoryMdSection(args.section, args.content);
      if (success) {
        brain.invalidateMemoryCache();
        memory.autoCurate('update-memory-section', { section: args.section });
        return `Updated MEMORY.md section: "${args.section}"`;
      }
      return 'Failed to update MEMORY.md — file may not exist.';
    }

    // ─── Project State ───
    case 'get_project_status': {
      const projects = loadProjects();
      const project = projects.find(p => p.id === args.project_id);
      if (!project) return `Project not found: ${args.project_id}`;

      // Init state if first time
      projectState.initProjectState(args.project_id, project.name, project.directory);
      const status = projectState.getProjectStatus(args.project_id);

      let report = `PROJECT STATUS\n`;
      report += `Name: ${status.project_name}\n`;
      report += `Directory: ${status.project_directory}\n`;
      if (status.dev_framework) report += `Framework: ${status.dev_framework}\n`;
      if (status.dev_server_command) report += `Dev Command: ${status.dev_server_command}\n`;
      report += `\nDev Server: ${status.dev_server_running ? 'RUNNING' : 'STOPPED'}`;
      if (status.dev_port) report += ` (port ${status.dev_port})`;
      report += '\n';
      if (status.preview_available) report += `Preview: ${status.preview_available}\n`;
      else if (status.preview_url) report += `Preview URL (server not running): ${status.preview_url}\n`;
      if (status.last_updated_files?.length) {
        report += `\nLast Changed Files:\n${status.last_updated_files.map(f => `- ${f}`).join('\n')}\n`;
      }
      if (status.last_edit_summary) report += `Last Edit: ${status.last_edit_summary}\n`;
      if (status.last_commit_time) report += `Last Commit: ${status.last_commit_time}\n`;
      return report;
    }

    case 'update_project_state': {
      const state = projectState.recordChange(args.project_id, args.files, args.summary);

      let result = `Project state updated: ${args.files.length} file(s) changed — "${args.summary}"`;

      if (args.start_server) {
        const status = projectState.getProjectStatus(args.project_id);
        if (status && !status.dev_server_running && status.dev_server_command && status.project_directory) {
          try {
            const { exec: execAsync } = require('child_process');
            execAsync(status.dev_server_command, {
              cwd: status.project_directory,
              detached: true,
              stdio: 'ignore',
            }).unref?.();
            result += `\nDev server starting: ${status.dev_server_command}`;
            result += `\nPreview: ${status.preview_url}`;
          } catch (e) {
            result += `\nFailed to start dev server: ${e.message}`;
          }
        } else if (status?.dev_server_running) {
          result += `\nDev server already running at ${status.preview_url}`;
        }
      }
      return result;
    }

    case 'check_dev_server': {
      const projects = loadProjects();
      const project = projects.find(p => p.id === args.project_id);
      if (!project) return `Project not found: ${args.project_id}`;

      projectState.initProjectState(args.project_id, project.name, project.directory);
      const status = projectState.getProjectStatus(args.project_id);
      if (!status) return 'No project state found.';

      if (status.dev_server_running) {
        return `Dev server is RUNNING at ${status.preview_url} (port ${status.dev_port})`;
      }

      if (args.start_if_stopped && status.dev_server_command && status.project_directory) {
        try {
          const { exec: execAsync } = require('child_process');
          execAsync(status.dev_server_command, {
            cwd: status.project_directory,
            detached: true,
            stdio: 'ignore',
          }).unref?.();
          return `Dev server was STOPPED. Starting: ${status.dev_server_command}\nPreview will be at: ${status.preview_url}`;
        } catch (e) {
          return `Dev server STOPPED. Failed to start: ${e.message}`;
        }
      }

      let msg = `Dev server is STOPPED`;
      if (status.dev_server_command) msg += `\nStart with: ${status.dev_server_command}`;
      if (status.preview_url) msg += `\nPreview URL (when running): ${status.preview_url}`;
      return msg;
    }

    // ─── Execution Layer ───
    case 'run_tool': {
      wsSend({ type: 'status', text: `Running tool: ${args.tool}...` });
      const result = await toolRouter.execute_tool(args.tool, args.payload, { wsSend });
      if (result.success) {
        return typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result, null, 2);
      }
      return `Tool error: ${result.error}`;
    }

    case 'run_agent': {
      const agent = AGENTS[args.agent];
      if (!agent) return `Unknown agent: ${args.agent}. Available: ${Object.keys(AGENTS).join(', ')}`;
      wsSend({ type: 'status', text: `Running ${args.agent} agent...` });
      wsSend({ type: 'agent-start', agent: args.agent });
      const result = await agent.run(args.input, { wsSend });
      wsSend({ type: 'agent-complete', agent: args.agent, success: result.success });
      if (result.success) {
        let output = `Agent "${args.agent}" completed in ${((result.duration || 0) / 1000).toFixed(1)}s`;
        if (result.totalCost) output += ` ($${result.totalCost.toFixed(2)})`;
        if (result.result) output += `\n\n${typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2)}`;
        if (Array.isArray(result.findings) && result.findings.length) {
          output += `\n\nFindings:\n${result.findings.map(f => `- ${f.title || 'Untitled'}: ${(f.summary || f.content || '').slice(0, 200)}`).join('\n')}`;
        } else if (typeof result.findings === 'string') {
          output += `\n\n${result.findings}`;
        }
        return output;
      }
      return `Agent "${args.agent}" failed: ${result.error || result.result}`;
    }

    default:
      return `Unknown function: ${name}`;
  }
}

// ─── Claude Code Runner ──────────────────────────────────────────────────

function runClaudeCode(task, projectDir, wsSend) {
  return new Promise((resolve, reject) => {
    const args = ['-p', task, '--output-format', 'stream-json',
      '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(git *),Bash(npm *),Bash(node *),Bash(ls *),Bash(mkdir *)'];

    const cwd = projectDir || process.env.HOME;
    const proc = spawn('claude', args, {
      cwd, env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let costUsd = 0;

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text') {
                output += block.text;
                wsSend({ type: 'claude-stream', content: block.text });
              } else if (block.type === 'tool_use') {
                wsSend({ type: 'claude-tool', name: block.name });
              }
            }
          } else if (parsed.type === 'result') {
            costUsd = parsed.cost_usd || 0;
          }
        } catch {}
      }
    });

    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', (code) => {
      if (costUsd) {
        costs.logCall('claude', 'claude-sonnet-4-6', { cost: costUsd });
      }
      if (code === 0) {
        resolve(output || 'Task completed successfully.');
      } else {
        resolve(`Task encountered an issue: ${stderr.slice(0, 500) || 'Unknown error'}`);
      }
    });

    proc.on('error', (err) => resolve(`Failed to run Claude Code: ${err.message}`));
  });
}

// ─── Chat Handler ────────────────────────────────────────────────────────

function buildChatContext(projectId) {
  const projects = loadProjects();
  const project = projects.find(p => p.id === projectId);
  const projectContext = project ? { ...project, milestones: loadMilestones(projectId) } : null;
  const runningTask = taskManager.getRunningTask();
  const queuedTasks = taskManager.getAllTasks({ status: 'queued' });
  return { projects, project, projectContext, runningTask, queuedTasks };
}

function buildSystemPromptForChat(userMessage, ctx, tier) {
  const relevantMemories = memory.searchMemories(userMessage, 5);
  const relevantSkills = memory.findSkillsForQuery(userMessage);
  const preferences = memory.getPreferences();
  const memStats = memory.getMemoryStats();
  const todayStats = costs.getStats('today');

  return brain.buildSystemPrompt({
    project: ctx.projectContext,
    memories: relevantMemories,
    skills: relevantSkills,
    preferences,
    stats: {
      memoryCount: memStats.total,
      skillCount: memory.loadSkills().length,
      projectCount: ctx.projects.length,
    },
    costs: {
      todaySpend: todayStats.totalCost.toFixed(2),
      todayCalls: todayStats.totalCalls,
    },
    runningTask: ctx.runningTask ? taskManager.taskSummary(ctx.runningTask) : null,
    queuedTaskCount: ctx.queuedTasks.length,
    modelTier: tier,
  });
}

async function handleChat(userMessage, projectId, wsSend) {
  const convId = projectId || 'general';
  const convMessages = loadConversation(convId);
  convMessages.push({ role: 'user', content: userMessage, timestamp: new Date().toISOString() });
  return handleClaudeChat(userMessage, convId, convMessages, projectId, wsSend);
}

// ─── Claude Chat (Tiered: Haiku default → escalate to Sonnet) ────────────

async function handleClaudeChat(userMessage, convId, convMessages, projectId, wsSend) {
  const ctx = buildChatContext(projectId);

  // ALL conversations start at Haiku
  const routing = modelRouter.getDefaultTier();
  let currentModel = routing.model;
  let currentTier = routing.tier;
  let currentLabel = routing.label;

  const systemPrompt = buildSystemPromptForChat(userMessage, ctx, currentTier);

  wsSend({ type: 'thinking', tier: currentTier, label: currentLabel });
  wsSend({ type: 'model-tier', tier: currentTier, label: currentLabel, reason: routing.reason });

  // Build tools — Haiku gets escalation tool, Sonnet does not
  let tools = [...CLAUDE_TOOLS, ESCALATION_TOOL];

  // Build messages for Claude API (last 20 messages)
  const apiMessages = [];
  const recent = convMessages.slice(-20);
  for (const m of recent) {
    if (m.role === 'user') {
      apiMessages.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      apiMessages.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] });
    }
  }

  // Ensure first message is from user (Anthropic API requirement)
  while (apiMessages.length && apiMessages[0].role !== 'user') {
    apiMessages.shift();
  }
  // Ensure we have at least one message
  if (!apiMessages.length) {
    apiMessages.push({ role: 'user', content: userMessage });
  }

  try {
    let fullText = '';
    let rounds = 0;
    let activeSystem = systemPrompt;

    while (rounds < 8) {
      rounds++;
      let text = '';
      const toolUses = {}; // index -> { id, name, inputJson }
      let hasToolUse = false;
      let stopReason = null;

      for await (const event of callClaudeStream(currentModel, apiMessages, activeSystem, tools)) {
        if (event.type === 'token') {
          text += event.content;
          wsSend({ type: 'stream-token', content: event.content });
        } else if (event.type === 'tool_use_start') {
          hasToolUse = true;
          toolUses[event.index] = { id: event.id, name: event.name, inputJson: '' };
          if (event.name !== 'escalate_to_sonnet') {
            wsSend({ type: 'function-call', name: event.name });
          }
        } else if (event.type === 'tool_input_delta') {
          if (toolUses[event.index]) toolUses[event.index].inputJson += event.delta;
        } else if (event.type === 'done') {
          stopReason = event.stopReason;
          // Log cost
          const costModel = modelRouter.costModelName(currentModel);
          costs.logCall('claude-chat', costModel, {
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

      // Check for escalation BEFORE executing other tools
      const escalateCall = Object.values(toolUses).find(tu => tu.name === 'escalate_to_sonnet');
      if (escalateCall) {
        let reason = 'deeper reasoning needed';
        try { reason = JSON.parse(escalateCall.inputJson).reason || reason; } catch {}

        // Switch to Sonnet
        const sonnet = modelRouter.TIERS.sonnet;
        currentModel = sonnet.model;
        currentTier = 'sonnet';
        currentLabel = sonnet.label;
        tools = [...CLAUDE_TOOLS]; // Sonnet doesn't need escalation tool

        // Rebuild system prompt for Sonnet (includes full brain files)
        activeSystem = buildSystemPromptForChat(userMessage, ctx, 'sonnet');

        wsSend({ type: 'model-tier', tier: 'sonnet', label: 'SONNET', reason: `Escalated: ${reason}` });

        // Don't add the failed tool call to history — just retry with Sonnet
        // Clear any partial streaming text
        if (text) {
          // Haiku produced some text before escalating — discard it
          // The frontend will handle the model switch notification
        }
        continue;
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

      // Execute tools and build results
      const toolResults = [];
      for (const [, tu] of Object.entries(toolUses)) {
        let input = {};
        try { input = JSON.parse(tu.inputJson); } catch {}

        wsSend({ type: 'status', text: `Running ${tu.name}...` });
        const result = await executeFunction(tu.name, input, wsSend);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }

      // Add tool results as user message (Anthropic format)
      if (toolResults.length) {
        apiMessages.push({ role: 'user', content: toolResults });
      }

      wsSend({ type: 'tool-done' });
    }

    wsSend({ type: 'stream-end', tier: currentTier, label: currentLabel });

    // Save to conversation
    convMessages.push({
      role: 'assistant',
      content: fullText,
      timestamp: new Date().toISOString(),
      tier: currentTier,
    });
    saveConversation(convId, convMessages);
    memory.learnPattern(userMessage, ctx.project ? 'project-work' : 'general');

    return fullText;

  } catch (err) {
    const errMsg = `I ran into an issue: ${err.message}`;
    wsSend({ type: 'error', message: errMsg });
    wsSend({ type: 'stream-end', tier: currentTier, label: currentLabel });
    convMessages.push({ role: 'assistant', content: errMsg, timestamp: new Date().toISOString() });
    saveConversation(convId, convMessages);
    return errMsg;
  }
}

// GPT path removed — Vance now runs entirely on Claude (Haiku/Sonnet/Claude Code)

// ─── WebSocket (using ws library) ────────────────────────────────────────

const clients = new Set();

async function handleMessage(ws, msg) {
  switch (msg.action) {
    case 'chat': {
      const chatSend = (data) => ws.send(data);
      try {
        await handleChat(msg.message, msg.projectId, chatSend);
      } catch (e) {
        // Guarantee stream-end is sent even if handleChat crashes unexpectedly
        console.error('Chat handler crash:', e.message);
        chatSend({ type: 'error', message: `Chat error: ${e.message}` });
        chatSend({ type: 'stream-end', tier: 'haiku', label: 'HAIKU' });
      }
      break;
    }

    case 'list-projects': {
      const projects = loadProjects().map(p => ({ ...p, milestones: loadMilestones(p.id) }));
      ws.send({ type: 'projects', projects });
      break;
    }

    case 'get-conversation': {
      const msgs = loadConversation(msg.convId || 'general');
      ws.send({ type: 'conversation', convId: msg.convId || 'general', messages: msgs });
      break;
    }

    case 'get-milestones': {
      ws.send({ type: 'milestones', projectId: msg.projectId, milestones: loadMilestones(msg.projectId) });
      break;
    }

    case 'get-costs': {
      const stats = costs.getStats(msg.period || 'all');
      const recent = costs.getRecentCalls(msg.limit || 50);
      ws.send({ type: 'costs', stats, recent });
      break;
    }

    case 'get-memories': {
      ws.send({ type: 'memories', memories: memory.getAllMemories(), stats: memory.getMemoryStats() });
      break;
    }

    case 'get-skills': {
      ws.send({ type: 'skills', skills: memory.loadSkills() });
      break;
    }

    case 'get-brain': {
      ws.send({ type: 'brain', files: brain.getBrainFiles(), pending: brain.getPendingUpdates() });
      break;
    }

    case 'approve-brain-update': {
      const result = brain.approveBrainUpdate(msg.updateId);
      ws.send({ type: 'brain-update-result', action: 'approved', ...result });
      break;
    }

    case 'reject-brain-update': {
      const result = brain.rejectBrainUpdate(msg.updateId);
      ws.send({ type: 'brain-update-result', action: 'rejected', ...result });
      break;
    }

    case 'get-tasks': {
      const tasks = taskManager.getAllTasks();
      ws.send({ type: 'tasks', tasks: tasks.map(t => taskManager.taskSummary(t)) });
      break;
    }

    case 'get-task-log': {
      const log = taskManager.readLog(msg.taskId);
      ws.send({ type: 'task-log', taskId: msg.taskId, log });
      break;
    }

    // ─── Memory System Actions ───
    case 'get-daily-notes': {
      const notes = memory.listDailyNotes(msg.limit || 30);
      ws.send({ type: 'daily-notes', notes });
      break;
    }

    case 'get-daily-note': {
      const note = memory.readDailyNote(msg.date);
      ws.send({ type: 'daily-note', date: msg.date, content: note });
      break;
    }

    case 'get-vector-stats': {
      ws.send({ type: 'vector-stats', stats: vectorMemory.getStats() });
      break;
    }

    case 'get-curation-history': {
      ws.send({ type: 'curation-history', entries: memory.getCurationHistory(msg.limit || 50) });
      break;
    }

    case 'get-memory-md': {
      ws.send({ type: 'memory-md', content: memory.readMemoryMd() });
      break;
    }

    case 'get-projects-md': {
      ws.send({ type: 'projects-md', content: memory.readProjectsMd() });
      break;
    }

    case 'get-telemetry': {
      const sysInfo = await getSystemInfo('all');
      const costStats = costs.getStats('today');
      const costWeek = costs.getStats('week');
      const running = taskManager.getRunningTask();
      const queued = taskManager.getAllTasks({ status: 'queued' });
      ws.send({
        type: 'telemetry',
        system: sysInfo,
        costs: { today: costStats, week: costWeek },
        tasks: { running: running ? taskManager.taskSummary(running) : null, queuedCount: queued.length },
      });
      break;
    }

    // ─── Project State Actions ───
    case 'get-project-state': {
      const projects = loadProjects();
      const project = projects.find(p => p.id === msg.projectId);
      if (!project) { ws.send({ type: 'error', message: 'Project not found' }); break; }
      projectState.initProjectState(msg.projectId, project.name, project.directory);
      ws.send({ type: 'project-state', projectId: msg.projectId, state: projectState.getProjectStatus(msg.projectId) });
      break;
    }

    case 'get-all-project-states': {
      ws.send({ type: 'all-project-states', states: projectState.getAllStates() });
      break;
    }

    // ─── Execution Layer Actions ───
    case 'list-tools': {
      ws.send({ type: 'tools', tools: toolRouter.listTools() });
      break;
    }

    case 'run-tool': {
      const result = await toolRouter.execute_tool(msg.tool, msg.payload, {
        wsSend: (data) => ws.send(data),
        projectId: msg.projectId,
      });
      ws.send({ type: 'tool-result', tool: msg.tool, ...result });
      break;
    }

    case 'run-agent': {
      const agent = AGENTS[msg.agent];
      if (!agent) {
        ws.send({ type: 'error', message: `Unknown agent: ${msg.agent}` });
        break;
      }
      ws.send({ type: 'agent-start', agent: msg.agent });
      const result = await agent.run(msg.input || {}, {
        wsSend: (data) => ws.send(data),
        projectId: msg.projectId,
      });
      ws.send({ type: 'agent-result', agent: msg.agent, ...result });
      break;
    }

    case 'get-execution-logs': {
      const logs = executionLogger.readLogs(msg.limit || 50, msg.filter);
      ws.send({ type: 'execution-logs', logs });
      break;
    }

    case 'get-execution-stats': {
      ws.send({ type: 'execution-stats', stats: executionLogger.getStats() });
      break;
    }

    // ─── Spatial Interface Actions ───
    case 'get-spatial-data': {
      const projects = loadProjects().map(p => ({
        ...p,
        milestones: loadMilestones(p.id),
        state: projectState.getProjectStatus(p.id),
      }));
      const tasks = taskManager.getAllTasks().map(t => taskManager.taskSummary(t));
      const costStats = costs.getStats('today');
      const sysInfo = await getSystemInfo('all');
      const pending = brain.getPendingUpdates();
      const allStates = projectState.getAllStates();
      ws.send({
        type: 'spatial-data',
        projects,
        tasks,
        costs: costStats,
        system: sysInfo,
        pendingBrainUpdates: pending,
        projectStates: allStates,
      });
      break;
    }

    case 'classify-project': {
      const projects = loadProjects();
      const idx = projects.findIndex(p => p.id === msg.projectId);
      if (idx === -1) { ws.send({ type: 'error', message: 'Project not found' }); break; }
      projects[idx].layer = msg.layer || 2;
      projects[idx].projectType = msg.projectType || 'venture';
      saveProjects(projects);
      ws.send({ type: 'project-classified', projectId: msg.projectId, layer: projects[idx].layer, projectType: projects[idx].projectType });
      break;
    }

    case 'create-project': {
      const projects = loadProjects();
      const newProj = {
        id: crypto.randomUUID(),
        name: msg.name || 'Untitled',
        description: msg.description || '',
        directory: msg.directory || '',
        layer: msg.layer || null,
        projectType: msg.projectType || null,
        createdAt: new Date().toISOString(),
      };
      projects.push(newProj);
      saveProjects(projects);
      ws.send({ type: 'project-created', project: newProj });
      break;
    }

    // ─── Voice System Actions ───
    case 'voice-start': {
      if (!voiceSystem) {
        ws.send({ type: 'voice-error', component: 'system', message: 'Voice system not initialized' });
        break;
      }
      // Apply config overrides if provided
      if (msg.config) voiceSystem.updateConfig(msg.config);
      const started = await voiceSystem.start();
      if (!started) {
        ws.send({ type: 'voice-error', component: 'system', message: 'Voice system failed to start — check backends' });
      }
      break;
    }

    case 'voice-stop': {
      if (voiceSystem) voiceSystem.stop();
      break;
    }

    case 'voice-mute': {
      if (voiceSystem) voiceSystem.mute();
      break;
    }

    case 'voice-unmute': {
      if (voiceSystem) voiceSystem.unmute();
      break;
    }

    case 'voice-configure': {
      if (voiceSystem && msg.config) voiceSystem.updateConfig(msg.config);
      ws.send({ type: 'voice-configured', config: msg.config });
      break;
    }

    case 'voice-status': {
      ws.send({ type: 'voice-status', status: voiceSystem ? voiceSystem.getStatus() : { state: 'unavailable' } });
      break;
    }

    default:
      ws.send({ type: 'error', message: `Unknown action: ${msg.action}` });
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // API endpoints
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online', uptime: process.uptime(), model: 'claude-haiku/sonnet',
      hasKey: !!ANTHROPIC_KEY, tiers: ['haiku', 'sonnet', 'claude-code'],
      memory: { vectors: vectorMemory.getStats().totalEntries, dailyNotes: memory.listDailyNotes(1).length > 0 },
      execution: { tools: toolRouter.listTools().length, agents: Object.keys(AGENTS).length },
    }));
    return;
  }
  if (url.pathname === '/api/costs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(costs.getStats(url.searchParams.get('period') || 'all')));
    return;
  }
  if (url.pathname === '/api/projects') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projects: loadProjects().map(p => ({ ...p, milestones: loadMilestones(p.id) })) }));
    return;
  }

  if (url.pathname === '/api/brain') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files: brain.getBrainFiles(), pending: brain.getPendingUpdates() }));
    return;
  }
  if (url.pathname.startsWith('/api/brain/') && req.method === 'GET') {
    const fileKey = url.pathname.split('/').pop();
    const content = brain.readBrainFile(fileKey);
    if (content !== '') {
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(content);
    } else {
      res.writeHead(404); res.end('Brain file not found');
    }
    return;
  }

  // Serve UI pages
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveFile(res, 'index.html');
  }
  if (url.pathname === '/costs' || url.pathname === '/costs.html') {
    return serveFile(res, 'costs.html');
  }
  if (url.pathname === '/brain' || url.pathname === '/brain.html') {
    return serveFile(res, 'brain.html');
  }
  if (url.pathname === '/spatial' || url.pathname === '/spatial.html') {
    return serveFile(res, 'spatial.html');
  }

  // Serve static .js and .css files from __dirname
  const STATIC_TYPES = { '.js': 'application/javascript', '.css': 'text/css' };
  const ext = path.extname(url.pathname);
  if (STATIC_TYPES[ext]) {
    const fp = path.join(__dirname, url.pathname.replace(/^\//, ''));
    if (fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext] });
      res.end(fs.readFileSync(fp));
      return;
    }
  }

  res.writeHead(404); res.end('Not found');
});

function serveFile(res, filename) {
  const fp = path.join(__dirname, filename);
  if (fs.existsSync(fp)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(fp));
  } else {
    res.writeHead(404); res.end('Not found');
  }
}

const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (socket) => {
  const ws = {
    send(data) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(typeof data === 'string' ? data : JSON.stringify(data));
        }
      } catch {}
    },
  };
  clients.add(ws);
  ws.send({ type: 'connected', model: 'claude-haiku/sonnet', hasKey: !!ANTHROPIC_KEY, tier: 'haiku' });
  socket.on('message', (raw) => {
    try { handleMessage(ws, JSON.parse(raw.toString())); }
    catch { handleMessage(ws, { raw: raw.toString() }); }
  });
  socket.on('close', () => clients.delete(ws));
});

// Prevent uncaught exceptions from crashing the server
process.on('uncaughtException', (err) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message?.includes('ECONNRESET')) return;
  console.error('Uncaught:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});

// ─── Task Manager Broadcast Setup ─────────────────────────────────────────

taskManager.setBroadcast((event) => {
  for (const client of clients) {
    try { client.send(event); } catch {}
  }
});

// ─── Voice System Setup ───────────────────────────────────────────────────

let voiceSystem = null;

function initVoiceSystem() {
  const GROQ_KEY = process.env.GROQ_API_KEY || '';
  const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || '';
  const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY || '';

  voiceSystem = new VoiceSystem({
    openaiKey: OPENAI_KEY,
    groqKey: GROQ_KEY,
    deepgramKey: DEEPGRAM_KEY,
    elevenLabsKey: ELEVENLABS_KEY,
    whisperModel: process.env.WHISPER_MODEL || 'base',
    whisperBackend: process.env.WHISPER_BACKEND || null,  // force: whisper-cpp, groq, openai
    ttsBackend: process.env.TTS_BACKEND || null,          // force: piper, elevenlabs, openai, macos-say
    alwaysOn: process.env.VOICE_ALWAYS_ON !== 'false',    // default: true (always-on conversational mode)
    fillerEnabled: process.env.VOICE_FILLERS !== 'false', // default: true (thinking fillers)
    fillerDelay: parseInt(process.env.VOICE_FILLER_DELAY) || 800,
    ttsVoice: process.env.TTS_VOICE || null,
    ttsSpeed: parseFloat(process.env.TTS_SPEED) || 1.0,
    elevenLabsVoice: process.env.ELEVENLABS_VOICE_ID || null,
    silenceTimeout: parseInt(process.env.VOICE_SILENCE_TIMEOUT) || 800,
    energyThreshold: parseFloat(process.env.VOICE_ENERGY_THRESHOLD) || 0.008,
    interruptionSensitivity: parseFloat(process.env.VOICE_INTERRUPTION_SENSITIVITY) || 0.5,
  });

  // Wire voice conversation handler — uses Sonnet 4.6 directly for natural voice
  const voiceConversationHandler = new ConversationHandler({
    handleChat: async (message, projectId, wsSend) => {
      // Inject voice-specific prompt into the brain system
      const origBuild = buildSystemPromptForChat;
      const voiceBuild = (userMessage, ctx, tier) => {
        const basePrompt = origBuild(userMessage, ctx, tier);
        return basePrompt + ConversationHandler.VOICE_PROMPT_ADDITION;
      };

      const convId = projectId || 'voice';
      const convMessages = loadConversation(convId);
      convMessages.push({ role: 'user', content: message, timestamp: new Date().toISOString() });

      const ctx = buildChatContext(projectId);

      // Voice uses Sonnet 4.6 directly — no Haiku escalation overhead
      const routing = modelRouter.getVoiceTier();
      const currentModel = routing.model;
      const currentTier = routing.tier;
      const currentLabel = routing.label;

      const systemPrompt = voiceBuild(message, ctx, currentTier);
      // No escalation tool needed — already on Sonnet
      const tools = [...CLAUDE_TOOLS];
      const apiMessages = [];
      const recent = convMessages.slice(-20);
      for (const m of recent) {
        if (m.role === 'user') apiMessages.push({ role: 'user', content: m.content });
        else if (m.role === 'assistant') apiMessages.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] });
      }
      while (apiMessages.length && apiMessages[0].role !== 'user') apiMessages.shift();
      if (!apiMessages.length) apiMessages.push({ role: 'user', content: message });

      let fullText = '';
      let rounds = 0;
      let activeSystem = systemPrompt;

      while (rounds < 8) {
        rounds++;
        let text = '';
        const toolUses = {};
        let hasToolUse = false;
        let stopReason = null;

        for await (const event of callClaudeStream(currentModel, apiMessages, activeSystem, tools)) {
          if (event.type === 'token') {
            text += event.content;
            wsSend({ type: 'stream-token', content: event.content });
          } else if (event.type === 'tool_use_start') {
            hasToolUse = true;
            toolUses[event.index] = { id: event.id, name: event.name, inputJson: '' };
          } else if (event.type === 'tool_input_delta') {
            if (toolUses[event.index]) toolUses[event.index].inputJson += event.delta;
          } else if (event.type === 'done') {
            stopReason = event.stopReason;
            const costModel = modelRouter.costModelName(currentModel);
            costs.logCall('claude-voice', costModel, {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
            });
          }
        }

        if (!hasToolUse || stopReason === 'end_turn') {
          fullText = text;
          break;
        }

        // Execute tools (no escalation needed — already on Sonnet)
        const assistantContent = [];
        if (text) assistantContent.push({ type: 'text', text });
        for (const [, tu] of Object.entries(toolUses)) {
          let input = {};
          try { input = JSON.parse(tu.inputJson); } catch {}
          assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input });
        }
        apiMessages.push({ role: 'assistant', content: assistantContent });

        const toolResults = [];
        for (const [, tu] of Object.entries(toolUses)) {
          let input = {};
          try { input = JSON.parse(tu.inputJson); } catch {}
          const result = await executeFunction(tu.name, input, wsSend);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }
        if (toolResults.length) apiMessages.push({ role: 'user', content: toolResults });
      }

      convMessages.push({ role: 'assistant', content: fullText, timestamp: new Date().toISOString(), tier: currentTier });
      saveConversation(convId, convMessages);
      return fullText;
    },
    buildChatContext,
    buildSystemPromptForChat,
    loadConversation,
    saveConversation,
  });

  voiceSystem.setConversationHandler(voiceConversationHandler);

  // Broadcast voice events to all connected WS clients
  voiceSystem.on('state-change', (data) => {
    for (const client of clients) {
      try { client.send({ type: 'voice-state', state: data.to, from: data.from }); } catch {}
    }
  });

  voiceSystem.on('started', (data) => {
    for (const client of clients) {
      try { client.send({ type: 'voice-started', ...data }); } catch {}
    }
  });

  voiceSystem.on('stopped', () => {
    for (const client of clients) {
      try { client.send({ type: 'voice-stopped' }); } catch {}
    }
  });

  voiceSystem.on('transcription', (data) => {
    for (const client of clients) {
      try { client.send({ type: 'voice-transcription', text: data.text, duration: data.duration }); } catch {}
    }
  });

  voiceSystem.on('response', (data) => {
    for (const client of clients) {
      try { client.send({ type: 'voice-response', text: data.text, latency: data.totalLatency }); } catch {}
    }
  });

  voiceSystem.on('error', (data) => {
    console.error(`Voice error [${data.component}]:`, data.error?.message || data.error);
    for (const client of clients) {
      try { client.send({ type: 'voice-error', component: data.component, message: data.error?.message || String(data.error) }); } catch {}
    }
  });

  voiceSystem.on('interrupted', () => {
    for (const client of clients) {
      try { client.send({ type: 'voice-interrupted' }); } catch {}
    }
  });

  voiceSystem.on('speech-start', () => {
    for (const client of clients) {
      try { client.send({ type: 'voice-speech-start' }); } catch {}
    }
  });

  voiceSystem.on('backends-detected', (data) => {
    for (const client of clients) {
      try { client.send({ type: 'voice-backends', ...data }); } catch {}
    }
    const sttLabel = data.stt.backend || data.stt.model || 'none';
    const sttType = data.stt.type || 'batch';
    console.log(`  Voice STT: ${sttLabel} (${sttType})`);
    console.log(`  Voice TTS: ${data.tts.backend || 'none'}`);
    console.log(`  Voice Mode: ${data.mode || 'always-on'}`);
  });

  // ─── New conversational events ─────────────────────────────────────

  voiceSystem.on('partial-transcript', (data) => {
    for (const client of clients) {
      try { client.send({ type: 'voice-partial', text: data.text }); } catch {}
    }
  });

  voiceSystem.on('dismissal', (data) => {
    for (const client of clients) {
      try { client.send({ type: 'voice-dismissal', text: data.text, response: data.response }); } catch {}
    }
    console.log(`  Voice: Dismissed ("${data.text}")`);
  });

  voiceSystem.on('backchannel', (data) => {
    for (const client of clients) {
      try { client.send({ type: 'voice-backchannel', text: data.text }); } catch {}
    }
  });

  voiceSystem.on('filler', (data) => {
    for (const client of clients) {
      try { client.send({ type: 'voice-filler', text: data.text }); } catch {}
    }
  });

  return voiceSystem;
}

// ─── Default Claude Budget ────────────────────────────────────────────────

const claudeBudget = costs.checkBudget('claude');
if (!claudeBudget.dailyBudget) {
  costs.setBudget('claude', 5, 50); // $5/day, $50/month default
}

// Init vector memory (uses OpenAI embeddings) then start server
(async () => {
  if (OPENAI_KEY) {
    await vectorMemory.init(OPENAI_KEY);
  } else {
    console.log('  Vector Memory: DISABLED (no OPENAI_API_KEY for embeddings)');
  }

  // Auto-initialize project states for all known projects
  const startupProjects = loadProjects();
  for (const p of startupProjects) {
    if (p.directory) projectState.initProjectState(p.id, p.name, p.directory);
  }

  // Initialize voice system
  try {
    initVoiceSystem();
    console.log('  Voice System: Initialized');
  } catch (err) {
    console.log(`  Voice System: FAILED — ${err.message}`);
  }

  server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║         VANCE — Online                ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
  const brainFiles = brain.getBrainFiles();
  const brainLoaded = Object.values(brainFiles).filter(f => f.exists).length;
  const budget = costs.checkBudget('claude');
  const smartMem = brain.getSmartMemory();
  const dailyNotes = memory.listDailyNotes(5);
  const vecStats = vectorMemory.getStats();
  console.log(`  Model Tiers: Haiku (text chat) → Sonnet 4.6 (reasoning + voice) → Claude Code (projects)`);
  console.log(`  Anthropic Key: ${ANTHROPIC_KEY ? 'Set' : 'MISSING — set ANTHROPIC_API_KEY'}`);
  console.log(`  Brain: ${brainLoaded}/${Object.keys(brainFiles).length} files loaded`);
  console.log(`  Memory: MEMORY.md ${smartMem.memoryMd ? '✓' : '—'} | projects.md ${smartMem.projectsMd ? '✓' : '—'} | ${dailyNotes.length} daily notes`);
  console.log(`  Vector Memory: ${vecStats.totalEntries} entries (${vecStats.backend || 'pgvector'})`);
  console.log(`  Projects: ${loadProjects().length}`);
  console.log(`  Memories: ${memory.getMemoryStats().total}`);
  console.log(`  Skills: ${memory.loadSkills().length}`);
  console.log(`  Claude Budget: $${budget.dailyBudget}/day, $${budget.monthlyBudget}/month`);
  console.log(`  Tasks: ${taskManager.getAllTasks({ status: 'queued' }).length} queued, ${taskManager.getRunningTask() ? 1 : 0} running`);
  console.log(`  Execution: ${toolRouter.listTools().length} tools, ${Object.keys(AGENTS).length} agents`);
  const stateCount = Object.keys(projectState.getAllStates()).length;
  console.log(`  Project States: ${stateCount} tracked`);
  const voiceInfo = voiceSystem ? voiceSystem.getStatus() : null;
  const voiceMode = voiceInfo?.mode || '—';
  const sttInfo = voiceInfo?.stt?.backend || voiceInfo?.stt?.model || '—';
  const sttType = voiceInfo?.stt?.type || 'batch';
  console.log(`  Voice: ${voiceInfo ? 'Ready' : 'Not available'} (${voiceMode} | Brain: Sonnet 4.6 | STT: ${sttInfo} [${sttType}] | TTS: ${voiceInfo?.tts?.backend || '—'})\n`);
  });
})();
