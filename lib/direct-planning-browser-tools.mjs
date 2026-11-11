import { PLAN_CONTRACT_SCHEMA } from '../public/planning-contract-model.mjs';
import { planningProgramXml } from '../public/planning-program-xml.mjs';
import { projectPlanningBrowserExecution } from './planning-browser-http.mjs';
import {viabilityRequirementSchema} from '../public/task-viability-model.mjs';
import {responseCycleResponseSchema,RESPONSE_CYCLE_STAGES} from '../public/response-cycle-model.mjs';
import { USER_AGENCY_CHECKPOINT_SCHEMA } from '../public/planning-user-agency.mjs';
import { PLANNING_BROWSER_VERSION, PLANNING_MODULE_TEMPLATES, PLANNING_LINK_KINDS } from '../public/planning-browser-model.mjs';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength });
const requestId = { ...string(120), pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$', description: 'Stable ID for this exact direct action under the current connection. Identical retries recover its saved receipt; use a new ID to read a fresh snapshot.' };
const id = { ...string(120), pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$' };
const revision = { type: 'integer', minimum: 1 };
const page = { offset: { type: 'integer', minimum: 0, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const kinds = { enum: PLANNING_MODULE_TEMPLATES.map(template => template.kind) };
const common = { requestId, graphRequestId: { ...id, description: 'ID of the shared Planning request, distinct from the direct requestId.' } };
const responseProperties = Object.fromEntries(PLANNING_MODULE_TEMPLATES.flatMap(template => template.fields.map(field => [field.id, string(8000, 0)])));
const cycleResponseProperties={contract:structuredClone(PLAN_CONTRACT_SCHEMA),userAgency:structuredClone(USER_AGENCY_CHECKPOINT_SCHEMA),...Object.fromEntries(['inference','plan','think','respond'].flatMap(stage=>Object.entries(responseCycleResponseSchema(stage).properties).filter(([key])=>!['values','grounding','openQuestions','challengeResponses'].includes(key))))};
cycleResponseProperties.checks.items.properties.id.enum=[...new Set(RESPONSE_CYCLE_STAGES.flatMap(stage=>stage.checks.map(check=>check.id)))];
const response = {
  ...cycleResponseProperties,
  requirements: viabilityRequirementSchema(),
  values: object(responseProperties),
  grounding: { type: 'array', maxItems: 100, items: object({ field: { enum: Object.keys(responseProperties) }, sourceId: string(300) }, ['field', 'sourceId']) },
  openQuestions: { type: 'array', maxItems: 40, items: string(2000) },
  challengeResponses: { type: 'array', maxItems: 100, items: object({ edgeId: id, disposition: { enum: ['addressed', 'open'] }, note: string(4000) }, ['edgeId', 'disposition', 'note']) },
};
const action = (name, properties = {}, required = []) => object({ requestId, action: { const: name }, ...properties }, ['requestId', 'action', ...required]);
// MCP clients render root properties but may not expand a root-only oneOf.
// Advertise every action-specific field at the root while preserving exact
// oneOf validation (including required fields and forbidden extras).
const union = variants => {
  const properties={};
  for(const variant of variants)for(const [key,spec] of Object.entries(variant.properties||{})){
    if(key==='action')continue;
    if(!Object.hasOwn(properties,key)){properties[key]=spec;continue;}
    const prior=JSON.stringify(properties[key]),current=JSON.stringify(spec);
    if(prior===current)continue;
    const options=properties[key].anyOf?properties[key].anyOf:[properties[key]];
    if(!options.some(item=>JSON.stringify(item)===current))options.push(spec);
    properties[key]={anyOf:options};
  }
  properties.action={type:'string',enum:variants.map(row=>row.properties.action.const),
    description:'Choose one action. Required fields and exact allowed keys are enforced by the corresponding variant.'};
  return {type:'object',properties,required:['requestId','action'],additionalProperties:false,oneOf:variants};
};
const readSchema = union([
  action('list', { conversationId: id, query: string(500, 0), ...page }),
  action('templates'),
  action('get', { graphRequestId: common.graphRequestId, nodeId: id, ...page, edgeOffset: page.offset, sourceOffset: page.offset, inputOffset: page.offset, attemptOffset: page.offset }, ['graphRequestId']),
  action('program', { graphRequestId: common.graphRequestId, offset: page.offset, limit: { type: 'integer', minimum: 1, maximum: 50000 } }, ['graphRequestId']),
  action('attempts', { graphRequestId: common.graphRequestId, nodeId: id, ...page }, ['graphRequestId']),
  action('source', { graphRequestId: common.graphRequestId, sourceId: string(300) }, ['graphRequestId', 'sourceId']),
  action('response_history', { graphRequestId: common.graphRequestId, nodeId: id, responseId: id, ...page, inputOffset: page.offset }, ['graphRequestId']),
]);
const writeSchema = union([
  action('create_request', { graphRequestId: common.graphRequestId, conversationId: id, title: string(240), objective: string(12000), cwd: string(4096) }, ['title', 'objective']),
  action('add_module', { graphRequestId: common.graphRequestId, nodeId: id, parentId: id, kind: kinds, title: string(240), prompt: string(12000, 0), doneWhen: string(1000, 0), skipReason: string(1000, 0), expectedParentRevision: revision }, ['graphRequestId', 'kind', 'title']),
  action('update_module', { graphRequestId: common.graphRequestId, nodeId: id, title: string(240), prompt: string(12000, 0), kind: kinds, parentId: { anyOf: [id, { type: 'null' }] }, doneWhen: string(1000, 0), skipReason: string(1000, 0), expectedNodeRevision: revision }, ['graphRequestId', 'nodeId', 'expectedNodeRevision']),
  action('update_program', { graphRequestId: common.graphRequestId, xml: string(640000), expectedRequestRevision: revision }, ['graphRequestId', 'xml', 'expectedRequestRevision']),
  action('assign', { graphRequestId: common.graphRequestId, nodeId: id, ownerId: id, label: string(240), scope: { enum: ['node', 'subtree'] }, expectedNodeRevision: revision }, ['graphRequestId', 'nodeId', 'ownerId', 'scope', 'expectedNodeRevision']),
  action('link', { graphRequestId: common.graphRequestId, edgeId: id, kind: { enum: PLANNING_LINK_KINDS }, from: id, to: id, sourceResponseId: id, sourceResponseRevision: revision, sourceField: string(120), freshness: { enum: ['latest', 'pinned'] }, expectedNodeRevision: revision }, ['graphRequestId', 'kind', 'from', 'to', 'expectedNodeRevision']),
  action('add_source', { graphRequestId: common.graphRequestId, title: string(240), text: string(40000), url: string(2000) }, ['graphRequestId', 'title', 'text']),
  action('record_response', { graphRequestId: common.graphRequestId, nodeId: id, expectedNodeRevision: revision, ...response }, ['graphRequestId', 'nodeId', 'expectedNodeRevision', 'values']),
]);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const failure = (message, code = 'DIRECT_PLANNING_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const check = signal => { if (signal?.aborted) throw Object.assign(failure('Planning action cancelled before dispatch.', 'ABORT_ERR', 409), { name: 'AbortError' }); };
const result = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const sourceMetadata = source => pick(source, ['id', 'kind', 'title', 'url', 'revision', 'responseId', 'contentHash', 'provenance', 'verified']);
const responseMetadata = value => value ? pick(value, ['id', 'nodeId', 'kind', 'revision', 'nodeRevision', 'provenance', 'verifiedAction']) : null;
const inputReference = input => {
  const { values, subtree, ...reference } = input;
  return { ...reference, ...(Array.isArray(subtree) ? { subtree: subtree.map(inputReference) } : {}) };
};
const responseDetail = (value, { inputOffset = 0, limit = 40 } = {}) => {
  if (!value) return null;
  const { sources, inputs, ...response } = value;
  return { ...response, sourceIds: (sources || []).map(source => source.id), inputs: pagination((inputs || []).map(inputReference), inputOffset, limit) };
};
const pagination = (values, offset, limit) => {
  const items = []; let bytes = 0;
  for (const item of values.slice(offset, offset + limit)) { const size = Buffer.byteLength(JSON.stringify(item)); if (items.length && bytes + size > 512 * 1024) break; items.push(item); bytes += size; }
  return { items, total: values.length, offset, limit, nextOffset: offset + items.length < values.length ? offset + items.length : null };
};
const requestMetadata = request => pick(request, ['id', 'conversationId', 'title', 'objective', 'cwd', 'revision', 'createdAt', 'updatedAt', 'summary', 'cycles', 'execution']);
export const planningAttemptMetadata = attempt => ({...pick(attempt, ['id', 'nodeId', 'purpose', 'status', 'workerStatus', 'nodeRevision', 'model', 'effort', 'serviceTier', 'createdAt', 'startedAt', 'finishedAt', 'responseId', 'error', 'message', 'cancelReason', 'formatRepairOf', 'repairOf', 'repairIndex', 'repairAttemptId']),
  ...(attempt.purpose==='child_admission'?{semanticReview:{kind:'model_judgment',version:attempt.childAdmission?.snapshot?.version,responseId:attempt.childAdmission?.snapshot?.responseId,binding:attempt.childAdmission?.snapshot?.binding,...(attempt.childAdmission?.judgment?{judgment:attempt.childAdmission.judgment}:{}),...(attempt.metadata?.usage?{usage:attempt.metadata.usage}:{})}}:{}),
  ...(attempt.semanticRefinement?{semanticRefinementOf:attempt.semanticRefinement.reviewAttemptId}:{})});
const edgeMetadata = edge => edge.knowledge ? { ...edge, knowledge: { ...pick(edge.knowledge, ['id', 'revision', 'title', 'cwd', 'provenance']), sourceId: 'knowledge:' + edge.knowledge.id + ':' + edge.knowledge.revision } } : edge;

/** Page document structure without embedding every historical input/source snapshot. */
export function readPlanningGraphRequest(request, { nodeId, offset = 0, edgeOffset = 0, sourceOffset = 0, inputOffset = 0, attemptOffset = 0, limit = 40 } = {}) {
  const nodes = request.nodes || [], selected = nodeId ? nodes.find(node => node.id === nodeId) : null;
  if (nodeId && !selected) throw failure('Planning module not found.', 'PLANNING_NODE_NOT_FOUND', 404);
  const nodePage = pagination(nodes.map(node => ({ ...node, response: responseMetadata(node.response) })), offset, limit);
  const visible = selected ? [selected] : nodePage.items, ids = new Set(visible.map(node => node.id));
  const edges = (request.edges || []).filter(edge => ids.has(edge.from) || selected && edge.to === selected.id);
  return {
    request: requestMetadata(request),
    ...(selected ? { node: { ...selected, response: responseDetail(selected.response, { inputOffset, limit }) } } : {
      nodes: nodePage
    }),
    attempts: pagination((request.attempts || []).filter(attempt => !nodeId || attempt.nodeId === nodeId).map(planningAttemptMetadata), attemptOffset, limit),
    edges: pagination(edges.map(edgeMetadata), edgeOffset, limit),
    sources: pagination((request.sources || []).map(sourceMetadata), sourceOffset, limit),
    reading: 'Saved public graph data. Source metadata and input references do not verify their claims. Use source for exact material and response_history with responseId for an earlier public response.'
  };
}

/** Host-bound, durable direct tools. This factory receives no provider or worker runner. */
export function createDirectPlanningBrowserTools({ store, getCatalog = null, getExecutionSnapshot = null, writerContext = null, onChange = () => {} } = {}) {
  if (!store || ['list', 'get', 'create', 'addNode', 'updateNode', 'link', 'addSource'].some(method => typeof store[method] !== 'function')) throw failure('Use the app-owned Planning store.', 'DIRECT_PLANNING_CONFIGURATION', 503);
  if (getCatalog !== null && typeof getCatalog !== 'function' || typeof onChange !== 'function') throw failure('Use app-owned Planning catalog and event callbacks.', 'DIRECT_PLANNING_CONFIGURATION', 503);
  if (getExecutionSnapshot !== null && typeof getExecutionSnapshot !== 'function') throw failure('Use an app-owned execution snapshot provider.', 'DIRECT_PLANNING_CONFIGURATION', 503);
  const project = request => { let snapshot = null; try { snapshot = getExecutionSnapshot?.() || null; } catch {} return projectPlanningBrowserExecution(request, snapshot); };
  if (writerContext !== null && typeof writerContext !== 'function') throw failure('Use a host-owned writer context provider.', 'DIRECT_PLANNING_CONFIGURATION', 503);
  const external = store.externalWriter?.();
  const writer = writerContext || ((args, { client, jobId }) => {
    if (!client?.id || !jobId) throw failure('Planning writes require an authenticated durable direct job.', 'DIRECT_AUTH_REQUIRED', 401);
    return { actor: { type: 'external-agent', id: client.id }, clientRequestId: jobId, recordResponse: (requestId, nodeId, value, options) => {
      if (typeof external?.recordResponse !== 'function') throw failure('External public response recording is unavailable.', 'PLANNING_EXTERNAL_WRITER_UNAVAILABLE', 503);
      return external.recordResponse(requestId, nodeId, value, { ...options, receipt: { jobId, connectionId: client.id, requestId: args.requestId, tool: 'blackice_planning_graph_write' } });
    } };
  });
  const definition = (name, description, scope, inputSchema, mutating) => ({ name, description, scope, requiredScopes: [scope], inputSchema, mutating, annotations: { readOnlyHint: !mutating, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
  return [
    {
      definition: definition('blackice_planning_graph_read', 'Read the same recursive Planning graph used by BLACKICE. list returns conversation/request catalog pages; templates lists required public response fields. get pages module metadata, or nodeId selects a module with its latest public response; offset, edgeOffset, sourceOffset, inputOffset and attemptOffset page modules, relationships, source metadata, captured input references and execution attempts independently. attempts reads bounded host attempt metadata; program reads the editable program XML in character windows. Live execution uses the same host projection as the workspace; an old running record without a live worker remains unknown. source reads exact recorded material. response_history pages immutable response metadata, or responseId reads one response with optional inputOffset. Results use durable jobs and explicit pagination. Reading never starts a model or changes completion.', 'read', readSchema, false),
      async execute(args, { signal } = {}) {
        check(signal); let value;
        if (args.action === 'templates') value = { version: PLANNING_BROWSER_VERSION, templates: PLANNING_MODULE_TEMPLATES };
        else if (args.action === 'list') {
          const catalog = getCatalog ? await getCatalog() : { ...(await store.list()), conversations: [], templates: PLANNING_MODULE_TEMPLATES };
          const query = (args.query || '').toLowerCase(), requests = (catalog.requests || []).filter(row => (!args.conversationId || row.conversationId === args.conversationId) && (!query || (row.title + '\n' + (row.objective || '')).toLowerCase().includes(query)));
          value = { ...catalog, requests: pagination(requests, args.offset || 0, args.limit || 40), conversations: pagination((catalog.conversations || []).map(row => { const { requests, ...metadata } = row; return metadata; }), args.offset || 0, args.limit || 40) };
        } else {
          const request = project(await store.get(args.graphRequestId)); check(signal);
          if (args.action === 'get') value = readPlanningGraphRequest(request, args);
          else if (args.action === 'program') { const xml = request.programXml || planningProgramXml(request), offset = args.offset || 0, limit = args.limit || 12000; value = { request: requestMetadata(request), xml: { text: xml.slice(offset, offset + limit), offset, totalCharacters: xml.length, nextOffset: offset + limit < xml.length ? offset + limit : null } }; }
          else if (args.action === 'attempts') { if (args.nodeId && !request.nodes.some(node => node.id === args.nodeId)) throw failure('Planning module not found.', 'PLANNING_NODE_NOT_FOUND', 404); value = { request: requestMetadata(request), attempts: pagination((request.attempts || []).filter(attempt => !args.nodeId || attempt.nodeId === args.nodeId).map(planningAttemptMetadata), args.offset || 0, args.limit || 40) }; }
          else if (args.action === 'source') {
            const source = request.sources.find(row => row.id === args.sourceId);
            if (!source) throw failure('Recorded Planning source not found.', 'PLANNING_SOURCE_NOT_FOUND', 404);
            value = { request: requestMetadata(request), source };
          } else if (args.action === 'response_history') {
            const rows = (request.responses || []).filter(row => !args.nodeId || row.nodeId === args.nodeId);
            if (args.responseId) { const selected = rows.find(row => row.id === args.responseId); if (!selected) throw failure('Recorded Planning response not found.', 'PLANNING_RESPONSE_NOT_FOUND', 404); value = { request: requestMetadata(request), response: responseDetail(selected, args) }; }
            else value = { request: requestMetadata(request), responses: pagination(rows.map(responseMetadata), args.offset || 0, args.limit || 40) };
          } else throw failure('Unknown Planning read action.');
        }
        check(signal); return result(value);
      }
    },
    {
      definition: definition('blackice_planning_graph_write', 'Develop BLACKICE Planning bidirectionally: create_request, add_module, update_module, update_program, assign, link, add_source, or record_response. Module edits include observable doneWhen and optional skipReason; clear either with an empty string. update_program uses the exact request revision and saved XML, preserving host-owned responses and execution history. Shared changes appear in the Planning workspace. Use expectedNodeRevision on the exact module, and expectedParentRevision for a new child; independent branches can progress concurrently. record_response is an externally authored public contribution stamped with this authenticated connector and durable job, never a Luna runtime response or verification. No graph edit starts a model, executes an action, or forges done status. No actor/provenance/approval override is accepted.', 'planning:write', writeSchema, true),
      async execute(args, context = {}) {
        const { signal } = context; check(signal);
        const { actor, clientRequestId, recordResponse } = await writer(args, context);
        if (!actor?.id || !clientRequestId || typeof recordResponse !== 'function') throw failure('The host writer context is unavailable.', 'DIRECT_PLANNING_CONFIGURATION', 503);
        const options = { actor, clientRequestId, ...pick(args, ['expectedNodeRevision', 'expectedParentRevision']) };
        let saved, focus = args.nodeId || args.from, extra = {};
        if (args.action === 'create_request') {
          saved = await store.create({ ...pick(args, ['conversationId', 'title', 'objective', 'cwd']), ...(args.graphRequestId ? { id: args.graphRequestId } : {}), conversationId: args.conversationId || 'planning_' + clientRequestId.slice(7, 39), clientRequestId }, { actor });
        } else if (args.action === 'add_module') {
          saved = await store.addNode(args.graphRequestId, { ...pick(args, ['parentId', 'kind', 'title', 'prompt', 'doneWhen', 'skipReason']), ...(args.nodeId ? { id: args.nodeId } : {}) }, options);
          focus = args.nodeId || saved.nodes.at(-1)?.id;
        } else if (args.action === 'update_module') saved = await store.updateNode(args.graphRequestId, args.nodeId, pick(args, ['title', 'prompt', 'kind', 'parentId', 'doneWhen', 'skipReason']), options);
        else if (args.action === 'update_program') saved = await store.updateProgram(args.graphRequestId, { xml: args.xml, expectedRevision: args.expectedRequestRevision }, options);
        else if (args.action === 'assign') saved = await store.assign(args.graphRequestId, args.nodeId, pick(args, ['ownerId', 'label', 'scope']), options);
        else if (args.action === 'link') saved = await store.link(args.graphRequestId, { ...pick(args, ['kind', 'from', 'to', 'sourceResponseId', 'sourceResponseRevision', 'sourceField', 'freshness']), ...(args.edgeId ? { id: args.edgeId } : {}) }, options);
        else if (args.action === 'add_source') { saved = await store.addSource(args.graphRequestId, pick(args, ['title', 'text', 'url']), options); extra.source = saved.sources.filter(source => source.id.startsWith('source:')).at(-1); }
        else if (args.action === 'record_response') {
          saved = await recordResponse(args.graphRequestId, args.nodeId, pick(args, ['values', 'requirements', 'grounding', 'openQuestions', 'challengeResponses', ...Object.keys(cycleResponseProperties)]), options);
        } else throw failure('Unknown Planning write action.');
        // Once committed, cancellation cannot erase the actual saved receipt.
        try { await onChange({ type: 'planning.browser.updated', data: { requestId: saved.id, conversationId: saved.conversationId, revision: saved.revision }, at: new Date().toISOString() }); }
        catch { /* A failed display notification must not relabel a committed graph edit. */ }
        return result({ operation: args.action, ...readPlanningGraphRequest(project(saved), { nodeId: focus }), ...extra, modelStarted: false, externalActionExecuted: false });
      }
    }
  ];
}
