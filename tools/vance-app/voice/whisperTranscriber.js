/**
 * VANCE — Whisper Transcriber (v2 — Upgraded)
 *
 * Transcribes speech audio using multiple backends (priority order):
 *   1. whisper.cpp (local, fast, free, offline) — preferred
 *   2. Groq Whisper API (cloud, ultra-fast, cheap) — fast fallback
 *   3. OpenAI Whisper API (cloud, reliable) — last resort
 *
 * Includes:
 *   - Noise/hallucination filtering
 *   - Configurable backend preference
 *   - Model management (detect installed models)
 *   - Word-level confidence (when available)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Common Whisper hallucinations to filter out
const HALLUCINATION_PATTERNS = [
  /^\[.*\]$/,                          // [BLANK_AUDIO], [MUSIC], etc.
  /^\(.*\)$/,                          // (silence), (music), etc.
  /^thanks?\s*for\s*watching/i,        // "Thanks for watching"
  /^please\s*subscribe/i,              // "Please subscribe"
  /^you$/i,                            // single word "you" (common hallucination)
  /^\s*\.+\s*$/,                       // just dots/periods
  /^thank you\.?$/i,                   // standalone "Thank you"
  /^bye\.?$/i,                         // standalone "Bye"
  /^♪/,                                // music notes
  /^🎵/,                               // music emoji
  /^\s*$/,                             // empty/whitespace only
];

class WhisperTranscriber {
  constructor(config = {}) {
    this.modelSize = config.modelSize || 'base';  // tiny, base, small, medium, large, large-v3-turbo
    this.language = config.language || 'en';
    this.sampleRate = config.sampleRate || 16000;
    this.openaiKey = config.openaiKey || null;
    this.groqKey = config.groqKey || null;
    this.backend = null;              // 'whisper-cpp' | 'groq' | 'openai-api'
    this.preferredBackend = config.preferredBackend || null; // force a specific backend
    this.whisperPath = config.whisperPath || null;
    this.modelPath = config.modelPath || null;
    this.tmpDir = path.join(os.tmpdir(), 'vance-voice');
    this.noiseFilter = config.noiseFilter !== false; // default: on
    this.lastTranscribeTime = 0;
    this.transcriptionCount = 0;

    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  /**
   * Detect available transcription backend (respects preferredBackend)
   */
  detect() {
    // If user forces a specific backend
    if (this.preferredBackend) {
      switch (this.preferredBackend) {
        case 'whisper-cpp':
          if (this._detectWhisperCpp()) return this.backend;
          break;
        case 'groq':
          if (this.groqKey) { this.backend = 'groq'; return this.backend; }
          break;
        case 'openai':
        case 'openai-api':
          if (this.openaiKey) { this.backend = 'openai-api'; return this.backend; }
          break;
      }
      // Fall through to auto-detect if preferred isn't available
    }

    // Auto-detect: whisper.cpp → Groq → OpenAI
    if (this._detectWhisperCpp()) return this.backend;
    if (this.groqKey) { this.backend = 'groq'; return this.backend; }
    if (this.openaiKey) { this.backend = 'openai-api'; return this.backend; }

    return null;
  }

  /**
   * Detect whisper.cpp binary
   */
  _detectWhisperCpp() {
    const possiblePaths = [
      this.whisperPath,
      '/usr/local/bin/whisper-cpp',
      '/opt/homebrew/bin/whisper-cpp',
      path.join(os.homedir(), 'whisper.cpp/main'),
      path.join(os.homedir(), 'whisper.cpp/build/bin/main'),
      path.join(os.homedir(), 'whisper.cpp/build/bin/whisper-cli'),
    ].filter(Boolean);

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        this.whisperPath = p;
        this.backend = 'whisper-cpp';
        return true;
      }
    }

    // Check PATH
    try {
      const resolved = execSync('which whisper-cpp 2>/dev/null || which whisper 2>/dev/null', {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      if (resolved) {
        this.whisperPath = resolved;
        this.backend = 'whisper-cpp';
        return true;
      }
    } catch {}

    // Check Homebrew
    try {
      const brewPrefix = execSync('brew --prefix whisper-cpp 2>/dev/null', {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      const binPath = path.join(brewPrefix, 'bin', 'whisper-cpp');
      if (fs.existsSync(binPath)) {
        this.whisperPath = binPath;
        this.backend = 'whisper-cpp';
        return true;
      }
    } catch {}

    return false;
  }

  /**
   * Find the whisper.cpp model file
   */
  _findModel() {
    if (this.modelPath && fs.existsSync(this.modelPath)) return this.modelPath;

    const modelName = `ggml-${this.modelSize}.bin`;
    const searchPaths = [
      path.join(os.homedir(), 'whisper.cpp/models', modelName),
      path.join(os.homedir(), '.cache/whisper', modelName),
      path.join('/usr/local/share/whisper-cpp/models', modelName),
      path.join('/opt/homebrew/share/whisper-cpp/models', modelName),
    ];

    // Also check Homebrew cellar
    try {
      const brewPrefix = execSync('brew --prefix whisper-cpp 2>/dev/null', {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      searchPaths.push(path.join(brewPrefix, 'share/whisper-cpp/models', modelName));
    } catch {}

    for (const p of searchPaths) {
      if (fs.existsSync(p)) {
        this.modelPath = p;
        return p;
      }
    }
    return null;
  }

  /**
   * List all installed whisper.cpp models
   */
  listInstalledModels() {
    const models = [];
    const modelDirs = [
      path.join(os.homedir(), 'whisper.cpp/models'),
      path.join(os.homedir(), '.cache/whisper'),
      '/usr/local/share/whisper-cpp/models',
      '/opt/homebrew/share/whisper-cpp/models',
    ];

    try {
      const brewPrefix = execSync('brew --prefix whisper-cpp 2>/dev/null', {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      modelDirs.push(path.join(brewPrefix, 'share/whisper-cpp/models'));
    } catch {}

    const seen = new Set();
    for (const dir of modelDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
          if (file.startsWith('ggml-') && file.endsWith('.bin')) {
            const name = file.replace('ggml-', '').replace('.bin', '');
            if (!seen.has(name)) {
              seen.add(name);
              const stat = fs.statSync(path.join(dir, file));
              models.push({
                name,
                size: stat.size,
                sizeMB: Math.round(stat.size / 1024 / 1024),
                path: path.join(dir, file),
              });
            }
          }
        }
      } catch {}
    }

    return models;
  }

  /**
   * Write raw PCM buffer to a WAV file
   */
  _writeWav(pcmBuffer) {
    const id = crypto.randomBytes(4).toString('hex');
    const wavPath = path.join(this.tmpDir, `speech-${id}.wav`);

    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = this.sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;
    const headerSize = 44;

    const header = Buffer.alloc(headerSize);
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + headerSize - 8, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    fs.writeFileSync(wavPath, Buffer.concat([header, pcmBuffer]));
    return wavPath;
  }

  /**
   * Filter out noise, hallucinations, and garbage transcriptions
   */
  _filterNoise(text) {
    if (!text || !this.noiseFilter) return text;

    const trimmed = text.trim();
    if (!trimmed) return '';

    for (const pattern of HALLUCINATION_PATTERNS) {
      if (pattern.test(trimmed)) return '';
    }

    // Filter very short transcriptions that are likely noise (1-2 chars)
    if (trimmed.length <= 2 && !/\w{2}/.test(trimmed)) return '';

    return trimmed;
  }

  /**
   * Transcribe audio buffer using whisper.cpp
   */
  async _transcribeWhisperCpp(pcmBuffer) {
    const wavPath = this._writeWav(pcmBuffer);
    const model = this._findModel();

    if (!model) {
      this._cleanup(wavPath);
      throw new Error(
        `Whisper model "${this.modelSize}" not found.\n` +
        `Install with: whisper-cpp-download-ggml-model ${this.modelSize}\n` +
        `Available models: tiny (75MB), base (142MB), small (466MB), medium (1.5GB), large-v3-turbo (1.5GB)`
      );
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-m', model,
        '-f', wavPath,
        '-l', this.language,
        '--no-timestamps',
        '-t', '4',         // threads (M1 sweet spot)
        '--print-special', 'false',
      ];

      const proc = spawn(this.whisperPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        this._cleanup(wavPath);
        if (code === 0) {
          const text = stdout
            .split('\n')
            .map(l => l.replace(/^\[.*?\]\s*/, '').trim())
            .filter(l => l && !l.startsWith('whisper_'))
            .join(' ')
            .trim();
          resolve(this._filterNoise(text));
        } else {
          reject(new Error(`whisper.cpp exited ${code}: ${stderr.slice(0, 300)}`));
        }
      });

      proc.on('error', (err) => {
        this._cleanup(wavPath);
        reject(err);
      });

      // Kill after 30s timeout
      setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('Whisper transcription timed out (30s)'));
      }, 30000);
    });
  }

  /**
   * Transcribe audio buffer using Groq Whisper API (ultra-fast)
   */
  async _transcribeGroq(pcmBuffer) {
    const wavPath = this._writeWav(pcmBuffer);

    try {
      const boundary = '----VanceVoice' + crypto.randomBytes(8).toString('hex');
      const fileData = fs.readFileSync(wavPath);

      const parts = [];
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`);
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${this.language}\r\n`);
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`);
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0.0\r\n`);
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`);

      const bodyParts = [
        Buffer.from(parts.join(''), 'utf8'),
        fileData,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
      ];
      const body = Buffer.concat(bodyParts);

      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.groqKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq Whisper API ${res.status}: ${errText}`);
      }

      const result = await res.json();
      const text = (result.text || '').trim();
      return this._filterNoise(text);

    } finally {
      this._cleanup(wavPath);
    }
  }

  /**
   * Transcribe audio buffer using OpenAI Whisper API (fallback)
   */
  async _transcribeOpenAI(pcmBuffer) {
    const wavPath = this._writeWav(pcmBuffer);

    try {
      const boundary = '----VanceVoice' + crypto.randomBytes(8).toString('hex');
      const fileData = fs.readFileSync(wavPath);

      const parts = [];
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`);
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${this.language}\r\n`);
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n`);
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`);

      const bodyParts = [
        Buffer.from(parts.join(''), 'utf8'),
        fileData,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
      ];
      const body = Buffer.concat(bodyParts);

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openaiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI Whisper API ${res.status}: ${errText}`);
      }

      const text = await res.text();
      return this._filterNoise(text.trim());

    } finally {
      this._cleanup(wavPath);
    }
  }

  /**
   * Transcribe a PCM audio buffer to text.
   * Returns the transcription string (empty string if noise/silence).
   */
  async transcribe(pcmBuffer) {
    if (!this.backend) this.detect();

    if (!this.backend) {
      throw new Error(
        'No transcription backend available.\n' +
        'Options:\n' +
        '  1. Install whisper.cpp: brew install whisper-cpp\n' +
        '  2. Set GROQ_API_KEY for ultra-fast cloud transcription (free tier)\n' +
        '  3. Set OPENAI_API_KEY for OpenAI Whisper API'
      );
    }

    const start = Date.now();
    let text;

    switch (this.backend) {
      case 'whisper-cpp':
        text = await this._transcribeWhisperCpp(pcmBuffer);
        break;
      case 'groq':
        text = await this._transcribeGroq(pcmBuffer);
        break;
      case 'openai-api':
        text = await this._transcribeOpenAI(pcmBuffer);
        break;
    }

    this.lastTranscribeTime = Date.now() - start;
    this.transcriptionCount++;
    return text || '';
  }

  _cleanup(filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }

  /**
   * Get info about the current configuration
   */
  getInfo() {
    return {
      backend: this.backend,
      modelSize: this.modelSize,
      language: this.language,
      whisperPath: this.whisperPath,
      modelPath: this.modelPath,
      groqAvailable: !!this.groqKey,
      openaiAvailable: !!this.openaiKey,
      localModels: this.backend === 'whisper-cpp' ? this.listInstalledModels() : [],
      lastTranscribeTime: this.lastTranscribeTime,
      transcriptionCount: this.transcriptionCount,
    };
  }
}

module.exports = WhisperTranscriber;
