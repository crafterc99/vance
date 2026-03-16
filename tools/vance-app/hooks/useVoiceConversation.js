/**
 * VANCE — useVoiceConversation Hook (v2 — Conversational)
 *
 * Client-side interface for the always-on voice conversation system.
 * Communicates with the Vance server over WebSocket.
 *
 * New in v2:
 *   - Always-on mode (mic stays on until dismissed)
 *   - Partial transcript display (real-time as user speaks)
 *   - Dismissal events (user says "thanks", "goodbye")
 *   - Backchannel detection (ignores "mm-hmm", "yeah")
 *   - Filler events (Vance thinking aloud)
 *
 * Usage:
 *   const voice = createVoiceConversation(ws);
 *   voice.start();  // starts always-on listening
 *   voice.on('partial-transcript', ({ text }) => showPartial(text));
 *   voice.on('transcription', ({ text }) => showFinal(text));
 *   voice.on('response', ({ text }) => showResponse(text));
 *   voice.on('dismissal', () => showGoodbye());
 *   // voice stops automatically on dismissal, or manually:
 *   voice.stop();
 */

function createVoiceConversation(ws) {
  let state = 'idle';
  let mode = 'always-on';
  const listeners = {};

  function on(event, handler) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(handler);
  }

  function off(event, handler) {
    if (listeners[event]) {
      listeners[event] = listeners[event].filter(h => h !== handler);
    }
  }

  function emit(event, data) {
    if (listeners[event]) {
      for (const handler of listeners[event]) {
        try { handler(data); } catch (e) { console.error('Voice event handler error:', e); }
      }
    }
  }

  function send(action, data = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action, ...data }));
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'voice-state':
        state = msg.state;
        emit('state-change', { from: msg.from, to: msg.state });
        break;

      case 'voice-started':
        state = 'listening';
        mode = msg.mode || 'always-on';
        emit('started', msg);
        break;

      case 'voice-stopped':
        state = 'idle';
        emit('stopped', msg);
        break;

      case 'voice-transcription':
        emit('transcription', {
          text: msg.text,
          duration: msg.duration,
          classification: msg.classification,
          source: msg.source,
        });
        break;

      case 'voice-partial':
        emit('partial-transcript', { text: msg.text });
        break;

      case 'voice-response':
        emit('response', { text: msg.text, latency: msg.latency });
        break;

      case 'voice-error':
        emit('error', { component: msg.component, message: msg.message });
        break;

      case 'voice-interrupted':
        emit('interrupted', {});
        break;

      case 'voice-dismissal':
        emit('dismissal', { text: msg.text, response: msg.response });
        // State will transition to idle via voice-stopped
        break;

      case 'voice-backchannel':
        emit('backchannel', { text: msg.text });
        break;

      case 'voice-filler':
        emit('filler', { text: msg.text });
        break;

      case 'voice-backends':
        emit('backends', msg);
        break;

      case 'voice-status':
        state = msg.status.state;
        mode = msg.status.mode || 'always-on';
        emit('status', msg.status);
        break;

      case 'voice-speech-start':
        emit('speech-start', {});
        break;
    }
  }

  return {
    on,
    off,
    handleMessage,

    /**
     * Start always-on voice conversation
     */
    start(config = {}) {
      send('voice-start', { config });
    },

    /**
     * Stop voice (or say "goodbye" to stop naturally)
     */
    stop() {
      send('voice-stop');
      state = 'idle';
      emit('state-change', { from: state, to: 'idle' });
    },

    mute() { send('voice-mute'); },
    unmute() { send('voice-unmute'); },

    configure(updates) {
      send('voice-configure', { config: updates });
    },

    getStatus() { send('voice-status'); },
    getState() { return state; },
    getMode() { return mode; },
    isActive() { return state !== 'idle'; },
    isListening() { return state === 'listening'; },
    isSpeaking() { return state === 'speaking'; },
    isThinking() { return state === 'thinking'; },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createVoiceConversation };
}
