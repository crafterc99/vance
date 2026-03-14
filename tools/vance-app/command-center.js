/**
 * VANCE Command Center — Main Controller
 * Single IIFE containing all logic: WebSocket, chat, streaming, projects,
 * voice, ticker, telemetry, task card, and particle bridge.
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════════
  const state = {
    ws: null,
    projects: [],
    activeProject: null,
    isBusy: false,
    // Streaming
    streamingMsg: null,
    streamBubble: null,
    streamRaw: '',
    streamTools: [],
    // Voice
    recognition: null,
    isRecording: false,
    audioCtx: null,
    analyser: null,
    voiceAnimFrame: null,
    // Ticker
    events: [],
    maxEvents: 50,
    // Busy safety timeout
    busyTimer: null,
    lastActivity: 0,
    // Telemetry
    telemetry: null,
    telemetryInterval: null,
    costHistory: [], // for sparkline
    // Task card
    runningTask: null,
    taskStartTime: null,
    taskTimerInterval: null,
    // Welcome
    typewriterDone: false,
    // Model tier
    currentTier: 'haiku',
    currentLabel: 'HAIKU',
  };

  // ═══════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function timeLabel() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function timeShort() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function scrollBottom() {
    const el = $('#messages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function renderMd(text) {
    if (!text) return '';
    if (typeof marked !== 'undefined') {
      try {
        return marked.parse(text);
      } catch (e) {
        // Fallback to basic renderer
      }
    }
    return renderMdBasic(text);
  }

  // Basic markdown fallback (from original index.html)
  function renderMdBasic(text) {
    let t = text;
    t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    t = t.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code}</code></pre>`);
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    t = t.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    t = t.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    t = t.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
    t = t.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    t = t.replace(/^---$/gm, '<hr>');
    t = t.replace(/^- (.+)$/gm, '<li>$1</li>');
    t = t.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    t = t.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    t = t.replace(/\n\n/g, '</p><p>');
    t = t.replace(/\n/g, '<br>');
    if (!t.startsWith('<')) t = '<p>' + t + '</p>';
    t = t.replace(/<p><\/p>/g, '');
    t = t.replace(/<p>(<h[1-3]>)/g, '$1');
    t = t.replace(/(<\/h[1-3]>)<\/p>/g, '$1');
    t = t.replace(/<p>(<pre>)/g, '$1');
    t = t.replace(/(<\/pre>)<\/p>/g, '$1');
    t = t.replace(/<p>(<ul>)/g, '$1');
    t = t.replace(/(<\/ul>)<\/p>/g, '$1');
    t = t.replace(/<p>(<blockquote>)/g, '$1');
    t = t.replace(/(<\/blockquote>)<\/p>/g, '$1');
    t = t.replace(/<p>(<hr>)<\/p>/g, '$1');
    return t;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // marked.js Configuration
  // ═══════════════════════════════════════════════════════════════════════
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      breaks: true,
      gfm: true,
      headerIds: false,
      mangle: false,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WebSocket
  // ═══════════════════════════════════════════════════════════════════════
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    state.ws = new WebSocket(`${proto}//${location.host}/ws`);

    state.ws.onopen = () => {
      setStatus('online', 'Online');
      wsSend({ action: 'list-projects' });
      wsSend({ action: 'get-memories' });
      wsSend({ action: 'get-skills' });
      wsSend({ action: 'get-telemetry' });
      wsSend({ action: 'get-tasks' });
      startTelemetryPolling();
    };

    state.ws.onclose = () => {
      setStatus('offline', 'Offline');
      stopTelemetryPolling();
      setTimeout(connect, 3000);
    };

    state.ws.onerror = () => setStatus('offline', 'Error');
    state.ws.onmessage = (e) => handle(JSON.parse(e.data));
  }

  function wsSend(d) {
    if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(d));
  }

  function setStatus(s, t) {
    const dot = $('#statusDot');
    if (dot) dot.className = 'status-dot ' + s;
    const label = $('#statusText');
    if (label) label.textContent = t;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Message Handler
  // ═══════════════════════════════════════════════════════════════════════
  function handle(d) {
    switch (d.type) {
      case 'connected':
        if (!d.hasKey) {
          setStatus('nokey', 'No API Key');
          const w = $('#keyWarning');
          if (w) w.style.display = 'block';
        }
        if (d.tier) updateTierIndicator(d.tier, d.tier.toUpperCase());
        break;

      case 'projects':
        state.projects = d.projects;
        renderProjects();
        break;

      case 'project-created':
        state.projects.push({ ...d.project, milestones: [] });
        renderProjects();
        selectProject(d.project.id);
        hideModal();
        addEvent('task', `Project created: ${d.project.name}`);
        break;

      case 'thinking':
        setStatus('busy', d.label ? `${d.label}` : 'Thinking');
        state.isBusy = true;
        showThinking();
        startBusyWatchdog();
        addEvent('chat', `Processing via ${d.label || 'AI'}...`);
        break;

      case 'model-tier':
        state.currentTier = d.tier;
        state.currentLabel = d.label;
        updateTierIndicator(d.tier, d.label);
        if (d.reason && d.reason.startsWith('Escalated')) {
          addEvent('task', `Model escalated to ${d.label}: ${d.reason}`);
        }
        break;

      case 'stream-token':
        removeThinking();
        resetBusyWatchdog();
        appendStreamToken(d.content);
        break;

      case 'stream-end':
        finalizeStream(d.tier || state.currentTier, d.label || state.currentLabel);
        setStatus('online', 'Online');
        state.isBusy = false;
        clearBusyWatchdog();
        break;

      case 'response':
        removeThinking();
        finalizeStream();
        if (d.content) addMsg('assistant', d.content);
        setStatus('online', 'Online');
        state.isBusy = false;
        clearBusyWatchdog();
        break;

      case 'status':
        resetBusyWatchdog();
        updateThinking(d.text);
        break;

      case 'claude-stream':
        resetBusyWatchdog();
        appendStreamToken(d.content);
        break;

      case 'claude-tool':
      case 'function-call':
        removeThinking();
        resetBusyWatchdog();
        appendToolBadge(d.name);
        addEvent('tool', d.name);
        break;

      case 'tool-done':
        break;

      case 'milestone':
        appendMilestone(d.title);
        refreshMilestones();
        addEvent('milestone', d.title);
        speak('Milestone: ' + d.title);
        if (window.particlePulse) window.particlePulse();
        break;

      case 'error':
        setStatus('online', 'Online');
        state.isBusy = false;
        clearBusyWatchdog();
        removeThinking();
        finalizeStream();
        addMsg('assistant', 'Error: ' + d.message);
        addEvent('error', d.message);
        break;

      case 'conversation':
        renderConv(d.messages);
        break;

      case 'milestones':
        renderMilestones(d.milestones);
        break;

      case 'memories': {
        const count = d.stats?.total || 0;
        const el = $('#memCount');
        if (el) el.textContent = count;
        updateReadout('memories', count);
        break;
      }

      case 'skills': {
        const count = d.skills?.length || 0;
        const el = $('#skillCount');
        if (el) el.textContent = count;
        updateReadout('skills', count);
        break;
      }

      case 'telemetry':
        state.telemetry = d;
        renderTelemetry(d);
        break;

      case 'tasks':
        if (d.tasks) renderTaskList(d.tasks);
        break;

      // ─── Task Manager Events ───
      case 'task-queued':
        addEvent('task', `Queued: ${d.title || d.taskId}`);
        break;

      case 'task-started':
        state.runningTask = d;
        state.taskStartTime = Date.now();
        showTaskCard(d);
        addEvent('task', `Started: ${d.title || d.taskId}`);
        break;

      case 'task-stream':
        updateTaskStream(d.content);
        break;

      case 'task-tool':
        addTaskTool(d.name);
        addEvent('tool', `[Task] ${d.name}`);
        break;

      case 'task-milestone':
        addTaskMilestone(d.detail || d.type);
        addEvent('milestone', `[Task] ${d.detail || d.type}`);
        if (window.particlePulse) window.particlePulse();
        break;

      case 'task-completed':
        addEvent('task', `Completed: ${d.title || d.taskId}`);
        hideTaskCard();
        if (window.particlePulse) window.particlePulse();
        break;

      case 'task-failed':
        addEvent('error', `Task failed: ${d.error || d.taskId}`);
        hideTaskCard();
        break;

      case 'task-retrying':
        addEvent('task', `Retrying: ${d.title || d.taskId}`);
        break;

      case 'task-paused':
        addEvent('task', `Paused: ${d.title || d.taskId}`);
        hideTaskCard();
        break;

      case 'task-cancelled':
        addEvent('task', `Cancelled: ${d.title || d.taskId}`);
        hideTaskCard();
        break;

      // Store memory events
      case 'memory-stored':
        addEvent('memory', 'Memory stored');
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Projects
  // ═══════════════════════════════════════════════════════════════════════
  function renderProjects() {
    const el = $('#projectList');
    if (!el) return;
    el.innerHTML = '';

    // General node
    const gc = document.createElement('div');
    gc.className = 'project-node' + (state.activeProject === null ? ' active' : '');
    gc.onclick = () => selectProject(null);
    gc.innerHTML = '<h4>General</h4><p>No project context</p>';
    el.appendChild(gc);

    for (const p of state.projects) {
      const c = document.createElement('div');
      c.className = 'project-node' + (p.id === state.activeProject ? ' active' : '');
      c.onclick = () => selectProject(p.id);
      const mc = p.milestones?.length || 0;
      c.innerHTML = `<h4>${esc(p.name)}</h4><p>${esc(p.description || p.directory || '')}</p>${mc ? `<div class="project-progress"><div class="fill" style="width:${Math.min(mc * 12, 100)}%"></div></div>` : ''}`;
      el.appendChild(c);
    }

    updateReadout('projects', state.projects.length);
  }

  function selectProject(id) {
    state.activeProject = id;
    renderProjects();
    wsSend({ action: 'get-conversation', convId: id || 'general' });
    if (id) {
      wsSend({ action: 'get-milestones', projectId: id });
    }
  }

  function renderConv(msgs) {
    const el = $('#messages');
    if (!el) return;
    el.innerHTML = '';
    state.streamingMsg = null;
    state.streamBubble = null;
    state.streamRaw = '';
    state.streamTools = [];

    if (!msgs.length) {
      showWelcome();
      return;
    }

    for (const m of msgs) {
      if (m.role === 'user' || m.role === 'assistant') addMsgDirect(m.role, m.content, false);
    }
    scrollBottom();
  }

  function renderMilestones(ms) {
    // Milestones no longer shown in sidebar, but we can add to ticker
    if (ms?.length) {
      // Just update readout, milestones are in the ticker now
    }
  }

  function refreshMilestones() {
    if (state.activeProject) wsSend({ action: 'get-milestones', projectId: state.activeProject });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Welcome Screen
  // ═══════════════════════════════════════════════════════════════════════
  function showWelcome() {
    const el = $('#messages');
    if (!el) return;
    el.innerHTML = `
      <div class="welcome" id="welcome">
        <div class="orb-wrap">
          <div class="orb"></div>
          <div class="orb-ring orb-ring--1"></div>
          <div class="orb-ring orb-ring--2"></div>
        </div>
        <div class="welcome-logo">VANCE</div>
        <div class="welcome-sub" id="welcomeSub"></div>
        <div class="welcome-hint">Type or hold the mic to speak</div>
        <div class="key-warning" id="keyWarning" style="display:none">
          No Anthropic API key set.<br>Add <code>ANTHROPIC_API_KEY=sk-ant-...</code> to .env then restart.
        </div>
      </div>
    `;
    typewriterEffect();
  }

  function typewriterEffect() {
    const el = $('#welcomeSub');
    if (!el) return;
    const text = state.activeProject
      ? 'Ready to work on this project. Standing by for orders.'
      : 'Your personal AI command center. Talk naturally — I\'ll build, manage, and ship your projects.';
    let i = 0;
    el.innerHTML = '<span class="typewriter-cursor"></span>';

    function tick() {
      if (i < text.length) {
        el.innerHTML = esc(text.substring(0, i + 1)) + '<span class="typewriter-cursor"></span>';
        i++;
        setTimeout(tick, 30);
      } else {
        el.innerHTML = esc(text);
        state.typewriterDone = true;
      }
    }
    tick();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Messages
  // ═══════════════════════════════════════════════════════════════════════
  function addMsg(role, content) {
    addMsgDirect(role, content, true);
  }

  function addMsgDirect(role, content, scroll = true) {
    const welcome = $('#welcome');
    if (welcome) welcome.remove();
    const el = $('#messages');
    if (!el) return;
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    const rendered = role === 'assistant' ? renderMd(content || '') : esc(content || '');
    d.innerHTML = `<div class="bubble">${rendered}</div><div class="meta">${timeLabel()}</div>`;
    el.appendChild(d);
    if (scroll) scrollBottom();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Streaming
  // ═══════════════════════════════════════════════════════════════════════
  function appendStreamToken(text) {
    if (!state.streamingMsg) {
      const welcome = $('#welcome');
      if (welcome) welcome.remove();
      const el = $('#messages');
      if (!el) return;
      state.streamingMsg = document.createElement('div');
      state.streamingMsg.className = 'msg assistant';
      state.streamBubble = document.createElement('div');
      state.streamBubble.className = 'bubble';
      state.streamBubble.innerHTML = '<span class="stream-cursor"></span>';
      state.streamingMsg.appendChild(state.streamBubble);
      el.appendChild(state.streamingMsg);
      state.streamRaw = '';
      state.streamTools = [];
    }
    state.streamRaw += text;
    const cursor = '<span class="stream-cursor"></span>';
    state.streamBubble.innerHTML = renderMd(state.streamRaw) + cursor;
    // Re-add tool badges
    if (state.streamTools.length) {
      let toolsDiv = state.streamBubble.querySelector('.msg-tools');
      if (!toolsDiv) {
        toolsDiv = document.createElement('div');
        toolsDiv.className = 'msg-tools';
        state.streamBubble.appendChild(toolsDiv);
      }
      toolsDiv.innerHTML = state.streamTools
        .map((n) => `<span class="fn-badge done"><span class="fn-icon">&#9670;</span> ${esc(n)}</span>`)
        .join('');
    }
    scrollBottom();
  }

  function appendToolBadge(name) {
    state.streamTools.push(name);
    if (!state.streamingMsg) {
      const welcome = $('#welcome');
      if (welcome) welcome.remove();
      const el = $('#messages');
      if (!el) return;
      state.streamingMsg = document.createElement('div');
      state.streamingMsg.className = 'msg assistant';
      state.streamBubble = document.createElement('div');
      state.streamBubble.className = 'bubble';
      state.streamingMsg.appendChild(state.streamBubble);
      el.appendChild(state.streamingMsg);
      state.streamRaw = '';
    }
    let toolsDiv = state.streamBubble.querySelector('.msg-tools');
    if (!toolsDiv) {
      toolsDiv = document.createElement('div');
      toolsDiv.className = 'msg-tools';
      state.streamBubble.appendChild(toolsDiv);
    }
    toolsDiv.innerHTML = state.streamTools
      .map((n) => `<span class="fn-badge"><span class="fn-icon">&#9670;</span> ${esc(n)}</span>`)
      .join('');
    scrollBottom();
  }

  function finalizeStream(tier, label) {
    if (state.streamingMsg) {
      const cursor = state.streamBubble.querySelector('.stream-cursor');
      if (cursor) cursor.remove();
      if (state.streamRaw) {
        state.streamBubble.innerHTML = renderMd(state.streamRaw);
        if (state.streamTools.length) {
          const toolsDiv = document.createElement('div');
          toolsDiv.className = 'msg-tools';
          toolsDiv.innerHTML = state.streamTools
            .map((n) => `<span class="fn-badge done"><span class="fn-icon">&#9670;</span> ${esc(n)}</span>`)
            .join('');
          state.streamBubble.appendChild(toolsDiv);
        }
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      const tierBadge = tier ? `<span class="tier-badge tier-${tier}">${esc(label || tier.toUpperCase())}</span> ` : '';
      meta.innerHTML = tierBadge + esc(timeLabel());
      state.streamingMsg.appendChild(meta);
      speak(summarize(state.streamRaw));
    }
    state.streamingMsg = null;
    state.streamBubble = null;
    state.streamRaw = '';
    state.streamTools = [];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Thinking Indicator
  // ═══════════════════════════════════════════════════════════════════════
  function showThinking() {
    removeThinking();
    const el = $('#messages');
    if (!el) return;
    const d = document.createElement('div');
    d.className = 'thinking-bar';
    d.id = 'thinkInd';
    d.innerHTML =
      '<div class="thinking-dots"><span></span><span></span><span></span></div><span class="thinking-text" id="thinkLabel">Thinking</span>';
    el.appendChild(d);
    scrollBottom();
  }

  function updateThinking(t) {
    const l = $('#thinkLabel');
    if (l) l.textContent = t;
  }

  function removeThinking() {
    const el = $('#thinkInd');
    if (el) el.remove();
  }

  function appendMilestone(title) {
    const el = $('#messages');
    if (!el) return;
    const d = document.createElement('div');
    d.className = 'milestone-bubble';
    d.innerHTML = `<span class="m-icon">&#9670;</span><span class="m-text">${esc(title)}</span>`;
    el.appendChild(d);
    scrollBottom();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Busy Watchdog — auto-unlock if no activity for 60s
  // ═══════════════════════════════════════════════════════════════════════
  function startBusyWatchdog() {
    clearBusyWatchdog();
    state.lastActivity = Date.now();
    state.busyTimer = setInterval(() => {
      if (!state.isBusy) { clearBusyWatchdog(); return; }
      if (Date.now() - state.lastActivity > 60000) {
        console.warn('[Vance] Busy watchdog triggered — force unlocking input after 60s inactivity');
        state.isBusy = false;
        clearBusyWatchdog();
        setStatus('online', 'Online');
        removeThinking();
        finalizeStream();
        addEvent('error', 'Response timed out — input unlocked');
      }
    }, 5000);
  }

  function resetBusyWatchdog() {
    state.lastActivity = Date.now();
  }

  function clearBusyWatchdog() {
    if (state.busyTimer) {
      clearInterval(state.busyTimer);
      state.busyTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Input / Send
  // ═══════════════════════════════════════════════════════════════════════
  function send() {
    const inp = $('#inputField');
    if (!inp) return;
    const text = inp.value.trim();
    if (!text || state.isBusy) return;
    finalizeStream();
    addMsg('user', text);
    addEvent('chat', text.length > 60 ? text.substring(0, 60) + '...' : text);
    wsSend({ action: 'chat', message: text, projectId: state.activeProject });
    inp.value = '';
    inp.style.height = 'auto';
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Voice
  // ═══════════════════════════════════════════════════════════════════════
  function startVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    state.recognition = new SR();
    state.recognition.continuous = false;
    state.recognition.interimResults = true;
    state.recognition.lang = 'en-US';
    let final = '';
    const inp = $('#inputField');

    state.recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      if (inp) inp.value = final + interim;
    };

    state.recognition.onend = () => {
      state.isRecording = false;
      const btn = $('#voiceBtn');
      if (btn) btn.classList.remove('recording');
      stopVoiceWaveform();
      if (final.trim()) {
        if (inp) inp.value = final.trim();
        setTimeout(send, 300);
      }
    };

    state.recognition.start();
    state.isRecording = true;
    const btn = $('#voiceBtn');
    if (btn) btn.classList.add('recording');
    startVoiceWaveform();
  }

  function stopVoice() {
    if (state.recognition && state.isRecording) state.recognition.stop();
  }

  // Voice Waveform Canvas
  function startVoiceWaveform() {
    const canvas = $('#voiceWaveform');
    if (!canvas) return;
    canvas.classList.add('active');

    if (!state.audioCtx) {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const source = state.audioCtx.createMediaStreamSource(stream);
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = 256;
      source.connect(state.analyser);

      const ctx = canvas.getContext('2d');
      const bufferLength = state.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      function draw() {
        if (!state.isRecording) return;
        state.voiceAnimFrame = requestAnimationFrame(draw);
        state.analyser.getByteFrequencyData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const barWidth = canvas.width / bufferLength * 2.5;
        let x = 0;
        for (let i = 0; i < bufferLength; i++) {
          const barHeight = (dataArray[i] / 255) * canvas.height;
          ctx.fillStyle = `rgba(255, 51, 85, ${dataArray[i] / 255 * 0.8})`;
          ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
          x += barWidth;
        }
      }
      draw();

      // Store stream to stop later
      state._voiceStream = stream;
    }).catch(() => {});
  }

  function stopVoiceWaveform() {
    const canvas = $('#voiceWaveform');
    if (canvas) canvas.classList.remove('active');
    if (state.voiceAnimFrame) cancelAnimationFrame(state.voiceAnimFrame);
    if (state._voiceStream) {
      state._voiceStream.getTracks().forEach((t) => t.stop());
      state._voiceStream = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Speech Output
  // ═══════════════════════════════════════════════════════════════════════
  function speak(text) {
    if (!text || !window.speechSynthesis) return;
    const clean = text
      .replace(/```[\s\S]*?```/g, 'code block')
      .replace(/`[^`]+`/g, '')
      .replace(/<[^>]+>/g, '')
      .substring(0, 300);
    if (!clean.trim()) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.05;
    u.pitch = 0.95;
    const voices = speechSynthesis.getVoices();
    const pref = voices.find(
      (v) => v.name.includes('Daniel') || v.name.includes('Alex') || v.name.includes('Samantha')
    );
    if (pref) u.voice = pref;
    speechSynthesis.speak(u);
  }

  function summarize(t) {
    if (!t) return '';
    const s = t.split(/[.!?\n]/)[0];
    return s.length > 200 ? s.substring(0, 200) : s;
  }

  if (window.speechSynthesis) {
    speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices());
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Activity Ticker
  // ═══════════════════════════════════════════════════════════════════════
  function addEvent(type, desc) {
    const event = { type, desc, time: timeShort() };
    state.events.unshift(event);
    if (state.events.length > state.maxEvents) state.events.pop();
    renderTickerEvent(event);
  }

  function renderTickerEvent(event) {
    const feed = $('#tickerFeed');
    if (!feed) return;

    const el = document.createElement('div');
    el.className = 'ticker-event';

    const iconMap = {
      task: '&#9654;',
      tool: '&#9881;',
      milestone: '&#9670;',
      memory: '&#9733;',
      error: '&#9888;',
      chat: '&#9679;',
    };

    el.innerHTML = `
      <span class="ticker-time">${esc(event.time)}</span>
      <span class="ticker-icon ${event.type}">${iconMap[event.type] || '&#9679;'}</span>
      <span class="ticker-desc">${esc(event.desc)}</span>
    `;

    feed.prepend(el);

    // Trim excess
    while (feed.children.length > state.maxEvents) {
      feed.removeChild(feed.lastChild);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Telemetry
  // ═══════════════════════════════════════════════════════════════════════
  function startTelemetryPolling() {
    stopTelemetryPolling();
    state.telemetryInterval = setInterval(() => {
      wsSend({ action: 'get-telemetry' });
    }, 10000);
  }

  function stopTelemetryPolling() {
    if (state.telemetryInterval) {
      clearInterval(state.telemetryInterval);
      state.telemetryInterval = null;
    }
  }

  function renderTelemetry(data) {
    if (!data) return;

    // CPU gauge
    renderCpuGauge(data.system?.cpu);

    // Memory bar
    const memPct = parseFloat(data.system?.memory?.percent) || 0;
    renderBarGauge('memBar', memPct, data.system?.memory?.used || '?');

    // Disk bar
    const diskPct = parseFloat(data.system?.disk?.percent) || 0;
    renderBarGauge('diskBar', diskPct, data.system?.disk?.used || '?');

    // Cost
    renderCostWidget(data.costs);

    // Update top bar cost
    const costPill = $('#costPill');
    if (costPill) {
      const todayTotal = data.costs?.today?.totalCost || 0;
      costPill.textContent = `Today $${todayTotal.toFixed(2)}`;
    }
  }

  function renderCpuGauge(cpu) {
    const el = $('#cpuGauge');
    if (!el || !cpu) return;

    // Use load average as percentage (load / cores * 100)
    const load1 = cpu.load?.[0] || 0;
    const cores = cpu.cores || 1;
    const pct = Math.min(Math.round((load1 / cores) * 100), 100);

    const color = pct < 50 ? '#00e5a0' : pct < 80 ? '#ffa040' : '#ff3355';
    const circumference = 2 * Math.PI * 35;
    const offset = circumference - (pct / 100) * circumference;

    el.innerHTML = `
      <svg viewBox="0 0 80 80">
        <circle cx="40" cy="40" r="35" fill="none" stroke="rgba(30,30,50,0.5)" stroke-width="4"/>
        <circle cx="40" cy="40" r="35" fill="none" stroke="${color}" stroke-width="4"
          stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
          stroke-linecap="round" transform="rotate(-90 40 40)"
          style="transition: stroke-dashoffset 0.5s ease"/>
      </svg>
      <div class="cpu-gauge-text">${pct}%</div>
    `;
  }

  function renderBarGauge(id, pct, label) {
    const el = $(`#${id}`);
    if (!el) return;
    const colorClass = pct < 60 ? 'green' : pct < 85 ? 'yellow' : 'red';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:2px">
        <span class="telem-value" style="font-size:10px">${Math.round(pct)}%</span>
        <span style="font-family:var(--mono);font-size:8px;color:var(--text-muted)">${esc(String(label))}</span>
      </div>
      <div class="bar-gauge"><div class="bar-gauge-fill ${colorClass}" style="width:${pct}%"></div></div>
    `;
  }

  function renderCostWidget(costs) {
    const el = $('#costWidget');
    if (!el) return;

    const todayTotal = costs?.today?.totalCost || 0;

    // Build sparkline data from week stats if available
    const weekData = costs?.week;
    let sparklineHtml = '';
    if (weekData?.byDay && Object.keys(weekData.byDay).length > 0) {
      const days = Object.entries(weekData.byDay).sort((a, b) => a[0].localeCompare(b[0])).slice(-7);
      const vals = days.map(([, v]) => v.cost || 0);
      const max = Math.max(...vals, 0.01);
      const sparkPoints = vals.map((v, i) => `${(i / Math.max(vals.length - 1, 1)) * 100},${100 - (v / max) * 80}`).join(' ');
      sparklineHtml = `
        <div class="sparkline-container">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="sparkline-canvas" style="width:100%;height:24px">
            <polyline points="${sparkPoints}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
          </svg>
        </div>
      `;
    }

    el.innerHTML = `
      <div class="telem-value" style="color:var(--green)">$${todayTotal.toFixed(2)}</div>
      <div style="font-family:var(--mono);font-size:7px;color:var(--text-muted);margin-top:2px">TODAY</div>
      ${sparklineHtml}
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Task Card
  // ═══════════════════════════════════════════════════════════════════════
  function showTaskCard(data) {
    const card = $('#taskCard');
    if (!card) return;

    const title = data.title || data.prompt?.substring(0, 60) || 'Running task...';
    const tier = data.tier || 'sonnet';
    const model = data.model || '';

    $('#taskTitle').textContent = title;
    const badge = $('#taskModelBadge');
    if (badge) {
      badge.className = 'model-badge ' + tier;
      badge.textContent = tier.toUpperCase();
    }

    const terminal = $('#taskTerminal');
    if (terminal) terminal.textContent = '';

    const milestones = $('#taskMilestones');
    if (milestones) milestones.innerHTML = '';

    const tools = $('#taskTools');
    if (tools) tools.innerHTML = '';

    // Start elapsed timer
    state.taskStartTime = Date.now();
    updateTaskTimer();
    state.taskTimerInterval = setInterval(updateTaskTimer, 1000);

    // Show with animation
    requestAnimationFrame(() => {
      card.style.display = 'block';
      requestAnimationFrame(() => card.classList.add('visible'));
    });
  }

  function hideTaskCard() {
    const card = $('#taskCard');
    if (card) {
      card.classList.remove('visible');
      setTimeout(() => { card.style.display = 'none'; }, 400);
    }
    if (state.taskTimerInterval) {
      clearInterval(state.taskTimerInterval);
      state.taskTimerInterval = null;
    }
    state.runningTask = null;
  }

  function updateTaskTimer() {
    const el = $('#taskElapsed');
    if (!el || !state.taskStartTime) return;
    const elapsed = Math.floor((Date.now() - state.taskStartTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    el.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
  }

  function updateTaskStream(content) {
    const terminal = $('#taskTerminal');
    if (!terminal) return;
    terminal.textContent += content;
    // Keep scrolled to bottom
    terminal.scrollTop = terminal.scrollHeight;
    // Trim if too long
    if (terminal.textContent.length > 5000) {
      terminal.textContent = '...' + terminal.textContent.slice(-4000);
    }
  }

  function addTaskMilestone(text) {
    const el = $('#taskMilestones');
    if (!el) return;
    const chip = document.createElement('span');
    chip.className = 'task-milestone-chip';
    chip.textContent = text;
    el.appendChild(chip);
  }

  function addTaskTool(name) {
    const el = $('#taskTools');
    if (!el) return;
    const badge = document.createElement('span');
    badge.className = 'task-tool-badge';
    badge.textContent = name;
    el.appendChild(badge);
  }

  function renderTaskList(tasks) {
    // If there's a running task, show it
    const running = tasks.find((t) => t.status === 'running');
    if (running && !state.runningTask) {
      state.runningTask = running;
      showTaskCard(running);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // System Readout
  // ═══════════════════════════════════════════════════════════════════════
  function updateReadout(key, value) {
    const el = $(`#readout-${key}`);
    if (el) el.textContent = value;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Model Tier Indicator
  // ═══════════════════════════════════════════════════════════════════════
  function updateTierIndicator(tier, label) {
    const el = $('#tierIndicator');
    if (!el) return;
    el.className = 'tier-indicator tier-' + tier;
    el.textContent = label || tier.toUpperCase();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Modal (New Project)
  // ═══════════════════════════════════════════════════════════════════════
  function showModal() {
    const modal = $('#modal');
    if (modal) modal.classList.add('visible');
    const nameInput = $('#projName');
    if (nameInput) nameInput.focus();
  }

  function hideModal() {
    const modal = $('#modal');
    if (modal) modal.classList.remove('visible');
  }

  function createProject() {
    const n = $('#projName')?.value.trim();
    if (!n) return;
    wsSend({
      action: 'create-project',
      name: n,
      description: $('#projDesc')?.value.trim(),
      directory: $('#projDir')?.value.trim() || undefined,
    });
    if ($('#projName')) $('#projName').value = '';
    if ($('#projDesc')) $('#projDesc').value = '';
    if ($('#projDir')) $('#projDir').value = '';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Bindings
  // ═══════════════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', () => {
    // Input
    const inputField = $('#inputField');
    if (inputField) {
      inputField.addEventListener('keydown', handleKey);
      inputField.addEventListener('input', () => autoResize(inputField));
    }

    // Send
    const sendBtn = $('#sendBtn');
    if (sendBtn) sendBtn.addEventListener('click', send);

    // Voice
    const voiceBtn = $('#voiceBtn');
    if (voiceBtn) {
      voiceBtn.addEventListener('mousedown', startVoice);
      voiceBtn.addEventListener('mouseup', stopVoice);
      voiceBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startVoice(); });
      voiceBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopVoice(); });
    }

    // New project
    const newProjBtn = $('#newProjectBtn');
    if (newProjBtn) newProjBtn.addEventListener('click', showModal);

    // Modal
    const modalOverlay = $('#modal');
    if (modalOverlay) modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) hideModal(); });

    const createBtn = $('#createProjectBtn');
    if (createBtn) createBtn.addEventListener('click', createProject);

    const cancelBtn = $('#cancelModalBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', hideModal);

    // Escape key
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideModal(); });

    // Show welcome
    showWelcome();

    // Connect
    connect();

    // Add initial ticker event
    addEvent('task', 'Command Center initialized');
  });
})();
