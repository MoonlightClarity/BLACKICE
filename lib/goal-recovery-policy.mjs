import {createHash} from 'node:crypto';

const READ_ACTIONS = new Set(['read', 'snapshot', 'screenshot', 'tabs', 'list', 'get', 'status', 'search',
  'find', 'inspect', 'diagnostics', 'downloads', 'catalog', 'protection', 'history', 'describe']);
const POTENTIALLY_EFFECTFUL = new Set(['click', 'press', 'submit', 'send', 'create', 'delete', 'write',
  'patch', 'fill', 'select', 'upload', 'navigate', 'run', 'execute', 'approve', 'transfer', 'update',
  'post', 'publish', 'save', 'move', 'rename', 'type', 'interaction']);
const BLOCKER_CODES = /AUTH|DENIED|FORBIDDEN|NOT_ALLOWED|UNAVAILABLE|MISSING|UNSUPPORTED|SCOPE_REQUIRED/i;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const argsOf = call => typeof call?.arguments === 'string' ? parse(call.arguments) || {} : call?.arguments || {};
const CONTROL_READS = new Set(['workflow_get','observe_get','execution_get','runtime_get','operations_list','schedule_preview','job_get']);
const passiveCall = (call, action) => call.name === 'relay_find_files' || READ_ACTIONS.has(action)
  || call.name === 'relay_browser' && action === 'wait'
  || call.name === 'relay_workspace' && action === 'patch_history'
  || call.name === 'relay_control' && CONTROL_READS.has(action);
const receiptOf = result => (result?.contentItems || []).map(item => item?.type === 'inputText' ? parse(item.text) : null).find(row => row && typeof row === 'object') || {};

const searchSession = cursor => typeof cursor === 'string' && /^fs1:[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(cursor) ? cursor.split(':')[1] : null;
function searchCoverageOf(call, args, receipt, success) {
  if (call.name !== 'relay_find_files' || !success || receipt.engine !== 'filesystem'
    || !Number.isSafeInteger(receipt.scannedEntries) || receipt.scannedEntries < 0
    || typeof receipt.query !== 'string' || !Array.isArray(receipt.roots)
    || typeof receipt.scanComplete !== 'boolean') return null;
  const inputCursor = args.cursor ?? null, nextCursor = receipt.cursor;
  const sessionId = searchSession(inputCursor) || searchSession(nextCursor);
  if (!sessionId || inputCursor !== null && !searchSession(inputCursor)
    || nextCursor !== null && searchSession(nextCursor) !== sessionId
    || inputCursor !== null && searchSession(inputCursor) !== sessionId
    || (nextCursor === null) !== receipt.scanComplete
    || args.query !== undefined && args.query !== receipt.query) return null;
  return {sessionId, inputCursor, nextCursor, scannedEntries:receipt.scannedEntries,
    scope:sha([receipt.query,receipt.roots,receipt.match]), scanComplete:receipt.scanComplete};
}
function assessSearchCoverage(goal, evidence) {
  const retained = new Map((goal.searchProgress || []).slice(-16).map(row => [row.sessionId,row]));
  let advanced = false;
  for (const row of evidence) {
    const current = row?.searchCoverage;
    if (row?.tool !== 'relay_find_files' || row.kind !== 'observation' || !current) continue;
    const prior = retained.get(current.sessionId);
    if (!prior) { retained.set(current.sessionId,current); continue; }
    const continues = current.inputCursor !== null && prior.nextCursor === current.inputCursor
      && prior.scope === current.scope && current.nextCursor !== current.inputCursor
      && current.scannedEntries >= prior.scannedEntries;
    if (!continues) continue; // Reset, replay and terminal traversal restarts cannot advance a baseline.
    advanced ||= current.scannedEntries > prior.scannedEntries;
    // Even an empty directory page may rotate its cursor. Retain that identity, but not progress.
    retained.delete(current.sessionId); retained.set(current.sessionId,current);
  }
  return {advanced, retained:[...retained.values()].slice(-16)};
}


export function inFlightEffectSignature(call) {
  const args = argsOf(call), action = String(args.action || '').toLowerCase();
  if (call.name === 'relay_goal' || passiveCall(call, action)) return null;
  const canonical = Object.fromEntries(Object.entries(args).filter(([key]) => !['requestId','taskContext'].includes(key)).sort(([a],[b]) => a.localeCompare(b)));
  return sha([call.name, canonical]);
}

export function operationScope(call) {
  const args = argsOf(call), action = String(args.action || '').toLowerCase();
  const mode = args.ref ? 'observed-ref' : Number.isFinite(args.x) || Number.isFinite(args.y)
    ? 'coordinates' : action === 'press' ? 'keyboard' : 'other';
  const anchor = args.tabId || args.path || args.target || args.destination || args.url || '';
  const url = String(args.expectedUrl || args.url || '').split(/[?#]/, 1)[0];
  // Exclude ephemeral ref values so the same failed operation cannot evade
  // detection by refreshing a reference or changing its request ID.
  return sha([call.name, action, mode, anchor, url]);
}

export function detectUnknownEffectReplay(history = [], call) {
  const args = argsOf(call), action = String(args.action || '').toLowerCase();
  if (passiveCall(call, action) || !action || call.name === 'relay_goal') return null;
  const canonicalArgs = Object.fromEntries(Object.entries(args).filter(([key]) =>
    !['requestId', 'taskContext'].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
  const signature = sha([call.name, canonicalArgs]);
  const pending = history.find(row => row?.signature === signature && row.kind === 'uncertain_external_effect');
  if (!pending) return null;
  return {code:'GOAL_EFFECT_UNRESOLVED',actionDispatched:false,
    guidance:'An earlier identical effectful operation had an UNKNOWN external effect (' + (pending.code || 'unknown tool failure')
      + '). Read relay_goal effects and inspect the destination. Use relay_goal reconcile with the exact receipt identity and evidence. Keep genuinely unknown outcomes unknown; when a deliberate repeat is justified within the user objective, record retryReason instead of claiming absence. This permits one attempt in the current turn, not an automatic replay. Continue independent user-authorized work while checking.'};
}

export function detectNoProgressDispatchLoop(history = [], call, {after = 0, threshold = 3} = {}) {
  const args = argsOf(call), action = String(args.action || '').toLowerCase();
  if (passiveCall(call, action) || !action || call.name === 'relay_goal') return null;
  const scope = operationScope(call);
  const denied = history.filter(row => row?.scope === scope && row.success === false
    && row.actionDispatched === false && row.code && (!after || Date.parse(row.at || '') >= after));
  const counts = new Map();
  for (const row of denied) counts.set(row.code, (counts.get(row.code) || 0) + 1);
  const repeated = [...counts].find(([, count]) => count >= threshold);
  if (!repeated) return null;
  return {code: 'GOAL_REPLAN_REQUIRED', actionDispatched: false, originalCode: repeated[0], repeated: repeated[1],
    guidance: 'The host refused this operation without dispatch at least ' + repeated[1]
      + ' times on this unchanged target (' + repeated[0] + '). Do not try another reference to the same action or bypass its precondition using coordinates or keys. Inspect the actual host refusal and current destination, satisfy its missing precondition, or pursue a DIFFERENT independently authorized operation. No new external effect was dispatched.'};
}

export function observeGoalToolOutcome(call, result) {
  const args = argsOf(call), receipt = receiptOf(result), action = String(args.action || '').toLowerCase();
  const passive = passiveCall(call, action);
  const effectful = POTENTIALLY_EFFECTFUL.has(action) || (!passive && call.name !== 'relay_goal');
  const actionDispatched = typeof result?.actionDispatched === 'boolean' ? result.actionDispatched
    : typeof receipt?.actionDispatched === 'boolean' ? receipt.actionDispatched : null;
  const success = result?.success !== false;
  const code = String(result?.code || receipt.code || '').slice(0, 120);
  let kind, guidance = '';
  if (success) {
    kind = passive ? 'observation' : 'tool_executed_unverified';
  } else if (actionDispatched === false) {
    kind = 'recoverable_no_dispatch';
    const next = receipt.recovery?.nextCall;
    const refusal = typeof receipt.error === 'string' ? receipt.error : typeof receipt.error?.message === 'string'
      ? receipt.error.message : typeof receipt.message === 'string' ? receipt.message : '';
    guidance = /UNINSPECTED|UNCLASSIFIED|PRECONDITION|RECONCILE_REQUIRED|STALE/i.test(code)
      ? 'The HOST refused the operation before dispatch (' + code + '). '
        + (refusal ? refusal.slice(0, 350) + ' ' : '')
        + 'Do not reinterpret a host error as a website CAPTCHA or bypass the refusal with coordinates or keyboard events. Observe the exact control or read the required history/state, satisfy the stated precondition, and then attempt a supported DIFFERENT next step.'
        + (next && typeof next === 'object' ? ' Concrete recovery observation: ' + JSON.stringify(next).slice(0,600) : '')
      : next && typeof next === 'object'
        ? 'No action was dispatched. Inspect the returned observation; an available concrete recovery observation is: ' + JSON.stringify(next).slice(0, 600)
        : 'The action was not dispatched. Reobserve the actual state, change the failed precondition or tool route, then try a supported next step.';
  } else if (effectful) {
    kind = 'uncertain_external_effect';
    guidance = 'An external action may have taken effect. Do NOT replay it from this error. Inspect the destination and saved receipts read-only; if still unresolved record UNKNOWN and pursue an independent authorized branch.';
  } else if (BLOCKER_CODES.test(code)) {
    kind = 'candidate_blocker';
    guidance = 'This capability reports unavailable or denied. Check whether an independently authorized alternate tool or path exists. Report a genuine blocker only for the affected operation after alternatives are assessed.';
  } else {
    kind = 'recoverable_read_friction';
    guidance = 'This observation failed, not the objective. Inspect the tool error and choose another evidence source or valid precondition; do not repeat an unchanged failing read.';
  }
  const canonicalArgs = Object.fromEntries(Object.entries(args).filter(([key]) => !['requestId', 'taskContext'].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
  const excerpt = (result?.contentItems || []).filter(item => item?.type === 'inputText').map(item => String(item.text || '')).join('\n').slice(0, 1400);
  const searchCoverage = searchCoverageOf(call,args,receipt,result?.success === true);
  return {tool: call.name, action: action || null, kind, code: code || null,
    actionDispatched, scope: operationScope(call), signature: sha([call.name, canonicalArgs]),
    resultDigest: sha([success, code, excerpt]), success, guidance,
    ...(searchCoverage ? {searchCoverage} : {})};
}

export function repeatedUnproductiveOperations(previous = [], current = []) {
  const earlier = new Set(previous.filter(row => row?.signature && row?.resultDigest)
    .map(row => row.signature + ':' + row.resultDigest));
  return current.filter(row => row?.signature && row?.resultDigest
    && earlier.has(row.signature + ':' + row.resultDigest)
    && row.kind !== 'observation').map(row => ({tool: row.tool, action: row.action, kind: row.kind}));
}

export function assessGoalProgress(goal = {}, run = {}) {
  const report = run.goalProgress || null;
  const search = assessSearchCoverage(goal, run.goalEvidence || []);
  const observed = typeof report?.observedMilestone === 'string' && report.observedMilestone
    && !(goal.milestones || []).includes(report.observedMilestone) ? report.observedMilestone : null;
  // Agent-authored milestone strings and successful tool calls are not independent outcome evidence.
  // A wholly tool-free reasoning/writing turn may develop a new work product, but this is
  // provisional model-reported progress, not a destination-confirmed external effect.
  const reasoning = !run.goalEvidence?.length && Boolean(report?.evidence)
    && report.evidence !== goal.previousProgressEvidence;
  const repeated = repeatedUnproductiveOperations(goal.lastToolEvidence || [], run.goalEvidence || []);
  const newAction = (run.goalEvidence || []).some(row => row?.signature
    && !(goal.lastToolEvidence || []).some(old => old.signature === row.signature));
  const previousNext = String(goal.previousNextAction || '').trim().toLowerCase();
  const next = String(report?.nextAction || '').trim().toLowerCase();
  return {progress: Boolean(report?.evidence && observed) || reasoning || search.advanced,
    searchProgress: search.retained, searchAdvanced: search.advanced,
    progressKind: observed ? 'host_observed_intermediate' : search.advanced ? 'host_observed_search_coverage' : reasoning ? 'provisional_reasoning' : 'unverified',
    observedMilestone: observed, repeated, newAction,
    repeatedNextAction: Boolean(next && previousNext && next === previousNext)};
}
