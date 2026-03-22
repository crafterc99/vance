/**
 * VANCE — Transport Layer
 *
 * HTTP routes + WebSocket handling extracted from server.js.
 * Exports: createServer(deps) → { server, wss, clients, broadcast }
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

/**
 * Create the HTTP server and WebSocket handler.
 *
 * @param {Object} deps - All dependencies
 * @returns {{ server, wss, clients, broadcast, wsBroadcast }}
 */
function createServer(deps) {
  const {
    PORT, ANTHROPIC_KEY,
    loadProjects, saveProjects, loadMilestones,
    costs, memory, brain, taskManager, taskIntelligence,
    vectorMemory, projectState, executionLogger,
    claudeSession, voiceSystem,
    conversation, getSystemInfo,
  } = deps;

  const clients = new Set();

  function broadcast(event) {
    for (const client of clients) {
      try { client.send(event); } catch {}
    }
  }

  // ─── WebSocket Message Handler ──────────────────────────────────────

  async function handleMessage(ws, msg) {
    switch (msg.action) {
      case 'chat': {
        try {
          await conversation.handleChat(msg.message, msg.projectId, (data) => ws.send(data), { source: 'text' });
        } catch (e) {
          console.error('Chat handler crash:', e.message);
          ws.send({ type: 'error', message: `Chat error: ${e.message}` });
          ws.send({ type: 'stream-end', tier: 'sonnet', label: 'SONNET' });
        }
        break;
      }

      case 'list-projects': {
        const projects = loadProjects().map(p => ({ ...p, milestones: loadMilestones(p.id) }));
        ws.send({ type: 'projects', projects });
        break;
      }

      case 'get-conversation': {
        const msgs = deps.loadConversation(msg.convId || 'general');
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

      case 'get-tasks': {
        const tasks = taskManager.getAllTasks();
        ws.send({ type: 'tasks', tasks: tasks.map(t => taskManager.taskSummary(t)) });
        break;
      }

      case 'get-task-log': {
        const log = taskManager.readLog(msg.taskId);
        ws.send({ type: 'task-log', taskId: msg.taskId, log });
        break;
      }

      // ─── Memory System Actions ───
      case 'get-daily-notes': {
        const notes = memory.listDailyNotes(msg.limit || 30);
        ws.send({ type: 'daily-notes', notes });
        break;
      }

      case 'get-daily-note': {
        const note = memory.readDailyNote(msg.date);
        ws.send({ type: 'daily-note', date: msg.date, content: note });
        break;
      }

      case 'get-vector-stats': {
        ws.send({ type: 'vector-stats', stats: vectorMemory.getStats() });
        break;
      }

      case 'get-curation-history': {
        ws.send({ type: 'curation-history', entries: memory.getCurationHistory(msg.limit || 50) });
        break;
      }

      case 'get-memory-md': {
        ws.send({ type: 'memory-md', content: memory.readMemoryMd() });
        break;
      }

      case 'get-projects-md': {
        ws.send({ type: 'projects-md', content: memory.readProjectsMd() });
        break;
      }

      case 'get-telemetry': {
        const sysInfo = await getSystemInfo('all');
        const costStats = costs.getStats('today');
        const costWeek = costs.getStats('week');
        const running = taskManager.getRunningTask();
        const queued = taskManager.getAllTasks({ status: 'queued' });
        ws.send({
          type: 'telemetry',
          system: sysInfo,
          costs: { today: costStats, week: costWeek },
          tasks: { running: running ? taskManager.taskSummary(running) : null, queuedCount: queued.length },
        });
        break;
      }

      // ─── Project State Actions ───
      case 'get-project-state': {
        const projects = loadProjects();
        const project = projects.find(p => p.id === msg.projectId);
        if (!project) { ws.send({ type: 'error', message: 'Project not found' }); break; }
        projectState.initProjectState(msg.projectId, project.name, project.directory);
        ws.send({ type: 'project-state', projectId: msg.projectId, state: projectState.getProjectStatus(msg.projectId) });
        break;
      }

      case 'get-all-project-states': {
        ws.send({ type: 'all-project-states', states: projectState.getAllStates() });
        break;
      }

      // ─── Execution Layer Actions ───
      case 'get-execution-logs': {
        const logs = executionLogger.readLogs(msg.limit || 50, msg.filter);
        ws.send({ type: 'execution-logs', logs });
        break;
      }

      case 'get-execution-stats': {
        ws.send({ type: 'execution-stats', stats: executionLogger.getStats() });
        break;
      }

      // ─── Spatial Interface Actions ───
      case 'get-spatial-data': {
        const projects = loadProjects().map(p => ({
          ...p, milestones: loadMilestones(p.id), state: projectState.getProjectStatus(p.id),
        }));
        const tasks = taskManager.getAllTasks().map(t => taskManager.taskSummary(t));
        const costStats = costs.getStats('today');
        const sysInfo = await getSystemInfo('all');
        const pending = brain.getPendingUpdates();
        const allStates = projectState.getAllStates();
        const taskDashboard = taskIntelligence.getDashboard();
        ws.send({
          type: 'spatial-data', projects, tasks,
          costs: costStats, system: sysInfo,
          pendingBrainUpdates: pending, projectStates: allStates,
          taskIntelligence: taskDashboard,
        });
        break;
      }

      // ─── Task Intelligence Direct Actions ───
      case 'complete-user-task': {
        const task = taskIntelligence.completeUserTask(msg.taskId);
        ws.send({ type: 'user-task-completed', taskId: msg.taskId, success: !!task });
        break;
      }

      case 'dismiss-user-task': {
        const task = taskIntelligence.dismissUserTask(msg.taskId);
        ws.send({ type: 'user-task-dismissed', taskId: msg.taskId, success: !!task });
        break;
      }

      case 'classify-project': {
        const projects = loadProjects();
        const idx = projects.findIndex(p => p.id === msg.projectId);
        if (idx === -1) { ws.send({ type: 'error', message: 'Project not found' }); break; }
        projects[idx].layer = msg.layer || 2;
        projects[idx].projectType = msg.projectType || 'venture';
        saveProjects(projects);
        ws.send({ type: 'project-classified', projectId: msg.projectId, layer: projects[idx].layer, projectType: projects[idx].projectType });
        break;
      }

      case 'create-project': {
        const projects = loadProjects();
        const newProj = {
          id: crypto.randomUUID(), name: msg.name || 'Untitled',
          description: msg.description || '', directory: msg.directory || '',
          layer: msg.layer || null, projectType: msg.projectType || null,
          createdAt: new Date().toISOString(),
        };
        projects.push(newProj);
        saveProjects(projects);
        ws.send({ type: 'project-created', project: newProj });
        break;
      }

      // ─── Voice System Actions ───
      case 'voice-start': {
        if (!voiceSystem) { ws.send({ type: 'voice-error', component: 'system', message: 'Voice system not initialized' }); break; }
        if (msg.config) voiceSystem.updateConfig(msg.config);
        const started = await voiceSystem.start();
        if (!started) ws.send({ type: 'voice-error', component: 'system', message: 'Voice system failed to start' });
        break;
      }

      case 'voice-stop': { if (voiceSystem) voiceSystem.stop(); break; }
      case 'voice-mute': { if (voiceSystem) voiceSystem.mute(); break; }
      case 'voice-unmute': { if (voiceSystem) voiceSystem.unmute(); break; }

      case 'voice-configure': {
        if (voiceSystem && msg.config) voiceSystem.updateConfig(msg.config);
        ws.send({ type: 'voice-configured', config: msg.config });
        break;
      }

      case 'voice-status': {
        ws.send({ type: 'voice-status', status: voiceSystem ? voiceSystem.getStatus() : { state: 'unavailable' } });
        break;
      }

      default:
        ws.send({ type: 'error', message: `Unknown action: ${msg.action}` });
    }
  }

  // ─── HTTP Server ──────────────────────────────────────────────────────

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // API endpoints
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'online', uptime: process.uptime(), model: 'claude-sonnet-4-6',
        hasKey: !!ANTHROPIC_KEY, tiers: ['sonnet', 'claude-code'],
        memory: { vectors: vectorMemory.getStats().totalEntries, dailyNotes: memory.listDailyNotes(1).length > 0 },
      }));
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
      if (content !== '') { res.writeHead(200, { 'Content-Type': 'text/markdown' }); res.end(content); }
      else { res.writeHead(404); res.end('Brain file not found'); }
      return;
    }

    // Serve UI pages
    const pages = { '/': 'index.html', '/index.html': 'index.html', '/costs': 'costs.html', '/costs.html': 'costs.html', '/brain': 'brain.html', '/brain.html': 'brain.html', '/spatial': 'spatial.html', '/spatial.html': 'spatial.html' };
    const page = pages[url.pathname];
    if (page) { return serveFile(res, page); }

    // Static files
    const STATIC_TYPES = { '.js': 'application/javascript', '.css': 'text/css' };
    const ext = path.extname(url.pathname);
    if (STATIC_TYPES[ext]) {
      const fp = path.join(__dirname, url.pathname.replace(/^\//, ''));
      if (fs.existsSync(fp)) { res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext] }); res.end(fs.readFileSync(fp)); return; }
    }

    res.writeHead(404); res.end('Not found');
  });

  function serveFile(res, filename) {
    const fp = path.join(__dirname, filename);
    if (fs.existsSync(fp)) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(fp)); }
    else { res.writeHead(404); res.end('Not found'); }
  }

  // ─── WebSocket Server ─────────────────────────────────────────────────

  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (socket) => {
    const ws = {
      send(data) {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(typeof data === 'string' ? data : JSON.stringify(data));
          }
        } catch {}
      },
    };
    clients.add(ws);
    ws.send({ type: 'connected', model: 'claude-sonnet-4-6', hasKey: !!ANTHROPIC_KEY, tier: 'sonnet' });
    socket.on('message', (raw) => {
      try { handleMessage(ws, JSON.parse(raw.toString())); }
      catch { handleMessage(ws, { raw: raw.toString() }); }
    });
    socket.on('close', () => clients.delete(ws));
  });

  return { server, wss, clients, broadcast };
}

/**
 * Wire voice system events to broadcast to all WS clients.
 */
function wireVoiceEvents(voiceSystem, clients) {
  const voiceEvents = [
    ['state-change', (data) => ({ type: 'voice-state', state: data.to, from: data.from })],
    ['started', (data) => ({ type: 'voice-started', ...data })],
    ['stopped', () => ({ type: 'voice-stopped' })],
    ['transcription', (data) => ({ type: 'voice-transcription', text: data.text, duration: data.duration })],
    ['response', (data) => ({ type: 'voice-response', text: data.text, latency: data.totalLatency })],
    ['error', (data) => { console.error(`Voice error [${data.component}]:`, data.error?.message || data.error); return { type: 'voice-error', component: data.component, message: data.error?.message || String(data.error) }; }],
    ['interrupted', () => ({ type: 'voice-interrupted' })],
    ['speech-start', () => ({ type: 'voice-speech-start' })],
    ['backends-detected', (data) => { console.log(`  Voice STT: ${data.stt.backend || data.stt.model || 'none'} (${data.stt.type || 'batch'})`); console.log(`  Voice TTS: ${data.tts.backend || 'none'}`); return { type: 'voice-backends', ...data }; }],
    ['partial-transcript', (data) => ({ type: 'voice-partial', text: data.text })],
    ['dismissal', (data) => { console.log(`  Voice: Dismissed ("${data.text}")`); return { type: 'voice-dismissal', text: data.text, response: data.response }; }],
    ['backchannel', (data) => ({ type: 'voice-backchannel', text: data.text })],
    ['filler', (data) => ({ type: 'voice-filler', text: data.text })],
  ];

  for (const [event, transform] of voiceEvents) {
    voiceSystem.on(event, (data) => {
      const msg = transform(data);
      for (const client of clients) {
        try { client.send(msg); } catch {}
      }
    });
  }
}

module.exports = { createServer, wireVoiceEvents };
