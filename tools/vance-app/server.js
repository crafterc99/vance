#!/usr/bin/env node
/**
 * VANCE — Personal AI Assistant Server
 *
 * Voice-driven, project-managing, autonomous coding assistant.
 * Wraps Claude Code headless mode with a real-time WebSocket interface.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.VANCE_PORT || 4000;
const DATA_DIR = path.resolve(__dirname, '../../.vance-data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');
const MILESTONES_DIR = path.join(DATA_DIR, 'milestones');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
fs.mkdirSync(MILESTONES_DIR, { recursive: true });

// ─── Data Layer ──────────────────────────────────────────────────────────

function loadProjects() {
  if (!fs.existsSync(PROJECTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
}

function saveProjects(projects) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

function loadConversation(id) {
  const file = path.join(CONVERSATIONS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function appendMessage(convId, role, content, meta = {}) {
  const messages = loadConversation(convId);
  const msg = { role, content, timestamp: new Date().toISOString(), ...meta };
  messages.push(msg);
  fs.writeFileSync(path.join(CONVERSATIONS_DIR, `${convId}.json`), JSON.stringify(messages, null, 2));
  return msg;
}

function loadMilestones(projectId) {
  const file = path.join(MILESTONES_DIR, `${projectId}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function addMilestone(projectId, milestone) {
  const milestones = loadMilestones(projectId);
  milestones.push({ ...milestone, id: crypto.randomUUID(), timestamp: new Date().toISOString() });
  fs.writeFileSync(path.join(MILESTONES_DIR, `${projectId}.json`), JSON.stringify(milestones, null, 2));
  return milestones;
}

// ─── Claude Code Executor ────────────────────────────────────────────────

class ClaudeExecutor {
  constructor() {
    this.activeSessions = new Map();
  }

  async execute(prompt, options = {}) {
    const {
      projectDir,
      sessionId,
      onChunk,
      onComplete,
      onError,
      systemPrompt,
    } = options;

    const args = ['-p', prompt, '--output-format', 'stream-json'];

    if (sessionId) {
      args.push('--session-id', sessionId);
      if (options.resume) args.push('--resume');
    }

    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    // Allow common tools for autonomous work
    args.push('--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(git *),Bash(npm *),Bash(node *),Bash(ls *),Bash(mkdir *),Bash(cat *),Agent');

    const cwd = projectDir || process.cwd();

    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let fullOutput = '';
      let lastAssistantText = '';
      let toolsUsed = [];

      proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);

            if (parsed.type === 'assistant' && parsed.message?.content) {
              for (const block of parsed.message.content) {
                if (block.type === 'text' && block.text) {
                  lastAssistantText += block.text;
                  fullOutput += block.text;
                  if (onChunk) onChunk({ type: 'text', content: block.text });
                } else if (block.type === 'tool_use') {
                  toolsUsed.push(block.name);
                  if (onChunk) onChunk({ type: 'tool', name: block.name, input: block.input });
                }
              }
            } else if (parsed.type === 'result') {
              if (onChunk) onChunk({ type: 'result', subtype: parsed.subtype, cost: parsed.cost_usd, duration: parsed.duration_ms, session_id: parsed.session_id });
            }
          } catch {
            // Non-JSON output
            fullOutput += line;
            if (onChunk) onChunk({ type: 'raw', content: line });
          }
        }
      });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        const result = {
          output: lastAssistantText || fullOutput,
          toolsUsed,
          exitCode: code,
          stderr: stderr.trim(),
        };
        if (code === 0) {
          if (onComplete) onComplete(result);
          resolve(result);
        } else {
          const err = new Error(stderr || `Claude exited with code ${code}`);
          err.result = result;
          if (onError) onError(err);
          reject(err);
        }
      });

      proc.on('error', (err) => {
        if (onError) onError(err);
        reject(err);
      });

      // Store for potential cancellation
      this.activeSessions.set(sessionId || 'default', proc);
    });
  }

  cancel(sessionId) {
    const proc = this.activeSessions.get(sessionId || 'default');
    if (proc) {
      proc.kill('SIGTERM');
      this.activeSessions.delete(sessionId || 'default');
      return true;
    }
    return false;
  }
}

const executor = new ClaudeExecutor();

// ─── WebSocket (minimal, no deps) ───────────────────────────────────────

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC11E85B')
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'));

  return {
    send(data) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      const buf = Buffer.from(payload, 'utf8');
      const frame = [];

      frame.push(0x81); // text frame
      if (buf.length < 126) {
        frame.push(buf.length);
      } else if (buf.length < 65536) {
        frame.push(126, (buf.length >> 8) & 0xff, buf.length & 0xff);
      } else {
        frame.push(127);
        for (let i = 7; i >= 0; i--) frame.push((buf.length >> (i * 8)) & 0xff);
      }

      socket.write(Buffer.concat([Buffer.from(frame), buf]));
    },
    onMessage(cb) {
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const secondByte = buffer[1];
          const masked = (secondByte & 0x80) !== 0;
          let payloadLen = secondByte & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (buffer.length < 4) return;
            payloadLen = buffer.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (buffer.length < 10) return;
            payloadLen = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }

          const maskOffset = offset;
          if (masked) offset += 4;
          const totalLen = offset + payloadLen;
          if (buffer.length < totalLen) return;

          const payload = buffer.subarray(offset, offset + payloadLen);
          if (masked) {
            const mask = buffer.subarray(maskOffset, maskOffset + 4);
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          }

          const opcode = buffer[0] & 0x0f;
          buffer = buffer.subarray(totalLen);

          if (opcode === 0x08) { socket.end(); return; } // close
          if (opcode === 0x09) { /* ping — ignore */ continue; }
          if (opcode === 0x01 || opcode === 0x02) { // text or binary
            try { cb(JSON.parse(payload.toString('utf8'))); }
            catch { cb({ raw: payload.toString('utf8') }); }
          }
        }
      });
    },
    onClose(cb) { socket.on('close', cb); socket.on('end', cb); },
  };
}

// ─── Active Connections ──────────────────────────────────────────────────

const clients = new Set();

function broadcast(data) {
  for (const ws of clients) {
    try { ws.send(data); } catch {}
  }
}

// ─── Handle WebSocket Messages ───────────────────────────────────────────

async function handleMessage(ws, msg) {
  const { action, ...params } = msg;

  switch (action) {
    case 'chat': {
      const { message, projectId } = params;
      const convId = projectId || 'general';

      // Save user message
      appendMessage(convId, 'user', message);
      ws.send({ type: 'ack', convId });

      // Determine project context
      const projects = loadProjects();
      const project = projects.find(p => p.id === projectId);
      const projectDir = project?.directory;

      // Build system prompt with project context
      let systemPrompt = `You are Vance, a personal AI assistant. You are like Jarvis from Iron Man — calm, competent, proactive. Speak concisely and confidently. Address the user directly.\n\nWhen working on tasks:\n- Report progress as you go\n- When you complete a significant milestone, say "MILESTONE: <description>" on its own line\n- Be decisive and autonomous — don't ask for permission on routine decisions\n- If creating a new project, set up proper structure, git, dependencies`;

      if (project) {
        systemPrompt += `\n\nActive Project: "${project.name}"\nDirectory: ${project.directory}\nDescription: ${project.description || 'No description'}\nStatus: ${project.status || 'active'}`;
        const milestones = loadMilestones(projectId);
        if (milestones.length) {
          systemPrompt += `\n\nCompleted Milestones:\n${milestones.map(m => `- ${m.title}`).join('\n')}`;
        }
      }

      // Execute via Claude
      const sessionId = `vance-${convId}`;
      ws.send({ type: 'thinking' });

      try {
        await executor.execute(message, {
          projectDir: projectDir || process.env.HOME,
          sessionId,
          resume: true,
          systemPrompt,
          onChunk(chunk) {
            ws.send({ type: 'stream', ...chunk });

            // Auto-detect milestones from Claude's output
            if (chunk.type === 'text' && chunk.content.includes('MILESTONE:')) {
              const match = chunk.content.match(/MILESTONE:\s*(.+)/);
              if (match && projectId) {
                const milestone = { title: match[1].trim(), status: 'completed' };
                addMilestone(projectId, milestone);
                ws.send({ type: 'milestone', ...milestone, projectId });
              }
            }
          },
          onComplete(result) {
            appendMessage(convId, 'assistant', result.output, {
              toolsUsed: result.toolsUsed,
            });
            ws.send({ type: 'done', output: result.output, toolsUsed: result.toolsUsed });
          },
          onError(err) {
            appendMessage(convId, 'assistant', `Error: ${err.message}`, { error: true });
            ws.send({ type: 'error', message: err.message });
          },
        });
      } catch (err) {
        ws.send({ type: 'error', message: err.message });
      }
      break;
    }

    case 'create-project': {
      const { name, description, directory } = params;
      const projects = loadProjects();
      const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const dir = directory || path.join(process.env.HOME, 'Claude Test', name);

      projects.push({
        id,
        name,
        description: description || '',
        directory: dir,
        status: 'active',
        createdAt: new Date().toISOString(),
      });
      saveProjects(projects);
      fs.mkdirSync(dir, { recursive: true });

      ws.send({ type: 'project-created', project: projects[projects.length - 1] });
      break;
    }

    case 'list-projects': {
      const projects = loadProjects();
      const enriched = projects.map(p => ({
        ...p,
        milestones: loadMilestones(p.id),
      }));
      ws.send({ type: 'projects', projects: enriched });
      break;
    }

    case 'get-milestones': {
      const milestones = loadMilestones(params.projectId);
      ws.send({ type: 'milestones', projectId: params.projectId, milestones });
      break;
    }

    case 'get-conversation': {
      const messages = loadConversation(params.convId || 'general');
      ws.send({ type: 'conversation', convId: params.convId || 'general', messages });
      break;
    }

    case 'cancel': {
      const cancelled = executor.cancel(params.sessionId);
      ws.send({ type: 'cancelled', success: cancelled });
      break;
    }

    default:
      ws.send({ type: 'error', message: `Unknown action: ${action}` });
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // REST API fallbacks
  if (url.pathname === '/api/projects' && req.method === 'GET') {
    const projects = loadProjects().map(p => ({ ...p, milestones: loadMilestones(p.id) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projects }));
    return;
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'online', uptime: process.uptime() }));
    return;
  }

  // Serve UI
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(htmlPath));
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    const ws = acceptWebSocket(req, socket);
    clients.add(ws);
    ws.send({ type: 'connected', message: 'Vance online.' });

    ws.onMessage((msg) => handleMessage(ws, msg));
    ws.onClose(() => clients.delete(ws));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   VANCE — Personal AI Assistant      ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
  console.log(`  Projects: ${loadProjects().length}`);
  console.log(`  Data: ${DATA_DIR}\n`);
});
