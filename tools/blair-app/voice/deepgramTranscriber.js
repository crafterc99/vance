/**
 * BLAIR — Deepgram Streaming Transcriber
 *
 * Real-time streaming speech-to-text using Deepgram Nova-3.
 * Unlike Whisper (batch mode), Deepgram processes audio in real-time
 * and emits partial transcripts as the user speaks.
 *
 * Benefits over Whisper:
 *   - Native streaming (no batch latency)
 *   - Better accuracy for conversational speech
 *   - Built-in endpointing (smart silence detection)
 *   - Partial transcripts for early processing
 *   - ~200-400ms latency vs Whisper's 1-3s
 */
const { EventEmitter } = require('events');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

class DeepgramTranscriber extends EventEmitter {
  constructor(config = {}) {
    super();
    this.apiKey = config.deepgramKey || process.env.DEEPGRAM_API_KEY || '';
    this.language = config.language || 'en';
    this.model = config.model || 'nova-3';
    this.sampleRate = config.sampleRate || 16000;
    this.client = null;
    this.connection = null;
    this.connected = false;
    this.lastTranscribeTime = 0;
    this.transcriptionCount = 0;

    // Accumulate partial transcripts for the current utterance
    this._partialTranscript = '';
    this._finalTranscript = '';
    this._utteranceTimeout = null;
  }

  /**
   * Check if Deepgram is available
   */
  isAvailable() {
    return !!this.apiKey;
  }

  /**
   * Start a live transcription session.
   * Call sendAudio() to feed audio chunks.
   * Listen for 'transcript', 'partial', and 'utterance-end' events.
   */
  async start() {
    if (!this.apiKey) {
      throw new Error('Deepgram API key not set. Set DEEPGRAM_API_KEY env var.');
    }

    this.client = createClient(this.apiKey);
    this.connection = this.client.listen.live({
      model: this.model,
      language: this.language,
      smart_format: true,
      punctuate: true,
      endpointing: 300,           // ms of silence to finalize utterance (fast)
      interim_results: true,       // send partial transcripts
      utterance_end_ms: 1200,      // max utterance gap before forced end
      vad_events: true,            // voice activity detection events
      sample_rate: this.sampleRate,
      channels: 1,
      encoding: 'linear16',
    });

    return new Promise((resolve, reject) => {
      this.connection.on(LiveTranscriptionEvents.Open, () => {
        this.connected = true;
        this.emit('connected');
        resolve();
      });

      this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        this._handleTranscript(data);
      });

      this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
        // Deepgram detected end of utterance (user stopped talking)
        if (this._finalTranscript.trim()) {
          this.emit('utterance-end', {
            text: this._finalTranscript.trim(),
            timestamp: Date.now(),
          });
          this._finalTranscript = '';
          this._partialTranscript = '';
        }
      });

      this.connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
        this.emit('speech-started');
      });

      this.connection.on(LiveTranscriptionEvents.Error, (err) => {
        this.emit('error', err);
        if (!this.connected) reject(err);
      });

      this.connection.on(LiveTranscriptionEvents.Close, () => {
        this.connected = false;
        this.emit('disconnected');
      });

      // Timeout connection attempt
      setTimeout(() => {
        if (!this.connected) reject(new Error('Deepgram connection timeout'));
      }, 10000);
    });
  }

  /**
   * Handle incoming transcript from Deepgram
   */
  _handleTranscript(data) {
    const alt = data.channel?.alternatives?.[0];
    if (!alt) return;

    const text = alt.transcript || '';
    if (!text) return;

    const isFinal = data.is_final;
    const confidence = alt.confidence || 0;

    if (isFinal) {
      // Final transcript for this speech segment
      this._finalTranscript += (this._finalTranscript ? ' ' : '') + text;
      this._partialTranscript = '';
      this.transcriptionCount++;

      this.emit('transcript', {
        text,
        fullText: this._finalTranscript,
        confidence,
        isFinal: true,
      });
    } else {
      // Partial/interim transcript (user still speaking)
      this._partialTranscript = text;

      this.emit('partial', {
        text,
        confidence,
        isFinal: false,
      });
    }
  }

  /**
   * Send raw PCM audio data to Deepgram for transcription.
   * Call this continuously with mic audio chunks.
   */
  sendAudio(pcmBuffer) {
    if (this.connected && this.connection) {
      this.connection.send(pcmBuffer);
    }
  }

  /**
   * Stop the live transcription session
   */
  stop() {
    if (this.connection) {
      try { this.connection.finish(); } catch {}
      this.connection = null;
    }
    this.connected = false;
    this._partialTranscript = '';
    this._finalTranscript = '';
  }

  /**
   * Get current partial transcript (what user is saying right now)
   */
  getPartialTranscript() {
    return this._partialTranscript;
  }

  /**
   * Get accumulated final transcript for current utterance
   */
  getFinalTranscript() {
    return this._finalTranscript;
  }

  getInfo() {
    return {
      backend: 'deepgram',
      model: this.model,
      language: this.language,
      connected: this.connected,
      transcriptionCount: this.transcriptionCount,
    };
  }
}

module.exports = DeepgramTranscriber;
