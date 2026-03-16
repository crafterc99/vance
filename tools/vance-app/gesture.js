(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE CONTROLLER — MediaPipe Tasks Vision (GestureRecognizer)
  // ═══════════════════════════════════════════════════════════════════════════

  const CONFIG = {
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,

    processEveryN: 2,

    cursorSmoothing: 0.25,
    zoomSensitivity: 6,
    orbitSensitivity: 3,
    holdMs: 500,
    cooldownMs: 500,
    layerCooldownMs: 1000,

    // Swipe: use wrist tracking in a time window after palm detected
    swipeWindowMs: 600,      // track wrist for 600ms after palm first seen
    swipeMinWristDist: 0.08, // normalized wrist displacement to trigger
  };

  const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 8;

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

  // Swipe state: wrist-based with time window
  let swipeActive = false;      // true while tracking a potential swipe
  let swipeStartTime = 0;       // when we first saw Open_Palm
  let swipeStartWristX = 0;     // wrist X when swipe tracking began
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
      <div class="gesture-trail" id="gestureTrail"></div>
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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOAD — MediaPipe Tasks Vision
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadRecognizer() {
    setStatus('LOADING VISION SDK...', false);

    const vision = await import(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs'
    );

    const { GestureRecognizer, FilesetResolver } = vision;

    setStatus('LOADING MODEL...', false);

    const fileset = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
    );

    // Try GPU first, fall back to CPU
    const opts = {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task',
      },
      runningMode: 'VIDEO',
      numHands: CONFIG.numHands,
      minHandDetectionConfidence: CONFIG.minHandDetectionConfidence,
      minHandPresenceConfidence: CONFIG.minHandPresenceConfidence,
      minTrackingConfidence: CONFIG.minTrackingConfidence,
    };

    try {
      opts.baseOptions.delegate = 'GPU';
      recognizer = await GestureRecognizer.createFromOptions(fileset, opts);
      setStatus('MODEL READY (GPU)', true);
    } catch (gpuErr) {
      console.warn('GPU delegate failed, falling back to CPU:', gpuErr);
      opts.baseOptions.delegate = 'CPU';
      recognizer = await GestureRecognizer.createFromOptions(fileset, opts);
      setStatus('MODEL READY (CPU)', true);
    }
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
      videoEl.onerror = () => { clearTimeout(t); rej(new Error('Video error')); };
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
  // PROCESSING LOOP
  // ═══════════════════════════════════════════════════════════════════════════

  let consecutiveErrors = 0;

  function runLoop() {
    if (!active) return;

    frameCount++;

    if (frameCount % CONFIG.processEveryN === 0 &&
        videoEl && videoEl.readyState >= 2 && recognizer) {

      const now = videoEl.currentTime;
      if (now !== lastVideoTime) {
        lastVideoTime = now;

        try {
          const result = recognizer.recognizeForVideo(videoEl, performance.now());
          consecutiveErrors = 0;
          handleResult(result);
        } catch (err) {
          consecutiveErrors++;
          console.warn('recognizeForVideo error #' + consecutiveErrors + ':', err.message);
          // If we get 10+ errors in a row, stop gracefully
          if (consecutiveErrors > 10) {
            console.error('Too many consecutive errors, stopping gesture control');
            setStatus('ERROR — STOPPED', false);
            setTimeout(() => deactivate(), 2000);
            return;
          }
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

    // Swipe detection: wrist-based with time window
    // When Open_Palm first detected, record wrist position.
    // Keep tracking wrist for swipeWindowMs even if gesture changes
    // (fast motion causes misclassification). Fire if wrist moves enough.
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
  //
  // Problem: when you swipe an open palm, the fast motion causes MediaPipe
  // to misclassify the gesture (motion blur → "None" or "Closed_Fist").
  //
  // Solution: once Open_Palm is detected, start a 600ms window. During
  // that window, track wrist X displacement regardless of what gesture
  // is being classified. If wrist moves enough, fire the layer switch.
  // ═══════════════════════════════════════════════════════════════════════════

  function handleSwipe(gestureName, wristX, now) {
    // Start tracking when we see Open_Palm
    if (gestureName === 'Open_Palm' && !swipeActive) {
      if (now - lastLayerSwitch < CONFIG.layerCooldownMs) return;
      swipeActive = true;
      swipeStartTime = now;
      swipeStartWristX = wristX;
      return;
    }

    // If we're in a swipe window, check displacement
    if (swipeActive) {
      const elapsed = now - swipeStartTime;

      // Window expired without enough movement
      if (elapsed > CONFIG.swipeWindowMs) {
        swipeActive = false;
        return;
      }

      const dx = wristX - swipeStartWristX;

      if (Math.abs(dx) > CONFIG.swipeMinWristDist) {
        // Swipe detected!
        swipeActive = false;
        lastLayerSwitch = now;

        const api = window._spatialGestureAPI;
        if (api) {
          if (dx > 0) api.gestureLayerNext(); else api.gestureLayerPrev();
        }
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
        // Swipe handled separately in handleSwipe()
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
  // UI
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

    // Highlight active row in legend
    const legend = document.getElementById('gestureLegend');
    if (legend) {
      legend.querySelectorAll('.gesture-legend-row').forEach(row => {
        row.classList.toggle('active-row', row.dataset.gesture === mapped);
      });
    }
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
  // DRAWING
  // ═══════════════════════════════════════════════════════════════════════════

  const CONNS = [
    [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],
    [13,17],[17,18],[18,19],[19,20],[0,17],
  ];

  function drawHand(result) {
    if (!ctx || !canvasEl) return;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!result.landmarks) return;

    for (const lm of result.landmarks) {
      ctx.strokeStyle = 'rgba(68,136,255,0.5)';
      ctx.lineWidth = 2;
      for (const [a, b] of CONNS) {
        ctx.beginPath();
        ctx.moveTo(lm[a].x * canvasEl.width, lm[a].y * canvasEl.height);
        ctx.lineTo(lm[b].x * canvasEl.width, lm[b].y * canvasEl.height);
        ctx.stroke();
      }
      for (let i = 0; i < lm.length; i++) {
        const x = lm[i].x * canvasEl.width, y = lm[i].y * canvasEl.height;
        const tip = [4, 8, 12, 16, 20].includes(i);
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
    consecutiveErrors = 0;
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
    try { if (recognizer) { recognizer.close(); } } catch (e) { /* ignore */ }
    recognizer = null;

    const ov = document.getElementById('gestureOverlay');
    if (ov) { ov.classList.remove('active'); setTimeout(() => ov.remove(), 300); }
    const btn = document.getElementById('gestureToggleBtn');
    if (btn) btn.classList.remove('active');

    currentGesture = 'None';
    isPinching = false;
    isGrabbing = false;
    swipeActive = false;
  }

  function toggle() { active ? deactivate() : activate(); }

  window._gestureController = {
    activate, deactivate, toggle,
    isActive: () => active,
    getCurrentGesture: () => currentGesture,
  };

})();
