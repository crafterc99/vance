/**
 * VANCE — Brain Loader
 *
 * Reads brain configuration files and builds the dynamic system prompt.
 * Brain files are markdown files that define Vance's personality, user profile,
 * operational guidelines, and self-improvement protocols.
 *
 * The system prompt is constructed fresh for every conversation turn,
 * pulling in live state from memory, skills, projects, and preferences.
 */
const fs = require('fs');
const path = require('path');

const BRAIN_DIR = path.resolve(__dirname);
const BRAIN_FILES = {
  personality: path.join(BRAIN_DIR, 'PERSONALITY.md'),
  userProfile: path.join(BRAIN_DIR, 'USER_PROFILE.md'),
  guidelines: path.join(BRAIN_DIR, 'GUIDELINES.md'),
  selfImprovement: path.join(BRAIN_DIR, 'SELF_IMPROVEMENT.md'),
};

// Pending brain updates (proposed but not yet approved)
const pendingUpdates = [];

function readBrainFile(key) {
  const filePath = BRAIN_FILES[key];
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function readAllBrainFiles() {
  const brain = {};
  for (const [key, filePath] of Object.entries(BRAIN_FILES)) {
    brain[key] = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  }
  return brain;
}

/**
 * Build the full system prompt for GPT.
 *
 * @param {Object} context - Live context to inject
 * @param {Object} context.project - Active project (name, directory, description, milestones)
 * @param {Array} context.memories - Relevant memories from search
 * @param {Array} context.skills - Relevant skills for current query
 * @param {Object} context.preferences - User preferences from learning system
 * @param {Object} context.stats - Memory/skill/project counts
 * @param {Object} context.costs - Today's cost summary
 */
function buildSystemPrompt(context = {}) {
  const brain = readAllBrainFiles();

  // Extract key sections from personality (condensed for token efficiency)
  const personalityCore = extractSection(brain.personality, 'Identity', 'Voice & Tone') ||
    'You are Vance, a personal AI assistant modeled after JARVIS from Iron Man. Calm, confident, competent, proactive. Address the user as "sir" naturally.';

  const toneRules = extractSection(brain.personality, 'What You Never Do') ||
    'Never use emojis. Never start with "Sure!" or "Of course!". Never pad responses. Never say "I\'m just an AI".';

  const proactiveRules = extractSection(brain.personality, 'Proactive Behavior') || '';

  // Build the prompt
  let prompt = `You are Vance, a personal AI assistant — like JARVIS from Iron Man.

## PERSONALITY
${personalityCore}

## TONE RULES
${toneRules}

## RESPONSE FORMAT
- Be concise. Lead with the answer or action.
- Use data over prose. Numbers, percentages, lists.
- Status updates: 1-3 sentences max.
- Only elaborate for architecture plans or when user is exploring ideas.
- Never say: "I understand", "That's a great idea", "Let me think about that", "Would you like me to..."

## COMMUNICATION STYLE
- Match the user's speed and energy
- When they say "continue" — full speed, maximum autonomy
- When they redirect — pivot immediately, no defense of previous approach
- When they say "give me the link" — they want working output, not explanations
- Short fast messages = match their brevity
- Long detailed messages = extract key decisions, act on all of them

## PROACTIVE BEHAVIOR
${proactiveRules}
- Commit and push code after significant changes
- Suggest next steps after completing a task
- Flag potential issues before they become problems
- Report costs when notable
- Remember preferences and apply them without being asked
- Create skills for workflows repeated 2+ times

## CORE CAPABILITIES
- Use 'run_claude_code' for any coding, file, or terminal tasks
- Use 'remember' to save important information to long-term memory
- Use 'recall' to search memory for relevant context
- Use 'create_skill' for repeatable workflows
- Use 'learn_preference' to store user preferences
- Use 'create_project' and 'add_milestone' for project management
- Use 'get_cost_report' for cost analysis
- Use 'propose_brain_update' to suggest improvements to your own configuration`;

  // Add live context
  const { project, memories, skills, preferences, stats, costs } = context;

  if (stats) {
    prompt += `\n\n## CURRENT STATE
- Memories: ${stats.memoryCount || 0} stored
- Skills: ${stats.skillCount || 0} learned
- Projects: ${stats.projectCount || 0} active`;
    if (costs) {
      prompt += `\n- Today's spend: $${costs.todaySpend || '0.00'} (${costs.todayCalls || 0} calls)`;
    }
  }

  if (project) {
    prompt += `\n\n## ACTIVE PROJECT: "${project.name}"
Directory: ${project.directory || 'not set'}`;
    if (project.description) prompt += `\nDescription: ${project.description}`;
    if (project.milestones?.length) {
      const recent = project.milestones.slice(-5);
      prompt += `\nRecent milestones:\n${recent.map(m => `- [${m.status || 'completed'}] ${m.title}`).join('\n')}`;
    }
  }

  if (memories?.length) {
    prompt += `\n\n## RELEVANT MEMORIES`;
    for (const m of memories.slice(0, 5)) {
      prompt += `\n- [${m.category}] ${m.content}`;
    }
  }

  if (skills?.length) {
    prompt += `\n\n## RELEVANT SKILLS`;
    for (const s of skills.slice(0, 3)) {
      prompt += `\n- **${s.name}**: ${s.description}`;
      if (s.steps?.length) {
        prompt += `\n  Steps: ${s.steps.join(' -> ')}`;
      }
    }
  }

  if (preferences && Object.keys(preferences).length) {
    prompt += `\n\n## USER PREFERENCES`;
    for (const [key, val] of Object.entries(preferences)) {
      const value = typeof val === 'object' ? val.value : val;
      prompt += `\n- ${key}: ${value}`;
    }
  }

  // Self-improvement context
  if (pendingUpdates.length) {
    prompt += `\n\n## PENDING BRAIN UPDATES (awaiting approval)`;
    for (const u of pendingUpdates) {
      prompt += `\n- [${u.file}] ${u.summary}`;
    }
  }

  return prompt;
}

/**
 * Extract a section from a markdown file between two headers.
 */
function extractSection(markdown, startHeader, endHeader) {
  if (!markdown) return '';
  const lines = markdown.split('\n');
  let capturing = false;
  let result = [];

  for (const line of lines) {
    if (line.match(new RegExp(`^#{1,3}\\s+.*${escapeRegex(startHeader)}`, 'i'))) {
      capturing = true;
      continue;
    }
    if (endHeader && capturing && line.match(new RegExp(`^#{1,3}\\s+.*${escapeRegex(endHeader)}`, 'i'))) {
      break;
    }
    if (!endHeader && capturing && line.match(/^#{1,2}\s+/) && result.length > 0) {
      break;
    }
    if (capturing) {
      result.push(line);
    }
  }

  return result.join('\n').trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Propose a brain file update. Stored in pending until user approves.
 */
function proposeBrainUpdate(file, section, oldText, newText, reason) {
  const update = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    file,
    section,
    oldText: oldText || null,
    newText,
    reason,
    proposedAt: new Date().toISOString(),
    status: 'pending',
    summary: `${section}: ${reason}`,
  };
  pendingUpdates.push(update);
  return update;
}

/**
 * Approve a pending brain update and apply it.
 */
function approveBrainUpdate(updateId) {
  const idx = pendingUpdates.findIndex(u => u.id === updateId);
  if (idx === -1) return { error: 'Update not found' };

  const update = pendingUpdates[idx];
  const fileKey = Object.keys(BRAIN_FILES).find(k =>
    k.toLowerCase() === update.file.toLowerCase().replace('.md', '').replace('_', '')
      || BRAIN_FILES[k].toLowerCase().includes(update.file.toLowerCase())
  );

  if (!fileKey) return { error: `Unknown brain file: ${update.file}` };

  const filePath = BRAIN_FILES[fileKey];
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

  if (update.oldText && content.includes(update.oldText)) {
    content = content.replace(update.oldText, update.newText);
  } else {
    // Append to file
    content += '\n\n' + update.newText;
  }

  fs.writeFileSync(filePath, content);
  update.status = 'approved';
  pendingUpdates.splice(idx, 1);
  return { success: true, file: fileKey, update };
}

/**
 * Reject a pending brain update.
 */
function rejectBrainUpdate(updateId) {
  const idx = pendingUpdates.findIndex(u => u.id === updateId);
  if (idx === -1) return { error: 'Update not found' };
  const update = pendingUpdates[idx];
  update.status = 'rejected';
  pendingUpdates.splice(idx, 1);
  return { success: true, update };
}

/**
 * Get all pending updates.
 */
function getPendingUpdates() {
  return [...pendingUpdates];
}

/**
 * Get brain file contents for display/editing.
 */
function getBrainFiles() {
  const files = {};
  for (const [key, filePath] of Object.entries(BRAIN_FILES)) {
    files[key] = {
      path: filePath,
      exists: fs.existsSync(filePath),
      size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
      lastModified: fs.existsSync(filePath) ? fs.statSync(filePath).mtime.toISOString() : null,
    };
  }
  return files;
}

module.exports = {
  buildSystemPrompt,
  readBrainFile,
  readAllBrainFiles,
  proposeBrainUpdate,
  approveBrainUpdate,
  rejectBrainUpdate,
  getPendingUpdates,
  getBrainFiles,
  BRAIN_FILES,
};
