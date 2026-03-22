/**
 * VANCE — Unified Coding Executor (Agent SDK)
 *
 * Replaces child_process.spawn with @anthropic-ai/claude-agent-sdk query().
 * Same external API so claude-session.js and task-manager.js don't change.
 *
 * Exports:
 *   - spawnClaude(opts) — SDK query with stream-json-compatible return shape
 *   - runInteractive(opts) — persistent session prompts
 *   - runBackground(task, callbacks) — background task execution
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getSDK } = require('./sdk');
const costs = require('./costs');

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Expand ~ to actual home directory */
function expandHome(dir) {
  if (!dir) return dir;
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2));
  if (dir === '~') return os.homedir();
  return dir;
}

/** Find the absolute path to the claude binary (kept for fallback) */
let _claudeBin = null;
function getClaudeBin() {
  if (_claudeBin) return _claudeBin;
  const { execSync } = require('child_process');
  const candidates = [
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.npm-global/bin/claude'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { _claudeBin = c; return c; }
  }
  try {
    _claudeBin = execSync('which claude', { encoding: 'utf8' }).trim();
    return _claudeBin;
  } catch {}
  _claudeBin = 'claude';
  return _claudeBin;
}

// ─── Milestone Detection ─────────────────────────────────────────────────

const MILESTONE_PATTERNS = [
  { pattern: /(\d+)\s+(?:tests?\s+)?pass(?:ing|ed)/i, type: 'tests-passing', extract: (m) => `${m[1]} tests passing` },
  { pattern: /build\s+(?:succeeded|successful|complete)/i, type: 'build-success', extract: () => 'Build successful' },
  { pattern: /(?:created?|wrote|written)\s+(?:file\s+)?[`"']?([^\s`"']+\.\w{1,5})[`"']?/i, type: 'file-created', extract: (m) => `Created ${m[1]}` },
  { pattern: /committed|git commit/i, type: 'git-commit', extract: () => 'Changes committed' },
  { pattern: /0 (?:errors?|failures?|failed)/i, type: 'zero-errors', extract: () => 'Zero errors' },
  { pattern: /phase\s+\d+\s+(?:complete|done|finished)/i, type: 'phase-complete', extract: (m) => m[0] },
  { pattern: /(?:npm|yarn|pnpm)\s+install|dependencies?\s+installed/i, type: 'deps-installed', extract: () => 'Dependencies installed' },
  { pattern: /server\s+(?:running|started|listening)\s+(?:on|at)\s+(?:port\s+)?(\d+)/i, type: 'server-running', extract: (m) => `Server running on port ${m[1]}` },
  { pattern: /all\s+tests?\s+pass/i, type: 'all-tests-pass', extract: () => 'All tests passing' },
];

function detectMilestones(text) {
  const milestones = [];
  for (const { pattern, type, extract } of MILESTONE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      milestones.push({ type, detail: extract(match), timestamp: new Date().toISOString() });
    }
  }
  return milestones;
}

// ─── Clean Environment ───────────────────────────────────────────────────

function buildCleanEnv() {
  const cleanEnv = { ...process.env, FORCE_COLOR: '0' };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_SSE_PORT;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
  if (cleanEnv.PATH && !cleanEnv.PATH.includes('/usr/local/bin')) {
    cleanEnv.PATH = '/usr/local/bin:' + cleanEnv.PATH;
  }
  return cleanEnv;
}

// ─── Unified Tool Allowlist ──────────────────────────────────────────────

const FULL_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit',
  'Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(bun:*)',
  'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)',
  'Bash(rm:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(find:*)', 'Bash(wc:*)',
  'Bash(python:*)', 'Bash(pip:*)', 'Bash(python3:*)',
  'Bash(tsc:*)', 'Bash(eslint:*)', 'Bash(prettier:*)',
  'Bash(jest:*)', 'Bash(vitest:*)', 'Bash(mocha:*)',
  'Bash(curl:*)', 'Bash(wget:*)',
  'Bash(docker:*)', 'Bash(docker-compose:*)',
  'Bash(cargo:*)', 'Bash(go:*)', 'Bash(make:*)',
  'Bash(brew:*)', 'Bash(which:*)', 'Bash(echo:*)', 'Bash(env:*)',
  'Bash(cd:*)', 'Bash(pwd:*)', 'Bash(chmod:*)',
  'Bash(sed:*)', 'Bash(awk:*)', 'Bash(sort:*)', 'Bash(uniq:*)',
  'Bash(tar:*)', 'Bash(zip:*)', 'Bash(unzip:*)',
  'Bash(ps:*)', 'Bash(kill:*)', 'Bash(lsof:*)',
  'Bash(open:*)', 'Bash(osascript:*)', 'Bash(gh:*)',
  'Bash(grep:*)', 'Bash(touch:*)',
];

// Keep legacy comma-separated strings for backward compat (child_process fallback)
const INTERACTIVE_TOOLS = FULL_TOOLS.join(',');
const BACKGROUND_TOOLS = FULL_TOOLS.join(',');

// ─── SDK-Based Spawn ─────────────────────────────────────────────────────

/**
 * Spawn Claude Code via Agent SDK query().
 * Returns same shape as old spawnClaude: { process: handle, result: Promise }
 *
 * The `process` handle has:
 *   - interrupt() for cancellation (replaces proc.kill('SIGTERM'))
 *   - _getLastActivity() for watchdog
 *
 * Falls back to child_process.spawn if SDK import fails.
 */
async function spawnClaude(opts) {
  const { cwd, costCategory, model, callbacks = {} } = opts;
  const resolvedCwd = expandHome(cwd) || process.env.HOME;

  if (!fs.existsSync(resolvedCwd)) {
    try { fs.mkdirSync(resolvedCwd, { recursive: true }); } catch {}
  }

  let sdk;
  try {
    sdk = await getSDK();
  } catch (err) {
    console.error('[coding] Agent SDK import failed, falling back to CLI spawn:', err.message);
    return spawnClaudeFallback(opts);
  }

  const { query } = sdk;

  let output = '';
  let costUsd = 0;
  let sessionId = opts.sessionId || null;
  let toolCalls = [];
  let lastActivity = Date.now();
  let interrupted = false;

  // Build SDK query options
  const queryOpts = {
    model: model || 'claude-sonnet-4-6',
    cwd: resolvedCwd,
    permissionMode: 'bypassPermissions',
    allowedTools: FULL_TOOLS,
    systemPrompt: opts.systemPrompt || undefined,
  };

  if (opts.maxBudget) queryOpts.maxTurns = Math.ceil(opts.maxBudget * 20); // rough: $0.05/turn avg
  if (opts.effort) queryOpts.effort = opts.effort;
  if (opts.resume) queryOpts.resume = opts.resume;

  // MCP servers — Playwright for browser control
  queryOpts.mcpServers = {
    playwright: {
      command: 'npx',
      args: ['@playwright/mcp@latest'],
    },
  };

  // System prompt handling
  if (opts.appendSystemPrompt) {
    queryOpts.systemPrompt = opts.appendSystemPrompt;
  }

  // Create a handle that mimics a child process for cancel/watchdog
  const handle = {
    pid: process.pid, // placeholder
    _getLastActivity: () => lastActivity,
    _interrupted: false,
    interrupt() {
      this._interrupted = true;
      interrupted = true;
    },
    // Compat: kill just calls interrupt
    kill(signal) {
      this.interrupt();
    },
  };

  const result = (async () => {
    try {
      const conversation = await query({
        prompt: opts.prompt || opts.message,
        options: queryOpts,
      });

      // Iterate async generator
      for await (const message of conversation) {
        if (interrupted) break;
        lastActivity = Date.now();
        if (callbacks.onActivity) callbacks.onActivity(lastActivity);

        // Process SDK messages
        if (message.type === 'assistant') {
          for (const block of (message.content || [])) {
            if (block.type === 'text') {
              output += block.text;
              if (callbacks.onStream) callbacks.onStream(block.text);
              const milestones = detectMilestones(block.text);
              for (const ms of milestones) {
                if (callbacks.onMilestone) callbacks.onMilestone(ms);
              }
            } else if (block.type === 'tool_use') {
              toolCalls.push({ name: block.name, input: block.input });
              if (callbacks.onToolUse) callbacks.onToolUse(block.name, block.input);
            } else if (block.type === 'tool_result') {
              // Check tool results for milestone text
              const resultText = typeof block.content === 'string' ? block.content :
                Array.isArray(block.content) ? block.content.map(c => c.text || '').join('') : '';
              if (resultText) {
                const milestones = detectMilestones(resultText);
                for (const ms of milestones) {
                  if (callbacks.onMilestone) callbacks.onMilestone(ms);
                }
              }
            }
          }
        } else if (message.type === 'result') {
          costUsd = message.total_cost_usd || message.cost_usd || 0;
          sessionId = message.session_id || sessionId;
        }
      }

      // Log cost
      if (costUsd && costCategory) {
        costs.logCall(costCategory, model || 'claude-sonnet-4-6', { cost: costUsd });
      }

      const resultObj = {
        output: output || 'Done.',
        costUsd,
        sessionId,
        toolCalls,
        exitCode: interrupted ? 1 : 0,
      };

      if (callbacks.onComplete && !interrupted) callbacks.onComplete(resultObj);
      return resultObj;
    } catch (err) {
      const error = `SDK query error: ${err.message}`;
      if (callbacks.onError) callbacks.onError(error);

      // Log any partial cost
      if (costUsd && costCategory) {
        costs.logCall(costCategory, model || 'claude-sonnet-4-6', { cost: costUsd });
      }

      return { output: output || '', costUsd, error, sessionId, toolCalls, exitCode: 1 };
    }
  })();

  return { process: handle, result };
}

// ─── Fallback: CLI Spawn (if SDK unavailable) ────────────────────────────

function spawnClaudeFallback(opts) {
  const { spawn } = require('child_process');
  const { args, cwd, costCategory, model, callbacks = {} } = opts;
  const claudeBin = getClaudeBin();
  const resolvedCwd = expandHome(cwd) || process.env.HOME;

  if (!fs.existsSync(resolvedCwd)) {
    try { fs.mkdirSync(resolvedCwd, { recursive: true }); } catch {}
  }

  const proc = spawn(claudeBin, args || [], {
    cwd: resolvedCwd,
    env: buildCleanEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdin.end();

  let output = '';
  let costUsd = 0;
  let sessionId = null;
  let toolCalls = [];
  let lastActivity = Date.now();

  const result = new Promise((resolve) => {
    proc.stdout.on('data', (data) => {
      lastActivity = Date.now();
      if (callbacks.onActivity) callbacks.onActivity(lastActivity);

      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text') {
                output += block.text;
                if (callbacks.onStream) callbacks.onStream(block.text);
                const milestones = detectMilestones(block.text);
                for (const ms of milestones) {
                  if (callbacks.onMilestone) callbacks.onMilestone(ms);
                }
              } else if (block.type === 'tool_use') {
                toolCalls.push({ name: block.name, input: block.input });
                if (callbacks.onToolUse) callbacks.onToolUse(block.name, block.input);
              }
            }
          } else if (parsed.type === 'result') {
            costUsd = parsed.cost_usd || 0;
            sessionId = parsed.session_id || null;
          }
        } catch {}
      }
    });

    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      lastActivity = Date.now();
      if (callbacks.onActivity) callbacks.onActivity(lastActivity);
    });

    proc.on('close', (code) => {
      if (costUsd && costCategory) {
        costs.logCall(costCategory, model || 'claude-sonnet-4-6', { cost: costUsd });
      }
      const resultObj = { output: output || 'Done.', costUsd, sessionId, toolCalls, exitCode: code };
      if (code !== 0) {
        resultObj.error = stderr.slice(0, 1000) || `Exit code ${code}`;
        if (callbacks.onError) callbacks.onError(resultObj.error);
      } else {
        if (callbacks.onComplete) callbacks.onComplete(resultObj);
      }
      resolve(resultObj);
    });

    proc.on('error', (err) => {
      const error = `Failed to spawn Claude: ${err.message}`;
      if (callbacks.onError) callbacks.onError(error);
      resolve({ output: '', costUsd: 0, error, toolCalls: [], exitCode: -1 });
    });
  });

  proc._getLastActivity = () => lastActivity;
  return { process: proc, result };
}

// ─── Model Selection ─────────────────────────────────────────────────────

const MODEL_TIERS = {
  haiku: {
    model: 'claude-haiku-4-5',
    defaultBudget: 0.50,
    keywords: ['typo', 'rename', 'format', 'version bump', 'simple fix', 'lint', 'spelling', 'indent'],
  },
  sonnet: {
    model: 'claude-sonnet-4-6',
    defaultBudget: 3.00,
    keywords: ['feature', 'component', 'test', 'refactor', 'style', 'route', 'endpoint', 'crud', 'form', 'page'],
  },
  opus: {
    model: 'claude-opus-4-6',
    defaultBudget: 8.00,
    keywords: ['architecture', 'full-stack', 'migration', 'rewrite', 'redesign', 'database', 'auth system', 'deploy'],
  },
};

function selectModel(task) {
  const lower = (task.prompt || task.title || '').toLowerCase();
  for (const kw of MODEL_TIERS.opus.keywords) {
    if (lower.includes(kw)) return { tier: 'opus', model: MODEL_TIERS.opus.model, maxBudget: MODEL_TIERS.opus.defaultBudget };
  }
  for (const kw of MODEL_TIERS.haiku.keywords) {
    if (lower.includes(kw)) return { tier: 'haiku', model: MODEL_TIERS.haiku.model, maxBudget: MODEL_TIERS.haiku.defaultBudget };
  }
  return { tier: 'sonnet', model: MODEL_TIERS.sonnet.model, maxBudget: MODEL_TIERS.sonnet.defaultBudget };
}

// ─── Git Isolation ───────────────────────────────────────────────────────

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function prepareGitBranch(task) {
  const { execSync } = require('child_process');
  const cwd = expandHome(task.projectDir);
  if (!cwd) return null;

  const vanceDir = path.resolve(__dirname);
  const vanceRoot = path.resolve(__dirname, '../..');
  if (path.resolve(cwd) === vanceDir || path.resolve(cwd) === vanceRoot) {
    return null;
  }

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe' });
  } catch {
    return null;
  }

  const slug = slugify(task.title);
  const branch = `vance/${slug}`;
  let stashed = false;

  try {
    const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
    if (status) {
      execSync('git stash push -m "vance-auto-stash"', { cwd, stdio: 'pipe' });
      stashed = true;
    }

    let defaultBranch = 'main';
    try {
      defaultBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', { cwd, encoding: 'utf8' }).trim().replace('origin/', '');
    } catch {
      try {
        execSync('git rev-parse --verify main', { cwd, stdio: 'pipe' });
        defaultBranch = 'main';
      } catch {
        defaultBranch = 'master';
      }
    }

    execSync(`git checkout ${defaultBranch}`, { cwd, stdio: 'pipe' });
    try { execSync('git pull --ff-only', { cwd, stdio: 'pipe', timeout: 15000 }); } catch {}
    try { execSync(`git branch -D ${branch}`, { cwd, stdio: 'pipe' }); } catch {}
    execSync(`git checkout -b ${branch}`, { cwd, stdio: 'pipe' });

    return { branch, stashed };
  } catch (err) {
    if (stashed) {
      try { execSync('git stash pop', { cwd, stdio: 'pipe' }); } catch {}
    }
    console.error(`Git branch prep failed: ${err.message}`);
    return null;
  }
}

function postTaskGit(task) {
  const { execSync } = require('child_process');
  const cwd = expandHome(task.projectDir);
  if (!cwd || !task.branch) return;

  try {
    const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
    if (status) {
      execSync('git add -A', { cwd, stdio: 'pipe' });
      execSync(`git commit -m "vance: final changes for ${task.title}"`, { cwd, stdio: 'pipe' });
    }

    let defaultBranch = 'main';
    try {
      defaultBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', { cwd, encoding: 'utf8' }).trim().replace('origin/', '');
    } catch {}

    execSync(`git checkout ${defaultBranch}`, { cwd, stdio: 'pipe' });
    if (task.stashed) {
      try { execSync('git stash pop', { cwd, stdio: 'pipe' }); } catch {}
    }
  } catch (err) {
    console.error(`Post-task git cleanup failed: ${err.message}`);
  }
}

// ─── High-Level APIs ─────────────────────────────────────────────────────

/**
 * Run an interactive Claude Code prompt in a persistent session.
 * Now uses SDK query() instead of CLI spawn.
 */
function runInteractive(opts) {
  const systemAppend = [
    'You are operating as Claude Code, controlled by Vance (a JARVIS-like AI).',
    `Project: ${opts.projectId || 'general'}`,
    opts.cwd ? `Working directory: ${opts.cwd}` : '',
    'Work autonomously. Commit frequently. Do NOT push unless told to.',
    'Be thorough — read files before editing, run tests after changes.',
  ].filter(Boolean).join('\n');

  return spawnClaude({
    prompt: opts.message,
    message: opts.message,
    cwd: opts.cwd,
    costCategory: 'claude-session',
    model: opts.model || 'claude-sonnet-4-6',
    maxBudget: opts.maxBudget,
    effort: opts.effort,
    resume: opts.claudeSessionId,
    sessionId: opts.claudeSessionId,
    appendSystemPrompt: systemAppend,
    callbacks: opts.callbacks || {},
    // Fallback CLI args (for spawnClaudeFallback)
    args: buildInteractiveArgs(opts, systemAppend),
  });
}

function buildInteractiveArgs(opts, systemAppend) {
  const args = ['-p', opts.message];
  args.push('--model', opts.model || 'claude-sonnet-4-6');
  if (opts.maxBudget) args.push('--max-budget-usd', String(opts.maxBudget));
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.claudeSessionId) args.push('--resume', opts.claudeSessionId);
  args.push('--permission-mode', 'bypassPermissions');
  args.push('--allowedTools', INTERACTIVE_TOOLS);
  args.push('--output-format', 'stream-json', '--verbose');
  args.push('--append-system-prompt', systemAppend);
  return args;
}

/**
 * Run a background Claude Code task.
 * Now uses SDK query() instead of CLI spawn.
 */
function runBackground(task, callbacks = {}) {
  const systemAppend = [
    `TASK: "${task.title}"`,
    task.projectDir ? `PROJECT DIR: ${task.projectDir}` : '',
    task.branch ? `BRANCH: ${task.branch} — do NOT switch branches` : '',
    task.maxBudget ? `BUDGET LIMIT: $${task.maxBudget} — stay under this` : '',
    'RULES: Commit frequently. Do NOT push. Do NOT switch branches. Do NOT delete files unless replacing them.',
  ].filter(Boolean).join('\n');

  return spawnClaude({
    prompt: task.prompt,
    message: task.prompt,
    cwd: task.projectDir,
    costCategory: 'claude',
    model: task.model || 'claude-sonnet-4-6',
    maxBudget: task.maxBudget,
    effort: task.effort,
    resume: task.sessionId,
    sessionId: task.sessionId,
    appendSystemPrompt: systemAppend,
    callbacks,
    // Fallback CLI args
    args: buildBackgroundArgs(task, systemAppend),
  });
}

function buildBackgroundArgs(task, systemAppend) {
  const args = ['-p', task.prompt];
  if (task.model) args.push('--model', task.model);
  if (task.maxBudget) args.push('--max-budget-usd', String(task.maxBudget));
  if (task.effort) args.push('--effort', task.effort);
  args.push('--permission-mode', 'bypassPermissions');
  args.push('--allowedTools', BACKGROUND_TOOLS);
  args.push('--output-format', 'stream-json', '--verbose');
  if (task.sessionId) args.push('--resume', task.sessionId);
  args.push('--append-system-prompt', systemAppend);
  return args;
}

module.exports = {
  // Core
  spawnClaude,
  runInteractive,
  runBackground,
  // Helpers
  expandHome,
  getClaudeBin,
  detectMilestones,
  buildCleanEnv,
  // Model selection
  selectModel,
  MODEL_TIERS,
  // Git isolation
  prepareGitBranch,
  postTaskGit,
  // Tool lists
  INTERACTIVE_TOOLS,
  BACKGROUND_TOOLS,
  FULL_TOOLS,
};
