/**
 * VANCE — Enhanced Claude Code Runner
 *
 * Spawns Claude Code with full flag support:
 * - Model selection (haiku/sonnet/opus)
 * - Budget caps
 * - Git branch isolation
 * - Stream-json output parsing
 * - Milestone detection
 * - Resume support
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const costs = require('./costs');

// ─── Model Selection ──────────────────────────────────────────────────────

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

/**
 * Auto-select model based on task complexity keywords.
 * Returns { model, tier, maxBudget }.
 */
function selectModel(task) {
  const lower = (task.prompt || task.title || '').toLowerCase();

  // Check opus first (most specific)
  for (const kw of MODEL_TIERS.opus.keywords) {
    if (lower.includes(kw)) return { tier: 'opus', model: MODEL_TIERS.opus.model, maxBudget: MODEL_TIERS.opus.defaultBudget };
  }
  // Check haiku (simplest)
  for (const kw of MODEL_TIERS.haiku.keywords) {
    if (lower.includes(kw)) return { tier: 'haiku', model: MODEL_TIERS.haiku.model, maxBudget: MODEL_TIERS.haiku.defaultBudget };
  }
  // Default to sonnet
  return { tier: 'sonnet', model: MODEL_TIERS.sonnet.model, maxBudget: MODEL_TIERS.sonnet.defaultBudget };
}

// ─── Milestone Detection ──────────────────────────────────────────────────

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

// ─── Tool Allowlist ───────────────────────────────────────────────────────

const ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit',
  'Bash(git status)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git diff *)',
  'Bash(git log *)', 'Bash(git branch *)', 'Bash(git checkout *)', 'Bash(git stash *)',
  'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(bun *)',
  'Bash(ls *)', 'Bash(mkdir *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)',
  'Bash(python *)', 'Bash(pip *)',
  'Bash(tsc *)', 'Bash(eslint *)', 'Bash(prettier *)',
  'Bash(jest *)', 'Bash(vitest *)', 'Bash(mocha *)',
].join(',');

// ─── Git Branch Isolation ─────────────────────────────────────────────────

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * Prepare git branch for task. Creates vance/{slug} branch.
 * Returns { branch, stashed } or null if not a git repo.
 */
function prepareGitBranch(task) {
  const cwd = task.projectDir;
  if (!cwd) return null;

  try {
    // Check if git repo
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe' });
  } catch {
    return null; // Not a git repo
  }

  const slug = slugify(task.title);
  const branch = `vance/${slug}`;
  let stashed = false;

  try {
    // Stash uncommitted changes
    const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
    if (status) {
      execSync('git stash push -m "vance-auto-stash"', { cwd, stdio: 'pipe' });
      stashed = true;
    }

    // Get default branch
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

    // Checkout default branch and pull
    execSync(`git checkout ${defaultBranch}`, { cwd, stdio: 'pipe' });
    try {
      execSync('git pull --ff-only', { cwd, stdio: 'pipe', timeout: 15000 });
    } catch {} // Pull may fail if no remote

    // Create task branch
    try {
      execSync(`git branch -D ${branch}`, { cwd, stdio: 'pipe' });
    } catch {} // Branch may not exist
    execSync(`git checkout -b ${branch}`, { cwd, stdio: 'pipe' });

    return { branch, stashed };
  } catch (err) {
    // Restore stash if we failed
    if (stashed) {
      try { execSync('git stash pop', { cwd, stdio: 'pipe' }); } catch {}
    }
    console.error(`Git branch prep failed: ${err.message}`);
    return null;
  }
}

/**
 * Post-task git cleanup. Commits remaining changes, returns to default branch.
 */
function postTaskGit(task) {
  const cwd = task.projectDir;
  if (!cwd || !task.branch) return;

  try {
    // Commit any remaining changes on the task branch
    const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
    if (status) {
      execSync('git add -A', { cwd, stdio: 'pipe' });
      execSync(`git commit -m "vance: final changes for ${task.title}"`, { cwd, stdio: 'pipe' });
    }

    // Return to default branch
    let defaultBranch = 'main';
    try {
      defaultBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', { cwd, encoding: 'utf8' }).trim().replace('origin/', '');
    } catch {}

    execSync(`git checkout ${defaultBranch}`, { cwd, stdio: 'pipe' });

    // Pop stash if we stashed
    if (task.stashed) {
      try { execSync('git stash pop', { cwd, stdio: 'pipe' }); } catch {}
    }
  } catch (err) {
    console.error(`Post-task git cleanup failed: ${err.message}`);
  }
}

// ─── Build CLI Args ───────────────────────────────────────────────────────

function buildArgs(task) {
  const args = ['-p', task.prompt];

  // Model
  if (task.model) {
    args.push('--model', task.model);
  }

  // Budget
  if (task.maxBudget) {
    args.push('--max-budget-usd', String(task.maxBudget));
  }

  // Effort
  if (task.effort) {
    args.push('--effort', task.effort);
  }

  // Permission mode — bypass for autonomous execution
  args.push('--permission-mode', 'bypassPermissions');

  // Tool allowlist
  args.push('--allowedTools', ALLOWED_TOOLS);

  // Output format
  args.push('--output-format', 'stream-json');

  // Resume support
  if (task.sessionId) {
    args.push('--resume', task.sessionId);
  }

  // Append system prompt with task context
  const systemAppend = [
    `TASK: "${task.title}"`,
    task.projectDir ? `PROJECT DIR: ${task.projectDir}` : '',
    task.branch ? `BRANCH: ${task.branch} — do NOT switch branches` : '',
    task.maxBudget ? `BUDGET LIMIT: $${task.maxBudget} — stay under this` : '',
    'RULES: Commit frequently. Do NOT push. Do NOT switch branches. Do NOT delete files unless replacing them.',
  ].filter(Boolean).join('\n');

  args.push('--append-system-prompt', systemAppend);

  return args;
}

// ─── Run Claude Process ───────────────────────────────────────────────────

/**
 * Spawn Claude Code process with full stream-json parsing.
 *
 * @param {Object} task - Task object with prompt, model, maxBudget, etc.
 * @param {Object} callbacks - { onStream, onToolUse, onMilestone, onActivity, onComplete, onFail }
 * @returns {ChildProcess} The spawned process (for PID tracking)
 */
function run(task, callbacks = {}) {
  const args = buildArgs(task);
  const cwd = task.projectDir || process.env.HOME;

  const proc = spawn('claude', args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let output = '';
  let costUsd = 0;
  let sessionId = null;
  let lastActivity = Date.now();

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

              // Check for milestones in output
              const milestones = detectMilestones(block.text);
              for (const ms of milestones) {
                if (callbacks.onMilestone) callbacks.onMilestone(ms);
              }
            } else if (block.type === 'tool_use') {
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
    // Log cost
    if (costUsd) {
      costs.logCall('claude', task.model || 'claude-sonnet-4-6', { cost: costUsd });
    }

    if (code === 0) {
      if (callbacks.onComplete) {
        callbacks.onComplete({
          output: output || 'Task completed successfully.',
          costUsd,
          sessionId,
        });
      }
    } else {
      if (callbacks.onFail) {
        callbacks.onFail({
          error: stderr.slice(0, 1000) || `Exit code ${code}`,
          costUsd,
          sessionId,
        });
      }
    }
  });

  proc.on('error', (err) => {
    if (callbacks.onFail) {
      callbacks.onFail({ error: `Failed to spawn Claude: ${err.message}`, costUsd: 0 });
    }
  });

  // Attach lastActivity getter for watchdog
  proc._getLastActivity = () => lastActivity;

  return proc;
}

module.exports = {
  selectModel,
  detectMilestones,
  prepareGitBranch,
  postTaskGit,
  buildArgs,
  run,
  MODEL_TIERS,
  ALLOWED_TOOLS,
};
