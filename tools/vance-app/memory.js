/**
 * VANCE — Long-Term Memory System
 *
 * Stores memories with tags, importance scores, and timestamps.
 * Supports semantic retrieval by keyword matching and recency.
 * Memories decay over time unless reinforced.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../../.vance-data');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const LEARNING_FILE = path.join(DATA_DIR, 'learning.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SKILLS_DIR, { recursive: true });

// ─── Memory Store ────────────────────────────────────────────────────────

function loadMemories() {
  if (!fs.existsSync(MEMORY_FILE)) return [];
  return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
}

function saveMemories(memories) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2));
}

function addMemory(content, tags = [], importance = 5, category = 'general') {
  const memories = loadMemories();
  const memory = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    content,
    tags: tags.map(t => t.toLowerCase()),
    category,
    importance, // 1-10
    accessCount: 0,
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    reinforced: 0,
  };
  memories.push(memory);
  saveMemories(memories);
  return memory;
}

function searchMemories(query, limit = 10) {
  const memories = loadMemories();
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = memories.map(m => {
    let score = 0;
    const text = (m.content + ' ' + m.tags.join(' ')).toLowerCase();

    // Keyword match
    for (const word of words) {
      if (text.includes(word)) score += 3;
      for (const tag of m.tags) {
        if (tag.includes(word) || word.includes(tag)) score += 5;
      }
    }

    // Importance boost
    score += m.importance * 0.5;

    // Recency boost (more recent = higher)
    const ageHours = (Date.now() - new Date(m.lastAccessed).getTime()) / 3600000;
    score += Math.max(0, 10 - ageHours * 0.1);

    // Access frequency boost
    score += Math.min(m.accessCount * 0.3, 5);

    // Reinforcement boost
    score += m.reinforced * 2;

    return { ...m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit).filter(m => m.score > 0);

  // Mark as accessed
  if (results.length) {
    const allMems = loadMemories();
    for (const r of results) {
      const mem = allMems.find(m => m.id === r.id);
      if (mem) {
        mem.accessCount++;
        mem.lastAccessed = new Date().toISOString();
      }
    }
    saveMemories(allMems);
  }

  return results;
}

function reinforceMemory(id) {
  const memories = loadMemories();
  const mem = memories.find(m => m.id === id);
  if (mem) {
    mem.reinforced++;
    mem.lastAccessed = new Date().toISOString();
    saveMemories(memories);
  }
  return mem;
}

function deleteMemory(id) {
  const memories = loadMemories().filter(m => m.id !== id);
  saveMemories(memories);
}

function getAllMemories() {
  return loadMemories();
}

function getMemoryStats() {
  const memories = loadMemories();
  const categories = {};
  for (const m of memories) {
    categories[m.category] = (categories[m.category] || 0) + 1;
  }
  return {
    total: memories.length,
    categories,
    oldestMemory: memories.length ? memories[0].createdAt : null,
    newestMemory: memories.length ? memories[memories.length - 1].createdAt : null,
  };
}

// ─── Skills System ───────────────────────────────────────────────────────

function loadSkills() {
  const skills = [];
  if (!fs.existsSync(SKILLS_DIR)) return skills;
  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      skills.push(JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8')));
    } catch {}
  }
  return skills;
}

function createSkill(name, description, steps, triggers = []) {
  const skill = {
    id: name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
    name,
    description,
    steps, // Array of instruction strings
    triggers: triggers.map(t => t.toLowerCase()), // Words that activate this skill
    createdAt: new Date().toISOString(),
    usageCount: 0,
    successRate: 0,
    lastUsed: null,
    version: 1,
  };
  fs.writeFileSync(path.join(SKILLS_DIR, `${skill.id}.json`), JSON.stringify(skill, null, 2));
  return skill;
}

function getSkill(id) {
  const file = path.join(SKILLS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function updateSkill(id, updates) {
  const skill = getSkill(id);
  if (!skill) return null;
  Object.assign(skill, updates);
  skill.version++;
  fs.writeFileSync(path.join(SKILLS_DIR, `${id}.json`), JSON.stringify(skill, null, 2));
  return skill;
}

function recordSkillUsage(id, success) {
  const skill = getSkill(id);
  if (!skill) return null;
  skill.usageCount++;
  skill.lastUsed = new Date().toISOString();
  // Running average success rate
  skill.successRate = ((skill.successRate * (skill.usageCount - 1)) + (success ? 1 : 0)) / skill.usageCount;
  fs.writeFileSync(path.join(SKILLS_DIR, `${id}.json`), JSON.stringify(skill, null, 2));
  return skill;
}

function findSkillsForQuery(query) {
  const skills = loadSkills();
  const words = query.toLowerCase().split(/\s+/);
  return skills.filter(s => {
    for (const trigger of s.triggers) {
      for (const word of words) {
        if (word.includes(trigger) || trigger.includes(word)) return true;
      }
    }
    return s.description.toLowerCase().split(/\s+/).some(w => words.includes(w));
  });
}

// ─── Learning System ─────────────────────────────────────────────────────

function loadLearning() {
  if (!fs.existsSync(LEARNING_FILE)) return { patterns: [], preferences: {}, corrections: [] };
  return JSON.parse(fs.readFileSync(LEARNING_FILE, 'utf8'));
}

function saveLearning(data) {
  fs.writeFileSync(LEARNING_FILE, JSON.stringify(data, null, 2));
}

function learnPattern(pattern, category) {
  const learning = loadLearning();
  learning.patterns.push({
    pattern,
    category,
    timestamp: new Date().toISOString(),
  });
  // Keep last 500 patterns
  if (learning.patterns.length > 500) learning.patterns = learning.patterns.slice(-500);
  saveLearning(learning);
}

function learnPreference(key, value) {
  const learning = loadLearning();
  learning.preferences[key] = { value, updatedAt: new Date().toISOString() };
  saveLearning(learning);
}

function learnCorrection(original, corrected, context) {
  const learning = loadLearning();
  learning.corrections.push({
    original,
    corrected,
    context,
    timestamp: new Date().toISOString(),
  });
  if (learning.corrections.length > 200) learning.corrections = learning.corrections.slice(-200);
  saveLearning(learning);
}

function getPreferences() {
  return loadLearning().preferences;
}

module.exports = {
  addMemory, searchMemories, reinforceMemory, deleteMemory, getAllMemories, getMemoryStats,
  loadSkills, createSkill, getSkill, updateSkill, recordSkillUsage, findSkillsForQuery,
  learnPattern, learnPreference, learnCorrection, getPreferences, loadLearning,
};
