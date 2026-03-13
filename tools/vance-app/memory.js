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
const MEMORY_DIR = path.resolve(__dirname, 'memory');
const DAILY_DIR = path.join(MEMORY_DIR, 'daily');
const PROJECTS_DIR = path.resolve(__dirname, 'projects');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SKILLS_DIR, { recursive: true });
fs.mkdirSync(DAILY_DIR, { recursive: true });
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
fs.mkdirSync(path.join(MEMORY_DIR, 'decisions'), { recursive: true });
fs.mkdirSync(path.join(MEMORY_DIR, 'research'), { recursive: true });
fs.mkdirSync(path.join(MEMORY_DIR, 'workflows'), { recursive: true });
fs.mkdirSync(path.join(MEMORY_DIR, 'tasks'), { recursive: true });

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

// ─── Daily Notes ─────────────────────────────────────────────────────────

function getDailyNotePath(date) {
  const dateStr = date || new Date().toISOString().split('T')[0];
  return path.join(DAILY_DIR, `${dateStr}.md`);
}

function readDailyNote(date) {
  const filePath = getDailyNotePath(date);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function writeDailyNote(content, date) {
  const filePath = getDailyNotePath(date);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function appendDailyNote(section, content, date) {
  const filePath = getDailyNotePath(date);
  const dateStr = date || new Date().toISOString().split('T')[0];

  if (!fs.existsSync(filePath)) {
    // Create new daily note with template
    const template = `# Daily Note - ${dateStr}\n\n## Summary\n\n## Tasks Worked On\n\n## Decisions\n\n## Open Loops\n\n## Follow-Up\n`;
    fs.writeFileSync(filePath, template);
  }

  let note = fs.readFileSync(filePath, 'utf8');

  // Find the section header and append content after it
  const sectionRegex = new RegExp(`(## ${section}[^\n]*\n)`, 'i');
  if (sectionRegex.test(note)) {
    note = note.replace(sectionRegex, `$1- ${content}\n`);
  } else {
    // Section doesn't exist, append at end
    note += `\n## ${section}\n- ${content}\n`;
  }

  fs.writeFileSync(filePath, note);
  return filePath;
}

function listDailyNotes(limit = 30) {
  if (!fs.existsSync(DAILY_DIR)) return [];
  return fs.readdirSync(DAILY_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(f => ({
      date: f.replace('.md', ''),
      path: path.join(DAILY_DIR, f),
      size: fs.statSync(path.join(DAILY_DIR, f)).size,
    }));
}

// ─── Project Files ───────────────────────────────────────────────────────

function ensureProjectDir(slug) {
  const dir = path.join(PROJECTS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readProjectFile(slug, file) {
  const filePath = path.join(PROJECTS_DIR, slug, file);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function writeProjectFile(slug, file, content) {
  const dir = ensureProjectDir(slug);
  const filePath = path.join(dir, file);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function appendProjectFile(slug, file, content) {
  const dir = ensureProjectDir(slug);
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content + '\n');
  } else {
    fs.appendFileSync(filePath, '\n' + content);
  }
  return filePath;
}

function listProjectFiles(slug) {
  const dir = path.join(PROJECTS_DIR, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md'));
}

// ─── MEMORY.md Management ────────────────────────────────────────────────

const MEMORY_MD_FILE = path.join(MEMORY_DIR, 'MEMORY.md');

function readMemoryMd() {
  if (!fs.existsSync(MEMORY_MD_FILE)) return '';
  return fs.readFileSync(MEMORY_MD_FILE, 'utf8');
}

function updateMemoryMdSection(section, content) {
  if (!fs.existsSync(MEMORY_MD_FILE)) return false;

  let md = fs.readFileSync(MEMORY_MD_FILE, 'utf8');
  const sectionRegex = new RegExp(`(## ${section}[^\n]*\n)((?:(?!## ).)*)`, 'is');

  if (sectionRegex.test(md)) {
    md = md.replace(sectionRegex, `$1${content}\n\n`);
  } else {
    // Add section at end
    md += `\n## ${section}\n${content}\n`;
  }

  // Update timestamp
  md = md.replace(/Last Updated: \d{4}-\d{2}-\d{2}/, `Last Updated: ${new Date().toISOString().split('T')[0]}`);

  fs.writeFileSync(MEMORY_MD_FILE, md);
  return true;
}

// ─── projects.md Management ──────────────────────────────────────────────

const PROJECTS_MD_FILE = path.join(MEMORY_DIR, 'projects.md');

function readProjectsMd() {
  if (!fs.existsSync(PROJECTS_MD_FILE)) return '';
  return fs.readFileSync(PROJECTS_MD_FILE, 'utf8');
}

function writeProjectsMd(content) {
  fs.writeFileSync(PROJECTS_MD_FILE, content);
  return true;
}

// ─── Self-Curation ───────────────────────────────────────────────────────

const CURATION_LOG_FILE = path.join(DATA_DIR, 'curation-log.json');

function loadCurationLog() {
  if (!fs.existsSync(CURATION_LOG_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CURATION_LOG_FILE, 'utf8')); } catch { return []; }
}

function saveCurationLog(log) {
  fs.writeFileSync(CURATION_LOG_FILE, JSON.stringify(log, null, 2));
}

/**
 * Auto-curate: low-risk memory updates applied automatically.
 * - Updates to daily notes
 * - Adding new memories with importance <= 5
 * - Updating project status in projects.md
 * - Appending to existing sections (not overwriting)
 */
function autoCurate(action, details) {
  const log = loadCurationLog();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    action,
    details,
    timestamp: new Date().toISOString(),
    risk: 'low',
    auto: true,
  };
  log.push(entry);
  // Keep last 500 entries
  if (log.length > 500) log.splice(0, log.length - 500);
  saveCurationLog(log);
  return entry;
}

/**
 * Check if an action is safe for auto-curation.
 * Returns { safe: boolean, reason: string }
 */
function isSafeAutoCuration(action, target) {
  const SAFE_ACTIONS = [
    'append-daily-note',
    'add-memory',
    'update-project-status',
    'append-project-note',
    'record-decision',
    'record-task-outcome',
  ];

  const UNSAFE_TARGETS = [
    'PERSONALITY.md', 'USER_PROFILE.md', 'GUIDELINES.md',
    'SELF_IMPROVEMENT.md', 'tool_rules.md',
  ];

  if (!SAFE_ACTIONS.includes(action)) {
    return { safe: false, reason: `Action '${action}' requires approval` };
  }

  if (target && UNSAFE_TARGETS.some(t => target.includes(t))) {
    return { safe: false, reason: `Modifying '${target}' requires approval` };
  }

  return { safe: true, reason: 'Low-risk auto-curation' };
}

/**
 * Get curation history for review.
 */
function getCurationHistory(limit = 50) {
  return loadCurationLog().slice(-limit).reverse();
}

// ─── Memory Decisions / Research / Workflows ─────────────────────────────

function recordDecision(title, content, projectSlug) {
  const dateStr = new Date().toISOString().split('T')[0];
  const fileName = `${dateStr}-${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 50)}.md`;
  const filePath = path.join(MEMORY_DIR, 'decisions', fileName);
  const md = `# Decision: ${title}\nDate: ${dateStr}\nProject: ${projectSlug || 'general'}\n\n${content}\n`;
  fs.writeFileSync(filePath, md);
  autoCurate('record-decision', { title, projectSlug });
  return filePath;
}

function recordResearch(title, content, tags) {
  const dateStr = new Date().toISOString().split('T')[0];
  const fileName = `${dateStr}-${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 50)}.md`;
  const filePath = path.join(MEMORY_DIR, 'research', fileName);
  const md = `# Research: ${title}\nDate: ${dateStr}\nTags: ${(tags || []).join(', ')}\n\n${content}\n`;
  fs.writeFileSync(filePath, md);
  return filePath;
}

function recordWorkflow(name, steps, triggers) {
  const fileName = `${name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}.md`;
  const filePath = path.join(MEMORY_DIR, 'workflows', fileName);
  const md = `# Workflow: ${name}\nTriggers: ${(triggers || []).join(', ')}\n\n## Steps\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;
  fs.writeFileSync(filePath, md);
  return filePath;
}

function recordTaskOutcome(taskId, title, outcome, cost, duration) {
  const dateStr = new Date().toISOString().split('T')[0];
  const fileName = `${dateStr}-${taskId}.md`;
  const filePath = path.join(MEMORY_DIR, 'tasks', fileName);
  const md = `# Task: ${title}\nID: ${taskId}\nDate: ${dateStr}\nOutcome: ${outcome}\nCost: $${(cost || 0).toFixed(2)}\nDuration: ${duration || 'unknown'}\n`;
  fs.writeFileSync(filePath, md);
  autoCurate('record-task-outcome', { taskId, title, outcome });
  return filePath;
}

module.exports = {
  // Original memory
  addMemory, searchMemories, reinforceMemory, deleteMemory, getAllMemories, getMemoryStats,
  // Skills
  loadSkills, createSkill, getSkill, updateSkill, recordSkillUsage, findSkillsForQuery,
  // Learning
  learnPattern, learnPreference, learnCorrection, getPreferences, loadLearning,
  // Daily notes
  readDailyNote, writeDailyNote, appendDailyNote, listDailyNotes,
  // Project files
  readProjectFile, writeProjectFile, appendProjectFile, listProjectFiles,
  // MEMORY.md + projects.md
  readMemoryMd, updateMemoryMdSection, readProjectsMd, writeProjectsMd,
  // Self-curation
  autoCurate, isSafeAutoCuration, getCurationHistory,
  // Decisions / Research / Workflows / Tasks
  recordDecision, recordResearch, recordWorkflow, recordTaskOutcome,
  // Paths
  MEMORY_DIR, DAILY_DIR, PROJECTS_DIR,
};
