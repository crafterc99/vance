/**
 * VANCE — Project Intelligence
 *
 * Scans each project and generates:
 *   - CLAUDE.md at project root (comprehensive context for Claude Code)
 *   - .claude/settings.json (pre-authorized tools for zero-permission sessions)
 *
 * Highest-impact module: eliminates cold-start on every Claude Code session.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const coding = require('./coding');
const projectState = require('./runtime/project-state');

const DATA_DIR = path.resolve(__dirname, '../../.vance-data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const MEMORY_DIR = path.resolve(__dirname, 'memory');

const VANCE_HEADER = '<!-- vance-managed -->';
const INTEL_STATE_FILE = path.join(DATA_DIR, 'project-intel-state.json');

// ─── Intel State Tracking ─────────────────────────────────────────────────

function loadIntelState() {
  try { return JSON.parse(fs.readFileSync(INTEL_STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveIntelState(state) {
  fs.writeFileSync(INTEL_STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Permission Settings Template ─────────────────────────────────────────

const FULL_PERMISSIONS = {
  permissions: {
    allow: [
      'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit',
      'Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)',
      'Bash(bun:*)', 'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(rm:*)',
      'Bash(cp:*)', 'Bash(mv:*)', 'Bash(find:*)', 'Bash(curl:*)',
      'Bash(docker:*)', 'Bash(python:*)', 'Bash(tsc:*)',
      'Bash(jest:*)', 'Bash(vitest:*)', 'Bash(open:*)',
      'Bash(osascript:*)', 'Bash(gh:*)', 'Bash(brew:*)',
      'Bash(sed:*)', 'Bash(awk:*)', 'Bash(grep:*)', 'Bash(touch:*)',
      'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)',
      'Bash(chmod:*)', 'Bash(tar:*)', 'Bash(zip:*)', 'Bash(unzip:*)',
      'Bash(ps:*)', 'Bash(kill:*)', 'Bash(lsof:*)', 'Bash(echo:*)',
      'Bash(pwd:*)', 'Bash(cd:*)', 'Bash(env:*)', 'Bash(which:*)',
      'Bash(sort:*)', 'Bash(uniq:*)', 'Bash(cargo:*)', 'Bash(go:*)',
      'Bash(make:*)', 'Bash(pip:*)', 'Bash(python3:*)',
      'Bash(eslint:*)', 'Bash(prettier:*)', 'Bash(mocha:*)',
      'Bash(wget:*)', 'Bash(docker-compose:*)',
    ],
  },
};

// ─── Project Scanning ─────────────────────────────────────────────────────

/**
 * Scan a project directory and build a structured info object.
 */
function scanProject(projectDir) {
  const dir = coding.expandHome(projectDir);
  if (!dir || !fs.existsSync(dir)) return null;

  const info = {
    directory: dir,
    name: path.basename(dir),
    description: '',
    stack: {},
    commands: {},
    architecture: [],
    keyFiles: [],
    conventions: {},
    recentCommits: [],
    notes: '',
  };

  // Package.json analysis
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      info.name = pkg.name || info.name;
      info.description = pkg.description || '';

      // Stack detection
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const depNames = Object.keys(allDeps);

      // Framework
      const frameworkInfo = projectState.detectFramework(dir);
      if (frameworkInfo) info.stack.framework = frameworkInfo.dev_framework;

      // Language
      if (depNames.includes('typescript') || fs.existsSync(path.join(dir, 'tsconfig.json'))) {
        info.stack.language = 'TypeScript';
      } else {
        info.stack.language = 'JavaScript';
      }

      // Styling
      if (depNames.some(d => d.includes('tailwind'))) info.stack.styling = 'Tailwind CSS';
      else if (depNames.includes('styled-components')) info.stack.styling = 'styled-components';
      else if (depNames.includes('@emotion/react')) info.stack.styling = 'Emotion';

      // State management
      if (depNames.includes('zustand')) info.stack.stateManagement = 'Zustand';
      else if (depNames.includes('redux') || depNames.includes('@reduxjs/toolkit')) info.stack.stateManagement = 'Redux';
      else if (depNames.includes('mobx')) info.stack.stateManagement = 'MobX';

      // Testing
      if (depNames.includes('vitest')) info.stack.testing = 'Vitest';
      else if (depNames.includes('jest')) info.stack.testing = 'Jest';
      else if (depNames.includes('mocha')) info.stack.testing = 'Mocha';

      // Key deps
      const notable = depNames.filter(d =>
        ['react', 'vue', 'angular', 'svelte', 'express', 'fastify', 'supabase',
         'prisma', 'drizzle', 'stripe', 'phaser', 'three', 'framer-motion',
         'react-router', 'next-auth', 'clerk'].some(k => d.includes(k))
      );
      if (notable.length) info.stack.keyDeps = notable;

      // Commands from scripts
      if (pkg.scripts) {
        if (pkg.scripts.dev) info.commands.dev = `npm run dev`;
        if (pkg.scripts.build) info.commands.build = `npm run build`;
        if (pkg.scripts.test) info.commands.test = `npm test`;
        if (pkg.scripts.lint) info.commands.lint = `npm run lint`;
        if (pkg.scripts.start) info.commands.start = `npm start`;
      }
    } catch {}
  }

  // Directory tree (max depth 3, skip node_modules/.git/.next/dist)
  info.architecture = getDirectoryTree(dir, 3);

  // Key files detection
  const keyFilePatterns = [
    'src/main.ts', 'src/main.tsx', 'src/index.ts', 'src/index.tsx',
    'src/App.tsx', 'src/App.ts', 'src/app.ts', 'src/app.tsx',
    'src/store.ts', 'src/stores/*.ts', 'src/lib/*.ts',
    'vite.config.ts', 'vite.config.js', 'tsconfig.json',
    'tailwind.config.ts', 'tailwind.config.js',
    'server.js', 'server.ts', 'index.js', 'index.ts',
  ];
  for (const pattern of keyFilePatterns) {
    const full = path.join(dir, pattern);
    if (!pattern.includes('*') && fs.existsSync(full)) {
      info.keyFiles.push(pattern);
    }
  }

  // Git recent commits
  try {
    const log = execSync('git log --oneline -10 2>/dev/null', { cwd: dir, encoding: 'utf8', timeout: 5000 });
    info.recentCommits = log.trim().split('\n').filter(Boolean);
  } catch {}

  // Git HEAD hash for staleness check
  try {
    info.gitHead = execSync('git rev-parse HEAD 2>/dev/null', { cwd: dir, encoding: 'utf8', timeout: 3000 }).trim();
  } catch { info.gitHead = null; }

  // Conventions detection
  try {
    // Check for .eslintrc, .prettierrc, etc
    if (fs.existsSync(path.join(dir, '.eslintrc.js')) || fs.existsSync(path.join(dir, '.eslintrc.json')) || fs.existsSync(path.join(dir, 'eslint.config.js'))) {
      info.conventions.linting = 'ESLint';
    }
    if (fs.existsSync(path.join(dir, '.prettierrc')) || fs.existsSync(path.join(dir, '.prettierrc.json'))) {
      info.conventions.formatting = 'Prettier';
    }
    // Check commit message style from recent commits
    if (info.recentCommits.length > 3) {
      const hasConventional = info.recentCommits.some(c => /^\w+ (feat|fix|chore|docs|style|refactor|test)\W/.test(c));
      if (hasConventional) info.conventions.commits = 'conventional';
    }
  } catch {}

  return info;
}

/**
 * Get directory tree as string lines (skip node_modules, .git, etc).
 */
function getDirectoryTree(dir, maxDepth, currentDepth = 0, prefix = '') {
  const lines = [];
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.vite', '.cache', 'coverage', '.claude']);

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !SKIP.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}`);

      if (entry.isDirectory() && currentDepth < maxDepth - 1) {
        const childLines = getDirectoryTree(
          path.join(dir, entry.name), maxDepth, currentDepth + 1, prefix + childPrefix
        );
        lines.push(...childLines);
      }
    }
  } catch {}

  return lines;
}

// ─── CLAUDE.md Generation ─────────────────────────────────────────────────

/**
 * Generate CLAUDE.md at project root from scanned info.
 */
function generateClaudeMd(projectDir, info, projectMeta = {}) {
  const dir = coding.expandHome(projectDir);
  const claudeFile = path.join(dir, 'CLAUDE.md');

  // Don't overwrite manually edited ones
  if (fs.existsSync(claudeFile)) {
    const existing = fs.readFileSync(claudeFile, 'utf8');
    if (!existing.startsWith(VANCE_HEADER)) {
      console.log(`  [project-intel] Skipping ${info.name}/CLAUDE.md — manually edited`);
      return false;
    }
  }

  const lines = [VANCE_HEADER];
  lines.push(`# ${projectMeta.name || info.name}`);
  lines.push('');

  if (projectMeta.description || info.description) {
    lines.push(projectMeta.description || info.description);
    lines.push('');
  }

  // Stack
  if (Object.keys(info.stack).length) {
    lines.push('## Stack');
    for (const [key, val] of Object.entries(info.stack)) {
      if (key === 'keyDeps') {
        lines.push(`- **Key Dependencies**: ${val.join(', ')}`);
      } else {
        lines.push(`- **${key.charAt(0).toUpperCase() + key.slice(1)}**: ${val}`);
      }
    }
    lines.push('');
  }

  // Commands
  if (Object.keys(info.commands).length) {
    lines.push('## Commands');
    for (const [cmd, script] of Object.entries(info.commands)) {
      lines.push(`- **${cmd}**: \`${script}\``);
    }
    lines.push('');
  }

  // Architecture
  if (info.architecture.length) {
    lines.push('## Architecture');
    lines.push('```');
    lines.push(...info.architecture.slice(0, 60));
    if (info.architecture.length > 60) lines.push('... (truncated)');
    lines.push('```');
    lines.push('');
  }

  // Key Files
  if (info.keyFiles.length) {
    lines.push('## Key Files');
    for (const f of info.keyFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  // Conventions
  if (Object.keys(info.conventions).length) {
    lines.push('## Conventions');
    for (const [key, val] of Object.entries(info.conventions)) {
      lines.push(`- **${key}**: ${val}`);
    }
    lines.push('');
  }

  // Recent Commits
  if (info.recentCommits.length) {
    lines.push('## Recent Activity');
    for (const c of info.recentCommits) {
      lines.push(`- ${c}`);
    }
    lines.push('');
  }

  // Project notes from MEMORY.md/projects.md
  const notes = getProjectNotes(projectMeta.id || info.name);
  if (notes) {
    lines.push('## Notes');
    lines.push(notes);
    lines.push('');
  }

  // Rules
  lines.push('## Rules');
  lines.push('- Work autonomously. Commit frequently. Do NOT push unless told to.');
  lines.push('- Read files before editing. Run tests after changes.');
  lines.push('- npm cache has permissions issues — use `--cache ./.npm-cache` flag when installing.');
  lines.push('');

  fs.writeFileSync(claudeFile, lines.join('\n'));
  console.log(`  [project-intel] Generated ${info.name}/CLAUDE.md`);
  return true;
}

// ─── Settings Generation ──────────────────────────────────────────────────

/**
 * Generate .claude/settings.json at project root.
 */
function generateSettings(projectDir) {
  const dir = coding.expandHome(projectDir);
  const claudeDir = path.join(dir, '.claude');
  const settingsFile = path.join(claudeDir, 'settings.json');

  // Don't overwrite manually edited ones
  if (fs.existsSync(settingsFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (existing._vanceManaged !== true) {
        console.log(`  [project-intel] Skipping ${path.basename(dir)}/.claude/settings.json — manually edited`);
        return false;
      }
    } catch {}
  }

  fs.mkdirSync(claudeDir, { recursive: true });
  const settings = { _vanceManaged: true, ...FULL_PERMISSIONS };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  console.log(`  [project-intel] Generated ${path.basename(dir)}/.claude/settings.json`);
  return true;
}

// ─── Helper: Extract notes from MEMORY.md ─────────────────────────────────

function getProjectNotes(projectId) {
  try {
    const brain = require('./brain/loader');
    const { memoryMd, projectsMd } = brain.getSmartMemory();
    const combined = (memoryMd || '') + '\n' + (projectsMd || '');

    // Look for project-specific sections
    const projectNames = {
      'soul-jam': ['Soul Jam', 'soul-jam'],
      'athletes-blender': ['Athletes Blender', 'athletes-blender'],
      'sos-train': ['SOS Train', 'sos-train'],
      'vance': ['Vance', 'vance'],
      'vantheah': ['Vantheah', 'vantheah'],
      'promotifyy': ['Promotifyy', 'promotifyy'],
    };

    const names = projectNames[projectId] || [projectId];
    const lines = combined.split('\n');
    let capturing = false;
    let notes = [];

    for (const line of lines) {
      for (const name of names) {
        if (line.includes(`**${name}**`) || line.match(new RegExp(`^#+\\s+.*${name}`, 'i'))) {
          capturing = true;
          break;
        }
      }
      if (capturing) {
        if (line.match(/^##?\s/) && notes.length > 0) break; // New major section
        notes.push(line);
      }
    }

    return notes.join('\n').trim().slice(0, 1000) || null;
  } catch { return null; }
}

// ─── Staleness Check ──────────────────────────────────────────────────────

/**
 * Check if CLAUDE.md needs refresh (git HEAD changed since last generation).
 */
function needsRefresh(projectDir) {
  const dir = coding.expandHome(projectDir);
  if (!dir) return true;

  const claudeFile = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(claudeFile)) return true;

  const state = loadIntelState();
  const key = dir;
  if (!state[key]) return true;

  try {
    const currentHead = execSync('git rev-parse HEAD 2>/dev/null', { cwd: dir, encoding: 'utf8', timeout: 3000 }).trim();
    return currentHead !== state[key].gitHead;
  } catch {
    return false; // Can't check git, assume fresh
  }
}

// ─── High-Level Pipeline ──────────────────────────────────────────────────

/**
 * Full pipeline: resolve dir → scan → generate CLAUDE.md + settings.json
 */
function bootstrapProject(projectId) {
  try {
    const projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    const project = projects.find(p => p.id === projectId);
    if (!project) return { success: false, error: `Project not found: ${projectId}` };

    const dir = coding.expandHome(project.directory);
    if (!dir || !fs.existsSync(dir)) {
      return { success: false, error: `Directory not found: ${project.directory}` };
    }

    const info = scanProject(dir);
    if (!info) return { success: false, error: `Scan failed for ${projectId}` };

    const claudeMd = generateClaudeMd(dir, info, project);
    const settings = generateSettings(dir);

    // Track state for staleness checks
    const state = loadIntelState();
    state[dir] = { gitHead: info.gitHead, lastBootstrap: new Date().toISOString(), projectId };
    saveIntelState(state);

    return {
      success: true,
      projectId,
      claudeMdGenerated: claudeMd,
      settingsGenerated: settings,
      stack: info.stack,
      commands: info.commands,
      keyFiles: info.keyFiles,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Bootstrap all projects from projects.json.
 */
async function bootstrapAll() {
  let projects;
  try {
    projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
  } catch {
    return [];
  }

  const results = [];
  for (const project of projects) {
    const result = bootstrapProject(project.id);
    results.push(result);
  }
  return results;
}

module.exports = {
  scanProject,
  generateClaudeMd,
  generateSettings,
  bootstrapProject,
  bootstrapAll,
  needsRefresh,
  FULL_PERMISSIONS,
};
