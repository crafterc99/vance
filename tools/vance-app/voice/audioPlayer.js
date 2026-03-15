/**
 * VANCE — Audio Player
 *
 * Manages audio playback queue for voice output. Handles:
 *   - Sequential playback of speech segments
 *   - Interruption (stop current + clear queue)
 *   - Volume control
 *   - Playback state tracking
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');

class AudioPlayer extends EventEmitter {
  constructor(config = {}) {
    super();
    this.volume = config.volume || 1.0;  // 0.0 - 1.0
    this.queue = [];
    this.currentProc = null;
    this.playing = false;
    this.processing = false;
  }

  /**
   * Play an audio file (WAV or MP3). Returns when playback finishes.
   */
  async play(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Audio file not found: ${filePath}`);
    }

    this.playing = true;
    this.emit('play-start', { file: filePath });

    return new Promise((resolve, reject) => {
      // afplay is macOS's built-in audio player
      const args = [filePath];
      if (this.volume !== 1.0) {
        args.push('-v', String(this.volume));
      }

      const proc = spawn('afplay', args, { stdio: 'pipe' });
      this.currentProc = proc;

      proc.on('close', (code) => {
        this.playing = false;
        this.currentProc = null;
        this.emit('play-end', { file: filePath });
        if (code === 0) resolve();
        else reject(new Error(`afplay exited ${code}`));
      });

      proc.on('error', (err) => {
        this.playing = false;
        this.currentProc = null;
        reject(err);
      });
    });
  }

  /**
   * Add a file to the playback queue and start processing if idle
   */
  enqueue(filePath) {
    this.queue.push(filePath);
    if (!this.processing) {
      this._processQueue();
    }
  }

  /**
   * Process the playback queue sequentially
   */
  async _processQueue() {
    this.processing = true;

    while (this.queue.length > 0) {
      const file = this.queue.shift();
      try {
        await this.play(file);
      } catch (err) {
        this.emit('error', err);
      }
    }

    this.processing = false;
    this.emit('queue-empty');
  }

  /**
   * Stop current playback and clear the queue
   */
  stop() {
    this.queue = [];
    if (this.currentProc) {
      try { this.currentProc.kill('SIGTERM'); } catch {}
      this.currentProc = null;
    }
    this.playing = false;
    this.processing = false;
    this.emit('stopped');
  }

  /**
   * Set playback volume (0.0 - 1.0)
   */
  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
  }

  /**
   * Check if currently playing
   */
  isPlaying() {
    return this.playing;
  }
}

module.exports = AudioPlayer;
