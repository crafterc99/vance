(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE CONTROLLER — MediaPipe Hands overlay for Spatial UI
  // ═══════════════════════════════════════════════════════════════════════════

  const GESTURE_CONFIG = {
    maxHands: 1,
    minDetectionConfidence: 0.65,
    minTrackingConfidence: 0.5,
    modelComplexity: 0,  // 0 = lite (faster), 1 = full

    // Throttle: only process every Nth frame to prevent lag
    processEveryNFrames: 3,

    // Gesture thresholds
    pinchThreshold: 0.07,
    swipeVelocity: 15,
    swipeMinDistance: 0.1,
    holdDuration: 600,
    zoomSensitivity: 8,
    orbitSensitivity: 3,
    cursorSmoothing: 0.25,

    // Script load timeout
    scriptTimeout: 15000,
  };

  // Landmark indices
  const LM = {
    WRIST: 0,
    THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
    INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
    MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
    RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
    PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  let active = false;
  let hands = null;
  let cameraStream = null;
  let videoEl = null;
  let canvasEl = null;
  let canvasCtx = null;
  let animFrameId = null;
  let frameCount = 0;
  let processing = false; // prevent frame stacking

  let currentGesture = 'none';
  let gestureStartTime = 0;
  let gestureHeld = false;

  const cursor = { x: 0.5, y: 0.5, smoothX: 0.5, smoothY: 0.5 };
  const prevCursor = { x: 0.5, y: 0.5 };

  let pinchStartDist = 0;
  let isPinching = false;
  let isGrabbing = false;

  const swipeHistory = [];
  let lastLayerSwitch = 0;
  let lastAction = 0;
  const ACTION_COOLDOWN = 500;

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  function createOverlayDOM() {
    // Remove existing if any
    const existing = document.getElementById('gestureOverlay');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'gestureOverlay';
    container.className = 'gesture-overlay';
    container.innerHTML = `
      <div class="gesture-pip" id="gesturePip">
        <video id="gestureVideo" autoplay playsinline muted></video>
        <canvas id="gestureCanvas"></canvas>
        <div class="gesture-pip-label">GESTURE CAM</div>
      </div>
      <div class="gesture-cursor" id="gestureCursor">
        <div class="gesture-cursor-ring"></div>
        <div class="gesture-cursor-dot"></div>
      </div>
      <div class="gesture-indicator" id="gestureIndicator">
        <div class="gesture-indicator-icon" id="gestureIcon"></div>
        <div class="gesture-indicator-label" id="gestureLabel">READY</div>
      </div>
      <div class="gesture-status" id="gestureStatus">
        <span class="gesture-status-dot"></span>
        <span class="gesture-status-text">INITIALIZING</span>
      </div>
      <div class="gesture-trail" id="gestureTrail"></div>
    `;
    document.body.appendChild(container);

    videoEl = document.getElementById('gestureVideo');
    canvasEl = document.getElementById('gestureCanvas');
    canvasCtx = canvasEl.getContext('2d');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MEDIAPIPE LOADING — with timeout & fallback versions
  // ═══════════════════════════════════════════════════════════════════════════

  function loadScript(src, timeout) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      const timer = setTimeout(() => {
        s.onload = s.onerror = null;
        reject(new Error('Script timeout: ' + src));
      }, timeout || GESTURE_CONFIG.scriptTimeout);
      s.onload = () => { clearTimeout(timer); resolve(); };
      s.onerror = () => { clearTimeout(timer); reject(new Error('Script load failed: ' + src)); };
      document.head.appendChild(s);
    });
  }

  async function loadMediaPipe() {
    // Use unversioned latest from CDN for reliability
    const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe';
    const scripts = [
      `${CDN}/hands/hands.js`,
      `${CDN}/camera_utils/camera_utils.js`,
      `${CDN}/drawing_utils/drawing_utils.js`,
    ];

    for (const src of scripts) {
      updateStatus('LOADING ' + src.split('/').pop().replace('.js', '').toUpperCase() + '...', false);
      try {
        await loadScript(src);
      } catch (err) {
        console.warn('MediaPipe load warning:', err.message);
        throw err;
      }
    }
  }

  async function initHands() {
    if (!window.Hands) {
      throw new Error('MediaPipe Hands not loaded — window.Hands is undefined');
    }

    hands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    hands.setOptions({
      maxNumHands: GESTURE_CONFIG.maxHands,
      modelComplexity: GESTURE_CONFIG.modelComplexity,
      minDetectionConfidence: GESTURE_CONFIG.minDetectionConfidence,
      minTrackingConfidence: GESTURE_CONFIG.minTrackingConfidence,
    });

    hands.onResults(onHandResults);

    // Warm up the model with a blank frame
    updateStatus('WARMING UP MODEL...', false);
    const warmupCanvas = document.createElement('canvas');
    warmupCanvas.width = 64;
    warmupCanvas.height = 64;
    try {
      await hands.send({ image: warmupCanvas });
    } catch (e) {
      console.warn('Warmup send failed (non-fatal):', e);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMERA
  // ═══════════════════════════════════════════════════════════════════════════

  async function startCamera() {
    updateStatus('REQUESTING CAMERA...', false);
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        updateStatus('CAM DENIED', false);
        throw new Error('Camera permission denied');
      }
      if (err.name === 'NotFoundError') {
        updateStatus('NO CAMERA', false);
        throw new Error('No camera found');
      }
      updateStatus('CAM ERROR', false);
      throw err;
    }

    videoEl.srcObject = cameraStream;

    // Wait for video to actually be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video start timeout')), 8000);
      videoEl.onloadeddata = () => { clearTimeout(timeout); resolve(); };
      videoEl.onerror = (e) => { clearTimeout(timeout); reject(e); };
      videoEl.play().catch(reject);
    });

    canvasEl.width = videoEl.videoWidth || 640;
    canvasEl.height = videoEl.videoHeight || 480;

    updateStatus('TRACKING', true);
    frameCount = 0;
    processing = false;
    runProcessLoop();
  }

  function stopCamera() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FRAME PROCESSING — Throttled to prevent lag
  // ═══════════════════════════════════════════════════════════════════════════

  function runProcessLoop() {
    if (!active) return;

    frameCount++;

    // Only process every Nth frame to keep the UI responsive
    if (frameCount % GESTURE_CONFIG.processEveryNFrames === 0 && !processing) {
      if (videoEl && videoEl.readyState >= 2 && hands) {
        processing = true;
        hands.send({ image: videoEl })
          .then(() => { processing = false; })
          .catch((err) => {
            console.warn('Hand detection error:', err);
            processing = false;
          });
      }
    }

    animFrameId = requestAnimationFrame(runProcessLoop);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HAND RESULTS
  // ═══════════════════════════════════════════════════════════════════════════

  function onHandResults(results) {
    drawLandmarks(results);

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      setGesture('none');
      hideCursor();
      return;
    }

    const landmarks = results.multiHandLandmarks[0];
    const handedness = results.multiHandedness?.[0]?.label || 'Right';

    // Cursor from index finger tip (mirrored)
    const indexTip = landmarks[LM.INDEX_TIP];
    cursor.x = 1 - indexTip.x;
    cursor.y = indexTip.y;
    cursor.smoothX += (cursor.x - cursor.smoothX) * GESTURE_CONFIG.cursorSmoothing;
    cursor.smoothY += (cursor.y - cursor.smoothY) * GESTURE_CONFIG.cursorSmoothing;

    updateCursorPosition();
    showCursor();

    // Swipe history
    swipeHistory.push({ x: cursor.x, y: cursor.y, t: Date.now() });
    if (swipeHistory.length > 8) swipeHistory.shift();

    // Classify and act
    const gesture = classifyGesture(landmarks, handedness);
    setGesture(gesture);
    executeGestureAction(gesture, landmarks);

    prevCursor.x = cursor.smoothX;
    prevCursor.y = cursor.smoothY;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE CLASSIFICATION
  // ═══════════════════════════════════════════════════════════════════════════

  function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + ((a.z || 0) - (b.z || 0)) ** 2);
  }

  function isFingerExtended(landmarks, tipIdx, pipIdx, mcpIdx) {
    return dist(landmarks[tipIdx], landmarks[mcpIdx]) > dist(landmarks[pipIdx], landmarks[mcpIdx]) * 1.2;
  }

  function classifyGesture(lm) {
    const thumbTip = lm[LM.THUMB_TIP];
    const indexTip = lm[LM.INDEX_TIP];

    const indexExt = isFingerExtended(lm, LM.INDEX_TIP, LM.INDEX_PIP, LM.INDEX_MCP);
    const middleExt = isFingerExtended(lm, LM.MIDDLE_TIP, LM.MIDDLE_PIP, LM.MIDDLE_MCP);
    const ringExt = isFingerExtended(lm, LM.RING_TIP, LM.RING_PIP, LM.RING_MCP);
    const pinkyExt = isFingerExtended(lm, LM.PINKY_TIP, LM.PINKY_PIP, LM.PINKY_MCP);

    const pinchDist = dist(thumbTip, indexTip);
    const allCurled = !indexExt && !middleExt && !ringExt && !pinkyExt;

    // 1. PINCH
    if (pinchDist < GESTURE_CONFIG.pinchThreshold && !allCurled) return 'pinch';

    // 2. FIST
    if (allCurled) {
      // Check thumbs up: thumb tip above thumb MCP
      if (lm[LM.THUMB_TIP].y < lm[LM.THUMB_MCP].y - 0.05) return 'thumbsup';
      return 'fist';
    }

    // 3. PEACE — index + middle only
    if (indexExt && middleExt && !ringExt && !pinkyExt) return 'peace';

    // 4. POINT — only index
    if (indexExt && !middleExt && !ringExt && !pinkyExt) return 'point';

    // 5. OPEN PALM — all extended
    if (indexExt && middleExt && ringExt && pinkyExt) return 'palm';

    return 'none';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  function executeGestureAction(gesture, landmarks) {
    const now = Date.now();
    const api = window._spatialGestureAPI;
    if (!api) return;

    switch (gesture) {
      case 'point': {
        const sx = cursor.smoothX * window.innerWidth;
        const sy = cursor.smoothY * window.innerHeight;
        api.gestureRaycast(sx, sy);
        break;
      }
      case 'pinch': {
        const pd = dist(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]);
        if (!isPinching) { isPinching = true; pinchStartDist = pd; }
        else {
          api.gestureZoom((pd - pinchStartDist) * GESTURE_CONFIG.zoomSensitivity);
          pinchStartDist = pd;
        }
        break;
      }
      case 'fist': {
        if (!isGrabbing) { isGrabbing = true; }
        else {
          const dx = (cursor.smoothX - prevCursor.x) * GESTURE_CONFIG.orbitSensitivity;
          const dy = (cursor.smoothY - prevCursor.y) * GESTURE_CONFIG.orbitSensitivity;
          api.gestureOrbit(dx, dy);
        }
        break;
      }
      case 'palm': {
        if (swipeHistory.length < 4 || now - lastLayerSwitch < 800) break;
        const first = swipeHistory[0], last = swipeHistory[swipeHistory.length - 1];
        const dx = last.x - first.x, dt = last.t - first.t;
        if (dt === 0) break;
        const vel = Math.abs(dx) / dt * 1000;
        if (Math.abs(dx) > GESTURE_CONFIG.swipeMinDistance && vel > GESTURE_CONFIG.swipeVelocity) {
          lastLayerSwitch = now;
          if (dx > 0) api.gestureLayerNext(); else api.gestureLayerPrev();
          flashIndicator();
          swipeHistory.length = 0;
        }
        break;
      }
      case 'thumbsup': {
        if (gestureHeld && now - lastAction > ACTION_COOLDOWN) {
          lastAction = now;
          api.confirmAction();
          flashIndicator();
        }
        break;
      }
      default:
        isPinching = false;
        isGrabbing = false;
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UI UPDATES
  // ═══════════════════════════════════════════════════════════════════════════

  const GESTURE_ICONS = {
    none: '', point: '\u261D', pinch: '\uD83E\uDD0F', fist: '\u270A',
    palm: '\uD83D\uDD90', thumbsup: '\uD83D\uDC4D', peace: '\u270C',
  };

  const GESTURE_LABELS = {
    none: 'NO HAND', point: 'POINT \u2014 SELECT', pinch: 'PINCH \u2014 ZOOM',
    fist: 'FIST \u2014 ORBIT', palm: 'PALM \u2014 SWIPE',
    thumbsup: 'CONFIRM', peace: 'PEACE',
  };

  function setGesture(gesture) {
    if (gesture !== currentGesture) {
      currentGesture = gesture;
      gestureStartTime = Date.now();
      gestureHeld = false;
      if (gesture !== 'pinch') isPinching = false;
      if (gesture !== 'fist') isGrabbing = false;
    }

    if (!gestureHeld && Date.now() - gestureStartTime > GESTURE_CONFIG.holdDuration) {
      gestureHeld = true;
    }

    const icon = document.getElementById('gestureIcon');
    const label = document.getElementById('gestureLabel');
    const indicator = document.getElementById('gestureIndicator');
    if (icon) icon.textContent = GESTURE_ICONS[gesture] || '';
    if (label) label.textContent = GESTURE_LABELS[gesture] || '';
    if (indicator) {
      indicator.className = 'gesture-indicator gesture-' + gesture;
      if (gestureHeld) indicator.classList.add('gesture-held');
    }

    const cursorEl = document.getElementById('gestureCursor');
    if (cursorEl) cursorEl.className = 'gesture-cursor gesture-cursor-' + gesture;
  }

  function updateCursorPosition() {
    const el = document.getElementById('gestureCursor');
    if (!el) return;
    const x = cursor.smoothX * window.innerWidth;
    const y = cursor.smoothY * window.innerHeight;
    el.style.transform = `translate(${x}px, ${y}px)`;
    addTrailDot(x, y);
  }

  function showCursor() {
    const el = document.getElementById('gestureCursor');
    if (el) el.style.opacity = '1';
  }

  function hideCursor() {
    const el = document.getElementById('gestureCursor');
    if (el) el.style.opacity = '0';
  }

  function updateStatus(text, ok) {
    const el = document.getElementById('gestureStatus');
    if (!el) return;
    const dot = el.querySelector('.gesture-status-dot');
    const txt = el.querySelector('.gesture-status-text');
    if (dot) dot.className = 'gesture-status-dot ' + (ok ? 'active' : 'error');
    if (txt) txt.textContent = text;
  }

  function flashIndicator() {
    const el = document.getElementById('gestureIndicator');
    if (!el) return;
    el.classList.add('gesture-flash');
    setTimeout(() => el.classList.remove('gesture-flash'), 300);
  }

  // Trail
  const trailDots = [];
  function addTrailDot(x, y) {
    const container = document.getElementById('gestureTrail');
    if (!container) return;
    const dot = document.createElement('div');
    dot.className = 'gesture-trail-dot';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    container.appendChild(dot);
    trailDots.push(dot);
    requestAnimationFrame(() => { dot.style.opacity = '0'; dot.style.transform = 'scale(0)'; });
    setTimeout(() => { dot.remove(); const i = trailDots.indexOf(dot); if (i > -1) trailDots.splice(i, 1); }, 400);
    while (trailDots.length > 12) trailDots.shift().remove();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAWING — Landmarks on PiP
  // ═══════════════════════════════════════════════════════════════════════════

  function drawLandmarks(results) {
    if (!canvasCtx || !canvasEl) return;
    canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!results.multiHandLandmarks) return;

    for (const landmarks of results.multiHandLandmarks) {
      const conns = [
        [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
        [5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],
        [13,17],[17,18],[18,19],[19,20],[0,17],
      ];
      canvasCtx.strokeStyle = 'rgba(68,136,255,0.6)';
      canvasCtx.lineWidth = 2;
      for (const [a, b] of conns) {
        canvasCtx.beginPath();
        canvasCtx.moveTo(landmarks[a].x * canvasEl.width, landmarks[a].y * canvasEl.height);
        canvasCtx.lineTo(landmarks[b].x * canvasEl.width, landmarks[b].y * canvasEl.height);
        canvasCtx.stroke();
      }
      for (let i = 0; i < landmarks.length; i++) {
        const x = landmarks[i].x * canvasEl.width, y = landmarks[i].y * canvasEl.height;
        const tip = [4,8,12,16,20].includes(i);
        canvasCtx.beginPath();
        canvasCtx.arc(x, y, tip ? 5 : 3, 0, Math.PI * 2);
        canvasCtx.fillStyle = tip ? '#4488ff' : 'rgba(68,136,255,0.4)';
        canvasCtx.fill();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIVATE / DEACTIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  async function activate() {
    if (active) return;
    active = true;

    createOverlayDOM();

    try {
      await loadMediaPipe();
      updateStatus('INITIALIZING MODEL...', false);
      await initHands();
      await startCamera();

      const overlay = document.getElementById('gestureOverlay');
      if (overlay) overlay.classList.add('active');
      const btn = document.getElementById('gestureToggleBtn');
      if (btn) btn.classList.add('active');

    } catch (err) {
      console.error('Gesture init failed:', err);
      updateStatus(err.message ? err.message.slice(0, 20).toUpperCase() : 'FAILED', false);
      // Keep overlay visible for 3s so user sees the error
      setTimeout(() => deactivate(), 3000);
    }
  }

  function deactivate() {
    active = false;
    stopCamera();

    const overlay = document.getElementById('gestureOverlay');
    if (overlay) {
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 300);
    }

    const btn = document.getElementById('gestureToggleBtn');
    if (btn) btn.classList.remove('active');

    hands = null;
    currentGesture = 'none';
    isPinching = false;
    isGrabbing = false;
    swipeHistory.length = 0;
  }

  function toggle() {
    if (active) deactivate(); else activate();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPOSE API
  // ═══════════════════════════════════════════════════════════════════════════

  window._gestureController = { activate, deactivate, toggle, isActive: () => active, getCurrentGesture: () => currentGesture };

})();
