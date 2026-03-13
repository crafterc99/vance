/**
 * Coding Agent — Multi-step coding workflow orchestrator
 *
 * Workflow: Analyze → Plan → Execute → Verify → Report
 *
 * Uses Claude Code tool for implementation, memory tool for context,
 * and project tool for state tracking.
 */

const toolRouter = require('../tools/tool_router');
const logger = require('../runtime/logger');

const description = 'Multi-step coding agent: analyze → plan → execute → verify';

/**
 * Run a coding agent workflow.
 *
 * @param {object} input - { task, directory, projectId, steps, maxBudget }
 * @param {object} context - { wsSend, projectId }
 * @returns {object} { success, steps, result, totalCost }
 */
async function run(input, context = {}) {
  const { task, directory, projectId, maxBudget = 5 } = input;
  const { wsSend } = context;

  if (!task) throw new Error('Missing required field: task');

  const startTime = Date.now();
  const stepResults = [];
  let totalCost = 0;

  const emit = (step, status, detail) => {
    if (wsSend) wsSend({ type: 'agent-step', agent: 'coding', step, status, detail });
    logger.log('agent-step', { agent: 'coding', step, status });
  };

  try {
    // Step 1: Gather context from memory
    emit('context', 'running', 'Gathering project context...');
    let memoryContext = '';
    try {
      const memResult = await toolRouter.execute_tool('memory', {
        action: 'search', query: task, limit: 3, projectId,
      }, context);
      if (memResult.success && memResult.result) {
        const results = memResult.result;
        const vectorSnippets = (results.vector || []).map(v => v.content).join('\n');
        const jsonSnippets = (results.json || []).map(j => j.content).join('\n');
        memoryContext = [vectorSnippets, jsonSnippets].filter(Boolean).join('\n---\n');
      }
    } catch {}
    stepResults.push({ step: 'context', status: 'complete', hasContext: !!memoryContext });
    emit('context', 'complete', memoryContext ? 'Found relevant context' : 'No prior context');

    // Step 2: Execute the coding task
    emit('execute', 'running', 'Running Claude Code...');
    const enhancedTask = memoryContext
      ? `Context from previous work:\n${memoryContext.slice(0, 2000)}\n\n---\n\nTask: ${task}`
      : task;

    const codeResult = await toolRouter.execute_tool('claude_code', {
      action: 'execute',
      task: enhancedTask,
      directory: directory || undefined,
      timeout: 300,
    }, context);

    if (codeResult.success) {
      totalCost += codeResult.result?.costUsd || 0;
      stepResults.push({
        step: 'execute',
        status: 'complete',
        output: codeResult.result?.output?.slice(0, 2000),
        cost: codeResult.result?.costUsd || 0,
        toolCalls: codeResult.result?.toolCalls || [],
      });
      emit('execute', 'complete', `Done ($${(codeResult.result?.costUsd || 0).toFixed(2)})`);
    } else {
      stepResults.push({ step: 'execute', status: 'error', error: codeResult.error });
      emit('execute', 'error', codeResult.error);
    }

    // Step 3: Record outcome in memory
    emit('record', 'running', 'Saving to memory...');
    try {
      await toolRouter.execute_tool('memory', {
        action: 'store',
        content: `Coding task: ${task}\nResult: ${codeResult.success ? 'success' : 'failed'}\nCost: $${totalCost.toFixed(2)}`,
        type: 'task-outcome',
        projectId,
        tags: ['coding', 'task'],
      }, context);
    } catch {}
    stepResults.push({ step: 'record', status: 'complete' });
    emit('record', 'complete', 'Saved');

    // Budget check
    if (totalCost > maxBudget) {
      logger.log('agent-budget-exceeded', { agent: 'coding', cost: totalCost, budget: maxBudget });
    }

    const duration = Date.now() - startTime;
    logger.log('agent-complete', { agent: 'coding', duration, cost: totalCost, success: codeResult.success });

    return {
      success: codeResult.success,
      steps: stepResults,
      result: codeResult.result?.output?.slice(0, 5000) || codeResult.error,
      totalCost,
      duration,
    };

  } catch (e) {
    const duration = Date.now() - startTime;
    logger.log('agent-error', { agent: 'coding', error: e.message, duration });
    return {
      success: false,
      steps: stepResults,
      result: e.message,
      totalCost,
      duration,
    };
  }
}

module.exports = { run, description };
