/**
 * VANCE — Direct Task Dispatch
 *
 * Bypasses the conversation layer entirely. Direct API → Claude Code.
 * No Sonnet routing call, no clarification loops — straight to execution.
 *
 * Exports:
 *   - init(deps) — inject dependencies
 *   - dispatch(opts) — dispatch a single task
 *   - dispatchBatch(tasks) — queue multiple tasks
 */
const { execSync } = require('child_process');
const coding = require('./coding');

let deps = {};

/**
 * Initialize with dependencies from server.js
 */
function init(injected) {
  deps = injected;
}

/**
 * Dispatch a task directly to Claude Code.
 *
 * @param {Object} opts
 * @param {string} opts.projectId — Project ID from projects.json
 * @param {string} opts.task — Task description
 * @param {string} [opts.mode='background'] — 'interactive' or 'background'
 * @param {string} [opts.model] — Model override
 * @param {number} [opts.maxBudget] — Budget cap
 * @param {number} [opts.priority=5] — Priority 1-10
 * @returns {Object} { taskId, status, sessionId, branch, mode }
 */
async function dispatch(opts) {
  const { projectId, task, mode = 'background', model, maxBudget, priority } = opts;

  if (!task) return { error: 'No task description provided' };

  // 1. Resolve project
  const project = resolveProject(projectId);
  const projectDir = project ? coding.expandHome(project.directory) : process.env.HOME;

  // 2. Bootstrap CLAUDE.md if stale/missing
  if (project && deps.projectIntel) {
    try {
      if (deps.projectIntel.needsRefresh(projectDir)) {
        deps.projectIntel.bootstrapProject(projectId);
      }
    } catch (err) {
      console.log(`[dispatch] Bootstrap skipped: ${err.message}`);
    }
  }

  // 3. Build lean system context
  const systemContext = buildSystemContext(task, projectDir);

  // 4. Route by mode
  if (mode === 'interactive') {
    return dispatchInteractive(opts, project, projectDir, systemContext);
  }

  return dispatchBackground(opts, project, projectDir, systemContext);
}

/**
 * Dispatch as interactive session (immediate, streaming).
 */
async function dispatchInteractive(opts, project, projectDir, systemContext) {
  if (!deps.claudeSession) {
    return { error: 'Claude session manager not available' };
  }

  const projectId = opts.projectId || 'general';
  const session = deps.claudeSession.getOrCreate(projectId, projectDir);

  try {
    const result = await deps.claudeSession.prompt(session.id, `${systemContext}\n\n${opts.task}`, {
      model: opts.model,
      maxBudget: opts.maxBudget,
    });

    return {
      mode: 'interactive',
      status: 'completed',
      sessionId: result.sessionId,
      costUsd: result.costUsd,
      output: result.output?.slice(0, 500),
      toolCalls: result.toolCalls?.length || 0,
    };
  } catch (err) {
    return { mode: 'interactive', status: 'failed', error: err.message };
  }
}

/**
 * Dispatch as background task (queued, git-isolated).
 */
async function dispatchBackground(opts, project, projectDir, systemContext) {
  if (!deps.taskManager) {
    return { error: 'Task manager not available' };
  }

  const task = deps.taskManager.createTask({
    title: opts.task.slice(0, 80),
    prompt: `${systemContext}\n\n${opts.task}`,
    projectId: opts.projectId || null,
    projectDir,
    model: opts.model,
    maxBudget: opts.maxBudget,
    priority: opts.priority || 5,
    source: 'dispatch',
  });

  // Auto-start if possible
  deps.taskManager.startNext();

  return {
    mode: 'background',
    taskId: task.id,
    status: task.status,
    branch: task.branch,
    model: task.model,
    tier: task.tier,
    maxBudget: task.maxBudget,
  };
}

/**
 * Dispatch multiple tasks.
 */
async function dispatchBatch(tasks) {
  const results = [];
  for (const taskOpts of tasks) {
    const result = await dispatch(taskOpts);
    results.push(result);
  }
  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function resolveProject(projectId) {
  if (!projectId || !deps.loadProjects) return null;
  const projects = deps.loadProjects();
  return projects.find(p => p.id === projectId) || null;
}

function buildSystemContext(task, projectDir) {
  const lines = [`TASK: "${task}"`];

  // Recent git log
  if (projectDir) {
    try {
      const log = execSync('git log --oneline -5 2>/dev/null', {
        cwd: projectDir, encoding: 'utf8', timeout: 5000,
      }).trim();
      if (log) {
        lines.push('RECENT COMMITS:');
        for (const l of log.split('\n')) {
          lines.push(`  ${l}`);
        }
      }
    } catch {}
  }

  lines.push('RULES: Work autonomously. Commit frequently. Do NOT push. Do NOT ask questions — make decisions and proceed.');

  return lines.join('\n');
}

module.exports = {
  init,
  dispatch,
  dispatchBatch,
};
