/**
 * VANCE — Whisper Transcriber
 *
 * Transcribes speech audio using whisper.cpp (local, fast, free).
 * Falls back to OpenAI Whisper API if whisper.cpp is not installed.
 *
 * Accepts raw PCM audio buffers and returns transcription text.
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class WhisperTranscriber {
  constructor(config = {}) {
    this.modelSize = config.modelSize || 'base';  // tiny, base, small, medium, large
    this.language = config.language || 'en';
    this.sampleRate = config.sampleRate || 16000;
    this.openaiKey = config.openaiKey || null;
    this.backend = null; // 'whisper-cpp' | 'openai-api'
    this.whisperPath = config.whisperPath || null;
    this.modelPath = config.modelPath || null;
    this.tmpDir = path.join(os.tmpdir(), 'vance-voice');

    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  /**
   * Detect available transcription backend
   */
  detect() {
    // Check for whisper.cpp binary
    const possiblePaths = [
      this.whisperPath,
      '/usr/local/bin/whisper-cpp',
      '/opt/homebrew/bin/whisper-cpp',
      path.join(os.homedir(), 'whisper.cpp/main'),
      path.join(os.homedir(), 'whisper.cpp/build/bin/main'),
    ].filter(Boolean);

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        this.whisperPath = p;
        this.backend = 'whisper-cpp';
        break;
      }
    }

    // Also check if it's on PATH
    if (!this.backend) {
      try {
        const resolved = execSync('which whisper-cpp 2>/dev/null || which whisper 2>/dev/null', {
          encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        if (resolved) {
          this.whisperPath = resolved;
          this.backend = 'whisper-cpp';
        }
      } catch {}
    }

    // Check for Homebrew whisper.cpp
    if (!this.backend) {
      try {
        const brewPrefix = execSync('brew --prefix whisper-cpp 2>/dev/null', {
          encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        const binPath = path.join(brewPrefix, 'bin', 'whisper-cpp');
        if (fs.existsSync(binPath)) {
          this.whisperPath = binPath;
          this.backend = 'whisper-cpp';
        }
      } catch {}
    }

    // Fallback: OpenAI Whisper API
    if (!this.backend && this.openaiKey) {
      this.backend = 'openai-api';
    }

    return this.backend;
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
   * Write raw PCM buffer to a WAV file (whisper.cpp needs WAV input)
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
    header.writeUInt32LE(16, 16);           // fmt chunk size
    header.writeUInt16LE(1, 20);            // PCM format
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
   * Transcribe audio buffer using whisper.cpp
   */
  async _transcribeWhisperCpp(pcmBuffer) {
    const wavPath = this._writeWav(pcmBuffer);
    const model = this._findModel();

    if (!model) {
      this._cleanup(wavPath);
      throw new Error(`Whisper model "${this.modelSize}" not found. Download with: whisper-cpp-download-ggml-model ${this.modelSize}`);
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
          // whisper.cpp outputs text with some whitespace/metadata — clean it
          const text = stdout
            .split('\n')
            .map(l => l.replace(/^\[.*?\]\s*/, '').trim()) // remove timestamps if present
            .filter(l => l && !l.startsWith('whisper_'))    // remove debug lines
            .join(' ')
            .trim();
          resolve(text);
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
   * Transcribe audio buffer using OpenAI Whisper API (fallback)
   */
  async _transcribeOpenAI(pcmBuffer) {
    const wavPath = this._writeWav(pcmBuffer);

    try {
      // Use multipart form upload
      const boundary = '----VanceVoice' + crypto.randomBytes(8).toString('hex');
      const fileData = fs.readFileSync(wavPath);

      const parts = [];
      // model field
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`);
      // language field
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${this.language}\r\n`);
      // response_format
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n`);
      // file field
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
      return text.trim();

    } finally {
      this._cleanup(wavPath);
    }
  }

  /**
   * Transcribe a PCM audio buffer to text.
   * Returns the transcription string.
   */
  async transcribe(pcmBuffer) {
    if (!this.backend) this.detect();

    if (!this.backend) {
      throw new Error('No transcription backend available. Install whisper.cpp (`brew install whisper-cpp`) or set OPENAI_API_KEY.');
    }

    if (this.backend === 'whisper-cpp') {
      return this._transcribeWhisperCpp(pcmBuffer);
    } else {
      return this._transcribeOpenAI(pcmBuffer);
    }
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
    };
  }
}

module.exports = WhisperTranscriber;
