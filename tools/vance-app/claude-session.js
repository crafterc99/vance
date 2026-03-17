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
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const costs = require('./costs');
const claudeRunner = require('./claude-runner');

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

// ─── Full Tool Access (mirrors VS Code experience) ───────────────────────

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
].join(',');

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
    projectDir: projectDir || process.env.HOME,
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

    // Don't allow concurrent prompts on the same session
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

    // Build Claude CLI args
    const args = ['-p', message];

    // Model
    args.push('--model', opts.model || session.model || 'claude-sonnet-4-6');

    // Budget
    if (opts.maxBudget) {
      args.push('--max-budget-usd', String(opts.maxBudget));
    }

    // Effort
    if (opts.effort) {
      args.push('--effort', opts.effort);
    }

    // Resume existing session or start fresh
    if (session.claudeSessionId) {
      args.push('--resume', session.claudeSessionId);
    }

    // Full permission bypass — like VS Code
    args.push('--permission-mode', 'bypassPermissions');

    // Full tool access
    args.push('--allowedTools', FULL_TOOLS);

    // Stream JSON output
    args.push('--output-format', 'stream-json');

    // System prompt with Vance context
    const systemAppend = [
      'You are operating as Claude Code, controlled by Vance (a JARVIS-like AI).',
      `Project: ${session.projectId || 'general'}`,
      session.projectDir ? `Working directory: ${session.projectDir}` : '',
      'Work autonomously. Commit frequently. Do NOT push unless told to.',
      'Be thorough — read files before editing, run tests after changes.',
    ].filter(Boolean).join('\n');
    args.push('--append-system-prompt', systemAppend);

    const cwd = session.projectDir || process.env.HOME;

    // Spawn
    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeProcesses[sessionId] = proc;

    let output = '';
    let costUsd = 0;
    let claudeSessionId = null;
    let toolCalls = [];

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);

          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text') {
                output += block.text;
                if (opts.onStream) opts.onStream(block.text);
                broadcast({
                  type: 'claude-session-stream',
                  sessionId,
                  content: block.text,
                });

                // Detect milestones
                const milestones = claudeRunner.detectMilestones(block.text);
                for (const ms of milestones) {
                  broadcast({
                    type: 'claude-session-milestone',
                    sessionId,
                    milestone: ms,
                  });
                }
              } else if (block.type === 'tool_use') {
                toolCalls.push({ name: block.name, input: block.input });
                if (opts.onToolUse) opts.onToolUse(block.name, block.input);
                broadcast({
                  type: 'claude-session-tool',
                  sessionId,
                  tool: block.name,
                });
              }
            }
          } else if (parsed.type === 'result') {
            costUsd = parsed.cost_usd || 0;
            claudeSessionId = parsed.session_id || null;
          }
        } catch {}
      }
    });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      delete activeProcesses[sessionId];

      // Update session
      if (claudeSessionId) {
        session.claudeSessionId = claudeSessionId;
      }
      session.totalCost += costUsd;
      session.status = code === 0 ? 'idle' : 'error';
      saveSessions();

      // Log cost
      if (costUsd) {
        costs.logCall('claude-session', session.model || 'claude-sonnet-4-6', { cost: costUsd });
      }

      const result = {
        output: output || 'Done.',
        costUsd,
        claudeSessionId,
        toolCalls,
        exitCode: code,
      };

      broadcast({
        type: 'claude-session-complete',
        sessionId,
        costUsd,
        exitCode: code,
        toolCount: toolCalls.length,
      });

      if (code === 0) {
        if (opts.onComplete) opts.onComplete(result);
        resolve(result);
      } else {
        const error = stderr.slice(0, 1000) || `Exit code ${code}`;
        result.error = error;
        if (opts.onError) opts.onError(error);
        resolve(result); // Resolve, don't reject — let caller handle
      }
    });

    proc.on('error', (err) => {
      delete activeProcesses[sessionId];
      session.status = 'error';
      saveSessions();

      const error = `Failed to spawn Claude: ${err.message}`;
      if (opts.onError) opts.onError(error);
      resolve({ output: '', costUsd: 0, error, toolCalls: [] });
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
