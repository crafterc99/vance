(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE CONTROLLER — MediaPipe Tasks Vision (GestureRecognizer)
  // Performance-optimized: low-res cam, throttled inference, cached DOM
  // ═══════════════════════════════════════════════════════════════════════════

  const CONFIG = {
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,

    inferenceIntervalMs: 80,   // ~12fps inference, decoupled from render loop

    cursorSmoothing: 0.25,
    zoomSensitivity: 6,
    orbitSensitivity: 3,
    holdMs: 500,
    cooldownMs: 500,
    layerCooldownMs: 1000,

    swipeWindowMs: 600,
    swipeMinWristDist: 0.08,
  };

  const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 8;

  const MP_VERSION = '0.10.32';
  const MP_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task';

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  let active = false;
  let recognizer = null;
  let cameraStream = null;
  let videoEl = null;
  let canvasEl = null;
  let ctx = null;
  let timerId = null;
  let lastVideoTime = -1;
  let lastTimestamp = 0;
  let consecutiveErrors = 0;

  let currentGesture = 'None';
  let gestureStart = 0;
  let gestureHeld = false;

  const cursor = { x: 0.5, y: 0.5, sx: 0.5, sy: 0.5 };
  const prev = { x: 0.5, y: 0.5 };

  let isPinching = false;
  let pinchBaseDist = 0;
  let isGrabbing = false;

  let swipeActive = false;
  let swipeStartTime = 0;
  let swipeStartWristX = 0;
  let lastLayerSwitch = 0;
  let lastActionTime = 0;

  // Cached DOM refs (set once in buildOverlay)
  let dom = {};

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
      <div class="gesture-cursor" id="gestureCursor" style="will-change:transform">
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
      <div class="gesture-legend" id="gestureLegend">
        <div class="gesture-legend-title">GESTURE CONTROLS</div>
        <div class="gesture-legend-row active-row" data-gesture="point">
          <span class="gesture-legend-icon">\u261D</span>
          <span class="gesture-legend-name">Point</span>
          <span class="gesture-legend-action">Select</span>
        </div>
        <div class="gesture-legend-row" data-gesture="pinch">
          <span class="gesture-legend-icon">\uD83E\uDD0F</span>
          <span class="gesture-legend-name">Pinch</span>
          <span class="gesture-legend-action">Zoom</span>
        </div>
        <div class="gesture-legend-row" data-gesture="fist">
          <span class="gesture-legend-icon">\u270A</span>
          <span class="gesture-legend-name">Fist + Drag</span>
          <span class="gesture-legend-action">Orbit</span>
        </div>
        <div class="gesture-legend-row" data-gesture="palm">
          <span class="gesture-legend-icon">\uD83D\uDD90</span>
          <span class="gesture-legend-name">Palm + Slide</span>
          <span class="gesture-legend-action">Layer</span>
        </div>
        <div class="gesture-legend-row" data-gesture="thumbsup">
          <span class="gesture-legend-icon">\uD83D\uDC4D</span>
          <span class="gesture-legend-name">Thumbs Up</span>
          <span class="gesture-legend-action">Approve</span>
        </div>
        <div class="gesture-legend-row" data-gesture="peace">
          <span class="gesture-legend-icon">\u270C</span>
          <span class="gesture-legend-name">Peace</span>
          <span class="gesture-legend-action">\u2014</span>
        </div>
        <div class="gesture-legend-hint">Press <kbd>G</kbd> to toggle</div>
      </div>`;
    document.body.appendChild(el);

    videoEl = document.getElementById('gestureVideo');
    canvasEl = document.getElementById('gestureCanvas');
    ctx = canvasEl.getContext('2d');

    // Cache all DOM refs once
    dom = {
      overlay: el,
      cursor: document.getElementById('gestureCursor'),
      icon: document.getElementById('gestureIcon'),
      label: document.getElementById('gestureLabel'),
      indicator: document.getElementById('gestureIndicator'),
      status: document.getElementById('gestureStatus'),
      legendRows: document.querySelectorAll('#gestureLegend .gesture-legend-row'),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOAD — MediaPipe Tasks Vision
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadRecognizer() {
    setStatus('LOADING SDK...', false);
    console.log('[Gesture] Loading MediaPipe v' + MP_VERSION);

    let vision;
    try {
      vision = await import(MP_CDN + '/vision_bundle.mjs');
    } catch (e) {
      console.error('[Gesture] SDK import failed:', e);
      setStatus('SDK FAILED', false);
      throw e;
    }

    const { GestureRecognizer, FilesetResolver } = vision;
    if (!GestureRecognizer || !FilesetResolver) throw new Error('Missing exports');

    setStatus('LOADING WASM...', false);
    const fileset = await FilesetResolver.forVisionTasks(MP_CDN + '/wasm');

    setStatus('LOADING MODEL...', false);

    const opts = {
      baseOptions: { modelAssetPath: MODEL_URL },
      runningMode: 'VIDEO',
      numHands: CONFIG.numHands,
      minHandDetectionConfidence: CONFIG.minHandDetectionConfidence,
      minHandPresenceConfidence: CONFIG.minHandPresenceConfidence,
      minTrackingConfidence: CONFIG.minTrackingConfidence,
    };

    try {
      opts.baseOptions.delegate = 'GPU';
      recognizer = await GestureRecognizer.createFromOptions(fileset, opts);
      console.log('[Gesture] Model ready (GPU)');
      setStatus('TRACKING (GPU)', true);
    } catch (_) {
      console.warn('[Gesture] GPU failed, trying CPU');
      try {
        opts.baseOptions.delegate = 'CPU';
        recognizer = await GestureRecognizer.createFromOptions(fileset, opts);
        console.log('[Gesture] Model ready (CPU)');
        setStatus('TRACKING (CPU)', true);
      } catch (e) {
        console.error('[Gesture] CPU failed:', e);
        setStatus('MODEL FAILED', false);
        throw e;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMERA — Low resolution for performance
  // ═══════════════════════════════════════════════════════════════════════════

  async function startCam() {
    setStatus('REQUESTING CAMERA...', false);

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
      audio: false,
    });

    videoEl.srcObject = cameraStream;

    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('Video timeout')), 8000);
      videoEl.onloadeddata = () => { clearTimeout(t); res(); };
      videoEl.onerror = () => { clearTimeout(t); rej(new Error('Video error')); };
      videoEl.play().catch(rej);
    });

    canvasEl.width = videoEl.videoWidth || 320;
    canvasEl.height = videoEl.videoHeight || 240;

    setStatus('TRACKING', true);
    lastVideoTime = -1;
    lastTimestamp = 0;
    consecutiveErrors = 0;
    startInferenceLoop();
  }

  function stopCam() {
    stopInferenceLoop();
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    if (videoEl) videoEl.srcObject = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INFERENCE LOOP — Decoupled from render via setTimeout
  // Runs at ~12fps independently so Three.js render loop stays smooth
  // ═══════════════════════════════════════════════════════════════════════════

  function startInferenceLoop() {
    stopInferenceLoop();
    tick();
  }

  function stopInferenceLoop() {
    if (timerId) { clearTimeout(timerId); timerId = null; }
  }

  function tick() {
    if (!active) return;

    if (videoEl && videoEl.readyState >= 2 && recognizer) {
      const vt = videoEl.currentTime;
      if (vt !== lastVideoTime) {
        lastVideoTime = vt;

        let ts = performance.now();
        if (ts <= lastTimestamp) ts = lastTimestamp + 1;
        lastTimestamp = ts;

        try {
          const result = recognizer.recognizeForVideo(videoEl, ts);
          consecutiveErrors = 0;
          handleResult(result);
        } catch (err) {
          consecutiveErrors++;
          if (consecutiveErrors <= 3) console.warn('[Gesture] error:', err.message);
          if (consecutiveErrors > 10) {
            setStatus('ERROR — STOPPED', false);
            setTimeout(() => deactivate(), 2000);
            return;
          }
        }
      }
    }

    timerId = setTimeout(tick, CONFIG.inferenceIntervalMs);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESULT HANDLER
  // ═══════════════════════════════════════════════════════════════════════════

  function handleResult(result) {
    drawHand(result);

    if (!result.landmarks || result.landmarks.length === 0) {
      setGesture('None');
      setCursorVisible(false);
      swipeActive = false;
      return;
    }

    const lm = result.landmarks[0];
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

    // Wrist position (mirrored) for swipe tracking
    const wristX = 1 - lm[WRIST].x;
    const now = Date.now();
    handleSwipe(gestureName, wristX, now);

    // Pinch detection via landmark distance
    const thumbTip = lm[THUMB_TIP];
    const indexTip = lm[INDEX_TIP];
    const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y, (thumbTip.z || 0) - (indexTip.z || 0));
    if (pinchDist < 0.06 && gestureName !== 'Closed_Fist') gestureName = 'Pinch';

    setGesture(gestureName);
    executeAction(gestureName, lm, pinchDist);

    prev.x = cursor.sx;
    prev.y = cursor.sy;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SWIPE — Wrist tracking with time window
  // ═══════════════════════════════════════════════════════════════════════════

  function handleSwipe(gestureName, wristX, now) {
    if (gestureName === 'Open_Palm' && !swipeActive) {
      if (now - lastLayerSwitch < CONFIG.layerCooldownMs) return;
      swipeActive = true;
      swipeStartTime = now;
      swipeStartWristX = wristX;
      return;
    }

    if (swipeActive) {
      if (now - swipeStartTime > CONFIG.swipeWindowMs) { swipeActive = false; return; }

      const dx = wristX - swipeStartWristX;
      if (Math.abs(dx) > CONFIG.swipeMinWristDist) {
        swipeActive = false;
        lastLayerSwitch = now;
        const api = window._spatialGestureAPI;
        if (api) { dx > 0 ? api.gestureLayerNext() : api.gestureLayerPrev(); }
        flash();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE → ACTION
  // ═══════════════════════════════════════════════════════════════════════════

  const GESTURE_MAP = {
    'Pointing_Up': 'point', 'Pinch': 'pinch', 'Closed_Fist': 'fist',
    'Open_Palm': 'palm', 'Thumb_Up': 'thumbsup', 'Thumb_Down': 'thumbsdown',
    'Victory': 'peace', 'ILoveYou': 'ily', 'None': 'none',
  };

  function executeAction(gesture, lm, pinchDist) {
    const api = window._spatialGestureAPI;
    if (!api) return;
    const now = Date.now();

    switch (gesture) {
      case 'Pointing_Up':
        api.gestureRaycast(cursor.sx * innerWidth, cursor.sy * innerHeight);
        break;

      case 'Pinch':
        if (!isPinching) { isPinching = true; pinchBaseDist = pinchDist; }
        else {
          api.gestureZoom((pinchDist - pinchBaseDist) * CONFIG.zoomSensitivity);
          pinchBaseDist = pinchDist;
        }
        break;

      case 'Closed_Fist':
        if (!isGrabbing) { isGrabbing = true; }
        else {
          api.gestureOrbit(
            (cursor.sx - prev.x) * CONFIG.orbitSensitivity,
            (cursor.sy - prev.y) * CONFIG.orbitSensitivity
          );
        }
        break;

      case 'Open_Palm':
        break;

      case 'Thumb_Up':
        if (gestureHeld && now - lastActionTime > CONFIG.cooldownMs) {
          lastActionTime = now;
          api.confirmAction();
          flash();
        }
        break;

      default:
        isPinching = false;
        isGrabbing = false;
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UI — All use cached DOM refs, no getElementById per frame
  // ═══════════════════════════════════════════════════════════════════════════

  const ICONS = {
    None: '', Pointing_Up: '\u261D', Pinch: '\uD83E\uDD0F', Closed_Fist: '\u270A',
    Open_Palm: '\uD83D\uDD90', Thumb_Up: '\uD83D\uDC4D', Thumb_Down: '\uD83D\uDC4E',
    Victory: '\u270C', ILoveYou: '\uD83E\uDD1F',
  };
  const LABELS = {
    None: 'NO HAND', Pointing_Up: 'POINT \u2014 SELECT', Pinch: 'PINCH \u2014 ZOOM',
    Closed_Fist: 'FIST \u2014 ORBIT', Open_Palm: 'PALM \u2014 SLIDE TO SWITCH',
    Thumb_Up: 'CONFIRM', Thumb_Down: 'THUMB DOWN', Victory: 'PEACE', ILoveYou: 'ILY',
  };

  let lastMapped = '';

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

    // Only touch DOM if gesture actually changed
    if (mapped !== lastMapped) {
      lastMapped = mapped;
      if (dom.icon) dom.icon.textContent = ICONS[g] || '';
      if (dom.label) dom.label.textContent = LABELS[g] || g;
      if (dom.indicator) {
        dom.indicator.className = 'gesture-indicator gesture-' + mapped;
      }
      if (dom.cursor) dom.cursor.className = 'gesture-cursor gesture-cursor-' + mapped;
      if (dom.legendRows) {
        dom.legendRows.forEach(row => {
          row.classList.toggle('active-row', row.dataset.gesture === mapped);
        });
      }
    }

    if (dom.indicator && gestureHeld) dom.indicator.classList.add('gesture-held');
  }

  function moveCursor() {
    if (!dom.cursor) return;
    dom.cursor.style.transform = `translate(${cursor.sx * innerWidth}px,${cursor.sy * innerHeight}px)`;
  }

  function setCursorVisible(v) {
    if (dom.cursor) dom.cursor.style.opacity = v ? '1' : '0';
  }

  function setStatus(text, ok) {
    if (!dom.status) return;
    const dot = dom.status.querySelector('.gesture-status-dot');
    const txt = dom.status.querySelector('.gesture-status-text');
    if (dot) dot.className = 'gesture-status-dot ' + (ok ? 'active' : 'error');
    if (txt) txt.textContent = text;
  }

  function flash() {
    if (!dom.indicator) return;
    dom.indicator.classList.add('gesture-flash');
    setTimeout(() => dom.indicator && dom.indicator.classList.remove('gesture-flash'), 300);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAWING — Lightweight PiP skeleton
  // ═══════════════════════════════════════════════════════════════════════════

  const CONNS = [
    [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],
    [13,17],[17,18],[18,19],[19,20],[0,17],
  ];

  function drawHand(result) {
    if (!ctx || !canvasEl) return;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!result.landmarks || result.landmarks.length === 0) return;

    const lm = result.landmarks[0];
    const w = canvasEl.width, h = canvasEl.height;

    ctx.strokeStyle = 'rgba(68,136,255,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [a, b] of CONNS) {
      ctx.moveTo(lm[a].x * w, lm[a].y * h);
      ctx.lineTo(lm[b].x * w, lm[b].y * h);
    }
    ctx.stroke();

    ctx.fillStyle = '#4488ff';
    for (const i of [4, 8, 12, 16, 20]) {
      ctx.beginPath();
      ctx.arc(lm[i].x * w, lm[i].y * h, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIVATE / DEACTIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  async function activate() {
    if (active) return;
    active = true;
    buildOverlay();
    console.log('[Gesture] Activating...');

    try {
      await loadRecognizer();
    } catch (err) {
      console.error('[Gesture] Model load failed:', err);
      setStatus('MODEL LOAD FAILED', false);
      setTimeout(() => deactivate(), 4000);
      return;
    }

    try {
      await startCam();
    } catch (err) {
      console.error('[Gesture] Camera failed:', err);
      setStatus(err.name === 'NotAllowedError' ? 'CAM DENIED' : 'CAM FAILED', false);
      setTimeout(() => deactivate(), 4000);
      return;
    }

    if (dom.overlay) dom.overlay.classList.add('active');
    const btn = document.getElementById('gestureToggleBtn');
    if (btn) btn.classList.add('active');
    console.log('[Gesture] Active and tracking');
  }

  function deactivate() {
    active = false;
    stopCam();
    try { if (recognizer) recognizer.close(); } catch (_) {}
    recognizer = null;

    if (dom.overlay) { dom.overlay.classList.remove('active'); setTimeout(() => { if (dom.overlay) dom.overlay.remove(); }, 300); }
    const btn = document.getElementById('gestureToggleBtn');
    if (btn) btn.classList.remove('active');

    currentGesture = 'None';
    lastMapped = '';
    isPinching = false;
    isGrabbing = false;
    swipeActive = false;
    dom = {};
  }

  function toggle() { active ? deactivate() : activate(); }

  window._gestureController = {
    activate, deactivate, toggle,
    isActive: () => active,
    getCurrentGesture: () => currentGesture,
  };

})();
