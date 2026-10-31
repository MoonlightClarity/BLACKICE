import { createHash } from 'node:crypto';
import { compactExecution } from './planning-execution.mjs';

export const TASK_TOOL_VIEW_LIMITS = Object.freeze({ replyBytes: 24_000, chunkChars: 4000, outlineItems: 20 });
const VIEWS = new Set(['current', 'outline', 'history', 'full']);
const READ_FIELDS = ['view', 'offset', 'limit', 'viewHash'];
const VOLATILE = new Set(['availableWork', 'executionObservations', 'planningAwareness', 'tradecraftPulse', 'externalActionResult']);
const clone = value => structuredClone(value);
const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const fail = (message, code = 'INVALID_TASK_VIEW') => Object.assign(new Error(message), { code, status: 400 });
const digest = value => createHash('sha256').update(value).digest('hex');
const present = value => value !== undefined && value !== null;
const json = value => JSON.stringify(value);

export function validateTaskViewArguments(args, version = 11) {
  if (READ_FIELDS.some(key => args[key] !== undefined) && (version < 11 || args.action !== 'read'))
    throw fail('View and paging fields belong only to read in task catalog 11 or later. Writes were not changed.', version < 11 ? 'TASK_SCHEMA_UNSUPPORTED' : 'INVALID_TASK_VIEW');
  if (version < 11 || args.action !== 'read') return;
  if (args.view !== undefined && !VIEWS.has(args.view)) throw fail('Choose current, outline, history or full view.');
  if ((!args.view || args.view === 'current') && ['offset', 'limit', 'viewHash'].some(key => args[key] !== undefined)) throw fail('Current is an unpaged work view. Use outline, history or full for paging.');
  if (args.status !== undefined && (args.view !== 'outline' || !['pending', 'active', 'blocked', 'done', 'skipped'].includes(args.status))) throw fail('Status filtering belongs to outline view and needs an actual plan status.');
  for (const key of ['offset', 'limit']) if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < (key === 'limit' ? 1 : 0) || args[key] > (key === 'limit' ? 10_000 : 2_000_000))) throw fail('Use a nonnegative offset and a positive limit up to 10000.');
  if (args.viewHash !== undefined && (typeof args.viewHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.viewHash))) throw fail('Copy viewHash from the preceding page.');
  if (args.stepId !== undefined && (typeof args.stepId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(args.stepId))) throw fail('Use an actual saved stepId for a focused read.');
  if (args.view === 'history' && !args.stepId) throw fail('History view needs the saved stepId.');
  if ((args.offset || 0) > 0 && (!Number.isSafeInteger(args.expectedRevision) || !args.viewHash)) throw fail('Continue a page with its exact expectedRevision and viewHash.');
}

export function savedTaskViewState(state) {
  return Object.fromEntries(Object.entries(state).filter(([key]) => !VOLATILE.has(key)).map(([key, value]) => [key, clone(value)]));
}

function structuralRow(step, state) {
  const row = {};
  for (const key of ['id', 'parentId', 'kind', 'title', 'status', 'attempt', 'selectedChildId']) if (present(step[key])) row[key] = step[key];
  const availability = state.availableWork?.byId?.[step.id];
  if (availability) row.availability = availability.state;
  if (step.evidence) row.hasEvidence = true;
  if (step.blockedReason) row.hasBlocker = true;
  if (step.pastAttempts?.length || step.pastAttemptsOmitted) row.pastAttemptCount = (step.pastAttempts?.length || 0) + (step.pastAttemptsOmitted || 0);
  return row;
}

function sourceFor(state, args) {
  const view = args.view || 'current', step = args.stepId ? state.steps.find(item => item.id === args.stepId) : null;
  if (args.stepId && !step) throw fail('That stepId is not in the returned saved state.', 'TASK_STEP_MISSING');
  let source;
  if (view === 'history') source = step.pastAttempts || [];
  else if (view === 'outline') source = state.steps.filter(item => !args.status || item.status === args.status).map(item => structuralRow(item, state));
  else source = step || savedTaskViewState(state);
  const text = json(source), hash = digest(json({ view, stepId: args.stepId || null, status: args.status || null, source }));
  return { view, step, source, text, hash };
}

/** Validate stable pages before awareness/engine acknowledge a successful read. */
export function validateTaskViewSnapshot(state, args) {
  if (args.action !== 'read') return;
  validateTaskViewArguments(args);
  if (args.expectedRevision !== undefined && args.expectedRevision !== state.revision)
    throw Object.assign(fail('The saved task changed. Start the requested view again at its current revision.', 'TASK_STATE_CONFLICT'), { status: 409, currentRevision: state.revision });
  const source = sourceFor(state, args);
  if ((args.offset || 0) > source.text.length && source.view !== 'outline') throw fail('This offset is beyond the requested saved view.');
  if (source.view !== 'outline' && (args.offset || 0) > 0 && /[\uDC00-\uDFFF]/.test(source.text[args.offset] || '')) throw fail('This offset splits a Unicode character. Use the returned nextOffset.');
  if (args.viewHash && args.viewHash !== source.hash)
    throw Object.assign(fail('The requested view changed. Restart its first page; do not combine these bytes with an earlier view.', 'TASK_VIEW_CHANGED'), { status: 409, currentRevision: state.revision });
  return source;
}

function nextRead(state, view, extra = {}) { return { action: 'read', view, expectedRevision: state.revision, ...extra }; }
function selectedStepIds(state, args) {
  const changed = [args.stepId, args.review?.nextStepId, ...(args.operations || []).flatMap(operation => [operation.stepId, operation.step?.id])].filter(Boolean);
  return [...new Set([args.action === 'read' && args.stepId ? args.stepId : null, ...(state.availableWork?.active || []), ...changed, ...(state.availableWork?.ready || [])].filter(Boolean))];
}

function compactCurrent(state, args, fits) {
  const steps = state.steps || [], byId = new Map(steps.map(step => [step.id, step]));
  const omitted = [], view = { kind: 'partial', name: 'current', shownStepIds: [], omittedSections: omitted,
    note: 'Partial work view, not a replacement plan. Evidence and definitions not shown remain saved. Read a focused step or a pinned full/history page before changing omitted work. A success flag alone reports the operation. Explicitly verified returned properties are evidence of those properties at that time; check required outcomes not established by the result, such as destination acceptance or content quality.' };
  const result = { taskId: state.taskId, revision: state.revision, goal: state.goal, view,
    counts: { steps: steps.length, active: steps.filter(step => step.status === 'active').length, blocked: steps.filter(step => step.status === 'blocked').length, done: steps.filter(step => step.status === 'done').length, skipped: steps.filter(step => step.status === 'skipped').length, ready: state.availableWork?.ready?.length ?? null },
    retrieval: { focusedStep: { action: 'read', stepId: '<saved-step-id>', expectedRevision: state.revision }, outline: nextRead(state, 'outline'), full: nextRead(state, 'full'), history: nextRead(state, 'history', { stepId: '<saved-step-id>' }) } };
  const omit = path => { if (!omitted.includes(path)) omitted.push(path); };
  const put = (target, key, value, path = key) => {
    if (!present(value)) return false;
    target[key] = clone(value);
    if (!fits(result, 1500)) { delete target[key]; omit(path); return false; }
    return true;
  };
  // Preserve immediate external-action guidance and uncertainty before history.
  for (const key of ['externalActionResult', 'externalRecovery', 'interruption']) put(result, key, state[key]);
  if (state.externalActions?.length) {
    result.externalActions = { total: state.externalActions.length, uncertain: state.externalActions.filter(item => item.status === 'uncertain').length, items: [] };
    for (const receipt of [...state.externalActions].sort((a, b) => (b.status === 'uncertain') - (a.status === 'uncertain'))) {
      result.externalActions.items.push(clone(receipt));
      if (!fits(result, 1500)) { result.externalActions.items.pop(); omit('externalActions'); break; }
    }
    result.externalActions.notShown = state.externalActions.length - result.externalActions.items.length;
  }
  put(result, 'plan', state.plan);
  put(result, 'planningAwareness', state.planningAwareness);
  put(result, 'latestReview', state.planningReviews?.at(-1));
  put(result, 'checkpoint', state.checkpoint);
  result.steps = [];
  const chosen = selectedStepIds(state, args);
  for (const id of chosen) {
    const step = byId.get(id); if (!step) continue;
    const detail = { id: step.id }, missing = [];
    result.steps.push(detail);
    for (const [key, value] of Object.entries(step)) {
      if (key === 'id' || key === 'pastAttempts') continue;
      detail[key] = clone(value);
      if (!fits(result, 1800)) { delete detail[key]; missing.push(key); }
    }
    if (step.pastAttempts?.length) detail.pastAttempts = { retained: step.pastAttempts.length, previouslyOmitted: step.pastAttemptsOmitted || 0, summaries: step.pastAttempts.map(item => ({ attempt: item.attempt, status: item.status, at: item.at })), read: nextRead(state, 'history', { stepId: id }) };
    const available = state.availableWork?.byId?.[id];
    if (available) {
      detail.availability = { state: available.state, reason: available.reason, owner: available.owner, execution: available.execution };
      if (available.prerequisites?.length) detail.availability.prerequisites = available.prerequisites.map(item => ({ id: item.id, satisfied: item.satisfied, ...(item.executionStatus ? { executionStatus: item.executionStatus } : {}) }));
      if (!fits(result, 1800)) { delete detail.availability.prerequisites; missing.push('availability.prerequisites'); }
    }
    if (missing.length) { detail.omittedFields = missing; omit('steps.' + id); }
    if (!fits(result, 1500)) { result.steps.pop(); omit('additional focused steps'); break; }
    view.shownStepIds.push(id);
  }
  result.focus = { requested: args.action === 'read' ? args.stepId || null : null, selectedTotal: chosen.length, shown: result.steps.length, notShown: chosen.length - result.steps.length };
  const ancestors = new Set();
  for (const id of view.shownStepIds) { let step = byId.get(id); for (let depth = 0; step?.parentId && depth < 200; depth++) { if (ancestors.has(step.parentId)) break; ancestors.add(step.parentId); step = byId.get(step.parentId); } }
  result.ancestors = [];
  for (const id of ancestors) {
    const step = byId.get(id); if (!step) continue;
    const context = Object.fromEntries(['id', 'parentId', 'title', 'kind', 'status', 'selectedChildId', 'branch', 'condition', 'note', 'doneWhen'].filter(key => present(step[key])).map(key => [key, clone(step[key])]));
    result.ancestors.push(context);
    if (!fits(result, 1300)) { result.ancestors.pop(); omit('ancestor definitions'); break; }
  }
  const blocked = steps.filter(step => step.status === 'blocked');
  result.blockers = { total: blocked.length, items: [], read: nextRead(state, 'outline', { status: 'blocked' }) };
  for (const step of blocked) {
    result.blockers.items.push({ id: step.id, title: step.title, blockedReason: step.blockedReason });
    if (!fits(result, 1000)) { result.blockers.items.pop(); omit('additional blocker reasons'); break; }
  }
  result.blockers.notShown = blocked.length - result.blockers.items.length;
  if (state.executionObservations) {
    put(result, 'executionObservations', compactExecution(state.executionObservations));
  }
  if (state.artifacts?.length) {
    result.artifacts = { total: state.artifacts.length, items: [] };
    const artifacts = args.action === 'artifact' ? [...state.artifacts].reverse() : state.artifacts;
    for (const artifact of artifacts) {
      result.artifacts.items.push(clone(artifact));
      if (!fits(result, 800)) { result.artifacts.items.pop(); omit('additional artifacts'); break; }
    }
    result.artifacts.notShown = state.artifacts.length - result.artifacts.items.length;
  }
  put(result, 'tradecraftPulse', state.tradecraftPulse);
  result.outline = { total: steps.length, offset: 0, items: [] };
  for (const step of steps.slice(0, TASK_TOOL_VIEW_LIMITS.outlineItems)) {
    result.outline.items.push(structuralRow(step, state));
    if (!fits(result, 600)) { result.outline.items.pop(); break; }
  }
  result.outline.notShown = steps.length - result.outline.items.length;
  if (result.outline.notShown) {
    const source = sourceFor(state, { view: 'outline' });
    result.outline.nextRead = nextRead(state, 'outline', { offset: result.outline.items.length, viewHash: source.hash });
  }
  view.omittedHistory = true;
  view.omittedDefinitions = { stepCount: steps.length - view.shownStepIds.length, note: 'Criteria, evidence and prior attempts for unshown step IDs were not delivered in this partial view. Use a focused stepId read before relying on or changing that omitted work; use pinned full/history pages for complete bytes.' };
  view.requiredFocusedRetrieval = result.focus.notShown > 0 || omitted.length > 0 || result.blockers.notShown > 0;
  return result;
}

function pagedView(state, args, fits) {
  const source = sourceFor(state, args), offset = args.offset || 0;
  const result = { taskId: state.taskId, revision: state.revision, view: { name: source.view, kind: source.view === 'outline' ? 'structural-page' : 'exact-json-page', stepId: args.stepId || null, viewHash: source.hash }, offset,
    note: source.view === 'outline' ? 'Structural rows omit saved criteria/evidence. Read a saved stepId for current details.' : 'Concatenate text from pages with this exact revision and viewHash, then JSON.parse once. No saved bytes are silently truncated. Full task view excludes the named derived/live metadata; full step and history retain the complete saved record.' };
  if (source.view === 'outline') {
    const rows = source.source; result.totalItems = rows.length; result.items = [];
    for (const row of rows.slice(offset, offset + Math.min(args.limit || TASK_TOOL_VIEW_LIMITS.outlineItems, 40))) {
      result.items.push(row); if (!fits(result, 600)) { result.items.pop(); break; }
    }
    result.unit = 'rows'; result.nextOffset = offset + result.items.length < rows.length ? offset + result.items.length : null;
  } else {
    result.unit = 'UTF-16 code units'; result.encoding = 'JSON'; result.totalChars = source.text.length;
    if (source.view === 'full' && !args.stepId) result.excludedDerivedFields = [...VOLATILE];
    if (source.view === 'history') { result.retainedAttempts = source.step.pastAttempts?.length || 0; result.previouslyOmittedAttempts = source.step.pastAttemptsOmitted || 0; }
    let end = Math.min(source.text.length, offset + Math.min(args.limit || TASK_TOOL_VIEW_LIMITS.chunkChars, 10_000));
    if (end < source.text.length && /[\uD800-\uDBFF]/.test(source.text[end - 1])) end += end - offset === 1 ? 1 : -1;
    result.text = source.text.slice(offset, end);
    while (!fits(result, 600) && end > offset) {
      end = offset + Math.floor((end - offset) * .8);
      if (end < source.text.length && /[\uD800-\uDBFF]/.test(source.text[end - 1])) end--;
      result.text = source.text.slice(offset, end);
    }
    if (end === offset && offset < source.text.length) { end = offset + (/[\uD800-\uDBFF]/.test(source.text[offset]) ? 2 : 1); result.text = source.text.slice(offset, end); }
    result.nextOffset = end < source.text.length ? end : null;
  }
  if (result.nextOffset !== null) result.nextRead = nextRead(state, source.view, { ...(args.stepId ? { stepId: args.stepId } : {}), ...(args.status ? { status: args.status } : {}), offset: result.nextOffset, limit: args.limit || (source.view === 'outline' ? TASK_TOOL_VIEW_LIMITS.outlineItems : TASK_TOOL_VIEW_LIMITS.chunkChars), viewHash: source.hash });
  return result;
}

/** Called only after full-result planning/awareness processing. Input remains untouched. */
export function projectNativeTaskResult(receipt, args = {}, { maxBytes = TASK_TOOL_VIEW_LIMITS.replyBytes } = {}) {
  if (receipt?.success !== true || !Array.isArray(receipt.contentItems)) return receipt;
  const index = receipt.contentItems.findIndex(item => item.type === 'inputText');
  let state; try { state = JSON.parse(receipt.contentItems[index]?.text || 'null'); } catch { return receipt; }
  if (!state?.taskId || !Number.isSafeInteger(state.revision) || !Array.isArray(state.steps)) return receipt;
  const make = body => ({ ...receipt, contentItems: receipt.contentItems.map((item, position) => position === index ? { ...item, text: json(body) } : item) });
  const fits = (body, reserve = 0) => size(make(body)) <= maxBytes - reserve;
  let projected;
  try { projected = args.action === 'read' && args.view && args.view !== 'current' ? pagedView(state, args, fits) : compactCurrent(state, args, fits); }
  catch (error) { projected = { taskId: state.taskId, revision: state.revision, view: { kind: 'partial', omittedAllDetails: true }, warning: 'The saved operation retains its actual success. The compact view could not be prepared; inspect the saved state before further changes.', retrieval: nextRead(state, 'full') }; }
  if (!fits(projected)) projected = { taskId: state.taskId, revision: state.revision, view: { kind: 'partial', omittedAllDetails: true }, warning: 'Saved details exceed this reply budget. The operation retains its actual success; full saved details remain available through a pinned read.', retrieval: nextRead(state, 'full'), ...(state.externalActionResult ? { externalActionResult: state.externalActionResult } : {}), ...(state.externalRecovery ? { externalRecovery: state.externalRecovery } : {}) };
  // Safety annotations are never discarded or converted into retry-shaped
  // failures. Existing guards bound them independently of the state projection.
  return make(projected);
}
