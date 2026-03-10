/**
 * VANCE — API Cost Tracker
 *
 * Tracks every API call across all components:
 * - OpenAI GPT (conversation brain)
 * - Claude Code (coding tasks)
 * - Gemini (sprite generation)
 * - Speech APIs
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../../.vance-data');
const COSTS_FILE = path.join(DATA_DIR, 'costs.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Pricing per 1K tokens (approximate, March 2026)
const PRICING = {
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'claude-opus-4-6': { input: 0.015, output: 0.075 },
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
  'claude-haiku-4-5': { input: 0.0008, output: 0.004 },
  'gemini-2.5-flash-image': { input: 0.0001, output: 0.0004 },
  'gemini-3-pro-image-preview': { input: 0.00125, output: 0.005 },
  'whisper-1': { perMinute: 0.006 },
  'tts-1': { perChar: 0.000015 },
  'tts-1-hd': { perChar: 0.00003 },
};

function loadCosts() {
  if (!fs.existsSync(COSTS_FILE)) return { entries: [], budgets: {} };
  return JSON.parse(fs.readFileSync(COSTS_FILE, 'utf8'));
}

function saveCosts(data) {
  fs.writeFileSync(COSTS_FILE, JSON.stringify(data, null, 2));
}

function logCall(component, model, details = {}) {
  const costs = loadCosts();
  const pricing = PRICING[model] || {};

  let cost = 0;
  if (details.inputTokens && pricing.input) {
    cost += (details.inputTokens / 1000) * pricing.input;
  }
  if (details.outputTokens && pricing.output) {
    cost += (details.outputTokens / 1000) * pricing.output;
  }
  if (details.durationMinutes && pricing.perMinute) {
    cost += details.durationMinutes * pricing.perMinute;
  }
  if (details.characters && pricing.perChar) {
    cost += details.characters * pricing.perChar;
  }
  if (details.cost) {
    cost = details.cost; // Override with exact cost if provided
  }

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    component, // 'gpt', 'claude', 'gemini', 'speech', etc.
    model,
    cost: Math.round(cost * 1000000) / 1000000, // 6 decimal places
    inputTokens: details.inputTokens || 0,
    outputTokens: details.outputTokens || 0,
    timestamp: new Date().toISOString(),
    meta: details.meta || null,
  };

  costs.entries.push(entry);

  // Keep last 10000 entries
  if (costs.entries.length > 10000) costs.entries = costs.entries.slice(-10000);
  saveCosts(costs);
  return entry;
}

function getStats(period = 'all') {
  const costs = loadCosts();
  let entries = costs.entries;

  // Filter by period
  if (period !== 'all') {
    const now = Date.now();
    const cutoffs = {
      'today': now - 86400000,
      'week': now - 604800000,
      'month': now - 2592000000,
    };
    const cutoff = cutoffs[period];
    if (cutoff) entries = entries.filter(e => new Date(e.timestamp).getTime() > cutoff);
  }

  // Aggregate
  const byComponent = {};
  const byModel = {};
  const byDay = {};
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;

  for (const e of entries) {
    totalCost += e.cost;
    totalInput += e.inputTokens;
    totalOutput += e.outputTokens;

    byComponent[e.component] = (byComponent[e.component] || 0) + e.cost;
    byModel[e.model] = (byModel[e.model] || 0) + e.cost;

    const day = e.timestamp.slice(0, 10);
    if (!byDay[day]) byDay[day] = { cost: 0, calls: 0 };
    byDay[day].cost += e.cost;
    byDay[day].calls++;
  }

  return {
    totalCost: Math.round(totalCost * 100) / 100,
    totalCalls: entries.length,
    totalInput,
    totalOutput,
    byComponent: Object.entries(byComponent).map(([k, v]) => ({ name: k, cost: Math.round(v * 100) / 100 })).sort((a, b) => b.cost - a.cost),
    byModel: Object.entries(byModel).map(([k, v]) => ({ name: k, cost: Math.round(v * 100) / 100 })).sort((a, b) => b.cost - a.cost),
    byDay: Object.entries(byDay).map(([k, v]) => ({ date: k, ...v, cost: Math.round(v.cost * 100) / 100 })).sort((a, b) => a.date.localeCompare(b.date)),
    period,
    budgets: costs.budgets,
  };
}

function setBudget(component, daily, monthly) {
  const costs = loadCosts();
  costs.budgets[component] = { daily, monthly };
  saveCosts(costs);
}

function checkBudget(component) {
  const costs = loadCosts();
  const budget = costs.budgets[component];
  if (!budget) return { withinBudget: true };

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date().toISOString().slice(0, 7);

  let dailySpent = 0;
  let monthlySpent = 0;
  for (const e of costs.entries) {
    if (e.component === component) {
      if (e.timestamp.startsWith(today)) dailySpent += e.cost;
      if (e.timestamp.startsWith(monthStart)) monthlySpent += e.cost;
    }
  }

  return {
    withinBudget: dailySpent < budget.daily && monthlySpent < budget.monthly,
    dailySpent: Math.round(dailySpent * 100) / 100,
    dailyBudget: budget.daily,
    monthlySpent: Math.round(monthlySpent * 100) / 100,
    monthlyBudget: budget.monthly,
  };
}

function getRecentCalls(limit = 50) {
  const costs = loadCosts();
  return costs.entries.slice(-limit).reverse();
}

module.exports = { logCall, getStats, setBudget, checkBudget, getRecentCalls, PRICING };
