/**
 * VANCE Command Center — Particle Background
 * Self-contained Three.js scene with 400 drifting particles and a Tron grid.
 * Exposes window.particlePulse() for event-driven glow spikes.
 */
(function () {
  'use strict';

  if (typeof THREE === 'undefined') {
    console.warn('[particles] Three.js not loaded, skipping particle background');
    return;
  }

  const PARTICLE_COUNT = 400;
  const COLORS = [0x4488ff, 0x00e5a0, 0xff8c00]; // blue, green, orange
  const BASE_OPACITY = 0.15;
  const DRIFT_SPEED = 0.0003;

  // ─── Scene Setup ───
  const canvas = document.getElementById('particleCanvas');
  if (!canvas) return;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 2, 8);
  camera.lookAt(0, 0, 0);

  // ─── Particles ───
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const colors = new Float32Array(PARTICLE_COUNT * 3);
  const sizes = new Float32Array(PARTICLE_COUNT);
  const velocities = new Float32Array(PARTICLE_COUNT * 3);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3 = i * 3;
    positions[i3] = (Math.random() - 0.5) * 20;
    positions[i3 + 1] = (Math.random() - 0.5) * 14;
    positions[i3 + 2] = (Math.random() - 0.5) * 12;

    const color = new THREE.Color(COLORS[i % COLORS.length]);
    colors[i3] = color.r;
    colors[i3 + 1] = color.g;
    colors[i3 + 2] = color.b;

    sizes[i] = Math.random() * 3 + 1;

    velocities[i3] = (Math.random() - 0.5) * DRIFT_SPEED;
    velocities[i3 + 1] = (Math.random() - 0.5) * DRIFT_SPEED;
    velocities[i3 + 2] = (Math.random() - 0.5) * DRIFT_SPEED;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.PointsMaterial({
    size: 2,
    vertexColors: true,
    transparent: true,
    opacity: BASE_OPACITY,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    depthWrite: false,
  });

  const particles = new THREE.Points(geometry, material);
  scene.add(particles);

  // ─── Grid Plane (Tron-style) ───
  const gridHelper = new THREE.GridHelper(30, 40, 0x4488ff, 0x4488ff);
  gridHelper.position.y = -5;
  gridHelper.material.opacity = 0.04;
  gridHelper.material.transparent = true;
  scene.add(gridHelper);

  // ─── Pulse State ───
  let pulseIntensity = 0;
  let pulseDecay = 0;

  window.particlePulse = function () {
    pulseIntensity = 1.0;
    pulseDecay = 0.02; // decays over ~50 frames (~1s at 60fps)
  };

  // ─── Animation Loop ───
  function animate() {
    requestAnimationFrame(animate);

    const posArr = geometry.attributes.position.array;

    // Drift particles
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;
      posArr[i3] += velocities[i3];
      posArr[i3 + 1] += velocities[i3 + 1];
      posArr[i3 + 2] += velocities[i3 + 2];

      // Wrap around boundaries
      if (posArr[i3] > 10) posArr[i3] = -10;
      if (posArr[i3] < -10) posArr[i3] = 10;
      if (posArr[i3 + 1] > 7) posArr[i3 + 1] = -7;
      if (posArr[i3 + 1] < -7) posArr[i3 + 1] = 7;
      if (posArr[i3 + 2] > 6) posArr[i3 + 2] = -6;
      if (posArr[i3 + 2] < -6) posArr[i3 + 2] = 6;
    }
    geometry.attributes.position.needsUpdate = true;

    // Slow Y-axis rotation
    particles.rotation.y += 0.0002;

    // Pulse effect
    if (pulseIntensity > 0) {
      material.opacity = BASE_OPACITY + pulseIntensity * 0.4;
      material.size = 2 + pulseIntensity * 3;
      pulseIntensity -= pulseDecay;
      if (pulseIntensity < 0) {
        pulseIntensity = 0;
        material.opacity = BASE_OPACITY;
        material.size = 2;
      }
    }

    renderer.render(scene, camera);
  }

  animate();

  // ─── Resize ───
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
})();
