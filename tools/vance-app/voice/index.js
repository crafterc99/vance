/**
 * VANCE — Voice System (v2 — Upgraded)
 *
 * Main orchestrator for the conversational voice pipeline:
 *   Mic → VAD → Whisper STT → Vance Brain (Sonnet 4.6) → TTS → Audio Playback
 *
 * Upgraded:
 *   - Groq Whisper support (ultra-fast cloud STT)
 *   - ElevenLabs TTS support (highest quality)
 *   - Sonnet 4.6 as default voice brain (natural conversation)
 *   - Noise/hallucination filtering in transcription
 *   - Configurable backend preferences
 *   - Better status reporting with latency metrics
 *
 * States:
 *   idle      — voice system initialized but not active
 *   listening — mic open, waiting for speech
 *   thinking  — processing user speech, generating response
 *   speaking  — playing TTS response
 */
const { EventEmitter } = require('events');
const MicListener = require('./micListener');
const SpeechDetection = require('./speechDetection');
const WhisperTranscriber = require('./whisperTranscriber');
const ConversationHandler = require('./conversationHandler');
const TTSEngine = require('./ttsEngine');
const AudioPlayer = require('./audioPlayer');
const InterruptionController = require('./interruptionController');

class VoiceSystem extends EventEmitter {
  constructor(config = {}) {
    super();

    this.state = 'idle'; // idle | listening | thinking | speaking

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
      elevenLabsKey: config.elevenLabsKey || null,
      elevenLabsVoice: config.elevenLabsVoice || null,
      micDevice: config.micDevice || null,
      ...config,
    };

    // Initialize components with new backend options
    this.mic = new MicListener({
      sampleRate: this.config.sampleRate,
      device: this.config.micDevice,
    });

    this.vad = new SpeechDetection({
      sampleRate: this.config.sampleRate,
      energyThreshold: this.config.energyThreshold,
      silenceTimeout: this.config.silenceTimeout,
    });

    this.transcriber = new WhisperTranscriber({
      modelSize: this.config.whisperModel,
      language: this.config.whisperLanguage,
      openaiKey: this.config.openaiKey,
      groqKey: this.config.groqKey,
      preferredBackend: this.config.whisperBackend,
      sampleRate: this.config.sampleRate,
    });

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

    // Conversation handler (injected from server)
    this.conversationHandler = null;

    // Latency tracking
    this.metrics = {
      totalConversations: 0,
      avgTranscribeTime: 0,
      avgResponseTime: 0,
      avgTTSTime: 0,
    };

    // Bind event pipeline
    this._setupPipeline();
  }

  /**
   * Wire up the audio → detection → transcription → response → speech pipeline
   */
  _setupPipeline() {
    // Mic audio → VAD
    this.mic.on('audio', (chunk) => {
      this.vad.processChunk(chunk);
    });

    // VAD speech start → update state
    this.vad.on('speech-start', () => {
      if (this.state === 'listening') {
        this.emit('speech-start');
      }
    });

    // VAD speech end with audio → transcribe
    this.vad.on('speech-audio', async (audioBuffer, meta) => {
      if (this.state !== 'listening' && this.state !== 'speaking') {
        if (this.state === 'thinking') return;
      }
      await this._handleSpeechAudio(audioBuffer, meta);
    });

    // Interruption handling
    this.interruption.on('interrupted', () => {
      this._setState('listening');
      this.emit('interrupted');
    });

    // TTS events
    this.tts.on('speak-start', () => {
      this._setState('speaking');
    });

    this.tts.on('speak-end', () => {
      if (this.state === 'speaking') {
        this._setState('listening');
      }
    });

    this.tts.on('speak-cancelled', () => {
      // Interrupted — already handled by interruption controller
    });

    // Error forwarding
    this.mic.on('error', (err) => this.emit('error', { component: 'mic', error: err }));
    this.transcriber.on?.('error', (err) => this.emit('error', { component: 'transcriber', error: err }));
  }

  /**
   * Process speech audio through the pipeline
   */
  async _handleSpeechAudio(audioBuffer, meta) {
    this._setState('thinking');

    try {
      // 1. Transcribe
      const startTime = Date.now();
      const transcript = await this.transcriber.transcribe(audioBuffer);
      const transcribeTime = Date.now() - startTime;

      this.emit('transcription', {
        text: transcript,
        duration: meta.duration,
        transcribeTime,
        sttBackend: this.transcriber.backend,
      });

      if (!transcript || !transcript.trim()) {
        this._setState('listening');
        return;
      }

      // 2. Get response from Vance brain (Sonnet 4.6)
      if (!this.conversationHandler) {
        this.emit('error', { component: 'conversation', error: new Error('No conversation handler set') });
        this._setState('listening');
        return;
      }

      // Collect response text, building sentences for streaming TTS
      let fullResponse = '';
      let sentenceBuffer = '';
      const sentences = [];

      const onToken = (token) => {
        fullResponse += token;
        sentenceBuffer += token;

        // Check if we have a complete sentence
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
        null, // projectId
        onToken
      );
      const responseTime = Date.now() - responseStart;

      // Handle any remaining text in the buffer
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
      this.metrics.avgTranscribeTime = (this.metrics.avgTranscribeTime * (this.metrics.totalConversations - 1) + transcribeTime) / this.metrics.totalConversations;
      this.metrics.avgResponseTime = (this.metrics.avgResponseTime * (this.metrics.totalConversations - 1) + responseTime) / this.metrics.totalConversations;

      // If we haven't started speaking yet (short response), speak now
      if (this.state === 'thinking' && (response || fullResponse)) {
        const textToSpeak = response || fullResponse;
        this._setState('speaking');
        await this.tts.speak(textToSpeak);
        if (this.state === 'speaking') {
          this._setState('listening');
        }
      }

    } catch (err) {
      this.emit('error', { component: 'pipeline', error: err });
      this._setState('listening');
    }
  }

  /**
   * Start speaking sentences as they arrive (streaming TTS)
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
   * Set the conversation handler (called from server integration)
   */
  setConversationHandler(handler) {
    this.conversationHandler = handler;
  }

  /**
   * Start the voice conversation loop
   */
  async start() {
    // Detect backends
    const sttBackend = this.transcriber.detect();
    const ttsBackend = this.tts.detect();

    this.emit('backends-detected', {
      stt: this.transcriber.getInfo(),
      tts: this.tts.getInfo(),
    });

    if (!sttBackend) {
      this.emit('error', {
        component: 'transcriber',
        error: new Error(
          'No speech recognition backend available.\n' +
          'Options: whisper.cpp (brew install whisper-cpp), Groq API (GROQ_API_KEY), or OpenAI API (OPENAI_API_KEY)'
        ),
      });
      return false;
    }

    if (!ttsBackend) {
      this.emit('error', {
        component: 'tts',
        error: new Error('No TTS backend available.'),
      });
      return false;
    }

    // Start mic + VAD + interruption monitoring
    this.mic.start();
    this.interruption.startMonitoring();
    this.interruption.setSensitivity(this.config.interruptionSensitivity);

    this._setState('listening');
    this.emit('started', {
      stt: sttBackend,
      tts: ttsBackend,
      brain: 'sonnet-4.6',
      config: this.config,
    });

    return true;
  }

  /**
   * Stop the voice conversation loop
   */
  stop() {
    this.tts.cancel();
    this.mic.stop();
    this.interruption.stopMonitoring();
    this.vad.reset();
    this._setState('idle');
    this.emit('stopped');
  }

  /**
   * Mute (pause listening but keep system active)
   */
  mute() {
    this.mic.pause();
    this.emit('muted');
  }

  /**
   * Unmute
   */
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
  }

  /**
   * Get current system status
   */
  getStatus() {
    const safeConfig = { ...this.config };
    if (safeConfig.openaiKey) safeConfig.openaiKey = '***set***';
    if (safeConfig.groqKey) safeConfig.groqKey = '***set***';
    if (safeConfig.elevenLabsKey) safeConfig.elevenLabsKey = '***set***';
    return {
      state: this.state,
      brain: 'sonnet-4.6',
      mic: {
        active: this.mic.isActive(),
        backend: this.mic.backend,
      },
      stt: this.transcriber.getInfo(),
      tts: this.tts.getInfo(),
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
