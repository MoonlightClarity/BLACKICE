import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SwarmBoardStore } from '../lib/swarm-board.mjs';
import { createSwarmDirectTools } from '../lib/swarm-direct-tools.mjs';
import { validDirectArguments } from '../lib/direct-execution-api.mjs';
import { SWARM_ACTION_NAMES } from '../lib/swarm-action-contract.mjs';

const human = { kind: 'human', id: 'local-session', label: 'Local user' };
const worker = { kind: 'connector', id: 'worker-client', label: 'Worker connector' };
let counter = 0;
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'blackice-swarm-'));
  const store = await new SwarmBoardStore({ dataDir }).init();
  t.after(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const apply = (action, rest = {}, actor = human) =>
    store.apply({ mutationId: 'm' + ++counter, action, ...rest }, actor);
  const create = async () => (await apply('create_project',
    { value: { id: 'swarm_demo', name: 'Swarm demo', objective: 'Coordinate independently owned code without claiming a release.' } })).project;
  const propose = async (id, more = {}) => apply('propose_item', {
    projectId: 'swarm_demo', expectedProjectRevision: store.snapshot('swarm_demo').revision,
    value: { id, title: id, scope: 'Own one isolated file.', requirements: 'Observed, independently reviewable result.',
      ownerId: 'agent_a', dependsOn: [], verificationTarget: 'unit', ...more },
  });
  return { dataDir, store, apply, create, propose };
}
const itemOf = (store, id = 'build') => store.snapshot('swarm_demo').items.find(item => item.id === id);
const sourceOf = (store, id) => store.snapshot('swarm_demo').sources.find(item => item.id === id);
const itemAction = (store, id, action, value, extra = {}) => ({
  projectId: 'swarm_demo', itemId: id, expectedItemRevision: itemOf(store, id).revision, value, ...extra,
});
async function evidence(ctx, id, sourceId, outcome, claim = 'accepted output', authority = 'unit') {
  const item = itemOf(ctx.store, id), source = sourceOf(ctx.store, sourceId);
  return ctx.apply('record_evidence', { projectId: 'swarm_demo', itemId: id,
    value: { id: 'ev_' + ++counter, claim, epistemic: 'observed', authority, outcome,
      sourceId, sourceRevision: source.revision, requirementRevision: item.requirementRevision,
      note: 'Reported observation by an authenticated connector, not independently checked.' } }, worker);
}
async function recordSource(ctx, id, text, update = false) {
  return ctx.apply('record_source', { projectId: 'swarm_demo',
    ...(update ? { expectedSourceRevision: sourceOf(ctx.store, id).revision } :
      { expectedProjectRevision: ctx.store.snapshot('swarm_demo').revision }),
    value: { id, text, reference: 'fixture://record/' + id } });
}
async function workerA(ctx) {
  return ctx.apply('register_worker', { projectId: 'swarm_demo',
    expectedProjectRevision: ctx.store.snapshot('swarm_demo').revision,
    value: { id: 'agent_a', label: 'Agent A', scope: 'Only its own isolated lane.',
      kind: 'agent', actorId: 'worker-client' } });
}

test('swarm persists a separate management ledger; worker readiness is not coordinator approval', async t => {
  const ctx = await fixture(t);
  await ctx.create(); await workerA(ctx); await ctx.propose('build', { verificationTarget: 'live_worker' });
  let item = itemOf(ctx.store);
  assert.equal(item.phase, 'proposed');
  assert.equal(item.readiness, 'not_ready');
  await ctx.apply('request_ready', itemAction(ctx.store, 'build', 'request_ready', { note: 'I think my code can be reviewed.' }), worker);
  item = itemOf(ctx.store);
  assert.equal(item.readiness, 'ready_requested');
  assert.equal(item.readyDecision, null);
  await assert.rejects(ctx.apply('decide_ready', itemAction(ctx.store, 'build', 'decide_ready',
    { disposition: 'approved', reason: 'No evidence yet.', evidenceIds: [] })), /Approval needs a current worker-ready request/);
  await recordSource(ctx, 'fixture', 'one test output');
  const recorded = await evidence(ctx, 'build', 'fixture', 'pass');
  const saved = recorded.project.evidence.at(-1);
  assert.equal(saved.originAuthenticated, false);
  assert.equal(itemOf(ctx.store).proof.comparableObservedEvidence, false, 'unit evidence is not live-worker proof');
  await assert.rejects(ctx.apply('decide_ready', itemAction(ctx.store, 'build', 'decide_ready',
    { disposition: 'approved', reason: 'I approve.', evidenceIds: [saved.id] }), worker), /Only the recorded coordinator/);
  await assert.rejects(ctx.apply('decide_ready', itemAction(ctx.store, 'build', 'decide_ready',
    { disposition: 'approved', reason: 'Unit proof cannot support live worker.', evidenceIds: [saved.id] })), /required authority/);
  const reportedLive = (await evidence(ctx, 'build', 'fixture', 'pass', 'worker acknowledgment', 'live_worker')).project.evidence.at(-1);
  await ctx.apply('decide_ready', itemAction(ctx.store, 'build', 'decide_ready',
    { disposition: 'approved', reason: 'Approved based on claimed live-worker evidence; not independently authenticated.',
      evidenceIds: [reportedLive.id] }));
  assert.equal(itemOf(ctx.store).readiness, 'ready');
  assert.equal(itemOf(ctx.store).proof.assessment, 'reported-comparable');
  assert.deepEqual(itemOf(ctx.store).readinessHistory.map(record => record.kind), ['request', 'decision']);
  const reopened = await new SwarmBoardStore({ dataDir: ctx.dataDir }).init();
  assert.equal(reopened.snapshot('swarm_demo').items[0].readiness, 'ready');
  await reopened.close();
});

test('independent work-item writes use per-item CAS, while same-item races conflict', async t => {
  const ctx = await fixture(t);
  await ctx.create(); await workerA(ctx); await ctx.propose('build'); await ctx.propose('docs');
  const a = itemOf(ctx.store, 'build').revision, b = itemOf(ctx.store, 'docs').revision;
  await Promise.all([
    ctx.apply('request_ready', { projectId: 'swarm_demo', itemId: 'build', expectedItemRevision: a,
      value: { note: 'Build ready for review.' } }, worker),
    ctx.apply('request_ready', { projectId: 'swarm_demo', itemId: 'docs', expectedItemRevision: b,
      value: { note: 'Docs ready for review.' } }, worker),
  ]);
  assert.equal(itemOf(ctx.store, 'build').readiness, 'ready_requested');
  assert.equal(itemOf(ctx.store, 'docs').readiness, 'ready_requested');
  const earlier = itemOf(ctx.store, 'build').revision;
  const results = await Promise.allSettled([
    ctx.apply('request_ready', { projectId: 'swarm_demo', itemId: 'build', expectedItemRevision: earlier,
      value: { note: 'First request.' } }, worker),
    ctx.apply('request_ready', { projectId: 'swarm_demo', itemId: 'build', expectedItemRevision: earlier,
      value: { note: 'Overwritten request.' } }, worker),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'SWARM_REVISION_CONFLICT').length, 1);
});

test('idempotency survives a lost acknowledgement and rejects divergent reuse', async t => {
  const ctx = await fixture(t);
  const input = { mutationId: 'stable_create', action: 'create_project',
    value: { id: 'swarm_demo', name: 'Swarm demo', objective: 'Only create once.' } };
  const first = await ctx.store.apply(input, human);
  const retry = await ctx.store.apply(input, human);
  assert.equal(first.duplicate, false); assert.equal(retry.duplicate, true);
  assert.equal(ctx.store.snapshot().eventCount, 1);
  await assert.rejects(ctx.store.apply({ ...input,
    value: { ...input.value, objective: 'Changed objective' } }, human), /reused with different payload/);
});

test('source and requirement revision changes invalidate only applicable claims, retaining failure history', async t => {
  const ctx = await fixture(t);
  await ctx.create(); await workerA(ctx); await ctx.propose('build'); await ctx.propose('docs');
  await recordSource(ctx, 'build_source', 'build revision A');
  await recordSource(ctx, 'docs_source', 'docs revision A');
  const first = (await evidence(ctx, 'build', 'build_source', 'pass')).project.evidence.at(-1).id;
  await evidence(ctx, 'docs', 'docs_source', 'pass');
  await ctx.apply('request_ready', itemAction(ctx.store, 'build', 'request_ready', { note: 'Ready with version A.' }), worker);
  await ctx.apply('decide_ready', itemAction(ctx.store, 'build', 'decide_ready',
    { disposition: 'approved', reason: 'Current source A.', evidenceIds: [first] }));
  assert.equal(itemOf(ctx.store, 'build').readiness, 'ready');
  await recordSource(ctx, 'build_source', 'build revision B', true);
  assert.equal(sourceOf(ctx.store, 'build_source').history[0].text, 'build revision A', 'previous source content retained');
  assert.equal(itemOf(ctx.store, 'build').readiness, 'stale');
  assert.equal(itemOf(ctx.store, 'build').staleEvidence.length, 1);
  assert.equal(itemOf(ctx.store, 'docs').applicableEvidence.length, 1);
  const failId = (await evidence(ctx, 'build', 'build_source', 'fail')).project.evidence.at(-1).id;
  assert.equal(itemOf(ctx.store, 'build').readiness, 'contradicted');
  const passedId = (await evidence(ctx, 'build', 'build_source', 'pass')).project.evidence.at(-1).id;
  assert.equal(itemOf(ctx.store, 'build').readiness, 'contradicted', 'new pass cannot erase unresolved failure');
  await assert.rejects(ctx.apply('decide_ready', itemAction(ctx.store, 'build', 'decide_ready',
    { disposition: 'approved', reason: 'Trying to bypass a failed observation.', evidenceIds: [passedId] })), /no unresolved failures/);
  await ctx.apply('resolve_failure', { projectId: 'swarm_demo', itemId: 'build',
    value: { evidenceId: failId, replacementId: passedId, reason: 'A new source revision corrected the assertion.' } });
  assert.equal(itemOf(ctx.store, 'build').unresolvedFailures.length, 0);
  await ctx.apply('decide_ready', itemAction(ctx.store, 'build', 'decide_ready',
    { disposition: 'approved', reason: 'Current correction and source B.', evidenceIds: [passedId] }));
  assert.equal(itemOf(ctx.store, 'build').readiness, 'ready');
  await ctx.apply('edit_item', itemAction(ctx.store, 'build', 'edit_item',
    { requirements: 'Now require a packaged run, not the previous output.' }));
  assert.equal(itemOf(ctx.store, 'build').requirementHistory[0].requirements,
    'Observed, independently reviewable result.', 'prior requirement revision retained');
  assert.equal(itemOf(ctx.store, 'build').readiness, 'stale');
  assert.equal(itemOf(ctx.store, 'docs').applicableEvidence.length, 1);
  assert.ok(ctx.store.snapshot('swarm_demo').evidence.some(e => e.id === failId), 'failed evidence retained forever');
});

test('explicit transitions and integration receipts do not execute work or manufacture delivery', async t => {
  const ctx = await fixture(t); await ctx.create(); await workerA(ctx); await ctx.propose('build');
  await assert.rejects(ctx.apply('transition', itemAction(ctx.store, 'build', 'transition',
    { phase: 'delivered' })), /Advance one explicit/);
  await ctx.apply('transition', itemAction(ctx.store, 'build', 'transition', { phase: 'queued' }));
  await assert.rejects(ctx.apply('transition', itemAction(ctx.store, 'build', 'transition',
    { phase: 'delivered' })), /delivery reference/);
  await ctx.apply('transition', itemAction(ctx.store, 'build', 'transition',
    { phase: 'delivered', reference: 'external-message-123' }), worker);
  assert.equal(itemOf(ctx.store).phase, 'delivered');
  await ctx.apply('transition', itemAction(ctx.store, 'build', 'transition', { phase: 'accepted' }), worker);
  await assert.rejects(ctx.apply('transition', itemAction(ctx.store, 'build', 'transition',
    { phase: 'completed' })), /Completion needs current/);
  await recordSource(ctx, 'output', 'unit test completed, nothing packaged');
  const saved = (await evidence(ctx, 'build', 'output', 'pass')).project.evidence.at(-1).id;
  await ctx.apply('request_ready', itemAction(ctx.store, 'build', 'request_ready', { note: 'Ready for coordinator.' }), worker);
  await ctx.apply('decide_ready', itemAction(ctx.store, 'build', 'decide_ready',
    { disposition: 'approved', reason: 'Coordinator accepts limited evidence.', evidenceIds: [saved] }));
  await assert.rejects(ctx.apply('record_integration', itemAction(ctx.store, 'build', 'record_integration',
    { status: 'recorded' })), /exact integration reference/);
  await ctx.apply('record_integration', itemAction(ctx.store, 'build', 'record_integration',
    { status: 'recorded', reference: 'candidate-commit-abcdef', note: 'Recorded only; no merge was executed.' }));
  await ctx.apply('transition', itemAction(ctx.store, 'build', 'transition',
    { phase: 'completed', note: 'Management review complete, not a release.' }));
  assert.equal(itemOf(ctx.store).completionCurrent, true);
  assert.equal(itemOf(ctx.store).integration.independentlyVerified, false);
  assert.equal(itemOf(ctx.store).integrationHistory.length, 1);
  assert.equal(itemOf(ctx.store).integrationHistory[0].reference, 'candidate-commit-abcdef');
});

test('tampered saved snapshots are rejected rather than silently resetting Swarm history', async t => {
  const ctx = await fixture(t); await ctx.create();
  const file = path.join(ctx.dataDir, 'swarm-board.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.projects[0].objective = 'Tampered without revision or integrity update';
  await writeFile(file, JSON.stringify(saved));
  await assert.rejects(new SwarmBoardStore({ dataDir: ctx.dataDir }).init(), /could not be loaded/);
  assert.ok((await readFile(file, 'utf8')).includes('Tampered'), 'corrupt original retained for inspection');
});

test('read/write connector definitions expose distinct scopes and never forge actor from payload', async t => {
  const ctx = await fixture(t);
  const [read, write] = createSwarmDirectTools({ board: ctx.store });
  assert.deepEqual(read.definition.requiredScopes, ['read']);
  assert.deepEqual(write.definition.requiredScopes, ['planning:write']);
  const r = await write.execute({ requestId: 'request-one', mutationId: 'mutation-one', action: 'create_project',
    value: { id: 'swarm_demo', name: 'Connector project', objective: 'Connector-owned evidence and actions.' } },
    { client: { id: 'worker-client', label: 'Agent user' } });
  assert.equal(r.success, true);
  assert.equal(ctx.store.snapshot('swarm_demo').coordinator.id, 'worker-client');
  const inspected = await read.execute({ requestId: 'read-self' },
    { client: { id: 'worker-client', label: 'Agent user' } });
  assert.equal(JSON.parse(inspected.contentItems[0].text).self.id, 'worker-client');
  await assert.rejects(write.execute({ requestId: 'request-two', mutationId: 'mutation-two', action: 'edit_project',
    projectId: 'swarm_demo', expectedProjectRevision: 1, value: { name: 'Forged' } }),
    /authenticated connector grant context/);
});

test('dependent readiness follows current upstream completion and exact integration approval', async t => {
  const ctx = await fixture(t);
  await ctx.create(); await workerA(ctx);
  await ctx.propose('upstream');
  await ctx.propose('dependent', { dependsOn: ['upstream'] });
  await recordSource(ctx, 'upstream_source', 'Initial verified source.');
  const first = (await evidence(ctx, 'upstream', 'upstream_source', 'pass')).project.evidence.at(-1).id;
  await ctx.apply('request_ready', itemAction(ctx.store, 'upstream', 'request_ready', { note: 'Ready to review.' }), worker);
  await ctx.apply('decide_ready', itemAction(ctx.store, 'upstream', 'decide_ready',
    { disposition: 'approved', reason: 'Unit proof reported.', evidenceIds: [first] }));
  await ctx.apply('transition', itemAction(ctx.store, 'upstream', 'transition', { phase: 'queued' }));
  await ctx.apply('transition', itemAction(ctx.store, 'upstream', 'transition',
    { phase: 'delivered', reference: 'fixture-message' }), worker);
  await ctx.apply('transition', itemAction(ctx.store, 'upstream', 'transition', { phase: 'accepted' }), worker);
  await ctx.apply('record_integration', itemAction(ctx.store, 'upstream', 'record_integration',
    { status: 'recorded', reference: 'fixture-commit-one' }));
  await ctx.apply('transition', itemAction(ctx.store, 'upstream', 'transition', { phase: 'completed' }));
  assert.equal(itemOf(ctx.store, 'upstream').completionCurrent, true);
  await recordSource(ctx, 'dependent_source', 'Dependent result.');
  const downstream = (await evidence(ctx, 'dependent', 'dependent_source', 'pass')).project.evidence.at(-1).id;
  await ctx.apply('request_ready', itemAction(ctx.store, 'dependent', 'request_ready', { note: 'Ready when upstream is done.' }), worker);
  await ctx.apply('decide_ready', itemAction(ctx.store, 'dependent', 'decide_ready',
    { disposition: 'approved', reason: 'Dependency was complete.', evidenceIds: [downstream] }));
  assert.equal(itemOf(ctx.store, 'dependent').readiness, 'ready');

  await recordSource(ctx, 'upstream_source', 'Source revision invalidates prior evidence.', true);
  assert.equal(itemOf(ctx.store, 'upstream').completionCurrent, false);
  assert.equal(itemOf(ctx.store, 'dependent').readiness, 'not_ready');
  assert.deepEqual(itemOf(ctx.store, 'dependent').dependenciesWaiting, ['upstream']);
  const second = (await evidence(ctx, 'upstream', 'upstream_source', 'pass')).project.evidence.at(-1).id;
  await ctx.apply('request_ready', itemAction(ctx.store, 'upstream', 'request_ready', { note: 'New source reviewed.' }), worker);
  await ctx.apply('decide_ready', itemAction(ctx.store, 'upstream', 'decide_ready',
    { disposition: 'approved', reason: 'New evidence replaces the stale source.', evidenceIds: [second] }));
  assert.equal(itemOf(ctx.store, 'upstream').readiness, 'ready');
  assert.equal(itemOf(ctx.store, 'upstream').completionCurrent, false,
    'the previous integration reference was tied to the previous approval');
  await ctx.apply('record_integration', itemAction(ctx.store, 'upstream', 'record_integration',
    { status: 'recorded', reference: 'fixture-commit-two' }));
  assert.equal(itemOf(ctx.store, 'upstream').completionCurrent, true);
  assert.equal(itemOf(ctx.store, 'dependent').readiness, 'ready');
});

test('failure resolution requires later comparable observed proof and preserves the rejected claims', async t => {
  const ctx = await fixture(t);
  await ctx.create(); await workerA(ctx); await ctx.propose('build');
  await recordSource(ctx, 'check', 'Saved check output.');
  const olderPass = (await evidence(ctx, 'build', 'check', 'pass')).project.evidence.at(-1).id;
  const failure = (await evidence(ctx, 'build', 'check', 'fail')).project.evidence.at(-1).id;
  const resolveWith = replacementId => ctx.apply('resolve_failure',
    { projectId: 'swarm_demo', itemId: 'build',
      value: { evidenceId: failure, replacementId, reason: 'Conservative remediation assessment.' } });
  await assert.rejects(resolveWith(olderPass), /later observed passing evidence/);
  const source = sourceOf(ctx.store, 'check'), item = itemOf(ctx.store, 'build');
  const inferred = (await ctx.apply('record_evidence', { projectId: 'swarm_demo', itemId: 'build',
    value: { id: 'inferred_pass', claim: 'accepted output', epistemic: 'inferred', authority: 'unit', outcome: 'pass',
      sourceId: source.id, sourceRevision: source.revision, requirementRevision: item.requirementRevision } }, worker)).project.evidence.at(-1).id;
  await assert.rejects(resolveWith(inferred), /later observed passing evidence/);
  const differentAuthority = (await evidence(ctx, 'build', 'check', 'pass', 'accepted output', 'integration')).project.evidence.at(-1).id;
  await assert.rejects(resolveWith(differentAuthority), /same claimed authority/);
  const accepted = (await evidence(ctx, 'build', 'check', 'pass')).project.evidence.at(-1).id;
  await resolveWith(accepted);
  assert.deepEqual(itemOf(ctx.store, 'build').unresolvedFailures, []);
  assert.ok(ctx.store.snapshot('swarm_demo').evidence.some(entry => entry.id === failure));
});

test('only the bound worker or local human may report delivery or request worker readiness', async t => {
  const ctx = await fixture(t);
  await ctx.create(); await workerA(ctx); await ctx.propose('build');
  const outsider = { kind: 'connector', id: 'unbound_connector', label: 'Unbound worker' };
  const forbidden = promise => assert.rejects(promise, error => error.code === 'SWARM_OWNER_REQUIRED');
  await forbidden(ctx.apply('request_ready',
    itemAction(ctx.store, 'build', 'request_ready', { note: 'Other worker makes ready claim.' }), outsider));
  await ctx.apply('transition', itemAction(ctx.store, 'build', 'transition', { phase: 'queued' }));
  await forbidden(ctx.apply('transition', itemAction(ctx.store, 'build', 'transition',
    { phase: 'delivered', reference: 'outsider-reference' }), outsider));
  assert.equal(itemOf(ctx.store).phase, 'queued');
  await ctx.apply('transition', itemAction(ctx.store, 'build', 'transition',
    { phase: 'delivered', reference: 'authenticated-owner-report' }), worker);
  await ctx.apply('request_ready',
    itemAction(ctx.store, 'build', 'request_ready', { note: 'I own this item.' }), worker);
  assert.equal(itemOf(ctx.store).readiness, 'ready_requested');
  assert.equal(itemOf(ctx.store).readyRequest.actor.id, worker.id);
});

test('published direct-write schema fully discriminates action revisions and value requirements', async t => {
  const { store } = await fixture(t);
  const write = createSwarmDirectTools({ board: store }).find(entry => entry.definition.name === 'blackice_swarm_write');
  const spec = write.definition.inputSchema;
  assert.ok(Array.isArray(spec.oneOf) && spec.oneOf.length >= SWARM_ACTION_NAMES.length,
    'discoverable per-action oneOf variants, including state-specific variants');
  const mk = (action, value, extra = {}) =>
    ({ requestId: 'schema_request', mutationId: 'schema_mutation', action, ...extra, value });
  const byProject = { projectId: 'project_one', expectedProjectRevision: 1 };
  const byItem = { projectId: 'project_one', itemId: 'item_one', expectedItemRevision: 1 };
  const valid = [
    mk('create_project', { id: 'project_one', name: 'One', objective: 'Explicit scope.' }),
    mk('edit_project', { name: 'Revised' }, byProject),
    mk('register_worker', { id: 'worker_one', label: 'Worker', scope: 'One file.', actorId: 'oauth_grant_one' }, byProject),
    mk('propose_item', { id: 'item_one', title: 'Proof', scope: 'One file.', requirements: 'Unit check',
      ownerId: null, dependsOn: [], verificationTarget: 'unit' }, byProject),
    mk('edit_item', { requirements: 'Revised check' }, byItem),
    mk('transition', { phase: 'queued' }, byItem),
    mk('transition', { phase: 'delivered', reference: 'external-receipt' }, byItem),
    mk('record_source', { id: 'source_one', text: 'Payload A' }, byProject),
    mk('record_source', { id: 'source_one', text: 'Payload B' },
      { projectId: 'project_one', expectedSourceRevision: 1 }),
    mk('record_evidence', { id: 'evidence_one', claim: 'Build succeeds', epistemic: 'observed',
      authority: 'unit', outcome: 'pass', sourceId: 'source_one', sourceRevision: 1,
      requirementRevision: 1 }, { projectId: 'project_one', itemId: 'item_one' }),
    mk('resolve_failure', { evidenceId: 'failed_one', replacementId: 'passed_two', reason: 'New proof.' },
      { projectId: 'project_one', itemId: 'item_one' }),
    mk('request_ready', { note: 'Request, not approval.' }, byItem),
    mk('decide_ready', { disposition: 'approved', reason: 'Current comparable reported proof.',
      evidenceIds: ['evidence_one'] }, byItem),
    mk('decide_ready', { disposition: 'blocked', reason: 'Specific blocking evidence.' }, byItem),
    mk('record_integration', { status: 'recorded', reference: 'commit_123' }, byItem),
    mk('record_integration', { status: 'proposed' }, byItem),
  ];
  assert.deepEqual([...new Set(valid.map(args => args.action))].sort(), [...SWARM_ACTION_NAMES].sort());
  for (const args of valid) assert.equal(validDirectArguments(args, spec), true, args.action + ' must validate');
  assert.equal(validDirectArguments({ ...valid[0], expectedItemRevision: 1 }, spec), false,
    'create_project must reject unrelated top-level revision fields');
  assert.equal(validDirectArguments({ ...valid[1], value: {} }, spec), false,
    'edit_project needs at least one field');
  assert.equal(validDirectArguments({ ...valid[3], value: { ...valid[3].value, ownerId: 'worker_one', arbitrary: true } }, spec), false,
    'nested value must reject unsupported keys');
  assert.equal(validDirectArguments({ ...valid[6], value: { phase: 'delivered' } }, spec), false,
    'delivered requires a reference');
  assert.equal(validDirectArguments({ ...valid[7], expectedSourceRevision: 1 }, spec), false,
    'source create and update locks are mutually exclusive');
  assert.equal(validDirectArguments({ ...valid[8], expectedProjectRevision: 1 }, spec), false,
    'source update cannot quietly accept an extra project revision');
  assert.equal(validDirectArguments({ ...valid[12], value: { disposition: 'approved', reason: 'No evidence.' } }, spec), false,
    'approvals require selected evidence IDs');
  assert.equal(validDirectArguments({ ...valid[14], value: { status: 'recorded' } }, spec), false,
    'integration recording requires a reference');
  assert.equal(validDirectArguments({ ...valid[13], expectedProjectRevision: 2 }, spec), false,
    'item decision must not accept project-level optimistic locks');
});

test('nativeContext is not an authenticated Swarm connector grant or a registered native worker adapter', async t => {
  const { store } = await fixture(t);
  const [read, write] = createSwarmDirectTools({ board: store });
  const nativeContext = { runId: 'native_fake', nodeId: 'agent_fake' };
  const observed = JSON.parse((await read.execute({ requestId: 'read_native' }, { nativeContext })).contentItems[0].text);
  assert.equal(observed.self, null);
  assert.equal(observed.identityScope.nativeWorkerToolsRegistered, false);
  await assert.rejects(write.execute({ requestId: 'write_native', mutationId: 'native_mutation',
    action: 'create_project', value: { id: 'native_wrong', name: 'No', objective: 'Not a native binding.' } },
    { nativeContext }), error => error.code === 'SWARM_ACTOR_REQUIRED');
  assert.equal(store.snapshot().projects.length, 0, 'unverified native context had no effects');
});
