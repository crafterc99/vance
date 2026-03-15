/**
 * VANCE — Microphone Listener
 *
 * Captures raw audio from the system microphone using macOS's `rec` (SoX)
 * or `ffmpeg` as a fallback. Streams PCM audio chunks to the speech detection
 * and transcription pipeline.
 *
 * Audio format: 16-bit PCM, 16kHz, mono (whisper-native format)
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { execSync } = require('child_process');

class MicListener extends EventEmitter {
  constructor(config = {}) {
    super();
    this.sampleRate = config.sampleRate || 16000;
    this.channels = config.channels || 1;
    this.bitDepth = config.bitDepth || 16;
    this.device = config.device || null; // null = system default
    this.proc = null;
    this.active = false;
    this.paused = false;
    this.backend = null; // 'sox' | 'ffmpeg'
  }

  /**
   * Detect which audio capture backend is available
   */
  _detectBackend() {
    // Prefer sox (rec command) — lightweight, fast
    // Check common paths including Homebrew locations
    const recPaths = ['/opt/homebrew/bin/rec', '/usr/local/bin/rec'];
    for (const p of recPaths) {
      if (require('fs').existsSync(p)) {
        this._recPath = p;
        return 'sox';
      }
    }
    try {
      execSync('which rec', { stdio: 'pipe' });
      this._recPath = 'rec';
      return 'sox';
    } catch {}

    // Fallback: ffmpeg with avfoundation
    const ffmpegPaths = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    for (const p of ffmpegPaths) {
      if (require('fs').existsSync(p)) {
        this._ffmpegPath = p;
        return 'ffmpeg';
      }
    }
    try {
      execSync('which ffmpeg', { stdio: 'pipe' });
      this._ffmpegPath = 'ffmpeg';
      return 'ffmpeg';
    } catch {}

    return null;
  }

  /**
   * Start capturing microphone audio.
   * Emits 'audio' events with raw PCM Buffer chunks.
   * Emits 'error' on failures.
   */
  start() {
    if (this.active) return;

    this.backend = this._detectBackend();
    if (!this.backend) {
      this.emit('error', new Error('No audio capture backend found. Install sox (`brew install sox`) or ffmpeg (`brew install ffmpeg`).'));
      return;
    }

    this.active = true;
    this.paused = false;

    if (this.backend === 'sox') {
      this._startSox();
    } else {
      this._startFfmpeg();
    }

    this.emit('started', { backend: this.backend, sampleRate: this.sampleRate });
  }

  _startSox() {
    // rec outputs raw PCM to stdout
    const args = [
      '-q',                          // quiet
      '-t', 'raw',                   // raw output
      '-b', String(this.bitDepth),   // 16-bit
      '-e', 'signed-integer',        // signed int
      '-r', String(this.sampleRate), // 16kHz
      '-c', String(this.channels),   // mono
      '-',                           // stdout
    ];

    this.proc = spawn(this._recPath || 'rec', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk) => {
      if (!this.paused) {
        this.emit('audio', chunk);
      }
    });

    this.proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('Input File')) {
        // sox often prints info to stderr, only emit real errors
        if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
          this.emit('error', new Error(`sox: ${msg}`));
        }
      }
    });

    this.proc.on('close', (code) => {
      this.active = false;
      this.emit('stopped', { code });
    });

    this.proc.on('error', (err) => {
      this.active = false;
      this.emit('error', err);
    });
  }

  _startFfmpeg() {
    // ffmpeg with avfoundation (macOS) captures from default mic
    const device = this.device || ':default';
    const args = [
      '-f', 'avfoundation',
      '-i', device,
      '-acodec', 'pcm_s16le',
      '-ar', String(this.sampleRate),
      '-ac', String(this.channels),
      '-f', 's16le',
      '-loglevel', 'error',
      'pipe:1',
    ];

    this.proc = spawn(this._ffmpegPath || 'ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk) => {
      if (!this.paused) {
        this.emit('audio', chunk);
      }
    });

    this.proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) this.emit('error', new Error(`ffmpeg: ${msg}`));
    });

    this.proc.on('close', (code) => {
      this.active = false;
      this.emit('stopped', { code });
    });

    this.proc.on('error', (err) => {
      this.active = false;
      this.emit('error', err);
    });
  }

  /**
   * Pause audio capture (mic stays open but chunks are discarded)
   */
  pause() {
    this.paused = true;
    this.emit('paused');
  }

  /**
   * Resume audio capture
   */
  resume() {
    this.paused = false;
    this.emit('resumed');
  }

  /**
   * Stop capturing and kill the subprocess
   */
  stop() {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.active = false;
    this.paused = false;
  }

  /**
   * Check if mic is currently capturing
   */
  isActive() {
    return this.active && !this.paused;
  }
}

module.exports = MicListener;
