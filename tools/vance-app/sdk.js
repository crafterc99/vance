/**
 * VANCE — Agent SDK ESM Bridge
 *
 * The @anthropic-ai/claude-agent-sdk is pure ESM. VANCE is CommonJS.
 * This module provides an async bridge: call getSDK() at runtime, not at import time.
 */
let _sdk = null;

async function getSDK() {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-agent-sdk');
  return _sdk;
}

module.exports = { getSDK };
