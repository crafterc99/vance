// ═══════════════════════════════════════════════════════════════════════════
// GESTURE WORKER — Runs MediaPipe inference off the main thread
// Receives ImageBitmap frames, returns landmarks + gesture name
// ═══════════════════════════════════════════════════════════════════════════

const MP_VERSION = '0.10.32';
const MP_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task';

let recognizer = null;

self.onmessage = async function (e) {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      self.postMessage({ type: 'status', text: 'LOADING SDK...' });
      const vision = await import(MP_CDN + '/vision_bundle.mjs');
      const { GestureRecognizer, FilesetResolver } = vision;

      self.postMessage({ type: 'status', text: 'LOADING WASM...' });
      const fileset = await FilesetResolver.forVisionTasks(MP_CDN + '/wasm');

      self.postMessage({ type: 'status', text: 'LOADING MODEL...' });
      recognizer = await GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });

      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || 'Load failed' });
    }
  }

  if (msg.type === 'frame' && recognizer) {
    try {
      const result = recognizer.recognizeForVideo(msg.bitmap, msg.timestamp);
      msg.bitmap.close();

      let landmarks = null;
      if (result.landmarks && result.landmarks.length > 0) {
        landmarks = result.landmarks[0].map(lm => ({ x: lm.x, y: lm.y, z: lm.z || 0 }));
      }

      let gesture = 'None';
      if (result.gestures && result.gestures.length > 0 && result.gestures[0].length > 0) {
        gesture = result.gestures[0][0].categoryName || 'None';
      }

      self.postMessage({ type: 'result', landmarks, gesture });
    } catch (err) {
      if (msg.bitmap) try { msg.bitmap.close(); } catch (_) {}
      self.postMessage({ type: 'error', message: err.message || 'Inference error' });
    }
  }
};
