/**
 * BLAIR — Voice Conversation Handler (v2 — Conversational)
 *
 * Routes voice transcriptions through the Blair brain (Sonnet 4.6 for voice).
 * Optimized for natural spoken conversation:
 *   - Concise, warm, human-sounding responses
 *   - Streaming text output for low-latency TTS
 *   - Context-aware conversational style
 *   - No markdown, no formatting — pure speech
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
   * Modeled after ChatGPT Advanced Voice Mode's conversational style.
   */
  static VOICE_PROMPT_ADDITION = `

## VOICE MODE — ALWAYS-ON CONVERSATION

You're in a live voice conversation. The mic is always on. This is like talking to a friend — not giving a presentation.

### How to speak:
- **Talk, don't write.** No markdown, no bullets, no code blocks, no asterisks, no headers. Everything you say will be read aloud by a TTS engine.
- **Be brief.** 1-3 sentences is ideal. Only go longer if the user asks you to explain in detail. Think 10-20 seconds of speech max.
- **Sound human.** Use contractions (I'll, you're, that's, won't, can't). Start sentences with "So", "Yeah", "Well", "Actually" sometimes. Vary your sentence length.
- **Lead with the answer.** Don't build up to it. Say the answer first, then explain if needed.
- **Match their energy.** If they're casual, be casual. If they're focused, be direct. If they're excited, match it.

### What NOT to do:
- Don't say "Certainly!", "I'd be happy to!", "Absolutely!", "Great question!" — these sound robotic.
- Don't repeat back what they said ("You asked about...") — just answer.
- Don't give disclaimers unless safety-critical.
- Don't list things with numbers or bullets. Use "first... then... and also..." naturally.
- Don't say "Is there anything else?" — the conversation is always on, they'll just keep talking.
- Don't use colons, semicolons, or em dashes — they sound weird when read aloud.

### Conversation flow:
- If they say something short like "yeah" or "okay" after your response, they're just acknowledging. Don't respond to that.
- If there's a natural pause in conversation, don't fill it. Just wait.
- If you need to do something that takes time, say so briefly: "Looking that up now" or "Give me a sec."
- When you finish a thought, just stop. Don't add filler at the end.
`;

  /**
   * Process a voice transcription and return the response text.
   */
  async processVoiceInput(transcript, projectId, onToken) {
    if (!transcript || !transcript.trim()) {
      return null;
    }

    const cleanTranscript = transcript.trim();

    let fullResponse = '';
    let firstTokenTime = null;

    const wsSend = (data) => {
      if (data.type === 'stream-token') {
        if (!firstTokenTime) firstTokenTime = Date.now();
        fullResponse += data.content;
        if (onToken) onToken(data.content);
      }
    };

    try {
      const result = await this.handleChat(cleanTranscript, projectId, wsSend);
      return result || fullResponse;
    } catch (err) {
      return `Sorry, I ran into an issue. ${err.message}`;
    }
  }
}

module.exports = ConversationHandler;
