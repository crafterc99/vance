#!/usr/bin/env node
/**
 * BLAIR — Personal AI Operating System
 *
 * Refactored entry point. Loads modules and wires them together.
 *
 * Architecture:
 *   - conversation.js — Unified chat engine (text + voice)
 *   - tools.js — 18 consolidated tools
 *   - coding.js — Unified coding executor
 *   - prompt.js — Lean prompt composition (~800 token base)
 *   - router.js — Mode classifier (conversation/tool/claude_code/background_task)
 *   - transport.js — HTTP routes + WebSocket handling
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

// Load .env file (no external dependency)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  }
}

// ─── Core Modules ────────────────────────────────────────────────────────

const memory = require('./memory');
const costs = require('./costs');
const brain = require('./brain/loader');
const taskManager = require('./task-manager');
const vectorMemory = require('./vector-memory');
const projectState = require('./runtime/project-state');
const executionLogger = require('./runtime/logger');
const VoiceSystem = require('./voice');
const ConversationHandler = require('./voice/conversationHandler');
const TaskIntelligence = require('./task-intelligence');
const claudeSession = require('./claude-session');
const coding = require('./coding');

// New modular architecture
const conversation = require('./conversation');
const transport = require('./transport');
const projectIntel = require('./project-intel');
const dispatch = require('./dispatch');

// ─── Constants ───────────────────────────────────────────────────────────

const PORT = process.env.BLAIR_PORT || 4000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const DATA_DIR = path.resolve(__dirname, '../../.blair-data');
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

// ─── Shell & System Helpers ──────────────────────────────────────────────

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
      const maxLen = 50000;
      if (stdout.length > maxLen) stdout = stdout.slice(0, maxLen) + `\n... (truncated, ${stdout.length} chars total)`;
      if (stderr.length > maxLen) stderr = stderr.slice(0, maxLen) + '\n... (truncated)';
      resolve({ code, stdout, stderr });
    });
    proc.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
  });
}

function resolvePath(p) {
  if (!p) return process.env.HOME;
  if (p.startsWith('~')) p = path.join(process.env.HOME, p.slice(1));
  return path.resolve(p);
}

function searchFiles(query, searchPath, filePattern, nameOnly, maxResults = 20) {
  const resolved = resolvePath(searchPath);
  if (nameOnly) {
    try {
      const cmd = filePattern
        ? `find "${resolved}" -maxdepth 5 -name "${query}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -${maxResults}`
        : `find "${resolved}" -maxdepth 5 -name "*${query}*" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -${maxResults}`;
      return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();
    } catch (e) { return e.message; }
  }
  try {
    const globArg = filePattern ? `--include="${filePattern}"` : '';
    const cmd = `grep -rn ${globArg} --exclude-dir=node_modules --exclude-dir=.git "${query}" "${resolved}" 2>/dev/null | head -${maxResults}`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
    return result || 'No matches found.';
  } catch { return 'No matches found.'; }
}

async function getSystemInfo(category = 'all') {
  const info = {};
  const run = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim(); }
    catch { return 'unavailable'; }
  };

  if (category === 'all' || category === 'cpu') {
    info.cpu = { model: os.cpus()[0]?.model || 'unknown', cores: os.cpus().length, load: os.loadavg() };
  }
  if (category === 'all' || category === 'memory') {
    const total = os.totalmem(), free = os.freemem();
    info.memory = { total: (total / 1e9).toFixed(1) + ' GB', used: ((total - free) / 1e9).toFixed(1) + ' GB', free: (free / 1e9).toFixed(1) + ' GB', percent: ((1 - free / total) * 100).toFixed(0) + '%' };
  }
  if (category === 'all' || category === 'disk') {
    const df = run('df -h / | tail -1');
    const parts = df.split(/\s+/);
    info.disk = { total: parts[1], used: parts[2], available: parts[3], percent: parts[4] };
  }
  if (category === 'all' || category === 'battery') info.battery = run('pmset -g batt 2>/dev/null');
  if (category === 'all' || category === 'network') {
    info.network = { localIP: run("ipconfig getifaddr en0 2>/dev/null || echo 'not connected'"), wifi: run("/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I 2>/dev/null | awk '/ SSID/ {print $2}'") || 'not connected' };
  }
  if (category === 'all' || category === 'processes') info.processes = run('ps -eo pid,pcpu,pmem,comm -r | head -11');
  if (category === 'all') {
    info.uptime = (os.uptime() / 3600).toFixed(1) + ' hours';
    info.hostname = os.hostname();
    info.user = os.userInfo().username;
    info.platform = `macOS ${run('sw_vers -productVersion 2>/dev/null')}`;
    info.nodeVersion = process.version;
  }
  return info;
}

// ─── Claude Streaming API ────────────────────────────────────────────────

async function* callClaudeStream(model, messages, system, tools) {
  const body = {
    model,
    max_tokens: 8192,
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
    buf = lines.pop();

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
              yield { type: 'tool_use_start', index: event.index, id: event.content_block.id, name: event.content_block.name };
            }
            break;
          case 'content_block_delta':
            if (event.delta?.type === 'text_delta') yield { type: 'token', content: event.delta.text };
            else if (event.delta?.type === 'input_json_delta') yield { type: 'tool_input_delta', index: event.index, delta: event.delta.partial_json };
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

// ─── Claude Code Runner (via session manager) ────────────────────────────

async function runClaudeCode(task, projectDir, wsSend, projectId) {
  const session = claudeSession.getOrCreate(projectId || 'general', projectDir || process.env.HOME);
  wsSend({ type: 'status', text: `Claude Code ${session.claudeSessionId ? '(resuming session)' : '(new session)'}...` });

  const result = await claudeSession.prompt(session.id, task, {
    onStream: (text) => { wsSend({ type: 'claude-stream', content: text }); },
    onToolUse: (name) => { wsSend({ type: 'claude-tool', name }); },
  });

  if (result.error) return `Claude Code encountered an issue: ${result.error}`;
  return result.output || 'Done.';
}

// ─── Error Handlers ──────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message?.includes('ECONNRESET')) return;
  console.error('Uncaught:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});

// ─── Wire Everything Together ────────────────────────────────────────────

// Shared dependency bag for conversation.js and tools.js
const deps = {
  memory, costs, brain, taskManager, vectorMemory, projectState,
  executionLogger, claudeSession,
  loadProjects, saveProjects, loadConversation, saveConversation,
  loadMilestones, addMilestone,
  runShell, resolvePath, searchFiles, getSystemInfo,
  runClaudeCode, callClaudeStream,
  taskIntelligence: null, // set below after broadcast is ready
};

// Default budget
const claudeBudget = costs.checkBudget('claude');
if (!claudeBudget.dailyBudget) costs.setBudget('claude', 5, 50);

// ─── Start Server ────────────────────────────────────────────────────────

(async () => {
  // Init vector memory
  if (OPENAI_KEY) {
    await vectorMemory.init(OPENAI_KEY);
  } else {
    console.log('  Vector Memory: DISABLED (no OPENAI_API_KEY for embeddings)');
  }

  // Init project states
  const startupProjects = loadProjects();
  for (const p of startupProjects) {
    if (p.directory) projectState.initProjectState(p.id, p.name, p.directory);
  }

  // Create transport (HTTP + WS)
  let voiceSystem = null;
  const { server, wss, clients, broadcast } = transport.createServer({
    PORT, ANTHROPIC_KEY,
    loadProjects, saveProjects, loadMilestones,
    loadConversation,
    costs, memory, brain, taskManager,
    vectorMemory, projectState, executionLogger,
    claudeSession,
    conversation,
    getSystemInfo,
    dispatch, projectIntel,
    get voiceSystem() { return voiceSystem; },
    get taskIntelligence() { return deps.taskIntelligence; },
  });

  // Wire broadcast to task manager and session manager
  taskManager.setBroadcast(broadcast);
  claudeSession.setBroadcast(broadcast);

  // Init task intelligence
  const taskIntelligence = new TaskIntelligence({
    taskManager, memory, broadcast,
  });
  deps.taskIntelligence = taskIntelligence;

  // Init dispatch engine
  dispatch.init({ loadProjects, taskManager, claudeSession, projectIntel, costs });

  // Init conversation engine
  conversation.init(deps);

  // Bootstrap all projects (async, non-blocking)
  projectIntel.bootstrapAll().then(results => {
    const ok = results.filter(r => r.success).length;
    console.log(`  Projects bootstrapped: ${ok}/${results.length}`);
  }).catch(() => {});

  // Init voice system
  try {
    const GROQ_KEY = process.env.GROQ_API_KEY || '';
    const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || '';
    const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY || '';

    voiceSystem = new VoiceSystem({
      openaiKey: OPENAI_KEY,
      groqKey: GROQ_KEY,
      deepgramKey: DEEPGRAM_KEY,
      elevenLabsKey: ELEVENLABS_KEY,
      whisperModel: process.env.WHISPER_MODEL || 'base',
      whisperBackend: process.env.WHISPER_BACKEND || null,
      ttsBackend: process.env.TTS_BACKEND || null,
      alwaysOn: process.env.VOICE_ALWAYS_ON !== 'false',
      fillerEnabled: process.env.VOICE_FILLERS !== 'false',
      fillerDelay: parseInt(process.env.VOICE_FILLER_DELAY) || 800,
      ttsVoice: process.env.TTS_VOICE || null,
      ttsSpeed: parseFloat(process.env.TTS_SPEED) || 1.0,
      elevenLabsVoice: process.env.ELEVENLABS_VOICE_ID || null,
      silenceTimeout: parseInt(process.env.VOICE_SILENCE_TIMEOUT) || 800,
      energyThreshold: parseFloat(process.env.VOICE_ENERGY_THRESHOLD) || 0.008,
      interruptionSensitivity: parseFloat(process.env.VOICE_INTERRUPTION_SENSITIVITY) || 0.5,
    });

    // Voice handler uses conversation.handleChat with voice source
    const voiceConversationHandler = new ConversationHandler({
      handleChat: async (message, projectId, wsSend) => {
        return conversation.handleChat(message, projectId, wsSend, { source: 'voice' });
      },
      buildChatContext: conversation.buildChatContext,
      buildSystemPromptForChat: conversation.buildSystemPromptForChat,
      loadConversation,
      saveConversation,
    });

    voiceSystem.setConversationHandler(voiceConversationHandler);
    transport.wireVoiceEvents(voiceSystem, clients);
    console.log('  Voice System: Initialized');
  } catch (err) {
    console.log(`  Voice System: FAILED — ${err.message}`);
  }

  // Start listening
  server.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║         BLAIR — Online                ║`);
    console.log(`  ║   http://localhost:${PORT}              ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);

    const brainFiles = brain.getBrainFiles();
    const brainLoaded = Object.values(brainFiles).filter(f => f.exists).length;
    const budget = costs.checkBudget('claude');
    const smartMem = brain.getSmartMemory();
    const dailyNotes = memory.listDailyNotes(5);
    const vecStats = vectorMemory.getStats();
    const voiceInfo = voiceSystem ? voiceSystem.getStatus() : null;

    console.log(`  Model: Sonnet 4.6 (single-tier) → Claude Code (projects)`);
    console.log(`  Anthropic Key: ${ANTHROPIC_KEY ? 'Set' : 'MISSING — set ANTHROPIC_API_KEY'}`);
    console.log(`  Brain: ${brainLoaded}/${Object.keys(brainFiles).length} files loaded`);
    console.log(`  Memory: MEMORY.md ${smartMem.memoryMd ? '✓' : '—'} | projects.md ${smartMem.projectsMd ? '✓' : '—'} | ${dailyNotes.length} daily notes`);
    console.log(`  Vector Memory: ${vecStats.totalEntries} entries (${vecStats.backend || 'pgvector'})`);
    console.log(`  Projects: ${loadProjects().length}`);
    console.log(`  Memories: ${memory.getMemoryStats().total}`);
    console.log(`  Skills: ${memory.loadSkills().length}`);
    console.log(`  Claude Budget: $${budget.dailyBudget}/day, $${budget.monthlyBudget}/month`);
    console.log(`  Tasks: ${taskManager.getAllTasks({ status: 'queued' }).length} queued, ${taskManager.getRunningTask() ? 1 : 0} running`);
    console.log(`  Tools: 18 consolidated`);
    const stateCount = Object.keys(projectState.getAllStates()).length;
    console.log(`  Project States: ${stateCount} tracked`);
    const voiceMode = voiceInfo?.mode || '—';
    const sttInfo = voiceInfo?.stt?.backend || voiceInfo?.stt?.model || '—';
    const sttType = voiceInfo?.stt?.type || 'batch';
    console.log(`  Voice: ${voiceInfo ? 'Ready' : 'Not available'} (${voiceMode} | Brain: Sonnet 4.6 | STT: ${sttInfo} [${sttType}] | TTS: ${voiceInfo?.tts?.backend || '—'})\n`);
  });
})();
