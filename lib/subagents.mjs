/** On-demand, bounded delegation from a running Relay agent. */
import {createHash} from 'node:crypto';
import {readOnlyToolDenial} from './worker-permissions.mjs';
import {evaluateParallelAdmission} from './subagent-simple-gate.mjs';

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

export const SUBAGENT_TOOL={
  "type": "function",
  "name": "relay_delegate",
  "description": "Run independent worker tasks and return their actual statuses, outputs and receipts. Each task needs a unique id and prompt; dependsOn names worker results it needs. Workers inherit this model and available access. readOnly prevents file changes, commands and external mutations. stepId assigns an existing plan item when planning is used. A failed prerequisite blocks its dependents.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tasks": {
        "type": "array",
        "minItems": 1,
        "maxItems": 8,
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 64,
              "pattern": "^[A-Za-z0-9_-]+$"
            },
            "prompt": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12000
            },
            "dependsOn": {
              "type": "array",
              "maxItems": 11,
              "uniqueItems": true,
              "items": {
                "type": "string",
                "pattern": "^[A-Za-z0-9_-]{1,64}$"
              },
              "description": "Actual worker results required before this task starts. IDs may be in this batch or a previously accepted batch in this turn. Omit for independent work."
            },
            "stepId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$",
              "description": "The existing live plan action or group where this worker records progress and results."
            },
            "readOnly": {
              "type": "boolean",
              "description": "Run this fresh worker read-only. Source inspection and assigned plan notes remain available; workspace writes, commands and external mutations are denied. Omit to inherit the parent boundary."
            }
          },
          "required": [
            "id",
            "prompt"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "tasks"
    ],
    "additionalProperties": false
  }
};
export const SUBAGENT_SCHEMA_VERSION = 7;
export const SUBAGENT_INSTRUCTIONS = "\nINDEPENDENT WORKERS\nGive each worker one clear output, its inputs, owned files and a check for completion. Use dependsOn only for a result the task actually needs. Keep one writer per file and inspect returned changes and checks before integrating them. Up to 8 tasks per call and 12 per response share the configured parallel capacity. Delegation is admitted when at least two tasks can overlap and two worker slots are available; otherwise continue directly. Workers inherit the model and access, and cannot delegate or change settings. A started or returned worker is not proof that its requested outcome succeeded.\n";

export function subagentInstructionsForExecution({ executionGuardrails = false, planningContractVersion } = {}) {
  const assignment = planningContractVersion === 14
    ? 'stepId names an existing canonical work item. It assigns that item without creating child plan nodes. Omit it for independent work when planning is optional. Preserve other owners and shared criteria.\n'
    : 'Use stepId only for an existing item in the attached task schema.\n';
  const effects = executionGuardrails
    ? 'The coordinator owns final external sends in this execution mode; workers return their prepared work and observed receipts.\n'
    : 'Workers may perform requested external actions within their assignment using their attached tools.\n';
  return SUBAGENT_INSTRUCTIONS + assignment + effects;
}
export function subagentToolForExecution(tool, { executionGuardrails = false, planningContractVersion } = {}) {
  const next = structuredClone(tool);
  next.description = subagentInstructionsForExecution({ executionGuardrails, planningContractVersion });
  if (planningContractVersion === 14)
    next.inputSchema.properties.tasks.items.properties.stepId.description = 'Existing canonical work-item ID to assign to this worker. The item and its evidence keep their IDs.';
  return next;
}

/** One event-driven DAG scheduler owns admission and capacity across all calls. */
export function createSubagentToolHandler({
  runtime, cwd, runInput = '', model, effort, serviceTier, contextOptions, timeoutMs,
  providerIdleTimeoutMs, maxParallel = 3, signal, createTools = () => ({}),
  onEvent = () => {}, prepareTasks = async () => {},
  onTaskStart = async () => {}, onTaskFinish = async () => {}, beforeModel = null,
  onProviderDispatch = async () => {},
  getUserContext, onTaskRuntime = () => {}, executionGuardrails = false, planningContractVersion,
  onAdmission = () => {},
} = {}) {
  if (!runtime?.runAgent || !Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new Error('Subagent runtime or concurrency limit is invalid.');
  const jobs = new Map(); let used = 0, running = 0, pumping = false;
  const emit = event => { if (!cancelled(signal)) onEvent({ type: 'subagent', ...event }); };
  const stopped = job => cancelled(job.signal);
  const userContext = () => {
    const value = getUserContext ? getUserContext() : { currentUserRequest: { source: 'current-user-request', text: String(runInput) } };
    const text = JSON.stringify(value), limit = 16000;
    return { fingerprint: createHash('sha256').update(text).digest('hex'), truncated: text.length > limit,
      text: text.length > limit ? text.slice(0, limit / 2) + '\n[Actual user context excerpt: middle omitted]\n' + text.slice(-limit / 2) : text };
  };
  const finishUserContext = job => {
    if (!job.userContext) return;
    try { job.userContext.finishFingerprint = userContext().fingerprint; }
    catch { job.userContext.finishFingerprint = null; job.userContext.comparisonUnavailable = true; }
  };
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
    let selectedWorkerModel = null, hostRunAgentCallAttempted = false;
    const toolSummary = { completed: 0, failed: 0 };
    let measuredUsage, resolvedModel, threadId, turnId;
    const runtimeUpdates = [];
    const reportRuntime = starting => {
      const update = onTaskRuntime({task, starting, threadId, turnId, signal:job.signal});
      if (update?.then) { runtimeUpdates.push(update); update.catch(() => {}); }
    };
    const observe = value => {
      threadId = runtimeId(value?.threadId) || threadId;
      turnId = runtimeId(value?.turnId) || turnId;
      measuredUsage = usageReceipt(value?.usage) || measuredUsage;
    };
    const executionReceipt = () => ({ ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}), ...(resolvedModel ? { model: resolvedModel } : {}), ...(measuredUsage ? { usage: measuredUsage } : {}),
      ...(job.userContext ? { userContext: job.userContext, contextChangedSinceStart: job.userContext.comparisonUnavailable ? null : job.userContext.startFingerprint !== job.userContext.finishFingerprint } : {}),
      toolSummary: { ...toolSummary },
      // The host can prove whether runtime.runAgent was CALLED. This does not
      // prove that any external model/provider received a request.
      hostRunAgentCallAttempted });
    let available;
    try {
      await onTaskStart({ task, signal: job.signal });
      available = await createTools({ task, signal: job.signal });
      if (stopped(job)) throw Object.assign(Error('Delegation stopped.'), { name: 'AbortError' });
      const initialContext = userContext();
      job.userContext = { source: 'host-supplied-user-entries', startFingerprint: initialContext.fingerprint,
        finishFingerprint: initialContext.fingerprint, truncated: initialContext.truncated };
      emit({ id: task.id, status: 'running', label: task.prompt.slice(0, 140), dependsOn: task.dependsOn, ...(task.stepId ? { stepId: task.stepId } : {}) });
      const tools = Array.isArray(available?.tools) ? available.tools : [];
      const inputs = task.dependsOn.map(id => ({ id, output: jobs.get(id).result.output || '', truncated: jobs.get(id).result.truncated === true }));
      const instructionSections=[
        'You are a short-lived BLACKICE subagent. Finish only your assigned independent task.',
        'You share the working folder and live plan with other agents. Work only within your assigned scope and do not repeat another worker’s tasks. Record actual assigned plan progress when relay_task is attached.',
        planningContractVersion === 14 ? 'You cannot spawn subagents or edit BLACKICE configuration. Remain within the exact assigned canonical work-item scope and inherited authorization. The host journals operations automatically; report actual results, evidence and uncertainty without claiming a tool success confirmed the requested outcome.' : executionGuardrails === true ? 'You cannot spawn subagents or edit BLACKICE configuration. The coordinator owns final remote sends and their durable receipts. Report actual work, evidence, file paths, and limits.' : 'You cannot spawn subagents or edit BLACKICE configuration. Authorized external actions may be performed within your assignment using attached capabilities and inherited access; respect read-only assignments and actual user constraints. Report actual actions, effects and limits; no coordinator approval or external-receipt checkpoint is required.',
        'The latest user direction controls this assignment. Report actual findings and uncertainty; the coordinator verifies the combined result.',
      ].map((text,index)=>({id:'delegate-contract-'+(index+1),title:'Delegation mechanics',source:'lib/subagents.mjs',role:'user',text,reason:'This execution is a delegated assignment'}));
      const prompt = [
        ...instructionSections.slice(0,3).map(section=>section.text),
        'ACTUAL USER REQUEST CONTEXT (host-supplied provenance, not a worker-authored goal; excerpts are marked):\n' + initialContext.text,
        instructionSections[3].text,
        'REQUIRED WORKER RESULTS (actual completed prerequisites):\n' + JSON.stringify(inputs).slice(0, 18000),
        'YOUR ASSIGNED TASK:\n' + task.prompt,
        available?.instructions || '',
      ].join('\n\n');
      try{available?.onInstructionContextPrepared?.({prompt,sections:instructionSections});}catch{}
      reportRuntime(true);
      selectedWorkerModel=model;
      beforeModel?.({task,signal:job.signal,model:selectedWorkerModel});
      if(stopped(job))throw Object.assign(Error('Delegation stopped before provider admission.'),{name:'AbortError',code:'ABORT_ERR'});
      await onProviderDispatch({task,signal:job.signal,model:selectedWorkerModel});
      // A durable Swarm dispatch fence may await I/O beyond the Goal deadline.
      // Repeat the actual host wall-clock admission check after that await,
      // immediately before invoking the provider; timers are not proof.
      beforeModel?.({task,signal:job.signal,model:selectedWorkerModel});
      if (stopped(job)) throw Object.assign(Error('Delegation stopped before provider dispatch.'), { name: 'AbortError' });
      hostRunAgentCallAttempted = true;
      const result = await runtime.runAgent({
        cwd, prompt, model:selectedWorkerModel, effort, ...(serviceTier === undefined ? {} : { serviceTier }), sandbox: task.readOnly === true || available?.sandbox === 'read-only' ? 'read-only' : 'danger-full-access', codexHistory: 'relay', timeoutMs, providerIdleTimeoutMs, signal: job.signal,
        ...(contextOptions ? { context: contextOptions } : {}), ...(tools.length ? { dynamicTools: tools, onToolCall: (call, context) => readOnlyToolDenial(call, !(task.readOnly === true || available?.sandbox === 'read-only')) || available.onToolCall(call, context) } : {}),
        ...(available?.developerLayer!=null?{developerLayer:available.developerLayer}:{}),
        ...(available?.developerInstructions !== undefined ? { developerInstructions: available.developerInstructions } : {}),
        ...(available?.providerExecutionContract ? { providerExecutionContract: available.providerExecutionContract } : {}),
        ...(available?.hostOnlyTools === true ? { hostOnlyTools: true } : {}),
        ...(typeof available?.onToolResultDelivered === 'function' ? { onToolResultDelivered: available.onToolResultDelivered } : {}),
        ...(typeof available?.onInstructionAuditPrepared === 'function' ? { onInstructionAuditPrepared: available.onInstructionAuditPrepared } : {}),
        ...(typeof available?.onPromptAccepted === 'function' ? { onPromptAccepted: available.onPromptAccepted } : {}),
        ...(typeof available?.onBeforeFinal === 'function' ? { onBeforeFinal: available.onBeforeFinal } : {}),
        onEvent: event => {
          observe(event);
          if (event?.threadId || event?.turnId) reportRuntime(false);
          if (event?.type === 'thread' && typeof event.model === 'string' && event.model.trim()) resolvedModel = event.model.slice(0, 200);
          if (event?.type === 'tool.result') {
            available?.onActionReceipt?.(event);
            const success = event.success === true; toolSummary[success ? 'completed' : 'failed']++;
            if (!stopped(job)) emit({ id: task.id, status: success ? 'tool-completed' : 'tool-failed', tool: String(event.tool || '').slice(0, 160), success });
          }
        },
      });
      await Promise.all(runtimeUpdates);
      observe(result);
      await available?.close?.();
      finishUserContext(job);
      if (stopped(job)) throw Object.assign(Error('Delegation stopped.'), { name: 'AbortError' });
      if (typeof available?.validateFinal === 'function') await available.validateFinal(result);
      if (stopped(job)) throw Object.assign(Error('Delegation stopped.'), { name: 'AbortError' });
      const output = String(result?.output || ''), receipt = { id: task.id, status: 'completed', output: output.slice(0, job.resultLimit), ...(output.length > job.resultLimit ? { truncated: true } : {}), durationMs: Date.now() - began, ...executionReceipt() };
      await settle(job, receipt); emit({ id: task.id, status: receipt.status, durationMs: receipt.durationMs, ...executionReceipt() });
    } catch (error) {
      await Promise.allSettled(runtimeUpdates);
      finishUserContext(job);
      const wasStopped = stopped(job) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
      const receipt = { id: task.id, status: wasStopped ? 'cancelled' : 'failed', error: safeMessage(error), durationMs: Date.now() - began, ...executionReceipt() };
      await settle(job, receipt); emit({ id: task.id, status: receipt.status, message: receipt.error, durationMs: receipt.durationMs, ...executionReceipt() });
    } finally { try{await available?.close?.();}catch{} running--; job.removeAbort?.(); pump(); }
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
      if (!Array.isArray(supplied) || supplied.length < 1 || supplied.length > LIMIT_PER_CALL || Object.keys(args).some(key => key!=='tasks')) throw new Error('Give 1 to 8 bounded subagent tasks.');
      const tasks = structuredClone(supplied), seen = new Set();
      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).some(key => !['id', 'prompt', 'dependsOn', 'stepId', 'readOnly'].includes(key)) || typeof task.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(task.id) || seen.has(task.id) || jobs.has(task.id) || typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > 12000) throw new Error('Each task needs a unique unused short ID and a nonempty prompt of at most 12,000 characters.');
        if (task.readOnly !== undefined && typeof task.readOnly !== 'boolean') throw new Error('readOnly must be a boolean; omit it to inherit the parent boundary.');
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
      const admission=evaluateParallelAdmission({tasks,maxParallel});
      try{onAdmission({at:new Date().toISOString(),taskIds:tasks.map(x=>x.id),...admission})}catch{}
      if(!admission.allowed)return textResult({error:admission.reason,code:admission.code,
        guidance:'Continue with the coordinator rather than spending another provider turn on serial delegation.',
        gate:'static_dag',providerCalls:0},false);
      used += tasks.length;
      const combinedSignal = signal && toolContext.signal ? AbortSignal.any([signal, toolContext.signal]) : signal || toolContext.signal;
      batch = tasks.map(task => {
        let resolve; const promise = new Promise(done => { resolve = done; });
        const job = { task, promise, resolve, signal: combinedSignal, admitted: false, resultLimit: Math.min(12000, Math.floor(LIMIT_RESULT_CHARS / tasks.length)) };
        const onAbort = () => pump(); combinedSignal?.addEventListener('abort', onAbort, { once: true });
        job.removeAbort = () => combinedSignal?.removeEventListener('abort', onAbort); jobs.set(task.id, job); return job;
      });
      await prepareTasks({ tasks, signal: combinedSignal, toolContext });
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
