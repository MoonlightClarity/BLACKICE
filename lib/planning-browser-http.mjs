import { createHash, randomUUID } from 'node:crypto';
import { PLANNING_BROWSER_VERSION, PLANNING_MODULE_TEMPLATES } from '../public/planning-browser-model.mjs';
import { planningExecutionModeOf } from '../public/response-cycle-model.mjs';

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

export async function planningBrowserCatalog({ store, conversations, runtime, runtimeSettings }) {
  const catalog = await store.list();
  const requests = catalog.requests || [];
  const groups = new Map();
  for (const conversation of conversations?.list?.('all') || []) {
    const id = conversation.taskId || conversation.rootId || conversation.id;
    if (!id || conversation.state === 'deleted' || conversation.bucket === 'deleted') continue;
    groups.set(id, {
      id, title: conversation.title || conversation.name || 'Conversation',
      state: conversation.state || conversation.bucket || 'active',
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
      json(res, status, request);
    } finally { fileMutations?.delete(pending); }
  };
  try {
    if (pathname === BASE && method === 'GET') {
      json(res, 200, await planningBrowserCatalog({ store, conversations, runtime, runtimeSettings }));
      return true;
    }
    const segments = pathname.slice(BASE.length + 1).split('/');
    if (segments[0] !== 'requests' || segments.slice(1).some(segment => !ID.test(segment))) throw fail('Planning resource not found.', 404, 'PLANNING_BROWSER_NOT_FOUND');
    const [_, requestId, collection, nodeId, action] = segments;
    const value = WRITE.has(method) ? await body(req, 256 * 1024) : null;
    if (segments.length === 1 && method === 'POST') {
      fields(value, ['conversationId', 'title', 'objective', 'cwd', 'clientRequestId', 'planningExecutionMode']);
      const { planningExecutionMode: requestedMode, ...definition } = value;
      const planningExecutionMode = planningExecutionModeOf(requestedMode);
      if (planningExecutionMode && !responseCycle) throw fail('The recursive response planner is unavailable.', 503, 'PLANNING_CYCLE_UNAVAILABLE');
      // A caller's stable creation ID also stabilizes an automatically grouped conversation.
      const conversationId = value.conversationId || 'planning_' + (typeof value.clientRequestId === 'string'
        ? createHash('sha256').update(value.clientRequestId).digest('hex') : randomUUID());
      await mutate(async () => {
        const request = await store.create({ ...definition, conversationId, cwd: value.cwd || defaultCwd }, { actor, planningExecutionMode });
        if (!planningExecutionMode) return request;
        // Keep the initial revision and cycle key stable across partial or uncertain delivery.
        // createCycle recognizes its existing receipt before enforcing the initial revision.
        return responseCycle.createCycle(request.id, {
          title: value.title, purpose: value.objective, planningExecutionMode,
          expectedRequestRevision: 1, clientRequestId: 'request-root-cycle'
        }, { actor });
      }, 201);
      return true;
    }
    if (segments.length === 2 && method === 'GET') {
      json(res, 200, await store.get(requestId)); return true;
    }
    if (collection === 'cycles' && method === 'POST') {
      if(!responseCycle)throw fail('The recursive response planner is unavailable.',503,'PLANNING_CYCLE_UNAVAILABLE');
      if(segments.length===3){
        fields(value,['parentNodeId','title','purpose','planningExecutionMode','expectedRequestRevision','expectedParentRevision','clientRequestId']);
        await mutate(()=>responseCycle.createCycle(requestId,value,{actor}),201);return true;
      }
      if(segments.length===5&&action==='run'){
        fields(value,['expectedRequestRevision','expectedCycleRevision','planningExecutionMode','model','effort','serviceTier','clientRequestId']);
        await mutate(()=>responseCycle.runCycle(requestId,nodeId,value,{actor}));return true;
      }
      if(segments.length===5&&action==='plan'){
        fields(value,['expectedRequestRevision','expectedCycleRevision','expectedPlanRevision','expectedPlanResponseId','plan','clientRequestId']);
        await mutate(()=>responseCycle.editPlan(requestId,nodeId,value,{actor}));return true;
      }
      if(segments.length===5&&action==='continue'){
        fields(value,['expectedRequestRevision','expectedCycleRevision','expectedPlanRevision','expectedPlanResponseId','clientRequestId']);
        await mutate(()=>responseCycle.continueCycle(requestId,nodeId,value,{actor}));return true;
      }
      throw fail('Response-cycle action not found.',404,'PLANNING_CYCLE_NOT_FOUND');
    }
    if (segments.length === 4 && collection === 'viability' && nodeId === 'answer' && method === 'POST') {
      if(!responseCycle?.answerQuestion&&!taskViability)throw fail('Task readiness is unavailable.',503,'TASK_VIABILITY_UNAVAILABLE');
      fields(value,['nodeId','requirementId','answer','expectedNodeRevision','expectedResponseId','clientRequestId']);
      await mutate(()=>responseCycle?.answerQuestion?responseCycle.answerQuestion(requestId,value,{operations,actor}):taskViability.answer(requestId,value,{operations,actor}));return true;
    }
    if (segments.length === 3 && collection === 'nodes' && method === 'POST') {
      fields(value, ['parentId', 'kind', 'title', 'prompt', 'expectedParentRevision', 'clientRequestId']);
      await mutate(() => store.addNode(requestId, pick(value, ['parentId', 'kind', 'title', 'prompt']), options(value, actor, true)), 201);
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
      fields(value, ['title', 'prompt', 'kind', 'parentId', 'expectedNodeRevision', 'clientRequestId']);
      await mutate(() => store.updateNode(requestId, nodeId, pick(value, ['title', 'prompt', 'kind', 'parentId']), options(value, actor)));
      return true;
    }
    if (collection === 'nodes' && nodeId && segments.length === 5 && method === 'POST') {
      if (action === 'responses') {
        fields(value, ['values', 'grounding', 'openQuestions', 'challengeResponses', 'requirements', 'checks', 'subproblems', 'childResults', 'acceptanceCriteria', 'steps', 'inferences', 'criterionResults', 'coverage', 'expectedNodeRevision']);
        await mutate(() => store.recordHumanResponse(requestId, nodeId, pick(value, ['values', 'grounding', 'openQuestions', 'challengeResponses', 'requirements', 'checks', 'subproblems', 'childResults', 'acceptanceCriteria', 'steps', 'inferences', 'criterionResults', 'coverage']), options(value, actor)));
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
