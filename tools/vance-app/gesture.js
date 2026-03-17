// ═══════════════════════════════════════════════════════════════════════════
// GESTURE CONTROLLER — Simple, reliable MediaPipe hand tracking
// Loaded as ES module. Inference throttled to ~4fps to avoid freezing.
// ═══════════════════════════════════════════════════════════════════════════

import {
  GestureRecognizer,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task';

const INFERENCE_MS = 260;   // ~4 fps — keeps Three.js smooth
const CAM_W = 320;
const CAM_H = 240;
const SMOOTH = 0.25;
const HOLD_MS = 500;
const COOLDOWN_MS = 500;
const LAYER_COOLDOWN_MS = 1000;
const SWIPE_WINDOW_MS = 600;
const SWIPE_MIN = 0.08;
const ZOOM_SENS = 6;
const ORBIT_SENS = 3;

const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 8;

// ─── State ──────────────────────────────────────────────────────────────────
let active = false;
let recognizer = null;
let cameraStream = null;
let videoEl = null;
let canvasEl = null;
let ctx = null;
let timerId = null;
let lastTs = 0;

let currentGesture = 'None';
let gestureStart = 0;
let gestureHeld = false;

const cursor = { x: 0.5, y: 0.5, sx: 0.5, sy: 0.5 };
const prev   = { x: 0.5, y: 0.5 };

let isPinching = false, pinchBase = 0;
let isGrabbing = false;
let swipeActive = false, swipeT0 = 0, swipeX0 = 0;
let lastLayerSwitch = 0, lastActionTime = 0;
let lastMapped = '';

let dom = {};

// ─── DOM ────────────────────────────────────────────────────────────────────
function buildOverlay() {
  let el = document.getElementById('gestureOverlay');
  if (el) el.remove();

  el = document.createElement('div');
  el.id = 'gestureOverlay';
  el.className = 'gesture-overlay active';          // visible immediately
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

  videoEl  = document.getElementById('gestureVideo');
  canvasEl = document.getElementById('gestureCanvas');
  ctx      = canvasEl.getContext('2d');

  dom = {
    overlay:    el,
    cursor:     document.getElementById('gestureCursor'),
    icon:       document.getElementById('gestureIcon'),
    label:      document.getElementById('gestureLabel'),
    indicator:  document.getElementById('gestureIndicator'),
    status:     document.getElementById('gestureStatus'),
    legendRows: document.querySelectorAll('#gestureLegend .gesture-legend-row'),
  };
}

// ─── Camera ─────────────────────────────────────────────────────────────────
async function startCam() {
  setStatus('REQUESTING CAMERA...', false);
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: CAM_W }, height: { ideal: CAM_H }, facingMode: 'user' },
    audio: false,
  });
  videoEl.srcObject = cameraStream;

  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('Video timeout')), 8000);
    videoEl.onloadeddata = () => { clearTimeout(t); res(); };
    videoEl.onerror      = () => { clearTimeout(t); rej(new Error('Video error')); };
    videoEl.play().catch(rej);
  });

  canvasEl.width  = videoEl.videoWidth  || CAM_W;
  canvasEl.height = videoEl.videoHeight || CAM_H;
}

function stopCam() {
  if (timerId) { clearTimeout(timerId); timerId = null; }
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  if (videoEl) videoEl.srcObject = null;
}

// ─── Model ──────────────────────────────────────────────────────────────────
async function loadModel() {
  setStatus('LOADING WASM...', false);
  const fileset = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm',
  );

  setStatus('LOADING MODEL...', false);
  recognizer = await GestureRecognizer.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });

  setStatus('TRACKING', true);
}

// ─── Inference loop (throttled setTimeout, NOT rAF) ─────────────────────────
function tick() {
  if (!active) return;

  if (recognizer && videoEl && videoEl.readyState >= 2) {
    let ts = performance.now();
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;

    try {
      const result = recognizer.recognizeForVideo(videoEl, ts);

      let landmarks = null;
      if (result.landmarks && result.landmarks.length > 0) {
        landmarks = result.landmarks[0].map(lm => ({
          x: lm.x, y: lm.y, z: lm.z || 0,
        }));
      }

      let gesture = 'None';
      if (result.gestures && result.gestures.length > 0 && result.gestures[0].length > 0) {
        gesture = result.gestures[0][0].categoryName || 'None';
      }

      processResult(landmarks, gesture);
    } catch (e) {
      console.warn('[Gesture] inference:', e.message);
    }
  }

  timerId = setTimeout(tick, INFERENCE_MS);
}

// ─── Process result ─────────────────────────────────────────────────────────
function processResult(landmarks, gestureName) {
  if (!landmarks) {
    setGesture('None');
    setCursorVisible(false);
    swipeActive = false;
    drawHand(null);
    return;
  }

  drawHand(landmarks);

  // Cursor from index fingertip (mirrored)
  const tip = landmarks[INDEX_TIP];
  cursor.x = 1 - tip.x;
  cursor.y = tip.y;
  cursor.sx += (cursor.x - cursor.sx) * SMOOTH;
  cursor.sy += (cursor.y - cursor.sy) * SMOOTH;
  moveCursor();
  setCursorVisible(true);

  // Wrist for swipe
  const wristX = 1 - landmarks[WRIST].x;
  const now = Date.now();
  handleSwipe(gestureName, wristX, now);

  // Pinch via landmark distance
  const t2 = landmarks[THUMB_TIP], i2 = landmarks[INDEX_TIP];
  const pinchDist = Math.hypot(t2.x - i2.x, t2.y - i2.y, t2.z - i2.z);
  if (pinchDist < 0.06 && gestureName !== 'Closed_Fist') gestureName = 'Pinch';

  setGesture(gestureName);
  executeAction(gestureName, landmarks, pinchDist);

  prev.x = cursor.sx;
  prev.y = cursor.sy;
}

// ─── Swipe ──────────────────────────────────────────────────────────────────
function handleSwipe(g, wristX, now) {
  if (g === 'Open_Palm' && !swipeActive) {
    if (now - lastLayerSwitch < LAYER_COOLDOWN_MS) return;
    swipeActive = true; swipeT0 = now; swipeX0 = wristX;
    return;
  }
  if (swipeActive) {
    if (now - swipeT0 > SWIPE_WINDOW_MS) { swipeActive = false; return; }
    const dx = wristX - swipeX0;
    if (Math.abs(dx) > SWIPE_MIN) {
      swipeActive = false;
      lastLayerSwitch = now;
      const api = window._spatialGestureAPI;
      if (api) { dx > 0 ? api.gestureLayerNext() : api.gestureLayerPrev(); }
      flash();
    }
  }
}

// ─── Action mapping ─────────────────────────────────────────────────────────
const GESTURE_MAP = {
  Pointing_Up: 'point', Pinch: 'pinch', Closed_Fist: 'fist',
  Open_Palm: 'palm', Thumb_Up: 'thumbsup', Thumb_Down: 'thumbsdown',
  Victory: 'peace', ILoveYou: 'ily', None: 'none',
};

function executeAction(gesture, _lm, pinchDist) {
  const api = window._spatialGestureAPI;
  if (!api) return;
  const now = Date.now();

  switch (gesture) {
    case 'Pointing_Up':
      api.gestureRaycast(cursor.sx * innerWidth, cursor.sy * innerHeight);
      break;
    case 'Pinch':
      if (!isPinching) { isPinching = true; pinchBase = pinchDist; }
      else { api.gestureZoom((pinchDist - pinchBase) * ZOOM_SENS); pinchBase = pinchDist; }
      break;
    case 'Closed_Fist':
      if (!isGrabbing) isGrabbing = true;
      else api.gestureOrbit((cursor.sx - prev.x) * ORBIT_SENS, (cursor.sy - prev.y) * ORBIT_SENS);
      break;
    case 'Thumb_Up':
      if (gestureHeld && now - lastActionTime > COOLDOWN_MS) {
        lastActionTime = now; api.confirmAction(); flash();
      }
      break;
    default:
      isPinching = false; isGrabbing = false;
      break;
  }
}

// ─── UI helpers ─────────────────────────────────────────────────────────────
const ICONS  = { None:'', Pointing_Up:'\u261D', Pinch:'\uD83E\uDD0F', Closed_Fist:'\u270A', Open_Palm:'\uD83D\uDD90', Thumb_Up:'\uD83D\uDC4D', Thumb_Down:'\uD83D\uDC4E', Victory:'\u270C', ILoveYou:'\uD83E\uDD1F' };
const LABELS = { None:'NO HAND', Pointing_Up:'POINT \u2014 SELECT', Pinch:'PINCH \u2014 ZOOM', Closed_Fist:'FIST \u2014 ORBIT', Open_Palm:'PALM \u2014 SLIDE TO SWITCH', Thumb_Up:'CONFIRM', Thumb_Down:'THUMB DOWN', Victory:'PEACE', ILoveYou:'ILY' };

function setGesture(g) {
  if (g !== currentGesture) {
    currentGesture = g; gestureStart = Date.now(); gestureHeld = false;
    if (g !== 'Pinch') isPinching = false;
    if (g !== 'Closed_Fist') isGrabbing = false;
  }
  if (!gestureHeld && Date.now() - gestureStart > HOLD_MS) gestureHeld = true;

  const mapped = GESTURE_MAP[g] || 'none';
  if (mapped !== lastMapped) {
    lastMapped = mapped;
    if (dom.icon)  dom.icon.textContent = ICONS[g] || '';
    if (dom.label) dom.label.textContent = LABELS[g] || g;
    if (dom.indicator) dom.indicator.className = 'gesture-indicator gesture-' + mapped;
    if (dom.cursor)    dom.cursor.className = 'gesture-cursor gesture-cursor-' + mapped;
    if (dom.legendRows) dom.legendRows.forEach(r => r.classList.toggle('active-row', r.dataset.gesture === mapped));
  }
  if (dom.indicator && gestureHeld) dom.indicator.classList.add('gesture-held');
}

function moveCursor() {
  if (dom.cursor) dom.cursor.style.transform = `translate(${cursor.sx * innerWidth}px,${cursor.sy * innerHeight}px)`;
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

// ─── Drawing ────────────────────────────────────────────────────────────────
const CONNS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],[0,17],
];

function drawHand(landmarks) {
  if (!ctx || !canvasEl) return;
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  if (!landmarks) return;

  const w = canvasEl.width, h = canvasEl.height;
  ctx.strokeStyle = 'rgba(68,136,255,0.4)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const [a, b] of CONNS) {
    ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
    ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
  }
  ctx.stroke();

  ctx.fillStyle = '#4488ff';
  for (const i of [4, 8, 12, 16, 20]) {
    ctx.beginPath();
    ctx.arc(landmarks[i].x * w, landmarks[i].y * h, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─── Activate / Deactivate ──────────────────────────────────────────────────
async function activate() {
  if (active) return;
  active = true;
  buildOverlay();

  const btn = document.getElementById('gestureToggleBtn');
  if (btn) btn.classList.add('active');

  console.log('[Gesture] Activating...');
  setStatus('STARTING...', false);

  try {
    await startCam();
  } catch (err) {
    console.error('[Gesture] Camera failed:', err);
    setStatus(err.name === 'NotAllowedError' ? 'CAM DENIED' : 'CAM FAILED', false);
    setTimeout(() => deactivate(), 3000);
    return;
  }

  try {
    await loadModel();
  } catch (err) {
    console.error('[Gesture] Model load failed:', err);
    setStatus('LOAD FAILED', false);
    setTimeout(() => deactivate(), 3000);
    return;
  }

  // Start inference loop
  tick();
  console.log('[Gesture] Active — inference @', Math.round(1000 / INFERENCE_MS), 'fps');
}

function deactivate() {
  active = false;
  stopCam();
  if (recognizer) { try { recognizer.close(); } catch (_) {} recognizer = null; }

  if (dom.overlay) {
    dom.overlay.classList.remove('active');
    setTimeout(() => { if (dom.overlay) dom.overlay.remove(); }, 300);
  }
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

// Expose globally so spatial.js can call it
window._gestureController = {
  activate, deactivate, toggle,
  isActive: () => active,
  getCurrentGesture: () => currentGesture,
};

console.log('[Gesture] Module loaded');
