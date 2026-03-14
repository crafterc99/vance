(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSTANTS
  // ═══════════════════════════════════════════════════════════════════════════

  const COLORS = {
    accent: 0x4488ff,
    accentBright: 0x66aaff,
    green: 0x00e5a0,
    greenDim: 0x009a6a,
    warn: 0xffa040,
    danger: 0xff3355,
    purple: 0xa855f7,
    grid: 0x4488ff,
    particle: 0x4488ff,
    platformBase: 0x181828,
    platformGlow: 0x4488ff,
    orbCore: 0x4488ff,
    orbRing: 0x66aaff,
    nodeColor: 0x7070a0,
    nodeLine: 0x2a2a44,
  };

  const LAYERS = {
    1: {
      label: 'LAYER 1 \u2014 OPERATIONS',
      sublabel: 'Command & Control',
      camera: { pos: [0, 2, 8], lookAt: [0, 0, 0] },
    },
    2: {
      label: 'LAYER 2 \u2014 CORE PROJECTS',
      sublabel: 'Active Ventures',
      camera: { pos: [0, 4, -5], lookAt: [0, 0, -12] },
    },
    3: {
      label: 'LAYER 3 \u2014 EXTERNAL',
      sublabel: 'Sub-projects & Experiments',
      camera: { pos: [0, 6, -18], lookAt: [0, 0, -30] },
    },
  };

  // Panel anchor positions in world space (Layer 1, semicircle at z=2)
  const PANEL_ANCHORS = [
    { id: 'panelTasks', x: -4, y: 1.5, z: 2 },
    { id: 'panelDeadlines', x: -2, y: 2.2, z: 1.5 },
    { id: 'panelPriorities', x: 0, y: 2.5, z: 1.2 },
    { id: 'panelCosts', x: 2, y: 2.2, z: 1.5 },
    { id: 'panelApprovals', x: 4, y: 1.5, z: 2 },
  ];

  const KNOWN_VENTURES = ['soul-jam', 'athletes-blender', 'sos-train', 'vance', 'vantheah', 'promotifyy'];
  const CAMERA_LERP = 0.05;
  const PLATFORM_SPACING = 5;
  const DAILY_BUDGET = 5.0;

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  let ws = null;
  let wsConnected = false;
  let currentLayer = 1;
  let focusedProject = null;
  let classifyingProject = null;

  // Data from server
  let projects = [];
  let tasks = [];
  let costData = {};
  let systemData = {};
  let pendingBrainUpdates = 0;

  // Three.js
  let renderer, scene, camera;
  let clock;

  // Scene objects
  let centralOrb = null;
  let orbRings = [];
  let gridFloor = null;
  let particles = null;
  let platformMeshes = []; // { mesh, project, label, glowRing }
  let nodeMeshes = []; // { mesh, project, label }
  let connectionLines = [];

  // Camera controller state
  const cam = {
    targetPos: new THREE.Vector3(0, 2, 8),
    targetLookAt: new THREE.Vector3(0, 0, 0),
    currentPos: new THREE.Vector3(0, 2, 8),
    currentLookAt: new THREE.Vector3(0, 0, 0),
    isDragging: false,
    lastMouse: { x: 0, y: 0 },
    orbitTheta: 0,
    orbitPhi: 0.3,
    orbitRadius: 8,
  };

  // Raycaster
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function $(id) { return document.getElementById(id); }

  function worldToScreen(worldPos) {
    const vec = worldPos.clone().project(camera);
    const canvas = renderer.domElement;
    return {
      x: (vec.x * 0.5 + 0.5) * canvas.clientWidth,
      y: (-vec.y * 0.5 + 0.5) * canvas.clientHeight,
      z: vec.z,
    };
  }

  function lerpVal(a, b, t) { return a + (b - a) * t; }

  function formatCost(n) { return '$' + (n || 0).toFixed(2); }

  function slugify(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // THREE.JS SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  function initThree() {
    const canvas = $('spatialCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x09090f, 1);

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x09090f, 0.018);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(0, 2, 8);
    camera.lookAt(0, 0, 0);

    clock = new THREE.Clock();

    // Ambient light
    const ambient = new THREE.AmbientLight(0x222244, 0.5);
    scene.add(ambient);

    // Point light at orb position
    const pointLight = new THREE.PointLight(COLORS.accent, 1.5, 30);
    pointLight.position.set(0, 2, 0);
    scene.add(pointLight);

    // Directional light from above
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight.position.set(5, 10, 5);
    scene.add(dirLight);

    createGrid();
    createParticles();
    createCentralOrb();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GEOMETRY — Grid Floor
  // ═══════════════════════════════════════════════════════════════════════════

  function createGrid() {
    const size = 100;
    const divisions = 60;
    const gridHelper = new THREE.GridHelper(size, divisions, COLORS.grid, COLORS.grid);
    gridHelper.position.y = -2;
    gridHelper.material.opacity = 0.03;
    gridHelper.material.transparent = true;
    gridHelper.material.depthWrite = false;
    scene.add(gridHelper);
    gridFloor = gridHelper;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GEOMETRY — Ambient Particles
  // ═══════════════════════════════════════════════════════════════════════════

  function createParticles() {
    const count = 200;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 60;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 30 + 5;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 80 - 10;
      velocities[i * 3] = (Math.random() - 0.5) * 0.005;
      velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.003;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.005;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.userData.velocities = velocities;

    const material = new THREE.PointsMaterial({
      color: COLORS.particle,
      size: 0.08,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    particles = new THREE.Points(geometry, material);
    scene.add(particles);
  }

  function updateParticles() {
    if (!particles) return;
    const positions = particles.geometry.attributes.position.array;
    const velocities = particles.geometry.userData.velocities;

    for (let i = 0; i < positions.length; i += 3) {
      positions[i] += velocities[i];
      positions[i + 1] += velocities[i + 1];
      positions[i + 2] += velocities[i + 2];

      // Wrap around
      if (positions[i] > 30) positions[i] = -30;
      if (positions[i] < -30) positions[i] = 30;
      if (positions[i + 1] > 20) positions[i + 1] = -5;
      if (positions[i + 1] < -5) positions[i + 1] = 20;
      if (positions[i + 2] > 10) positions[i + 2] = -50;
      if (positions[i + 2] < -50) positions[i + 2] = 10;
    }
    particles.geometry.attributes.position.needsUpdate = true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GEOMETRY — Central Voice Orb (Layer 1)
  // ═══════════════════════════════════════════════════════════════════════════

  function createCentralOrb() {
    // Core sphere
    const sphereGeo = new THREE.SphereGeometry(0.5, 32, 32);
    const sphereMat = new THREE.MeshPhongMaterial({
      color: COLORS.orbCore,
      emissive: COLORS.orbCore,
      emissiveIntensity: 0.3,
      transparent: true,
      opacity: 0.7,
      shininess: 100,
    });
    centralOrb = new THREE.Mesh(sphereGeo, sphereMat);
    centralOrb.position.set(0, 0.5, 0);
    scene.add(centralOrb);

    // Ring 1
    const ring1Geo = new THREE.TorusGeometry(0.9, 0.02, 16, 64);
    const ring1Mat = new THREE.MeshBasicMaterial({
      color: COLORS.orbRing,
      transparent: true,
      opacity: 0.4,
    });
    const ring1 = new THREE.Mesh(ring1Geo, ring1Mat);
    ring1.position.copy(centralOrb.position);
    ring1.rotation.x = Math.PI / 3;
    scene.add(ring1);
    orbRings.push(ring1);

    // Ring 2
    const ring2Geo = new THREE.TorusGeometry(1.2, 0.015, 16, 64);
    const ring2Mat = new THREE.MeshBasicMaterial({
      color: COLORS.orbRing,
      transparent: true,
      opacity: 0.25,
    });
    const ring2 = new THREE.Mesh(ring2Geo, ring2Mat);
    ring2.position.copy(centralOrb.position);
    ring2.rotation.x = -Math.PI / 4;
    ring2.rotation.y = Math.PI / 6;
    scene.add(ring2);
    orbRings.push(ring2);
  }

  function updateOrb(time) {
    if (!centralOrb) return;
    // Pulsate
    const scale = 1 + Math.sin(time * 2) * 0.05;
    centralOrb.scale.set(scale, scale, scale);
    centralOrb.material.emissiveIntensity = 0.3 + Math.sin(time * 3) * 0.15;

    // Rotate rings
    if (orbRings[0]) orbRings[0].rotation.z += 0.005;
    if (orbRings[1]) orbRings[1].rotation.z -= 0.003;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GEOMETRY — Project Platforms (Layer 2)
  // ═══════════════════════════════════════════════════════════════════════════

  function createPlatform(project, index, total) {
    const xSpread = (total - 1) * PLATFORM_SPACING;
    const x = -xSpread / 2 + index * PLATFORM_SPACING;
    const y = 0;
    const z = -12;

    // Cylinder base
    const baseGeo = new THREE.CylinderGeometry(1.8, 1.8, 0.2, 32);
    const baseMat = new THREE.MeshPhongMaterial({
      color: COLORS.platformBase,
      emissive: COLORS.accent,
      emissiveIntensity: 0.05,
      transparent: true,
      opacity: 0.9,
    });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.set(x, y, z);
    base.userData = { type: 'platform', projectId: project.id };
    scene.add(base);

    // Glow ring
    const glowGeo = new THREE.TorusGeometry(1.9, 0.04, 16, 64);
    const glowMat = new THREE.MeshBasicMaterial({
      color: COLORS.platformGlow,
      transparent: true,
      opacity: 0.3,
    });
    const glowRing = new THREE.Mesh(glowGeo, glowMat);
    glowRing.position.set(x, y + 0.15, z);
    glowRing.rotation.x = -Math.PI / 2;
    scene.add(glowRing);

    // Small sphere on top
    const topGeo = new THREE.SphereGeometry(0.2, 16, 16);
    const topColor = getProjectColor(project);
    const topMat = new THREE.MeshPhongMaterial({
      color: topColor,
      emissive: topColor,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.8,
    });
    const topSphere = new THREE.Mesh(topGeo, topMat);
    topSphere.position.set(x, y + 0.5, z);
    scene.add(topSphere);

    // HTML label
    const labelDiv = document.createElement('div');
    labelDiv.className = 'platform-label';
    labelDiv.innerHTML = `
      <div class="platform-label-name">${escapeHtml(project.name)}</div>
      <div class="platform-label-type">${project.projectType || 'project'}</div>
    `;
    labelDiv.addEventListener('click', () => focusProject(project));
    $('overlayContainer').appendChild(labelDiv);

    platformMeshes.push({
      mesh: base,
      topSphere,
      glowRing,
      project,
      label: labelDiv,
      worldPos: new THREE.Vector3(x, y + 1.2, z),
    });
  }

  function getProjectColor(project) {
    const slug = slugify(project.name);
    if (slug.includes('soul-jam')) return COLORS.warn;
    if (slug.includes('athletes')) return COLORS.green;
    if (slug.includes('sos-train')) return COLORS.danger;
    if (slug.includes('vance')) return COLORS.accent;
    if (slug.includes('vantheah')) return COLORS.purple;
    if (slug.includes('promotifyy')) return 0xff8c00;
    return COLORS.accentBright;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GEOMETRY — External Nodes (Layer 3)
  // ═══════════════════════════════════════════════════════════════════════════

  function createNode(project, index, total) {
    // Scatter in a constellation pattern
    const angle = (index / Math.max(total, 1)) * Math.PI * 2;
    const radius = 4 + Math.random() * 4;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * 2 + Math.random() * 2;
    const z = -30 + (Math.random() - 0.5) * 6;

    const geo = new THREE.SphereGeometry(0.25, 16, 16);
    const mat = new THREE.MeshPhongMaterial({
      color: COLORS.nodeColor,
      emissive: COLORS.nodeColor,
      emissiveIntensity: 0.2,
      transparent: true,
      opacity: 0.7,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.userData = { type: 'node', projectId: project.id };
    scene.add(mesh);

    // HTML label
    const labelDiv = document.createElement('div');
    labelDiv.className = 'node-label';
    labelDiv.innerHTML = `<div class="node-label-name">${escapeHtml(project.name)}</div>`;
    labelDiv.addEventListener('click', () => focusProject(project));
    $('overlayContainer').appendChild(labelDiv);

    nodeMeshes.push({
      mesh,
      project,
      label: labelDiv,
      worldPos: new THREE.Vector3(x, y + 0.5, z),
    });
  }

  function createConnectionLines() {
    // Remove old lines
    connectionLines.forEach(l => scene.remove(l));
    connectionLines = [];

    // Connect nearby nodes
    for (let i = 0; i < nodeMeshes.length; i++) {
      for (let j = i + 1; j < nodeMeshes.length; j++) {
        const dist = nodeMeshes[i].mesh.position.distanceTo(nodeMeshes[j].mesh.position);
        if (dist < 6) {
          const geo = new THREE.BufferGeometry().setFromPoints([
            nodeMeshes[i].mesh.position,
            nodeMeshes[j].mesh.position,
          ]);
          const mat = new THREE.LineBasicMaterial({
            color: COLORS.nodeLine,
            transparent: true,
            opacity: 0.15,
          });
          const line = new THREE.Line(geo, mat);
          scene.add(line);
          connectionLines.push(line);
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

    // Update HUD
    $('hudLayerLabel').textContent = cfg.label;
    $('hudSublabel').textContent = cfg.sublabel;

    // Update layer buttons
    document.querySelectorAll('.layer-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.layer) === layer);
    });
  }

  function focusProject(project) {
    focusedProject = project;

    // Find platform or node
    const pm = platformMeshes.find(p => p.project.id === project.id);
    const nm = nodeMeshes.find(n => n.project.id === project.id);
    const target = pm || nm;

    if (target) {
      const pos = target.mesh.position;
      cam.targetPos.set(pos.x, pos.y + 2, pos.z + 4);
      cam.targetLookAt.set(pos.x, pos.y, pos.z);
    }

    // Check if needs classification
    if (project.layer == null) {
      showClassifyModal(project);
    }

    showProjectPanel(project);
  }

  function unfocus() {
    focusedProject = null;
    hideProjectPanel();
    jumpToLayer(currentLayer);
  }

  function updateCamera() {
    cam.currentPos.lerp(cam.targetPos, CAMERA_LERP);
    cam.currentLookAt.lerp(cam.targetLookAt, CAMERA_LERP);
    camera.position.copy(cam.currentPos);
    camera.lookAt(cam.currentLookAt);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERLAY SYSTEM — Project panels in 3D space
  // ═══════════════════════════════════════════════════════════════════════════

  function updateOverlays() {
    // Layer 1 panels — positioned from PANEL_ANCHORS
    PANEL_ANCHORS.forEach(anchor => {
      const panel = $(anchor.id);
      if (!panel) return;

      const worldPos = new THREE.Vector3(anchor.x, anchor.y, anchor.z);
      const screen = worldToScreen(worldPos);

      if (screen.z > 1) {
        // Behind camera
        panel.style.opacity = '0';
        panel.style.pointerEvents = 'none';
        return;
      }

      // Distance-based scaling
      const camDist = camera.position.distanceTo(worldPos);
      const scaleFactor = Math.max(0.3, Math.min(1, 6 / camDist));
      const opacity = Math.max(0, Math.min(1, 1 - (camDist - 4) / 20));

      panel.style.left = screen.x + 'px';
      panel.style.top = screen.y + 'px';
      panel.style.transform = `translate(-50%, -50%) scale(${scaleFactor})`;
      panel.style.opacity = opacity;
      panel.style.pointerEvents = opacity > 0.2 ? 'auto' : 'none';
    });

    // Platform labels (Layer 2)
    platformMeshes.forEach(pm => {
      const screen = worldToScreen(pm.worldPos);
      if (screen.z > 1) {
        pm.label.style.opacity = '0';
        return;
      }
      const camDist = camera.position.distanceTo(pm.worldPos);
      const opacity = Math.max(0, Math.min(1, 1 - (camDist - 3) / 25));
      pm.label.style.left = screen.x + 'px';
      pm.label.style.top = screen.y + 'px';
      pm.label.style.transform = 'translate(-50%, -50%)';
      pm.label.style.opacity = opacity;
    });

    // Node labels (Layer 3)
    nodeMeshes.forEach(nm => {
      const screen = worldToScreen(nm.worldPos);
      if (screen.z > 1) {
        nm.label.style.opacity = '0';
        return;
      }
      const camDist = camera.position.distanceTo(nm.worldPos);
      const opacity = Math.max(0, Math.min(1, 1 - (camDist - 3) / 20));
      nm.label.style.left = screen.x + 'px';
      nm.label.style.top = screen.y + 'px';
      nm.label.style.transform = 'translate(-50%, -50%)';
      nm.label.style.opacity = opacity;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENE BUILDER — Rebuild from data
  // ═══════════════════════════════════════════════════════════════════════════

  function rebuildScene() {
    // Clear old platforms
    platformMeshes.forEach(pm => {
      scene.remove(pm.mesh);
      scene.remove(pm.glowRing);
      scene.remove(pm.topSphere);
      if (pm.label.parentNode) pm.label.parentNode.removeChild(pm.label);
    });
    platformMeshes = [];

    // Clear old nodes
    nodeMeshes.forEach(nm => {
      scene.remove(nm.mesh);
      if (nm.label.parentNode) nm.label.parentNode.removeChild(nm.label);
    });
    nodeMeshes = [];

    // Clear connection lines
    connectionLines.forEach(l => scene.remove(l));
    connectionLines = [];

    // Classify projects
    const l2Projects = [];
    const l3Projects = [];

    projects.forEach(p => {
      const classified = autoClassify(p);
      if (classified === 2) l2Projects.push(p);
      else l3Projects.push(p);
    });

    // Build Layer 2 platforms
    l2Projects.forEach((p, i) => createPlatform(p, i, l2Projects.length));

    // Build Layer 3 nodes
    l3Projects.forEach((p, i) => createNode(p, i, l3Projects.length));

    // Create connection lines between nodes
    createConnectionLines();

    // Update HUD stats
    $('hudProjects').textContent = projects.length + ' Projects';
    $('hudTasks').textContent = tasks.length + ' Tasks';
  }

  function autoClassify(project) {
    // If already classified, use that
    if (project.layer === 2 || project.layer === 3) return project.layer;

    // Known ventures → Layer 2
    const slug = slugify(project.name);
    if (KNOWN_VENTURES.some(v => slug.includes(v))) return 2;

    // Has milestones and directory → Layer 2
    if (project.milestones && project.milestones.length > 0 && project.directory) return 2;

    // Default → Layer 3
    return 3;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PANEL RENDERING — Update data in HTML panels
  // ═══════════════════════════════════════════════════════════════════════════

  function updatePanels() {
    // Tasks panel
    const running = tasks.filter(t => t.status === 'running' || t.status === 'active');
    const queued = tasks.filter(t => t.status === 'queued' || t.status === 'pending');
    const completed = tasks.filter(t => t.status === 'completed' || t.status === 'done');

    $('taskActive').textContent = running.length;
    $('taskQueued').textContent = queued.length;
    $('taskCompleted').textContent = completed.length;

    // Deadlines panel
    updateDeadlinesPanel();

    // Priorities panel
    updatePrioritiesPanel();

    // Costs panel
    const todayCost = costData.totalCost || 0;
    $('costToday').textContent = formatCost(todayCost);
    $('costCalls').textContent = (costData.totalCalls || 0).toString();
    $('costPill').textContent = 'TODAY ' + formatCost(todayCost);
    const budgetPct = Math.min(100, (todayCost / DAILY_BUDGET) * 100);
    $('costBarFill').style.width = budgetPct + '%';

    // Approvals panel
    $('approvalsPending').textContent = pendingBrainUpdates;
  }

  function updateDeadlinesPanel() {
    const body = $('panelDeadlinesBody');
    // Collect upcoming milestones across projects
    const upcoming = [];
    projects.forEach(p => {
      (p.milestones || []).forEach(m => {
        if (m.dueDate || m.date) {
          upcoming.push({
            project: p.name,
            name: m.title || m.name || m.text,
            date: m.dueDate || m.date,
          });
        }
      });
    });

    upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));
    const top3 = upcoming.slice(0, 3);

    if (top3.length === 0) {
      body.innerHTML = '<div class="panel-empty">No deadlines set</div>';
    } else {
      body.innerHTML = top3.map(d => `
        <div class="panel-stat-row">
          <span style="font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100px">${escapeHtml(d.name)}</span>
          <span class="val" style="font-size:8px;color:var(--warn)">${new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        </div>
      `).join('');
    }
  }

  function updatePrioritiesPanel() {
    const body = $('panelPrioritiesBody');
    const priorityTasks = tasks
      .filter(t => t.status !== 'completed' && t.status !== 'done')
      .slice(0, 3);

    if (priorityTasks.length === 0) {
      body.innerHTML = '<div class="panel-empty">No priority tasks</div>';
    } else {
      body.innerHTML = priorityTasks.map(t => `
        <div class="panel-stat-row">
          <span style="font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px">${escapeHtml(t.name || t.title || t.id)}</span>
          <span class="val" style="font-size:8px">${t.status || '?'}</span>
        </div>
      `).join('');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROJECT PANEL — Expanded view on focus
  // ═══════════════════════════════════════════════════════════════════════════

  function showProjectPanel(project) {
    const panel = $('projectPanel');
    panel.style.display = 'block';

    $('ppName').textContent = project.name;
    $('ppDesc').textContent = project.description || 'No description';

    // Framework badge
    const state = project.state || {};
    $('ppFramework').textContent = state.framework || project.projectType || 'Project';

    // Dev status
    const statusEl = $('ppDevStatus');
    if (state.devServer === 'running') {
      statusEl.textContent = 'Dev Server Running';
      statusEl.className = 'pp-status online';
    } else {
      statusEl.textContent = 'Offline';
      statusEl.className = 'pp-status';
    }

    // Milestones
    const msContainer = $('ppMilestones');
    const milestones = project.milestones || [];
    if (milestones.length === 0) {
      msContainer.innerHTML = '<div class="panel-empty">No milestones</div>';
    } else {
      msContainer.innerHTML = milestones.map(m => `
        <div class="pp-milestone">
          <div class="pp-milestone-dot ${m.completed ? 'done' : 'pending'}"></div>
          <span class="pp-milestone-name">${escapeHtml(m.title || m.name || m.text)}</span>
          ${m.timestamp ? `<span class="pp-milestone-date">${new Date(m.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>` : ''}
        </div>
      `).join('');
    }

    // Progress
    const completedMs = milestones.filter(m => m.completed).length;
    const progress = milestones.length > 0 ? Math.round((completedMs / milestones.length) * 100) : 0;
    $('ppProgressFill').style.width = progress + '%';
    $('ppProgressText').textContent = progress + '%';
  }

  function hideProjectPanel() {
    $('projectPanel').style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLASSIFICATION
  // ═══════════════════════════════════════════════════════════════════════════

  function showClassifyModal(project) {
    classifyingProject = project;
    $('classifyName').textContent = project.name;
    $('classifyModal').style.display = 'flex';
  }

  function hideClassifyModal() {
    classifyingProject = null;
    $('classifyModal').style.display = 'none';
  }

  function classifyProject(layer) {
    if (!classifyingProject) return;
    wsSend({
      action: 'classify-project',
      projectId: classifyingProject.id,
      layer: layer,
      projectType: layer === 2 ? 'venture' : 'sub-task',
    });
    classifyingProject.layer = layer;
    hideClassifyModal();
    rebuildScene();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET
  // ═══════════════════════════════════════════════════════════════════════════

  function connectWS() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      wsConnected = true;
      $('statusDot').className = 'status-dot online';
      $('statusText').textContent = 'Online';
      // Request spatial data
      wsSend({ action: 'get-spatial-data' });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWSMessage(msg);
      } catch (e) {
        console.warn('WS parse error:', e);
      }
    };

    ws.onclose = () => {
      wsConnected = false;
      $('statusDot').className = 'status-dot offline';
      $('statusText').textContent = 'Disconnected';
      // Reconnect after 3s
      setTimeout(connectWS, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function handleWSMessage(msg) {
    switch (msg.type) {
      case 'connected':
        break;

      case 'spatial-data':
        projects = msg.projects || [];
        tasks = msg.tasks || [];
        costData = msg.costs || {};
        systemData = msg.system || {};
        pendingBrainUpdates = msg.pendingBrainUpdates || 0;
        rebuildScene();
        updatePanels();
        break;

      case 'project-classified':
        // Update local project
        const pc = projects.find(p => p.id === msg.projectId);
        if (pc) {
          pc.layer = msg.layer;
          pc.projectType = msg.projectType;
        }
        rebuildScene();
        break;

      case 'project-created':
        projects.push(msg.project);
        rebuildScene();
        updatePanels();
        break;

      default:
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANIMATION LOOP
  // ═══════════════════════════════════════════════════════════════════════════

  function animate() {
    requestAnimationFrame(animate);

    const time = clock.getElapsedTime();

    // Update camera
    updateCamera();

    // Update orb
    updateOrb(time);

    // Update particles
    updateParticles();

    // Animate platform glow rings
    platformMeshes.forEach((pm, i) => {
      pm.glowRing.rotation.z += 0.002;
      pm.glowRing.material.opacity = 0.2 + Math.sin(time * 2 + i) * 0.1;

      // Hover float for top sphere
      pm.topSphere.position.y = pm.mesh.position.y + 0.5 + Math.sin(time * 1.5 + i * 0.5) * 0.1;
    });

    // Animate node spheres
    nodeMeshes.forEach((nm, i) => {
      nm.mesh.position.y += Math.sin(time * 0.8 + i * 0.7) * 0.001;
      nm.mesh.material.opacity = 0.5 + Math.sin(time + i) * 0.2;
    });

    // Update HTML overlays
    updateOverlays();

    // Render
    renderer.render(scene, camera);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RAYCASTER — Click detection
  // ═══════════════════════════════════════════════════════════════════════════

  function onCanvasClick(event) {
    const canvas = renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    // Check platforms
    const platformObjs = platformMeshes.map(pm => pm.mesh);
    const nodeObjs = nodeMeshes.map(nm => nm.mesh);
    const allClickable = [...platformObjs, ...nodeObjs];

    const intersects = raycaster.intersectObjects(allClickable);
    if (intersects.length > 0) {
      const hit = intersects[0].object;
      const projectId = hit.userData.projectId;
      const project = projects.find(p => p.id === projectId);
      if (project) {
        focusProject(project);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT BINDINGS
  // ═══════════════════════════════════════════════════════════════════════════

  function bindEvents() {
    const canvas = renderer.domElement;

    // Mouse drag for orbit
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      cam.isDragging = true;
      cam.lastMouse = { x: e.clientX, y: e.clientY };
      document.body.classList.add('dragging');
    });

    window.addEventListener('mousemove', (e) => {
      if (!cam.isDragging) return;
      const dx = e.clientX - cam.lastMouse.x;
      const dy = e.clientY - cam.lastMouse.y;
      cam.lastMouse = { x: e.clientX, y: e.clientY };

      // Orbit around current lookAt
      const offset = cam.targetPos.clone().sub(cam.targetLookAt);
      const dist = offset.length();

      cam.orbitTheta -= dx * 0.005;
      cam.orbitPhi = Math.max(-0.8, Math.min(1.2, cam.orbitPhi - dy * 0.005));

      offset.x = dist * Math.sin(cam.orbitPhi) * Math.sin(cam.orbitTheta);
      offset.y = dist * Math.cos(cam.orbitPhi);
      offset.z = dist * Math.sin(cam.orbitPhi) * Math.cos(cam.orbitTheta);

      cam.targetPos.copy(cam.targetLookAt).add(offset);
    });

    window.addEventListener('mouseup', () => {
      cam.isDragging = false;
      document.body.classList.remove('dragging');
    });

    // Scroll zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = cam.targetPos.clone().sub(cam.targetLookAt).normalize();
      const zoomDelta = e.deltaY * 0.01;
      cam.targetPos.addScaledVector(dir, zoomDelta);
    }, { passive: false });

    // Click
    canvas.addEventListener('click', (e) => {
      // Only fire click if not dragging
      if (Math.abs(e.clientX - cam.lastMouse.x) < 3 && Math.abs(e.clientY - cam.lastMouse.y) < 3) {
        onCanvasClick(e);
      }
    });

    // Keyboard
    window.addEventListener('keydown', (e) => {
      // Ignore if typing in input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      const speed = 0.5;
      const forward = cam.targetLookAt.clone().sub(cam.targetPos).normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

      switch (e.key) {
        case '1':
          jumpToLayer(1);
          break;
        case '2':
          jumpToLayer(2);
          break;
        case '3':
          jumpToLayer(3);
          break;
        case 'w':
        case 'W':
        case 'ArrowUp':
          cam.targetPos.addScaledVector(forward, speed);
          cam.targetLookAt.addScaledVector(forward, speed);
          break;
        case 's':
        case 'S':
        case 'ArrowDown':
          cam.targetPos.addScaledVector(forward, -speed);
          cam.targetLookAt.addScaledVector(forward, -speed);
          break;
        case 'a':
        case 'A':
        case 'ArrowLeft':
          cam.targetPos.addScaledVector(right, -speed);
          cam.targetLookAt.addScaledVector(right, -speed);
          break;
        case 'd':
        case 'D':
        case 'ArrowRight':
          cam.targetPos.addScaledVector(right, speed);
          cam.targetLookAt.addScaledVector(right, speed);
          break;
        case 'Escape':
          unfocus();
          break;
        case ' ':
          e.preventDefault();
          jumpToLayer(1);
          break;
      }
    });

    // Layer buttons
    document.querySelectorAll('.layer-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        jumpToLayer(parseInt(btn.dataset.layer));
      });
    });

    // Project panel close
    $('ppClose').addEventListener('click', unfocus);

    // Open in chat
    $('ppOpenChat').addEventListener('click', () => {
      if (focusedProject) {
        window.location.href = '/?project=' + focusedProject.id;
      }
    });

    // Classification modal
    $('classifyL2').addEventListener('click', () => classifyProject(2));
    $('classifyL3').addEventListener('click', () => classifyProject(3));

    // Window resize
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA REFRESH
  // ═══════════════════════════════════════════════════════════════════════════

  function startDataRefresh() {
    // Refresh spatial data every 15 seconds
    setInterval(() => {
      if (wsConnected) {
        wsSend({ action: 'get-spatial-data' });
      }
    }, 15000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════

  document.addEventListener('DOMContentLoaded', () => {
    initThree();
    bindEvents();
    connectWS();
    startDataRefresh();
    animate();
  });

})();
