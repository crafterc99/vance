(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSTANTS
  // ═══════════════════════════════════════════════════════════════════════════

  const COLORS = {
    accent: 0x4488ff, accentBright: 0x66aaff,
    green: 0x00e5a0, greenDim: 0x009a6a,
    warn: 0xffa040, danger: 0xff3355, purple: 0xa855f7,
    grid: 0x4488ff, particle: 0x4488ff,
    platformBase: 0x181828, platformGlow: 0x4488ff,
    orbCore: 0x4488ff, orbRing: 0x66aaff,
    nodeColor: 0x7070a0, nodeLine: 0x2a2a44,
  };

  const LAYERS = {
    1: { label: 'LAYER 1 \u2014 OPERATIONS', camera: { pos: [0, 2, 8], lookAt: [0, 0, 0] } },
    2: { label: 'LAYER 2 \u2014 CORE PROJECTS', camera: { pos: [0, 4, -5], lookAt: [0, 0, -12] } },
    3: { label: 'LAYER 3 \u2014 EXTERNAL', camera: { pos: [0, 6, -18], lookAt: [0, 0, -30] } },
  };

  const KNOWN_VENTURES = ['soul-jam', 'athletes-blender', 'sos-train', 'vance', 'vantheah', 'promotifyy'];
  const PROJECT_COLORS = {
    'vantheah': '#4488ff', 'promotifyy': '#ff8c00', 'soul-jam': '#00e5a0',
    'athletes-blender': '#ffc940', 'sos-train': '#ff3355', 'vance': '#a855f7',
  };
  const CAMERA_LERP = 0.05;
  const PLATFORM_SPACING = 5;
  const DEFAULT_DAILY_BUDGET = 5.0;

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  let ws = null, wsConnected = false;
  let currentLayer = 1;
  let focusedProject = null, classifyingProject = null;

  let projects = [], tasks = [], costData = {}, systemData = {};
  let pendingBrainUpdates = [];
  let projectStates = {};

  let renderer, scene, camera, clock;
  let centralOrb = null, orbRings = [], particles = null;
  let platformMeshes = [], nodeMeshes = [], connectionLines = [];

  const cam = {
    targetPos: new THREE.Vector3(0, 2, 8),
    targetLookAt: new THREE.Vector3(0, 0, 0),
    currentPos: new THREE.Vector3(0, 2, 8),
    currentLookAt: new THREE.Vector3(0, 0, 0),
    isDragging: false, lastMouse: { x: 0, y: 0 },
    dragStart: { x: 0, y: 0 },
    orbitTheta: 0, orbitPhi: 0.3,
  };

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function $(id) { return document.getElementById(id); }
  function formatCost(n) { return '$' + (n || 0).toFixed(2); }
  function slugify(name) { return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }

  function worldToScreen(worldPos) {
    const vec = worldPos.clone().project(camera);
    const c = renderer.domElement;
    return { x: (vec.x * 0.5 + 0.5) * c.clientWidth, y: (-vec.y * 0.5 + 0.5) * c.clientHeight, z: vec.z };
  }

  function getProjectDotColor(project) {
    const slug = slugify(project.name || project);
    for (const [key, color] of Object.entries(PROJECT_COLORS)) {
      if (slug.includes(key)) return color;
    }
    return '#7070a0';
  }

  function getDailyBudget() {
    if (costData.budgets) {
      const b = costData.budgets.claude || costData.budgets;
      if (b && b.daily) return b.daily;
    }
    return DEFAULT_DAILY_BUDGET;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // THREE.JS SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  function initThree() {
    const canvas = $('spatialCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0a0a14, 1);

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0a0a14, 0.018);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(0, 2, 8);
    camera.lookAt(0, 0, 0);
    clock = new THREE.Clock();

    scene.add(new THREE.AmbientLight(0x222244, 0.5));
    const pl = new THREE.PointLight(COLORS.accent, 1.5, 30);
    pl.position.set(0, 2, 0);
    scene.add(pl);
    const dl = new THREE.DirectionalLight(0xffffff, 0.3);
    dl.position.set(5, 10, 5);
    scene.add(dl);

    createGrid();
    createParticles();
    createCentralOrb();
  }

  function createGrid() {
    const g = new THREE.GridHelper(100, 60, COLORS.grid, COLORS.grid);
    g.position.y = -2; g.material.opacity = 0.03; g.material.transparent = true; g.material.depthWrite = false;
    scene.add(g);
  }

  function createParticles() {
    const count = 200, geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3), vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i*3]=(Math.random()-0.5)*60; pos[i*3+1]=(Math.random()-0.5)*30+5; pos[i*3+2]=(Math.random()-0.5)*80-10;
      vel[i*3]=(Math.random()-0.5)*0.005; vel[i*3+1]=(Math.random()-0.5)*0.003; vel[i*3+2]=(Math.random()-0.5)*0.005;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.userData.velocities = vel;
    particles = new THREE.Points(geo, new THREE.PointsMaterial({
      color: COLORS.particle, size: 0.08, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    scene.add(particles);
  }

  function updateParticles() {
    if (!particles) return;
    const p = particles.geometry.attributes.position.array, v = particles.geometry.userData.velocities;
    for (let i = 0; i < p.length; i += 3) {
      p[i]+=v[i]; p[i+1]+=v[i+1]; p[i+2]+=v[i+2];
      if(p[i]>30)p[i]=-30; if(p[i]<-30)p[i]=30;
      if(p[i+1]>20)p[i+1]=-5; if(p[i+1]<-5)p[i+1]=20;
      if(p[i+2]>10)p[i+2]=-50; if(p[i+2]<-50)p[i+2]=10;
    }
    particles.geometry.attributes.position.needsUpdate = true;
  }

  function createCentralOrb() {
    const sg = new THREE.SphereGeometry(0.5, 32, 32);
    const sm = new THREE.MeshPhongMaterial({ color: COLORS.orbCore, emissive: COLORS.orbCore, emissiveIntensity: 0.3, transparent: true, opacity: 0.7, shininess: 100 });
    centralOrb = new THREE.Mesh(sg, sm); centralOrb.position.set(0, 0.5, 0); scene.add(centralOrb);
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.02, 16, 64), new THREE.MeshBasicMaterial({ color: COLORS.orbRing, transparent: true, opacity: 0.4 }));
    r1.position.copy(centralOrb.position); r1.rotation.x = Math.PI / 3; scene.add(r1); orbRings.push(r1);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.015, 16, 64), new THREE.MeshBasicMaterial({ color: COLORS.orbRing, transparent: true, opacity: 0.25 }));
    r2.position.copy(centralOrb.position); r2.rotation.x = -Math.PI / 4; r2.rotation.y = Math.PI / 6; scene.add(r2); orbRings.push(r2);
  }

  function updateOrb(time) {
    if (!centralOrb) return;
    const s = 1 + Math.sin(time * 2) * 0.05;
    centralOrb.scale.set(s, s, s);
    centralOrb.material.emissiveIntensity = 0.3 + Math.sin(time * 3) * 0.15;
    if (orbRings[0]) orbRings[0].rotation.z += 0.005;
    if (orbRings[1]) orbRings[1].rotation.z -= 0.003;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLATFORMS (Layer 2) & NODES (Layer 3)
  // ═══════════════════════════════════════════════════════════════════════════

  function createPlatform(project, index, total) {
    const x = -(total - 1) * PLATFORM_SPACING / 2 + index * PLATFORM_SPACING, y = 0, z = -12;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.2, 32),
      new THREE.MeshPhongMaterial({ color: COLORS.platformBase, emissive: COLORS.accent, emissiveIntensity: 0.05, transparent: true, opacity: 0.9 }));
    base.position.set(x, y, z); base.userData = { type: 'platform', projectId: project.id }; scene.add(base);
    const glow = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.04, 16, 64),
      new THREE.MeshBasicMaterial({ color: COLORS.platformGlow, transparent: true, opacity: 0.3 }));
    glow.position.set(x, y + 0.15, z); glow.rotation.x = -Math.PI / 2; scene.add(glow);
    const tc = getProjectMeshColor(project);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 16),
      new THREE.MeshPhongMaterial({ color: tc, emissive: tc, emissiveIntensity: 0.4, transparent: true, opacity: 0.8 }));
    top.position.set(x, y + 0.5, z); scene.add(top);
    const lbl = document.createElement('div'); lbl.className = 'platform-label';
    lbl.innerHTML = `<div class="platform-label-name">${escapeHtml(project.name)}</div><div class="platform-label-type">${project.projectType || 'project'}</div>`;
    lbl.addEventListener('click', () => focusProject(project));
    $('overlayContainer').appendChild(lbl);
    platformMeshes.push({ mesh: base, topSphere: top, glowRing: glow, project, label: lbl, worldPos: new THREE.Vector3(x, y + 1.2, z) });
  }

  function getProjectMeshColor(p) {
    const s = slugify(p.name);
    if (s.includes('soul-jam')) return COLORS.warn;
    if (s.includes('athletes')) return COLORS.green;
    if (s.includes('sos-train')) return COLORS.danger;
    if (s.includes('vance')) return COLORS.accent;
    if (s.includes('vantheah')) return COLORS.purple;
    if (s.includes('promotifyy')) return 0xff8c00;
    return COLORS.accentBright;
  }

  function createNode(project, index, total) {
    const angle = (index / Math.max(total, 1)) * Math.PI * 2;
    const r = 4 + Math.random() * 4;
    const x = Math.cos(angle) * r, y = Math.sin(angle) * 2 + Math.random() * 2, z = -30 + (Math.random() - 0.5) * 6;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 16),
      new THREE.MeshPhongMaterial({ color: COLORS.nodeColor, emissive: COLORS.nodeColor, emissiveIntensity: 0.2, transparent: true, opacity: 0.7 }));
    mesh.position.set(x, y, z); mesh.userData = { type: 'node', projectId: project.id }; scene.add(mesh);
    const lbl = document.createElement('div'); lbl.className = 'node-label';
    lbl.innerHTML = `<div class="node-label-name">${escapeHtml(project.name)}</div>`;
    lbl.addEventListener('click', () => focusProject(project));
    $('overlayContainer').appendChild(lbl);
    nodeMeshes.push({ mesh, project, label: lbl, worldPos: new THREE.Vector3(x, y + 0.5, z) });
  }

  function createConnectionLines() {
    connectionLines.forEach(l => scene.remove(l)); connectionLines = [];
    for (let i = 0; i < nodeMeshes.length; i++) {
      for (let j = i + 1; j < nodeMeshes.length; j++) {
        if (nodeMeshes[i].mesh.position.distanceTo(nodeMeshes[j].mesh.position) < 6) {
          const g = new THREE.BufferGeometry().setFromPoints([nodeMeshes[i].mesh.position, nodeMeshes[j].mesh.position]);
          const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: COLORS.nodeLine, transparent: true, opacity: 0.15 }));
          scene.add(l); connectionLines.push(l);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMERA CONTROLLER
  // ═══════════════════════════════════════════════════════════════════════════

  function jumpToLayer(layer) {
    currentLayer = layer;
    focusedProject = null;
    hideProjectPanel();
    const cfg = LAYERS[layer];
    cam.targetPos.set(...cfg.camera.pos);
    cam.targetLookAt.set(...cfg.camera.lookAt);

    const dash = $('l1Dashboard');
    if (layer === 1) { dash.classList.remove('hidden'); }
    else { dash.classList.add('hidden'); }

    document.querySelectorAll('.layer-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.layer) === layer);
    });
  }

  function focusProject(project) {
    focusedProject = project;
    const pm = platformMeshes.find(p => p.project.id === project.id);
    const nm = nodeMeshes.find(n => n.project.id === project.id);
    const target = pm || nm;
    if (target) {
      const pos = target.mesh.position;
      cam.targetPos.set(pos.x, pos.y + 2, pos.z + 4);
      cam.targetLookAt.set(pos.x, pos.y, pos.z);
    }
    if (project.layer == null) showClassifyModal(project);
    showProjectPanel(project);
  }

  function unfocus() { focusedProject = null; hideProjectPanel(); jumpToLayer(currentLayer); }

  function updateCamera() {
    cam.currentPos.lerp(cam.targetPos, CAMERA_LERP);
    cam.currentLookAt.lerp(cam.targetLookAt, CAMERA_LERP);
    camera.position.copy(cam.currentPos);
    camera.lookAt(cam.currentLookAt);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERLAY SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  function updateOverlays() {
    platformMeshes.forEach(pm => {
      const s = worldToScreen(pm.worldPos);
      if (s.z > 1) { pm.label.style.opacity = '0'; return; }
      const d = camera.position.distanceTo(pm.worldPos);
      const o = Math.max(0, Math.min(1, 1 - (d - 3) / 25));
      pm.label.style.left = s.x + 'px'; pm.label.style.top = s.y + 'px';
      pm.label.style.transform = 'translate(-50%, -50%)'; pm.label.style.opacity = o;
    });
    nodeMeshes.forEach(nm => {
      const s = worldToScreen(nm.worldPos);
      if (s.z > 1) { nm.label.style.opacity = '0'; return; }
      const d = camera.position.distanceTo(nm.worldPos);
      const o = Math.max(0, Math.min(1, 1 - (d - 3) / 20));
      nm.label.style.left = s.x + 'px'; nm.label.style.top = s.y + 'px';
      nm.label.style.transform = 'translate(-50%, -50%)'; nm.label.style.opacity = o;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENE BUILDER
  // ═══════════════════════════════════════════════════════════════════════════

  function rebuildScene() {
    platformMeshes.forEach(pm => { scene.remove(pm.mesh); scene.remove(pm.glowRing); scene.remove(pm.topSphere); if (pm.label.parentNode) pm.label.remove(); });
    platformMeshes = [];
    nodeMeshes.forEach(nm => { scene.remove(nm.mesh); if (nm.label.parentNode) nm.label.remove(); });
    nodeMeshes = [];
    connectionLines.forEach(l => scene.remove(l)); connectionLines = [];

    const l2 = [], l3 = [];
    projects.forEach(p => { (autoClassify(p) === 2 ? l2 : l3).push(p); });
    l2.forEach((p, i) => createPlatform(p, i, l2.length));
    l3.forEach((p, i) => createNode(p, i, l3.length));
    createConnectionLines();
  }

  function autoClassify(p) {
    if (p.layer === 2 || p.layer === 3) return p.layer;
    const s = slugify(p.name);
    if (KNOWN_VENTURES.some(v => s.includes(v))) return 2;
    if (p.milestones && p.milestones.length > 0 && p.directory) return 2;
    return 3;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DASHBOARD — Live Data Widgets
  // ═══════════════════════════════════════════════════════════════════════════

  function updateDashboard() {
    updateCreditsWidget();
    updateSparkline();
    updateIncomeExpenses();
    updateApprovalQueue();
    updateCalendar();
    updateGauges();
    updatePriorities();
  }

  // ─── Credits Widget (live from cost API) ───
  function updateCreditsWidget() {
    const totalCalls = costData.totalCalls || 0;
    const totalTokens = (costData.totalInput || 0) + (costData.totalOutput || 0);

    let display;
    if (totalTokens >= 1000000) display = (totalTokens / 1000000).toFixed(1) + 'M+';
    else if (totalTokens >= 1000) display = (totalTokens / 1000).toFixed(1) + 'k+';
    else if (totalTokens > 0) display = totalTokens.toString();
    else if (totalCalls > 0) display = totalCalls.toString();
    else display = '\u2014';

    $('l1CreditsValue').textContent = display;
  }

  // ─── Sparkline (live from byDay cost data) ───
  function updateSparkline() {
    const days = costData.byDay || [];
    if (days.length < 2) return; // keep default curve if no data

    const costs = days.slice(-7).map(d => d.cost);
    const max = Math.max(...costs, 0.01);
    const h = 28, w = 80, pad = 2;
    const step = w / (costs.length - 1);
    let d = '';
    costs.forEach((c, i) => {
      const x = i * step;
      const y = h - (c / max) * (h - pad * 2) - pad;
      d += (i === 0 ? 'M' : ' L') + x.toFixed(1) + ',' + y.toFixed(1);
    });
    $('l1SparklinePath').setAttribute('d', d);
  }

  // ─── Income & Expenses (live from cost/budget data) ───
  function updateIncomeExpenses() {
    const budget = getDailyBudget();
    const todayCost = costData.totalCost || 0;
    const remaining = Math.max(0, budget - todayCost);

    // Income = daily budget
    $('l1Income').textContent = formatCost(budget);
    // Expenses = today's spend
    $('l1Expenses').textContent = formatCost(todayCost);

    // Update detail text
    const incomeDetail = document.querySelector('.l1-income-block:first-child .l1-income-detail');
    const expenseDetail = document.querySelector('.l1-income-block:last-child .l1-income-detail');

    if (incomeDetail) {
      incomeDetail.innerHTML = 'Daily budget &mdash; <strong>' + formatCost(remaining) + '</strong> remaining';
    }
    if (expenseDetail) {
      const calls = costData.totalCalls || 0;
      expenseDetail.innerHTML = '<strong>' + calls + '</strong> API calls today';
    }
  }

  // ─── Approval Queue (live from brain pending updates) ───
  function updateApprovalQueue() {
    const list = $('l1ApprovalsList');
    const pending = Array.isArray(pendingBrainUpdates) ? pendingBrainUpdates : [];

    $('l1ApprovalsBadge').textContent = 'Pending: ' + pending.length;

    if (pending.length === 0) {
      list.innerHTML = '<div class="l1-empty-state">No pending approvals</div>';
      return;
    }

    list.innerHTML = pending.map(u => {
      const name = escapeHtml(u.file || u.section || 'Brain Update');
      const desc = escapeHtml(u.reason || u.description || u.summary || '');
      return `
        <div class="l1-approval-item">
          <div class="l1-approval-info">
            <div class="l1-approval-project">${name}</div>
            <div class="l1-approval-desc">${desc}</div>
          </div>
          <div class="l1-approval-actions">
            <button class="l1-btn-approve" onclick="window._approveUpdate('${u.id}')">Approve</button>
            <button class="l1-btn-deny" onclick="window._rejectUpdate('${u.id}')">Deny</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Expose approval handlers globally
  window._approveUpdate = function(id) {
    wsSend({ action: 'approve-brain-update', updateId: id });
    setTimeout(() => wsSend({ action: 'get-spatial-data' }), 500);
  };
  window._rejectUpdate = function(id) {
    wsSend({ action: 'reject-brain-update', updateId: id });
    setTimeout(() => wsSend({ action: 'get-spatial-data' }), 500);
  };

  // ─── Calendar (live from project milestones) ───
  function updateCalendar() {
    const container = $('l1CalendarGrid');
    const now = new Date();
    const year = now.getFullYear(), month = now.getMonth(), today = now.getDate();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Collect milestone dates from real project data
    const milestoneDates = {};
    projects.forEach(p => {
      (p.milestones || []).forEach(m => {
        const ts = m.timestamp || m.dueDate || m.date;
        if (!ts) return;
        const d = new Date(ts);
        if (d.getMonth() === month && d.getFullYear() === year) {
          milestoneDates[d.getDate()] = getProjectDotColor(p);
        }
      });
    });

    // Also mark task-related dates
    tasks.forEach(t => {
      if (!t.createdAt) return;
      const d = new Date(t.createdAt);
      if (d.getMonth() === month && d.getFullYear() === year && !milestoneDates[d.getDate()]) {
        milestoneDates[d.getDate()] = '#7070a0';
      }
    });

    // Header
    let html = '';
    ['S','M','T','W','T','F','S'].forEach(d => {
      html += `<div class="cal-header-cell">${d}</div>`;
    });

    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
      html += '<div class="cal-cell empty"></div>';
    }

    // Day cells
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = d === today;
      const dotColor = milestoneDates[d];
      const classes = ['cal-cell'];
      if (isToday) classes.push('today');
      if (dotColor) classes.push('has-event');

      html += `<div class="${classes.join(' ')}">`;
      html += `<span class="cal-date"${dotColor && !isToday ? ` style="color:${dotColor}"` : ''}>${d}</span>`;
      if (dotColor) html += `<span class="cal-dot" style="background:${dotColor}"></span>`;
      html += '</div>';
    }

    container.innerHTML = html;
  }

  // ─── Gauges (live from cost + system data) ───
  function updateGauges() {
    const circumference = 251.33;

    // Daily Usage = cost / daily budget
    const todayCost = costData.totalCost || 0;
    const budget = getDailyBudget();
    const dailyPct = Math.min(100, Math.round((todayCost / budget) * 100));

    $('l1GaugeDailyVal').innerHTML = dailyPct + '<span class="l1-gauge-pct">%</span>';
    $('l1GaugeDailyArc').setAttribute('stroke-dashoffset', circumference * (1 - dailyPct / 100));

    // CPU = system load average / cores
    let cpuPct = 0;
    if (systemData && systemData.cpu) {
      const load = systemData.cpu.load;
      const cores = systemData.cpu.cores || 1;
      if (Array.isArray(load) && load.length > 0) {
        cpuPct = Math.min(100, Math.round((load[0] / cores) * 100));
      } else if (typeof systemData.cpu === 'string') {
        const match = String(systemData.cpu).match(/[\d.]+/);
        if (match) cpuPct = Math.round(parseFloat(match[0]));
      }
    }
    // Also try memory percent as fallback
    if (cpuPct === 0 && systemData && systemData.memory && systemData.memory.percent) {
      const match = String(systemData.memory.percent).match(/[\d.]+/);
      if (match) cpuPct = Math.round(parseFloat(match[0]));
    }

    $('l1GaugeCpuVal').innerHTML = cpuPct + '<span class="l1-gauge-pct">%</span>';
    $('l1GaugeCpuArc').setAttribute('stroke-dashoffset', circumference * (1 - cpuPct / 100));
  }

  // ─── Priorities (live from projects + tasks) ───
  function updatePriorities() {
    const list = $('l1PrioritiesList');
    const items = [];

    // Build from real projects
    projects.forEach(p => {
      const color = getProjectDotColor(p);
      let status = 'Active';
      const ms = p.milestones || [];
      const done = ms.filter(m => m.completed || m.status === 'completed').length;
      if (ms.length > 0) {
        const pct = Math.round((done / ms.length) * 100);
        if (pct === 100) status = 'Complete';
        else if (pct > 50) status = 'In Progress';
        else status = 'Development';
      }
      const state = p.state || {};
      if (state.dev_server_running) status = 'Running';

      const latestMs = ms[ms.length - 1];
      const desc = latestMs ? (latestMs.title || latestMs.name || latestMs.text || '') : (p.description || '').slice(0, 40);

      items.push({ project: p.name.toUpperCase(), desc, status, color });
    });

    // Add running tasks as priorities
    tasks.forEach(t => {
      if (t.status === 'running' || t.status === 'queued') {
        const color = t.projectId ? getProjectDotColor({ name: t.projectId }) : '#7070a0';
        items.push({
          project: (t.title || 'Task').toUpperCase(),
          desc: t.lastMilestone || t.durationFormatted || '',
          status: t.status === 'running' ? 'Running' : 'Queued',
          color,
        });
      }
    });

    if (items.length === 0) {
      list.innerHTML = '<div class="l1-empty-state">No active projects</div>';
      return;
    }

    const displayItems = items.slice(0, 6);

    list.innerHTML = displayItems.map(item => `
      <div class="l1-priority-item">
        <div class="l1-priority-dot" style="background:${item.color}; box-shadow: 0 0 6px ${item.color}88, 0 0 12px ${item.color}44;"></div>
        <div class="l1-priority-info">
          <div class="l1-priority-project">${escapeHtml(item.project)}</div>
          <div class="l1-priority-desc">${escapeHtml(item.desc)}${item.desc && item.status ? ' &mdash; ' : ''}<span class="l1-priority-status">${escapeHtml(item.status)}</span></div>
        </div>
      </div>
    `).join('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROJECT PANEL (focus view)
  // ═══════════════════════════════════════════════════════════════════════════

  function showProjectPanel(project) {
    $('projectPanel').style.display = 'block';
    $('ppName').textContent = project.name;
    $('ppDesc').textContent = project.description || 'No description';
    const state = project.state || {};
    $('ppFramework').textContent = state.dev_framework || project.projectType || 'Project';
    const se = $('ppDevStatus');
    if (state.dev_server_running) { se.textContent = 'Dev Server Running'; se.className = 'pp-status online'; }
    else { se.textContent = 'Offline'; se.className = 'pp-status'; }
    const ms = project.milestones || [];
    const mc = $('ppMilestones');
    if (!ms.length) { mc.innerHTML = '<div class="panel-empty">No milestones</div>'; }
    else {
      mc.innerHTML = ms.map(m => `<div class="pp-milestone"><div class="pp-milestone-dot ${m.completed || m.status === 'completed' ? 'done' : 'pending'}"></div><span class="pp-milestone-name">${escapeHtml(m.title || m.name || m.text)}</span>${m.timestamp ? `<span class="pp-milestone-date">${new Date(m.timestamp).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>` : ''}</div>`).join('');
    }
    const done = ms.filter(m => m.completed || m.status === 'completed').length;
    const pct = ms.length > 0 ? Math.round((done / ms.length) * 100) : 0;
    $('ppProgressFill').style.width = pct + '%';
    $('ppProgressText').textContent = pct + '%';
  }
  function hideProjectPanel() { $('projectPanel').style.display = 'none'; }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLASSIFICATION
  // ═══════════════════════════════════════════════════════════════════════════

  function showClassifyModal(p) { classifyingProject = p; $('classifyName').textContent = p.name; $('classifyModal').style.display = 'flex'; }
  function hideClassifyModal() { classifyingProject = null; $('classifyModal').style.display = 'none'; }
  function classifyProjectAction(layer) {
    if (!classifyingProject) return;
    wsSend({ action: 'classify-project', projectId: classifyingProject.id, layer, projectType: layer === 2 ? 'venture' : 'sub-task' });
    classifyingProject.layer = layer;
    hideClassifyModal(); rebuildScene();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET
  // ═══════════════════════════════════════════════════════════════════════════

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      wsConnected = true;
      $('statusDot').className = 'status-dot online';
      $('statusText').textContent = 'ONLINE';
      wsSend({ action: 'get-spatial-data' });
    };
    ws.onmessage = (e) => { try { handleWSMessage(JSON.parse(e.data)); } catch (err) { console.warn('WS parse:', err); } };
    ws.onclose = () => {
      wsConnected = false;
      $('statusDot').className = 'status-dot offline';
      $('statusText').textContent = 'OFFLINE';
      setTimeout(connectWS, 3000);
    };
    ws.onerror = () => { ws.close(); };
  }

  function wsSend(data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }

  function handleWSMessage(msg) {
    switch (msg.type) {
      case 'connected': break;
      case 'spatial-data':
        projects = msg.projects || [];
        tasks = msg.tasks || [];
        costData = msg.costs || {};
        systemData = msg.system || {};
        pendingBrainUpdates = msg.pendingBrainUpdates || [];
        projectStates = msg.projectStates || {};
        rebuildScene();
        updateDashboard();
        break;
      case 'project-classified':
        const pc = projects.find(p => p.id === msg.projectId);
        if (pc) { pc.layer = msg.layer; pc.projectType = msg.projectType; }
        rebuildScene();
        break;
      case 'project-created':
        projects.push(msg.project);
        rebuildScene(); updateDashboard();
        break;
      case 'brain-update-result':
        wsSend({ action: 'get-spatial-data' });
        break;
      case 'task-queued':
      case 'task-started':
      case 'task-completed':
      case 'task-failed':
        // Refresh data on task state changes
        wsSend({ action: 'get-spatial-data' });
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANIMATION LOOP
  // ═══════════════════════════════════════════════════════════════════════════

  function animate() {
    requestAnimationFrame(animate);
    const time = clock.getElapsedTime();
    updateCamera();
    updateOrb(time);
    updateParticles();
    platformMeshes.forEach((pm, i) => {
      pm.glowRing.rotation.z += 0.002;
      pm.glowRing.material.opacity = 0.2 + Math.sin(time * 2 + i) * 0.1;
      pm.topSphere.position.y = pm.mesh.position.y + 0.5 + Math.sin(time * 1.5 + i * 0.5) * 0.1;
    });
    nodeMeshes.forEach((nm, i) => {
      nm.mesh.position.y += Math.sin(time * 0.8 + i * 0.7) * 0.001;
      nm.mesh.material.opacity = 0.5 + Math.sin(time + i) * 0.2;
    });
    updateOverlays();
    renderer.render(scene, camera);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RAYCASTER
  // ═══════════════════════════════════════════════════════════════════════════

  function onCanvasClick(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const objs = [...platformMeshes.map(pm => pm.mesh), ...nodeMeshes.map(nm => nm.mesh)];
    const hits = raycaster.intersectObjects(objs);
    if (hits.length > 0) {
      const p = projects.find(pr => pr.id === hits[0].object.userData.projectId);
      if (p) focusProject(p);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  function bindEvents() {
    const canvas = renderer.domElement;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      cam.isDragging = true;
      cam.lastMouse = { x: e.clientX, y: e.clientY };
      cam.dragStart = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mousemove', (e) => {
      if (!cam.isDragging) return;
      const dx = e.clientX - cam.lastMouse.x, dy = e.clientY - cam.lastMouse.y;
      cam.lastMouse = { x: e.clientX, y: e.clientY };
      const offset = cam.targetPos.clone().sub(cam.targetLookAt);
      const dist = offset.length();
      cam.orbitTheta -= dx * 0.005;
      cam.orbitPhi = Math.max(-0.8, Math.min(1.2, cam.orbitPhi - dy * 0.005));
      offset.x = dist * Math.sin(cam.orbitPhi) * Math.sin(cam.orbitTheta);
      offset.y = dist * Math.cos(cam.orbitPhi);
      offset.z = dist * Math.sin(cam.orbitPhi) * Math.cos(cam.orbitTheta);
      cam.targetPos.copy(cam.targetLookAt).add(offset);
    });

    window.addEventListener('mouseup', () => { cam.isDragging = false; });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = cam.targetPos.clone().sub(cam.targetLookAt).normalize();
      cam.targetPos.addScaledVector(dir, e.deltaY * 0.01);
    }, { passive: false });

    canvas.addEventListener('click', (e) => {
      if (Math.abs(e.clientX - cam.dragStart.x) < 5 && Math.abs(e.clientY - cam.dragStart.y) < 5) {
        onCanvasClick(e);
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const speed = 0.5;
      const fwd = cam.targetLookAt.clone().sub(cam.targetPos).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      switch (e.key) {
        case '1': jumpToLayer(1); break;
        case '2': jumpToLayer(2); break;
        case '3': jumpToLayer(3); break;
        case 'w': case 'W': case 'ArrowUp': cam.targetPos.addScaledVector(fwd, speed); cam.targetLookAt.addScaledVector(fwd, speed); break;
        case 's': case 'S': case 'ArrowDown': cam.targetPos.addScaledVector(fwd, -speed); cam.targetLookAt.addScaledVector(fwd, -speed); break;
        case 'a': case 'A': case 'ArrowLeft': cam.targetPos.addScaledVector(right, -speed); cam.targetLookAt.addScaledVector(right, -speed); break;
        case 'd': case 'D': case 'ArrowRight': cam.targetPos.addScaledVector(right, speed); cam.targetLookAt.addScaledVector(right, speed); break;
        case 'Escape': unfocus(); break;
        case ' ': e.preventDefault(); jumpToLayer(1); break;
        case 'g': case 'G': if (window._gestureController) window._gestureController.toggle(); break;
      }
    });

    document.querySelectorAll('.layer-btn').forEach(btn => { btn.addEventListener('click', () => jumpToLayer(parseInt(btn.dataset.layer))); });
    $('ppClose').addEventListener('click', unfocus);
    $('ppOpenChat').addEventListener('click', () => { if (focusedProject) window.location.href = '/?project=' + focusedProject.id; });
    $('classifyL2').addEventListener('click', () => classifyProjectAction(2));
    $('classifyL3').addEventListener('click', () => classifyProjectAction(3));

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE BRIDGE — Exposed API for gesture.js overlay controller
  // ═══════════════════════════════════════════════════════════════════════════

  window._spatialGestureAPI = {
    // Raycast from gesture cursor (screen coords)
    gestureRaycast(screenX, screenY) {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((screenX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((screenY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const objs = [...platformMeshes.map(pm => pm.mesh), ...nodeMeshes.map(nm => nm.mesh)];
      const hits = raycaster.intersectObjects(objs);
      if (hits.length > 0) {
        const p = projects.find(pr => pr.id === hits[0].object.userData.projectId);
        if (p && p !== focusedProject) focusProject(p);
      }
    },

    // Zoom via pinch delta
    gestureZoom(delta) {
      const dir = cam.targetPos.clone().sub(cam.targetLookAt).normalize();
      cam.targetPos.addScaledVector(dir, -delta);
    },

    // Orbit via fist drag
    gestureOrbit(dx, dy) {
      const offset = cam.targetPos.clone().sub(cam.targetLookAt);
      const dist = offset.length();
      cam.orbitTheta -= dx * 0.5;
      cam.orbitPhi = Math.max(-0.8, Math.min(1.2, cam.orbitPhi - dy * 0.5));
      offset.x = dist * Math.sin(cam.orbitPhi) * Math.sin(cam.orbitTheta);
      offset.y = dist * Math.cos(cam.orbitPhi);
      offset.z = dist * Math.sin(cam.orbitPhi) * Math.cos(cam.orbitTheta);
      cam.targetPos.copy(cam.targetLookAt).add(offset);
    },

    // Layer navigation via palm swipe
    gestureLayerNext() {
      const next = Math.min(3, currentLayer + 1);
      if (next !== currentLayer) jumpToLayer(next);
    },
    gestureLayerPrev() {
      const prev = Math.max(1, currentLayer - 1);
      if (prev !== currentLayer) jumpToLayer(prev);
    },

    // Confirm action (thumbs up) — approve first pending brain update
    confirmAction() {
      if (pendingBrainUpdates.length > 0) {
        const first = pendingBrainUpdates[0];
        wsSend({ action: 'approve-brain-update', updateId: first.id });
        setTimeout(() => wsSend({ action: 'get-spatial-data' }), 500);
      }
    },

    // Expose state for gesture system
    getCurrentLayer() { return currentLayer; },
    getFocusedProject() { return focusedProject; },
    unfocus() { unfocus(); },
  };

  document.addEventListener('DOMContentLoaded', () => {
    initThree();
    bindEvents();
    connectWS();
    updateDashboard(); // initial render with empty states
    setInterval(() => { if (wsConnected) wsSend({ action: 'get-spatial-data' }); }, 15000);
    animate();

    // Gesture toggle button
    const gestureBtn = document.getElementById('gestureToggleBtn');
    if (gestureBtn) {
      gestureBtn.addEventListener('click', () => {
        if (window._gestureController) window._gestureController.toggle();
      });
    }
  });

})();
