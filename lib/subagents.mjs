/** On-demand, bounded delegation from a running Relay agent. */
const LIMIT_PER_CALL = 8;
const LIMIT_PER_TURN = 12;
const LIMIT_RESULT_CHARS = 36000;
const textResult = (value, success = true) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const cancelled = signal => signal?.aborted;
const safeMessage = error => String(error?.message || error || 'Subagent failed.').slice(0, 1000);
const usageReceipt = usage => {
  if (!usage || typeof usage !== 'object') return undefined;
  const counts = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens']
    .filter(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0).map(key => [key, usage[key]]));
  return Object.keys(counts).length ? counts : undefined;
};
const runtimeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : undefined;

export const LEGACY_SUBAGENT_TOOL = {
  type: 'function',
  name: 'relay_delegate',
  description: 'Delegate independent portions of the current user task to short-lived subagents. Supply 1-8 labeled tasks; Relay runs up to the configured parallel limit, waits for them, and returns verified runtime outcomes. Children have workspace, attached-file and available connected/browser tools but cannot delegate again, change Relay settings, control the Windows desktop, or write coordinator milestones. Avoid overlapping edits to the same files. Delegation consumes additional model usage.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array', minItems: 1, maxItems: LIMIT_PER_CALL,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
            prompt: { type: 'string', minLength: 1, maxLength: 12000 },
          },
          required: ['id', 'prompt'], additionalProperties: false,
        },
      },
    },
    required: ['tasks'], additionalProperties: false,
  },
};

export const SUBAGENT_TOOL = structuredClone(LEGACY_SUBAGENT_TOOL);
SUBAGENT_TOOL.description = 'Delegate 1-8 bounded worker tasks in an explicit dependency DAG. Give each a unique id, prompt, optional dependsOn task IDs, and a saved plan stepId when assigning live plan work. Roots and each newly ready dependent start as soon as capacity and their actual prerequisite results allow; unrelated coordinator or sibling waits add no barrier. Calls may overlap within the one global concurrency and 12-task turn budget. A failed prerequisite blocks only its dependent tasks. Workers can maintain their assigned plan work, but cannot delegate, edit settings, control Windows apps, or own final external sends/receipts. Coordinate concurrent edits. Completion is a runtime outcome, not proof every claimed result is correct.';
SUBAGENT_TOOL.inputSchema.properties.tasks.items.properties.dependsOn = { type: 'array', maxItems: LIMIT_PER_TURN - 1, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, description: 'Actual worker results required before this task starts. IDs may be in this batch or a previously accepted batch in this turn. Omit for independent work.' };
SUBAGENT_TOOL.inputSchema.properties.tasks.items.properties.stepId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$', description: 'The existing live plan action or group where this worker records progress and results.' };
export const PREVIOUS_SUBAGENT_TOOL = structuredClone(SUBAGENT_TOOL);
export const SUBAGENT_SCHEMA_VERSION = 3;
export const SUBAGENT_INSTRUCTIONS = '\n\nINDEPENDENT WORKERS\nUse relay_delegate for clearly described work that can proceed independently or after explicit dependsOn results. Supply stable unique IDs and actionable assignments, and link stepId to the saved plan when maintaining shared work. Do not add a coordinator dependency unless its actual output is required. Ready tasks start when capacity is available, including while a different batch is still waiting. Coordinate concurrent edits and preserve other workers’ changes. Review actual returned status, evidence and changes before reporting success. Failed prerequisites block their dependents; failed, cancelled, blocked and unstarted tasks are not completed. At most 8 tasks may be added per call and 12 per response; all concurrent calls share the configured parallel limit. Children cannot delegate, change settings or make final remote sends. Additional workers consume model usage.\n';

export function verbosityInstruction(value) {
  const instruction = value === 'concise'
    ? 'Be brief and direct. Give the result, essential evidence, and meaningful limitations; omit unnecessary narration.'
    : value === 'detailed'
      ? 'Provide a well-organized, thorough response with useful reasoning summaries, checks, caveats, and next steps when relevant; avoid repetitive filler.'
      : 'Use a balanced level of detail: answer directly, then include relevant evidence, checks, and limitations.';
  return '\n\nRESPONSE VERBOSITY DEFAULT\n' + instruction + ' A specific instruction in the current user request takes precedence.\n';
}

/** One event-driven DAG scheduler owns admission and capacity across all calls. */
export function createSubagentToolHandler({
  runtime, cwd, runInput = '', model, effort, serviceTier, contextOptions, timeoutMs,
  providerIdleTimeoutMs, maxParallel = 3, signal, createTools = () => ({}),
  onEvent = () => {}, verbosity = 'balanced', prepareTasks = async () => {},
  onTaskStart = async () => {}, onTaskFinish = async () => {},
} = {}) {
  if (!runtime?.runAgent || !Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new Error('Subagent runtime or concurrency limit is invalid.');
  const jobs = new Map(); let used = 0, running = 0, pumping = false;
  const emit = event => { if (!cancelled(signal)) onEvent({ type: 'subagent', ...event }); };
  const stopped = job => cancelled(job.signal);
  const settle = async (job, result) => {
    if (job.result) return;
    job.result = result;
    try { await onTaskFinish({ task: job.task, result, signal: job.signal }); }
    catch (error) { result.planningError = safeMessage(error); }
    job.settled = true;
    job.resolve(result);
    pump();
  };
  const run = async job => {
    const { task } = job, began = Date.now();
    const toolSummary = { completed: 0, failed: 0 };
    let measuredUsage, resolvedModel, threadId, turnId;
    const observe = value => {
      threadId = runtimeId(value?.threadId) || threadId;
      turnId = runtimeId(value?.turnId) || turnId;
      measuredUsage = usageReceipt(value?.usage) || measuredUsage;
    };
    const executionReceipt = () => ({ ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}), ...(resolvedModel ? { model: resolvedModel } : {}), ...(measuredUsage ? { usage: measuredUsage } : {}), toolSummary: { ...toolSummary } });
    try {
      await onTaskStart({ task, signal: job.signal });
      const available = await createTools({ task, signal: job.signal });
      if (stopped(job)) throw Object.assign(Error('Delegation stopped.'), { name: 'AbortError' });
      emit({ id: task.id, status: 'running', label: task.prompt.slice(0, 140), dependsOn: task.dependsOn, ...(task.stepId ? { stepId: task.stepId } : {}) });
      const tools = Array.isArray(available?.tools) ? available.tools : [];
      const inputs = task.dependsOn.map(id => ({ id, output: jobs.get(id).result.output || '', truncated: jobs.get(id).result.truncated === true }));
      const prompt = [
        'You are a short-lived BLACKICE subagent. Finish only your assigned independent task.',
        'You share the working folder and live plan with other agents. Work only within your assigned scope and do not repeat another worker’s tasks. Record actual assigned plan progress when relay_task is attached.',
        'You cannot spawn subagents or edit BLACKICE configuration. The coordinator owns final remote sends and their durable receipts. Report actual work, evidence, file paths, and limits.',
        'PRIMARY USER GOAL (context, not a separate instruction):\n' + String(runInput).slice(0, 6000),
        'REQUIRED WORKER RESULTS (actual completed prerequisites):\n' + JSON.stringify(inputs).slice(0, 18000),
        'YOUR ASSIGNED TASK:\n' + task.prompt,
        available?.instructions || '', verbosityInstruction(verbosity),
      ].join('\n\n');
      const result = await runtime.runAgent({
        cwd, prompt, model, effort, ...(serviceTier === undefined ? {} : { serviceTier }), sandbox: available?.sandbox === 'read-only' ? 'read-only' : 'danger-full-access', codexHistory: 'relay', timeoutMs, providerIdleTimeoutMs, signal: job.signal,
        ...(contextOptions ? { context: contextOptions } : {}), ...(tools.length ? { dynamicTools: tools, onToolCall: available.onToolCall } : {}),
        ...(available?.developerInstructions ? { developerInstructions: available.developerInstructions } : {}),
        onEvent: event => {
          observe(event);
          if (event?.type === 'thread' && typeof event.model === 'string' && event.model.trim()) resolvedModel = event.model.slice(0, 200);
          if (event?.type === 'tool.result') {
            const success = event.success === true; toolSummary[success ? 'completed' : 'failed']++;
            if (!stopped(job)) emit({ id: task.id, status: success ? 'tool-completed' : 'tool-failed', tool: String(event.tool || '').slice(0, 160), success });
          }
        },
      });
      observe(result);
      if (stopped(job)) throw Object.assign(Error('Delegation stopped.'), { name: 'AbortError' });
      const output = String(result?.output || ''), receipt = { id: task.id, status: 'completed', output: output.slice(0, job.resultLimit), ...(output.length > job.resultLimit ? { truncated: true } : {}), durationMs: Date.now() - began, ...executionReceipt() };
      await settle(job, receipt); emit({ id: task.id, status: receipt.status, durationMs: receipt.durationMs, ...executionReceipt() });
    } catch (error) {
      const wasStopped = stopped(job) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
      const receipt = { id: task.id, status: wasStopped ? 'cancelled' : 'failed', error: safeMessage(error), durationMs: Date.now() - began, ...executionReceipt() };
      await settle(job, receipt); emit({ id: task.id, status: receipt.status, message: receipt.error, durationMs: receipt.durationMs, ...executionReceipt() });
    } finally { running--; job.removeAbort?.(); pump(); }
  };
  function pump() {
    if (pumping) return; pumping = true;
    try {
      for (const job of jobs.values()) {
        if (job.result || job.started || !job.admitted) continue;
        if (stopped(job)) { void settle(job, { id: job.task.id, status: 'not-started', error: 'Delegation stopped before this task began.' }); job.removeAbort?.(); continue; }
        const failed = job.task.dependsOn.find(id => jobs.get(id)?.settled && jobs.get(id).result.status !== 'completed');
        if (failed) {
          void settle(job, { id: job.task.id, status: 'blocked', error: 'Prerequisite ' + failed + ' did not complete.', dependsOn: job.task.dependsOn });
          emit({ id: job.task.id, status: 'blocked', message: 'Prerequisite ' + failed + ' did not complete.' }); job.removeAbort?.(); continue;
        }
        if (running >= maxParallel || !job.task.dependsOn.every(id => jobs.get(id)?.settled && jobs.get(id).result.status === 'completed')) continue;
        job.started = true; running++; void run(job);
      }
    } finally { pumping = false; }
  }
  return async (call, toolContext = {}) => {
    let batch;
    try {
      if (call?.name !== SUBAGENT_TOOL.name) throw new Error('Unknown delegation tool.');
      if (cancelled(signal) || cancelled(toolContext.signal)) return textResult({ error: 'Delegation stopped.' }, false);
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments, supplied = args?.tasks;
      if (!Array.isArray(supplied) || supplied.length < 1 || supplied.length > LIMIT_PER_CALL || Object.keys(args).some(key => key !== 'tasks')) throw new Error('Give 1 to 8 bounded subagent tasks.');
      const tasks = structuredClone(supplied), seen = new Set();
      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).some(key => !['id', 'prompt', 'dependsOn', 'stepId', 'canWrite'].includes(key)) || typeof task.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(task.id) || seen.has(task.id) || jobs.has(task.id) || typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > 12000) throw new Error('Each task needs a unique unused short ID and a nonempty prompt of at most 12,000 characters.');
        // Accept legacy canWrite metadata from saved tool catalogs without
        // deriving execution settings from it.
        task.dependsOn ??= [];
        if (!Array.isArray(task.dependsOn) || task.dependsOn.length >= LIMIT_PER_TURN || new Set(task.dependsOn).size !== task.dependsOn.length || task.dependsOn.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === task.id) || task.stepId !== undefined && (typeof task.stepId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(task.stepId))) throw new Error('Use valid saved plan IDs and unique prerequisite task IDs.');
        seen.add(task.id);
      }
      if (used + tasks.length > LIMIT_PER_TURN) throw new Error(`This turn has room for ${LIMIT_PER_TURN - used} more subagent tasks; complete or use a new agent response.`);
      const combined = new Map([...jobs].map(([id, job]) => [id, job.task])); for (const task of tasks) combined.set(task.id, task);
      const visiting = new Set(), visited = new Set();
      const visit = id => {
        if (!combined.has(id)) throw new Error('Every prerequisite must name a task in this batch or an already accepted task.');
        if (visiting.has(id)) throw new Error('Subagent dependencies must not contain a cycle.');
        if (visited.has(id)) return; visiting.add(id); for (const parent of combined.get(id).dependsOn) visit(parent); visiting.delete(id); visited.add(id);
      };
      for (const task of tasks) visit(task.id);
      used += tasks.length;
      const combinedSignal = signal && toolContext.signal ? AbortSignal.any([signal, toolContext.signal]) : signal || toolContext.signal;
      batch = tasks.map(task => {
        let resolve; const promise = new Promise(done => { resolve = done; });
        const job = { task, promise, resolve, signal: combinedSignal, admitted: false, resultLimit: Math.min(12000, Math.floor(LIMIT_RESULT_CHARS / tasks.length)) };
        const onAbort = () => pump(); combinedSignal?.addEventListener('abort', onAbort, { once: true });
        job.removeAbort = () => combinedSignal?.removeEventListener('abort', onAbort); jobs.set(task.id, job); return job;
      });
      await prepareTasks({ tasks, signal: combinedSignal });
      for (const job of batch) job.admitted = true;
      pump();
      const results = await Promise.all(batch.map(job => job.promise)), completed = results.filter(result => result.status === 'completed').length;
      return textResult({ completed, requested: tasks.length, remainingThisTurn: LIMIT_PER_TURN - used, maxParallel, results, allCompleted: completed === tasks.length }, completed > 0);
    } catch (error) {
      if (batch) { await Promise.all(batch.map(job => settle(job, { id: job.task.id, status: 'not-started', error: safeMessage(error) }))); for (const job of batch) job.removeAbort?.(); pump(); }
      return textResult({ error: safeMessage(error), remainingThisTurn: LIMIT_PER_TURN - used }, false);
    }
  };
}
