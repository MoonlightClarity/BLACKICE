import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { taskPlanAvailability, normalizePlanningReconciliation } from './task-plan.mjs';
import { isProspectivePlanningAction } from './planning-policy.mjs';

// A dispatch reservation is separate from a plan claim. The existing task lock
// serializes it with other reservations and plan edits, including other stores.
// Only operation identity and outcome metadata are saved, never tool arguments.
const live = new Map();
const maxBytes = 2 * 1024 * 1024;
const fail = (code, message, extra = {}) => ({ success: false, code,
  contentItems: [{ type: 'inputText', text: JSON.stringify({ code, message, ...extra }) }] });
const clean = value => typeof value === 'string' && value.trim();
const attemptOf = step => Number.isSafeInteger(step?.attempt) && step.attempt > 0 ? step.attempt : 1;
const parse = call => { try { return typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments || {}; } catch { return {}; } };
const readActions = Object.freeze({
  relay_workspace: ['list', 'read', 'search', 'patch_history'],
  relay_files: ['list', 'read', 'search', 'image', 'read_bytes'],
  relay_browser: ['tabs', 'snapshot', 'read', 'screenshot', 'downloads'],
  relay_connections: ['connections', 'tools'],
  relay_memory: ['search', 'read'], relay_history: ['search', 'read'], relay_skills: ['search', 'read'],
  relay_email: ['status', 'drafts', 'get_draft', 'deliveries', 'get_delivery'],
  relay_apps: ['status', 'inspect', 'screenshot', 'get_text', 'read_document'],
  relay_windows: ['apps', 'status', 'windows', 'receipt', 'dialogs', 'inspect', 'get_text'],
  relay_desktop: ['windows', 'inspect', 'screenshot'],
  relay_control: ['workflow_get', 'observe_get', 'execution_get', 'runtime_get', 'operations_list', 'schedule_preview', 'job_get'],
});
const readOnly = call => readActions[call.name]?.includes(parse(call).action) === true;
const fileOf = (store, taskId) => `${store.file(taskId)}.sequence`;
const processAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
const fields = new Set('stepId attempt token callId providerCallId runId nodeId planRevision status success startedAt finishedAt pid tool action reconciliation reported'.split(' '));
async function load(file, taskId) {
  try {
    const info = await fs.stat(file);
    if (info.size > maxBytes) throw new Error('The sequential dispatch record exceeds its bound.');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value?.version !== 1 || value.taskId !== taskId || !Array.isArray(value.records)
      || value.records.length > 4096 || value.records.some(record => !record || typeof record !== 'object'
        || Object.keys(record).some(key => !fields.has(key)) || !clean(record.stepId)
        || !Number.isSafeInteger(record.attempt) || record.attempt < 1 || !clean(record.token)
        || !Number.isSafeInteger(record.planRevision) || !['running', 'returned'].includes(record.status)
        || record.status === 'returned' && typeof record.success !== 'boolean'
        || record.reported !== undefined && (!record.reported || !Number.isSafeInteger(record.reported.revision) || typeof record.reported.confirmed !== 'boolean')
        || record.reconciliation !== undefined && (!record.reconciliation || !['confirmed', 'absent'].includes(record.reconciliation.outcome)
          || !clean(record.reconciliation.observationCallId) || !clean(record.reconciliation.stepId)
          || !Number.isSafeInteger(record.reconciliation.attempt) || !Number.isSafeInteger(record.reconciliation.planRevision))))
      throw new Error('The sequential dispatch record is unavailable.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, taskId, records: [] };
    throw error;
  }
}
async function save(file, value) {
  const bytes = JSON.stringify(value);
  if (bytes.length > maxBytes) throw new Error('The sequential dispatch record exceeds its bound.');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
function reportedOutcome(record, state) {
  const current = state.steps.find(step => step.id === record.stepId);
  const step = attemptOf(current) === record.attempt ? current
    : current?.pastAttempts?.find(item => item.attempt === record.attempt);
  if (!step) return { recorded: Boolean(record.reported), confirmed: record.reported?.confirmed === true };
  const confirmed = step.status === 'done' && Boolean(clean(step.evidence));
  const disposition = step.status === 'blocked' && clean(step.blockedReason)
    || step.status === 'skipped' && clean(step.skipReason);
  return { recorded: Boolean(record.reported) || confirmed || Boolean(disposition), confirmed: record.reported?.confirmed === true || confirmed };
}
function acknowledgeOutcomes(ledger, state) {
  let changed = false;
  for (const record of ledger.records) {
    const outcome = reportedOutcome(record, state);
    if (outcome.recorded && (!record.reported || outcome.confirmed && !record.reported.confirmed)) {
      record.reported = { revision: state.revision, confirmed: outcome.confirmed }; changed = true;
    }
  }
  return changed;
}

/** Read the existing dispatch ledger without changing reservations or claims.
 * Final planning review uses the same actual-outcome interpretation as dispatch.
 * All owned branch attempts remain relevant, including an old unselected path's
 * uncertain effect; changing a branch cannot make that effect disappear. */
export async function planningSequenceStatus(store, taskId, state, { scopeStepId = null } = {}) {
  const file = fileOf(store, taskId);
  let ledger;
  try { ledger = await load(file, taskId); }
  catch { throw Object.assign(new Error('The sequential work record is unavailable. Preserve the saved plan and reconcile actual effects before responding.'), { code: 'TASK_PLAN_DISPATCH_UNAVAILABLE', status: 409 }); }
  const owned = new Set(scopeStepId ? [scopeStepId] : state.steps.map(step => step.id));
  if (scopeStepId) for (let changed = true; changed;) {
    changed = false;
    for (const step of state.steps) if (owned.has(step.parentId) && !owned.has(step.id)) { owned.add(step.id); changed = true; }
  }
  const records = ledger.records.filter(record => !scopeStepId || owned.has(record.stepId));
  const running = [], unreported = [], uncertain = [];
  const projection = records.map(record => {
    const reported = reportedOutcome(record, state), item = { stepId: record.stepId, attempt: record.attempt, callId: record.callId,
      runId: record.runId, nodeId: record.nodeId, status: record.status, ...(record.success === undefined ? {} : { success: record.success }),
      reported, ...(record.reconciliation ? { reconciliation: record.reconciliation } : {}) };
    const active = record.status === 'running' && (live.get(file) === record.token || record.pid !== process.pid && processAlive(record.pid));
    if (active) running.push(item);
    if (!reported.recorded) unreported.push(item);
    if (record.status === 'running' && !record.reconciliation && !active) uncertain.push(item);
    return item;
  });
  return { running, unreported, uncertain, signature: createHash('sha256').update(JSON.stringify(projection)).digest('hex') };
}
function reconciliationClaims(call, current) {
  if (call.name !== 'relay_task') return [];
  const args = parse(call), existing = new Map(current.steps.map(step => [step.id, step]));
  const claim = (stepId, value) => value?.reconciliation ? [{ stepId, status: value.status ?? existing.get(stepId)?.status,
    reconciliation: value.reconciliation }] : [];
  if (args.action === 'step') return claim(args.stepId, args);
  if (args.action === 'edit') return (args.operations || []).flatMap(operation => operation.type === 'update' ? claim(operation.stepId, operation.patch) : []);
  if (args.action === 'plan') return (args.steps || []).flatMap(step => claim(step.id, step));
  return [];
}
function validateReconciliation(claim, current, ledger) {
  let value = claim.reconciliation;
  const step = current.steps.find(item => item.id === claim.stepId);
  const reject = message => fail('TASK_PLAN_RECONCILIATION_INVALID', message, { stepId: claim.stepId, callId: value?.callId });
  try { value = normalizePlanningReconciliation(value); claim.reconciliation = value; }
  catch { return { denied: reject('Reconciliation requires a valid prior callId, explicit confirmed/absent outcome and actual observed evidence.') }; }
  if (claim.status !== 'done' || !value || !clean(value.callId) || !['confirmed', 'absent'].includes(value.outcome) || !clean(value.evidence))
    return { denied: reject('Save reconciliation on a completed observation leaf with the prior callId, explicit confirmed/absent outcome and actual observed evidence.') };
  const target = ledger.records.find(record => record.callId === value.callId);
  const observation = ledger.records.find(record => record.stepId === claim.stepId && record.attempt === attemptOf(step));
  if (!target) return { denied: reject('The referenced call is not in this task’s actual sequential dispatch record. Read the saved call identity before reporting its outcome.') };
  if (!observation || observation.status !== 'returned' || observation.success !== true
    || !readOnly({ name: observation.tool, arguments: { action: observation.action } }))
    return { denied: reject('Reconciliation needs this observation leaf’s actual successful read-only tool result. A reasoning claim, mutation or failed observation cannot establish the prior effect.') };
  if (observation.token === target.token || observation.planRevision <= target.planRevision || observation.startedAt < target.startedAt)
    return { denied: reject('The observation must occur after the referenced dispatch. A call cannot reconcile itself or rely on an earlier observation.') };
  if (target.reconciliation && (target.reconciliation.outcome !== value.outcome || target.reconciliation.observationCallId !== observation.callId))
    return { denied: reject('This dispatch already has a saved reconciliation. Preserve that historical effect; use a new planned observation for any later change at the destination.') };
  return { target, observation };
}

/** Called inside TaskStateStore's existing write lock, after constructing the
 * proposed state and before committing it. Human and agent edits follow the
 * same preservation rule: an outstanding operation cannot lose its definition.
 * Previously saved dispositions are retained in dispatch metadata before a
 * legitimate later revision can replace their current leaf representation. */
export async function validateSequentialPlanTransition(store, taskId, previous, next) {
  if (JSON.stringify(previous.steps) === JSON.stringify(next.steps)) return;
  const file = fileOf(store, taskId);
  let ledger;
  try { ledger = await load(file, taskId); }
  catch { throw Object.assign(new Error('The sequential dispatch record is unavailable. Preserve the current operation and inspect its actual result before replacing its work definition.'), { code: 'TASK_PLAN_DISPATCH_UNAVAILABLE', status: 409 }); }
  if (!ledger.records.length) return;
  const definitions = ['title', 'result', 'note', 'doneWhen', 'operation'];
  for (const record of ledger.records) {
    const old = previous.steps.find(step => step.id === record.stepId);
    const activeCall = record.status === 'running' && (live.get(file) === record.token || record.pid !== process.pid && processAlive(record.pid));
    if (!activeCall && reportedOutcome(record, previous).recorded) continue;
    const replacement = next.steps.find(step => step.id === record.stepId);
    if (activeCall && ['done', 'skipped'].includes(replacement?.status) && replacement.status !== old?.status)
      throw Object.assign(new Error(`Step "${record.stepId}" is still executing. Wait for its actual tool result before recording a terminal outcome; the proposed outcome was not saved.`), { code: 'TASK_PLAN_STEP_IN_FLIGHT', status: 409 });
    if (!old || !replacement || (replacement.kind || 'action') !== 'action'
      || attemptOf(old) !== record.attempt || attemptOf(replacement) !== record.attempt
      || definitions.some(key => JSON.stringify(old[key]) !== JSON.stringify(replacement[key])))
      throw Object.assign(new Error(`Preserve dispatched step "${record.stepId}" and its current operation until its actual result or uncertainty is saved. Record done with evidence, blocked with the actual reason, or skipped with its disposition before removing, expanding, redefining or revisiting it. The proposed plan edit was not saved.`), { code: activeCall ? 'TASK_PLAN_STEP_IN_FLIGHT' : 'TASK_PLAN_RESULT_REQUIRED', status: 409 });
  }
  // This acknowledges only the already durable previous state, never a proposed
  // completion whose surrounding plan write might still fail.
  if (acknowledgeOutcomes(ledger, previous)) await save(file, ledger);
}

/** One dispatch for one saved leaf attempt. Plan reads/writes are deliberately
 * outside this protocol; they can revise, reconcile or revisit the actual work. */
export function createSequentialPlanningGuard({ store, taskId, runId, nodeId, scopeStepId, schemaVersion = 9 } = {}) {
  const file = fileOf(store, taskId), reservations = new Map();
  // Runtime call IDs can be duplicated by a replay or transport bug. Associate
  // the reservation with this invocation, so rejecting a duplicate cannot
  // settle the original operation while it is still running.
  const keyOf = call => call;
  return {
    async before(call, { signal, expectedRevision, ownedIds } = {}) {
      const taskEdit = call.name === 'relay_task';
      const revisit = taskEdit && parse(call).action === 'edit' && parse(call).operations?.some(operation => operation.type === 'revisit');
      const args = parse(call);
      const hasReconciliation = taskEdit && (args.reconciliation || args.steps?.some(step => step.reconciliation)
        || args.operations?.some(operation => operation.patch?.reconciliation));
      if (taskEdit && !revisit && !hasReconciliation) return null;
      try {
        return await store.enqueue(taskId, async () => {
          const current = await store.get(taskId, { signal });
          if (current.revision !== expectedRevision)
            return fail('TASK_PLAN_REVIEW_REQUIRED', 'The plan changed before dispatch. Read its current revision and choose the next leaf again. The requested operation has not run.', { revision: current.revision });
          if (taskEdit) {
            const ledger = await load(file, taskId);
            for (const claim of reconciliationClaims(call, current)) {
              const checked = validateReconciliation(claim, current, ledger); if (checked.denied) return checked.denied;
            }
            if (!revisit) return null;
            const running = ledger.records.find(record => record.status === 'running'
              && (live.get(file) === record.token || record.pid !== process.pid && processAlive(record.pid)));
            if (running) return fail('TASK_PLAN_STEP_IN_FLIGHT', 'The current operation is still running. Preserve its attempt until its result returns; future plan edits remain available.', { stepId: running.stepId });
            const unresolved = ledger.records.filter(record => !reportedOutcome(record, current).recorded);
            if (unresolved.length) return fail('TASK_PLAN_RESULT_REQUIRED', 'Before revisiting, first save the preceding dispatched attempt as done with evidence, blocked with its actual uncertainty, or skipped with its actual reason. Revisit must preserve a reconciled outcome, not strand an unresolved active attempt.', { unresolved: unresolved.map(record => ({ stepId: record.stepId, attempt: record.attempt })) });
            return null;
          }
          const active = current.steps.filter(step => (step.kind || 'action') === 'action' && step.status === 'active');
          if (active.length !== 1)
            return fail('TASK_PLAN_ACTIVE_STEP_REQUIRED', 'Planning On requires exactly one active executable leaf before an operational tool. Decompose composite work, activate the next chronological leaf, and keep other work pending. The requested operation has not run.', { activeStepIds: active.map(step => step.id) });
          const step = active[0], availability = taskPlanAvailability(current).byId[step.id];
          if (ownedIds && !ownedIds.has(step.id))
            return fail('TASK_PLAN_NOT_READY', 'Another assigned scope owns the current active leaf. Keep this assignment pending until it becomes the next work item.', { stepId: step.id, scopeStepId });
          if (!availability || availability.state !== 'active' || availability.prerequisites.some(item => !item.satisfied))
            return fail('TASK_PLAN_NOT_READY', availability?.reason || 'Resolve this leaf’s prerequisites and branch before attempting it.', { stepId: step.id });
          if (!isProspectivePlanningAction(step))
            return fail('TASK_PLAN_DEPTH_REQUIRED', 'Save one concrete operation, its expected result, procedure and observable completion check before attempting this leaf.', { stepId: step.id });
          const operation = step.operation, action = parse(call).action;
          if (schemaVersion >= 9 && !operation)
            return fail('TASK_PLAN_OPERATION_REQUIRED', 'The current leaf needs operation with kind, concrete target, and tool/action for tool work. Save that operation before attempting it.', { stepId: step.id });
          if (operation && (operation.kind !== 'tool' || operation.tool !== call.name || operation.action !== undefined && operation.action !== action))
            return fail('TASK_PLAN_OPERATION_MISMATCH', 'This call does not match the active leaf’s saved operation. Return to planning, split or revise the remaining work, and activate the appropriate operation before attempting it.', { stepId: step.id, plannedTool: operation.tool, plannedAction: operation.action });
          const ledger = await load(file, taskId);
          const liveRecord = ledger.records.find(record => record.status === 'running'
            && (live.get(file) === record.token || record.pid !== process.pid && processAlive(record.pid)));
          if (liveRecord)
            return fail('TASK_PLAN_STEP_IN_FLIGHT', 'One planned operation is still running. Wait for its actual result, then reconcile that leaf before another operation. The requested operation has not run.', { stepId: liveRecord.stepId, callId: liveRecord.callId });
          const pending = ledger.records.filter(record => !reportedOutcome(record, current).recorded);
          if (pending.length)
            return fail('TASK_PLAN_RESULT_REQUIRED', 'Record the preceding operation’s actual result or uncertainty in its saved leaf before continuing. A plan revision or a new active step alone does not reconcile its effects. Planning edits remain available.', { unresolved: pending.map(record => ({ stepId: record.stepId, attempt: record.attempt, callId: record.callId, status: record.status })) });
          const uncertain = ledger.records.filter(record => record.status === 'running' && !record.reconciliation);
          if (uncertain.length && !readOnly(call))
            return fail('TASK_PLAN_RECONCILIATION_REQUIRED', 'An interrupted operation may already have run. After recording its uncertainty, plan a read-only observation of its effect, then record the actual finding with the original callId below before another effect. Do not replay it merely because its original result was lost.', { unresolved: uncertain.map(record => ({ stepId: record.stepId, attempt: record.attempt, callId: record.callId })) });
          // Delegation is an orchestration envelope. The assigned worker reserves
          // its actual leaf; holding an outer dispatch here would deadlock it.
          if (call.name === 'relay_delegate') {
            const tasks = parse(call).tasks;
            return Array.isArray(tasks) && tasks.length === 1 && tasks[0]?.stepId === step.id ? null
              : fail('TASK_PLAN_SEQUENTIAL_REQUIRED', 'Planning On delegates only the current active assignment to one worker. Use one task whose stepId is this leaf; the requested workers have not started.', { stepId: step.id });
          }
          const attempt = attemptOf(step), previous = ledger.records.find(record => record.stepId === step.id && record.attempt >= attempt);
          if (previous)
            return fail('TASK_PLAN_REPLAN_REQUIRED', 'This leaf attempt has already dispatched its operation. Record its outcome and plan a separate next operation, or explicitly revisit this step before attempting revised work. A read or unrelated edit does not replay it.', { stepId: step.id, attempt, callId: previous.callId });
          const token = randomUUID(), callId = `sequential-${token}`;
          const providerCallId = typeof call.callId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,159}$/.test(call.callId) ? call.callId : undefined;
          if (providerCallId && ledger.records.some(record => record.runId === runId && record.nodeId === nodeId && (record.providerCallId ?? record.callId) === providerCallId))
            return fail('TASK_PLAN_CALL_ID_REUSED', 'This provider call identity already belongs to an operation in the current run and worker. Preserve that receipt and issue a fresh tool call for the newly planned attempt. The requested operation has not run.', { providerCallId });
          const record = { stepId: step.id, attempt, token, callId, ...(providerCallId ? { providerCallId } : {}), runId, nodeId, planRevision: current.revision, tool: call.name,
            ...(typeof action === 'string' ? { action } : {}),
            status: 'running', startedAt: new Date().toISOString(), pid: process.pid };
          acknowledgeOutcomes(ledger, current);
          ledger.records.push(record);
          if (ledger.records.length > 4096) return fail('TASK_PLAN_DISPATCH_LIMIT', 'The task has too many retained dispatch identities. Preserve unresolved effects and archive reconciled work before continuing.');
          await save(file, ledger);
          live.set(file, token); reservations.set(keyOf(call), record);
          return null;
        }, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        return fail('TASK_PLAN_DISPATCH_UNAVAILABLE', 'The sequential work record could not be saved or read. The requested operation has not run. Preserve the current plan and inspect the saved result before retrying.');
      }
    },
    async after(call, receipt, { uncertain = false } = {}) {
      if (call.name === 'relay_task' && receipt?.success === true) {
        let response;
        try { response = JSON.parse(receipt.contentItems?.find(item => item.type === 'inputText')?.text || 'null'); } catch {}
        const claims = response?.taskId === taskId && Array.isArray(response.steps) ? reconciliationClaims(call, response) : [];
        if (claims.length || response?.taskId === taskId && ['plan', 'edit', 'step'].includes(parse(call).action)) {
          try {
            await store.enqueue(taskId, async () => {
              const current = await store.get(taskId), ledger = await load(file, taskId);
              const changed = acknowledgeOutcomes(ledger, current);
              for (const claim of claims) {
                const checked = validateReconciliation(claim, current, ledger);
                const savedStep = current.steps.find(step => step.id === claim.stepId);
                if (checked.denied || savedStep?.status !== 'done' || JSON.stringify(savedStep.reconciliation) !== JSON.stringify(claim.reconciliation))
                  throw new Error('The observation changed before reconciliation could be recorded.');
                checked.target.reconciliation = { outcome: claim.reconciliation.outcome,
                  observationCallId: checked.observation.callId, stepId: claim.stepId, attempt: attemptOf(savedStep),
                  planRevision: current.revision, at: new Date().toISOString() };
              }
              if (changed || claims.length) await save(file, ledger);
            });
          } catch {
            return { ...receipt, contentItems: [...receipt.contentItems, { type: 'inputText', text: JSON.stringify({ type: 'planning.sequence', status: 'reconciliation-not-saved',
              note: 'The plan update was saved, but its dispatch reconciliation could not be confirmed. Preserve the observation and reread before any further effect; the original operation was not replayed.' }) }] };
          }
        }
        return receipt;
      }
      const record = reservations.get(keyOf(call));
      if (!record) return receipt;
      reservations.delete(keyOf(call));
      let persisted = false;
      // A caught exception is a synthetic failed receipt, not evidence that an
      // already-dispatched operation finished without an effect. Interruption
      // and transport loss therefore require an actual observation to recover.
      const outcomeKnown = !uncertain && typeof receipt?.success === 'boolean';
      try {
        await store.enqueue(taskId, async () => {
          const ledger = await load(file, taskId), saved = ledger.records.find(item => item.token === record.token);
          // Never let an old call’s late result replace a newer attempt.
          if (!saved || saved.attempt !== record.attempt || saved.callId !== record.callId) return;
          if (outcomeKnown) { saved.status = 'returned'; saved.success = receipt.success; }
          saved.finishedAt = new Date().toISOString();
          await save(file, ledger); persisted = true;
        });
      } catch { /* Preserve the actual result; do not turn an effect into a retry. */ }
      finally { if (live.get(file) === record.token) live.delete(file); }
      const actual = typeof receipt?.success === 'boolean' ? receipt : { success: false, code: 'TASK_PLAN_RESULT_UNCONFIRMED', contentItems: [{ type: 'inputText', text: 'The dispatched tool did not return a valid result. Its effect is uncertain; reconcile it before continuing.' }] };
      return { ...actual, contentItems: [...(actual.contentItems || []), { type: 'inputText', text: JSON.stringify({
        type: 'planning.sequence', stepId: record.stepId, attempt: record.attempt, callId: record.callId,
        status: !outcomeKnown ? 'result-uncertain' : persisted ? 'result-returned' : 'result-not-saved',
        note: !outcomeKnown
          ? 'The dispatched operation did not produce a confirmed result. Record its uncertainty, then plan a read-only observation of the actual effect before any retry. A caught exception does not establish that nothing happened.'
          : persisted
          ? 'Return to planning: compare this actual result with the leaf’s completion criterion, record the outcome, then activate one next leaf. Split or revisit work when the result changes the plan. This receipt does not mark the leaf done.'
          : 'The operation returned but its sequential result could not be saved. Preserve this actual result and reconcile the effect before continuing; no operation was replayed.'
      }) }] };
    },
  };
}
