/**
 * VANCE — Model Router
 *
 * Tiered model system for cost-efficient AI orchestration:
 *   Tier 1 (Haiku)  — DEFAULT for ALL conversation. Fast, cheap, handles everything
 *                      unless deep thinking is explicitly required.
 *   Tier 2 (Sonnet) — Escalation only: deep reasoning, multi-step planning,
 *                      complex debugging, architecture decisions, design interpretation.
 *                      Haiku decides when to escalate via the escalate_to_sonnet tool.
 *   Tier 3 (Claude Code) — Project implementation via start_coding_task (already exists).
 *                          Sonnet or Haiku can delegate here for actual code changes.
 *
 * ALL conversations start with Haiku. Haiku handles interaction, tool use,
 * memory, status, commands, and lightweight reasoning. Haiku can escalate
 * to Sonnet mid-conversation when it recognizes it needs deeper thinking.
 */

const TIERS = {
  haiku: {
    model: 'claude-haiku-4-5-20251001',
    label: 'HAIKU',
    maxTokens: 4096,
  },
  sonnet: {
    model: 'claude-sonnet-4-6-20250514',
    label: 'SONNET',
    maxTokens: 8192,
  },
};

/**
 * All requests start at Haiku. Haiku decides if escalation is needed
 * via the escalate_to_sonnet tool. No pre-routing classification needed.
 */
function getDefaultTier() {
  return { tier: 'haiku', ...TIERS.haiku, reason: 'default — all conversations start at Haiku' };
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

module.exports = { TIERS, getDefaultTier, convertToolsToAnthropic, costModelName };
