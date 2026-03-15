/**
 * VANCE — Voice Conversation Handler
 *
 * Routes voice transcriptions through the Vance brain (Haiku for conversation,
 * escalate to Sonnet for complex reasoning). Integrates with the existing
 * handleChat pipeline but optimized for voice:
 *   - Shorter, more natural responses
 *   - Voice-specific system prompt additions
 *   - Streaming text output for low-latency TTS
 */

class ConversationHandler {
  constructor({ handleChat, buildChatContext, buildSystemPromptForChat, loadConversation, saveConversation }) {
    this.handleChat = handleChat;
    this.buildChatContext = buildChatContext;
    this.buildSystemPromptForChat = buildSystemPromptForChat;
    this.loadConversation = loadConversation;
    this.saveConversation = saveConversation;
    this.voiceConvId = 'voice';
  }

  /**
   * Voice-specific system prompt addition.
   * Appended to the normal brain system prompt to guide voice-appropriate responses.
   */
  static VOICE_PROMPT_ADDITION = `

## VOICE MODE ACTIVE

You are speaking aloud to the user through a voice interface. Follow these rules strictly:

1. **Be conversational** — respond as if you're having a natural spoken conversation. No markdown, no bullet points, no code blocks, no formatting.
2. **Be concise** — keep responses to 2-4 sentences unless the user asks for detail. Aim for 15-30 seconds of speech.
3. **Sound natural** — avoid robotic phrases like "processing request", "certainly", "I'd be happy to". Talk like a calm, knowledgeable human friend.
4. **No visual formatting** — no asterisks, no headers, no lists. Everything must sound natural when read aloud.
5. **Use contractions** — say "I'll", "you're", "that's", "won't" etc.
6. **Acknowledge naturally** — instead of "Understood", say something like "Got it" or "Yeah" or just dive into the answer.
7. **When listing things** — use "first... second... third..." or "the main ones are..." instead of bullet points.
8. **Prioritize actionable information** — lead with what matters most.
`;

  /**
   * Process a voice transcription and return the response text.
   *
   * @param {string} transcript - The user's transcribed speech
   * @param {string} projectId - Optional project context
   * @param {function} onToken - Callback for streaming tokens (for low-latency TTS)
   * @returns {Promise<string>} The full response text
   */
  async processVoiceInput(transcript, projectId, onToken) {
    if (!transcript || !transcript.trim()) {
      return null;
    }

    const cleanTranscript = transcript.trim();

    // Collect the full response
    let fullResponse = '';
    let firstTokenTime = null;

    const wsSend = (data) => {
      if (data.type === 'stream-token') {
        if (!firstTokenTime) firstTokenTime = Date.now();
        fullResponse += data.content;
        if (onToken) onToken(data.content);
      }
      // We capture stream-end to know when done, but don't need to forward most events
    };

    try {
      const result = await this.handleChat(cleanTranscript, projectId, wsSend);
      return result || fullResponse;
    } catch (err) {
      return `Sorry, I hit an issue. ${err.message}`;
    }
  }

  /**
   * Get a quick acknowledgment while processing (for perceived responsiveness).
   * Returns a brief phrase Vance says immediately while thinking.
   */
  static getThinkingPhrase() {
    const phrases = [
      'Let me check on that.',
      'One sec.',
      'Looking into it.',
      'Give me a moment.',
      'On it.',
      'Checking now.',
    ];
    return phrases[Math.floor(Math.random() * phrases.length)];
  }
}

module.exports = ConversationHandler;
