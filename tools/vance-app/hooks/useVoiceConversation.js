/**
 * VANCE — useVoiceConversation Hook
 *
 * Client-side interface for the voice conversation system.
 * Communicates with the Vance server over WebSocket to control
 * the voice pipeline (start/stop, state monitoring, configuration).
 *
 * This is a vanilla JS "hook" (not React) that manages voice state
 * and provides a clean API for the command center UI.
 *
 * Usage:
 *   const voice = createVoiceConversation(ws);
 *   voice.start();
 *   voice.on('state-change', ({ from, to }) => updateOrb(to));
 *   voice.on('transcription', ({ text }) => showUserSpeech(text));
 *   voice.on('response', ({ text }) => showVanceResponse(text));
 *   voice.stop();
 */

function createVoiceConversation(ws) {
  // State
  let state = 'idle'; // idle | listening | thinking | speaking
  const listeners = {};

  // Event system
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

  // Send WS message
  function send(action, data = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action, ...data }));
    }
  }

  // Handle incoming WS messages related to voice
  function handleMessage(msg) {
    switch (msg.type) {
      case 'voice-state':
        state = msg.state;
        emit('state-change', { from: msg.from, to: msg.state });
        break;

      case 'voice-started':
        state = 'listening';
        emit('started', msg);
        break;

      case 'voice-stopped':
        state = 'idle';
        emit('stopped', msg);
        break;

      case 'voice-transcription':
        emit('transcription', { text: msg.text, duration: msg.duration });
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

      case 'voice-backends':
        emit('backends', msg);
        break;

      case 'voice-status':
        state = msg.status.state;
        emit('status', msg.status);
        break;

      case 'voice-speech-start':
        emit('speech-start', {});
        break;
    }
  }

  // Public API
  return {
    on,
    off,
    handleMessage,

    /**
     * Start the voice conversation loop
     */
    start(config = {}) {
      send('voice-start', { config });
    },

    /**
     * Stop the voice conversation loop
     */
    stop() {
      send('voice-stop');
      state = 'idle';
      emit('state-change', { from: state, to: 'idle' });
    },

    /**
     * Mute the microphone (keep voice system active)
     */
    mute() {
      send('voice-mute');
    },

    /**
     * Unmute the microphone
     */
    unmute() {
      send('voice-unmute');
    },

    /**
     * Update voice configuration
     */
    configure(updates) {
      send('voice-configure', { config: updates });
    },

    /**
     * Get current voice system status
     */
    getStatus() {
      send('voice-status');
    },

    /**
     * Get current state
     */
    getState() {
      return state;
    },

    /**
     * Check if voice is active (not idle)
     */
    isActive() {
      return state !== 'idle';
    },
  };
}

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createVoiceConversation };
}
