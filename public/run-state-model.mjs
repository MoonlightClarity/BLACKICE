import {reduceToolOutcome} from './tool-outcomes-model.mjs';
/** Keep selected live state ahead of the periodically fetched run list. */
export function selectStartupRun(runs = [], rememberedId) {
  return runs.find(run => run?.id === rememberedId) || runs.find(run => ['queued', 'running', 'waiting'].includes(run?.status)) || runs[0] || null;
}

export function runsWithCurrent(runs = [], currentRun) {
  if (!currentRun?.id) return runs;
  const index = runs.findIndex(run => run.id === currentRun.id);
  const selected = reconcileTaskState(currentRun, index < 0 ? undefined : runs[index]);
  if (index < 0) return [selected, ...runs];
  return runs.map((run, position) => position === index ? selected : run);
}

const TRACE_LIMIT = 2500, TRACE_COMPACT_AT = 3000, eventCounts = new WeakMap();
const durableReceipt = event => { const data = event?.data || event; return ['message', 'steer'].includes(data?.type) || data?.type === 'item' && data.item?.type === 'agentMessage'; };
function appendReceipt(previous, receipt) {
  const events = Array.isArray(previous) ? previous : [], cached = eventCounts.get(events);
  let traceCount = (cached?.length === events.length ? cached.traceCount : events.reduce((total, event) => total + (durableReceipt(event) ? 0 : 1), 0)) + (durableReceipt(receipt) ? 0 : 1);
  let next = [...events, receipt];
  // Compact in batches. Actual assistant messages and human directions remain durable.
  if (traceCount > TRACE_COMPACT_AT) {
    let remaining = TRACE_LIMIT;
    const retained = [];
    for (let index = next.length - 1; index >= 0; index--) if (durableReceipt(next[index]) || remaining-- > 0) retained.push(next[index]);
    next = retained.reverse(); traceCount = TRACE_LIMIT;
  }
  eventCounts.set(next, { length: next.length, traceCount });
  return next;
}

/** Route each live receipt to its own run, without changing the user's selected run. */
export function reduceRunCollection({ runs = [], currentRun } = {}, event) {
  let collection = runs;
  if (currentRun?.id) {
    const index = collection.findIndex(run => run?.id === currentRun.id);
    const selected = reconcileTaskState(currentRun, index < 0 ? undefined : collection[index]);
    currentRun = selected;
    if (index < 0) collection = [...collection, selected];
    else if (collection[index] !== selected) collection = collection.map(run => run?.id === selected.id ? selected : run);
  }
  const runId = event?.runId;
  const source = typeof runId === 'string' && runId ? collection.find(run => run?.id === runId) : null;
  if (!source) return { runs: collection, currentRun, known: false };
  const next = reduceRunEvent(source, event);
  return { runs: collection.map(run => run?.id === runId ? next : run), currentRun: currentRun?.id === runId ? next : currentRun, known: true };
}

const activeRun = run => ['queued', 'running', 'waiting'].includes(run?.status) || run?.settled === false;
const terminalRun = run => ['completed', 'failed', 'cancelled'].includes(run?.status);
const updated = run => Date.parse(run?.updatedAt || run?.createdAt || '') || 0;

/** Connection readiness must not imply that admitted work has finished. */
export function workspaceActivity({runs = [], currentRun, execution = {}} = {}) {
  const snapshots = [...runs, ...(currentRun?.id ? [currentRun] : [])];
  const working = snapshots.some(run => ['queued', 'running', 'waiting'].includes(run?.status));
  const stopping = execution.stopping === true || snapshots.some(run => run?.status === 'cancelled' && run.settled === false);
  const settling = execution.settling === true || snapshots.some(run => terminalRun(run) && run.settled === false);
  if (working) return {label:'Working',title:stopping ? 'Tasks are working. A stopped task is still finishing an operation.' : 'An agent is working. You can send direction or stop it.'};
  if (stopping) return {label:'Stopping…',title:'A stopped task is finishing already-started work. Its execution slot remains reserved until that work finishes.'};
  if (settling) return {label:'Finishing…',title:'A task is finishing its remaining operations and saving the outcome.'};
  if (Number(execution.activeRunCount ?? execution.activeCount) > 0) return {label:'Working',title:'An admitted task is active. Its conversation will show the latest progress.'};
  return null;
}

/** Revision order survives delayed receipts and HTTP snapshots with newer timestamps. */
export function newerTaskState(previous, incoming, taskId) {
  const valid = value => value && typeof value === 'object' && !Array.isArray(value) && typeof taskId === 'string' && taskId.length > 0 && value.taskId === taskId && Number.isSafeInteger(value.revision) && value.revision > 0;
  const saved = valid(previous) ? previous : undefined;
  if (!valid(incoming)) return saved;
  return saved && saved.revision >= incoming.revision ? saved : incoming;
}

function withTaskState(run, taskState) {
  if (run.taskState === taskState) return run;
  const result = { ...run };
  if (taskState) result.taskState = taskState;
  else delete result.taskState;
  return result;
}
function reconcileTaskState(preferred, other) {
  return withTaskState(preferred, newerTaskState(preferred.taskState, other?.taskState, preferred.taskId || other?.taskId || preferred.id));
}

/** A late HTTP response cannot roll back receipts received after that request began. */
export function adoptFetchedRun(existing, incoming, { changedSinceRequest = false } = {}) {
  if (!incoming?.id) return existing;
  if (!existing?.id || existing.id !== incoming.id) return reconcileTaskState(incoming);
  const keepExisting = changedSinceRequest || updated(existing) > updated(incoming) || updated(existing) === updated(incoming) && terminalRun(existing) && !terminalRun(incoming);
  const taskState = newerTaskState(existing.taskState, incoming.taskState, existing.taskId || incoming.taskId || incoming.id);
  return withTaskState(keepExisting ? existing : incoming, taskState);
}

/** Reconcile bounded HTTP history with live runs that may be absent from that response. */
export function mergeRunSnapshots(currentList = [], incomingList = [], { currentRun, changedRunIds = new Set(), maxHistory = 100 } = {}) {
  const existing = new Map();
  for (const run of currentList || []) if (run?.id) existing.set(run.id, run);
  if (currentRun?.id) existing.set(currentRun.id, adoptFetchedRun(existing.get(currentRun.id), currentRun));
  const merged = new Map(existing);
  for (const incoming of incomingList || []) if (incoming?.id) merged.set(incoming.id, adoptFetchedRun(existing.get(incoming.id), incoming, { changedSinceRequest: Boolean(changedRunIds?.has?.(incoming.id)) }));
  const ordered = [...merged.values()].sort((a, b) => (Date.parse(b.createdAt || '') || updated(b)) - (Date.parse(a.createdAt || '') || updated(a)));
  const historyLimit = Math.max(1, Math.min(100, Math.floor(Number(maxHistory) || 100)));
  // Every admitted execution must remain visible. Only settled history is bounded.
  const active = ordered.filter(activeRun), history = ordered.filter(run => !activeRun(run)).slice(0, historyLimit);
  const selected = currentRun?.id && merged.get(currentRun.id);
  if (selected) {
    const bucket = activeRun(selected) ? active : history;
    if (!bucket.some(run => run.id === selected.id)) { bucket.pop(); bucket.push(selected); }
  }
  const retained = new Set([...active, ...history].map(run => run.id));
  return ordered.filter(run => retained.has(run.id));
}

/** Apply only facts carried by this run's stream; thread startup can follow node.updated. */
export function reduceRunEvent(run, event) {
  if (!run || !event || event.runId !== run.id) return run;
  const { type, nodeId, data, at } = event;
  const next = { ...run, ...(at ? { updatedAt: at } : {}), events: appendReceipt(run.events, { type, nodeId, data, at }) };
  if (type === 'node.updated' && nodeId && data && typeof data === 'object') {
    next.nodes = { ...run.nodes, [nodeId]: { ...run.nodes?.[nodeId], ...data } };
  }
  if (type !== 'agent.event' || !data || typeof data !== 'object') return next;
  if (data.type === 'task.state') {
    const taskState = newerTaskState(run.taskState, data.state, run.taskId || run.id);
    if (taskState) next.taskState = taskState;
    else delete next.taskState;
  }
  const previous = run.nodes?.[nodeId];
  if (!previous) return next;
  const node = { ...previous };
  for (const field of ['threadId', 'turnId']) {
    if (typeof data[field] === 'string' && data[field].trim()) node[field] = data[field];
  }
  if (data.type === 'thread' && typeof data.model === 'string' && data.model.trim()) node.resolvedModel = data.model;
  if (data.type === 'thread' && ['relay','codex'].includes(data.codexHistory)) node.codexHistory = data.codexHistory;
  if (data.type === 'thread' && ['default','none','minimal','low','medium','high','xhigh','max','ultra'].includes(data.effort)) node.resolvedEffort=data.effort;
  if (data.type === 'turn' && typeof data.status === 'string') node.turnStatus = data.status;
  if (data.type === 'delta' && typeof data.delta === 'string') node.output = ((typeof node.output === 'string' ? node.output : '') + data.delta).slice(-500000);
  if (data.type === 'context') node.contextStatus = data.context;
  if (data.type === 'tool.result') node.toolSummary = reduceToolOutcome(node.toolSummary, data);
  if (data.type === 'capability' && data.available === false) node.capabilityIssues = [...(node.capabilityIssues || []), data].slice(-20);
  if (data.type === 'capability' && data.available === true) node.capabilityIssues = (node.capabilityIssues || []).filter(issue=>issue.tool!==data.tool);
  if (data.type === 'usage') { node.usage = data.usage; delete next.usage; }
  next.nodes = { ...run.nodes, [nodeId]: node };
  return next;
}
