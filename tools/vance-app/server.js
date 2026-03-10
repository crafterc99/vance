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
const { spawn } = require('child_process');
const crypto = require('crypto');

const memory = require('./memory');
const costs = require('./costs');

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
  {
    type: 'function',
    function: {
      name: 'run_claude_code',
      description: 'Execute a coding task using Claude Code. Use for building projects, writing code, debugging, file operations, git, running commands.',
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
];

// ─── GPT API Call ────────────────────────────────────────────────────────

async function callGPT(messages, stream = false) {
  const body = {
    model: GPT_MODEL,
    messages,
    tools: TOOLS,
    temperature: 0.7,
    max_tokens: 4096,
  };
  if (stream) body.stream = true;

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

  if (stream) return res;

  const data = await res.json();

  // Log cost
  if (data.usage) {
    costs.logCall('gpt', GPT_MODEL, {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    });
  }

  return data;
}

// ─── Function Executor ───────────────────────────────────────────────────

async function executeFunction(name, args, wsSend) {
  switch (name) {
    case 'run_claude_code': {
      wsSend({ type: 'status', text: 'Executing code task...' });
      const result = await runClaudeCode(args.task, args.project_directory, wsSend);
      return result;
    }

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

  // Build system prompt
  const projects = loadProjects();
  const project = projects.find(p => p.id === projectId);
  const relevantMemories = memory.searchMemories(userMessage, 5);
  const relevantSkills = memory.findSkillsForQuery(userMessage);
  const preferences = memory.getPreferences();
  const memStats = memory.getMemoryStats();

  let system = `You are Vance, a personal AI assistant — like Jarvis from Iron Man. You are calm, confident, competent, and proactive. You speak concisely and directly.

CORE BEHAVIORS:
- Be decisive. Don't ask for permission on routine decisions.
- When working on tasks, report progress naturally.
- Remember things the user tells you using the 'remember' function.
- Learn user preferences using 'learn_preference'.
- Create skills for workflows you'll repeat using 'create_skill'.
- Use 'run_claude_code' for any coding, file, or terminal tasks.
- Always be aware of costs — report them when asked.

CURRENT STATE:
- Memory: ${memStats.total} memories stored
- Skills: ${memory.loadSkills().length} learned skills
- Projects: ${projects.length} active`;

  if (project) {
    const milestones = loadMilestones(projectId);
    system += `\n\nACTIVE PROJECT: "${project.name}"
Directory: ${project.directory}
Description: ${project.description || 'None'}
Milestones: ${milestones.length} completed`;
    if (milestones.length) {
      system += `\nRecent milestones: ${milestones.slice(-5).map(m => m.title).join(', ')}`;
    }
  }

  if (relevantMemories.length) {
    system += `\n\nRELEVANT MEMORIES:\n${relevantMemories.map(m => `- [${m.category}] ${m.content}`).join('\n')}`;
  }

  if (relevantSkills.length) {
    system += `\n\nRELEVANT SKILLS:\n${relevantSkills.map(s => `- ${s.name}: ${s.description}\n  Steps: ${s.steps.join(' → ')}`).join('\n')}`;
  }

  if (Object.keys(preferences).length) {
    system += `\n\nUSER PREFERENCES:\n${Object.entries(preferences).map(([k, v]) => `- ${k}: ${v.value}`).join('\n')}`;
  }

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
    let response = await callGPT(gptMessages);
    let choice = response.choices[0];

    // Function calling loop (max 8 rounds)
    let rounds = 0;
    while (choice.finish_reason === 'tool_calls' && rounds < 8) {
      rounds++;
      const toolCalls = choice.message.tool_calls;

      // Add assistant message with tool calls
      gptMessages.push(choice.message);

      // Execute each function
      for (const tc of toolCalls) {
        const args = JSON.parse(tc.function.arguments);
        wsSend({ type: 'function-call', name: tc.function.name, args });

        const result = await executeFunction(tc.function.name, args, wsSend);

        gptMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }

      // Get next response
      response = await callGPT(gptMessages);
      choice = response.choices[0];
    }

    const assistantMessage = choice.message.content || '';

    // Save to conversation
    convMessages.push({ role: 'assistant', content: assistantMessage, timestamp: new Date().toISOString() });
    saveConversation(convId, convMessages);

    // Auto-learn patterns
    memory.learnPattern(userMessage, project ? 'project-work' : 'general');

    wsSend({ type: 'response', content: assistantMessage });
    return assistantMessage;

  } catch (err) {
    const errMsg = `I ran into an issue: ${err.message}`;
    wsSend({ type: 'error', message: errMsg });
    convMessages.push({ role: 'assistant', content: errMsg, timestamp: new Date().toISOString() });
    saveConversation(convId, convMessages);
    return errMsg;
  }
}

// ─── WebSocket Implementation ────────────────────────────────────────────

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC11E85B')
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`, '', '',
  ].join('\r\n'));

  return {
    send(data) {
      try {
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        const buf = Buffer.from(payload, 'utf8');
        const frame = [0x81];
        if (buf.length < 126) frame.push(buf.length);
        else if (buf.length < 65536) frame.push(126, (buf.length >> 8) & 0xff, buf.length & 0xff);
        else { frame.push(127); for (let i = 7; i >= 0; i--) frame.push((buf.length >> (i * 8)) & 0xff); }
        socket.write(Buffer.concat([Buffer.from(frame), buf]));
      } catch {}
    },
    onMessage(cb) {
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const masked = (buffer[1] & 0x80) !== 0;
          let payloadLen = buffer[1] & 0x7f;
          let offset = 2;
          if (payloadLen === 126) { if (buffer.length < 4) return; payloadLen = buffer.readUInt16BE(2); offset = 4; }
          else if (payloadLen === 127) { if (buffer.length < 10) return; payloadLen = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          const maskOffset = offset;
          if (masked) offset += 4;
          if (buffer.length < offset + payloadLen) return;
          const payload = buffer.subarray(offset, offset + payloadLen);
          if (masked) { const mask = buffer.subarray(maskOffset, maskOffset + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
          const opcode = buffer[0] & 0x0f;
          buffer = buffer.subarray(offset + payloadLen);
          if (opcode === 0x08) { socket.end(); return; }
          if (opcode === 0x01 || opcode === 0x02) {
            try { cb(JSON.parse(payload.toString('utf8'))); } catch { cb({ raw: payload.toString('utf8') }); }
          }
        }
      });
    },
    onClose(cb) { socket.on('close', cb); socket.on('end', cb); },
  };
}

const clients = new Set();

// ─── WebSocket Message Handler ───────────────────────────────────────────

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

  // Serve UI pages
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveFile(res, 'index.html');
  }
  if (url.pathname === '/costs' || url.pathname === '/costs.html') {
    return serveFile(res, 'costs.html');
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

server.on('upgrade', (req, socket) => {
  if (req.url === '/ws') {
    const ws = acceptWebSocket(req, socket);
    clients.add(ws);
    ws.send({ type: 'connected', model: GPT_MODEL, hasKey: OPENAI_KEY !== 'sk-placeholder-add-your-key' });
    ws.onMessage((msg) => handleMessage(ws, msg));
    ws.onClose(() => clients.delete(ws));
  } else {
    socket.destroy();
  }
});

// Prevent uncaught exceptions from crashing the server
process.on('uncaughtException', (err) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message?.includes('ECONNRESET')) return;
  console.error('Uncaught:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║         VANCE — Online                ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
  console.log(`  Model: ${GPT_MODEL}`);
  console.log(`  API Key: ${OPENAI_KEY !== 'sk-placeholder-add-your-key' ? 'Set' : 'PLACEHOLDER — set OPENAI_API_KEY'}`);
  console.log(`  Projects: ${loadProjects().length}`);
  console.log(`  Memories: ${memory.getMemoryStats().total}`);
  console.log(`  Skills: ${memory.loadSkills().length}\n`);
});
