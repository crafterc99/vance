(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE CONTROLLER — MediaPipe Hands overlay for Spatial UI
  // ═══════════════════════════════════════════════════════════════════════════

  const GESTURE_CONFIG = {
    // MediaPipe settings
    maxHands: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.6,
    modelComplexity: 1,

    // Gesture thresholds
    pinchThreshold: 0.06,       // distance between thumb & index tips
    fistThreshold: 0.08,        // avg finger curl distance
    pointExtendThreshold: 0.12, // index finger extension
    swipeVelocity: 0.015,       // min velocity for swipe detection
    swipeMinDistance: 0.1,       // min distance for swipe
    holdDuration: 600,           // ms to hold a gesture before action
    zoomSensitivity: 8,         // pinch-to-zoom multiplier
    orbitSensitivity: 3,        // orbit rotation multiplier
    cursorSmoothing: 0.3,       // lerp factor for cursor position

    // Camera preview
    previewWidth: 200,
    previewHeight: 150,
  };

  // Landmark indices (MediaPipe hand model)
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
  let rafId = null;

  let currentGesture = 'none';
  let gestureStartTime = 0;
  let gestureHeld = false;

  // Cursor state
  const cursor = { x: 0.5, y: 0.5, smoothX: 0.5, smoothY: 0.5 };
  const prevCursor = { x: 0.5, y: 0.5 };

  // Pinch state for zoom
  let pinchStartDist = 0;
  let isPinching = false;

  // Swipe tracking
  const swipeHistory = [];
  const SWIPE_HISTORY_LEN = 8;

  // Grab/drag state
  let isGrabbing = false;
  let grabStartPos = { x: 0, y: 0 };

  // Cooldowns
  let lastLayerSwitch = 0;
  let lastAction = 0;
  const ACTION_COOLDOWN = 500;

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  function createOverlayDOM() {
    // Container
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
  // MEDIAPIPE INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadMediaPipe() {
    // Load MediaPipe scripts dynamically
    const scripts = [
      'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js',
      'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js',
      'https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@0.3.1675466124/drawing_utils.js',
    ];

    for (const src of scripts) {
      if (document.querySelector(`script[src="${src}"]`)) continue;
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
  }

  async function initMediaPipe() {
    await loadMediaPipe();

    hands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
    });

    hands.setOptions({
      maxNumHands: GESTURE_CONFIG.maxHands,
      modelComplexity: GESTURE_CONFIG.modelComplexity,
      minDetectionConfidence: GESTURE_CONFIG.minDetectionConfidence,
      minTrackingConfidence: GESTURE_CONFIG.minTrackingConfidence,
    });

    hands.onResults(onHandResults);
  }

  async function startCamera() {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
      });
      videoEl.srcObject = cameraStream;
      await videoEl.play();

      canvasEl.width = videoEl.videoWidth || 640;
      canvasEl.height = videoEl.videoHeight || 480;

      updateStatus('TRACKING', true);
      processFrame();
    } catch (err) {
      console.error('Gesture camera error:', err);
      updateStatus('CAM ERROR', false);
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  async function processFrame() {
    if (!active || !hands || !videoEl) return;
    if (videoEl.readyState >= 2) {
      await hands.send({ image: videoEl });
    }
    rafId = requestAnimationFrame(processFrame);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HAND RESULT PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════

  function onHandResults(results) {
    // Draw landmarks on pip canvas
    drawLandmarks(results);

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      setGesture('none');
      hideCursor();
      return;
    }

    const landmarks = results.multiHandLandmarks[0];
    const handedness = results.multiHandedness?.[0]?.label || 'Right';

    // Update cursor position from index finger tip (mirrored)
    const indexTip = landmarks[LM.INDEX_TIP];
    cursor.x = 1 - indexTip.x; // mirror horizontal
    cursor.y = indexTip.y;
    cursor.smoothX += (cursor.x - cursor.smoothX) * GESTURE_CONFIG.cursorSmoothing;
    cursor.smoothY += (cursor.y - cursor.smoothY) * GESTURE_CONFIG.cursorSmoothing;

    updateCursorPosition();
    showCursor();

    // Track swipe history
    swipeHistory.push({ x: cursor.x, y: cursor.y, t: Date.now() });
    if (swipeHistory.length > SWIPE_HISTORY_LEN) swipeHistory.shift();

    // Detect gesture
    const gesture = classifyGesture(landmarks, handedness);
    setGesture(gesture);

    // Execute gesture actions
    executeGestureAction(gesture, landmarks);

    // Store previous cursor
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
    const tip = landmarks[tipIdx];
    const pip = landmarks[pipIdx];
    const mcp = landmarks[mcpIdx];
    return dist(tip, mcp) > dist(pip, mcp) * 1.2;
  }

  function classifyGesture(lm, handedness) {
    const thumbTip = lm[LM.THUMB_TIP];
    const indexTip = lm[LM.INDEX_TIP];
    const middleTip = lm[LM.MIDDLE_TIP];
    const ringTip = lm[LM.RING_TIP];
    const pinkyTip = lm[LM.PINKY_TIP];
    const wrist = lm[LM.WRIST];

    const indexExtended = isFingerExtended(lm, LM.INDEX_TIP, LM.INDEX_PIP, LM.INDEX_MCP);
    const middleExtended = isFingerExtended(lm, LM.MIDDLE_TIP, LM.MIDDLE_PIP, LM.MIDDLE_MCP);
    const ringExtended = isFingerExtended(lm, LM.RING_TIP, LM.RING_PIP, LM.RING_MCP);
    const pinkyExtended = isFingerExtended(lm, LM.PINKY_TIP, LM.PINKY_PIP, LM.PINKY_MCP);

    const pinchDist = dist(thumbTip, indexTip);
    const allFingersCurled = !indexExtended && !middleExtended && !ringExtended && !pinkyExtended;

    // 1. PINCH — thumb + index close together
    if (pinchDist < GESTURE_CONFIG.pinchThreshold) {
      return 'pinch';
    }

    // 2. FIST — all fingers curled
    if (allFingersCurled) {
      return 'fist';
    }

    // 3. PEACE — index + middle extended, others curled
    if (indexExtended && middleExtended && !ringExtended && !pinkyExtended) {
      return 'peace';
    }

    // 4. THUMBS UP — thumb extended upward, all fingers curled
    const thumbUp = lm[LM.THUMB_TIP].y < lm[LM.THUMB_MCP].y - 0.05;
    if (thumbUp && allFingersCurled) {
      return 'thumbsup';
    }

    // 5. POINT — only index extended
    if (indexExtended && !middleExtended && !ringExtended && !pinkyExtended) {
      return 'point';
    }

    // 6. OPEN PALM — all fingers extended
    if (indexExtended && middleExtended && ringExtended && pinkyExtended) {
      return 'palm';
    }

    return 'none';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE ACTIONS — Maps to spatial UI controls
  // ═══════════════════════════════════════════════════════════════════════════

  function executeGestureAction(gesture, landmarks) {
    const now = Date.now();
    const spatial = window._spatialGestureAPI;
    if (!spatial) return;

    switch (gesture) {
      case 'point':
        // Move virtual cursor, check for hover/raycast on projects
        handlePointGesture(spatial);
        break;

      case 'pinch':
        // Zoom in/out based on pinch distance changes
        handlePinchGesture(landmarks, spatial);
        break;

      case 'fist':
        // Grab and drag to orbit camera
        handleFistGesture(spatial);
        break;

      case 'palm':
        // Swipe detection for layer switching
        handlePalmGesture(spatial, now);
        break;

      case 'thumbsup':
        // Confirm/approve action (held gesture)
        if (gestureHeld && now - lastAction > ACTION_COOLDOWN) {
          lastAction = now;
          spatial.confirmAction();
          flashIndicator('approve');
        }
        break;

      case 'peace':
        // Toggle gesture mode on/off (held gesture)
        if (gestureHeld && now - lastAction > ACTION_COOLDOWN * 2) {
          lastAction = now;
          // Don't toggle off via gesture—too easy to accidentally trigger
          flashIndicator('peace');
        }
        break;

      default:
        // Reset states when no gesture
        isPinching = false;
        isGrabbing = false;
        break;
    }
  }

  function handlePointGesture(spatial) {
    // Convert normalized cursor to screen coordinates
    const screenX = cursor.smoothX * window.innerWidth;
    const screenY = cursor.smoothY * window.innerHeight;
    spatial.gestureRaycast(screenX, screenY);
  }

  function handlePinchGesture(landmarks, spatial) {
    const pinchDist = dist(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]);

    if (!isPinching) {
      isPinching = true;
      pinchStartDist = pinchDist;
    } else {
      const delta = (pinchDist - pinchStartDist) * GESTURE_CONFIG.zoomSensitivity;
      spatial.gestureZoom(delta);
      pinchStartDist = pinchDist; // continuously update for smooth zoom
    }
  }

  function handleFistGesture(spatial) {
    if (!isGrabbing) {
      isGrabbing = true;
      grabStartPos.x = cursor.smoothX;
      grabStartPos.y = cursor.smoothY;
    } else {
      const dx = (cursor.smoothX - prevCursor.x) * GESTURE_CONFIG.orbitSensitivity;
      const dy = (cursor.smoothY - prevCursor.y) * GESTURE_CONFIG.orbitSensitivity;
      spatial.gestureOrbit(dx, dy);
    }
  }

  function handlePalmGesture(spatial, now) {
    if (swipeHistory.length < 4) return;
    if (now - lastLayerSwitch < 800) return;

    const first = swipeHistory[0];
    const last = swipeHistory[swipeHistory.length - 1];
    const dx = last.x - first.x;
    const dt = last.t - first.t;

    if (dt === 0) return;
    const velocity = Math.abs(dx) / dt * 1000;

    if (Math.abs(dx) > GESTURE_CONFIG.swipeMinDistance && velocity > GESTURE_CONFIG.swipeVelocity * 1000) {
      lastLayerSwitch = now;
      if (dx > 0) {
        spatial.gestureLayerNext();
        flashIndicator('swipe-right');
      } else {
        spatial.gestureLayerPrev();
        flashIndicator('swipe-left');
      }
      swipeHistory.length = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UI UPDATES
  // ═══════════════════════════════════════════════════════════════════════════

  const GESTURE_ICONS = {
    none: '',
    point: '👆',
    pinch: '🤏',
    fist: '✊',
    palm: '🖐️',
    thumbsup: '👍',
    peace: '✌️',
  };

  const GESTURE_LABELS = {
    none: 'NO HAND',
    point: 'POINT — SELECT',
    pinch: 'PINCH — ZOOM',
    fist: 'FIST — ORBIT',
    palm: 'PALM — SWIPE',
    thumbsup: 'CONFIRM',
    peace: 'PEACE',
  };

  function setGesture(gesture) {
    const changed = gesture !== currentGesture;
    if (changed) {
      currentGesture = gesture;
      gestureStartTime = Date.now();
      gestureHeld = false;

      // Reset interaction states on gesture change
      if (gesture !== 'pinch') isPinching = false;
      if (gesture !== 'fist') isGrabbing = false;
    }

    // Check hold duration
    if (!gestureHeld && Date.now() - gestureStartTime > GESTURE_CONFIG.holdDuration) {
      gestureHeld = true;
    }

    // Update indicator
    const icon = document.getElementById('gestureIcon');
    const label = document.getElementById('gestureLabel');
    const indicator = document.getElementById('gestureIndicator');
    if (icon) icon.textContent = GESTURE_ICONS[gesture] || '';
    if (label) label.textContent = GESTURE_LABELS[gesture] || gesture.toUpperCase();
    if (indicator) {
      indicator.className = 'gesture-indicator gesture-' + gesture;
      if (gestureHeld) indicator.classList.add('gesture-held');
    }

    // Update cursor style
    const cursorEl = document.getElementById('gestureCursor');
    if (cursorEl) cursorEl.className = 'gesture-cursor gesture-cursor-' + gesture;
  }

  function updateCursorPosition() {
    const cursorEl = document.getElementById('gestureCursor');
    if (!cursorEl) return;
    const x = cursor.smoothX * window.innerWidth;
    const y = cursor.smoothY * window.innerHeight;
    cursorEl.style.transform = `translate(${x}px, ${y}px)`;

    // Add trail dot
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

  function flashIndicator(type) {
    const indicator = document.getElementById('gestureIndicator');
    if (!indicator) return;
    indicator.classList.add('gesture-flash');
    setTimeout(() => indicator.classList.remove('gesture-flash'), 300);
  }

  // Trail effect
  const trailDots = [];
  const MAX_TRAIL = 12;

  function addTrailDot(x, y) {
    const container = document.getElementById('gestureTrail');
    if (!container) return;

    const dot = document.createElement('div');
    dot.className = 'gesture-trail-dot';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    container.appendChild(dot);
    trailDots.push(dot);

    // Fade out
    requestAnimationFrame(() => {
      dot.style.opacity = '0';
      dot.style.transform = 'scale(0)';
    });

    setTimeout(() => {
      dot.remove();
      const idx = trailDots.indexOf(dot);
      if (idx > -1) trailDots.splice(idx, 1);
    }, 400);

    // Limit trail length
    while (trailDots.length > MAX_TRAIL) {
      const old = trailDots.shift();
      old.remove();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAWING — Landmark visualization on PiP canvas
  // ═══════════════════════════════════════════════════════════════════════════

  function drawLandmarks(results) {
    if (!canvasCtx || !canvasEl) return;
    canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    if (!results.multiHandLandmarks) return;

    for (const landmarks of results.multiHandLandmarks) {
      // Draw connections
      const connections = [
        [0,1],[1,2],[2,3],[3,4],       // thumb
        [0,5],[5,6],[6,7],[7,8],       // index
        [5,9],[9,10],[10,11],[11,12],   // middle
        [9,13],[13,14],[14,15],[15,16], // ring
        [13,17],[17,18],[18,19],[19,20],// pinky
        [0,17],                         // palm base
      ];

      canvasCtx.strokeStyle = 'rgba(68, 136, 255, 0.6)';
      canvasCtx.lineWidth = 2;
      for (const [a, b] of connections) {
        const la = landmarks[a], lb = landmarks[b];
        canvasCtx.beginPath();
        canvasCtx.moveTo(la.x * canvasEl.width, la.y * canvasEl.height);
        canvasCtx.lineTo(lb.x * canvasEl.width, lb.y * canvasEl.height);
        canvasCtx.stroke();
      }

      // Draw landmarks
      for (let i = 0; i < landmarks.length; i++) {
        const lm = landmarks[i];
        const x = lm.x * canvasEl.width;
        const y = lm.y * canvasEl.height;
        const isTip = [4, 8, 12, 16, 20].includes(i);

        canvasCtx.beginPath();
        canvasCtx.arc(x, y, isTip ? 5 : 3, 0, Math.PI * 2);
        canvasCtx.fillStyle = isTip ? '#4488ff' : 'rgba(68, 136, 255, 0.4)';
        canvasCtx.fill();

        if (isTip) {
          canvasCtx.beginPath();
          canvasCtx.arc(x, y, 8, 0, Math.PI * 2);
          canvasCtx.strokeStyle = 'rgba(68, 136, 255, 0.3)';
          canvasCtx.lineWidth = 1;
          canvasCtx.stroke();
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — Toggle on/off
  // ═══════════════════════════════════════════════════════════════════════════

  async function activate() {
    if (active) return;
    active = true;

    createOverlayDOM();
    updateStatus('LOADING MODEL...', false);

    try {
      await initMediaPipe();
      updateStatus('STARTING CAM...', false);
      await startCamera();

      const overlay = document.getElementById('gestureOverlay');
      if (overlay) overlay.classList.add('active');

      // Show toggle as active
      const btn = document.getElementById('gestureToggleBtn');
      if (btn) btn.classList.add('active');

    } catch (err) {
      console.error('Gesture init failed:', err);
      updateStatus('FAILED', false);
      deactivate();
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

    // Clean up
    hands = null;
    currentGesture = 'none';
    isPinching = false;
    isGrabbing = false;
    swipeHistory.length = 0;
  }

  function toggle() {
    if (active) deactivate();
    else activate();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPOSE GLOBAL API
  // ═══════════════════════════════════════════════════════════════════════════

  window._gestureController = {
    activate,
    deactivate,
    toggle,
    isActive: () => active,
    getCurrentGesture: () => currentGesture,
  };

})();
