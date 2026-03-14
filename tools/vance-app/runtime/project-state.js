/**
 * Project State — Live state tracking for each project
 *
 * Detects framework, dev server, port, and preview URL.
 * Tracks last edits and commit times.
 * Persists to .vance-data/project-states.json
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.resolve(__dirname, '../../../.vance-data');
const STATE_FILE = path.join(DATA_DIR, 'project-states.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── State Storage ──────────────────────────────────────────────

function loadStates() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveStates(states) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(states, null, 2));
}

function getState(projectId) {
  const states = loadStates();
  return states[projectId] || null;
}

function setState(projectId, state) {
  const states = loadStates();
  states[projectId] = { ...states[projectId], ...state, lastStateUpdate: new Date().toISOString() };
  saveStates(states);
  return states[projectId];
}

// ─── Framework Detection ────────────────────────────────────────

const FRAMEWORK_SIGNALS = [
  { files: ['vite.config.ts', 'vite.config.js', 'vite.config.mts'], framework: 'vite', port: 5173, command: 'npm run dev' },
  { files: ['next.config.ts', 'next.config.js', 'next.config.mjs'], framework: 'next', port: 3000, command: 'npm run dev' },
  { files: ['angular.json'], framework: 'angular', port: 4200, command: 'ng serve' },
  { files: ['vue.config.js', 'vue.config.ts'], framework: 'vue-cli', port: 8080, command: 'npm run serve' },
  { files: ['nuxt.config.ts', 'nuxt.config.js'], framework: 'nuxt', port: 3000, command: 'npm run dev' },
  { files: ['svelte.config.js'], framework: 'sveltekit', port: 5173, command: 'npm run dev' },
  { files: ['astro.config.mjs', 'astro.config.ts'], framework: 'astro', port: 4321, command: 'npm run dev' },
  { files: ['remix.config.js'], framework: 'remix', port: 3000, command: 'npm run dev' },
];

/**
 * Detect framework, dev command, and port from a project directory.
 */
function detectFramework(directory) {
  if (!directory || !fs.existsSync(directory)) return null;

  // Check for framework config files
  for (const signal of FRAMEWORK_SIGNALS) {
    for (const file of signal.files) {
      if (fs.existsSync(path.join(directory, file))) {
        return {
          dev_framework: signal.framework,
          dev_port: signal.port,
          dev_server_command: signal.command,
          preview_url: `http://localhost:${signal.port}`,
        };
      }
    }
  }

  // Fallback: check package.json for scripts
  const pkgPath = path.join(directory, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.dev) {
        // Check if dev script mentions a port
        const portMatch = pkg.scripts.dev.match(/--port\s+(\d+)|-p\s+(\d+)/);
        const port = portMatch ? parseInt(portMatch[1] || portMatch[2]) : 3000;
        return {
          dev_framework: 'node',
          dev_port: port,
          dev_server_command: 'npm run dev',
          preview_url: `http://localhost:${port}`,
        };
      }
      if (pkg.scripts?.start) {
        return {
          dev_framework: 'node',
          dev_port: 3000,
          dev_server_command: 'npm start',
          preview_url: `http://localhost:3000`,
        };
      }
    } catch {}
  }

  // Check for standalone server.js with PORT
  const serverFile = path.join(directory, 'server.js');
  if (fs.existsSync(serverFile)) {
    try {
      const content = fs.readFileSync(serverFile, 'utf8');
      const portMatch = content.match(/PORT\s*(?:=|:)\s*(?:process\.env\.\w+\s*\|\|?\s*)?(\d+)/);
      const port = portMatch ? parseInt(portMatch[1]) : 3000;
      return {
        dev_framework: 'node-server',
        dev_port: port,
        dev_server_command: 'node server.js',
        preview_url: `http://localhost:${port}`,
      };
    } catch {}
  }

  return null;
}

/**
 * Check if a dev server is running on a given port.
 */
function isServerRunning(port) {
  try {
    const result = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Initialize or refresh project state by detecting framework info.
 */
function initProjectState(projectId, projectName, directory) {
  const existing = getState(projectId) || {};
  const detected = detectFramework(directory) || {};

  const state = {
    project_name: projectName,
    project_directory: directory,
    dev_framework: detected.dev_framework || existing.dev_framework || null,
    dev_server_command: detected.dev_server_command || existing.dev_server_command || null,
    dev_port: detected.dev_port || existing.dev_port || null,
    preview_url: detected.preview_url || existing.preview_url || null,
    last_updated_files: existing.last_updated_files || [],
    last_edit_summary: existing.last_edit_summary || null,
    last_commit_time: existing.last_commit_time || null,
  };

  return setState(projectId, state);
}

/**
 * Record a code change event.
 */
function recordChange(projectId, files, summary) {
  return setState(projectId, {
    last_updated_files: files,
    last_edit_summary: summary,
    last_change_time: new Date().toISOString(),
  });
}

/**
 * Record a commit event.
 */
function recordCommit(projectId) {
  return setState(projectId, {
    last_commit_time: new Date().toISOString(),
  });
}

/**
 * Get full project status summary.
 */
function getProjectStatus(projectId) {
  const state = getState(projectId);
  if (!state) return null;

  const serverRunning = state.dev_port ? isServerRunning(state.dev_port) : false;

  return {
    ...state,
    dev_server_running: serverRunning,
    preview_available: serverRunning && state.preview_url ? state.preview_url : null,
  };
}

/**
 * Get all project states.
 */
function getAllStates() {
  return loadStates();
}

module.exports = {
  getState,
  setState,
  detectFramework,
  isServerRunning,
  initProjectState,
  recordChange,
  recordCommit,
  getProjectStatus,
  getAllStates,
};
