/**
 * VANCE — Voice System (v3 — Conversational)
 *
 * Full conversational voice system modeled after ChatGPT Advanced Voice Mode:
 *   - Always-on mic (stays listening until conversational dismissal)
 *   - Deepgram streaming STT for real-time word recognition
 *   - Backchannel detection (doesn't treat "mm-hmm" as a question)
 *   - Filler audio to mask latency ("Hmm, let me think...")
 *   - Natural dismissal ("thanks", "goodbye", "that's all")
 *   - Sonnet 4.6 brain for natural responses
 *   - Interruption support (cut Vance off mid-sentence)
 *
 * Pipeline:
 *   Mic → Deepgram STT (streaming) → Turn Manager → Sonnet 4.6 → TTS → Speaker
 *         ↑                            ↓
 *         └── always-on ←── dismissal detection
 *
 * States:
 *   idle      — voice system off, not listening
 *   listening — mic open, always-on, waiting for speech
 *   thinking  — processing user speech, generating response
 *   speaking  — playing TTS response, then returns to listening
 */
const { EventEmitter } = require('events');
const MicListener = require('./micListener');
const SpeechDetection = require('./speechDetection');
const WhisperTranscriber = require('./whisperTranscriber');
const DeepgramTranscriber = require('./deepgramTranscriber');
const ConversationHandler = require('./conversationHandler');
const TTSEngine = require('./ttsEngine');
const AudioPlayer = require('./audioPlayer');
const InterruptionController = require('./interruptionController');
const TurnManager = require('./turnManager');

class VoiceSystem extends EventEmitter {
  constructor(config = {}) {
    super();

    this.state = 'idle';
    this.mode = 'always-on'; // 'always-on' | 'push-to-talk'

    // Configuration
    this.config = {
      sampleRate: config.sampleRate || 16000,
      whisperModel: config.whisperModel || 'base',
      whisperLanguage: config.whisperLanguage || 'en',
      whisperBackend: config.whisperBackend || null,
      ttsBackend: config.ttsBackend || null,
      ttsVoice: config.ttsVoice || null,
      ttsSpeed: config.ttsSpeed || 1.0,
      interruptionSensitivity: config.interruptionSensitivity || 0.5,
      silenceTimeout: config.silenceTimeout || 800,
      energyThreshold: config.energyThreshold || 0.008,
      openaiKey: config.openaiKey || null,
      groqKey: config.groqKey || null,
      deepgramKey: config.deepgramKey || null,
      elevenLabsKey: config.elevenLabsKey || null,
      elevenLabsVoice: config.elevenLabsVoice || null,
      micDevice: config.micDevice || null,
      alwaysOn: config.alwaysOn !== false,
      fillerEnabled: config.fillerEnabled !== false,
      fillerDelay: config.fillerDelay || 800,
      ...config,
    };

    // Initialize mic
    this.mic = new MicListener({
      sampleRate: this.config.sampleRate,
      device: this.config.micDevice,
    });

    // VAD for energy-based speech detection (used with Whisper fallback)
    this.vad = new SpeechDetection({
      sampleRate: this.config.sampleRate,
      energyThreshold: this.config.energyThreshold,
      silenceTimeout: this.config.silenceTimeout,
    });

    // STT backends — Deepgram (streaming, preferred) or Whisper (batch, fallback)
    this.deepgram = new DeepgramTranscriber({
      deepgramKey: this.config.deepgramKey,
      language: this.config.whisperLanguage,
      sampleRate: this.config.sampleRate,
    });

    this.whisper = new WhisperTranscriber({
      modelSize: this.config.whisperModel,
      language: this.config.whisperLanguage,
      openaiKey: this.config.openaiKey,
      groqKey: this.config.groqKey,
      preferredBackend: this.config.whisperBackend,
      sampleRate: this.config.sampleRate,
    });

    this.sttMode = null; // 'deepgram' | 'whisper'

    // TTS
    this.tts = new TTSEngine({
      voice: this.config.ttsVoice,
      speed: this.config.ttsSpeed,
      preferredBackend: this.config.ttsBackend,
      openaiKey: this.config.openaiKey,
      elevenLabsKey: this.config.elevenLabsKey,
      elevenLabsVoice: this.config.elevenLabsVoice,
    });

    this.audioPlayer = new AudioPlayer();

    this.interruption = new InterruptionController({
      ttsEngine: this.tts,
      speechDetection: this.vad,
      micListener: this.mic,
    });

    // Turn manager — handles dismissal, backchannels, fillers
    this.turnManager = new TurnManager({
      alwaysOn: this.config.alwaysOn,
      fillerEnabled: this.config.fillerEnabled,
      fillerDelay: this.config.fillerDelay,
    });

    // Conversation handler (injected from server)
    this.conversationHandler = null;

    // Metrics
    this.metrics = {
      totalConversations: 0,
      avgTranscribeTime: 0,
      avgResponseTime: 0,
      dismissals: 0,
      backchannelsIgnored: 0,
      fillersPlayed: 0,
    };

    this._setupPipeline();
  }

  /**
   * Wire up the full conversational pipeline
   */
  _setupPipeline() {
    // ─── Deepgram streaming path ─────────────────────────────────────
    // Mic audio → Deepgram (streaming STT)
    this.mic.on('audio', (chunk) => {
      if (this.sttMode === 'deepgram') {
        this.deepgram.sendAudio(chunk);
      }
      // Always feed VAD for interruption detection during TTS
      this.vad.processChunk(chunk);
    });

    // Deepgram emits partial transcripts in real-time
    this.deepgram.on('partial', (data) => {
      this.emit('partial-transcript', { text: data.text });
    });

    // Deepgram emits final transcript when utterance ends
    this.deepgram.on('utterance-end', async (data) => {
      if (this.state !== 'listening' && this.state !== 'speaking') {
        if (this.state === 'thinking') return;
      }
      await this._handleTranscription(data.text, 'deepgram');
    });

    this.deepgram.on('speech-started', () => {
      if (this.state === 'listening') {
        this.emit('speech-start');
      }
    });

    // ─── Whisper fallback path ───────────────────────────────────────
    this.vad.on('speech-start', () => {
      if (this.state === 'listening' && this.sttMode === 'whisper') {
        this.emit('speech-start');
      }
    });

    this.vad.on('speech-audio', async (audioBuffer, meta) => {
      if (this.sttMode !== 'whisper') return;
      if (this.state !== 'listening' && this.state !== 'speaking') {
        if (this.state === 'thinking') return;
      }
      try {
        const startTime = Date.now();
        const transcript = await this.whisper.transcribe(audioBuffer);
        const transcribeTime = Date.now() - startTime;
        if (transcript && transcript.trim()) {
          await this._handleTranscription(transcript, 'whisper', transcribeTime);
        } else {
          // Empty transcript — stay listening
        }
      } catch (err) {
        this.emit('error', { component: 'whisper', error: err });
      }
    });

    // ─── Interruption handling ───────────────────────────────────────
    this.interruption.on('interrupted', () => {
      this.turnManager.cancelFillerTimer();
      this._setState('listening');
      this.emit('interrupted');
    });

    // ─── TTS events ─────────────────────────────────────────────────
    this.tts.on('speak-start', () => {
      this._setState('speaking');
    });

    this.tts.on('speak-end', () => {
      this.turnManager.markAISpeechEnd();
      if (this.state === 'speaking') {
        this._setState('listening');
      }
    });

    this.tts.on('speak-cancelled', () => {
      // Interrupted
    });

    // ─── Filler events ──────────────────────────────────────────────
    this.turnManager.on('filler', async ({ text }) => {
      if (this.state === 'thinking') {
        this.metrics.fillersPlayed++;
        this.emit('filler', { text });
        try {
          await this.tts.speak(text);
        } catch {}
        // After filler, we might already be speaking the real response
      }
    });

    // ─── Error forwarding ───────────────────────────────────────────
    this.mic.on('error', (err) => this.emit('error', { component: 'mic', error: err }));
    this.deepgram.on('error', (err) => this.emit('error', { component: 'deepgram', error: err }));
  }

  /**
   * Central transcription handler — classifies utterance and decides action
   */
  async _handleTranscription(text, source, transcribeTime = 0) {
    // Classify the utterance
    const classification = this.turnManager.classifyUtterance(text);

    this.emit('transcription', {
      text,
      source,
      transcribeTime,
      classification: classification.type,
      action: classification.action,
    });

    switch (classification.action) {
      case 'end_session':
        // User said goodbye — respond warmly and stop
        this.metrics.dismissals++;
        this.emit('dismissal', { text, response: this.turnManager.getDismissalResponse() });
        const goodbyeText = this.turnManager.getDismissalResponse();
        this._setState('speaking');
        try {
          await this.tts.speak(goodbyeText);
        } catch {}
        this.stop();
        return;

      case 'ignore':
        // Backchannel right after AI speech — just ignore it
        this.metrics.backchannelsIgnored++;
        this.emit('backchannel', { text });
        return;

      case 'acknowledge':
        // Standalone backchannel — brief acknowledgment if appropriate
        this.metrics.backchannelsIgnored++;
        this.emit('backchannel', { text });
        return;

      case 'respond':
        // Real question/statement — process through brain
        await this._processUtterance(text, transcribeTime);
        return;
    }
  }

  /**
   * Process a real utterance through the Vance brain
   */
  async _processUtterance(transcript, transcribeTime = 0) {
    this._setState('thinking');

    // Start filler timer — will play thinking audio if response is slow
    const cancelToken = { cancelled: false };
    this.turnManager.startFillerTimer(cancelToken);

    try {
      if (!this.conversationHandler) {
        this.emit('error', { component: 'conversation', error: new Error('No conversation handler set') });
        this._setState('listening');
        return;
      }

      // Collect response text for streaming TTS
      let fullResponse = '';
      let sentenceBuffer = '';
      const sentences = [];
      let firstTokenReceived = false;

      const onToken = (token) => {
        if (!firstTokenReceived) {
          firstTokenReceived = true;
          // Cancel filler timer — real response is coming
          cancelToken.cancelled = true;
          this.turnManager.cancelFillerTimer();
        }

        fullResponse += token;
        sentenceBuffer += token;

        const sentenceEnd = sentenceBuffer.match(/[.!?]\s/);
        if (sentenceEnd) {
          const idx = sentenceEnd.index + 1;
          const sentence = sentenceBuffer.slice(0, idx).trim();
          sentenceBuffer = sentenceBuffer.slice(idx);
          if (sentence) {
            sentences.push(sentence);
            if (sentences.length === 1 && this.state === 'thinking') {
              this._startStreamingSpeech(sentences);
            }
          }
        }
      };

      const responseStart = Date.now();
      const response = await this.conversationHandler.processVoiceInput(
        transcript,
        null,
        onToken
      );
      const responseTime = Date.now() - responseStart;

      // Handle remaining text
      if (sentenceBuffer.trim()) {
        sentences.push(sentenceBuffer.trim());
      }

      this.emit('response', {
        text: response || fullResponse,
        responseTime,
        totalLatency: transcribeTime + responseTime,
        brainModel: 'sonnet-4.6',
      });

      // Update metrics
      this.metrics.totalConversations++;
      const n = this.metrics.totalConversations;
      this.metrics.avgTranscribeTime = (this.metrics.avgTranscribeTime * (n - 1) + transcribeTime) / n;
      this.metrics.avgResponseTime = (this.metrics.avgResponseTime * (n - 1) + responseTime) / n;

      // If we haven't started speaking yet (short response), speak now
      if (this.state === 'thinking' && (response || fullResponse)) {
        cancelToken.cancelled = true;
        this.turnManager.cancelFillerTimer();
        this._setState('speaking');
        await this.tts.speak(response || fullResponse);
        if (this.state === 'speaking') {
          this._setState('listening');
        }
      }

    } catch (err) {
      cancelToken.cancelled = true;
      this.turnManager.cancelFillerTimer();
      this.emit('error', { component: 'pipeline', error: err });
      this._setState('listening');
    }
  }

  /**
   * Stream sentences to TTS as they arrive
   */
  async _startStreamingSpeech(sentences) {
    this._setState('speaking');

    let i = 0;
    while (i < sentences.length && this.state === 'speaking') {
      await this.tts.speak(sentences[i]);
      i++;
    }

    if (this.state === 'speaking') {
      this._setState('listening');
    }
  }

  /**
   * Set the conversation handler (called from server)
   */
  setConversationHandler(handler) {
    this.conversationHandler = handler;
  }

  /**
   * Start the voice system (always-on mode)
   */
  async start() {
    // Detect STT backend: prefer Deepgram (streaming) → Whisper (batch)
    if (this.deepgram.isAvailable()) {
      try {
        await this.deepgram.start();
        this.sttMode = 'deepgram';
      } catch (err) {
        this.emit('error', { component: 'deepgram', error: err });
        // Fall back to Whisper
        this.sttMode = this.whisper.detect() ? 'whisper' : null;
      }
    } else {
      this.sttMode = this.whisper.detect() ? 'whisper' : null;
    }

    if (!this.sttMode) {
      this.emit('error', {
        component: 'transcriber',
        error: new Error(
          'No speech recognition backend available.\n' +
          'For best results: set DEEPGRAM_API_KEY (streaming, real-time)\n' +
          'Alternatives: whisper.cpp (local), GROQ_API_KEY (fast cloud), OPENAI_API_KEY'
        ),
      });
      return false;
    }

    // Detect TTS backend
    const ttsBackend = this.tts.detect();
    if (!ttsBackend) {
      this.emit('error', { component: 'tts', error: new Error('No TTS backend available.') });
      return false;
    }

    this.emit('backends-detected', {
      stt: this.sttMode === 'deepgram' ? this.deepgram.getInfo() : this.whisper.getInfo(),
      tts: this.tts.getInfo(),
      mode: this.config.alwaysOn ? 'always-on' : 'push-to-talk',
    });

    // Start mic + monitoring
    this.mic.start();
    this.interruption.startMonitoring();
    this.interruption.setSensitivity(this.config.interruptionSensitivity);

    this.turnManager.conversationActive = true;
    this._setState('listening');

    this.emit('started', {
      stt: this.sttMode,
      tts: ttsBackend,
      brain: 'sonnet-4.6',
      mode: this.config.alwaysOn ? 'always-on' : 'push-to-talk',
      config: this.config,
    });

    return true;
  }

  /**
   * Stop the voice system
   */
  stop() {
    this.turnManager.cancelFillerTimer();
    this.turnManager.conversationActive = false;
    this.tts.cancel();
    this.mic.stop();
    if (this.sttMode === 'deepgram') {
      this.deepgram.stop();
    }
    this.interruption.stopMonitoring();
    this.vad.reset();
    this.turnManager.reset();
    this._setState('idle');
    this.emit('stopped');
  }

  mute() {
    this.mic.pause();
    this.emit('muted');
  }

  unmute() {
    this.mic.resume();
    this.emit('unmuted');
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(updates) {
    Object.assign(this.config, updates);

    if (updates.energyThreshold !== undefined) {
      this.vad.setSensitivity(updates.energyThreshold);
    }
    if (updates.silenceTimeout !== undefined) {
      this.vad.silenceTimeout = updates.silenceTimeout;
    }
    if (updates.interruptionSensitivity !== undefined) {
      this.interruption.setSensitivity(updates.interruptionSensitivity);
    }
    if (updates.ttsSpeed !== undefined) {
      this.tts.speed = updates.ttsSpeed;
    }
    if (updates.ttsVoice !== undefined) {
      this.tts.voice = updates.ttsVoice;
    }
    if (updates.fillerEnabled !== undefined) {
      this.turnManager.fillerEnabled = updates.fillerEnabled;
    }
    if (updates.fillerDelay !== undefined) {
      this.turnManager.fillerDelay = updates.fillerDelay;
    }
  }

  /**
   * Get current system status
   */
  getStatus() {
    const safeConfig = { ...this.config };
    if (safeConfig.openaiKey) safeConfig.openaiKey = '***set***';
    if (safeConfig.groqKey) safeConfig.groqKey = '***set***';
    if (safeConfig.deepgramKey) safeConfig.deepgramKey = '***set***';
    if (safeConfig.elevenLabsKey) safeConfig.elevenLabsKey = '***set***';
    return {
      state: this.state,
      mode: this.config.alwaysOn ? 'always-on' : 'push-to-talk',
      brain: 'sonnet-4.6',
      mic: {
        active: this.mic.isActive(),
        backend: this.mic.backend,
      },
      stt: this.sttMode === 'deepgram'
        ? { ...this.deepgram.getInfo(), type: 'streaming' }
        : { ...this.whisper.getInfo(), type: 'batch' },
      tts: this.tts.getInfo(),
      turnManager: {
        alwaysOn: this.turnManager.alwaysOn,
        fillerEnabled: this.turnManager.fillerEnabled,
        turnCount: this.turnManager.turnCount,
      },
      metrics: this.metrics,
      config: safeConfig,
    };
  }

  _setState(newState) {
    const prev = this.state;
    this.state = newState;
    if (prev !== newState) {
      this.emit('state-change', { from: prev, to: newState });
    }
  }
}

module.exports = VoiceSystem;
