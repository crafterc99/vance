/**
 * Browser Agent — Navigate → Interact → Extract
 *
 * Multi-step browser automation agent for tasks like:
 * - Checking website status
 * - Filling forms
 * - Extracting structured data from pages
 * - Taking screenshots for review
 */

const toolRouter = require('../tools/tool_router');
const logger = require('../runtime/logger');

const description = 'Browser automation agent: navigate → interact → extract';

/**
 * Run a browser automation workflow.
 *
 * @param {object} input - { task, url, steps, extractSelectors }
 * @param {object} context - { wsSend }
 * @returns {object} { success, steps, data }
 */
async function run(input, context = {}) {
  const { task, url, steps = [], extractSelectors } = input;
  const { wsSend } = context;

  if (!url && !steps.length) throw new Error('Missing required field: url or steps');

  const startTime = Date.now();
  const stepResults = [];

  const emit = (step, status, detail) => {
    if (wsSend) wsSend({ type: 'agent-step', agent: 'browser', step, status, detail });
    logger.log('agent-step', { agent: 'browser', step, status });
  };

  try {
    // If simple URL task (no steps), do navigate + extract
    if (url && !steps.length) {
      emit('navigate', 'running', `Loading ${url}...`);
      const navResult = await toolRouter.execute_tool('browser', {
        action: 'navigate', url,
      }, context);

      if (!navResult.success) {
        return { success: false, error: navResult.error, duration: Date.now() - startTime };
      }

      stepResults.push({ step: 'navigate', status: 'complete', data: navResult.result });
      emit('navigate', 'complete', navResult.result?.title || url);

      // Extract if selectors provided
      if (extractSelectors) {
        emit('extract', 'running', 'Extracting data...');
        const extractResult = await toolRouter.execute_tool('browser', {
          action: 'extract', url, selector: extractSelectors,
        }, context);
        stepResults.push({ step: 'extract', status: 'complete', data: extractResult.result });
        emit('extract', 'complete', `Extracted ${(extractResult.result?.extracted || []).length} elements`);
      }

      // Screenshot
      if (input.screenshot) {
        emit('screenshot', 'running', 'Taking screenshot...');
        const ssResult = await toolRouter.execute_tool('browser', {
          action: 'screenshot', url, fullPage: input.fullPage,
        }, context);
        stepResults.push({ step: 'screenshot', status: 'complete', data: ssResult.result });
        emit('screenshot', 'complete', ssResult.result?.path || 'saved');
      }

      const duration = Date.now() - startTime;
      logger.log('agent-complete', { agent: 'browser', duration });

      return {
        success: true,
        steps: stepResults,
        data: stepResults.map(s => s.data),
        duration,
      };
    }

    // Execute defined steps in sequence
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepName = step.name || `step-${i + 1}`;
      emit(stepName, 'running', step.description || `Running ${step.action}...`);

      const result = await toolRouter.execute_tool('browser', {
        action: step.action,
        url: step.url || url,
        selector: step.selector,
        text: step.text,
        script: step.script,
        waitFor: step.waitFor,
        path: step.path,
        fullPage: step.fullPage,
      }, context);

      if (!result.success) {
        stepResults.push({ step: stepName, status: 'error', error: result.error });
        emit(stepName, 'error', result.error);

        if (step.required !== false) {
          // Required step failed — abort
          return {
            success: false,
            steps: stepResults,
            error: `Step "${stepName}" failed: ${result.error}`,
            duration: Date.now() - startTime,
          };
        }
        continue;
      }

      stepResults.push({ step: stepName, status: 'complete', data: result.result });
      emit(stepName, 'complete', 'Done');
    }

    const duration = Date.now() - startTime;
    logger.log('agent-complete', { agent: 'browser', duration, steps: stepResults.length });

    return {
      success: true,
      steps: stepResults,
      data: stepResults.map(s => s.data),
      duration,
    };

  } catch (e) {
    logger.log('agent-error', { agent: 'browser', error: e.message });
    return {
      success: false,
      steps: stepResults,
      error: e.message,
      duration: Date.now() - startTime,
    };
  }
}

module.exports = { run, description };
