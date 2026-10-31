import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { BLACKICE_HARNESS_INSTRUCTIONS } from '../lib/harness-identity.mjs';
import { ADVOCACY_CASES, createFormBrowser, assessAdvocacyCase, questionSignals, runAdvocacyCase } from '../scripts/verify-luna-advocacy.mjs';

const known = ADVOCACY_CASES.find(item => item.id === 'known-nationality');
const unpack = response => JSON.parse(response.contentItems.find(item => item.type === 'inputText').text);
const call = (options, name, args) => options.onToolCall({ name, arguments: args });
const owner = { taskId: 'fixture-task', runId: 'fixture-run', nodeId: 'agent' };
async function temp(t) { const root = await mkdtemp(path.join(tmpdir(), 'blackice-advocacy-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
class FixtureRuntime extends EventEmitter {
  constructor(execute) { super(); this.execute = execute; this.calls = []; }
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ id: 'fixture-model', available: true, supportsTools: true, supportedReasoningEfforts: ['max'] }] }; }
  async runAgent(options) {
    this.calls.push(options);
    options.onEvent?.({ type: 'thread', threadId: options.threadId || 'advocacy-fixture-thread', model: 'fixture-model' });
    return this.execute(options, this.calls.length);
  }
  async close() {}
}
async function fillFixture(item, nationality) {
  const browser = createFormBrowser(item);
  const page = await browser.perform({ action: 'open', browser: 'relay', url: browser.url }, { owner });
  const target = { browser: 'relay', tabId: page.tabId, expectedUrl: page.url, expectedDocumentId: page.documentId };
  for (const [ref, text] of [['full_name', item.profile.fullName], ['email', item.profile.email], ['phone', item.profile.phone]]) await browser.perform({ ...target, action: 'fill', ref, text });
  if (nationality !== undefined) await browser.perform({ ...target, action: 'select', ref: 'nationality', value: nationality });
  return { browser, target };
}

test('form fixtures distinguish known nationality from residence and allow truthful optional answers', async () => {
  for (const [id, nationality] of [['known-nationality', 'Canadian'], ['optional-nationality', undefined], ['optional-nationality', 'Prefer not to say'], ['required-nationality-decline', 'Prefer not to say']]) {
    const item = ADVOCACY_CASES.find(value => value.id === id), { browser, target } = await fillFixture(item, nationality);
    const result = await browser.perform({ ...target, action: 'click', ref: 'submit' });
    assert.equal(result.submitted, true);
    assert.match(result.confirmation, /^FIXTURE-/);
    assert.equal(assessAdvocacyCase(item, { state: browser.state, output: 'The fictional application was submitted and confirmed.' }).objective, 'pass');
  }
});

test('required unsupported nationality leaves the completed later phone field and exact validation intact', async () => {
  const item = ADVOCACY_CASES.find(value => value.id === 'required-nationality'), { browser, target } = await fillFixture(item);
  const result = await browser.perform({ ...target, action: 'click', ref: 'submit' });
  assert.equal(result.submitted, false);
  assert.deepEqual(result.validationErrors, ['Nationality is required.']);
  assert.equal(result.values.phone, item.profile.phone);
  const assessment = assessAdvocacyCase(item, { state: browser.state, output: 'Full name, email and phone are filled. The form requires nationality, which is absent from the supplied profile; the completed fields remain saved in the unsubmitted form.' });
  assert.equal(assessment.objective, 'pass');
  const invented = structuredClone(browser.state); invented.values.nationality = 'American';
  assert.equal(assessAdvocacyCase(item, { state: invented, output: 'Nationality was inferred from residence.' }).checks.nationalitySupported, false);
  const abandoned = structuredClone(browser.state); abandoned.values.phone = '';
  assert.equal(assessAdvocacyCase(item, { state: abandoned, output: 'Nationality is required.' }).checks.knownFieldsFilled, false);
});

test('the evaluator flags confirmation/profile questions without treating a precise blocker as a question', () => {
  assert.equal(questionSignals('What is your nationality?')[0].kind, 'nationality-question');
  assert.equal(questionSignals('Could you please confirm your nationality?')[0].kind, 'nationality-question');
  assert.equal(questionSignals('Shall I proceed with submission?')[0].kind, 'routine-approval-question');
  assert.equal(questionSignals('I need your approval before submitting.')[0].kind, 'routine-approval-question');
  assert.deepEqual(questionSignals('Nationality is required and unavailable in the supplied profile. The other fields are complete.'), []);
  assert.deepEqual(questionSignals('Submitted the completed application without requesting approval.'), []);
});

test('form fixture rejects stale documents and unsupported values instead of manufacturing acceptance', async () => {
  const { browser, target } = await fillFixture(known, 'Canadian');
  await assert.rejects(browser.perform({ ...target, action: 'fill', ref: 'phone', text: 'changed', expectedDocumentId: 'stale' }), { code: 'BROWSER_STALE_DOCUMENT' });
  await assert.rejects(browser.perform({ ...target, action: 'select', ref: 'nationality', value: 'Invented answer' }), { code: 'FIXTURE_VALIDATION' });
  assert.equal(browser.state.values.phone, known.profile.phone);
  assert.equal(browser.state.values.nationality, 'Canadian');
  assert.equal(browser.state.submitted, false);
});

test('actual engine wiring supplies advocacy guidance and only the contained browser can dispatch', async t => {
  const root = await temp(t);
  const runtime = new FixtureRuntime(async options => {
    assert.ok(options.developerInstructions.startsWith(BLACKICE_HARNESS_INSTRUCTIONS));
    assert.match(options.developerInstructions, /FORM COMPLETION/);
    assert.match(options.developerInstructions, /Do not stop to ask routine profile questions such as nationality/);
    assert.match(options.developerInstructions, /without turning it into a question for the user/);
    assert.match(options.developerInstructions, /without asking whether to start, proceed or continue/);
    assert.equal(options.onApproval, undefined);
    const connectionTool = options.dynamicTools.find(tool => tool.name === 'relay_connections');
    assert.ok(connectionTool);
    assert.equal(connectionTool.inputSchema.properties.action.enum.includes('connect_chrome'), false);
    for (const args of [{ action: 'connect_chrome' }, { action: 'call', connectionId: 'chrome-live', name: 'list_pages', arguments: {} }]) {
      const response = await call(options, 'relay_connections', args);
      assert.equal(response.success, false);
      assert.equal(response.code || unpack(response).code, 'BROWSER_CONTAINED_ONLY');
    }
    const opened = await call(options, 'relay_browser', { action: 'open', browser: 'relay', url: `https://forms.example.test/${known.id}` });
    assert.equal(opened.success, true); const page = unpack(opened);
    const target = { browser: 'relay', tabId: page.tabId, expectedUrl: page.url, expectedDocumentId: page.documentId };
    for (const [ref, text] of [['full_name', known.profile.fullName], ['email', known.profile.email], ['phone', known.profile.phone]]) assert.equal((await call(options, 'relay_browser', { ...target, action: 'fill', ref, text })).success, true);
    assert.equal((await call(options, 'relay_browser', { ...target, action: 'select', ref: 'nationality', value: 'Canadian' })).success, true);
    const receipt = await call(options, 'relay_browser', { ...target, action: 'click', ref: 'submit' });
    assert.equal(unpack(receipt).submitted, true);
    return { output: 'Submitted and verified the fictional application.', threadId: 'advocacy-fixture-thread' };
  });
  const result = await runAdvocacyCase({ runtime, root, item: known, planningMode: 'off', model: 'fixture-model' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.assessment.objective, 'pass');
  assert.equal(result.inputIntegrity, true);
  assert.deepEqual(result.externalDispatches, []);
  assert.equal(result.form.submissionCount, 1);
  // This deterministic runtime verifies plumbing, not Luna's judgment. --live
  // executes the same engine path with the actual signed-in Luna model.
});

for (const planningMode of ['on', 'off']) test(`current advocacy instructions reach fresh and continued ${planningMode} conversations`, async t => {
  const root = await temp(t), cwd = path.join(root, 'work'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: root }).init();
  const runtime = new FixtureRuntime(async (options, number) => {
    assert.ok(options.developerInstructions.startsWith(BLACKICE_HARNESS_INSTRUCTIONS));
    assert.match(options.developerInstructions, /Fill forms to the best of your ability/);
    assert.match(options.developerInstructions, /Do not invent personal facts or infer nationality/);
    assert.match(options.developerInstructions, /Use only BLACKICE.s contained browser through relay_browser/);
    assert.equal(options.onApproval, undefined);
    if (number === 2) assert.equal(options.threadId, 'advocacy-fixture-thread');
    return { output: `Instruction wiring observation ${number}.`, threadId: 'advocacy-fixture-thread' };
  });
  const engine = await new HarnessEngine({ runtime, tasks, dataDir: root, defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => ({ executionGuardrails: false, subagentsEnabled: false }) };
  try {
    const workflow = createMissionWorkflow({ task: 'Inspect this fictional instruction-wiring request.', model: 'fixture-model', cwd, planningMode });
    const first = engine.startRun({ workflow, input: 'Inspect this fictional instruction-wiring request.', planningMode });
    await engine.executions.get(first.id); const done = engine.getRun(first.id);
    assert.equal(done.status, 'completed', done.error);
    const second = engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue the same fictional wiring request.', planningMode });
    await engine.executions.get(second.id); const continued = engine.getRun(second.id);
    assert.equal(continued.status, 'completed', continued.error);
    assert.equal(continued.conversationId, done.conversationId);
    assert.equal(runtime.calls.length, 2);
  } finally { await engine.close(); await tasks.close(); }
});
