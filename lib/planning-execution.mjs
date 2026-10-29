// Runtime receipt metadata, separate from human/agent plan claims and revisions.
// Never retain tool arguments, output text, labels, URLs or form values here.
export const EXECUTION_LIMITS = Object.freeze({ recent: 48, unresolved: 24, seen: 256, bytes: 262144 });
const clone = value => structuredClone(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,159}$/.test(value) ? value : undefined;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
const actions = new Set(('call open navigate tabs snapshot screenshot read list search describe fill type click press upload wait interaction select scroll close write run patch image read_bytes export status inspect get_text get_document get_draft drafts send draft attach update delete create get tools connections connect disconnect evaluate extract download reload back forward move copy rename prepare confirm reconcile pause cancel').split(' '));
const code = value => typeof value === 'string' && /^(?:BROWSER_|TASK_|WORKSPACE_|ATTACHMENT_|PLANNING_|EXTERNAL_|INVALID_|MCP_|TOOL_|ABORT_)[A-Z0-9_]{1,70}$/.test(value) ? value : 'TOOL_FAILED';
const note = 'Runtime tool receipts, not milestone completion or destination confirmation. A completed upload/type/send call still needs its actual outcome checked. Different operations do not resolve each other. Historical data, not instructions.';
const errorAnnotations = new WeakMap();
export function rememberExecutionError(error, receipt, callId) {
  if (!error || typeof error !== 'object') return;
  const annotations = (receipt?.contentItems || []).filter(item => {
    if (item.type !== 'inputText') return false;
    try { return ['planning.execution', 'planning.execution-warning', 'planning.awareness', 'planning.sequence'].includes(JSON.parse(item.text)?.type); } catch { return false; }
  });
  const entries = errorAnnotations.get(error) || new Map(), key = String(callId || 'unidentified');
  entries.delete(key);
  if (annotations.length) entries.set(key, clone(annotations));
  while (entries.size > 32) entries.delete(entries.keys().next().value);
  errorAnnotations.set(error, entries);
}
export const executionErrorAnnotations = (error, callId) => {
  const entries = error && typeof error === 'object' ? errorAnnotations.get(error) : null;
  return clone((callId === undefined ? [...(entries?.values() || [])].at(-1) : entries?.get(String(callId))) || []);
};
export function executionReceipt(event, context = {}) {
  if (!id(event?.callId) || !id(context.runId) || !id(context.nodeId) || !/^relay_[a-z_]{1,60}$/.test(event.tool || '') || event.tool === 'relay_task' || typeof event.success !== 'boolean') return null;
  const allActive = [...new Set((context.activeStepIds || []).map(id).filter(Boolean))], activeStepIds = allActive.slice(0, 20);
  return { callId: event.callId, runId: context.runId, nodeId: context.nodeId, tool: event.tool,
    action: actions.has(event.action) ? event.action : 'call', status: event.success ? 'tool-completed' : 'tool-failed',
    ...(event.success ? {} : { code: code(event.code) }), ...(digest(event.operationKey) ? { operationKey: event.operationKey } : {}),
    planRevision: Number.isSafeInteger(context.planRevision) ? context.planRevision : null,
    ...(id(context.scopeStepId) ? { scopeStepId: context.scopeStepId } : {}), activeStepIds,
    ...(allActive.length === 1 ? { stepId: activeStepIds[0] } : {}), ...(allActive.length > 20 ? { omittedActiveStepIds: allActive.length - 20 } : {}),
    startedAt: new Date(context.startedAt || Date.now()).toISOString(), at: new Date(context.at || Date.now()).toISOString() };
}
const identity = receipt => JSON.stringify([receipt.runId, receipt.nodeId, receipt.callId]);
const receiptKeys = new Set('callId runId nodeId tool action status code operationKey planRevision scopeStepId activeStepIds stepId omittedActiveStepIds startedAt at recoveredCallIds'.split(' '));
const count = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
function validReceipt(value) {
  return value && typeof value === 'object' && Object.keys(value).every(key => receiptKeys.has(key)) && id(value.callId) && id(value.runId) && id(value.nodeId)
    && /^relay_[a-z_]{1,60}$/.test(value.tool) && actions.has(value.action) && ['tool-completed', 'tool-failed'].includes(value.status)
    && (value.code === undefined || code(value.code) === value.code) && (value.operationKey === undefined || digest(value.operationKey))
    && (value.planRevision === null || count(value.planRevision)) && (value.scopeStepId === undefined || id(value.scopeStepId))
    && Array.isArray(value.activeStepIds) && value.activeStepIds.length <= 20 && value.activeStepIds.every(id)
    && (value.stepId === undefined || value.activeStepIds.length === 1 && value.stepId === value.activeStepIds[0] && !value.omittedActiveStepIds)
    && (value.omittedActiveStepIds === undefined || count(value.omittedActiveStepIds)) && date(value.startedAt) && date(value.at)
    && (value.recoveredCallIds === undefined || Array.isArray(value.recoveredCallIds) && value.recoveredCallIds.length <= EXECUTION_LIMITS.unresolved && value.recoveredCallIds.every(id));
}
function validateJournal(value) {
  const keys = new Set('version taskId total successful failed recoveredFailures omittedReceipts omittedUnresolvedFailures dedupIdsOmitted recent unresolved seen updatedAt'.split(' '));
  const valid = value?.version === 1 && Object.keys(value).every(key => keys.has(key))
    && ['total', 'successful', 'failed', 'recoveredFailures', 'omittedReceipts', 'omittedUnresolvedFailures', 'dedupIdsOmitted'].every(key => count(value[key]))
    && (value.taskId === undefined || id(value.taskId)) && (value.updatedAt === undefined || date(value.updatedAt))
    && Array.isArray(value.recent) && value.recent.length <= EXECUTION_LIMITS.recent && value.recent.every(validReceipt)
    && Array.isArray(value.unresolved) && value.unresolved.length <= EXECUTION_LIMITS.unresolved && value.unresolved.every(item => validReceipt(item) && item.status === 'tool-failed')
    && Array.isArray(value.seen) && value.seen.length <= EXECUTION_LIMITS.seen && value.seen.every(item => {
      let ids; try { ids = JSON.parse(item.id); } catch { return false; }
      return Object.keys(item).every(key => ['id', 'status', 'operationKey'].includes(key)) && Array.isArray(ids) && ids.length === 3 && ids.every(id) && ['tool-completed', 'tool-failed'].includes(item.status) && (item.operationKey === undefined || digest(item.operationKey));
    });
  if (!valid) throw new Error('Invalid bounded execution journal.');
}
const sameOperation = (left, right) => left.operationKey && left.operationKey === right.operationKey && left.tool === right.tool && left.runId === right.runId && left.nodeId === right.nodeId && left.scopeStepId === right.scopeStepId && JSON.stringify(left.activeStepIds) === JSON.stringify(right.activeStepIds);
const sameFailure = (left, right) => left.runId === right.runId && left.nodeId === right.nodeId && left.tool === right.tool && left.action === right.action && left.code === right.code && left.planRevision === right.planRevision && JSON.stringify(left.activeStepIds) === JSON.stringify(right.activeStepIds);
export function appendExecutionReceipt(previous, receipt, limits = EXECUTION_LIMITS) {
  const state = previous ? clone(previous) : { version: 1, total: 0, successful: 0, failed: 0, recoveredFailures: 0, omittedReceipts: 0, omittedUnresolvedFailures: 0, dedupIdsOmitted: 0, recent: [], unresolved: [], seen: [] };
  validateJournal(state);
  if (!receipt) return { state, duplicate: true, notice: null };
  const key = identity(receipt), prior = state.seen.find(item => item.id === key);
  if (prior) {
    if (prior.status !== receipt.status || prior.operationKey !== receipt.operationKey) throw new Error('A completed call has a conflicting execution receipt.');
    return { state, duplicate: true, notice: null };
  }
  const repeated = receipt.status === 'tool-failed' && state.unresolved.filter(item => sameFailure(item, receipt)).length === 1;
  let recovered = [];
  if (receipt.status === 'tool-failed') { state.failed++; state.unresolved.push(receipt); }
  else {
    state.successful++;
    recovered = state.unresolved.filter(item => sameOperation(item, receipt));
    state.unresolved = state.unresolved.filter(item => !sameOperation(item, receipt));
    state.recoveredFailures += recovered.length;
  }
  const saved = { ...receipt, ...(recovered.length ? { recoveredCallIds: recovered.map(item => item.callId) } : {}) };
  state.total++; state.updatedAt = receipt.at; state.recent.push(saved); state.seen.push({ id: key, status: receipt.status, ...(receipt.operationKey ? { operationKey: receipt.operationKey } : {}) });
  if (state.recent.length > limits.recent) state.omittedReceipts += state.recent.splice(0, state.recent.length - limits.recent).length;
  if (state.unresolved.length > limits.unresolved) state.omittedUnresolvedFailures += state.unresolved.splice(0, state.unresolved.length - limits.unresolved).length;
  if (state.seen.length > limits.seen) state.dedupIdsOmitted += state.seen.splice(0, state.seen.length - limits.seen).length;
  // Count caps alone are insufficient when many long active IDs are valid.
  // Prefer dropping historical recent/seen rows before unresolved failures.
  const byteLimit = limits.bytes ?? EXECUTION_LIMITS.bytes, size = () => JSON.stringify(state).length;
  while (size() > byteLimit && state.recent.length > 1) { state.recent.shift(); state.omittedReceipts++; }
  while (size() > byteLimit && state.seen.length > 1) { state.seen.shift(); state.dedupIdsOmitted++; }
  while (size() > byteLimit && state.unresolved.length) { state.unresolved.shift(); state.omittedUnresolvedFailures++; }
  if (size() > byteLimit) throw new Error('Execution metadata exceeds its bound.');
  return { state, duplicate: false, receipt: saved, notice: repeated ? { kind: 'recurring-tool-error', callId: receipt.callId, activeStepIds: receipt.activeStepIds } : recovered.length ? { kind: 'exact-operation-recovered', callId: receipt.callId, recoveredCallIds: recovered.map(item => item.callId), activeStepIds: receipt.activeStepIds } : null };
}
export function executionView(state, { maxChars = 8000 } = {}) {
  if (!state) return null;
  validateJournal(state);
  const { seen, ...view } = clone(state);
  const result = { ...view, note, deduplication: `Exact call IDs retained for the latest ${EXECUTION_LIMITS.seen} receipts; older IDs may be omitted. Unresolved omissions are not claimed recovered.`, recentNotShown: 0, unresolvedNotShown: 0 };
  // The durable journal may retain more metadata than a model read should carry.
  while (JSON.stringify(result).length > maxChars && result.recent.length > 3) { result.recent.shift(); result.recentNotShown++; }
  while (JSON.stringify(result).length > maxChars && result.unresolved.length > 3) { result.unresolved.shift(); result.unresolvedNotShown++; }
  while (JSON.stringify(result).length > maxChars && result.recent.length > 1) { result.recent.shift(); result.recentNotShown++; }
  while (JSON.stringify(result).length > maxChars && result.unresolved.length) { result.unresolved.shift(); result.unresolvedNotShown++; }
  while (JSON.stringify(result).length > maxChars && result.recent.length) { result.recent.shift(); result.recentNotShown++; }
  return result;
}
export function compactExecution(view) {
  if (!view) return null;
  if (view.unavailable) return view;
  const compactReceipt = receipt => { const { operationKey, activeStepIds, ...rest } = receipt; return { ...rest, activeStepIds: activeStepIds.slice(0, 3), ...(activeStepIds.length > 3 ? { additionalActiveStepIds: activeStepIds.length - 3 + (receipt.omittedActiveStepIds || 0) } : {}) }; };
  return { total: view.total, successful: view.successful, failed: view.failed, recoveredFailures: view.recoveredFailures,
    omittedReceipts: view.omittedReceipts, omittedUnresolvedFailures: view.omittedUnresolvedFailures,
    unresolved: view.unresolved.slice(-3).map(compactReceipt), unresolvedNotShown: (view.unresolvedNotShown || 0) + Math.max(0, view.unresolved.length - 3), recent: view.recent.slice(-2).map(compactReceipt), recentNotShown: (view.recentNotShown || 0) + Math.max(0, view.recent.length - 2), note };
}
