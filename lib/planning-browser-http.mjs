import { createHash, randomUUID } from 'node:crypto';
import { PLANNING_BROWSER_VERSION, PLANNING_MODULE_TEMPLATES, legacyPlanningError } from '../public/planning-browser-model.mjs';
import { planningProgramXml } from '../public/planning-program-xml.mjs';

const BASE = '/api/planning-browser';
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const WRITE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const fail = (message, status = 400, code = 'PLANNING_BROWSER_REQUEST_INVALID') => Object.assign(new Error(message), { status, code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('Use only the declared Planning request fields. Runtime provenance and completion state are recorded by the host.');
  return value;
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const options = (value, actor, parent = false) => ({
  actor, ...(parent ? pick(value, ['expectedParentRevision']) : pick(value, ['expectedNodeRevision'])),
  ...pick(value, ['clientRequestId'])
});

const pendingExecution = new Set(['admitting', 'queued', 'prepared', 'starting', 'running', 'repairing', 'cancelling']);
const executionState = statuses => statuses.includes('running') ? 'running'
  : statuses.includes('cancelling') ? 'stopping' : statuses.includes('repairing') ? 'repairing'
  : statuses.some(state => ['admitting', 'queued', 'prepared', 'starting'].includes(state)) ? 'queued'
  : statuses.includes('unknown') ? 'unknown' : statuses.includes('failed') ? 'failed' : 'idle';
function executionSnapshot(runner) {
  try { const snapshot = runner?.status?.(); return Array.isArray(snapshot?.attempts) ? snapshot : null; }
  catch { return null; }
}
/** Add current host observations without rewriting the durable execution ledger. */
export function projectPlanningBrowserExecution(request, snapshot) {
  if (!request?.id) return request;
  const live = (snapshot?.attempts || []).filter(item => item.requestId === request.id && pendingExecution.has(item.status))
    .map(({ id, nodeId, status }) => ({ id, nodeId, status }));
  const byNode = new Map(live.map(item => [item.nodeId, item]));
  const latest = new Map((request.attempts || []).map(item => [item.nodeId, item]));
  const statuses = live.map(item => item.status);
  for (const attempt of latest.values()) {
    if (pendingExecution.has(attempt.status) && !live.some(item => item.id === attempt.id)) statuses.push('unknown');
    else if (attempt.status === 'failed') statuses.push('failed');
  }
  if (!Array.isArray(request.attempts) && Number(request.summary?.running) > 0 && !live.length) statuses.push('unknown');
  const execution = { source: 'planning-runtime', available: Boolean(snapshot), state: snapshot ? executionState(statuses) : 'unknown',
    running: live.filter(item => item.status === 'running').length, attempts: live };
  const result = { ...request, execution };
  if (Array.isArray(request.attempts)) result.attempts = request.attempts.map(attempt => {
    const observed = live.find(item => item.id === attempt.id && item.nodeId === attempt.nodeId);
    return { ...attempt, ...(observed ? { workerStatus: observed.status }
      : pendingExecution.has(attempt.status) ? { workerStatus: 'unknown' } : {}) };
  });
  if (Array.isArray(request.nodes)) result.nodes = request.nodes.map(node => {
    const observed = byNode.get(node.id), attempt = latest.get(node.id);
    const state = observed?.status || (pendingExecution.has(attempt?.status) || node.readiness?.state === 'running' ? 'unknown' : null);
    return { ...node, ...(state ? { executionStatus: state } : {}) };
  });
  if (Array.isArray(request.cycles)) result.cycles = request.cycles.map(cycle => {
    const ids = new Set([cycle.id, ...Object.values(cycle.stageNodeIds || {})]);
    for (let changed = true; changed;) {
      changed = false;
      for (const node of request.nodes || []) if (!ids.has(node.id) && ids.has(node.parentId)) { ids.add(node.id); changed = true; }
    }
    const states = (result.nodes || []).filter(node => ids.has(node.id) && node.executionStatus).map(node => node.executionStatus);
    if (!states.length && cycle.state === 'running') states.push('unknown');
    return { ...cycle, ...(states.length ? { executionStatus: executionState(states) } : {}) };
  });
  return result;
}

export async function planningBrowserCatalog({ store, conversations, runtime, runtimeSettings, runner }) {
  const catalog = await store.list();
  const snapshot = executionSnapshot(runner);
  const requests = (catalog.requests || []).map(request => projectPlanningBrowserExecution(request, snapshot));
  const groups = new Map();
  for (const conversation of conversations?.list?.('all') || []) {
    const id = conversation.taskId || conversation.rootId || conversation.id;
    if (!id || conversation.state === 'deleted' || conversation.bucket === 'deleted') continue;
    groups.set(id, {
      id, title: conversation.title || conversation.name || 'Conversation',
      state: conversation.state || conversation.bucket || 'active',
      status: conversation.status || null, settled: conversation.settled === true,
      source: 'conversation', runId: conversation.latestRunId || conversation.runId || conversation.id
    });
  }
  for (const request of requests) {
    if (!groups.has(request.conversationId)) groups.set(request.conversationId, {
      id: request.conversationId, title: request.conversationTitle || request.title || 'Planning conversation',
      state: 'active', source: 'planning'
    });
  }
  const settings = runtimeSettings?.get?.() || {};
  const status = runtime?.status?.() || {};
  return {
    version: PLANNING_BROWSER_VERSION,
    conversations: [...groups.values()].map(group => ({ ...group, requests: requests.filter(request => request.conversationId === group.id) })),
    requests, errors: catalog.errors || [], templates: PLANNING_MODULE_TEMPLATES,
    runtime: {
      defaultModel: status.defaultModel || 'default',
      defaultEffort: settings.defaultEffort || 'default',
      defaultServiceTier: settings.defaultServiceTier || 'default',
      subagentsEnabled: settings.subagentsEnabled === true,
      maxSubagents: settings.maxSubagents || 3
    }
  };
}

/** Local/paired-human HTTP adapter. Trusted model-response recording is never an HTTP operation. */
export async function handlePlanningBrowserHttp({
  req, res, pathname, store, runner, conversations, runtime, runtimeSettings, taskViability, operations, responseCycle,
  defaultCwd, body, json, fileMutations, onUpdated = () => {}, isClosing = () => false,
  actor = { type: 'human', id: 'local' }
}) {
  if (pathname !== BASE && !pathname.startsWith(BASE + '/')) return false;
  const method = req.method;
  const mutate = async (operation, status = 200) => {
    if (isClosing()) throw fail('BLACKICE is closing for maintenance. The saved Planning draft is unchanged.', 503, 'PLANNING_BROWSER_CLOSING');
    const pending = Promise.resolve().then(operation);
    fileMutations?.add(pending);
    try {
      const request = await pending;
      try { const notification = onUpdated({ type: 'planning.browser.updated', data: { requestId: request?.id, conversationId: request?.conversationId, revision: request?.revision }, at: new Date().toISOString() }); notification?.catch?.(() => {}); } catch { /* A notification failure does not undo a committed edit. */ }
      json(res, status, projectPlanningBrowserExecution(request, executionSnapshot(runner)));
    } finally { fileMutations?.delete(pending); }
  };
  try {
    if (pathname === BASE && method === 'GET') {
      json(res, 200, await planningBrowserCatalog({ store, conversations, runtime, runtimeSettings, runner }));
      return true;
    }
    const segments = pathname.slice(BASE.length + 1).split('/');
    if (segments[0] !== 'requests' || segments.slice(1).some(segment => !ID.test(segment))) throw fail('Planning resource not found.', 404, 'PLANNING_BROWSER_NOT_FOUND');
    const [_, requestId, collection, nodeId, action] = segments;
    if (method === 'POST' && (collection === 'cycles' || collection === 'viability' && nodeId === 'answer')) throw legacyPlanningError();
    const value = WRITE.has(method) ? await body(req, collection === 'program' ? 640 * 1024 : 256 * 1024) : null;
    if (segments.length === 1 && method === 'POST') {
      fields(value, ['conversationId', 'title', 'objective', 'cwd', 'clientRequestId', 'planningExecutionMode']);
      if (Object.hasOwn(value, 'planningExecutionMode')) throw legacyPlanningError();
      const conversationId = value.conversationId || 'planning_' + (typeof value.clientRequestId === 'string'
        ? createHash('sha256').update(value.clientRequestId).digest('hex') : randomUUID());
      await mutate(() => store.create({ ...value, conversationId, cwd: value.cwd || defaultCwd }, { actor }), 201);
      return true;
    }
    if (segments.length === 2 && method === 'GET') {
      json(res, 200, projectPlanningBrowserExecution(await store.get(requestId), executionSnapshot(runner))); return true;
    }
    if (collection === 'program' && segments.length === 3) {
      if (method === 'GET') {
        const request = await store.get(requestId);
        json(res, 200, { requestId, revision: request.revision, xml: request.programXml || planningProgramXml(request) });
        return true;
      }
      if (method === 'PUT') {
        fields(value, ['xml', 'expectedRevision', 'clientRequestId']);
        await mutate(() => store.updateProgram(requestId, { xml: value.xml, expectedRevision: value.expectedRevision }, { actor, clientRequestId: value.clientRequestId }));
        return true;
      }
      throw fail('Planning XML method not supported.', 405, 'PLANNING_XML_METHOD');
    }

    if (segments.length === 3 && collection === 'nodes' && method === 'POST') {
      fields(value, ['parentId', 'kind', 'title', 'prompt', 'doneWhen', 'skipReason', 'expectedParentRevision', 'clientRequestId']);
      await mutate(() => store.addNode(requestId, pick(value, ['parentId', 'kind', 'title', 'prompt', 'doneWhen', 'skipReason']), options(value, actor, true)), 201);
      return true;
    }
    if (segments.length === 3 && collection === 'sources' && method === 'POST') {
      fields(value, ['title', 'text', 'url', 'clientRequestId']);
      await mutate(() => store.addSource(requestId, pick(value, ['title', 'text', 'url']), { actor, ...pick(value, ['clientRequestId']) }), 201);
      return true;
    }
    if (segments.length === 3 && collection === 'edges' && method === 'POST') {
      fields(value, ['kind', 'from', 'to', 'sourceResponseId', 'sourceResponseRevision', 'sourceField', 'freshness', 'expectedNodeRevision', 'clientRequestId']);
      await mutate(() => store.link(requestId, pick(value, ['kind', 'from', 'to', 'sourceResponseId', 'sourceResponseRevision', 'sourceField', 'freshness']), options(value, actor)), 201);
      return true;
    }
    if (collection === 'nodes' && nodeId && segments.length === 4 && method === 'PATCH') {
      fields(value, ['title', 'prompt', 'kind', 'parentId', 'doneWhen', 'skipReason', 'expectedNodeRevision', 'clientRequestId']);
      await mutate(() => store.updateNode(requestId, nodeId, pick(value, ['title', 'prompt', 'kind', 'parentId', 'doneWhen', 'skipReason']), options(value, actor)));
      return true;
    }
    if (collection === 'nodes' && nodeId && segments.length === 5 && method === 'POST') {
      if (action === 'responses') {
        fields(value, ['values', 'grounding', 'openQuestions', 'challengeResponses', 'requirements', 'checks', 'subproblems', 'childResults', 'acceptanceCriteria', 'steps', 'inferences', 'criterionResults', 'coverage', 'userAgency', 'contract', 'expectedNodeRevision']);
        await mutate(() => store.recordHumanResponse(requestId, nodeId, pick(value, ['values', 'grounding', 'openQuestions', 'challengeResponses', 'requirements', 'checks', 'subproblems', 'childResults', 'acceptanceCriteria', 'steps', 'inferences', 'criterionResults', 'coverage', 'userAgency', 'contract']), options(value, actor)));
        return true;
      }
      if (action === 'assignment') {
        fields(value, ['ownerId', 'label', 'scope', 'expectedNodeRevision']);
        await mutate(() => store.assign(requestId, nodeId, pick(value, ['ownerId', 'label', 'scope']), options(value, actor)));
        return true;
      }
      if (action === 'run') {
        fields(value, ['model', 'effort', 'serviceTier', 'expectedNodeRevision', 'clientRequestId']);
        await mutate(async () => {
          const saved=await store.get(requestId);if(saved.nodes.find(node=>node.id===nodeId)?.skipReason)throw fail('A skipped module must be resumed before execution.',409,'PLANNING_MODULE_SKIPPED');
          await runner.start({ requestId, nodeId, ...value, automatic: false });
          return store.get(requestId);
        }, 202);
        return true;
      }
      if (action === 'cancel') {
        fields(value, ['attemptId', 'reason']);
        await mutate(async () => {
          const request = await store.get(requestId);
          const attempt = (request.attempts || []).find(item => item.nodeId === nodeId && (!value.attemptId || item.id === value.attemptId) && ['queued', 'running'].includes(item.status));
          if (!attempt) throw fail('No matching active module worker remains. Refresh the request to inspect its result.', 409, 'PLANNING_BROWSER_ATTEMPT_SETTLED');
          await runner.cancel(attempt.id, { reason: value.reason || 'Stopped from the Planning workspace.' });
          return store.get(requestId);
        });
        return true;
      }
    }
    throw fail('Planning resource or method not found.', 404, 'PLANNING_BROWSER_NOT_FOUND');
  } catch (error) {
    json(res, error.status || 400, {
      error: error.message,
      code: typeof error.code === 'string' ? error.code : 'PLANNING_BROWSER_REQUEST_FAILED',
      ...(Number.isSafeInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {}),
      ...(Number.isSafeInteger(error.currentNodeRevision) ? { currentNodeRevision: error.currentNodeRevision } : {})
    });
    return true;
  }
}
