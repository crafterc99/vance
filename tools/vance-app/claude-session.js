/**
 * VANCE — Claude Code Session Manager
 *
 * Persistent, multi-turn Claude Code sessions per project.
 * Works like Claude Code in VS Code — Vance can prompt, follow up,
 * and maintain context across multiple interactions.
 *
 * Architecture:
 *   - Each project gets a session that persists across prompts
 *   - Sessions can be resumed with full context
 *   - Output streams back in real-time (stream-json)
 *   - Vance's brain auto-delegates coding here
 *
 * Usage:
 *   const session = sessionManager.getOrCreate(projectId, projectDir);
 *   const result = await sessionManager.prompt(session.id, "add dark mode");
 */
const path = require('path');
const fs = require('fs');
const costs = require('./costs');
const coding = require('./coding');

const DATA_DIR = path.resolve(__dirname, '../../.vance-data');
const SESSIONS_FILE = path.join(DATA_DIR, 'claude-sessions.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Session Store ────────────────────────────────────────────────────────

let sessions = {};
let activeProcesses = {}; // sessionId → child process
let broadcastFn = null;

function setBroadcast(fn) { broadcastFn = fn; }
function broadcast(event) { if (broadcastFn) broadcastFn(event); }

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch { sessions = {}; }
}

function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

loadSessions();

// ─── Session Management ──────────────────────────────────────────────────

/**
 * Get or create a Claude Code session for a project.
 */
function getOrCreate(projectId, projectDir) {
  const key = projectId || 'general';

  if (sessions[key] && sessions[key].claudeSessionId) {
    sessions[key].lastAccessed = new Date().toISOString();
    saveSessions();
    return sessions[key];
  }

  const session = {
    id: key,
    projectId: projectId || null,
    projectDir: coding.expandHome(projectDir) || process.env.HOME,
    claudeSessionId: null, // Set after first prompt
    model: 'claude-sonnet-4-6',
    status: 'idle', // idle | running | error
    promptCount: 0,
    totalCost: 0,
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    lastPrompt: null,
  };

  sessions[key] = session;
  saveSessions();
  return session;
}

/**
 * Get an existing session.
 */
function getSession(sessionId) {
  return sessions[sessionId] || null;
}

/**
 * List all sessions.
 */
function listSessions() {
  return Object.values(sessions).map(s => ({
    id: s.id,
    projectId: s.projectId,
    status: s.status,
    promptCount: s.promptCount,
    totalCost: s.totalCost,
    lastPrompt: s.lastPrompt,
    lastAccessed: s.lastAccessed,
    hasClaudeSession: !!s.claudeSessionId,
  }));
}

/**
 * Check if a session is currently running.
 */
function isRunning(sessionId) {
  return !!activeProcesses[sessionId];
}

// ─── Prompt Execution ────────────────────────────────────────────────────

/**
 * Send a prompt to a Claude Code session.
 * Resumes the existing session if one exists, otherwise starts fresh.
 *
 * @param {string} sessionId - Session key (usually projectId)
 * @param {string} message - The prompt to send
 * @param {object} opts - { model, maxBudget, effort, onStream, onToolUse, onComplete, onError }
 * @returns {Promise<object>} { output, costUsd, sessionId, toolCalls }
 */
function prompt(sessionId, message, opts = {}) {
  return new Promise((resolve, reject) => {
    const session = sessions[sessionId];
    if (!session) {
      return reject(new Error(`Session not found: ${sessionId}`));
    }

    if (activeProcesses[sessionId]) {
      return reject(new Error('Session is already running. Wait for it to finish or cancel it.'));
    }

    session.status = 'running';
    session.lastPrompt = message;
    session.promptCount++;
    session.lastAccessed = new Date().toISOString();
    saveSessions();

    broadcast({
      type: 'claude-session-started',
      sessionId,
      prompt: message.slice(0, 100),
    });

    // Use coding.js unified spawn
    const { process: proc, result: spawnResult } = coding.runInteractive({
      message,
      cwd: session.projectDir || process.env.HOME,
      model: opts.model || session.model || 'claude-sonnet-4-6',
      maxBudget: opts.maxBudget,
      effort: opts.effort,
      claudeSessionId: session.claudeSessionId,
      projectId: session.projectId,
      callbacks: {
        onStream: (text) => {
          if (opts.onStream) opts.onStream(text);
          broadcast({ type: 'claude-session-stream', sessionId, content: text });

          const milestones = coding.detectMilestones(text);
          for (const ms of milestones) {
            broadcast({ type: 'claude-session-milestone', sessionId, milestone: ms });
          }
        },
        onToolUse: (name, input) => {
          if (opts.onToolUse) opts.onToolUse(name, input);
          broadcast({ type: 'claude-session-tool', sessionId, tool: name });
        },
      },
    });

    activeProcesses[sessionId] = proc;

    spawnResult.then((result) => {
      delete activeProcesses[sessionId];

      if (result.sessionId) {
        session.claudeSessionId = result.sessionId;
      }
      session.totalCost += result.costUsd;
      session.status = result.exitCode === 0 ? 'idle' : 'error';
      saveSessions();

      broadcast({
        type: 'claude-session-complete',
        sessionId,
        costUsd: result.costUsd,
        exitCode: result.exitCode,
        toolCount: result.toolCalls.length,
      });

      if (result.exitCode === 0) {
        if (opts.onComplete) opts.onComplete(result);
      } else if (opts.onError) {
        opts.onError(result.error);
      }

      resolve(result);
    });
  });
}

/**
 * Cancel a running session.
 */
function cancel(sessionId) {
  const proc = activeProcesses[sessionId];
  if (!proc) return { error: 'No active process for this session' };

  try { proc.kill('SIGTERM'); } catch {}
  delete activeProcesses[sessionId];

  if (sessions[sessionId]) {
    sessions[sessionId].status = 'idle';
    saveSessions();
  }

  broadcast({ type: 'claude-session-cancelled', sessionId });
  return { success: true };
}

/**
 * Reset a session (clear the Claude session ID to start fresh).
 */
function resetSession(sessionId) {
  if (activeProcesses[sessionId]) {
    cancel(sessionId);
  }
  if (sessions[sessionId]) {
    sessions[sessionId].claudeSessionId = null;
    sessions[sessionId].promptCount = 0;
    sessions[sessionId].totalCost = 0;
    sessions[sessionId].status = 'idle';
    saveSessions();
  }
  return { success: true };
}

module.exports = {
  getOrCreate,
  getSession,
  listSessions,
  isRunning,
  prompt,
  cancel,
  resetSession,
  setBroadcast,
};
