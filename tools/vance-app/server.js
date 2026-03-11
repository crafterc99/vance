#!/usr/bin/env node
/**
 * VANCE — Personal AI Assistant Server
 *
 * GPT-powered brain with function calling for:
 * - Claude Code execution (coding tasks)
 * - Long-term memory (learn, recall, adapt)
 * - Skill creation and management
 * - Project management with milestones
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

const PORT = process.env.VANCE_PORT || 4000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || 'sk-placeholder-add-your-key';
const GPT_MODEL = process.env.VANCE_MODEL || 'gpt-4o';
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

// ─── GPT Function Definitions ────────────────────────────────────────────

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
          file: { type: 'string', enum: ['personality', 'userProfile', 'guidelines', 'selfImprovement'], description: 'Which brain file to update' },
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
];

// ─── GPT Streaming Call ──────────────────────────────────────────────────

/**
 * Stream GPT response. Yields events:
 *   { type: 'token', content: '...' }
 *   { type: 'tool_call_start', index, id, name }
 *   { type: 'tool_call_args', index, args: '...' }
 *   { type: 'done', usage: { ... } }
 */
async function* callGPTStream(messages) {
  const body = {
    model: GPT_MODEL,
    messages,
    tools: TOOLS,
    temperature: 0.7,
    max_tokens: 4096,
    stream: true,
    stream_options: { include_usage: true },
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GPT API error ${res.status}: ${err}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

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
      if (payload === '[DONE]') return;

      try {
        const chunk = JSON.parse(payload);

        // Usage comes in the final chunk
        if (chunk.usage) {
          costs.logCall('gpt', GPT_MODEL, {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          });
          yield { type: 'done', usage: chunk.usage };
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          yield { type: 'token', content: delta.content };
        }

        // Tool calls (streamed as deltas)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              yield { type: 'tool_call_start', index: tc.index, id: tc.id, name: tc.function?.name || '' };
            }
            if (tc.function?.arguments) {
              yield { type: 'tool_call_args', index: tc.index, args: tc.function.arguments };
            }
          }
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
    const topApps = run('ps aux --sort=-%cpu | head -11');
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

async function handleChat(userMessage, projectId, wsSend) {
  const convId = projectId || 'general';
  const convMessages = loadConversation(convId);

  // Add user message
  convMessages.push({ role: 'user', content: userMessage, timestamp: new Date().toISOString() });

  // Build system prompt from brain files + live context
  const projects = loadProjects();
  const project = projects.find(p => p.id === projectId);
  const relevantMemories = memory.searchMemories(userMessage, 5);
  const relevantSkills = memory.findSkillsForQuery(userMessage);
  const preferences = memory.getPreferences();
  const memStats = memory.getMemoryStats();
  const todayStats = costs.getStats('today');

  const projectContext = project ? {
    ...project,
    milestones: loadMilestones(projectId),
  } : null;

  // Gather task context for system prompt
  const runningTask = taskManager.getRunningTask();
  const queuedTasks = taskManager.getAllTasks({ status: 'queued' });

  const system = brain.buildSystemPrompt({
    project: projectContext,
    memories: relevantMemories,
    skills: relevantSkills,
    preferences,
    stats: {
      memoryCount: memStats.total,
      skillCount: memory.loadSkills().length,
      projectCount: projects.length,
    },
    costs: {
      todaySpend: todayStats.totalCost.toFixed(2),
      todayCalls: todayStats.totalCalls,
    },
    runningTask: runningTask ? taskManager.taskSummary(runningTask) : null,
    queuedTaskCount: queuedTasks.length,
  });

  // Build GPT message history (last 20 messages for context)
  const gptMessages = [{ role: 'system', content: system }];
  const recent = convMessages.slice(-20);
  for (const m of recent) {
    if (m.role === 'user' || m.role === 'assistant') {
      gptMessages.push({ role: m.role, content: m.content });
    }
  }

  wsSend({ type: 'thinking' });

  try {
    let fullText = '';
    let rounds = 0;

    while (rounds < 8) {
      rounds++;
      let text = '';
      const toolCalls = {}; // index -> { id, name, args }
      let hasToolCalls = false;

      // Stream GPT response
      for await (const event of callGPTStream(gptMessages)) {
        if (event.type === 'token') {
          text += event.content;
          wsSend({ type: 'stream-token', content: event.content });
        } else if (event.type === 'tool_call_start') {
          hasToolCalls = true;
          toolCalls[event.index] = { id: event.id, name: event.name, args: '' };
          wsSend({ type: 'function-call', name: event.name });
        } else if (event.type === 'tool_call_args') {
          if (toolCalls[event.index]) toolCalls[event.index].args += event.args;
        }
      }

      // If we got text only (no tool calls), we're done
      if (!hasToolCalls) {
        fullText = text;
        break;
      }

      // Build the assistant message with tool calls for the conversation
      const assistantMsg = { role: 'assistant', content: text || null, tool_calls: [] };
      for (const [, tc] of Object.entries(toolCalls)) {
        assistantMsg.tool_calls.push({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args },
        });
      }
      gptMessages.push(assistantMsg);

      // Execute each tool call
      for (const [, tc] of Object.entries(toolCalls)) {
        let args;
        try { args = JSON.parse(tc.args); } catch { args = {}; }
        wsSend({ type: 'status', text: `Running ${tc.name}...` });

        const result = await executeFunction(tc.name, args, wsSend);

        gptMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }

      // Signal that tool execution is done, next round will stream
      wsSend({ type: 'tool-done' });
    }

    // Signal stream complete
    wsSend({ type: 'stream-end' });

    // Save to conversation
    convMessages.push({ role: 'assistant', content: fullText, timestamp: new Date().toISOString() });
    saveConversation(convId, convMessages);

    // Auto-learn patterns
    memory.learnPattern(userMessage, project ? 'project-work' : 'general');

    return fullText;

  } catch (err) {
    const errMsg = `I ran into an issue: ${err.message}`;
    wsSend({ type: 'error', message: errMsg });
    convMessages.push({ role: 'assistant', content: errMsg, timestamp: new Date().toISOString() });
    saveConversation(convId, convMessages);
    return errMsg;
  }
}

// ─── WebSocket (using ws library) ────────────────────────────────────────

const clients = new Set();

async function handleMessage(ws, msg) {
  switch (msg.action) {
    case 'chat':
      await handleChat(msg.message, msg.projectId, (data) => ws.send(data));
      break;

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
    res.end(JSON.stringify({ status: 'online', uptime: process.uptime(), model: GPT_MODEL, hasKey: OPENAI_KEY !== 'sk-placeholder-add-your-key' }));
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
  ws.send({ type: 'connected', model: GPT_MODEL, hasKey: OPENAI_KEY !== 'sk-placeholder-add-your-key' });
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

// ─── Default Claude Budget ────────────────────────────────────────────────

const claudeBudget = costs.checkBudget('claude');
if (!claudeBudget.dailyBudget) {
  costs.setBudget('claude', 5, 50); // $5/day, $50/month default
}

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║         VANCE — Online                ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
  const brainFiles = brain.getBrainFiles();
  const brainLoaded = Object.values(brainFiles).filter(f => f.exists).length;
  const budget = costs.checkBudget('claude');
  console.log(`  Model: ${GPT_MODEL}`);
  console.log(`  API Key: ${OPENAI_KEY !== 'sk-placeholder-add-your-key' ? 'Set' : 'PLACEHOLDER — set OPENAI_API_KEY'}`);
  console.log(`  Brain: ${brainLoaded}/${Object.keys(brainFiles).length} files loaded`);
  console.log(`  Projects: ${loadProjects().length}`);
  console.log(`  Memories: ${memory.getMemoryStats().total}`);
  console.log(`  Skills: ${memory.loadSkills().length}`);
  console.log(`  Claude Budget: $${budget.dailyBudget}/day, $${budget.monthlyBudget}/month`);
  console.log(`  Tasks: ${taskManager.getAllTasks({ status: 'queued' }).length} queued, ${taskManager.getRunningTask() ? 1 : 0} running\n`);
});
