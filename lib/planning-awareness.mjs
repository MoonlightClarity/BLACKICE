import { createHash } from 'node:crypto';
import { taskPlanAvailability } from './task-plan.mjs';
import { toolResultEvent } from './tool-outcomes.mjs';
import { rememberExecutionError } from './planning-execution.mjs';
import { createSequentialPlanningGuard } from './planning-sequence.mjs';

const clone = value => structuredClone(value);
const fail = (message, code = 'PLANNING_AWARENESS_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const identifier = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)) throw fail('Use a valid Planning identifier.');
  return value;
};
const parseArguments = call => { try { return typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; } catch { return null; } };
const receiptState = receipt => { try { return JSON.parse(receipt.contentItems?.find(item => item.type === 'inputText')?.text || 'null'); } catch { return null; } };
const errorReceipt = (code, message, extra = {}) => ({ success: false, code, contentItems: [{ type: 'inputText', text: JSON.stringify({ code, message, ...extra }) }] });

/** Include owned work, its actual prerequisites and enclosing branch/sequence
 * controls. Sibling parallel work supplies no accidental coordinator barrier. */
export function planningRelevance(state, scopeStepId = null) {
  const steps = state.steps || [], byId = new Map(steps.map(step => [step.id, step]));
  const own = new Set(), included = new Set(), ancestors = new Set();
  const subtree = (id, into) => {
    if (into.has(id)) return;
    into.add(id);
    for (const step of steps) if (step.parentId === id) subtree(step.id, into);
  };
  if (!scopeStepId) for (const step of steps) own.add(step.id);
  else if (byId.has(scopeStepId)) subtree(scopeStepId, own);
  for (const id of own) included.add(id);
  const availability = taskPlanAvailability(state);
  const pending = [...own];
  while (pending.length) {
    const id = pending.pop(), step = byId.get(id);
    if (!step) continue;
    for (let parentId = step.parentId; parentId; parentId = byId.get(parentId)?.parentId) {
      if (!included.has(parentId)) { included.add(parentId); ancestors.add(parentId); pending.push(parentId); }
    }
    for (const dependency of availability.byId[id]?.prerequisites || []) {
      const descendants = new Set(); subtree(dependency.id, descendants);
      for (const dependencyId of descendants) if (!included.has(dependencyId)) { included.add(dependencyId); pending.push(dependencyId); }
    }
  }
  const projected = steps.filter(step => included.has(step.id)).map(step => {
    const result = { ...step };
    // Group progress outside an ownership scope is derived from several workers.
    // Its branch/dependency controls are relevant; its aggregate progress is not.
    if (ancestors.has(step.id) && !own.has(step.id)) {
      delete result.status;
    }
    return result;
  });
  const projection = {
    goal: state.goal,
    plan: { layout: state.plan?.layout || 'sequence', selectedChildId: state.plan?.selectedChildId || null, detail: state.plan?.detail || null,
      ...(state.plan?.facts ? { facts: state.plan.facts } : {}), ...(state.plan?.branch ? { branch: state.plan.branch } : {}) },
    scopeStepId,
    scopeMissing: Boolean(scopeStepId && !byId.has(scopeStepId)),
    steps: projected,
    // A coordinator/global worker also sees global human context changes.
    ...(!scopeStepId ? { checkpoint: state.checkpoint || null } : {}),
  };
  return { signature: createHash('sha256').update(JSON.stringify(projection)).digest('hex'), stepIds: [...included], ownStepIds: [...own] };
}

/** Live presence and delivery receipts, deliberately separate from durable plan
 * revisions and execution completion. They expire/reset instead of inventing
 * knowledge after an application restart. */
export class PlanningAwareness {
  constructor({ clock = () => Date.now(), leaseMs = 20000, maxEditors = 100, maxWorkers = 512 } = {}) {
    this.clock = clock; this.leaseMs = leaseMs; this.maxEditors = maxEditors; this.maxWorkers = maxWorkers;
    this.presence = new Map(); this.workers = new Map(); this.listeners = new Set(); this.closed = false;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(taskId) { for (const listener of this.listeners) { try { listener({ taskId }); } catch {} } }
  prune() {
    const now = this.clock(), changed = new Set();
    for (const [key, value] of this.presence) if (Date.parse(value.expiresAt) <= now) { this.presence.delete(key); changed.add(value.taskId); }
    for (const taskId of changed) this.emit(taskId);
  }
  editorKey(taskId, actor, editorId) { return JSON.stringify([identifier(taskId), actor.type, identifier(actor.id), identifier(editorId)]); }
  setPresence(state, input, actor) {
    if (this.closed) throw fail('Planning presence is closed.', 'PLANNING_AWARENESS_CLOSED', 503);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['editorId', 'stepId'].includes(key))) throw fail('Use editorId and stepId only; drafts and identity are not accepted.');
    if (!actor || !['human-client', 'local-human'].includes(actor.type)) throw fail('Editing presence needs a verified human identity.', 'PLANNING_PRESENCE_FORBIDDEN', 403);
    const key = this.editorKey(state.taskId, actor, input.editorId), stepId = input.stepId === null ? null : identifier(input.stepId);
    if (stepId && !state.steps.some(step => step.id === stepId)) throw fail('This saved step is unavailable.', 'PLANNING_STEP_UNAVAILABLE', 404);
    this.prune();
    if (!this.presence.has(key) && this.presence.size >= this.maxEditors) throw fail('Too many active Planning editors. Try again after existing leases expire.', 'PLANNING_PRESENCE_LIMIT', 429);
    const label = String(actor.name || (actor.type === 'local-human' ? 'Local user' : 'Remote user')).slice(0, 120);
    this.presence.set(key, { taskId: state.taskId, editorId: input.editorId, stepId, label, actor: { type: actor.type, id: actor.id, ...(actor.name ? { name: label } : {}) }, expiresAt: new Date(this.clock() + this.leaseMs).toISOString() });
    this.emit(state.taskId); return this.snapshot(state);
  }
  clearPresence(state, input, actor) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'editorId')) throw fail('Release an editorId only.');
    if (!actor || !['human-client', 'local-human'].includes(actor.type)) throw fail('Editing presence needs a verified human identity.', 'PLANNING_PRESENCE_FORBIDDEN', 403);
    if (this.presence.delete(this.editorKey(state.taskId, actor, input.editorId))) this.emit(state.taskId);
    return this.snapshot(state);
  }
  register(state, { runId, nodeId, label, scopeStepId = null }) {
    identifier(runId); identifier(nodeId); if (scopeStepId) identifier(scopeStepId);
    if (this.closed) throw fail('Planning awareness is closed.', 'PLANNING_AWARENESS_CLOSED', 503);
    const id = `${runId}:${nodeId}`;
    if (this.workers.has(id)) throw fail('This worker is already registered.', 'PLANNING_WORKER_CONFLICT', 409);
    if (this.workers.size >= this.maxWorkers) {
      for (const [key, worker] of this.workers) { if (worker.status !== 'running') this.workers.delete(key); if (this.workers.size < this.maxWorkers) break; }
      if (this.workers.size >= this.maxWorkers) throw fail('The live Planning worker limit has been reached.', 'PLANNING_WORKER_LIMIT', 429);
    }
    const relevance = planningRelevance(state, scopeStepId);
    this.workers.set(id, { id, taskId: state.taskId, runId, nodeId, label: String(label || nodeId).slice(0, 120), scopeStepId, signature: relevance.signature, lastReadRevision: null, lastReadAt: null, status: 'running', startedAt: new Date(this.clock()).toISOString() });
    this.emit(state.taskId); return id;
  }
  observed(id, state, { read = false } = {}) {
    const worker = this.workers.get(id);
    if (!worker || worker.status !== 'running' || worker.taskId !== state.taskId) return;
    worker.signature = planningRelevance(state, worker.scopeStepId).signature;
    if (read) { worker.lastReadRevision = state.revision; worker.lastReadAt = new Date(this.clock()).toISOString(); }
    this.emit(state.taskId);
  }
  finish(id, status = 'completed') {
    const worker = this.workers.get(id); if (!worker) return;
    worker.status = ['completed', 'failed', 'cancelled'].includes(status) ? status : 'finished';
    worker.finishedAt = new Date(this.clock()).toISOString(); this.emit(worker.taskId);
  }
  finishRun(runId, status = 'finished') { for (const worker of this.workers.values()) if (worker.runId === runId && worker.status === 'running') this.finish(worker.id, status); }
  snapshot(state) {
    this.prune();
    const workers = [...this.workers.values()].filter(worker => worker.taskId === state.taskId).map(worker => {
      const { signature, taskId, ...publicWorker } = worker;
      const relevance = planningRelevance(state, worker.scopeStepId), pending = worker.status === 'running' && signature !== relevance.signature;
      return { ...publicWorker, stepIds: relevance.ownStepIds, pendingRevision: pending ? state.revision : null, state: worker.status !== 'running' ? 'finished' : pending ? 'needs-review' : worker.lastReadRevision === null ? 'unread' : 'current' };
    });
    return { taskId: state.taskId, revision: state.revision, leaseMs: this.leaseMs, presence: clone([...this.presence.values()].filter(item => item.taskId === state.taskId)), workers,
      note: 'Editing presence is advisory and contains no draft text. Read receipts record a saved plan delivered through the task tool, not comprehension. Saved changes are working context; mandatory fresh-read checkpoints apply only when execution guardrails are enabled. In-flight actions continue. Live presence and receipts reset on restart.' };
  }
  close() { this.closed = true; this.presence.clear(); this.workers.clear(); this.listeners.clear(); }
}

export async function createPlanningWorkerGuard({ store, taskId, runId, nodeId, label, scopeStepId = null, signal, onUpdated, onExecution, executionEnabled = false, sequentialEnabled = false, schemaVersion = 9, executionGuardrails = false } = {}) {
  const registry = store.awareness; let state;
  try { state = await store.get(taskId, { signal }); } catch (error) { if (executionGuardrails === true) throw error; onUpdated?.({ state: 'unavailable', message: 'Advisory planning context is unavailable; operational tools remain available.' }); return null; }
  if (!registry) return null;
  const id = registry.register(state, { runId, nodeId, label, scopeStepId });
  let lastNotice = '';
  const dispatches = new Map(), trackExecution = executionEnabled && typeof store.recordToolReceipt === 'function';
  const sequence = executionGuardrails === true && sequentialEnabled ? createSequentialPlanningGuard({ store, taskId, runId, nodeId, scopeStepId, schemaVersion, executionGuardrails: true }) : null;
  const publish = current => { onUpdated?.(registry.snapshot(current).workers.find(worker => worker.id === id)); };
  publish(state);
  return {
    id, idempotency: createToolCallIdempotency(),
    async before(call, context = {}) {
      const action = parseArguments(call)?.action;
      if (call.name === 'relay_task' && ['read', 'describe', 'draft_method'].includes(action)) return null;
      // Stop/report controls remain available even while saved work needs review.
      if (call.name === 'relay_browser_signin' || call.name === 'relay_control' && (['describe', 'catalog', 'operations_pause'].includes(action)
        || !sequence && ['workflow_get', 'observe_get', 'execution_get', 'runtime_get', 'operations_list', 'schedule_preview', 'job_get'].includes(action))) return null;
      if (executionGuardrails !== true) {
        if (trackExecution && call.name !== 'relay_task' && typeof call.callId === 'string') {
          let current; try { current = await store.get(taskId, { signal: context.signal || signal }); } catch {}
          const owned = current ? new Set(planningRelevance(current, scopeStepId).ownStepIds) : new Set();
          dispatches.set(call, { runId, nodeId, scopeStepId, planRevision: current?.revision || null, startedAt: new Date().toISOString(), activeStepIds: (current?.steps || []).filter(step => (step.kind || 'action') === 'action' && step.status === 'active' && owned.has(step.id)).map(step => step.id) });
          if (dispatches.size > 256) dispatches.delete(dispatches.keys().next().value);
        }
        return null;
      }
      const current = await store.get(taskId, { signal: context.signal || signal });
      const worker = registry.workers.get(id);
      if (!worker || worker.status !== 'running') return errorReceipt('TASK_PLAN_WORKER_FINISHED', 'This worker is no longer active. The requested operation has not run.');
      const relevance = planningRelevance(current, scopeStepId);
      if (relevance.signature !== worker.signature) {
        publish(current);
        return errorReceipt('TASK_PLAN_REVIEW_REQUIRED', 'Saved Planning changes affect your work. Call relay_task read, incorporate the current scope, dependencies, criteria and human notes, then decide which action remains appropriate. The requested operation has not run. Independent ownership scopes remain runnable.', { taskId, revision: current.revision, scopeStepId, lastReadRevision: worker.lastReadRevision });
      }
      if (scopeStepId && call.name !== 'relay_task') {
        const scope = taskPlanAvailability(current).byId[scopeStepId];
        if (!scope) return errorReceipt('TASK_PLAN_SCOPE_MISSING', 'Your assigned work is no longer in the saved plan. Read the current plan and report the changed assignment; the requested operation has not run.', { taskId, revision: current.revision, scopeStepId });
        const missing = scope.prerequisites.filter(item => !item.satisfied);
        if (missing.length || ['blocked', 'waiting', 'awaiting-choice', 'unselected', 'skipped'].includes(scope.state)) return errorReceipt('TASK_PLAN_NOT_READY', scope.reason || 'Your assigned work has an unmet prerequisite. Keep independent work moving and revisit this assignment when its prerequisite settles. The requested operation has not run.', { taskId, revision: current.revision, scopeStepId, dependencies: missing.map(item => ({ id: item.id, title: item.title })) });
      }
      if (sequence) {
        const denied = await sequence.before(call, { signal: context.signal || signal, expectedRevision: current.revision, ownedIds: new Set(relevance.ownStepIds) });
        if (denied) return denied;
      }
      if (trackExecution && call.name !== 'relay_task' && typeof call.callId === 'string') {
        const own = new Set(relevance.ownStepIds);
        dispatches.set(call, { runId, nodeId, scopeStepId, planRevision: current.revision, startedAt: new Date().toISOString(), activeStepIds: current.steps.filter(step => (step.kind || 'action') === 'action' && step.status === 'active' && own.has(step.id)).map(step => step.id) });
        // An uncooperative/aborted runtime cannot leave an unbounded map here.
        if (dispatches.size > 256) dispatches.delete(dispatches.keys().next().value);
      }
      return null;
    },
    after(call, receipt) {
      if (call.name !== 'relay_task' || receipt?.success !== true) return receipt;
      const current = receiptState(receipt), action = parseArguments(call)?.action;
      if (current?.taskId !== taskId || !Number.isSafeInteger(current.revision) || !Array.isArray(current.steps)) return receipt;
      registry.observed(id, current, { read: action === 'read' }); publish(current);
      if (action === 'read') {
        const item = receipt.contentItems.find(item => item.type === 'inputText');
        const snapshot = registry.snapshot(current), relevance = new Set(planningRelevance(current, scopeStepId).stepIds);
        const editors = snapshot.presence.filter(editor => editor.stepId === null || relevance.has(editor.stepId));
        item.text = JSON.stringify({ ...current, planningAwareness: { worker: snapshot.workers.find(worker => worker.id === id), presence: editors.slice(0, 20), totalRelevantEditors: editors.length, note: snapshot.note } });
      }
      return receipt;
    },
    async annotate(call, receipt, outcome) {
      if (sequence) receipt = await sequence.after(call, receipt, outcome);
      if (!receipt) return receipt;
      const dispatch = dispatches.get(call); dispatches.delete(call);
      if (trackExecution && dispatch) {
        let journalSaved = false;
        try {
          const saved = await store.recordToolReceipt(taskId, toolResultEvent(call, receipt), dispatch);
          journalSaved = true;
          if (saved?.observations && !saved.duplicate) onExecution?.(saved.observations);
          if (saved?.notice) {
            const current = await store.get(taskId), activeIds = new Set(saved.notice.activeStepIds);
            const checks = current.steps.filter(step => activeIds.has(step.id)).map(step => ({ stepId: step.id, status: step.status, doneWhen: step.doneWhen }));
            receipt = { ...receipt, contentItems: [...(receipt.contentItems || []), { type: 'inputText', text: JSON.stringify({ type: 'planning.execution', ...saved.notice, currentChecks: checks,
              note: saved.notice.kind === 'recurring-tool-error' ? 'Several calls in this work returned the same tool/action/error code; they may target different inputs. Use the actual errors and destination state to change the next action, and update useful recovery/progress state at the material milestone. Do not repeat an uncertain effect or add a new approval requirement.' : 'This exact operation now has a successful tool receipt. Different operations are not marked recovered; verify the destination or requested result before recording the milestone complete.' }) }] };
          }
        } catch {
          // A failed continuity write must never turn an already completed
          // operation into a retry-shaped error or imply it is durable.
          receipt = { ...receipt, contentItems: [...(receipt.contentItems || []), { type: 'inputText', text: JSON.stringify({ type: 'planning.execution-warning', code: journalSaved ? 'PLANNING_EXECUTION_CONTEXT_UNAVAILABLE' : 'PLANNING_EXECUTION_NOT_SAVED', callId: call.callId,
            note: journalSaved ? 'The runtime receipt was saved, but current plan criteria could not be read for a recovery annotation. The preceding tool retains its actual result. Reconcile the current plan and destination before changing progress.' : 'The preceding tool retains its actual result, but its Planning receipt could not be saved. Durability is not confirmed. Preserve this result and inspect the destination before any retry; no operation was replayed.' }) }] };
        }
      }
      if (!Array.isArray(receipt.contentItems) || parseArguments(call)?.action === 'read' && call.name === 'relay_task') return receipt;
      // An already dispatched action keeps its own success/error receipt even
      // when a person edits during it. Awareness text must never turn a completed
      // side effect into a retry-shaped failure.
      try {
        const current = await store.get(taskId), relevance = new Set(planningRelevance(current, scopeStepId).stepIds), snapshot = registry.snapshot(current);
        const worker = snapshot.workers.find(item => item.id === id);
        const editors = snapshot.presence.filter(editor => editor.stepId === null || relevance.has(editor.stepId));
        const notice = JSON.stringify({ editors: editors.map(editor => ({ editorId: editor.editorId, actorId: editor.actor.id, stepId: editor.stepId })), pendingRevision: worker?.pendingRevision || null });
        if (notice === lastNotice || !lastNotice && !editors.length && !worker?.pendingRevision) return receipt;
        lastNotice = notice;
        const message = { type: 'planning.awareness', taskId, revision: current.revision, presence: editors.slice(0, 20).map(editor => ({ label: editor.label, stepId: editor.stepId, expiresAt: editor.expiresAt })), totalRelevantEditors: editors.length, pendingRevision: worker?.pendingRevision || null,
          note: worker?.pendingRevision ? executionGuardrails === true ? 'A saved change affects your work. The preceding tool retains its reported result; read relay_task before the next affected action.' : 'Saved planning context changed. Incorporate relevant user directions and refresh the outline when useful; this notice does not block the next tool or response.' : editors.length ? 'A human is editing this work. Their unsaved draft is not available and has not changed the plan. Presence is advisory; incorporate saved changes when published.' : 'Editing presence has ended. The saved plan remains the authoritative work document.' };
        return { ...receipt, contentItems: [...receipt.contentItems, { type: 'inputText', text: JSON.stringify(message) }] };
      } catch { return receipt; }
    },
    finish(status) { registry.finish(id, status); },
  };
}

/** Runtime callback identity is transport correctness, independent of planning. */
export function createToolCallIdempotency() {
  const calls = new Map();
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return { invoke(call, execute) {
    if (typeof call?.callId !== 'string' || !call.callId.length) return execute(call);
    let invocation, fingerprint;
    try {
      invocation = structuredClone(call);
      let args = invocation.arguments; if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }
      fingerprint = createHash('sha256').update(JSON.stringify(canonical({ name: invocation.name, arguments: args }))).digest('hex');
    } catch { return errorReceipt('TOOL_CALL_ARGUMENTS_INVALID', 'The tool callback payload is not serializable; no operation was dispatched.'); }
    const previous = calls.get(invocation.callId);
    if (previous) return previous.fingerprint === fingerprint ? previous.promise : errorReceipt('TOOL_CALL_ID_CONFLICT', 'This tool callback ID already identifies a different payload. No additional operation was dispatched.', { callId: invocation.callId });
    const promise = Promise.resolve().then(() => execute(invocation));
    calls.set(invocation.callId, { fingerprint, promise });
    return promise;
  }};
}

export const wrapPlanningToolHandler = (guard, handler, { idempotency = guard?.idempotency || createToolCallIdempotency() } = {}) => {
  const execute = guard ? async (call, context) => {
  call = { ...call }; // Separate concurrent invocations even when a caller reuses an object/ID.
  let receipt;
  try { receipt = await handler(call, context); }
  catch (error) {
    // Runtime adapters still normalize and throw/cancel exactly as before.
    // Keep generated annotations out of the Error itself (it may be frozen).
    try { rememberExecutionError(error, await guard.annotate(call, { success: false, ...(error?.code ? { code: error.code } : {}), contentItems: [{ type: 'inputText', text: error?.message || 'The tool did not complete.' }] }, { uncertain: true }), call.callId); } catch {}
    throw error;
  }
  return guard.annotate(call, receipt);
} : handler;
  return (call, context) => idempotency.invoke(call, invocation => execute(invocation, context));
};

export const PLANNING_AWARENESS_INSTRUCTIONS = '\nSHARED PLANNING CHANGES\nA human may edit the shared plan while you work. Unsaved editing presence is advisory. At attached tool boundaries, relevant saved changes return TASK_PLAN_REVIEW_REQUIRED before the requested action executes. Read relay_task again, incorporate the saved criteria, dependencies and human context, and choose the next appropriate action. A read receipt records delivery of that saved revision; it does not prove comprehension. Do not bypass a review request with another tool. Keep independent assigned work moving. In-flight actions are not interrupted by a plan save.\n';
