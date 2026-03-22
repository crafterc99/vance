/**
 * BLAIR — Consolidated Tool Definitions
 *
 * 18 tools (down from 42) in OpenAI format.
 * Exports: TOOLS array, CLAUDE_TOOLS (Anthropic format), executeFunction() dispatcher.
 *
 * Merges:
 *   - manage_tasks: add/complete/dismiss/list user tasks + priorities + dashboard
 *   - manage_project: create/milestone/status/update/check_server
 *   - manage_session: list/cancel/reset/status/merge/set_budget
 *   - manage_memory: daily notes, vector store/search, decisions, MEMORY.md, preferences, skills, brain updates
 *   - recall: keyword + optional semantic search
 *
 * Drops: list_directory, get_cost_report, run_tool, run_agent
 */
const router = require('./router');

// ─── Tool Definitions (OpenAI format) ────────────────────────────────────

const TOOLS = [
  // ─── System Tools (13 kept) ────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Execute a shell command on the user\'s Mac. Returns stdout, stderr, exit code. Use for: git, npm, system checks, file manipulation, process management.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          cwd: { type: 'string', description: 'Working directory (default: home)' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: 30, max: 300)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns content with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path' },
          start_line: { type: 'number', description: 'Start line (1-indexed)' },
          end_line: { type: 'number', description: 'End line (default: all)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path' },
          content: { type: 'string', description: 'File content to write' },
          append: { type: 'boolean', description: 'Append instead of overwrite (default: false)' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for files by name or search file contents by text/regex.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex to search for' },
          path: { type: 'string', description: 'Directory to search in' },
          file_pattern: { type: 'string', description: 'Glob pattern to filter files' },
          name_only: { type: 'boolean', description: 'Search file names instead of contents' },
          max_results: { type: 'number', description: 'Max results (default: 20)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: 'Get Mac system information: CPU, memory, disk, battery, network, processes.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['all', 'cpu', 'memory', 'disk', 'battery', 'network', 'processes'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'Open an app, URL, or file on macOS.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'App name, URL, or file path' },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_applescript',
      description: 'Execute AppleScript on macOS for system automation.',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'AppleScript code to execute' },
        },
        required: ['script'],
      },
    },
  },
  // ─── Coding Tools ──────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'run_claude_code',
      description: 'Execute a coding task using Claude Code. Maintains persistent sessions per project. Use for: implementing features, fixing bugs, refactoring, debugging, testing.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The coding task or follow-up prompt' },
          project_directory: { type: 'string', description: 'Working directory' },
          project_id: { type: 'string', description: 'Project ID for session persistence' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_coding_task',
      description: 'Queue an autonomous coding task. Creates a git branch, auto-selects model/budget, runs in the background.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short human-readable title' },
          prompt: { type: 'string', description: 'Full detailed prompt for Claude Code' },
          project_directory: { type: 'string', description: 'Working directory' },
          project_id: { type: 'string', description: 'Blair project ID' },
          model: { type: 'string', enum: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'] },
          max_budget: { type: 'number', description: 'Override max budget in USD' },
          priority: { type: 'number', description: 'Priority 1-10 (10=highest)' },
        },
        required: ['title', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task_status',
      description: 'Get status of a specific task or the currently running task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID (omit for running task)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List all tasks, optionally filtered by status or project.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'] },
          project_id: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_task',
      description: 'Pause, resume, or cancel a task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
          action: { type: 'string', enum: ['pause', 'resume', 'cancel'] },
        },
        required: ['task_id', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Save something to long-term memory for future recall.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'What to remember' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Keywords for retrieval' },
          importance: { type: 'number', description: 'Importance 1-10' },
          category: { type: 'string', enum: ['preference', 'project', 'technical', 'personal', 'decision', 'general'] },
        },
        required: ['content', 'tags'],
      },
    },
  },
  // ─── Merged Tools (5 new) ──────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Search long-term memory. Uses keyword search by default. Set semantic=true for conceptual/vector search.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
          semantic: { type: 'boolean', description: 'Use vector/semantic search (default: false)' },
          type: { type: 'string', enum: ['daily-note', 'decision', 'research', 'task-outcome', 'memory', 'project-note'], description: 'Filter by type (semantic only)' },
          project_id: { type: 'string', description: 'Filter by project (semantic only)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_tasks',
      description: 'Manage user personal tasks/reminders and priorities. Actions: add, complete, dismiss, list, add_priority, complete_priority, dashboard.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'complete', 'dismiss', 'list', 'add_priority', 'complete_priority', 'dashboard'] },
          title: { type: 'string', description: 'Task/priority title (for add/add_priority)' },
          description: { type: 'string', description: 'Details' },
          task_id: { type: 'string', description: 'Task ID (for complete/dismiss)' },
          priority_id: { type: 'string', description: 'Priority ID (for complete_priority)' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          project: { type: 'string', description: 'Related project ID' },
          score: { type: 'number', description: 'Priority score 1-10 (for add_priority)' },
          due_at: { type: 'string', description: 'Due date/time ISO (for add)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_project',
      description: 'Manage projects. Actions: create, milestone, status, update, check_server.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'milestone', 'status', 'update', 'check_server'] },
          project_id: { type: 'string' },
          name: { type: 'string', description: 'Project name (create)' },
          description: { type: 'string' },
          directory: { type: 'string' },
          title: { type: 'string', description: 'Milestone title (milestone)' },
          milestone_status: { type: 'string', enum: ['completed', 'in-progress'] },
          files: { type: 'array', items: { type: 'string' }, description: 'Changed files (update)' },
          summary: { type: 'string', description: 'Change summary (update)' },
          start_server: { type: 'boolean', description: 'Start dev server (update/check_server)' },
          start_if_stopped: { type: 'boolean', description: 'Auto-start if stopped (check_server)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_session',
      description: 'Manage Claude Code sessions and tasks. Actions: list, cancel, reset, status, merge, set_budget.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'cancel', 'reset', 'status', 'merge', 'set_budget'] },
          session_id: { type: 'string', description: 'Session ID (cancel/reset/status)' },
          task_id: { type: 'string', description: 'Task ID (merge)' },
          push: { type: 'boolean', description: 'Push after merge (merge)' },
          daily: { type: 'number', description: 'Daily budget USD (set_budget)' },
          monthly: { type: 'number', description: 'Monthly budget USD (set_budget)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_memory',
      description: 'Advanced memory operations. Actions: daily_write, daily_read, store, search, decide, update_section, learn_pref, create_skill, brain_update.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['daily_write', 'daily_read', 'store', 'search', 'decide', 'update_section', 'learn_pref', 'create_skill', 'brain_update'] },
          // daily_write
          section: { type: 'string', description: 'Section name (daily_write, update_section)' },
          content: { type: 'string', description: 'Content (daily_write, store, decide, update_section, brain_update)' },
          // daily_read
          date: { type: 'string', description: 'Date YYYY-MM-DD (daily_read)' },
          // store
          type: { type: 'string', enum: ['daily-note', 'decision', 'research', 'task-outcome', 'memory', 'project-note'], description: 'Content type (store, search)' },
          project_id: { type: 'string', description: 'Project ID (store, search)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags (store, create_skill)' },
          // search
          query: { type: 'string', description: 'Search query (search)' },
          limit: { type: 'number', description: 'Max results (search)' },
          // decide
          title: { type: 'string', description: 'Title (decide, create_skill)' },
          project_slug: { type: 'string', description: 'Project slug (decide)' },
          // learn_pref
          key: { type: 'string', description: 'Preference key (learn_pref)' },
          value: { type: 'string', description: 'Preference value (learn_pref)' },
          // create_skill
          description: { type: 'string', description: 'Description (create_skill)' },
          steps: { type: 'array', items: { type: 'string' }, description: 'Steps (create_skill)' },
          triggers: { type: 'array', items: { type: 'string' }, description: 'Trigger words (create_skill)' },
          // brain_update
          file: { type: 'string', description: 'Brain file key (brain_update)' },
          old_text: { type: 'string', description: 'Text to replace (brain_update)' },
          new_text: { type: 'string', description: 'New text (brain_update)' },
          reason: { type: 'string', description: 'Why (brain_update)' },
        },
        required: ['action'],
      },
    },
  },
];

// ─── Anthropic Format ────────────────────────────────────────────────────

const CLAUDE_TOOLS = router.convertToolsToAnthropic(TOOLS);

// ─── Function Executor ───────────────────────────────────────────────────

/**
 * Execute a tool function by name.
 * Dependencies are injected via the `deps` parameter to avoid circular imports.
 *
 * @param {string} name - Tool name
 * @param {Object} args - Tool arguments
 * @param {Function} wsSend - WebSocket sender
 * @param {Object} deps - { memory, costs, brain, taskManager, taskIntelligence, claudeSession, vectorMemory, projectState, runClaudeCode, loadProjects, saveProjects, loadMilestones, addMilestone, runShell, resolvePath, searchFiles, getSystemInfo }
 * @returns {string} Tool result
 */
async function executeFunction(name, args, wsSend, deps) {
  const {
    memory, costs, brain, taskManager, taskIntelligence,
    claudeSession, vectorMemory, projectState,
    runClaudeCode, loadProjects, saveProjects,
    loadMilestones, addMilestone,
    runShell, resolvePath, searchFiles, getSystemInfo,
  } = deps;

  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');

  switch (name) {
    // ─── System Tools ───
    case 'run_shell': {
      wsSend({ type: 'status', text: `$ ${args.command.substring(0, 60)}${args.command.length > 60 ? '...' : ''}` });
      const result = await runShell(args.command, args.cwd, args.timeout || 30);
      let output = '';
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += (output ? '\n' : '') + `[stderr] ${result.stderr}`;
      output += `\n[exit code: ${result.code}]`;
      return output;
    }

    case 'read_file': {
      const filePath = resolvePath(args.path);
      if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const start = Math.max(0, (args.start_line || 1) - 1);
        const end = args.end_line ? Math.min(args.end_line, lines.length) : lines.length;
        const slice = lines.slice(start, end);
        const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join('\n');
        if (numbered.length > 50000) return numbered.slice(0, 50000) + `\n... (truncated, ${lines.length} total lines)`;
        return `${filePath} (${lines.length} lines):\n${numbered}`;
      } catch (e) { return `Error reading file: ${e.message}`; }
    }

    case 'write_file': {
      const filePath = resolvePath(args.path);
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (args.append) {
          fs.appendFileSync(filePath, args.content);
        } else {
          fs.writeFileSync(filePath, args.content);
        }
        return `Written to ${filePath} (${args.content.length} chars${args.append ? ', appended' : ''})`;
      } catch (e) { return `Error writing file: ${e.message}`; }
    }

    case 'search_files': {
      wsSend({ type: 'status', text: `Searching for "${args.query}"...` });
      return searchFiles(args.query, args.path, args.file_pattern, args.name_only, args.max_results || 20);
    }

    case 'system_info': {
      const info = await getSystemInfo(args.category || 'all');
      return JSON.stringify(info, null, 2);
    }

    case 'open_app': {
      try {
        const target = args.target;
        if (target.startsWith('http://') || target.startsWith('https://')) {
          execSync(`open "${target}"`, { timeout: 5000 });
          return `Opened URL: ${target}`;
        }
        if (!target.includes('/') && !target.includes('.')) {
          execSync(`open -a "${target}"`, { timeout: 5000 });
          return `Opened app: ${target}`;
        }
        const filePath = resolvePath(target);
        execSync(`open "${filePath}"`, { timeout: 5000 });
        return `Opened: ${filePath}`;
      } catch (e) { return `Error opening: ${e.message}`; }
    }

    case 'run_applescript': {
      try {
        const result = execSync(`osascript -e '${args.script.replace(/'/g, "'\\''")}'`, {
          encoding: 'utf8', timeout: 10000,
        });
        return result.trim() || 'AppleScript executed successfully.';
      } catch (e) { return `AppleScript error: ${e.stderr || e.message}`; }
    }

    // ─── Coding Tools ───
    case 'run_claude_code': {
      wsSend({ type: 'status', text: 'Executing code task...' });
      return await runClaudeCode(args.task, args.project_directory, wsSend, args.project_id);
    }

    case 'start_coding_task': {
      wsSend({ type: 'status', text: `Queuing task: ${args.title}` });
      const task = taskManager.createTask({
        title: args.title,
        prompt: args.prompt,
        projectDir: args.project_directory,
        projectId: args.project_id,
        model: args.model,
        maxBudget: args.max_budget,
        priority: args.priority,
      });
      const started = taskManager.startNext();
      let response = `Task queued: "${task.title}" [${task.id}] [${task.tier}/${task.model}, budget $${task.maxBudget}]`;
      if (started) {
        response = `Task RUNNING: "${task.title}" [${task.id}] [${task.tier}/${task.model}, budget $${task.maxBudget}]`;
        if (started.branch) response += `\nBranch: ${started.branch}`;
      } else if (taskManager.getRunningTask()) {
        const running = taskManager.getRunningTask();
        response += `\nQueued behind running task: "${running.title}" [${running.id}]`;
      }
      return response;
    }

    case 'get_task_status': {
      const task = args.task_id ? taskManager.getTask(args.task_id) : taskManager.getRunningTask();
      if (!task) return args.task_id ? `No task found with ID: ${args.task_id}` : 'No task currently running.';
      const summary = taskManager.taskSummary(task);
      let report = `Task: "${summary.title}" [${summary.status}]\nModel: ${summary.tier} (${summary.model})\nDuration: ${summary.durationFormatted}\nCost: $${(summary.costUsd || 0).toFixed(2)} / $${summary.maxBudget} budget\n`;
      if (summary.branch) report += `Branch: ${summary.branch}\n`;
      if (summary.milestones.length) {
        report += `Milestones (${summary.milestonesCount}):\n`;
        for (const m of summary.milestones.slice(-5)) report += `  - ${m.detail}\n`;
      }
      if (summary.error) report += `Error: ${summary.error}\n`;
      return report;
    }

    case 'list_tasks': {
      const tasks = taskManager.getAllTasks({ status: args.status, projectId: args.project_id });
      if (!tasks.length) return 'No tasks found.';
      let output = `Tasks (${tasks.length}):\n`;
      for (const t of tasks) {
        const s = taskManager.taskSummary(t);
        output += `  [${s.id}] ${s.title} — ${s.status} (${s.tier}, $${(s.costUsd || 0).toFixed(2)})\n`;
      }
      return output;
    }

    case 'control_task': {
      let result;
      switch (args.action) {
        case 'pause': result = taskManager.pauseTask(args.task_id); break;
        case 'resume': result = taskManager.resumeTask(args.task_id); break;
        case 'cancel': result = taskManager.cancelTask(args.task_id); break;
        default: return `Unknown action: ${args.action}`;
      }
      if (result.error) return `Error: ${result.error}`;
      return `Task ${args.task_id} ${args.action}d successfully.`;
    }

    case 'remember': {
      memory.addMemory(args.content, args.tags, args.importance || 5, args.category || 'general');
      return `Remembered: "${args.content}" [tags: ${args.tags.join(', ')}]`;
    }

    // ─── Merged Tools ───
    case 'recall': {
      if (args.semantic && vectorMemory) {
        wsSend({ type: 'status', text: 'Searching memory...' });
        const results = await vectorMemory.search(args.query, {
          limit: 5, type: args.type || null, projectId: args.project_id || null,
        });
        if (!results.length) return 'No relevant results found in semantic memory.';
        return results.map((r, i) => `${i + 1}. [${r.metadata.type}] (score: ${r.score.toFixed(2)}) ${r.content.slice(0, 300)}`).join('\n\n');
      }
      const results = memory.searchMemories(args.query, 5);
      if (!results.length) return 'No relevant memories found.';
      return results.map(m => `- [${m.category}] ${m.content} (importance: ${m.importance})`).join('\n');
    }

    case 'manage_tasks': {
      const priorityMap = { critical: 10, high: 8, medium: 5, low: 3 };
      switch (args.action) {
        case 'add': {
          const score = priorityMap[args.priority] || 5;
          const task = taskIntelligence.addUserTask(args.title, {
            description: args.description, project: args.project,
            priority: { level: args.priority || 'medium', score },
            dueAt: args.due_at, source: 'tool',
          });
          return `Added to your task board: "${task.title}" [${task.priority.level}, ID: ${task.id}]`;
        }
        case 'complete': {
          const task = taskIntelligence.completeUserTask(args.task_id);
          return task ? `Task completed: "${task.title}"` : `Task not found: ${args.task_id}`;
        }
        case 'dismiss': {
          const task = taskIntelligence.dismissUserTask(args.task_id);
          return task ? `Task dismissed: "${task.title}"` : `Task not found: ${args.task_id}`;
        }
        case 'list': {
          const tasks = taskIntelligence.getUserTasks({ project: args.project });
          if (!tasks.length) return 'No active user tasks.';
          return `Your tasks (${tasks.length}):\n` + tasks.map(t =>
            `  [${t.id}] ${t.title} — ${t.priority?.level || 'medium'}${t.project ? ` (${t.project})` : ''}${t.dueAt ? ` due: ${t.dueAt}` : ''}`
          ).join('\n');
        }
        case 'add_priority': {
          const p = taskIntelligence.addPriority(args.title, { description: args.description, project: args.project, score: args.score || 5 });
          return `Priority added: "${p.title}" [score: ${p.score}, ID: ${p.id}]`;
        }
        case 'complete_priority': {
          const p = taskIntelligence.completePriority(args.priority_id);
          return p ? `Priority completed: "${p.title}"` : `Priority not found: ${args.priority_id}`;
        }
        case 'dashboard': {
          const dashboard = taskIntelligence.getDashboard();
          let output = '## Task Dashboard\n\n';
          if (dashboard.priorities.length) {
            output += `### Priorities (${dashboard.priorities.length})\n`;
            for (const p of dashboard.priorities) output += `  [${p.id}] ${p.title} (score: ${p.score})${p.project ? ` — ${p.project}` : ''}\n`;
          }
          if (dashboard.userTasks.length) {
            output += `\n### Your Tasks (${dashboard.userTasks.length})\n`;
            for (const t of dashboard.userTasks) output += `  [${t.id}] ${t.title} — ${t.priority?.level || 'medium'}\n`;
          }
          const vt = dashboard.blairTasks;
          if (vt.running) output += `\n### Running: "${vt.running.title}" (${vt.running.tier}, $${(vt.running.costUsd || 0).toFixed(2)})\n`;
          if (vt.queued.length) { output += `\n### Queued (${vt.queued.length})\n`; for (const t of vt.queued) output += `  [${t.id}] ${t.title}\n`; }
          output += `\n### Stats\n  User tasks: ${dashboard.stats.totalUserTasks} | Queued: ${dashboard.stats.totalQueuedTasks} | Running: ${dashboard.stats.isRunning ? 'Yes' : 'No'}`;
          return output;
        }
        default: return `Unknown manage_tasks action: ${args.action}`;
      }
    }

    case 'manage_project': {
      switch (args.action) {
        case 'create': {
          const projects = loadProjects();
          const id = args.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          const dir = args.directory || path.join(process.env.HOME, 'Claude Test', args.name);
          projects.push({ id, name: args.name, description: args.description || '', directory: dir, status: 'active', createdAt: new Date().toISOString() });
          saveProjects(projects);
          fs.mkdirSync(dir, { recursive: true });
          wsSend({ type: 'project-created', project: projects[projects.length - 1] });
          return `Project "${args.name}" created at ${dir}`;
        }
        case 'milestone': {
          addMilestone(args.project_id, { title: args.title, status: args.milestone_status || 'completed' });
          wsSend({ type: 'milestone', title: args.title, projectId: args.project_id });
          return `Milestone recorded: "${args.title}"`;
        }
        case 'status': {
          const projects = loadProjects();
          const project = projects.find(p => p.id === args.project_id);
          if (!project) return `Project not found: ${args.project_id}`;
          projectState.initProjectState(args.project_id, project.name, project.directory);
          const status = projectState.getProjectStatus(args.project_id);
          let report = `PROJECT STATUS\nName: ${status.project_name}\nDirectory: ${status.project_directory}\n`;
          if (status.dev_framework) report += `Framework: ${status.dev_framework}\n`;
          report += `Dev Server: ${status.dev_server_running ? 'RUNNING' : 'STOPPED'}`;
          if (status.dev_port) report += ` (port ${status.dev_port})`;
          report += '\n';
          if (status.preview_available) report += `Preview: ${status.preview_available}\n`;
          if (status.last_updated_files?.length) report += `Last Changed: ${status.last_updated_files.join(', ')}\n`;
          if (status.last_edit_summary) report += `Last Edit: ${status.last_edit_summary}\n`;
          return report;
        }
        case 'update': {
          projectState.recordChange(args.project_id, args.files, args.summary);
          let result = `Project state updated: ${args.files.length} file(s) changed — "${args.summary}"`;
          if (args.start_server) {
            const status = projectState.getProjectStatus(args.project_id);
            if (status && !status.dev_server_running && status.dev_server_command && status.project_directory) {
              try {
                const { exec: execAsync } = require('child_process');
                execAsync(status.dev_server_command, { cwd: status.project_directory, detached: true, stdio: 'ignore' }).unref?.();
                result += `\nDev server starting: ${status.dev_server_command}`;
              } catch (e) { result += `\nFailed to start dev server: ${e.message}`; }
            }
          }
          return result;
        }
        case 'check_server': {
          const projects = loadProjects();
          const project = projects.find(p => p.id === args.project_id);
          if (!project) return `Project not found: ${args.project_id}`;
          projectState.initProjectState(args.project_id, project.name, project.directory);
          const status = projectState.getProjectStatus(args.project_id);
          if (!status) return 'No project state found.';
          if (status.dev_server_running) return `Dev server is RUNNING at ${status.preview_url} (port ${status.dev_port})`;
          if (args.start_if_stopped && status.dev_server_command && status.project_directory) {
            try {
              const { exec: execAsync } = require('child_process');
              execAsync(status.dev_server_command, { cwd: status.project_directory, detached: true, stdio: 'ignore' }).unref?.();
              return `Dev server was STOPPED. Starting: ${status.dev_server_command}\nPreview: ${status.preview_url}`;
            } catch (e) { return `Dev server STOPPED. Failed to start: ${e.message}`; }
          }
          let msg = 'Dev server is STOPPED';
          if (status.dev_server_command) msg += `\nStart with: ${status.dev_server_command}`;
          if (status.preview_url) msg += `\nPreview URL (when running): ${status.preview_url}`;
          return msg;
        }
        default: return `Unknown manage_project action: ${args.action}`;
      }
    }

    case 'manage_session': {
      switch (args.action) {
        case 'list': {
          const sessions = claudeSession.listSessions();
          if (!sessions.length) return 'No Claude Code sessions.';
          return sessions.map(s => `[${s.id}] ${s.status} — ${s.promptCount} prompts, $${s.totalCost.toFixed(2)}${s.hasClaudeSession ? ' (resumable)' : ''}`).join('\n');
        }
        case 'status': {
          const s = claudeSession.getSession(args.session_id);
          if (!s) return `Session not found: ${args.session_id}`;
          return `Session "${s.id}" — status: ${s.status}, prompts: ${s.promptCount}, cost: $${s.totalCost.toFixed(2)}`;
        }
        case 'cancel': {
          const r = claudeSession.cancel(args.session_id);
          return r.error || `Session ${args.session_id} cancelled.`;
        }
        case 'reset': {
          const r = claudeSession.resetSession(args.session_id);
          return r.error || `Session ${args.session_id} reset. Next prompt starts fresh.`;
        }
        case 'merge': {
          const task = taskManager.getTask(args.task_id);
          if (!task) return `Task not found: ${args.task_id}`;
          if (task.status !== 'completed') return `Task must be completed to merge. Status: ${task.status}`;
          if (!task.branch) return 'Task has no branch to merge.';
          if (!task.projectDir) return 'Task has no project directory.';
          try {
            const cwd = task.projectDir;
            let defaultBranch = 'main';
            try { defaultBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', { cwd, encoding: 'utf8' }).trim().replace('origin/', ''); } catch {}
            execSync(`git checkout ${defaultBranch}`, { cwd, stdio: 'pipe' });
            execSync(`git merge --no-ff ${task.branch} -m "Merge ${task.branch}: ${task.title}"`, { cwd, stdio: 'pipe' });
            let response = `Merged ${task.branch} into ${defaultBranch}.`;
            if (args.push) {
              execSync(`git push origin ${defaultBranch}`, { cwd, stdio: 'pipe', timeout: 30000 });
              response += ' Pushed to remote.';
            }
            try { execSync(`git branch -d ${task.branch}`, { cwd, stdio: 'pipe' }); } catch {}
            return response;
          } catch (e) { return `Merge failed: ${e.message}`; }
        }
        case 'set_budget': {
          costs.setBudget('claude', args.daily, args.monthly);
          return `Claude budget set: $${args.daily}/day, $${args.monthly}/month`;
        }
        default: return `Unknown manage_session action: ${args.action}`;
      }
    }

    case 'manage_memory': {
      switch (args.action) {
        case 'daily_write': {
          memory.appendDailyNote(args.section, args.content);
          memory.autoCurate('append-daily-note', { section: args.section, content: args.content.slice(0, 100) });
          return `Added to daily note (${args.section}): ${args.content.slice(0, 100)}`;
        }
        case 'daily_read': {
          const note = memory.readDailyNote(args.date);
          if (!note) return args.date ? `No daily note found for ${args.date}.` : 'No daily note for today yet.';
          return note;
        }
        case 'store': {
          if (!vectorMemory) return 'Vector memory not available.';
          const result = await vectorMemory.store(args.content, {
            type: args.type, projectId: args.project_id || null, tags: args.tags || [],
          });
          return result.stored ? `Stored in vector memory (${args.type}).` : `Failed to store: ${result.error}`;
        }
        case 'search': {
          if (!vectorMemory) return 'Vector memory not available.';
          wsSend({ type: 'status', text: 'Searching memory...' });
          const results = await vectorMemory.search(args.query, {
            limit: args.limit || 5, type: args.type || null, projectId: args.project_id || null,
          });
          if (!results.length) return 'No relevant results found.';
          return results.map((r, i) => `${i + 1}. [${r.metadata.type}] (score: ${r.score.toFixed(2)}) ${r.content.slice(0, 300)}`).join('\n\n');
        }
        case 'decide': {
          const filePath = memory.recordDecision(args.title, args.content, args.project_slug);
          if (vectorMemory) {
            vectorMemory.store(`Decision: ${args.title}\n${args.content}`, { type: 'decision', projectId: args.project_slug || null, tags: ['decision'] }).catch(() => {});
          }
          return `Decision recorded: "${args.title}" → ${filePath}`;
        }
        case 'update_section': {
          const check = memory.isSafeAutoCuration('update-memory-section', 'MEMORY.md');
          if (!check.safe) return `Cannot auto-update: ${check.reason}. Propose a brain update instead.`;
          const success = memory.updateMemoryMdSection(args.section, args.content);
          if (success) {
            brain.invalidateMemoryCache();
            memory.autoCurate('update-memory-section', { section: args.section });
            return `Updated MEMORY.md section: "${args.section}"`;
          }
          return 'Failed to update MEMORY.md.';
        }
        case 'learn_pref': {
          memory.learnPreference(args.key, args.value);
          return `Learned preference: ${args.key} = ${args.value}`;
        }
        case 'create_skill': {
          const skill = memory.createSkill(args.title, args.description, args.steps, args.triggers);
          return `Skill created: "${skill.name}" (triggers: ${(args.triggers || []).join(', ')})`;
        }
        case 'brain_update': {
          const update = brain.proposeBrainUpdate(args.file, args.section, args.old_text || null, args.new_text || args.content, args.reason);
          wsSend({ type: 'brain-update-proposed', update });
          return `Brain update proposed for ${args.file}/${args.section}: "${args.reason}". Awaiting approval.`;
        }
        default: return `Unknown manage_memory action: ${args.action}`;
      }
    }

    default:
      return `Unknown function: ${name}`;
  }
}

module.exports = {
  TOOLS,
  CLAUDE_TOOLS,
  executeFunction,
};
