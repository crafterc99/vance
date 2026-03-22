/**
 * BLAIR — Task Intelligence System
 *
 * Analyzes every conversation message and proactively:
 *   - Extracts actionable tasks from natural speech
 *   - Classifies: user-task (user does it) vs blair-task (Blair does it) vs note
 *   - Assigns priority based on urgency cues
 *   - Auto-queues coding tasks for autonomous execution
 *   - Maintains a priority board connected to the spatial UI
 *
 * This makes Blair proactive — not waiting to be told "create a task",
 * but understanding intent from conversation and acting on it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(__dirname, '../../.blair-data');
const PRIORITIES_FILE = path.join(DATA_DIR, 'priorities.json');
const USER_TASKS_FILE = path.join(DATA_DIR, 'user-tasks.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Task Classification Patterns ──────────────────────────────────────

// Patterns that signal "do this FOR me" (Blair task)
const BLAIR_TASK_PATTERNS = [
  /\b(build|create|implement|add|make|set up|setup|write|code|develop|deploy|fix|update|upgrade|refactor|optimize|configure)\b/i,
  /\b(push|commit|merge|install|run|test|debug|integrate)\b.*\b(for|to|in|on)\b/i,
  /\bcan you\b/i,
  /\bgo (ahead and|do|build|make|implement|create)\b/i,
  /\bi (need|want) (you to|a|an|the)\b/i,
  /\b(start|begin|kick off|launch|spin up)\b.*\b(working|building|coding|developing|task|project)\b/i,
];

// Patterns that signal "I need to do this myself" (user task / reminder)
const USER_TASK_PATTERNS = [
  /\bi (need to|have to|gotta|should|must|ought to)\b/i,
  /\bremind me to\b/i,
  /\bdon'?t (let me )?forget (to|about)\b/i,
  /\bi('ll| will) (need to|have to)\b/i,
  /\bmy (task|todo|to-?do)\b/i,
  /\b(tomorrow|later|tonight|this week|next week) i (need|have|should|want)\b/i,
  /\bput (it |that )?on my (list|board|priorities)\b/i,
  /\badd (it |that )?to my (tasks|todos|to-?dos|list|priorities)\b/i,
];

// Priority signal words
const PRIORITY_SIGNALS = {
  critical: { score: 10, patterns: [/\b(critical|urgent|emergency|asap|right now|immediately|showstopper|blocking)\b/i] },
  high: { score: 8, patterns: [/\b(important|priority|first|soon|today|high priority|needs to be done)\b/i] },
  medium: { score: 5, patterns: [/\b(when you (can|get a chance)|at some point|would be nice|should)\b/i] },
  low: { score: 3, patterns: [/\b(whenever|no rush|low priority|eventually|nice to have|backlog)\b/i] },
};

// Project detection from context
const PROJECT_KEYWORDS = {
  'soul-jam': ['soul jam', 'souljam', 'basketball', 'phaser'],
  'athletes-blender': ['athletes blender', 'blender', 'smoothie', 'subscription box'],
  'sos-train': ['sos train', 'sostrain', 'fitness', 'coaching'],
  'blair': ['blair', 'yourself', 'your own', 'your code', 'the assistant', 'command center'],
};

class TaskIntelligence {
  constructor(config = {}) {
    this.taskManager = config.taskManager || null;
    this.memory = config.memory || null;
    this.broadcast = config.broadcast || (() => {});
    this._loadState();
  }

  _loadState() {
    try {
      this.priorities = fs.existsSync(PRIORITIES_FILE)
        ? JSON.parse(fs.readFileSync(PRIORITIES_FILE, 'utf8'))
        : [];
    } catch { this.priorities = []; }

    try {
      this.userTasks = fs.existsSync(USER_TASKS_FILE)
        ? JSON.parse(fs.readFileSync(USER_TASKS_FILE, 'utf8'))
        : [];
    } catch { this.userTasks = []; }
  }

  _savePriorities() {
    fs.writeFileSync(PRIORITIES_FILE, JSON.stringify(this.priorities, null, 2));
  }

  _saveUserTasks() {
    fs.writeFileSync(USER_TASKS_FILE, JSON.stringify(this.userTasks, null, 2));
  }

  /**
   * Analyze a user message and extract any actionable items.
   * Called on every chat message to proactively detect tasks.
   *
   * Returns: {
   *   hasAction: boolean,
   *   items: [{ type, title, priority, project, autoQueue }]
   * }
   */
  analyzeMessage(message, projectContext = null) {
    if (!message || message.length < 10) return { hasAction: false, items: [] };

    const items = [];

    // Check if this is a Blair task (user wants Blair to do something)
    const isBlairTask = BLAIR_TASK_PATTERNS.some(p => p.test(message));
    const isUserTask = USER_TASK_PATTERNS.some(p => p.test(message));

    // Detect priority
    const priority = this._detectPriority(message);

    // Detect project
    const project = this._detectProject(message, projectContext);

    if (isBlairTask && !isUserTask) {
      items.push({
        type: 'blair-task',
        title: this._extractTitle(message),
        description: message,
        priority,
        project,
        autoQueue: true,
        source: 'conversation',
      });
    } else if (isUserTask) {
      items.push({
        type: 'user-task',
        title: this._extractTitle(message),
        description: message,
        priority,
        project,
        autoQueue: false,
        source: 'conversation',
      });
    }

    return { hasAction: items.length > 0, items };
  }

  /**
   * Extract a concise title from a message
   */
  _extractTitle(message) {
    // Remove filler words and extract the core action
    let title = message
      .replace(/^(hey |hi |yo |okay |ok |so |can you |could you |please |i need you to |i want you to |go ahead and )/i, '')
      .replace(/\b(for me|for the|right now|as soon as|when you can)\b/gi, '')
      .trim();

    // Truncate to reasonable length
    if (title.length > 80) {
      title = title.slice(0, 77) + '...';
    }

    // Capitalize first letter
    return title.charAt(0).toUpperCase() + title.slice(1);
  }

  /**
   * Detect priority from message content
   */
  _detectPriority(message) {
    for (const [level, config] of Object.entries(PRIORITY_SIGNALS)) {
      for (const pattern of config.patterns) {
        if (pattern.test(message)) {
          return { level, score: config.score };
        }
      }
    }
    return { level: 'medium', score: 5 };
  }

  /**
   * Detect which project a message relates to
   */
  _detectProject(message, projectContext) {
    if (projectContext) return projectContext;

    const lower = message.toLowerCase();
    for (const [projectId, keywords] of Object.entries(PROJECT_KEYWORDS)) {
      for (const kw of keywords) {
        if (lower.includes(kw)) return projectId;
      }
    }
    return null;
  }

  // ─── User Task Management ──────────────────────────────────────────

  /**
   * Add a task for the user (reminder / personal todo)
   */
  addUserTask(title, opts = {}) {
    const task = {
      id: crypto.randomUUID().slice(0, 8),
      title,
      description: opts.description || '',
      priority: opts.priority || { level: 'medium', score: 5 },
      project: opts.project || null,
      status: 'pending', // pending | done | dismissed
      createdAt: new Date().toISOString(),
      dueAt: opts.dueAt || null,
      source: opts.source || 'manual',
    };

    this.userTasks.push(task);
    this._saveUserTasks();

    this.broadcast({
      type: 'user-task-created',
      task,
    });

    return task;
  }

  /**
   * Complete a user task
   */
  completeUserTask(taskId) {
    const task = this.userTasks.find(t => t.id === taskId);
    if (task) {
      task.status = 'done';
      task.completedAt = new Date().toISOString();
      this._saveUserTasks();
      this.broadcast({ type: 'user-task-completed', taskId });
    }
    return task;
  }

  /**
   * Dismiss a user task
   */
  dismissUserTask(taskId) {
    const task = this.userTasks.find(t => t.id === taskId);
    if (task) {
      task.status = 'dismissed';
      this._saveUserTasks();
      this.broadcast({ type: 'user-task-dismissed', taskId });
    }
    return task;
  }

  /**
   * Get all active user tasks
   */
  getUserTasks(filter = {}) {
    let tasks = this.userTasks.filter(t => t.status === 'pending');
    if (filter.project) tasks = tasks.filter(t => t.project === filter.project);
    return tasks.sort((a, b) => (b.priority?.score || 5) - (a.priority?.score || 5));
  }

  // ─── Priority Board ────────────────────────────────────────────────

  /**
   * Add an item to the priority board (top-level goals/objectives)
   */
  addPriority(title, opts = {}) {
    const priority = {
      id: crypto.randomUUID().slice(0, 8),
      title,
      description: opts.description || '',
      score: opts.score || 5,
      project: opts.project || null,
      status: 'active', // active | completed | archived
      linkedTasks: [],   // task IDs (both user and blair tasks)
      createdAt: new Date().toISOString(),
    };

    this.priorities.push(priority);
    this._savePriorities();

    this.broadcast({ type: 'priority-created', priority });
    return priority;
  }

  /**
   * Link a task to a priority
   */
  linkTaskToPriority(priorityId, taskId) {
    const priority = this.priorities.find(p => p.id === priorityId);
    if (priority && !priority.linkedTasks.includes(taskId)) {
      priority.linkedTasks.push(taskId);
      this._savePriorities();
    }
  }

  /**
   * Get active priorities sorted by score
   */
  getActivePriorities() {
    return this.priorities
      .filter(p => p.status === 'active')
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Complete a priority
   */
  completePriority(id) {
    const p = this.priorities.find(p => p.id === id);
    if (p) {
      p.status = 'completed';
      p.completedAt = new Date().toISOString();
      this._savePriorities();
      this.broadcast({ type: 'priority-completed', id });
    }
    return p;
  }

  // ─── Auto-Queue Integration ────────────────────────────────────────

  /**
   * Auto-queue a Blair coding task from conversation analysis.
   * Returns the created task or null if task manager unavailable.
   */
  autoQueueTask(item, projectDir = null) {
    if (!this.taskManager) return null;

    const task = this.taskManager.createTask({
      title: item.title,
      prompt: item.description,
      projectDir: projectDir,
      projectId: item.project,
      priority: item.priority?.score || 5,
    });

    // Try to start if nothing is running
    this.taskManager.startNext();

    return task;
  }

  // ─── Full Dashboard Data ───────────────────────────────────────────

  /**
   * Get complete task intelligence state for the spatial UI
   */
  getDashboard() {
    const blairTasks = this.taskManager ? {
      running: this.taskManager.getRunningTask()
        ? this.taskManager.taskSummary(this.taskManager.getRunningTask())
        : null,
      queued: this.taskManager.getAllTasks({ status: 'queued' })
        .map(t => this.taskManager.taskSummary(t)),
      recentCompleted: this.taskManager.getAllTasks({ status: 'completed' })
        .slice(-5)
        .map(t => this.taskManager.taskSummary(t)),
      failed: this.taskManager.getAllTasks({ status: 'failed' })
        .map(t => this.taskManager.taskSummary(t)),
    } : { running: null, queued: [], recentCompleted: [], failed: [] };

    return {
      priorities: this.getActivePriorities(),
      userTasks: this.getUserTasks(),
      blairTasks,
      stats: {
        totalUserTasks: this.userTasks.filter(t => t.status === 'pending').length,
        totalQueuedTasks: blairTasks.queued.length,
        isRunning: !!blairTasks.running,
        activePriorities: this.priorities.filter(p => p.status === 'active').length,
      },
    };
  }
}

module.exports = TaskIntelligence;
