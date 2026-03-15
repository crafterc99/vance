/**
 * VANCE — Text-to-Speech Engine
 *
 * Converts text to spoken audio. Supports multiple backends:
 *   1. Piper TTS (local, high quality, fast) — preferred
 *   2. macOS `say` command (built-in, decent quality) — fallback
 *   3. OpenAI TTS API (cloud, highest quality) — optional premium
 *
 * For the voice conversation loop, the engine supports:
 *   - Full sentence synthesis
 *   - Sentence-by-sentence streaming (synthesize as text arrives)
 *   - Cancellation mid-speech (for interruptions)
 */
const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class TTSEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.backend = null;          // 'piper' | 'macos-say' | 'openai'
    this.voice = config.voice || null;
    this.speed = config.speed || 1.0;
    this.openaiKey = config.openaiKey || null;
    this.openaiVoice = config.openaiVoice || 'onyx'; // onyx = deep calm male
    this.piperPath = config.piperPath || null;
    this.piperModel = config.piperModel || null;
    this.tmpDir = path.join(os.tmpdir(), 'vance-voice');
    this.currentProc = null;      // active TTS process (for cancellation)
    this.speaking = false;

    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  /**
   * Detect available TTS backend
   */
  detect() {
    // Check for Piper TTS
    const piperPaths = [
      this.piperPath,
      '/usr/local/bin/piper',
      '/opt/homebrew/bin/piper',
      path.join(os.homedir(), 'piper/piper'),
    ].filter(Boolean);

    for (const p of piperPaths) {
      if (fs.existsSync(p)) {
        this.piperPath = p;
        this.backend = 'piper';
        break;
      }
    }

    if (!this.backend) {
      try {
        const resolved = execSync('which piper 2>/dev/null', {
          encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        if (resolved) {
          this.piperPath = resolved;
          this.backend = 'piper';
        }
      } catch {}
    }

    // macOS say is always available
    if (!this.backend) {
      try {
        execSync('which say', { stdio: 'pipe' });
        this.backend = 'macos-say';
      } catch {}
    }

    // OpenAI TTS API as last resort
    if (!this.backend && this.openaiKey) {
      this.backend = 'openai';
    }

    return this.backend;
  }

  /**
   * Synthesize text to speech and play it.
   * Returns a promise that resolves when playback finishes.
   * Can be cancelled via cancel().
   */
  async speak(text) {
    if (!text || !text.trim()) return;
    if (!this.backend) this.detect();
    if (!this.backend) throw new Error('No TTS backend available.');

    this.speaking = true;
    this.emit('speak-start', { text, backend: this.backend });

    try {
      switch (this.backend) {
        case 'piper':
          await this._speakPiper(text);
          break;
        case 'macos-say':
          await this._speakMacOS(text);
          break;
        case 'openai':
          await this._speakOpenAI(text);
          break;
      }
    } finally {
      this.speaking = false;
      this.currentProc = null;
      this.emit('speak-end');
    }
  }

  /**
   * Speak using Piper TTS (local, fast, high quality)
   */
  async _speakPiper(text) {
    return new Promise((resolve, reject) => {
      const outFile = path.join(this.tmpDir, `tts-${crypto.randomBytes(4).toString('hex')}.wav`);

      const args = ['--output_file', outFile];
      if (this.piperModel) args.push('--model', this.piperModel);

      const proc = spawn(this.piperPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;

      // Write text to stdin
      proc.stdin.write(text);
      proc.stdin.end();

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(outFile)) {
          this._cleanup(outFile);
          reject(new Error(`Piper TTS failed (${code}): ${stderr.slice(0, 200)}`));
          return;
        }

        // Play the generated WAV using afplay (macOS)
        const player = spawn('afplay', ['-r', String(this.speed), outFile]);
        this.currentProc = player;

        player.on('close', () => {
          this._cleanup(outFile);
          resolve();
        });
        player.on('error', (err) => {
          this._cleanup(outFile);
          reject(err);
        });
      });

      proc.on('error', (err) => {
        this._cleanup(outFile);
        reject(err);
      });
    });
  }

  /**
   * Speak using macOS built-in `say` command
   */
  async _speakMacOS(text) {
    return new Promise((resolve, reject) => {
      // Clean text for say command (remove special chars that cause issues)
      const cleanText = text
        .replace(/[`*_~#]/g, '')     // remove markdown artifacts
        .replace(/\n+/g, '. ')       // newlines to pauses
        .replace(/\s+/g, ' ')        // collapse whitespace
        .trim();

      const args = [];
      if (this.voice) {
        args.push('-v', this.voice);
      } else {
        // Default to a good voice — Samantha (female) or Alex (male) on macOS
        args.push('-v', 'Samantha');
      }
      if (this.speed !== 1.0) {
        // say rate is words per minute, default ~175
        args.push('-r', String(Math.round(175 * this.speed)));
      }
      args.push(cleanText);

      const proc = spawn('say', args, { stdio: 'pipe' });
      this.currentProc = proc;

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`say exited ${code}`));
      });
      proc.on('error', reject);
    });
  }

  /**
   * Speak using OpenAI TTS API
   */
  async _speakOpenAI(text) {
    const outFile = path.join(this.tmpDir, `tts-${crypto.randomBytes(4).toString('hex')}.mp3`);

    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',            // tts-1 = fast, tts-1-hd = higher quality
          input: text,
          voice: this.openaiVoice,
          speed: this.speed,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI TTS ${res.status}: ${err}`);
      }

      const arrayBuf = await res.arrayBuffer();
      fs.writeFileSync(outFile, Buffer.from(arrayBuf));

      // Play the audio
      await new Promise((resolve, reject) => {
        const player = spawn('afplay', [outFile]);
        this.currentProc = player;
        player.on('close', () => { this._cleanup(outFile); resolve(); });
        player.on('error', (err) => { this._cleanup(outFile); reject(err); });
      });

    } catch (err) {
      this._cleanup(outFile);
      throw err;
    }
  }

  /**
   * Speak text sentence-by-sentence as it arrives (streaming TTS).
   * Accepts an async generator or array of sentences.
   */
  async speakStream(sentenceGenerator) {
    this.speaking = true;
    this.emit('speak-start', { streaming: true });

    try {
      for await (const sentence of sentenceGenerator) {
        if (!this.speaking) break; // cancelled
        if (sentence && sentence.trim()) {
          await this.speak(sentence);
        }
      }
    } finally {
      this.speaking = false;
      this.emit('speak-end');
    }
  }

  /**
   * Cancel current speech immediately (for interruption handling)
   */
  cancel() {
    this.speaking = false;
    if (this.currentProc) {
      try { this.currentProc.kill('SIGTERM'); } catch {}
      this.currentProc = null;
    }
    this.emit('speak-cancelled');
  }

  /**
   * Check if currently speaking
   */
  isSpeaking() {
    return this.speaking;
  }

  _cleanup(filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }

  /**
   * Get available macOS voices
   */
  static listMacOSVoices() {
    try {
      const output = execSync('say -v "?"', { encoding: 'utf8' });
      return output.split('\n')
        .filter(l => l.trim())
        .map(l => {
          const match = l.match(/^(\S+)\s+(\S+)/);
          return match ? { name: match[1], lang: match[2] } : null;
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  getInfo() {
    return {
      backend: this.backend,
      voice: this.voice,
      speed: this.speed,
      piperPath: this.piperPath,
      piperModel: this.piperModel,
    };
  }
}

module.exports = TTSEngine;
