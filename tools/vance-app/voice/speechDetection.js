/**
 * VANCE — Speech Detection (Voice Activity Detection)
 *
 * Analyzes raw PCM audio chunks to detect when the user is speaking vs silence.
 * Uses energy-based VAD (no external dependencies) with configurable thresholds.
 *
 * Emits:
 *   'speech-start' — user started talking
 *   'speech-end'   — user stopped (after silence timeout)
 *   'speech-audio' — accumulated audio buffer of the speech segment
 */
const { EventEmitter } = require('events');

class SpeechDetection extends EventEmitter {
  constructor(config = {}) {
    super();

    // Audio config
    this.sampleRate = config.sampleRate || 16000;
    this.bytesPerSample = 2; // 16-bit PCM

    // VAD thresholds
    this.energyThreshold = config.energyThreshold || 0.008;  // RMS threshold for "speech"
    this.silenceTimeout = config.silenceTimeout || 800;       // ms of silence before speech-end
    this.minSpeechDuration = config.minSpeechDuration || 300; // ms minimum to count as speech
    this.preSpeechBuffer = config.preSpeechBuffer || 300;     // ms of audio to keep before speech start

    // State
    this.isSpeaking = false;
    this.silenceStart = 0;
    this.speechStart = 0;
    this.audioBuffer = [];          // chunks during current speech segment
    this.preSpeechChunks = [];      // rolling buffer of recent chunks before speech
    this.totalSpeechBytes = 0;

    // Pre-speech buffer size in bytes
    this.preSpeechMaxBytes = (this.sampleRate * this.bytesPerSample * this.preSpeechBuffer) / 1000;
  }

  /**
   * Calculate RMS (Root Mean Square) energy of a 16-bit PCM buffer
   */
  _calculateRMS(buffer) {
    const samples = buffer.length / this.bytesPerSample;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i += this.bytesPerSample) {
      // Read 16-bit signed integer (little-endian)
      const sample = buffer.readInt16LE(i);
      const normalized = sample / 32768; // normalize to [-1, 1]
      sumSquares += normalized * normalized;
    }

    return Math.sqrt(sumSquares / samples);
  }

  /**
   * Process incoming audio chunk from MicListener
   */
  processChunk(chunk) {
    const rms = this._calculateRMS(chunk);
    const now = Date.now();
    const isSpeech = rms > this.energyThreshold;

    if (isSpeech) {
      if (!this.isSpeaking) {
        // Speech just started
        this.isSpeaking = true;
        this.speechStart = now;
        this.silenceStart = 0;
        this.audioBuffer = [...this.preSpeechChunks]; // include pre-speech audio
        this.totalSpeechBytes = this.preSpeechChunks.reduce((sum, c) => sum + c.length, 0);
        this.emit('speech-start');
      }

      // Accumulate speech audio
      this.audioBuffer.push(chunk);
      this.totalSpeechBytes += chunk.length;
      this.silenceStart = 0; // reset silence timer

    } else {
      // Silence
      if (this.isSpeaking) {
        // Still in speech segment, accumulate (might be a brief pause)
        this.audioBuffer.push(chunk);
        this.totalSpeechBytes += chunk.length;

        if (!this.silenceStart) {
          this.silenceStart = now;
        }

        // Check if silence exceeded timeout
        if (now - this.silenceStart >= this.silenceTimeout) {
          const speechDuration = now - this.speechStart;

          if (speechDuration >= this.minSpeechDuration) {
            // Valid speech segment — emit the accumulated audio
            const fullAudio = Buffer.concat(this.audioBuffer);
            this.emit('speech-end', { duration: speechDuration });
            this.emit('speech-audio', fullAudio, { duration: speechDuration });
          } else {
            // Too short — discard (probably noise)
            this.emit('speech-end', { duration: speechDuration, discarded: true });
          }

          // Reset state
          this.isSpeaking = false;
          this.audioBuffer = [];
          this.totalSpeechBytes = 0;
          this.silenceStart = 0;
        }
      }

      // Maintain pre-speech rolling buffer
      this.preSpeechChunks.push(chunk);
      let preSpeechBytes = this.preSpeechChunks.reduce((sum, c) => sum + c.length, 0);
      while (preSpeechBytes > this.preSpeechMaxBytes && this.preSpeechChunks.length > 1) {
        const removed = this.preSpeechChunks.shift();
        preSpeechBytes -= removed.length;
      }
    }
  }

  /**
   * Force-end current speech segment (e.g., for interruption)
   */
  forceEnd() {
    if (this.isSpeaking) {
      const fullAudio = Buffer.concat(this.audioBuffer);
      const duration = Date.now() - this.speechStart;
      this.emit('speech-end', { duration, forced: true });
      if (duration >= this.minSpeechDuration) {
        this.emit('speech-audio', fullAudio, { duration, forced: true });
      }
      this.isSpeaking = false;
      this.audioBuffer = [];
      this.totalSpeechBytes = 0;
      this.silenceStart = 0;
    }
  }

  /**
   * Reset all state
   */
  reset() {
    this.isSpeaking = false;
    this.silenceStart = 0;
    this.speechStart = 0;
    this.audioBuffer = [];
    this.preSpeechChunks = [];
    this.totalSpeechBytes = 0;
  }

  /**
   * Update sensitivity (energy threshold)
   */
  setSensitivity(threshold) {
    this.energyThreshold = threshold;
  }
}

module.exports = SpeechDetection;
