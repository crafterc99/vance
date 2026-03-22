/**
 * Claude Code Tool — Spawns Claude Code CLI for autonomous coding tasks
 *
 * Actions:
 *   execute  — Run a coding task with Claude Code in a project directory
 *   review   — Code review of a file or diff
 *   explain  — Explain code in a file
 */

const { spawn } = require('child_process');
const path = require('path');
const logger = require('../runtime/logger');

const description = 'Autonomous coding via Claude Code CLI';
const actions = ['execute', 'review', 'explain'];

/**
 * @param {object} input - { action, task, directory, allowedTools, timeout, maxBudget }
 * @param {object} context - { wsSend, projectId }
 */
async function execute(input, context = {}) {
  const { action = 'execute', task, directory, allowedTools, timeout = 300, maxBudget } = input;
  const { wsSend } = context;

  if (!task) throw new Error('Missing required field: task');

  const cwd = directory || process.env.HOME;

  switch (action) {
    case 'execute':
      return runClaudeCode(task, cwd, allowedTools, timeout, wsSend);
    case 'review':
      return runClaudeCode(
        `Review the following code and provide feedback on quality, bugs, and improvements:\n\n${task}`,
        cwd, ['Read', 'Glob', 'Grep'], timeout, wsSend
      );
    case 'explain':
      return runClaudeCode(
        `Explain the following code clearly and concisely:\n\n${task}`,
        cwd, ['Read', 'Glob', 'Grep'], timeout, wsSend
      );
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function runClaudeCode(task, cwd, allowedTools, timeoutSec, wsSend) {
  return new Promise((resolve, reject) => {
    const tools = allowedTools || [
      'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Bash(git *)', 'Bash(npm *)', 'Bash(node *)', 'Bash(ls *)', 'Bash(mkdir *)',
    ];

    const args = [
      '-p', task,
      '--output-format', 'stream-json',
      '--allowedTools', tools.join(','),
    ];

    if (wsSend) wsSend({ type: 'tool-execution', tool: 'claude_code', status: 'spawning' });

    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let costUsd = 0;
    const toolCalls = [];

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      logger.log('tool-error', { tool: 'claude_code', error: `Timeout after ${timeoutSec}s` });
    }, timeoutSec * 1000);

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text') {
                output += block.text;
                if (wsSend) wsSend({ type: 'claude-stream', content: block.text });
              } else if (block.type === 'tool_use') {
                toolCalls.push(block.name);
                if (wsSend) wsSend({ type: 'claude-tool', name: block.name });
              }
            }
          } else if (parsed.type === 'result') {
            costUsd = parsed.cost_usd || 0;
          }
        } catch {}
      }
    });

    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        output: output || 'Task completed.',
        exitCode: code,
        costUsd,
        toolCalls,
        stderr: code !== 0 ? stderr.slice(0, 500) : undefined,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn Claude Code: ${err.message}`));
    });
  });
}

module.exports = { execute, description, actions };
