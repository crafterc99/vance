/**
 * VANCE — Model Router
 *
 * Tiered model system for cost-efficient AI orchestration:
 *   Tier 1 (Haiku)  — DEFAULT for text conversation. Fast, cheap, handles everything
 *                      unless deep thinking is explicitly required.
 *   Tier 2 (Sonnet) — Escalation from Haiku for deep reasoning. Also used as
 *                      DEFAULT for voice conversations (better quality, more natural).
 *   Tier 3 (Claude Code) — Project implementation via start_coding_task (already exists).
 *                          Sonnet or Haiku can delegate here for actual code changes.
 *
 * Text conversations start with Haiku. Haiku can escalate to Sonnet.
 * Voice conversations start with Sonnet directly for natural, high-quality responses.
 */

const TIERS = {
  haiku: {
    model: 'claude-haiku-4-5-20251001',
    label: 'HAIKU',
    maxTokens: 4096,
  },
  sonnet: {
    model: 'claude-sonnet-4-6',
    label: 'SONNET',
    maxTokens: 8192,
  },
};

/**
 * Default tier for text chat — starts at Haiku
 */
function getDefaultTier() {
  return { tier: 'haiku', ...TIERS.haiku, reason: 'default — text conversations start at Haiku' };
}

/**
 * Default tier for voice conversations — starts at Sonnet 4.6
 * Voice mode uses Sonnet directly for more natural, expressive responses
 */
function getVoiceTier() {
  return { tier: 'sonnet', ...TIERS.sonnet, reason: 'voice mode — Sonnet 4.6 for natural conversation' };
}

/**
 * Convert OpenAI-format tools to Anthropic Messages API format.
 * OpenAI: { type: 'function', function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function convertToolsToAnthropic(openaiTools) {
  return openaiTools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
}

/**
 * Strip date suffix from model ID for cost lookup.
 * e.g. 'claude-haiku-4-5-20251001' → 'claude-haiku-4-5'
 */
function costModelName(model) {
  return model.replace(/-\d{8}$/, '');
}

module.exports = { TIERS, getDefaultTier, getVoiceTier, convertToolsToAnthropic, costModelName };
