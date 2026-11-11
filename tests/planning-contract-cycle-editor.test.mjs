import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';
import { fixtureUserAgency } from './fixture-user-agency.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';
import { createPlanningBrowser } from '../public/next/workspaces/planning-browser.mjs';
import { planPayload } from '../public/next/workspaces/response-cycle-ui.mjs';
import { planningProgramXml } from '../public/planning-program-xml.mjs';
import { planningModuleTemplate, planningNodeSources, parseModuleResponse } from '../public/planning-browser-model.mjs';
import { RESPONSE_CYCLE_STAGES, responseCycleStage } from '../public/response-cycle-model.mjs';
import { contractPlanProjection } from '../public/planning-contract-model.mjs';

const cycleId = 'editor-cycle', conversationId = 'editor-conversation';
const contract = () => ({ contractVersion: 2, goal: 'Review the supplied source and obtain one observed confirmation.',
  criteria: [{ id: 'read', kind: 'observation', label: 'Inspect the source', description: 'Read the supplied source.', resourceKey: 'workspace:fixture' },
    { id: 'confirmed', kind: 'external-confirmation', label: 'Observed confirmation', description: 'Obtain an actual confirmation.', resourceKey: 'origin:https://example.invalid', targetCount: 1,
      receiptBinding: { version: 1, format: 'json', resourceKey: 'origin:https://example.invalid', record: '$.records[*]', status: '$.status', confirmedValues: ['confirmed'], outcomeId: '$.id', history: false } }],
  workItems: [{ id: 'inspect', title: 'Inspect source', objective: 'Read the supplied source.', owner: 'coordinator', resourceKeys: ['workspace:fixture'], effects: ['observe'], dependsOn: [], criterionIds: ['read'] },
    { id: 'confirm', title: 'Obtain confirmation', objective: 'Submit the bounded request and inspect its confirmation.', owner: 'coordinator', resourceKeys: ['origin:https://example.invalid'], effects: ['observe', 'interact', 'commit'], dependsOn: ['inspect'], criterionIds: ['confirmed'] }],
  instructions: [{ id: 'retain', text: 'Retain the observed confirmation.', handling: 'preserve' }, { id: 'audit', text: 'Record any optional formatting difference.', handling: 'audit' }] });
class Runtime extends EventEmitter {
  calls = 0;
  status() { return { connected: true, authenticated: true, ready: true, defaultModel: 'editor-fixture', models: [{ model: 'editor-fixture' }] }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { this.calls++; throw Error('Reading or saving a Plan must not start model work.'); }
}
class Desktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }
function request(url, route, { method = 'GET', headers = {}, body } = {}) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: url.port, path: route, method, agent: false,
      headers: { Host: url.host, ...headers, ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }) } }, res => {
      const chunks = []; res.on('data', value => chunks.push(value)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, value, text }); });
    });
    req.on('error', reject); req.setTimeout(7000, () => req.destroy(Error('Plan editor HTTP fixture timed out.'))); req.end(encoded);
  });
}
const planNode = document => document.nodes.find(node => node.id === document.cycles[0].stageNodeIds.plan);
const controls = document => ({ expectedRequestRevision: document.revision, expectedCycleRevision: document.nodes.find(node => node.id === cycleId).revision,
  expectedPlanRevision: planNode(document).revision, expectedPlanResponseId: planNode(document).response.id });
async function until(check, message) {
  for (let attempt = 0; attempt < 300; attempt++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(typeof message === 'function' ? message() : message);
}
async function fixture(t, { canonical = true, cycleState = 'paused_after_plan', accuracy } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'canonical-cycle-editor-')), runtime = new Runtime();
  const transport = createRemoteTransportFixture(), remoteAccess = new RemoteAccessManager({ dataDir: directory, transport: transport.transport, defaultHttpsPort: 8443 });
  let app, browser;
  t.after(async () => { browser?.destroy(); try { await app?.close(); assert.equal(runtime.calls, 0); } finally { await rm(directory, { recursive: true, force: true }); } });
  const dom = planningDOM(t);
  const prototype = Object.getPrototypeOf(dom.mount), type = Object.getOwnPropertyDescriptor(prototype, 'type');
  Object.defineProperty(prototype, 'type', { get: type.get, set(value) { this.setAttribute('type', value); } });
  prototype.replaceChildren = function (...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.rawText = ''; this.markup = ''; this.append(...children); };
  app = await createHarnessServer({ port: 0, dataDir: directory, defaultCwd: directory, runtime, desktop: new Desktop(), remoteAccess, autoAttachDesktop: false });
  await app.learning.updateSettings({ mode: 'manual' });
  let document = await app.planningBrowser.create({ conversationId, title: 'Review a saved Plan', objective: 'Review the supplied source and obtain one observed confirmation.', cwd: directory });
  const stages = Object.fromEntries(RESPONSE_CYCLE_STAGES.map(stage => [stage.id, cycleId + '-' + stage.id]));
  const writer = app.planningBrowser.runtimeWriter();
  document = await writer.configureResponseCycle(document.id, { createCycle: { id: cycleId, title: 'Review a saved Plan', objective: document.objective, stageNodeIds: stages,
    parentCycleId: null, parentStageId: null, depth: 0, pipelineVersion: 2, planningExecutionMode: 'plan_only', state: 'pending', acceptanceCriteria: [], sourceIds: null, execution: { required: false, state: 'not_required' } },
    rootPatch: { rootCycleId: cycleId }, ...(canonical ? { sources: [{ id: 'cycle:execution-contract:' + cycleId, kind: 'source', label: 'Canonical execution contract', text: JSON.stringify({ taskSchemaVersion: 14, contractVersion: 2 }) }] } : {}) });
  const stage = responseCycleStage('plan', { pipelineVersion: 2 }), fields = planningModuleTemplate('plan', { pipelineVersion: 2 }).fields, sourceId = 'request:' + document.id;
  const authored = contract(); if (accuracy !== undefined) authored.criteria[1].accuracy = structuredClone(accuracy);
  const body = { userAgency: fixtureUserAgency(), values: Object.fromEntries(fields.map(field => [field.id, field.label + ': use the supplied source and preserve the requested confirmation.'])),
    grounding: fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId })), openQuestions: [], challengeResponses: [], subproblems: [], childResults: [],
    checks: stage.checks.map(check => ({ id: check.id, assessment: check.when === 'effects' ? 'not_applicable' : 'supported', sourceIds: check.grounding === 'required' && check.when !== 'effects' ? [sourceId] : [], note: 'The bounded proposed work preserves the requested outcome and its stated evidence requirements.' })),
    ...(canonical ? { contract: authored } : contractPlanProjection(authored, [sourceId])) };
  const importResponse = async (nodeId, value) => {
    const raw = JSON.parse(await readFile(app.planningBrowser.file(document.id), 'utf8'));
    const node = raw.nodes.find(item => item.id === nodeId), sources = planningNodeSources(raw, nodeId);
    const parsed = parseModuleResponse(value, node.kind, { sources, pipelineVersion: 2 });
    node.revision++;
    raw.responses.push(app.planningBrowser._response(raw,node,parsed,{kind:'human',author:'historical-fixture',at:new Date().toISOString(),contentHash:'0'.repeat(64)},[],sources));
    raw.programXml=planningProgramXml(raw);app.planningBrowser._validate(raw);
    await writeFile(app.planningBrowser.file(document.id),JSON.stringify(raw));
    return app.planningBrowser.get(document.id);
  };
  for (const kind of ['inference', 'viability']) {
    const earlyStage = responseCycleStage(kind, { pipelineVersion: 2 }), earlyFields = planningModuleTemplate(kind, { pipelineVersion: 2 }).fields;
    const early = { userAgency: fixtureUserAgency(), values: Object.fromEntries(earlyFields.map(field => [field.id, field.label + ': the supplied source establishes a bounded request with an observed confirmation required.'])),
      grounding: earlyFields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId })), openQuestions: [], challengeResponses: [] };
    if (kind === 'viability') early.requirements = [];
    else Object.assign(early, { checks: earlyStage.checks.map(check => ({ id: check.id, assessment: check.when === 'effects' ? 'not_applicable' : 'supported', sourceIds: check.grounding === 'required' && check.when !== 'effects' ? [sourceId] : [], note: 'The supplied request supports the stated interpretation and bounded route.' })), subproblems: [], childResults: [],
      inferences: [{ id: 'requested-result', claim: 'The request requires a bounded source review and an observed confirmation.', basis: 'inferred', sourceIds: [sourceId], limitation: 'Operational observations have not yet been made.' }] });
    document = await importResponse(stages[earlyStage.id], early);
  }
  document = await importResponse(stages.plan, body);
  const accepted = planNode(document);
  document = await writer.configureResponseCycle(document.id, { cyclePatch: { id: cycleId, state: cycleState, planRef: { requestId: document.id, cycleId, nodeId: accepted.id, nodeRevision: accepted.revision, responseId: accepted.response.id } } });
  assert.equal(document.cycles[0].state, cycleState, JSON.stringify(document.cycles[0]));
  const initial = structuredClone(document), url = new URL(await app.listen()), page = await request(url, '/'), cookie = page.headers['set-cookie'][0].split(';')[0];
  const local = (route, options = {}) => request(url, route, { ...options, headers: { Cookie: cookie, ...(options.headers || {}) } });
  const calls = []; let afterPlanResponse = null;
  const api = async (route, methodOrOptions = 'GET', payload) => {
    const method = typeof methodOrOptions === 'string' ? methodOrOptions : 'GET'; calls.push({ route, method, body: structuredClone(payload) });
    const result = await local(route, { method, body: payload });
    if (result.status >= 400) throw Object.assign(Error(result.value?.error || result.text), { code: result.value?.code, status: result.status });
    if (method === 'POST' && route.endsWith('/plan')) await afterPlanResponse?.(result.value);
    return result.value;
  };
  browser = createPlanningBrowser({ mount: dom.mount, api, events: { subscribe() { return () => {}; } }, getStatus: () => ({ ...runtime.status(), cwd: directory }) });
  browser.openRequestId(document.id, { nodeId: stages.plan }); browser.enter();
  await until(() => dom.$('[data-selected-node-id="'+stages.plan+'"]'), () => 'Saved Plan archive did not render: ' + dom.mount.textContent.slice(-1500));
  const route = '/api/planning-browser/requests/' + document.id + '/cycles/' + cycleId + '/plan';
  const read = () => app.planningBrowser.get(document.id);
  const refresh = async () => { await dom.click('[data-action="refresh"]'); await until(() => !dom.$('[data-action="refresh"]').disabled, 'Refresh did not settle'); };
  return { app, runtime, dom, browser, initial, calls, local, route, read, refresh };
}

for(const canonical of [true,false])for(const cycleState of ['paused_after_plan','planned','failed','cancelled'])test(
 (canonical?'canonical':'legacy')+' archived Plan is inspectable and immutable in the real UI and HTTP routes when '+cycleState,async t=>{
 const f=await fixture(t,{canonical,cycleState}),before=await readFile(f.app.planningBrowser.file(f.initial.id),'utf8');
 const details=f.dom.$('.pb-cycle-plan-details');assert.ok(details);details.open=true;
 assert.match(details.textContent,/Inspect source|Inspect the source/);
 assert.match(details.textContent,/Obtain confirmation|Observed confirmation/);
 if(canonical){
  assert.match(details.textContent,/Recorded owner: coordinator/);
  assert.match(details.textContent,/observe, interact, commit/);
  assert.match(details.textContent,/Retain the observed confirmation/);
  assert.deepEqual(JSON.parse(details.querySelector('pre').textContent),planNode(f.initial).response.contract);
 }else{
  const shown=JSON.parse(details.querySelector('pre').textContent);
  assert.deepEqual(shown.acceptanceCriteria,planNode(f.initial).response.acceptanceCriteria);
  assert.deepEqual(shown.steps,planNode(f.initial).response.steps);
 }
 assert.equal(details.querySelectorAll('input,textarea,select,button').length,0);
 assert.equal(f.dom.$('[data-cycle-plan-form]'),null);assert.equal(f.dom.$('[data-cycle-continue]'),null);
 assert.doesNotMatch(f.dom.mount.textContent,/Use Edit the saved Plan/);
 for(const action of ['plan','continue','run']){
  const denied=await f.local('/api/planning-browser/requests/'+f.initial.id+'/cycles/'+cycleId+'/'+action,{method:'POST',body:{...controls(f.initial),plan:planPayload(planNode(f.initial).response),clientRequestId:'retired-'+action}});
  assert.equal(denied.status,410,denied.text);assert.equal(denied.value.code,'PLANNING_CYCLE_RETIRED');
 }
 const rawRoute='/api/planning-browser/requests/'+f.initial.id+'/nodes/'+planNode(f.initial).id+'/responses';
 const denied=await f.local(rawRoute,{method:'POST',body:{...planPayload(planNode(f.initial).response),expectedNodeRevision:planNode(f.initial).revision}});
 assert.equal(denied.status,410,denied.text);
 await f.refresh();assert.equal(await readFile(f.app.planningBrowser.file(f.initial.id),'utf8'),before);
 assert.deepEqual(planNode(await f.read()).response,planNode(f.initial).response);
 assert.equal(planNode(await f.read()).response.verifiedAction,false);assert.equal(f.runtime.calls,0);
 assert.equal(f.calls.some(call=>call.method!=='GET'),false);
});
test('archived canonical accuracy remains visible without an accuracy editor or a false completion claim',async t=>{
 const accuracy={mode:'exact',tolerance:'',decisionThreshold:'One real confirmation.',evidenceNeeded:'The original confirmation receipt.',consequence:'No unsupported completion claim.',unknownPolicy:'block',stopWhen:'One receipt is observed and bound.'};
 const f=await fixture(t,{accuracy}),details=f.dom.$('.pb-cycle-plan-details');details.open=true;
 assert.match(details.textContent,/Stop checking when: One receipt is observed and bound/);
 assert.equal(f.dom.$('[data-accuracy-editor]'),null);
 assert.deepEqual(planNode(await f.read()).response.contract.criteria[1].accuracy,accuracy);
 assert.equal(planNode(await f.read()).response.verifiedAction,false);assert.equal(f.runtime.calls,0);
});
