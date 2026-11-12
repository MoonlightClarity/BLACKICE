import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';
// Retained historical parsers and accounting stay readable; current owners and explicitly requested modules do not enter the retired compulsory cycle.
import { fixtureUserAgency } from './fixture-user-agency.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime,validatePlanningModuleResponse,planningModuleOutputSchema} from '../lib/planning-browser-runtime.mjs';
import {TaskViability} from '../lib/task-viability.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {RESPONSE_CYCLE_STAGES,evaluateResponseCycleStage,parseResponseCycleResponse,responseCycleResponseSchema,responseCycleTemplate} from '../public/response-cycle-model.mjs';
import {tokenUsageMeasurement} from '../public/token-usage.mjs';
import {normalizeOutputSchema,validateResponseOnlyOptions} from '../lib/response-profile.mjs';
import {planningModuleTemplate,projectPlanningRequest} from '../public/planning-browser-model.mjs';

const planUsage=tokenUsageMeasurement({inputTokens:7,outputTokens:4,totalTokens:11});
const operationalUsage=tokenUsageMeasurement({inputTokens:13,outputTokens:4,totalTokens:17});
const failedUsage=tokenUsageMeasurement({inputTokens:5,outputTokens:2,totalTokens:7});
const workflow=(resultValue=17)=>({id:'stabilization-fixture',name:'Stabilization fixture',nodes:[
 {id:'input',type:'input'},{id:'agent',type:'agent',name:'Worker',model:'fixture::free',effort:'low',prompt:'Return the supplied result of '+resultValue+'.'},{id:'output',type:'output'}
],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'on'}});
function response(input,resultValue=17){
 const stage=RESPONSE_CYCLE_STAGES.find(stage=>stage.kind===input.module.kind);
 const sourceId=(stage.order>=4?input.sources.find(source=>source.id.startsWith('cycle:execution:')):null)?.id||input.sources.find(source=>source.id==='viability:task')?.id||input.sources[0].id;
 const body={userAgency:fixtureUserAgency(),values:Object.fromEntries(input.template.fields.map(field=>[field.id,field.label+': the supplied bounded evidence supports this assessment.'])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[]};
 if(stage.id==='feasibility')return {...body,requirements:[]};
 Object.assign(body,{checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[sourceId]:[],note:'The supplied evidence supports this assessment.'})),subproblems:[],childResults:(input.cycle?.children||[]).filter(child=>['completed','failed','cancelled'].includes(child.state)).map(child=>({key:child.key,sourceId:child.sourceId,summary:'The child returned a bounded analytical finding.',usedFor:'Carry its findings and pending workflow requirements into the parent plan.'}))});
 const criteria=stage.id==='plan'&&input.cycle?.requiredAcceptanceCriteria?.length?input.cycle.requiredAcceptanceCriteria:input.cycle?.acceptanceCriteria?.length?input.cycle.acceptanceCriteria:[{id:'answer',label:'Requested answer',description:'Report the supplied result of '+resultValue+'.',verification:'response'}];
 if(stage.id==='inference')body.inferences=[{id:'finding',claim:'The requested result is bounded by the supplied premises.',basis:'inferred',sourceIds:[sourceId],limitation:'No external facts are inferred.'}];
 if(stage.id==='plan')Object.assign(body,{acceptanceCriteria:criteria,steps:[{id:'answer-step',label:'Obtain and check the result',description:'Obtain the operational result and compare it with the requested value.',dependsOn:[],criterionIds:criteria.map(item=>item.id),sourceIds:[sourceId]}]});
 if(stage.id==='think')body.criterionResults=criteria.map(item=>({criterionId:item.id,assessment:'satisfied',sourceIds:[sourceId],receiptIds:[],rationale:'The recorded result is '+resultValue+'.'}));
 if(stage.id==='respond'){body.values.answer='The result is '+resultValue+'.';body.coverage=criteria.map(item=>({criterionId:item.id,disposition:'addressed',sourceIds:[sourceId],responseExcerpt:body.values.answer,limitation:''}));}
 return body;
}
test('final coverage accepts truthful paraphrase of a limitation but still requires an exact quoted answer excerpt', () => {
  const sources = [{ id: 'cycle:execution:synthetic:projection:1', kind: 'response', text: 'The receipt is unconfirmed.' }];
  const input = { module: { kind: 'respond' }, template: responseCycleTemplate('respond'), sources, cycle: {} };
  const body = response(input);
  body.values.answer = 'Status remains pending because the employer receipt is not independently confirmed.';
  body.coverage = [{ criterionId: 'answer', disposition: 'partial', sourceIds: [sources[0].id],
    responseExcerpt: 'receipt is not independently confirmed',
    limitation: 'The source system did not return a definitive employer acknowledgement, leaving acceptance unresolved.' }];
  const attempt = { node: { kind: 'respond' }, template: input.template, sources, challenges: [], workflowNodeIds: [], cycleContext: {} };
  assert.equal(validatePlanningModuleResponse(attempt, JSON.stringify(body)).values.answer, body.values.answer);
  body.coverage[0].responseExcerpt = 'the employer definitively accepted';
  assert.throws(() => validatePlanningModuleResponse(attempt, JSON.stringify(body)), error =>
    error.code === 'PLANNING_RESPONSE_FORMAT' && error.issues[0].path.endsWith('.responseExcerpt'));
});


async function fixture(t, { operation, provider } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blackice-stabilization-'));
  const calls = [], entries = [];
  const settings = { defaultModel: 'fixture::free', defaultEffort: 'low', runTimeoutMs: null, executionGuardrails: false };
  const runtime = {
    status: () => ({ connected: true, authenticated: true, defaultModel: settings.defaultModel, models: [{ id: 'fixture::free', supportsTools: true }] }),
    resolveModel: model => ({ available: true, providerId: 'fixture', model: model === 'default' ? settings.defaultModel.split('::')[1] : model.split('::')[1] || model }),
    runAgent: async options => {
      const review = fixtureOutcomeReview(options); if (review) return review;
      if (options.responseOnly) { calls.push(options); assert.ok(provider, 'No automatic planning provider belongs to a direct owner run.'); return provider(options); }
      entries.push(options);
      options.onEvent?.({ type: 'thread', threadId: 'provider_fixture_' + entries.length, model: options.model, providerId: 'fixture' });
      const output = operation ? await operation(options, { dir, operationalCalls: entries.length }) : 'Observed result: 17.';
      options.onEvent?.({ type: 'usage', usage: operationalUsage });
      return finishFixtureCandidate(options, { output, usage: operationalUsage, threadId: 'provider_fixture_' + entries.length });
    }
  };
  const tasks = await new TaskStateStore({ dataDir: dir }).init();
  const store = await new PlanningBrowserStore({ dataDir: dir }).init();
  const engine = await new HarnessEngine({ runtime, tasks, dataDir: dir, defaultCwd: dir }).init();
  engine.runtimeSettings = { get: () => settings };
  const archive = await new ConversationArchive({ dataDir: dir, engine }).init();
  const runner = new PlanningBrowserRuntime({ store, runtime, defaultCwd: dir, getSettings: () => settings });
  let sourceReads = 0;
  const taskViability = new TaskViability({ store, runner, engine, conversations: archive,
    identity: { read: async () => { sourceReads++; throw Error('Retired readiness must not read a source.'); } }, getSettings: () => settings });
  const service = new ResponseCycleService({ store, runner, taskViability, engine, conversations: archive, getSettings: () => settings });
  engine.responseCycle = service;
  t.after(async () => { await engine.close(); await archive.close(); await runner.close(); await service.close(); await taskViability.close(); await store.close(); await tasks.close(); await rm(dir, { recursive: true, force: true }); });
  const execute = async (overrides = {}) => {
    const accepted = engine.startRun({ workflow: workflow(), input: 'Report the supplied result of 17 and preserve any uncertainty.', requestId: 'stabilization-test', ...overrides });
    await engine.executions.get(accepted.id); await archive.chain; return engine.getRun(accepted.id);
  };
  return { dir, engine, archive, store, runner, service, taskViability, settings, calls, entries, tasks, execute,
    get operationalCalls() { return entries.length; }, get sourceReads() { return sourceReads; } };
}

test('direct execution preserves the actual answer and usage without retired preflight, handoff or operational replay', async t => {
  const f = await fixture(t, { operation: async () => 'Observed result: 17. The external receipt remains unknown.' });
  const run = await f.execute({ planningMode: 'forced' });
  assert.equal(run.status, 'completed'); assert.equal(run.settled, true);
  assert.equal(run.nodes.agent.output, 'Observed result: 17. The external receipt remains unknown.');
  assert.equal(run.output, '[Worker]\n' + run.nodes.agent.output);
  assert.equal(f.operationalCalls, 1); assert.deepEqual(f.calls, []); assert.equal(f.sourceReads, 0);
  assert.equal(run.responseCycle, undefined); assert.equal(run.planningUsage.samples, 0); assert.equal(run.planningUsage.totalTokens, null);
  assert.equal(run.usage.totalTokens, 17); assert.equal((await f.archive.get(run.id)).output, run.output);
  assert.equal((await f.archive.get(run.id)).usage.totalTokens, 17);
  assert.deepEqual((await f.store.list()).requests, []);
});

test('retired readiness and Plan-only admission reject before source reads, providers or durable runs', async t => {
  const f = await fixture(t);
  for (const operation of [() => f.service.forRun({}), () => f.taskViability.assess({}), () => f.taskViability.answer({}, {})])
    await assert.rejects(async () => operation(), { code: 'PLANNING_CYCLE_RETIRED', status: 410 });
  assert.throws(() => f.engine.startRun({ workflow: workflow(), input: 'Inspect only.', planningExecutionMode: 'plan_only' }), { code: 'PLANNING_EXECUTION_MODE_RETIRED' });
  assert.equal(f.engine.listRuns().length, 0); assert.equal(f.calls.length, 0); assert.equal(f.operationalCalls, 0); assert.equal(f.sourceReads, 0);
  assert.deepEqual((await f.store.list()).requests, []);
});

test('an operational provider failure and explicit retry preserve the prior artifact without repeating its effect', async t => {
  const f = await fixture(t, { operation: async (_options, { dir, operationalCalls }) => {
    const file = path.join(dir, 'retained-result.json');
    if (operationalCalls === 1) { await writeFile(file, '{"result":17}'); throw Object.assign(Error('Owner transport failed after the write.'), { code: 'FIXTURE_TRANSPORT' }); }
    assert.equal(await readFile(file, 'utf8'), '{"result":17}');
    return 'Recovered the existing result 17 without rewriting it.';
  } });
  const first = await f.execute();
  assert.equal(first.status, 'failed'); assert.equal(first.errorCode, 'FIXTURE_TRANSPORT');
  const before = await readFile(path.join(f.dir, 'retained-result.json'));
  const next = f.engine.retryRun(first.id);
  await f.engine.executions.get(next.id); await f.archive.chain;
  const run = f.engine.getRun(next.id);
  assert.equal(run.status, 'completed'); assert.equal(run.taskId, first.taskId);
  assert.deepEqual(await readFile(path.join(f.dir, 'retained-result.json')), before);
  assert.equal(f.operationalCalls, 2); assert.deepEqual(f.calls, []);
  assert.match((await f.archive.get(run.id)).output, /without rewriting/);
});

test('explicit continuation chooses the requested model while preserving the previous archived answer', async t => {
  const f = await fixture(t), first = await f.execute();
  const next = f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue with the chosen model.', model: 'fixture::chosen', requestId: 'model-choice' });
  await f.engine.executions.get(next.id); await f.archive.chain;
  const run = f.engine.getRun(next.id);
  assert.equal(run.status, 'completed'); assert.equal(run.taskId, first.taskId);
  assert.equal(f.entries[1].model, 'fixture::chosen');
  assert.equal(run.workflow.nodes.find(node => node.id === 'agent').model, 'fixture::chosen');
  assert.equal((await f.archive.get(first.id)).output, first.output);
  assert.deepEqual(f.calls, []);
});

test('a current owner can read, write and reread evidence without any compulsory analytical stages', async t => {
  const operations = [];
  const f = await fixture(t, { operation: async options => {
    const send = async args => { const receipt = await options.onToolCall({ name: 'relay_workspace', arguments: args });
      assert.equal(receipt.success, true, JSON.stringify(receipt));
      operations.push(args.action); return JSON.parse(receipt.contentItems.find(item => item.type === 'inputText').text); };
    const raw = await send({ action: 'read', path: 'input.csv' });
    const rows = raw.content.split(/\r?\n/).map(line => line.replace(/^\d+: /, '')).filter(Boolean).slice(1).map(line => {
      const [sku, opening, received, shipped] = line.split(','); return { sku, closing_units: Number(opening) + Number(received) - Number(shipped) };
    });
    const result = { rows, total_units: rows.reduce((sum, row) => sum + row.closing_units, 0) };
    await send({ action: 'write', path: 'closing-units.json', text: JSON.stringify(result) });
    const reread = await send({ action: 'read', path: 'closing-units.json' });
    assert.deepEqual(JSON.parse(reread.content.replace(/^\d+: /gm, '')), result);
    return JSON.stringify(result);
  } });
  await writeFile(path.join(f.dir, 'input.csv'), 'sku,opening_units,received_units,shipped_units\nD,45,12,8\nE,20,3,11\nF,5,14,4\n');
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.error); assert.deepEqual(operations, ['read', 'write', 'read']);
  assert.equal(JSON.parse(run.nodes.agent.output).total_units, 76); assert.equal(f.calls.length, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'closing-units.json'), 'utf8')), JSON.parse(run.nodes.agent.output));
});

test('cancelled direct ownership settles and does not dispatch a replacement planner', { timeout: 10000 }, async t => {
  const entered = usageGate();
  const f = await fixture(t, { operation: async options => {
    entered.release();
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(Error('Stopped'), { name: 'AbortError' })), { once: true }));
  } });
  const accepted = f.engine.startRun({ workflow: workflow(), input: 'Hold this direct operation.' });
  await entered.promise;
  f.engine.cancelRun(accepted.id); await f.engine.executions.get(accepted.id); await f.archive.chain;
  const run = f.engine.getRun(accepted.id);
  assert.equal(run.status, 'cancelled'); assert.equal(run.settled, true);
  assert.equal(f.operationalCalls, 1); assert.deepEqual(f.calls, []);
  assert.equal((await f.archive.get(run.id)).status, 'cancelled');
});

test('explicit current module repair remains response-only, bounded, model-pinned and outside the owner run', async t => {
  let attempts = 0;
  const f = await fixture(t, { provider: async options => {
    attempts++;
    validateResponseOnlyOptions(options); normalizeOutputSchema(options.outputSchema);
    assert.equal(options.model, 'fixture::free'); assert.deepEqual(options.dynamicTools, []);
    if (attempts === 1) return { output: '{"inventedCompletion":true}', usage: failedUsage };
    const template = planningModuleTemplate('frame');
    return { output: JSON.stringify({ values: Object.fromEntries(template.fields.map(field => [field.id, field.label + ': the supplied bounded evidence remains uncertain.'])),
      grounding: template.fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId: 'request:optional' })), openQuestions: [], challengeResponses: [] }), usage: planUsage };
  } });
  await f.store.create({ id: 'optional', conversationId: 'stabilization', title: 'Optional analysis', objective: 'Inspect the supplied uncertainty.' });
  await f.store.addNode('optional', { id: 'frame', kind: 'frame', title: 'Frame' });
  await f.runner.start({ requestId: 'optional', nodeId: 'frame', expectedNodeRevision: 1 });
  await Promise.all(f.runner.activePromises());
  const document = await f.store.get('optional');
  assert.equal(attempts, 2); assert.equal(document.attempts[0].status, 'failed'); assert.equal(document.attempts[1].status, 'completed');
  assert.equal(document.attempts[1].repairOf, document.attempts[0].id);
  assert.equal(document.responses.length, 1); assert.equal(f.operationalCalls, 0); assert.equal(f.engine.listRuns().length, 0);
});


test('explicit module format repair stops after one retry and preserves both malformed public attempts', async t => {
  let calls = 0;
  const f = await fixture(t, { provider: async () => { calls++; return { output: '{"inventedCompletion":true}', usage: failedUsage }; } });
  await f.store.create({ id: 'invalid-module', conversationId: 'stabilization', title: 'Optional invalid analysis', objective: 'Preserve the actual failed output.' });
  await f.store.addNode('invalid-module', { id: 'frame', kind: 'frame', title: 'Frame' });
  await f.runner.start({ requestId: 'invalid-module', nodeId: 'frame', expectedNodeRevision: 1 });
  await Promise.all(f.runner.activePromises());
  const document = await f.store.get('invalid-module');
  assert.equal(calls, 2); assert.equal(document.responses.length, 0); assert.equal(document.attempts.length, 2);
  assert.ok(document.attempts.every(item => item.status === 'failed' && item.partialOutput === '{"inventedCompletion":true}'));
  assert.equal(document.attempts[1].repairOf, document.attempts[0].id);
  assert.equal(f.operationalCalls, 0);
});

test('cancelling one explicit module preserves completed sibling output and unrelated pending work', { timeout: 10000 }, async t => {
  const held = usageGate(), entered = usageGate();
  t.after(() => held.release());
  const f = await fixture(t, { provider: async options => {
    const input = JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n') + 2));
    if (input.module.title === 'held') { entered.release(); await held.promise; }
    const fields = planningModuleTemplate('frame').fields;
    return { output: JSON.stringify({ values: Object.fromEntries(fields.map(field => [field.id, field.label + ': saved independent observation.'])),
      grounding: fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId: 'request:siblings' })), openQuestions: [], challengeResponses: [] }) };
  } });
  await f.store.create({ id: 'siblings', conversationId: 'stabilization', title: 'Independent modules', objective: 'Preserve independent findings.' });
  for (const id of ['completed', 'held', 'unrelated']) await f.store.addNode('siblings', { id, kind: 'frame', title: id });
  await f.runner.start({ requestId: 'siblings', nodeId: 'completed', expectedNodeRevision: 1 });
  await Promise.all(f.runner.activePromises());
  const before = await f.store.get('siblings'), saved = before.nodes.find(item => item.id === 'completed').response;
  const active = await f.runner.start({ requestId: 'siblings', nodeId: 'held', expectedNodeRevision: 1 });
  await entered.promise;
  const cancellation = f.runner.cancel(active.attempt.id);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.runner.start({ requestId: 'siblings', nodeId: 'held', expectedNodeRevision: 1 }), { code: 'PLANNING_NODE_BUSY' });
  held.release(); await cancellation;
  const after = await f.store.get('siblings');
  assert.deepEqual(after.nodes.find(item => item.id === 'completed').response, saved);
  assert.equal(after.attempts.find(item => item.id === active.attempt.id).status, 'cancelled');
  assert.equal(after.nodes.find(item => item.id === 'held').response, null);
  assert.equal(after.attempts.some(item => item.nodeId === 'unrelated'), false);
  assert.equal(f.operationalCalls, 0);
});

test('archived nested cancellation projects without rewriting completed or unrelated records or restarting providers', async t => {
  const f = await fixture(t);
  let document = await f.store.create({ id: 'archived-nested', conversationId: 'stabilization', title: 'Historical graph', objective: 'Read retained analytical findings.' });
  const writer = f.store.runtimeWriter();
  const ids = id => Object.fromEntries(RESPONSE_CYCLE_STAGES.map(stage => [stage.id, id + '-' + stage.id]));
  for (const [id, parentCycleId, state] of [['root', null, 'running'], ['completed', 'root', 'completed'], ['pending', 'root', 'running'], ['unrelated', null, 'pending']]) {
    document = await writer.configureResponseCycle(document.id, { createCycle: { id, title: id, objective: id, stageNodeIds: ids(id),
      parentCycleId, parentStageId: parentCycleId ? parentCycleId + '-inference' : null, depth: parentCycleId ? 1 : 0,
      pipelineVersion: 1, planningExecutionMode: 'automatic', state, execution: { required: false, state: 'not_required' }, acceptanceCriteria: [] },
      ...(id === 'root' ? { rootPatch: { rootCycleId: 'root' } } : {}) });
  }
  const bytes = await readFile(f.store.file(document.id));
  for (const id of ['root', 'completed', 'pending', 'unrelated']) await assert.rejects(async () => f.service.runCycle(document.id, id, {}), { code: 'PLANNING_CYCLE_RETIRED' });
  assert.deepEqual(await readFile(f.store.file(document.id)), bytes); assert.equal(f.calls.length, 0);
  // Historical ancestor cancellation may project a cancelled running label,
  // but never rewrites the saved document or restarts a descendant.
  const raw = JSON.parse(bytes);
  const completedBefore = projectPlanningRequest(raw).cycles.find(item => item.id === 'completed');
  raw.responseCycle.cycles.find(item => item.id === 'root').state = 'cancelled';
  const before = structuredClone(raw), projected = projectPlanningRequest(raw);
  assert.deepEqual(projected.cycles.find(item => item.id === 'completed'), completedBefore);
  assert.equal(raw.responseCycle.cycles.find(item => item.id === 'completed').state, 'completed');
  assert.equal(projected.cycles.find(item => item.id === 'unrelated').state, 'pending');
  assert.equal(projected.cycles.find(item => item.id === 'pending').state, 'cancelled');
  assert.deepEqual(raw, before);
});
test('model evidence ignores symbolic aliases and unknown history cannot silently use the current default',async t=>{
 const f=await fixture(t),run=await f.execute(),saved=f.engine.runs.get(run.id),node=saved.workflow.nodes.find(node=>node.id==='agent');
 node.model='default';saved.nodes.agent.resolvedModel='default';
 const observed={type:'agent.event',nodeId:'agent',data:{type:'thread',model:'fixture::original'}};
 saved.events=[observed,{type:'agent.event',nodeId:'agent',data:{type:'thread',model:'default'}}];
 assert.equal(f.engine.recordedModel(saved,node),'fixture::original');
 saved.nodes.agent.resolvedModel='fixture::resolved';assert.equal(f.engine.recordedModel(saved,node),'fixture::resolved');
 saved.nodes.agent.resolvedModel='default';saved.events=[];
 f.settings.defaultModel='fixture::changed';
 assert.throws(()=>f.engine.continueRun(run.id,{nodeId:'agent',message:'Continue.',requestId:'unknown-history'}),{code:'CHAT_MODEL_HISTORY_UNKNOWN'});
 saved.status='failed';assert.throws(()=>f.engine.retryRun(run.id),{code:'CHAT_MODEL_HISTORY_UNKNOWN'});
 const selected=f.engine.continueRun(run.id,{nodeId:'agent',message:'Continue with the chosen free model.',model:'fixture::chosen',planningMode:'off',requestId:'explicit-history-choice'});
 await f.engine.executions.get(selected.id);
 assert.equal(f.engine.getRun(selected.id).workflow.nodes.find(node=>node.id==='agent').model,'fixture::chosen');
 assert.equal(saved.nodes.agent.resolvedModel,'default','historical evidence remains unchanged');
});


// Replay a sanitized minimal body from the free-model inventory Feasibility response.
// It retains the unknown facts and source-coverage omission pattern, with fixture IDs and paths.
const recordedFeasibility = JSON.parse(await readFile(new URL('./fixtures/feasibility-source-coverage-20261031.json', import.meta.url), 'utf8'));
const recordedRequestId = recordedFeasibility.grounding.find(item => item.field === 'objective').sourceId;
const recordedContextId = recordedFeasibility.requirements[0].checkedSourceIds.find(id => id.startsWith('cycle:context:'));
const recordedDirectory = 'C:\\fixture\\inventory';
function feasibilitySources() {
  return [
    { id: recordedRequestId, kind: 'request_objective', text: recordedFeasibility.values.objective },
    { id: 'viability:task', kind: 'user_input', text: recordedFeasibility.values.objective },
    { id: 'viability:workflow', kind: 'source', text: JSON.stringify(workflow(76)) },
    { id: 'viability:continuity', kind: 'source', text: 'A different earlier fixture path returned total 190. Its rows do not establish the current CSV contents.' },
    { id: 'viability:profile', kind: 'source', text: 'No personal facts are required for this inventory fixture.' },
    { id: recordedContextId, kind: 'source', text: 'An operational worker can use local file tools after preparation. No current file observation is recorded.' }
  ];
}
test('recorded source-coverage omissions permit analysis without inventing checked sources or resolved facts', () => {
  const sources = feasibilitySources(), saved = { ...structuredClone(recordedFeasibility), sources };
  const before = structuredClone(saved);
  const result = evaluateResponseCycleStage('feasibility', saved, { sources, workflowNodeIds: ['agent'],pipelineVersion:1 });
  assert.equal(result.analysisReady, true);
  assert.equal(result.dispatchReady, false);
  assert.equal(result.state, 'needs_evidence');
  assert.equal(result.viability.state, 'needs_evidence');
  assert.equal(result.viability.issues.length, 2);
  assert.equal(result.viability.sourceCoverage.length, 2);
  assert.equal(result.unresolvedChecks.length, 2);
  assert.deepEqual(result.viability.sourceCoverage[0].missingSourceIds, ['viability:profile']);
  assert.equal(saved.requirements.every(item => item.resolution === 'unknown' && item.value === 'unobserved'), true);
  assert.deepEqual(saved, before, 'evaluation must not fill checkedSourceIds or rewrite the response');
  assert.doesNotThrow(() => validatePlanningModuleResponse({ node: { kind: 'viability' }, sources, workflowNodeIds: ['agent'],pipelineVersion:1 }, JSON.stringify(recordedFeasibility)),
    'a valid unresolved assessment is not a malformed-output repair request');
});

test('preparatory source-coverage handling still rejects unavailable, stale, invalid and unsupported evidence', () => {
  const sources = feasibilitySources();
  const check = (mutate, context = {}) => {
    const saved = { ...structuredClone(recordedFeasibility), sources: structuredClone(sources) };
    mutate(saved);
    const result = evaluateResponseCycleStage('feasibility', saved, { sources, workflowNodeIds: ['agent'], ...context });
    assert.equal(result.analysisReady, false);
    assert.equal(result.dispatchReady, false);
    return result;
  };
  check(saved => saved.requirements[0].checkedSourceIds.push('unavailable-source'));
  check(saved => saved.requirements[0].dependentNodeIds.push('outside-workflow'));
  check(saved => { saved.requirements[0].resolution = 'inference'; saved.requirements[0].value = 'An invented current total'; });
  check(saved => { saved.grounding = saved.grounding.filter(item => item.field !== 'objective'); });
  assert.equal(check(saved => { saved.sources[4].text = 'A different historical profile snapshot'; }).state, 'stale');
  assert.equal(check(() => {}, { sources: sources.filter(item => item.id !== 'viability:profile') }).state, 'stale');
  check(() => {}, { recoveryIssue: { message: 'The host could not read an attached source.' } });
});

const workflowDiscovery = JSON.parse(await readFile(new URL('./fixtures/planning-workflow-discovery-20261031.json', import.meta.url), 'utf8'));
function workflowRequest(input, target = 'workflow') {
  const work = structuredClone(workflowDiscovery.request);
  const current = input.sources.find(item => item.id.startsWith('request:')).id;
  const feasibility = input.cycle?.prerequisites?.find(item => item.stageId === 'feasibility')?.sourceId || current;
  const context = input.sources.find(item => item.id.startsWith('cycle:context:')).id;
  work.sourceIds = [...new Set(work.sourceIds.map(id => id.startsWith('request:') ? current : id.startsWith('response:') ? feasibility : context))];
  if (target !== undefined) work.executionTarget = target;
  return work;
}
test('new provider routing is explicit and bounded while legacy bodies and public schemas stay unchanged', () => {
  const sources = [...feasibilitySources(), { id: 'response:feasibility-fixture', kind: 'response', text: 'The recorded feasibility finding is unresolved.' }], input = { module: { kind: 'inference' }, template: responseCycleTemplate('inference'), sources, cycle: {} };
  const body = response(input); body.subproblems = [workflowRequest(input)];
  delete body.subproblems[0].executionTarget;
  const original = structuredClone(body.subproblems[0]);
  const before = JSON.stringify(responseCycleResponseSchema('inference'));
  const parsed = parseResponseCycleResponse(body, 'inference');
  assert.deepEqual(parsed.subproblems[0], original, 'historical absent target must remain absent');
  const attempt = { node: { kind: 'inference' }, template: input.template, sources, workflowNodeIds: ['agent'], cycleContext: {} };
  const schema = planningModuleOutputSchema(attempt);
  assert.deepEqual(schema.properties.subproblems.items.properties.executionTarget.enum, ['analysis', 'workflow']);
  assert.ok(schema.properties.subproblems.items.required.includes('executionTarget'));
  assert.equal(JSON.stringify(responseCycleResponseSchema('inference')), before, 'attempt schema must not mutate frozen public catalogs');
  assert.throws(() => validatePlanningModuleResponse(attempt, JSON.stringify(body)), error => error.code === 'PLANNING_RESPONSE_FORMAT' && error.issues[0].path.endsWith('.executionTarget'));
  body.subproblems[0].executionTarget = 'workflow';
  assert.doesNotThrow(() => validatePlanningModuleResponse(attempt, JSON.stringify(body)));
  const legacy = { ...original };
  const bound = { cycles: [{ parentStageId: 'inference', key: legacy.key, request: legacy }] };
  const method = ResponseCycleService.prototype.assertSubproblemBindings;
  assert.doesNotThrow(() => method.call({}, bound, { id: 'inference', response: { subproblems: [{ ...legacy, executionTarget: 'analysis' }] } }));
  assert.throws(() => method.call({}, bound, { id: 'inference', response: body }), { code: 'RESPONSE_CYCLE_RECURSION' });
  attempt.cycleContext.children = [{ key: legacy.key, request: legacy }];
  assert.throws(() => validatePlanningModuleResponse(attempt, JSON.stringify(body)), { code: 'PLANNING_RESPONSE_FORMAT' });
});

const usageGate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return{promise,release};};
async function waitForUsage(check){
  const deadline=Date.now()+7000;
  while(Date.now()<deadline){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail('The held usage fixture did not reach its expected state.');
}
test('planning usage follows the bound owner and excludes separate linked descendants and old attempts',async()=>{
  const run={id:'owner-run',planningAttempts:[]},service={runBindings:new Map([['owner-run',{requestId:'usage-request',cycleId:'root',excludedAttemptIds:['old']} ]])};
  const cycles=[
    {id:'root',linkedRunId:'owner-run',stageNodeIds:{inference:'root-node'}},
    {id:'owned',parentCycleId:'root',stageNodeIds:{inference:'owned-node'}},
    {id:'foreign',parentCycleId:'root',linkedRunId:'other-run',stageNodeIds:{inference:'foreign-node'}},
    {id:'foreign-child',parentCycleId:'foreign',stageNodeIds:{inference:'foreign-child-node'}}
  ];
  const measured=(id,nodeId,total,status='completed')=>({id,nodeId,status,metadata:{usage:tokenUsageMeasurement({totalTokens:total})}});
  const request={id:'usage-request',cycles,nodes:cycles.map(cycle=>({id:cycle.stageNodeIds.inference,cycleId:cycle.id})),attempts:[
    measured('old','root-node',100),measured('root-current','root-node',11),measured('owned-current','owned-node',7),
    measured('owned-failed','owned-node',3,'failed'),measured('foreign-current','foreign-node',200),measured('foreign-child-current','foreign-child-node',300),
    measured('still-running','owned-node',50,'running')
  ]};
  await ResponseCycleService.prototype.captureRunUsage.call(service,run,{request});
  assert.deepEqual(run.planningAttempts.map(item=>item.attemptId),['root-current','owned-current','owned-failed']);assert.equal(run.planningUsage.totalTokens,21);
  await ResponseCycleService.prototype.captureRunUsage.call(service,run,{request});assert.equal(run.planningUsage.totalTokens,21);assert.equal(run.planningAttempts.length,3);
});
test('live usage refresh rechecks bindings after reads and isolates accounting failures from run failure',async()=>{
  const runner=new EventEmitter();runner.start=()=>{throw Error('No provider call belongs to accounting.');};
  let gate=usageGate(),readStarted=false,notifyCalls=0;
  const run={id:'live-run',settled:false,error:'Original stage failure',status:'running',planningAttempts:[]};
  const engine={runs:new Map([[run.id,run]]),snapshot:structuredClone,notify:()=>{notifyCalls++;}};
  const store={runtimeWriter:()=>({}),get:async()=>{readStarted=true;return gate.promise;}};
  const service=new ResponseCycleService({store,runner,engine});
  const request={id:'request-one',cycles:[{id:'cycle-one',linkedRunId:run.id,stageNodeIds:{inference:'stage-one'}}],nodes:[{id:'stage-one',cycleId:'cycle-one'}],attempts:[{id:'attempt-one',nodeId:'stage-one',status:'completed',metadata:{usage:planUsage}}]};
  service.runBindings.set(run.id,{requestId:request.id,cycleId:'cycle-one',excludedAttemptIds:[]});
  try{
    runner.emit('updated',{data:{requestId:request.id,workerStatus:'completed'}});await waitForUsage(()=>readStarted);
    service.runBindings.set(run.id,{requestId:'request-two',cycleId:'cycle-two',excludedAttemptIds:[]});gate.release(request);await Promise.allSettled([...service.usageUpdates.values()]);
    assert.deepEqual(run.planningAttempts,[]);assert.equal(notifyCalls,0,'changed bindings never inherit the old request total');
    gate=usageGate();readStarted=false;service.runBindings.set(run.id,{requestId:request.id,cycleId:'cycle-one',excludedAttemptIds:[]});
    runner.emit('updated',{data:{requestId:request.id,workerStatus:'completed'}});await waitForUsage(()=>readStarted);run.settled=true;gate.release(request);await Promise.allSettled([...service.usageUpdates.values()]);
    assert.deepEqual(run.planningAttempts,[]);assert.equal(notifyCalls,0,'a run settling during a read is not republished');
    run.settled=false;store.get=async()=>{throw Object.assign(Error('Fixture accounting read failed'),{code:'FIXTURE_USAGE_READ'});};
    runner.emit('updated',{data:{requestId:request.id,workerStatus:'failed'}});await Promise.allSettled([...service.usageUpdates.values()]);
    assert.equal(run.error,'Original stage failure');assert.equal(run.planningUsageError.code,'FIXTURE_USAGE_READ');
    store.get=async()=>request;runner.emit('updated',{data:{requestId:request.id,workerStatus:'completed'}});await Promise.allSettled([...service.usageUpdates.values()]);
    assert.equal(run.planningUsage.totalTokens,11);assert.equal(run.planningUsageError,undefined);assert.equal(notifyCalls,1);
  }finally{gate.release(request);await service.close();}
  assert.equal(runner.listenerCount('updated'),0);assert.equal(service.usageUpdates.size,0);
});
