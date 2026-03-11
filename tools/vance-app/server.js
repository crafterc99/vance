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
const brain = require('./brain/loader');

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
  {
    type: 'function',
    function: {
      name: 'propose_brain_update',
      description: 'Propose an update to your own brain configuration files (personality, user profile, guidelines, or self-improvement). The update requires user approval before being applied.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', enum: ['personality', 'userProfile', 'guidelines', 'selfImprovement'], description: 'Which brain file to update' },
          section: { type: 'string', description: 'Section or topic being updated' },
          old_text: { type: 'string', description: 'Existing text to replace (null for additions)' },
          new_text: { type: 'string', description: 'New text to add or replace with' },
          reason: { type: 'string', description: 'Why this update is needed' },
        },
        required: ['file', 'section', 'new_text', 'reason'],
      },
    },
  },
];

// ─── GPT Streaming Call ──────────────────────────────────────────────────

/**
 * Stream GPT response. Yields events:
 *   { type: 'token', content: '...' }
 *   { type: 'tool_call_start', index, id, name }
 *   { type: 'tool_call_args', index, args: '...' }
 *   { type: 'done', usage: { ... } }
 */
async function* callGPTStream(messages) {
  const body = {
    model: GPT_MODEL,
    messages,
    tools: TOOLS,
    temperature: 0.7,
    max_tokens: 4096,
    stream: true,
    stream_options: { include_usage: true },
  };

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

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6);
      if (payload === '[DONE]') return;

      try {
        const chunk = JSON.parse(payload);

        // Usage comes in the final chunk
        if (chunk.usage) {
          costs.logCall('gpt', GPT_MODEL, {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          });
          yield { type: 'done', usage: chunk.usage };
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          yield { type: 'token', content: delta.content };
        }

        // Tool calls (streamed as deltas)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              yield { type: 'tool_call_start', index: tc.index, id: tc.id, name: tc.function?.name || '' };
            }
            if (tc.function?.arguments) {
              yield { type: 'tool_call_args', index: tc.index, args: tc.function.arguments };
            }
          }
        }
      } catch {}
    }
  }
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

    case 'propose_brain_update': {
      const update = brain.proposeBrainUpdate(
        args.file, args.section, args.old_text || null, args.new_text, args.reason
      );
      wsSend({ type: 'brain-update-proposed', update });
      return `Brain update proposed for ${args.file}/${args.section}: "${args.reason}". Awaiting user approval.`;
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

  // Build system prompt from brain files + live context
  const projects = loadProjects();
  const project = projects.find(p => p.id === projectId);
  const relevantMemories = memory.searchMemories(userMessage, 5);
  const relevantSkills = memory.findSkillsForQuery(userMessage);
  const preferences = memory.getPreferences();
  const memStats = memory.getMemoryStats();
  const todayStats = costs.getStats('today');

  const projectContext = project ? {
    ...project,
    milestones: loadMilestones(projectId),
  } : null;

  const system = brain.buildSystemPrompt({
    project: projectContext,
    memories: relevantMemories,
    skills: relevantSkills,
    preferences,
    stats: {
      memoryCount: memStats.total,
      skillCount: memory.loadSkills().length,
      projectCount: projects.length,
    },
    costs: {
      todaySpend: todayStats.totalCost.toFixed(2),
      todayCalls: todayStats.totalCalls,
    },
  });

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
    let fullText = '';
    let rounds = 0;

    while (rounds < 8) {
      rounds++;
      let text = '';
      const toolCalls = {}; // index -> { id, name, args }
      let hasToolCalls = false;

      // Stream GPT response
      for await (const event of callGPTStream(gptMessages)) {
        if (event.type === 'token') {
          text += event.content;
          wsSend({ type: 'stream-token', content: event.content });
        } else if (event.type === 'tool_call_start') {
          hasToolCalls = true;
          toolCalls[event.index] = { id: event.id, name: event.name, args: '' };
          wsSend({ type: 'function-call', name: event.name });
        } else if (event.type === 'tool_call_args') {
          if (toolCalls[event.index]) toolCalls[event.index].args += event.args;
        }
      }

      // If we got text only (no tool calls), we're done
      if (!hasToolCalls) {
        fullText = text;
        break;
      }

      // Build the assistant message with tool calls for the conversation
      const assistantMsg = { role: 'assistant', content: text || null, tool_calls: [] };
      for (const [, tc] of Object.entries(toolCalls)) {
        assistantMsg.tool_calls.push({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args },
        });
      }
      gptMessages.push(assistantMsg);

      // Execute each tool call
      for (const [, tc] of Object.entries(toolCalls)) {
        let args;
        try { args = JSON.parse(tc.args); } catch { args = {}; }
        wsSend({ type: 'status', text: `Running ${tc.name}...` });

        const result = await executeFunction(tc.name, args, wsSend);

        gptMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }

      // Signal that tool execution is done, next round will stream
      wsSend({ type: 'tool-done' });
    }

    // Signal stream complete
    wsSend({ type: 'stream-end' });

    // Save to conversation
    convMessages.push({ role: 'assistant', content: fullText, timestamp: new Date().toISOString() });
    saveConversation(convId, convMessages);

    // Auto-learn patterns
    memory.learnPattern(userMessage, project ? 'project-work' : 'general');

    return fullText;

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

    case 'get-brain': {
      ws.send({ type: 'brain', files: brain.getBrainFiles(), pending: brain.getPendingUpdates() });
      break;
    }

    case 'approve-brain-update': {
      const result = brain.approveBrainUpdate(msg.updateId);
      ws.send({ type: 'brain-update-result', action: 'approved', ...result });
      break;
    }

    case 'reject-brain-update': {
      const result = brain.rejectBrainUpdate(msg.updateId);
      ws.send({ type: 'brain-update-result', action: 'rejected', ...result });
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

  if (url.pathname === '/api/brain') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files: brain.getBrainFiles(), pending: brain.getPendingUpdates() }));
    return;
  }
  if (url.pathname.startsWith('/api/brain/') && req.method === 'GET') {
    const fileKey = url.pathname.split('/').pop();
    const content = brain.readBrainFile(fileKey);
    if (content !== '') {
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(content);
    } else {
      res.writeHead(404); res.end('Brain file not found');
    }
    return;
  }

  // Serve UI pages
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveFile(res, 'index.html');
  }
  if (url.pathname === '/costs' || url.pathname === '/costs.html') {
    return serveFile(res, 'costs.html');
  }
  if (url.pathname === '/brain' || url.pathname === '/brain.html') {
    return serveFile(res, 'brain.html');
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
  const brainFiles = brain.getBrainFiles();
  const brainLoaded = Object.values(brainFiles).filter(f => f.exists).length;
  console.log(`  Model: ${GPT_MODEL}`);
  console.log(`  API Key: ${OPENAI_KEY !== 'sk-placeholder-add-your-key' ? 'Set' : 'PLACEHOLDER — set OPENAI_API_KEY'}`);
  console.log(`  Brain: ${brainLoaded}/${Object.keys(brainFiles).length} files loaded`);
  console.log(`  Projects: ${loadProjects().length}`);
  console.log(`  Memories: ${memory.getMemoryStats().total}`);
  console.log(`  Skills: ${memory.loadSkills().length}\n`);
});
