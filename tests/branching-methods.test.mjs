import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MethodStore, taskPlanMethodDraft } from '../lib/methods.mjs';
import { METHOD_LIMITS, BUILTIN_METHODS } from '../lib/process-ontology.mjs';
import { normalizeTaskPlan } from '../lib/task-plan.mjs';
import { createProjectToolHandler, PROJECT_TOOL } from '../lib/project-tools.mjs';

const action = (id, title, extra = {}) => ({ id, title, kind: 'action', doneWhen: `${title} has a checkable result.`, ...extra });
const source = () => ({ taskId: 'task-outline', revision: 7, goal: 'private-original-goal', cwd: '/private/original-workspace', inputs: [{ text: 'private-input' }], artifacts: [{ id: 'artifact-source', path: 'private-output-path' }], checkpoint: { summary: 'private-checkpoint' }, ...normalizeTaskPlan({
  plan: { layout: 'sequence', taskType: 'software', focusStepId: 'repair' },
  steps: [
    action('scope', 'Scope the change', { stepType: 'scope', status: 'done', evidence: 'private-runtime-evidence', note: 'private-runtime-note' }),
    { id: 'inspect', title: 'Inspect independent evidence', kind: 'parallel', dependsOn: ['scope'] },
    action('facts', 'Read the sources', { parentId: 'inspect', stepType: 'collect', result: 'A source comparison.', status: 'done', evidence: 'private-source-evidence', artifactIds: ['artifact-source'] }),
    action('check', 'Check the constraints', { parentId: 'inspect', stepType: 'check', status: 'done', evidence: 'private-constraint-evidence' }),
    { id: 'route', title: 'Choose the next action', kind: 'choice', selectedChildId: 'repair' },
    action('repair', 'Repair the issue', { parentId: 'route', condition: 'An issue is reproduced.', status: 'active', stepType: 'create' }),
    action('retain', 'Retain the existing behavior', { parentId: 'route', condition: 'No issue is reproduced.', stepType: 'decide' }),
    action('handoff', 'Explain the result', { dependsOn: ['route'], stepType: 'handoff' })
  ]
}, { actor: { runId: 'original-run', nodeId: 'original-node' }, artifacts: [{ id: 'artifact-source' }] }) });

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-branching-methods-')), calls = [];
  const projects = { definition: value => { calls.push({ action: 'definition', value }); return value; }, create: async value => { calls.push({ action: 'create', value }); return { ...value, id: 'project', status: 'draft' }; } };
  const stores = [], open = async () => { const store = await new MethodStore({ dataDir: directory, projects }).init(); stores.push(store); return store; }, methods = await open();
  t.after(async () => { for (const store of stores) await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { methods, open, calls, projects };
}

test('task method drafting retains the full reusable graph without task inputs, execution claims or past branch selections', () => {
  const state = source(), before = structuredClone(state), draft = taskPlanMethodDraft(state);
  assert.deepEqual(state, before); assert.equal(draft.name, 'Reusable task method'); assert.equal(draft.taskType, 'software'); assert.deepEqual(draft.inputs, []);
  assert.equal(draft.outline.layout, 'sequence'); assert.equal(draft.outline.steps.length, 8);
  assert.deepEqual(draft.outline.steps.filter(step => step.parentId === 'inspect').map(step => step.id), ['facts', 'check']);
  assert.equal(draft.outline.steps.find(step => step.id === 'inspect').kind, 'parallel');
  assert.equal(draft.outline.steps.find(step => step.id === 'route').kind, 'choice');
  assert.equal(draft.outline.steps.find(step => step.id === 'repair').condition, 'An issue is reproduced.');
  assert.deepEqual(draft.outline.steps.find(step => step.id === 'handoff').dependsOn, ['route']);
  assert.deepEqual(draft.steps.map(step => step.id), ['scope', 'facts', 'check', 'repair', 'retain', 'handoff']);
  assert.deepEqual(draft.steps.find(step => step.id === 'facts').checks, ['Read the sources has a checkable result.']);
  const raw = JSON.stringify(draft);
  for (const forbidden of ['private-', 'original-run', 'original-node', 'selectedChildId', 'focusStepId', '"evidence"', 'artifactIds', 'authoredBy', '"status"', '"note"']) assert.equal(raw.includes(forbidden), false, forbidden);
});

test('empty scaffolds cannot become methods; genuine legacy steps receive an explicit criterion draft', () => {
  assert.throws(() => taskPlanMethodDraft({ steps: [] }), { code: 'METHOD_OUTLINE_UNAVAILABLE', status: 409 });
  const legacy = { taskId: 'old-task', revision: 1, steps: [{ id: 'answer', title: 'Explain the result', status: 'done' }] };
  assert.match(taskPlanMethodDraft(legacy).outline.steps[0].doneWhen, /^Draft criterion:/);
  assert.match(taskPlanMethodDraft({ ...legacy, planVersion: 1, plan: { legacyCriteriaIds: ['answer'] } }).outline.steps[0].doneWhen, /^Draft criterion:/);
  assert.throws(() => taskPlanMethodDraft({ ...legacy, planVersion: 1, plan: {} }), /doneWhen/);
});

test('outline methods persist exact structure, support 200 nodes and preserve 120-character action IDs', async t => {
  const { methods, open } = await fixture(t), state = source();
  const saved = await methods.create(taskPlanMethodDraft(state)); assert.equal(saved.verification, 'unverified');
  assert.deepEqual(saved.outline, taskPlanMethodDraft(state).outline);
  const longId = 'x'.repeat(120), many = { taskId: 'large-task', revision: 1, ...normalizeTaskPlan({ plan: { layout: 'parallel' }, steps: Array.from({ length: 200 }, (_, index) => action(index ? `action-${index}` : longId, `Action ${index + 1}`)) }) };
  const large = await methods.create(taskPlanMethodDraft(many)); assert.equal(large.steps.length, 200); assert.equal(large.outline.steps.length, 200); assert.equal(large.steps[0].id, longId);
  const ordered = taskPlanMethodDraft(many); delete ordered.outline;
  await assert.rejects(methods.create(ordered), /one to 50 ordered steps/);
  await methods.close(); const reopened = await open(); assert.deepEqual(reopened.get(saved.id), saved); assert.deepEqual(reopened.get(large.id), large);
});

test('outline authoring rejects malformed structure, runtime fields and divergent action definitions before saving', async t => {
  const { methods } = await fixture(t);
  const mutations = [
    draft => { draft.outline.steps[1].parentId = 'missing'; },
    draft => { draft.outline.steps[1].parentId = 'facts'; },
    draft => { draft.outline.steps[0].dependsOn = ['handoff']; },
    draft => { draft.outline.steps[4].selectedChildId = 'repair'; },
    draft => { draft.outline.steps[0].status = 'done'; },
    draft => { draft.outline.steps[0].evidence = 'Past evidence'; },
    draft => { delete draft.outline.steps[0].doneWhen; },
    draft => { draft.outline.steps[0].stepType = 'missing-type'; },
    draft => { draft.steps.pop(); },
    draft => { draft.steps.reverse(); },
    draft => { draft.steps[0].title = 'A different action'; },
    draft => { draft.steps[0].checks = ['A different criterion.']; },
    draft => { draft.steps[0].parentId = 'inspect'; },
    draft => { draft.outline.steps[0].result = 'x'.repeat(1001); }
  ];
  for (const mutate of mutations) { const draft = taskPlanMethodDraft(source()); mutate(draft); await assert.rejects(methods.create(draft)); }
  const huge = taskPlanMethodDraft(source()); huge.outline = { layout: 'parallel', steps: Array.from({ length: 200 }, (_, index) => action(`long-${index}`, `Long action ${index}`, { doneWhen: 'x'.repeat(1000), result: 'y'.repeat(1000) })) }; delete huge.steps;
  await assert.rejects(methods.create(huge), { code: 'TASK_PLAN_LIMIT', status: 413 }); assert.equal(methods.status().custom, 0);
});

test('editing an outline requires a consistent blueprint, while metadata edits preserve source receipts', async t => {
  const { methods } = await fixture(t), receipt = await methods.saveTaskMethod(source()), saved = receipt.method;
  await assert.rejects(methods.update(saved.id, { expectedRevision: 1, steps: [...saved.steps].reverse() }), /Edit the branching outline together/);
  assert.equal(methods.get(saved.id).revision, 1);
  const renamed = await methods.update(saved.id, { expectedRevision: 1, name: 'Reviewed method name' }); assert.deepEqual(renamed.outline, saved.outline); assert.deepEqual(renamed.sourceTask, saved.sourceTask);
  const outline = structuredClone(renamed.outline), steps = structuredClone(renamed.steps); outline.steps.find(step => step.id === 'repair').title = 'Apply the smallest repair'; steps.find(step => step.id === 'repair').title = 'Apply the smallest repair';
  const revised = await methods.update(saved.id, { expectedRevision: 2, outline, steps }); assert.equal(revised.revision, 3); assert.equal(revised.outline.steps.find(step => step.id === 'repair').title, 'Apply the smallest repair');
  await assert.rejects(methods.update(saved.id, { expectedRevision: 3, outline: null }), /outline must be an object/);
  await assert.rejects(methods.update(saved.id, { expectedRevision: 3, sourceTask: {} }), /Unsupported method field/);
});

test('task method save receipts deduplicate concurrent retries and recover after task advancement and later method edits', async t => {
  const { methods, open } = await fixture(t), state = source(), options = { name: ' Reusable repair ', description: ' A reviewed blueprint. ' };
  const [first, retry] = await Promise.all([methods.saveTaskMethod(state, options), methods.saveTaskMethod(state, options)]);
  assert.equal(first.created, true); assert.equal(retry.created, false); assert.equal(first.method.id, retry.method.id); assert.equal(methods.status().custom, 1);
  assert.match(first.sourceTask.fingerprint, /^[a-f0-9]{64}$/); assert.match(first.sourceTask.requestFingerprint, /^[a-f0-9]{64}$/);
  const edited = await methods.update(first.method.id, { expectedRevision: 1, name: 'Later edit to preserve', description: 'New description.' });
  const advanced = { ...state, revision: 8 }; assert.equal(methods.findSavedTaskMethod(advanced.taskId, 8, options), null);
  const found = methods.findSavedTaskMethod(advanced.taskId, 7, { name: options.name.trim(), description: options.description.trim() }); assert.deepEqual(found.method, edited); assert.equal(found.created, false);
  assert.deepEqual((await methods.saveTaskMethod(state, options)).method, edited);
  found.method.name = 'Mutated response'; assert.equal(methods.get(edited.id).name, 'Later edit to preserve');
  await methods.close(); const reopened = await open(); assert.deepEqual(reopened.findSavedTaskMethod(state.taskId, 7, options).method, edited);
  assert.equal((await reopened.saveTaskMethod(advanced, options)).created, true); assert.equal((await reopened.saveTaskMethod(state, { ...options, name: 'Separate authoring intent' })).created, true); assert.equal(reopened.status().custom, 3);
});

test('canonical default save options match lookup and conflicting source content cannot overwrite a receipt', async t => {
  const { methods } = await fixture(t), state = source(), first = await methods.saveTaskMethod(state);
  assert.equal(methods.findSavedTaskMethod(state.taskId, state.revision, { name: null, description: undefined }).method.id, first.method.id);
  const changed = structuredClone(state); changed.steps[0].title = 'Changed source with the same revision';
  await assert.rejects(methods.saveTaskMethod(changed), { code: 'METHOD_SOURCE_CONFLICT', status: 409 }); assert.equal(methods.status().custom, 1);
  assert.equal(methods.get(first.method.id).steps[0].title, 'Scope the change');
  const definition = taskPlanMethodDraft(state); definition.sourceTask = first.sourceTask;
  await assert.rejects(methods.create(definition), /Unsupported method field/);
});

test('a save that committed before a lost acknowledgement remains recoverable without duplicating a method', async t => {
  const { methods, open } = await fixture(t), state = source(), persist = methods.persist.bind(methods);
  methods.persist = async next => { await persist(next); throw Error('Simulated lost acknowledgement'); };
  await assert.rejects(methods.saveTaskMethod(state), /lost acknowledgement/);
  assert.equal(methods.status().custom, 1); const original = methods.findSavedTaskMethod(state.taskId, state.revision); assert.ok(original);
  methods.persist = persist; assert.equal((await methods.saveTaskMethod(state)).method.id, original.method.id);
  await methods.close(); const reopened = await open(); assert.equal(reopened.findSavedTaskMethod(state.taskId, state.revision).method.id, original.method.id); assert.equal(reopened.status().custom, 1);
});

test('cancellation before admission and while queued creates no method, while close drains an admitted save', async t => {
  const { methods } = await fixture(t), stopped = new AbortController(); stopped.abort();
  await assert.rejects(methods.saveTaskMethod(source(), {}, { signal: stopped.signal }), { code: 'METHOD_SAVE_ABORTED' });
  const persist = methods.persist.bind(methods); let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  methods.persist = async next => { entered(); await gate; return persist(next); };
  const first = methods.saveTaskMethod(source()); await arrived;
  const queuedStop = new AbortController(), queued = methods.saveTaskMethod({ ...source(), taskId: 'queued-task' }, {}, { signal: queuedStop.signal });
  const rejected = assert.rejects(queued, { code: 'METHOD_SAVE_ABORTED' }); queuedStop.abort();
  const closing = methods.close(); release(); const saved = await first; await rejected; await closing;
  assert.equal(methods.status().custom, 1); assert.equal(methods.get(saved.method.id).id, saved.method.id);
});

test('a full library still returns an existing save receipt without evicting or replacing methods', async t => {
  const { methods } = await fixture(t), state = source(), first = await methods.saveTaskMethod(state);
  const filler = structuredClone(first.method); delete filler.sourceTask;
  methods.state.methods.push(...Array.from({ length: METHOD_LIMITS.methods - 1 }, (_, index) => ({ ...structuredClone(filler), id: `filler-${index}` })));
  assert.equal((await methods.saveTaskMethod(state)).method.id, first.method.id);
  await assert.rejects(methods.saveTaskMethod({ ...state, revision: 8 }), { status: 507 }); assert.equal(methods.status().custom, METHOD_LIMITS.methods);
});

test('malformed or duplicated persisted source receipts are rejected without discarding the saved file', async t => {
  const { methods, open } = await fixture(t), first = await methods.saveTaskMethod(source()); await methods.close();
  const healthy = JSON.parse(await readFile(methods.file, 'utf8'));
  for (const mutate of [state => { state.methods[0].sourceTask.fingerprint = 'forged'; }, state => { state.methods[0].sourceTask.revision = 0; }, state => { state.methods.push({ ...structuredClone(first.method), id: 'duplicate-receipt' }); }]) {
    const value = structuredClone(healthy); mutate(value); const raw = JSON.stringify(value); await writeFile(methods.file, raw); await rm(methods.file + '.bak', { force: true });
    const broken = await open(); assert.equal(broken.status().healthy, false); assert.equal(await readFile(methods.file, 'utf8'), raw); await broken.close();
  }
});

test('legacy project catalog stays byte-equivalent and cannot accept or execute branching methods', async t => {
  assert.equal(createHash('sha256').update(JSON.stringify(PROJECT_TOOL)).digest('hex'), '877436207114a65c7ef1c471455669fdbbe1343d49c739def4232a46f6c207a0');
  const { methods, calls, projects } = await fixture(t), draft = taskPlanMethodDraft(source()), saved = await methods.create(draft);
  assert.throws(() => methods.preview(saved.id), { code: 'METHOD_OUTLINE_TASK_ONLY', status: 409 });
  await assert.rejects(methods.use(saved.id), { code: 'METHOD_OUTLINE_TASK_ONLY', status: 409 });
  const handler = createProjectToolHandler({ projects, methods, capabilities: {}, cwd: '/workspace' });
  const call = args => handler({ name: PROJECT_TOOL.name, arguments: args });
  const unsupported = await call({ action: 'create_method', method: draft }); assert.equal(unsupported.success, false); assert.equal(JSON.parse(unsupported.contentItems[0].text).code, 'METHOD_SCHEMA_UNSUPPORTED');
  const unexposed = await call({ action: 'update_method', id: saved.id, method: { expectedRevision: 1, outline: saved.outline } }); assert.equal(unexposed.success, false);
  const flatten = await call({ action: 'update_method', id: saved.id, method: { expectedRevision: 1, steps: [...saved.steps].reverse() } }); assert.equal(flatten.success, false);
  const read = await call({ action: 'get_method', id: saved.id }); assert.equal(read.success, true); assert.deepEqual(JSON.parse(read.contentItems[0].text).outline, saved.outline);
  for (const action of ['preview_method', 'use_method']) { const result = await call({ action, id: saved.id }); assert.equal(result.success, false); assert.equal(JSON.parse(result.contentItems[0].text).code, 'METHOD_OUTLINE_TASK_ONLY'); }
  assert.equal(methods.status().custom, 1); assert.equal(calls.length, 0);
});

test('an unchanged exact-revision method keeps its complete action instructions when saved from a task', async t => {
  const { methods } = await fixture(t), method = BUILTIN_METHODS.find(item => item.id === 'catalyst-ach');
  const state = { taskId: 'retained-procedure', revision: 4, ...normalizeTaskPlan({ plan: { layout: 'sequence', taskType: method.taskType, method: { id: method.id, revision: method.revision } }, steps: method.steps.map(step => action(step.id, step.title, { stepType: step.type, result: step.result, doneWhen: step.checks[0] })) }) };
  const before = structuredClone(state), draft = methods.draftTaskMethod(state);
  assert.deepEqual(draft.steps, method.steps); assert.ok(draft.steps[0].instructions.length > draft.steps[0].title.length); assert.deepEqual(state, before);
  const saved = await methods.saveTaskMethod(state); assert.deepEqual(saved.method.steps, method.steps); assert.match(saved.sourceTask.outlineFingerprint, /^[a-f0-9]{64}$/); assert.deepEqual(saved.method.inputs, []);
  const changed = structuredClone(state); changed.steps[1].title = 'An adapted task-specific action';
  const partial = methods.draftTaskMethod(changed); assert.equal(partial.steps[1].instructions, changed.steps[1].title); assert.equal(partial.steps[0].instructions, method.steps[0].instructions);
  changed.plan.method.revision++; const stale = methods.draftTaskMethod(changed); assert.ok(stale.steps.every(step => step.instructions === step.title));
  await assert.rejects(methods.saveTaskMethod(changed), { code: 'METHOD_SOURCE_CONFLICT' });
});

test('branching source detail is preserved only for matching action rows and recovers after the source method is edited', async t => {
  const { methods, open } = await fixture(t), original = taskPlanMethodDraft(source());
  original.steps.forEach(step => { step.instructions = `Substantive reusable procedure for ${step.title}: identify inputs, compare observed evidence, record the supported output and retain the documented check.`; step.inputs = ['Reusable source context']; });
  const template = await methods.create(original), state = source(); state.plan.method = { id: template.id, revision: template.revision };
  const first = await methods.saveTaskMethod(state); assert.deepEqual(first.method.steps, template.steps);
  const moved = structuredClone(state); moved.steps.find(step => step.id === 'facts').dependsOn = ['scope']; const movedDraft = methods.draftTaskMethod(moved); assert.equal(movedDraft.steps.find(step => step.id === 'facts').instructions, 'Read the sources');
  await methods.update(template.id, { expectedRevision: 1, description: 'The source template was revised after its use.' });
  assert.ok(methods.draftTaskMethod(state).steps.every(step => step.instructions === step.title), 'A different source revision must not be silently reused.');
  const retry = await methods.saveTaskMethod(state); assert.equal(retry.created, false); assert.deepEqual(retry.method.steps, template.steps);
  await methods.close(); const reopened = await open(); assert.deepEqual((await reopened.saveTaskMethod(state)).method.steps, template.steps);
});

test('explicit authored action details survive an adapted-method save and participate in canonical retry identity', async t => {
  const { methods } = await fixture(t), state = source(), methodSteps = taskPlanMethodDraft(state).steps.map(step => ({ ...step, instructions: `  A complete reusable procedure for ${step.title}: identify input provenance, compare the observations with the stated condition, and write the supported result.  `, inputs: ['Original evidence'], checks: [...step.checks, 'The procedure preserves missing information and uncertainty.'] }));
  const options = { name: 'Composed evidence procedure', methodSteps, catalog: { domain: 'research', outputs: ['matrix'], prerequisites: ['Original observations are available.'] } }, draft = methods.draftTaskMethod(state, options);
  assert.ok(draft.steps.every(step => step.instructions.startsWith('A complete reusable'))); assert.equal(Object.hasOwn(draft, 'methodSteps'), false);
  const saved = await methods.saveTaskMethod(state, options); assert.deepEqual(saved.method.steps, draft.steps); assert.deepEqual(saved.method.catalog, options.catalog);
  const retry = methods.findSavedTaskMethod(state.taskId, state.revision, { ...options, methodSteps: methodSteps.map(step => ({ ...step, instructions: step.instructions.trim() })) }); assert.equal(retry.method.id, saved.method.id);
  const distinct = { ...options, methodSteps: methodSteps.map((step, index) => index ? step : { ...step, instructions: 'A deliberately different reusable first-step procedure.' }) };
  assert.equal(methods.findSavedTaskMethod(state.taskId, state.revision, distinct), null); const other = await methods.saveTaskMethod(state, distinct); assert.notEqual(other.method.id, saved.method.id);
  const raw = JSON.stringify(saved.method); for (const forbidden of ['private-runtime', 'private-input', 'artifactIds', 'selectedChildId', '"status"']) assert.equal(raw.includes(forbidden), false, forbidden);
});

test('authored method actions reject missing, reordered, divergent or execution-bearing rows before a save', async t => {
  const { methods } = await fixture(t), state = source(), steps = taskPlanMethodDraft(state).steps;
  for (const change of [value => value.pop(), value => value.reverse(), value => { value[0].title = 'Different task'; }, value => { value[0].checks = ['A different criterion.']; }, value => { value[0].status = 'done'; }, value => { value[0].evidence = 'A completion claim.'; }, value => { value[0].artifactIds = ['private-artifact']; }, value => { value[0].instructions = 'x'.repeat(12001); }]) {
    const methodSteps = structuredClone(steps); change(methodSteps); assert.throws(() => methods.draftTaskMethod(state, { methodSteps })); await assert.rejects(methods.saveTaskMethod(state, { methodSteps }));
  }
  assert.equal(methods.status().custom, 0);
});
