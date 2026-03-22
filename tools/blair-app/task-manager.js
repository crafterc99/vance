/**
 * BLAIR — Task Manager
 *
 * Autonomous task queue with state machine, persistence, and watchdog.
 * One task runs at a time. Tasks are git-isolated on blair/* branches.
 *
 * States: queued → running → completed | failed | paused
 *         paused → queued (resume)
 *         any → cancelled
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const coding = require('./coding');
const costs = require('./costs');

const DATA_DIR = path.resolve(__dirname, '../../.blair-data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const LOGS_DIR = path.join(DATA_DIR, 'task-logs');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

// ─── Project Directory Resolution ─────────────────────────────────────────

const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

function resolveProjectDir(projectId) {
  if (!projectId) return null;
  try {
    if (!fs.existsSync(PROJECTS_FILE)) return null;
    const projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    const project = projects.find(p => p.id === projectId);
    return project?.directory || null;
  } catch { return null; }
}

// ─── In-Memory State ──────────────────────────────────────────────────────

let runningProcesses = {}; // projectId → child process (multi-project concurrency)
let watchdogInterval = null;
let broadcastFn = null; // Set by server.js to broadcast WS events
const MAX_CONCURRENT = 3; // Max tasks running in parallel

function setBroadcast(fn) {
  broadcastFn = fn;
}

function broadcast(event) {
  if (broadcastFn) broadcastFn(event);
}

// ─── Persistence ──────────────────────────────────────────────────────────

function loadTasks() {
  if (!fs.existsSync(TASKS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function appendLog(taskId, text) {
  const logFile = path.join(LOGS_DIR, `${taskId}.log`);
  fs.appendFileSync(logFile, text);
}

function readLog(taskId) {
  const logFile = path.join(LOGS_DIR, `${taskId}.log`);
  if (!fs.existsSync(logFile)) return '';
  return fs.readFileSync(logFile, 'utf8');
}

// ─── Task CRUD ────────────────────────────────────────────────────────────

/**
 * Create a new task and add it to the queue.
 *
 * @param {Object} opts
 * @param {string} opts.title - Human-readable task title
 * @param {string} opts.prompt - The full prompt to send to Claude
 * @param {string} [opts.projectId] - Blair project ID
 * @param {string} [opts.projectDir] - Working directory for the task
 * @param {string} [opts.model] - Override model (claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-6)
 * @param {string} [opts.effort] - Effort level (low, medium, high)
 * @param {number} [opts.maxBudget] - Max USD spend for this task
 * @param {number} [opts.priority] - Priority 1-10 (10 = highest, default 5)
 * @returns {Object} The created task
 */
function createTask(opts) {
  // Auto-select model if not specified
  let modelInfo;
  if (opts.model) {
    // Find tier from model name
    const tier = Object.entries(coding.MODEL_TIERS).find(([, v]) => v.model === opts.model);
    modelInfo = {
      tier: tier ? tier[0] : 'sonnet',
      model: opts.model,
      maxBudget: opts.maxBudget || (tier ? tier[1].defaultBudget : 3.00),
    };
  } else {
    modelInfo = coding.selectModel(opts);
    if (opts.maxBudget) modelInfo.maxBudget = opts.maxBudget;
  }

  // Auto-resolve project directory from known projects
  let projectDir = opts.projectDir || null;
  if (!projectDir && opts.projectId) {
    projectDir = resolveProjectDir(opts.projectId);
  }

  const task = {
    id: crypto.randomUUID().slice(0, 8),
    title: opts.title,
    prompt: opts.prompt,
    projectId: opts.projectId || null,
    projectDir,
    model: modelInfo.model,
    tier: modelInfo.tier,
    effort: opts.effort || null,
    maxBudget: modelInfo.maxBudget,
    priority: opts.priority || 5,
    status: 'queued',
    source: opts.source || 'manual', // manual | conversation | voice | auto
    sessionId: null,
    branch: null,
    stashed: false,
    pid: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    lastActivityAt: null,
    costUsd: 0,
    milestones: [],
    error: null,
    retryCount: 0,
  };

  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);

  broadcast({ type: 'task-queued', task: taskSummary(task) });
  return task;
}

function getTask(id) {
  return loadTasks().find(t => t.id === id) || null;
}

function getRunningTask() {
  return loadTasks().find(t => t.status === 'running') || null;
}

function getRunningTasks() {
  return loadTasks().filter(t => t.status === 'running');
}

function getAllTasks(filter = {}) {
  let tasks = loadTasks();
  if (filter.status) tasks = tasks.filter(t => t.status === filter.status);
  if (filter.projectId) tasks = tasks.filter(t => t.projectId === filter.projectId);
  return tasks;
}

function updateTask(id, updates) {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;
  Object.assign(tasks[idx], updates);
  saveTasks(tasks);
  return tasks[idx];
}

// ─── Task Lifecycle ───────────────────────────────────────────────────────

/**
 * Start the next queued task (highest priority first).
 * Returns the started task or null if nothing to start.
 */
function startNext() {
  const running = getRunningTasks();

  // Don't exceed max concurrency
  if (running.length >= MAX_CONCURRENT) return null;

  // Get projects that already have a running task
  const busyProjects = new Set(running.map(t => t.projectId).filter(Boolean));

  const tasks = loadTasks();
  const queued = tasks
    .filter(t => t.status === 'queued')
    // Skip projects that already have a running task (1 per project)
    .filter(t => !t.projectId || !busyProjects.has(t.projectId))
    .sort((a, b) => (b.priority || 5) - (a.priority || 5));

  if (!queued.length) return null;

  const task = queued[0];

  // Pre-flight budget check
  const budgetCheck = costs.checkBudget('claude');
  if (budgetCheck.dailyBudget && !budgetCheck.withinBudget) {
    broadcast({
      type: 'task-budget-blocked',
      taskId: task.id,
      message: `Budget exceeded — daily: $${budgetCheck.dailySpent}/$${budgetCheck.dailyBudget}, monthly: $${budgetCheck.monthlySpent}/$${budgetCheck.monthlyBudget}`,
    });
    return null;
  }

  return _startTask(task);
}

function _startTask(task) {
  console.log(`[TaskManager] Starting task ${task.id}: "${task.title}"`);
  console.log(`[TaskManager]   cwd: ${task.projectDir || 'HOME'}, model: ${task.model}`);

  // Git branch isolation
  let gitResult = null;
  try {
    gitResult = coding.prepareGitBranch(task);
  } catch (err) {
    console.error(`[TaskManager] Git branch prep failed for ${task.id}: ${err.message}`);
  }
  if (gitResult) {
    task.branch = gitResult.branch;
    task.stashed = gitResult.stashed;
    console.log(`[TaskManager]   branch: ${task.branch}`);
  }

  task.status = 'running';
  task.startedAt = new Date().toISOString();
  task.lastActivityAt = new Date().toISOString();
  updateTask(task.id, task);

  broadcast({ type: 'task-started', task: taskSummary(task) });

  // Spawn Claude via coding.js
  console.log(`[TaskManager] Spawning Claude Code for task ${task.id}...`);
  const { process: proc, result: spawnResult } = coding.runBackground(task, {
    onStream: (text) => {
      appendLog(task.id, text);
      broadcast({ type: 'task-stream', taskId: task.id, content: text });
    },

    onToolUse: (name, input) => {
      broadcast({ type: 'task-tool', taskId: task.id, tool: name });
    },

    onMilestone: (milestone) => {
      const tasks = loadTasks();
      const t = tasks.find(x => x.id === task.id);
      if (t) {
        // Avoid duplicate milestone types in quick succession
        const isDupe = t.milestones.some(m => m.type === milestone.type &&
          Date.now() - new Date(m.timestamp).getTime() < 30000);
        if (!isDupe) {
          t.milestones.push(milestone);
          saveTasks(tasks);
          broadcast({ type: 'task-milestone', taskId: task.id, milestone });
        }
      }
    },

    onActivity: (timestamp) => {
      updateTask(task.id, { lastActivityAt: new Date(timestamp).toISOString() });
    },

    onComplete: (result) => {
      console.log(`[TaskManager] Task ${task.id} completed. Cost: $${result.costUsd || 0}`);
      delete runningProcesses[task.projectId || task.id];

      // Post-task git cleanup
      const updatedTask = getTask(task.id);
      if (updatedTask) {
        coding.postTaskGit(updatedTask);
      }

      updateTask(task.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        costUsd: result.costUsd,
        sessionId: result.sessionId,
      });

      appendLog(task.id, '\n\n--- TASK COMPLETED ---\n');

      broadcast({
        type: 'task-completed',
        task: taskSummary(getTask(task.id)),
        costUsd: result.costUsd,
      });

      // Auto-start next
      _autoStartNext();
    },

    onError: (error) => {
      // Error callback fires during process — full result handling in spawnResult.then below
    },
  });

  const procKey = task.projectId || task.id;
  runningProcesses[procKey] = proc;
  updateTask(task.id, { pid: proc.pid });

  // Handle completion/failure via the result promise
  spawnResult.then((result) => {
    delete runningProcesses[task.projectId || task.id];

    if (result.exitCode === 0 && !result.error) {
      // Success
      console.log(`[TaskManager] Task ${task.id} completed. Cost: $${result.costUsd || 0}`);
      const updatedTask = getTask(task.id);
      if (updatedTask) coding.postTaskGit(updatedTask);

      updateTask(task.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        costUsd: result.costUsd,
        sessionId: result.sessionId,
      });

      appendLog(task.id, '\n\n--- TASK COMPLETED ---\n');
      broadcast({ type: 'task-completed', task: taskSummary(getTask(task.id)), costUsd: result.costUsd });
      _autoStartNext();
    } else {
      // Failure
      const errorMsg = result.error || `Exit code ${result.exitCode}`;
      console.error(`[TaskManager] Task ${task.id} FAILED: ${errorMsg}`);

      const currentTask = getTask(task.id);
      if (!currentTask) return;

      if (currentTask.retryCount < 1 && result.sessionId) {
        updateTask(task.id, {
          status: 'queued',
          sessionId: result.sessionId,
          retryCount: currentTask.retryCount + 1,
          costUsd: (currentTask.costUsd || 0) + (result.costUsd || 0),
          error: `Retry after: ${errorMsg}`,
        });
        broadcast({ type: 'task-retrying', taskId: task.id, error: errorMsg });
        startNext();
        return;
      }

      coding.postTaskGit(currentTask);
      updateTask(task.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        costUsd: (currentTask.costUsd || 0) + (result.costUsd || 0),
        sessionId: result.sessionId,
        error: errorMsg,
      });
      appendLog(task.id, `\n\n--- TASK FAILED ---\n${errorMsg}\n`);
      broadcast({ type: 'task-failed', task: taskSummary(getTask(task.id)), error: errorMsg });
      _autoStartNext();
    }
  });

  // Start watchdog
  _startWatchdog();

  return getTask(task.id);
}

function _autoStartNext() {
  setTimeout(() => startNext(), 1000);
}

// ─── Task Control ─────────────────────────────────────────────────────────

/**
 * Pause a running task. Kills the process, saves sessionId for resume.
 */
function pauseTask(id) {
  const task = getTask(id);
  if (!task || task.status !== 'running') return { error: 'Task not running' };

  const procKey = task.projectId || task.id;
  const proc = runningProcesses[procKey];
  if (proc) {
    try { if (proc.interrupt) proc.interrupt(); else proc.kill('SIGTERM'); } catch {}
    delete runningProcesses[procKey];
  }

  updateTask(id, {
    status: 'paused',
    pid: null,
  });

  appendLog(id, '\n\n--- TASK PAUSED ---\n');
  broadcast({ type: 'task-paused', taskId: id });
  return { success: true };
}

/**
 * Resume a paused or failed task. Re-queues with sessionId for --resume.
 */
function resumeTask(id) {
  const task = getTask(id);
  if (!task || (task.status !== 'paused' && task.status !== 'failed')) {
    return { error: 'Task not paused or failed' };
  }

  updateTask(id, { status: 'queued' });
  broadcast({ type: 'task-queued', task: taskSummary(getTask(id)) });

  // Auto-start if nothing running
  if (!getRunningTask()) {
    startNext();
  }

  return { success: true };
}

/**
 * Cancel a task. Kills process if running, marks cancelled.
 */
function cancelTask(id) {
  const task = getTask(id);
  if (!task) return { error: 'Task not found' };

  const procKey = task.projectId || task.id;
  if (task.status === 'running' && runningProcesses[procKey]) {
    const proc = runningProcesses[procKey];
    try { if (proc.interrupt) proc.interrupt(); else proc.kill('SIGTERM'); } catch {}
    delete runningProcesses[procKey];
    coding.postTaskGit(task);
  }

  updateTask(id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    pid: null,
  });

  appendLog(id, '\n\n--- TASK CANCELLED ---\n');
  broadcast({ type: 'task-cancelled', taskId: id });

  if (task.status === 'running') _autoStartNext();
  return { success: true };
}

// ─── Watchdog ─────────────────────────────────────────────────────────────

function _startWatchdog() {
  if (watchdogInterval) return; // Already running

  watchdogInterval = setInterval(() => {
    const running = getRunningTasks();
    if (!running.length) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
      return;
    }

    // Check each running task for hung state (no output for 5 minutes)
    for (const task of running) {
      const lastActivity = new Date(task.lastActivityAt).getTime();
      const elapsed = Date.now() - lastActivity;

      if (elapsed > 5 * 60 * 1000) {
        console.log(`[Watchdog] Task ${task.id} hung for ${Math.round(elapsed / 60000)}m — pausing`);
        pauseTask(task.id);
      }
    }
  }, 30000); // Check every 30 seconds
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function taskSummary(task) {
  if (!task) return null;
  const duration = task.startedAt
    ? Math.round((new Date(task.completedAt || Date.now()) - new Date(task.startedAt)) / 1000)
    : 0;

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    model: task.model,
    tier: task.tier,
    branch: task.branch,
    priority: task.priority,
    source: task.source || 'manual',
    costUsd: task.costUsd,
    maxBudget: task.maxBudget,
    durationSec: duration,
    durationFormatted: duration > 0 ? formatDuration(duration) : 'not started',
    milestones: task.milestones,
    milestonesCount: task.milestones.length,
    lastMilestone: task.milestones.length ? task.milestones[task.milestones.length - 1].detail : null,
    error: task.error,
    projectId: task.projectId,
    projectDir: task.projectDir,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    retryCount: task.retryCount,
  };
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

module.exports = {
  createTask,
  getTask,
  getRunningTask,
  getRunningTasks,
  getAllTasks,
  startNext,
  pauseTask,
  resumeTask,
  cancelTask,
  taskSummary,
  readLog,
  setBroadcast,
  MAX_CONCURRENT,
};
