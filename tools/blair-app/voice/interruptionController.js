/**
 * BLAIR — Interruption Controller
 *
 * Manages the interruption system for voice conversations.
 * When the user starts speaking while Blair is talking:
 *   1. Immediately stops TTS playback
 *   2. Cancels any pending response generation
 *   3. Switches back to listening mode
 *   4. Processes the new user input
 *
 * This gives a natural conversational feel where the user can cut Blair off.
 */
const { EventEmitter } = require('events');

class InterruptionController extends EventEmitter {
  constructor({ ttsEngine, speechDetection, micListener }) {
    super();
    this.tts = ttsEngine;
    this.vad = speechDetection;
    this.mic = micListener;
    this.enabled = true;
    this.sensitivity = 0.5;           // 0-1, how easily the user can interrupt
    this.minInterruptionDuration = 200; // ms of speech needed to trigger interrupt
    this.interruptionCooldown = 500;   // ms cooldown after interruption
    this.lastInterruption = 0;
    this.pendingAbortController = null;

    this._boundOnSpeechStart = this._onSpeechStart.bind(this);
  }

  /**
   * Start monitoring for interruptions
   */
  startMonitoring() {
    this.vad.on('speech-start', this._boundOnSpeechStart);
  }

  /**
   * Stop monitoring for interruptions
   */
  stopMonitoring() {
    this.vad.removeListener('speech-start', this._boundOnSpeechStart);
  }

  /**
   * Called when VAD detects speech while Blair might be talking
   */
  _onSpeechStart() {
    if (!this.enabled) return;
    if (!this.tts.isSpeaking()) return; // Blair isn't speaking, no interruption needed

    const now = Date.now();
    if (now - this.lastInterruption < this.interruptionCooldown) return;

    this.lastInterruption = now;
    this._executeInterruption();
  }

  /**
   * Execute the interruption sequence
   */
  _executeInterruption() {
    // 1. Stop TTS immediately
    this.tts.cancel();

    // 2. Abort any pending response generation
    if (this.pendingAbortController) {
      this.pendingAbortController.abort();
      this.pendingAbortController = null;
    }

    // 3. Emit interruption event
    this.emit('interrupted', {
      timestamp: Date.now(),
    });
  }

  /**
   * Set an AbortController for the current response generation.
   * This will be cancelled on interruption.
   */
  setAbortController(controller) {
    this.pendingAbortController = controller;
  }

  /**
   * Clear the abort controller (response completed normally)
   */
  clearAbortController() {
    this.pendingAbortController = null;
  }

  /**
   * Enable/disable interruption handling
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /**
   * Set interruption sensitivity (0 = hard to interrupt, 1 = very easy)
   */
  setSensitivity(sensitivity) {
    this.sensitivity = Math.max(0, Math.min(1, sensitivity));
    // Adjust VAD threshold based on sensitivity
    // Lower threshold = easier to interrupt = higher sensitivity
    const baseThreshold = 0.015;
    const threshold = baseThreshold * (1 - this.sensitivity * 0.8);
    this.vad.setSensitivity(threshold);
  }
}

module.exports = InterruptionController;
