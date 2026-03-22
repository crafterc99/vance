/**
 * BLAIR — Conversational Turn Manager
 *
 * Manages the conversational flow for always-on voice mode:
 *   - Dismissal detection: "thanks", "goodbye", "that's all" → end session
 *   - Backchannel detection: "mm-hmm", "uh-huh", "yeah" → not a turn
 *   - Filler generation: "Hmm...", "Let me think..." → mask latency
 *   - Turn completion prediction: is the user done talking?
 *
 * This makes Blair feel like a natural conversation partner, not a
 * push-to-talk command interface.
 */
const { EventEmitter } = require('events');

// Phrases that signal the user wants to end the voice session
const DISMISSAL_PHRASES = [
  // Direct goodbye
  /\b(goodbye|good\s*bye|bye\s*bye|bye)\b/i,
  /\b(see\s*you|see\s*ya|later|talk\s*later|talk\s*to\s*you\s*later)\b/i,
  /\b(good\s*night|goodnight|night)\b/i,

  // Gratitude-based endings
  /^(thanks blair)\.?$/i,
  /\bthat'?s?\s*(all|it|everything)\b/i,
  /\bi'?m?\s*(good|done|all\s*set|all\s*good)\b.*\.?$/i,

  // Dismissal commands
  /\b(stop\s*listening|stop\s*voice|turn\s*off|shut\s*up|mute)\b/i,
  /\b(go\s*to\s*sleep|go\s*away|leave\s*me)\b/i,
  /\b(end\s*(the\s*)?(call|conversation|session|chat))\b/i,
  /\b(you\s*can\s*go|dismiss(ed)?)\b/i,
];

// Short utterances that are backchannels (acknowledgments, not questions)
const BACKCHANNEL_PHRASES = [
  /^(mm+[- ]?h[mu]+|uh[- ]?huh|hm+|hmm+)\.?$/i,
  /^(yeah|yep|yup|ya|yah)\.?$/i,
  /^(ok(ay)?|k|alright|right|sure)\.?$/i,
  /^(got\s*it|I\s*see|makes\s*sense)\.?$/i,
  /^(oh|ah|huh|wow|cool|nice|neat|great|interesting)\.?$/i,
  /^(go\s*on|continue|keep\s*going|and(\s*then)?)\.?$/i,
  /^(uh|um|so|well)\.?$/i,
];

// Thinking fillers that Blair speaks while the LLM is processing
const THINKING_FILLERS = [
  { text: 'Hmm, let me think about that.', weight: 3 },
  { text: 'One sec.', weight: 2 },
  { text: 'Let me check on that.', weight: 2 },
  { text: 'Give me a moment.', weight: 1 },
  { text: 'Good question.', weight: 2 },
  { text: 'Alright, looking into it.', weight: 1 },
  { text: 'So...', weight: 1 },
  { text: 'Well...', weight: 2 },
];

// Quick acknowledgments before processing
const QUICK_ACKS = [
  'Got it.',
  'On it.',
  'Sure.',
  'Alright.',
  'Okay.',
  'Yeah.',
  'Right.',
];

class TurnManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.alwaysOn = config.alwaysOn !== false; // default: true
    this.fillerEnabled = config.fillerEnabled !== false;
    this.fillerDelay = config.fillerDelay || 800; // ms before playing filler
    this.backchannelWindow = config.backchannelWindow || 1500; // ms after AI speech to detect backchannels
    this.lastAISpeechEnd = 0;
    this.conversationActive = false;
    this.turnCount = 0;
    this._fillerTimer = null;
    this._lastFillerIndex = -1;
  }

  /**
   * Check if a transcription is a dismissal phrase (end conversation)
   */
  isDismissal(text) {
    if (!text) return false;
    const cleaned = text.trim().replace(/[.,!?]+$/, '').trim();

    for (const pattern of DISMISSAL_PHRASES) {
      if (pattern.test(cleaned)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a transcription is a backchannel (not a real turn)
   */
  isBackchannel(text) {
    if (!text) return false;
    const cleaned = text.trim().replace(/[.,!?]+$/, '').trim();

    // Only treat as backchannel if it's short (< 5 words)
    if (cleaned.split(/\s+/).length > 4) return false;

    for (const pattern of BACKCHANNEL_PHRASES) {
      if (pattern.test(cleaned)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if backchannel was said shortly after AI finished speaking
   * (strong signal it's just acknowledgment, not a new question)
   */
  isPostSpeechBackchannel(text) {
    const timeSinceAISpeech = Date.now() - this.lastAISpeechEnd;
    return timeSinceAISpeech < this.backchannelWindow && this.isBackchannel(text);
  }

  /**
   * Classify an utterance and decide what to do with it.
   * Returns: { type, text, action }
   *   type: 'dismissal' | 'backchannel' | 'question' | 'command' | 'statement'
   *   action: 'end_session' | 'ignore' | 'respond' | 'acknowledge'
   */
  classifyUtterance(text) {
    if (!text || !text.trim()) {
      return { type: 'empty', text: '', action: 'ignore' };
    }

    const cleaned = text.trim();

    // Check dismissal first
    if (this.isDismissal(cleaned)) {
      return { type: 'dismissal', text: cleaned, action: 'end_session' };
    }

    // Check backchannel (especially right after AI finishes talking)
    if (this.isPostSpeechBackchannel(cleaned)) {
      return { type: 'backchannel', text: cleaned, action: 'ignore' };
    }

    // Even without post-speech context, very short backchannels on their own
    if (this.isBackchannel(cleaned) && cleaned.split(/\s+/).length <= 2) {
      return { type: 'backchannel', text: cleaned, action: 'acknowledge' };
    }

    // Is it a question?
    if (cleaned.endsWith('?') || /^(what|who|where|when|why|how|is|are|do|does|can|could|would|will|should|did)\b/i.test(cleaned)) {
      return { type: 'question', text: cleaned, action: 'respond' };
    }

    // Default: treat as a statement/command that needs a response
    this.turnCount++;
    return { type: 'statement', text: cleaned, action: 'respond' };
  }

  /**
   * Record when AI finishes speaking (for backchannel timing)
   */
  markAISpeechEnd() {
    this.lastAISpeechEnd = Date.now();
  }

  /**
   * Get a random thinking filler phrase
   */
  getThinkingFiller() {
    if (!this.fillerEnabled) return null;

    // Weighted random selection
    const totalWeight = THINKING_FILLERS.reduce((sum, f) => sum + f.weight, 0);
    let random = Math.random() * totalWeight;
    for (let i = 0; i < THINKING_FILLERS.length; i++) {
      random -= THINKING_FILLERS[i].weight;
      if (random <= 0) {
        // Avoid repeating the same filler back-to-back
        if (i === this._lastFillerIndex && THINKING_FILLERS.length > 1) {
          i = (i + 1) % THINKING_FILLERS.length;
        }
        this._lastFillerIndex = i;
        return THINKING_FILLERS[i].text;
      }
    }
    return THINKING_FILLERS[0].text;
  }

  /**
   * Get a quick acknowledgment
   */
  getQuickAck() {
    return QUICK_ACKS[Math.floor(Math.random() * QUICK_ACKS.length)];
  }

  /**
   * Get a natural goodbye response
   */
  getDismissalResponse() {
    const responses = [
      "Talk to you later.",
      "Catch you later.",
      "I'll be here when you need me.",
      "Later!",
      "Alright, I'll be around.",
      "Peace.",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  /**
   * Start a filler timer — if response hasn't started after fillerDelay ms,
   * emit a filler phrase event for TTS to speak
   */
  startFillerTimer(cancelToken) {
    this.cancelFillerTimer();
    if (!this.fillerEnabled) return;

    this._fillerTimer = setTimeout(() => {
      if (cancelToken && cancelToken.cancelled) return;
      const filler = this.getThinkingFiller();
      if (filler) {
        this.emit('filler', { text: filler });
      }
    }, this.fillerDelay);
  }

  /**
   * Cancel the filler timer (response started before filler was needed)
   */
  cancelFillerTimer() {
    if (this._fillerTimer) {
      clearTimeout(this._fillerTimer);
      this._fillerTimer = null;
    }
  }

  /**
   * Reset conversation state
   */
  reset() {
    this.turnCount = 0;
    this.lastAISpeechEnd = 0;
    this.cancelFillerTimer();
  }
}

module.exports = TurnManager;
