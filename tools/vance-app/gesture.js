(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE CONTROLLER — MediaPipe Tasks Vision (GestureRecognizer)
  //
  // Uses the official @mediapipe/tasks-vision GestureRecognizer which has
  // 7 built-in gestures + hand landmarks. Much more reliable than the
  // legacy @mediapipe/hands with manual classification.
  //
  // Built-in gestures:
  //   Closed_Fist, Open_Palm, Pointing_Up, Thumb_Up, Thumb_Down,
  //   Victory, ILoveYou, None
  // ═══════════════════════════════════════════════════════════════════════════

  const CONFIG = {
    numHands: 1,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,

    // Performance: skip frames to prevent lag
    processEveryN: 2,

    // Interaction
    cursorSmoothing: 0.25,
    zoomSensitivity: 6,
    orbitSensitivity: 3,
    swipeMinDist: 0.12,
    swipeMinVelocity: 12,
    holdMs: 500,
    cooldownMs: 500,
    layerCooldownMs: 900,
  };

  // MediaPipe hand landmark indices
  const THUMB_TIP = 4, INDEX_TIP = 8, INDEX_MCP = 5;

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  let active = false;
  let recognizer = null;
  let cameraStream = null;
  let videoEl = null;
  let canvasEl = null;
  let ctx = null;
  let loopId = null;
  let lastVideoTime = -1;
  let frameCount = 0;

  let currentGesture = 'None';
  let gestureStart = 0;
  let gestureHeld = false;

  const cursor = { x: 0.5, y: 0.5, sx: 0.5, sy: 0.5 };
  const prev = { x: 0.5, y: 0.5 };

  let isPinching = false;
  let pinchBaseDist = 0;
  let isGrabbing = false;

  const swipeLog = [];
  let lastLayerSwitch = 0;
  let lastActionTime = 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM
  // ═══════════════════════════════════════════════════════════════════════════

  function buildOverlay() {
    let el = document.getElementById('gestureOverlay');
    if (el) el.remove();

    el = document.createElement('div');
    el.id = 'gestureOverlay';
    el.className = 'gesture-overlay';
    el.innerHTML = `
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
      <div class="gesture-trail" id="gestureTrail"></div>`;
    document.body.appendChild(el);

    videoEl = document.getElementById('gestureVideo');
    canvasEl = document.getElementById('gestureCanvas');
    ctx = canvasEl.getContext('2d');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOAD — MediaPipe Tasks Vision via ES module import
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadRecognizer() {
    setStatus('LOADING VISION SDK...', false);

    // Dynamic import of the tasks-vision bundle
    const vision = await import(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs'
    );

    const { GestureRecognizer, FilesetResolver, DrawingUtils } = vision;

    // Store DrawingUtils for landmark rendering
    window._mpDrawingUtils = DrawingUtils;
    window._mpGestureRecognizer = GestureRecognizer;

    setStatus('LOADING MODEL...', false);

    const fileset = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
    );

    recognizer = await GestureRecognizer.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: CONFIG.numHands,
      minHandDetectionConfidence: CONFIG.minHandDetectionConfidence,
      minHandPresenceConfidence: CONFIG.minHandPresenceConfidence,
      minTrackingConfidence: CONFIG.minTrackingConfidence,
    });

    setStatus('MODEL READY', true);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMERA
  // ═══════════════════════════════════════════════════════════════════════════

  async function startCam() {
    setStatus('REQUESTING CAMERA...', false);

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
    } catch (e) {
      const msg = e.name === 'NotAllowedError' ? 'CAM DENIED' :
                  e.name === 'NotFoundError'   ? 'NO CAMERA' : 'CAM ERROR';
      setStatus(msg, false);
      throw e;
    }

    videoEl.srcObject = cameraStream;

    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('Video timeout')), 8000);
      videoEl.onloadeddata = () => { clearTimeout(t); res(); };
      videoEl.onerror = (e) => { clearTimeout(t); rej(e); };
      videoEl.play().catch(rej);
    });

    canvasEl.width = videoEl.videoWidth || 640;
    canvasEl.height = videoEl.videoHeight || 480;

    setStatus('TRACKING', true);
    frameCount = 0;
    lastVideoTime = -1;
    runLoop();
  }

  function stopCam() {
    if (loopId) { cancelAnimationFrame(loopId); loopId = null; }
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    if (videoEl) videoEl.srcObject = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESSING LOOP — Throttled
  // ═══════════════════════════════════════════════════════════════════════════

  function runLoop() {
    if (!active) return;

    frameCount++;

    if (frameCount % CONFIG.processEveryN === 0 &&
        videoEl && videoEl.readyState >= 2 && recognizer) {

      const now = videoEl.currentTime;
      if (now !== lastVideoTime) {
        lastVideoTime = now;
        const ts = performance.now();

        try {
          const result = recognizer.recognizeForVideo(videoEl, ts);
          handleResult(result);
        } catch (err) {
          console.warn('recognizeForVideo error:', err);
        }
      }
    }

    loopId = requestAnimationFrame(runLoop);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESULT HANDLER
  // ═══════════════════════════════════════════════════════════════════════════

  function handleResult(result) {
    drawHand(result);

    if (!result.landmarks || result.landmarks.length === 0) {
      setGesture('None');
      setCursorVisible(false);
      return;
    }

    const lm = result.landmarks[0]; // first hand
    const gestures = result.gestures;
    let gestureName = 'None';

    if (gestures && gestures.length > 0 && gestures[0].length > 0) {
      gestureName = gestures[0][0].categoryName || 'None';
    }

    // Cursor from index fingertip (mirrored)
    const tip = lm[INDEX_TIP];
    cursor.x = 1 - tip.x;
    cursor.y = tip.y;
    cursor.sx += (cursor.x - cursor.sx) * CONFIG.cursorSmoothing;
    cursor.sy += (cursor.y - cursor.sy) * CONFIG.cursorSmoothing;
    moveCursor();
    setCursorVisible(true);

    // Swipe log
    swipeLog.push({ x: cursor.x, y: cursor.y, t: Date.now() });
    if (swipeLog.length > 10) swipeLog.shift();

    // Check for pinch via landmark distance (not a built-in gesture)
    const thumbTip = lm[THUMB_TIP];
    const indexTip = lm[INDEX_TIP];
    const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y, (thumbTip.z||0) - (indexTip.z||0));
    const isPinchNow = pinchDist < 0.06 && gestureName !== 'Closed_Fist';

    // Override gesture if pinching
    if (isPinchNow) gestureName = 'Pinch';

    setGesture(gestureName);
    executeAction(gestureName, lm, pinchDist);

    prev.x = cursor.sx;
    prev.y = cursor.sy;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE → ACTION
  // ═══════════════════════════════════════════════════════════════════════════

  const GESTURE_MAP = {
    'Pointing_Up': 'point',
    'Pinch':       'pinch',
    'Closed_Fist': 'fist',
    'Open_Palm':   'palm',
    'Thumb_Up':    'thumbsup',
    'Thumb_Down':  'thumbsdown',
    'Victory':     'peace',
    'ILoveYou':    'ily',
    'None':        'none',
  };

  function executeAction(gesture, lm, pinchDist) {
    const api = window._spatialGestureAPI;
    if (!api) return;
    const now = Date.now();

    switch (gesture) {
      case 'Pointing_Up': {
        // Raycast at cursor position
        api.gestureRaycast(cursor.sx * innerWidth, cursor.sy * innerHeight);
        break;
      }

      case 'Pinch': {
        if (!isPinching) { isPinching = true; pinchBaseDist = pinchDist; }
        else {
          api.gestureZoom((pinchDist - pinchBaseDist) * CONFIG.zoomSensitivity);
          pinchBaseDist = pinchDist;
        }
        break;
      }

      case 'Closed_Fist': {
        if (!isGrabbing) { isGrabbing = true; }
        else {
          const dx = (cursor.sx - prev.x) * CONFIG.orbitSensitivity;
          const dy = (cursor.sy - prev.y) * CONFIG.orbitSensitivity;
          api.gestureOrbit(dx, dy);
        }
        break;
      }

      case 'Open_Palm': {
        // Swipe detection
        if (swipeLog.length < 4 || now - lastLayerSwitch < CONFIG.layerCooldownMs) break;
        const first = swipeLog[0], last = swipeLog[swipeLog.length - 1];
        const dx = last.x - first.x, dt = last.t - first.t;
        if (dt === 0) break;
        if (Math.abs(dx) > CONFIG.swipeMinDist && (Math.abs(dx) / dt * 1000) > CONFIG.swipeMinVelocity) {
          lastLayerSwitch = now;
          dx > 0 ? api.gestureLayerNext() : api.gestureLayerPrev();
          flash();
          swipeLog.length = 0;
        }
        break;
      }

      case 'Thumb_Up': {
        if (gestureHeld && now - lastActionTime > CONFIG.cooldownMs) {
          lastActionTime = now;
          api.confirmAction();
          flash();
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
  // UI HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  const ICONS = {
    None: '', Pointing_Up: '\u261D', Pinch: '\uD83E\uDD0F', Closed_Fist: '\u270A',
    Open_Palm: '\uD83D\uDD90', Thumb_Up: '\uD83D\uDC4D', Thumb_Down: '\uD83D\uDC4E',
    Victory: '\u270C', ILoveYou: '\uD83E\uDD1F',
  };
  const LABELS = {
    None: 'NO HAND', Pointing_Up: 'POINT \u2014 SELECT', Pinch: 'PINCH \u2014 ZOOM',
    Closed_Fist: 'FIST \u2014 ORBIT', Open_Palm: 'PALM \u2014 SWIPE',
    Thumb_Up: 'CONFIRM', Thumb_Down: 'THUMB DOWN', Victory: 'PEACE', ILoveYou: 'ILY',
  };

  function setGesture(g) {
    if (g !== currentGesture) {
      currentGesture = g;
      gestureStart = Date.now();
      gestureHeld = false;
      if (g !== 'Pinch') isPinching = false;
      if (g !== 'Closed_Fist') isGrabbing = false;
    }
    if (!gestureHeld && Date.now() - gestureStart > CONFIG.holdMs) gestureHeld = true;

    const mapped = GESTURE_MAP[g] || 'none';
    const iconEl = document.getElementById('gestureIcon');
    const labelEl = document.getElementById('gestureLabel');
    const indEl = document.getElementById('gestureIndicator');
    if (iconEl) iconEl.textContent = ICONS[g] || '';
    if (labelEl) labelEl.textContent = LABELS[g] || g;
    if (indEl) {
      indEl.className = 'gesture-indicator gesture-' + mapped;
      if (gestureHeld) indEl.classList.add('gesture-held');
    }
    const curEl = document.getElementById('gestureCursor');
    if (curEl) curEl.className = 'gesture-cursor gesture-cursor-' + mapped;
  }

  function moveCursor() {
    const el = document.getElementById('gestureCursor');
    if (!el) return;
    const x = cursor.sx * innerWidth, y = cursor.sy * innerHeight;
    el.style.transform = `translate(${x}px,${y}px)`;
    addTrail(x, y);
  }

  function setCursorVisible(v) {
    const el = document.getElementById('gestureCursor');
    if (el) el.style.opacity = v ? '1' : '0';
  }

  function setStatus(text, ok) {
    const el = document.getElementById('gestureStatus');
    if (!el) return;
    const dot = el.querySelector('.gesture-status-dot');
    const txt = el.querySelector('.gesture-status-text');
    if (dot) dot.className = 'gesture-status-dot ' + (ok ? 'active' : 'error');
    if (txt) txt.textContent = text;
  }

  function flash() {
    const el = document.getElementById('gestureIndicator');
    if (!el) return;
    el.classList.add('gesture-flash');
    setTimeout(() => el.classList.remove('gesture-flash'), 300);
  }

  // Trail dots
  const trails = [];
  function addTrail(x, y) {
    const c = document.getElementById('gestureTrail');
    if (!c) return;
    const d = document.createElement('div');
    d.className = 'gesture-trail-dot';
    d.style.left = x + 'px'; d.style.top = y + 'px';
    c.appendChild(d);
    trails.push(d);
    requestAnimationFrame(() => { d.style.opacity = '0'; d.style.transform = 'scale(0)'; });
    setTimeout(() => { d.remove(); const i = trails.indexOf(d); if (i > -1) trails.splice(i, 1); }, 400);
    while (trails.length > 12) trails.shift().remove();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAWING — Hand landmarks on PiP canvas
  // ═══════════════════════════════════════════════════════════════════════════

  const HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],
    [13,17],[17,18],[18,19],[19,20],[0,17],
  ];

  function drawHand(result) {
    if (!ctx || !canvasEl) return;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!result.landmarks) return;

    for (const lm of result.landmarks) {
      // Connections
      ctx.strokeStyle = 'rgba(68,136,255,0.5)';
      ctx.lineWidth = 2;
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo(lm[a].x * canvasEl.width, lm[a].y * canvasEl.height);
        ctx.lineTo(lm[b].x * canvasEl.width, lm[b].y * canvasEl.height);
        ctx.stroke();
      }
      // Points
      for (let i = 0; i < lm.length; i++) {
        const x = lm[i].x * canvasEl.width, y = lm[i].y * canvasEl.height;
        const tip = [4,8,12,16,20].includes(i);
        ctx.beginPath();
        ctx.arc(x, y, tip ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = tip ? '#4488ff' : 'rgba(68,136,255,0.4)';
        ctx.fill();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIVATE / DEACTIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  async function activate() {
    if (active) return;
    active = true;
    buildOverlay();

    try {
      await loadRecognizer();
      await startCam();

      const ov = document.getElementById('gestureOverlay');
      if (ov) ov.classList.add('active');
      const btn = document.getElementById('gestureToggleBtn');
      if (btn) btn.classList.add('active');
    } catch (err) {
      console.error('Gesture activation failed:', err);
      setStatus((err.message || 'FAILED').slice(0, 24).toUpperCase(), false);
      setTimeout(() => deactivate(), 4000);
    }
  }

  function deactivate() {
    active = false;
    stopCam();
    if (recognizer) { recognizer.close(); recognizer = null; }

    const ov = document.getElementById('gestureOverlay');
    if (ov) { ov.classList.remove('active'); setTimeout(() => ov.remove(), 300); }
    const btn = document.getElementById('gestureToggleBtn');
    if (btn) btn.classList.remove('active');

    currentGesture = 'None';
    isPinching = false;
    isGrabbing = false;
    swipeLog.length = 0;
  }

  function toggle() { active ? deactivate() : activate(); }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPOSE
  // ═══════════════════════════════════════════════════════════════════════════

  window._gestureController = {
    activate, deactivate, toggle,
    isActive: () => active,
    getCurrentGesture: () => currentGesture,
  };

})();
