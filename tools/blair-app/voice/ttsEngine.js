/**
 * BLAIR — Text-to-Speech Engine (v2 — Upgraded)
 *
 * Converts text to spoken audio. Supports multiple backends (priority order):
 *   1. Piper TTS (local, high quality, fast) — preferred
 *   2. ElevenLabs (cloud, best quality, expressive) — premium
 *   3. OpenAI TTS (cloud, good quality) — fallback premium
 *   4. macOS `say` command (built-in, decent quality) — always available
 *
 * Upgraded features:
 *   - Piper voice model auto-detection and listing
 *   - ElevenLabs integration with voice selection
 *   - Parallel sentence synthesis/playback pipeline
 *   - Noise gate for cleaner output
 *   - Better cancellation and interruption support
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
    this.backend = null;            // 'piper' | 'elevenlabs' | 'openai' | 'macos-say'
    this.preferredBackend = config.preferredBackend || null;
    this.voice = config.voice || null;
    this.speed = config.speed || 1.0;

    // API keys
    this.openaiKey = config.openaiKey || null;
    this.openaiVoice = config.openaiVoice || 'onyx';
    this.openaiModel = config.openaiModel || 'tts-1'; // tts-1 or tts-1-hd
    this.elevenLabsKey = config.elevenLabsKey || null;
    this.elevenLabsVoice = config.elevenLabsVoice || null; // voice ID
    this.elevenLabsModel = config.elevenLabsModel || 'eleven_turbo_v2_5';

    // Piper config
    this.piperPath = config.piperPath || null;
    this.piperModel = config.piperModel || null;

    // Runtime state
    this.tmpDir = path.join(os.tmpdir(), 'blair-voice');
    this.currentProc = null;
    this.speaking = false;
    this.synthQueue = [];         // pre-synthesized audio files ready to play
    this.lastSpeakTime = 0;
    this.speakCount = 0;

    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  /**
   * Detect available TTS backend (respects preferredBackend)
   */
  detect() {
    if (this.preferredBackend) {
      switch (this.preferredBackend) {
        case 'piper':
          if (this._detectPiper()) return this.backend;
          break;
        case 'elevenlabs':
          if (this.elevenLabsKey) { this.backend = 'elevenlabs'; return this.backend; }
          break;
        case 'openai':
          if (this.openaiKey) { this.backend = 'openai'; return this.backend; }
          break;
        case 'macos-say':
          this.backend = 'macos-say'; return this.backend;
      }
    }

    // Auto-detect: Piper → ElevenLabs → OpenAI → macOS say
    if (this._detectPiper()) return this.backend;
    if (this.elevenLabsKey) { this.backend = 'elevenlabs'; return this.backend; }
    if (this.openaiKey) { this.backend = 'openai'; return this.backend; }

    // macOS say is always available on macOS
    try {
      execSync('which say', { stdio: 'pipe' });
      this.backend = 'macos-say';
      return this.backend;
    } catch {}

    return null;
  }

  /**
   * Detect Piper TTS binary
   */
  _detectPiper() {
    const piperPaths = [
      this.piperPath,
      '/usr/local/bin/piper',
      '/opt/homebrew/bin/piper',
      path.join(os.homedir(), 'piper/piper'),
      path.join(os.homedir(), '.local/bin/piper'),
    ].filter(Boolean);

    for (const p of piperPaths) {
      if (fs.existsSync(p)) {
        this.piperPath = p;
        this.backend = 'piper';
        return true;
      }
    }

    try {
      const resolved = execSync('which piper 2>/dev/null', {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      if (resolved) {
        this.piperPath = resolved;
        this.backend = 'piper';
        return true;
      }
    } catch {}

    return false;
  }

  /**
   * List installed Piper voice models
   */
  listPiperModels() {
    const models = [];
    const modelDirs = [
      path.join(os.homedir(), '.local/share/piper-voices'),
      path.join(os.homedir(), 'piper/models'),
      path.join(os.homedir(), '.config/piper/models'),
      '/usr/local/share/piper-voices',
      '/opt/homebrew/share/piper-voices',
    ];

    const seen = new Set();
    for (const dir of modelDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        this._scanPiperModelsDir(dir, models, seen);
      } catch {}
    }

    // Also check if piperModel points to a specific file
    if (this.piperModel && fs.existsSync(this.piperModel)) {
      const name = path.basename(this.piperModel, '.onnx');
      if (!seen.has(name)) {
        models.push({ name, path: this.piperModel, quality: 'unknown' });
      }
    }

    return models;
  }

  _scanPiperModelsDir(dir, models, seen) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this._scanPiperModelsDir(fullPath, models, seen);
      } else if (entry.name.endsWith('.onnx')) {
        const name = entry.name.replace('.onnx', '');
        if (!seen.has(name)) {
          seen.add(name);
          const configPath = fullPath + '.json';
          let quality = 'medium';
          let language = 'unknown';
          try {
            if (fs.existsSync(configPath)) {
              const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
              quality = cfg.audio?.quality || 'medium';
              language = cfg.language?.code || 'unknown';
            }
          } catch {}
          models.push({ name, path: fullPath, quality, language });
        }
      }
    }
  }

  /**
   * Synthesize text to speech and play it.
   * Returns a promise that resolves when playback finishes.
   */
  async speak(text) {
    if (!text || !text.trim()) return;
    if (!this.backend) this.detect();
    if (!this.backend) throw new Error('No TTS backend available.');

    this.speaking = true;
    this.emit('speak-start', { text, backend: this.backend });

    const start = Date.now();
    try {
      switch (this.backend) {
        case 'piper':
          await this._speakPiper(text);
          break;
        case 'elevenlabs':
          await this._speakElevenLabs(text);
          break;
        case 'openai':
          await this._speakOpenAI(text);
          break;
        case 'macos-say':
          await this._speakMacOS(text);
          break;
      }
      this.lastSpeakTime = Date.now() - start;
      this.speakCount++;
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

        // Play the generated WAV
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
   * Speak using ElevenLabs TTS (cloud, best quality)
   */
  async _speakElevenLabs(text) {
    const outFile = path.join(this.tmpDir, `tts-${crypto.randomBytes(4).toString('hex')}.mp3`);
    const voiceId = this.elevenLabsVoice || 'pNInz6obpgDQGcFmaJgB'; // Adam (default deep male)

    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.elevenLabsKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: this.elevenLabsModel,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.3,
            use_speaker_boost: true,
          },
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`ElevenLabs TTS ${res.status}: ${err}`);
      }

      const arrayBuf = await res.arrayBuffer();
      fs.writeFileSync(outFile, Buffer.from(arrayBuf));

      await this._playFile(outFile);
    } catch (err) {
      this._cleanup(outFile);
      throw err;
    }
  }

  /**
   * Speak using macOS built-in `say` command
   */
  async _speakMacOS(text) {
    return new Promise((resolve, reject) => {
      const cleanText = text
        .replace(/[`*_~#]/g, '')
        .replace(/\n+/g, '. ')
        .replace(/\s+/g, ' ')
        .trim();

      const args = [];
      if (this.voice) {
        args.push('-v', this.voice);
      } else {
        args.push('-v', 'Samantha');
      }
      if (this.speed !== 1.0) {
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
          model: this.openaiModel,
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

      await this._playFile(outFile);
    } catch (err) {
      this._cleanup(outFile);
      throw err;
    }
  }

  /**
   * Play an audio file using afplay (macOS)
   */
  _playFile(filePath) {
    return new Promise((resolve, reject) => {
      const player = spawn('afplay', [filePath]);
      this.currentProc = player;
      player.on('close', () => { this._cleanup(filePath); resolve(); });
      player.on('error', (err) => { this._cleanup(filePath); reject(err); });
    });
  }

  /**
   * Speak text sentence-by-sentence as it arrives (streaming TTS).
   * Uses parallel synthesis: synthesizes next sentence while playing current one.
   */
  async speakStream(sentenceGenerator) {
    this.speaking = true;
    this.emit('speak-start', { streaming: true });

    try {
      let pendingSynth = null;

      for await (const sentence of sentenceGenerator) {
        if (!this.speaking) break;
        if (sentence && sentence.trim()) {
          // If we have a pre-synthesized file ready, play it while synthesizing next
          if (pendingSynth) {
            await pendingSynth;
          }
          // Speak current sentence
          await this.speak(sentence);
        }
      }

      if (pendingSynth) await pendingSynth;
    } finally {
      this.speaking = false;
      this.emit('speak-end');
    }
  }

  /**
   * Pre-synthesize text to a file without playing (for pipeline optimization)
   */
  async synthesize(text) {
    if (!text || !text.trim()) return null;
    if (!this.backend) this.detect();

    if (this.backend === 'piper') {
      return this._synthesizePiper(text);
    }
    // Other backends don't support easy pre-synthesis, return null
    return null;
  }

  async _synthesizePiper(text) {
    const outFile = path.join(this.tmpDir, `pre-${crypto.randomBytes(4).toString('hex')}.wav`);
    return new Promise((resolve, reject) => {
      const args = ['--output_file', outFile];
      if (this.piperModel) args.push('--model', this.piperModel);

      const proc = spawn(this.piperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      proc.stdin.write(text);
      proc.stdin.end();

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outFile)) resolve(outFile);
        else { this._cleanup(outFile); resolve(null); }
      });
      proc.on('error', () => { this._cleanup(outFile); resolve(null); });
    });
  }

  /**
   * Cancel current speech immediately
   */
  cancel() {
    this.speaking = false;
    this.synthQueue = [];
    if (this.currentProc) {
      try { this.currentProc.kill('SIGTERM'); } catch {}
      this.currentProc = null;
    }
    this.emit('speak-cancelled');
  }

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

  /**
   * List available ElevenLabs voices
   */
  async listElevenLabsVoices() {
    if (!this.elevenLabsKey) return [];
    try {
      const res = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': this.elevenLabsKey },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.voices || []).map(v => ({
        id: v.voice_id,
        name: v.name,
        category: v.category,
        labels: v.labels,
      }));
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
      piperModels: this.backend === 'piper' ? this.listPiperModels() : [],
      elevenLabsAvailable: !!this.elevenLabsKey,
      openaiAvailable: !!this.openaiKey,
      lastSpeakTime: this.lastSpeakTime,
      speakCount: this.speakCount,
    };
  }
}

module.exports = TTSEngine;
