/**
 * Project Tool — Project state management for Vance
 *
 * Actions:
 *   list        — List all projects
 *   get         — Get project details + milestones
 *   create      — Create a new project
 *   update      — Update project fields
 *   milestone   — Add a milestone to a project
 *   git_status  — Get git status/log for a project directory
 *   file_tree   — Get file tree for a project directory
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../runtime/logger');

const description = 'Project management and state tracking';
const actions = ['list', 'get', 'create', 'update', 'milestone', 'git_status', 'file_tree'];

const DATA_DIR = path.resolve(__dirname, '../../../.vance-data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const MILESTONES_DIR = path.join(DATA_DIR, 'milestones');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MILESTONES_DIR, { recursive: true });

function loadProjects() {
  if (!fs.existsSync(PROJECTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch { return []; }
}

function saveProjects(projects) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

function loadMilestones(projectId) {
  const file = path.join(MILESTONES_DIR, `${projectId}.json`);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function saveMilestones(projectId, milestones) {
  fs.writeFileSync(path.join(MILESTONES_DIR, `${projectId}.json`), JSON.stringify(milestones, null, 2));
}

function run(cmd, cwd, timeout = 5000) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return ''; }
}

/**
 * @param {object} input - { action, ...params }
 * @param {object} ctx - { wsSend }
 */
async function execute(input, ctx = {}) {
  const { action = 'list' } = input;

  switch (action) {
    case 'list': {
      const projects = loadProjects();
      return projects.map(p => ({
        ...p,
        milestoneCount: loadMilestones(p.id).length,
      }));
    }

    case 'get': {
      const { projectId } = input;
      if (!projectId) throw new Error('Missing required field: projectId');
      const projects = loadProjects();
      const project = projects.find(p => p.id === projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      return {
        ...project,
        milestones: loadMilestones(projectId),
      };
    }

    case 'create': {
      const { name, description: desc, directory } = input;
      if (!name) throw new Error('Missing required field: name');
      const projects = loadProjects();
      const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const dir = directory || path.join(process.env.HOME, 'Claude Test', name);

      const project = {
        id, name, description: desc || '',
        directory: dir, status: 'active',
        createdAt: new Date().toISOString(),
      };
      projects.push(project);
      saveProjects(projects);
      fs.mkdirSync(dir, { recursive: true });

      if (ctx.wsSend) ctx.wsSend({ type: 'project-created', project });
      return project;
    }

    case 'update': {
      const { projectId, ...updates } = input;
      if (!projectId) throw new Error('Missing required field: projectId');
      const projects = loadProjects();
      const project = projects.find(p => p.id === projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);

      // Only allow updating specific fields
      const allowed = ['name', 'description', 'status', 'directory'];
      for (const key of allowed) {
        if (updates[key] !== undefined) project[key] = updates[key];
      }
      saveProjects(projects);
      return project;
    }

    case 'milestone': {
      const { projectId, title, status = 'completed' } = input;
      if (!projectId || !title) throw new Error('Missing required fields: projectId, title');
      const milestones = loadMilestones(projectId);
      const milestone = {
        id: Date.now().toString(36),
        title,
        status,
        createdAt: new Date().toISOString(),
      };
      milestones.push(milestone);
      saveMilestones(projectId, milestones);

      if (ctx.wsSend) ctx.wsSend({ type: 'milestone', title, projectId });
      return milestone;
    }

    case 'git_status': {
      const { directory } = input;
      if (!directory) throw new Error('Missing required field: directory');
      if (!fs.existsSync(directory)) return { error: 'Directory not found' };

      const gitLog = run('git log --oneline -30 --format="%h|%s|%an|%ar"', directory);
      const gitStatus = run('git status --short', directory);
      const branch = run('git branch --show-current', directory);

      const commits = gitLog ? gitLog.split('\n').map(line => {
        const [hash, message, author, time] = line.split('|');
        return { hash, message, author, time };
      }) : [];

      return { branch, status: gitStatus, commits, commitCount: commits.length };
    }

    case 'file_tree': {
      const { directory, maxDepth = 3, maxFiles = 200 } = input;
      if (!directory) throw new Error('Missing required field: directory');
      if (!fs.existsSync(directory)) return { error: 'Directory not found' };

      const tree = run(
        `find . -maxdepth ${maxDepth} -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | head -${maxFiles}`,
        directory
      );
      const files = tree ? tree.split('\n').filter(f => f && f !== '.') : [];
      return { directory, files, fileCount: files.length };
    }

    default:
      throw new Error(`Unknown project action: ${action}`);
  }
}

module.exports = { execute, description, actions };
