import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PlanningOrganizationStore } from '../lib/planning-organization.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { ProjectStore } from '../lib/projects.mjs';
import { planningQuery, listPlanningWorkspace, editPlanningOrganization, projectPlanningWorkspace, guardArchivedProjectExecution } from '../lib/planning-workspace.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-planning-organization-')), cwd = path.join(directory, 'work'); await fs.mkdir(cwd);
  const planningOrganization = await new PlanningOrganizationStore({ dataDir: directory }).init(), stores = [planningOrganization], tasks = await new TaskStateStore({ dataDir: directory }).init();
  const entries = ['a', 'b', 'c', 'd'].map((taskId, index) => ({ id: taskId, taskId, title: `Original ${taskId}`, latestRunId: taskId, state: ['active', 'active', 'archived', 'deleted'][index], status: 'completed', updatedAt: new Date(1000 + index).toISOString() }));
  for (const item of entries) await tasks.ensure({ taskId: item.taskId, runId: item.id, cwd, goal: `Saved goal ${item.taskId}`, defaultPlan: true });
  const engine = new EventEmitter(); engine.runs = new Map(); engine.executions = new Map(); engine.listRuns = () => structuredClone([...engine.runs.values()]); engine.startRun = () => { throw new Error('This organization fixture never starts model work.'); };
  const projects = await new ProjectStore({ dataDir: directory, engine }).init(); clearTimeout(projects.timer); projects.timer = null; projects.kick = () => {};
  guardArchivedProjectExecution(projects, planningOrganization);
  const context = { directory, cwd, planningOrganization, tasks, projects, engine, entries, stores, events: [], conversations: { list: () => structuredClone(entries), status: () => ({ healthy: true }) } }; context.onUpdated = event => context.events.push(event);
  t.after(async () => { await projects.close(); await tasks.close(); await Promise.all(stores.map(store => store.close())); await fs.rm(directory, { recursive: true, force: true }); });
  context.edit = async operations => editPlanningOrganization(context, { expectedRevision: (await planningOrganization.get()).revision, operations });
  context.createProject = () => projects.create({ name: 'Original project', objective: 'Produce a checked result.', cwd, tasks: [{ id: 'build', title: 'Build the result', instructions: 'Implement the requested change.', acceptanceCriteria: ['The requested check passes.'], dependsOn: [] }] });
  return context;
}

test('legacy plans default to active and ungrouped without rewriting their saved documents', async t => {
  const c = await fixture(t), before = await fs.readFile(c.tasks.file('a'));
  const result = await listPlanningWorkspace(c, planningQuery(new URLSearchParams()));
  assert.deepEqual(new Set(result.plans.map(item => item.taskId)), new Set(['a', 'b']));
  assert.equal(result.organization.revision, 0); assert.equal(result.plans.find(item => item.taskId === 'a').title, 'Original a');
  assert.equal(result.plans[0].groupId, null); assert.deepEqual(await fs.readFile(c.tasks.file('a')), before);
  await assert.rejects(fs.stat(c.planningOrganization.file), { code: 'ENOENT' });
  assert.equal((await listPlanningWorkspace(c, planningQuery(new URLSearchParams('state=archived')))).plans[0].taskId, 'c');
});

test('names, shared group assignments and removal survive restart without changing task revisions or hierarchy', async t => {
  const c = await fixture(t), initial = await c.tasks.get('a');
  const state = await c.tasks.editPlan('a', { operations: [{ type: 'add', step: { id: 'section', title: 'Research', kind: 'sequence', parentId: null } }, { type: 'add', step: { id: 'check', title: 'Check the input', parentId: 'section', doneWhen: 'The input is recorded and checked.' } }] }, { expectedRevision: initial.revision, source: 'human' });
  const before = await fs.readFile(c.tasks.file('a')), project = await c.createProject();
  const saved = await c.edit([{ type: 'create_group', id: 'client', name: ' Client work ' }, { type: 'update_plan', taskId: 'a', name: ' Client research ', groupId: 'client' }, { type: 'update_project', projectId: project.id, groupId: 'client' }]);
  assert.deepEqual(saved.createdGroupIds, ['client']); assert.deepEqual(saved.taskIds, ['a']); assert.equal(saved.healthy, true);
  const reopened = await new PlanningOrganizationStore({ dataDir: c.directory }).init(); c.stores.push(reopened);
  const read = await reopened.get(); assert.equal(read.revision, 1); assert.equal(read.plans[0].name, 'Client research');
  assert.deepEqual(await fs.readFile(c.tasks.file('a')), before); assert.equal((await c.tasks.get('a')).revision, state.revision); assert.equal(c.projects.get(project.id).revision, project.revision);
  const catalog = await listPlanningWorkspace({ ...c, planningOrganization: reopened }, planningQuery(new URLSearchParams('groupId=client')));
  assert.equal(catalog.plans[0].title, 'Client research'); assert.equal(catalog.plans[0].conversationTitle, 'Original a'); assert.equal(catalog.organization.groups[0].planCount, 1);
  const projects = await projectPlanningWorkspace(c); assert.equal(projects.projects[0].groupName, 'Client work'); assert.equal(projects.projects[0].name, 'Original project');
  await c.edit([{ type: 'rename_group', groupId: 'client', name: 'Delivered work' }, { type: 'remove_group', groupId: 'client' }]);
  const removed = await reopened.get(); assert.equal(removed.plans[0].name, 'Client research'); assert.equal(removed.plans[0].groupId, null); assert.equal(removed.projects.length, 0); assert.deepEqual(await fs.readFile(c.tasks.file('a')), before);
  await c.edit([{ type: 'update_plan', taskId: 'a', name: null }]); assert.deepEqual((await reopened.get()).plans, []);
});

test('metadata search and group or exact task filters apply before real catalog pagination and respect Archive', async t => {
  const c = await fixture(t);
  await c.edit([{ type: 'create_group', id: 'alpha', name: 'Alpha research' }, { type: 'update_plan', taskId: 'a', name: 'Rare titled plan', groupId: 'alpha' }, { type: 'update_plan', taskId: 'c', name: 'Archived titled plan', groupId: 'alpha' }]);
  for (const query of ['query=Rare&limit=1', 'query=Alpha&limit=1', 'groupId=alpha&limit=1']) {
    const result = await listPlanningWorkspace(c, planningQuery(new URLSearchParams(query))); assert.equal(result.total, 1); assert.equal(result.plans[0].taskId, 'a'); assert.equal(result.hasMore, false); assert.equal(result.organization.groups[0].planCount, 1);
  }
  const ungrouped = await listPlanningWorkspace(c, planningQuery(new URLSearchParams('groupId=ungrouped'))); assert.deepEqual(ungrouped.plans.map(item => item.taskId), ['b']);
  const exact = await listPlanningWorkspace(c, planningQuery(new URLSearchParams('state=all&taskId=c'))); assert.equal(exact.plans[0].title, 'Archived titled plan'); assert.equal(exact.plans[0].bucket, 'archived');
  assert.equal((await listPlanningWorkspace(c, planningQuery(new URLSearchParams('taskId=c')))).total, 0);
  assert.equal((await listPlanningWorkspace(c, planningQuery(new URLSearchParams('taskId=d&state=all')))).total, 0);
  for (const query of ['groupId=', 'groupId=../a', 'taskId=a&taskId=b', 'taskId=' + 'a'.repeat(121)]) assert.throws(() => planningQuery(new URLSearchParams(query)), { status: 400 });
});

test('two actual organization stores enforce CAS without overwriting a concurrent winner', async t => {
  const c = await fixture(t), other = await new PlanningOrganizationStore({ dataDir: c.directory }).init(); c.stores.push(other);
  const results = await Promise.allSettled([c.planningOrganization.edit({ expectedRevision: 0, operations: [{ type: 'create_group', id: 'one', name: 'One' }] }), other.edit({ expectedRevision: 0, operations: [{ type: 'create_group', id: 'two', name: 'Two' }] })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1); const conflict = results.find(item => item.status === 'rejected').reason;
  assert.equal(conflict.code, 'PLANNING_ORGANIZATION_CONFLICT'); assert.equal(conflict.currentRevision, 1); assert.equal((await other.get()).groups.length, 1);
});

test('separate writer processes serialize the same revision through the on-disk organization lock', async t => {
  const c = await fixture(t), run = promisify(execFile), moduleURL = new URL('../lib/planning-organization.mjs', import.meta.url).href;
  const code = `import {PlanningOrganizationStore} from ${JSON.stringify(moduleURL)}; import {writeFile} from 'node:fs/promises';
    const store = await new PlanningOrganizationStore({dataDir:process.argv[1]}).init();
    try { const result = await store.edit({expectedRevision:0,operations:[{type:'create_group',id:process.argv[2],name:process.argv[2]}]}, {validateTargets:()=>new Promise(resolve=>setTimeout(resolve,40))}); await writeFile(process.argv[3],JSON.stringify({revision:result.revision,id:result.createdGroupIds[0]})); }
    catch(error) { await writeFile(process.argv[3],JSON.stringify({code:error.code,currentRevision:error.currentRevision})); }
    finally { await store.close(); }`;
  const results = await Promise.all(['process-a', 'process-b'].map(async group => { const output = path.join(c.directory, `${group}-result.json`); await run(process.execPath, ['--input-type=module', '--eval', code, c.directory, group, output], { timeout: 5000 }); return JSON.parse(await fs.readFile(output, 'utf8')); }));
  assert.equal(results.filter(result => result.revision === 1).length, 1); assert.equal(results.filter(result => result.code === 'PLANNING_ORGANIZATION_CONFLICT' && result.currentRevision === 1).length, 1);
  assert.equal((await c.planningOrganization.get()).groups.length, 1); await assert.rejects(fs.stat(`${c.planningOrganization.file}.lock`), { code: 'ENOENT' });
});

test('imported plans without assignments stay usable and unavailable old assignments remain preserved', async t => {
  const c = await fixture(t);
  await c.planningOrganization.edit({ expectedRevision: 0, operations: [{ type: 'create_group', id: 'history', name: 'Imported history' }, { type: 'update_plan', taskId: 'not-imported-yet', name: 'Preserved previous title', groupId: 'history' }, { type: 'update_project', projectId: 'not-imported-project', groupId: 'history', archived: true }] });
  const before = await c.planningOrganization.get(), catalog = await listPlanningWorkspace(c, planningQuery(new URLSearchParams()));
  assert.equal(catalog.healthy, true); assert.equal(catalog.plans.length, 2); assert.ok(catalog.plans.every(plan => plan.groupId === null)); assert.equal(catalog.organization.groups[0].planCount, 0);
  await c.edit([{ type: 'update_plan', taskId: 'a', name: 'A new available plan title' }]);
  const after = await c.planningOrganization.get(); assert.deepEqual(after.plans.find(item => item.taskId === 'not-imported-yet'), before.plans[0]); assert.deepEqual(after.projects, before.projects);
});

test('organization edits and worker plan progress keep independent revisions and preserve both results', async t => {
  const c = await fixture(t), state = await c.tasks.get('a');
  const results = await Promise.all([c.edit([{ type: 'update_plan', taskId: 'a', name: 'Named by the human' }]), c.tasks.editPlan('a', { operations: [{ type: 'metadata', patch: { goal: 'The worker has refined the goal.' } }] }, { expectedRevision: state.revision, source: 'human' })]);
  assert.equal(results[0].revision, 1); assert.equal(results[1].revision, state.revision + 1);
  const saved = (await listPlanningWorkspace(c, planningQuery(new URLSearchParams('taskId=a')))).plans[0]; assert.equal(saved.title, 'Named by the human'); assert.equal(saved.goal, 'The worker has refined the goal.'); assert.equal(saved.revision, results[1].revision);
});

test('invalid, missing and read-only targets reject the entire organization batch before publication', async t => {
  const c = await fixture(t); await c.edit([{ type: 'create_group', id: 'one', name: 'One' }]); const before = await fs.readFile(c.planningOrganization.file);
  for (const operations of [
    [{ type: 'create_group', id: 'two', name: 'one' }], [{ type: 'create_group', id: 'ungrouped', name: 'Reserved' }], [{ type: 'create_group', id: 'all', name: 'Reserved' }], [{ type: '__proto__' }],
    [{ type: 'update_plan', taskId: 'a', name: '' }], [{ type: 'update_plan', taskId: 'a', name: 'A\nB' }], [{ type: 'update_plan', taskId: 'a', groupId: 'missing' }],
    [{ type: 'rename_group', groupId: 'one', name: 'Changed' }, { type: 'update_plan', taskId: 'missing', name: 'Missing' }],
    [{ type: 'update_plan', taskId: 'd', name: 'Deleted' }], [{ type: 'update_project', projectId: 'missing', archived: true }], [{ type: 'update_plan', taskId: 'a', archived: true }],
  ]) { await assert.rejects(c.edit(operations)); assert.deepEqual(await fs.readFile(c.planningOrganization.file), before); }
  assert.equal(c.events.length, 1);
});

test('a queued request is frozen before waiting for another metadata writer', async t => {
  const c = await fixture(t), entered = deferred(), release = deferred();
  const holding = c.planningOrganization.withState(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const request = { expectedRevision: 0, operations: [{ type: 'create_group', id: 'fixed', name: 'Original name' }] }, pending = c.planningOrganization.edit(request); request.operations[0].name = 'Mutated name'; release.resolve(); await holding; await pending;
  assert.equal((await c.planningOrganization.get()).groups[0].name, 'Original name');
});

test('publication failure or cancellation preserves the last committed organization and emits no success', async t => {
  const c = await fixture(t); await c.edit([{ type: 'create_group', id: 'one', name: 'One' }]); const before = await fs.readFile(c.planningOrganization.file);
  const failing = new PlanningOrganizationStore({ dataDir: c.directory, io: { ...fs, rename: async (from, to) => { if (to === c.planningOrganization.file) throw Object.assign(new Error('Fixture disk failure.'), { code: 'EIO' }); return fs.rename(from, to); } } }); c.stores.push(failing);
  await assert.rejects(editPlanningOrganization({ ...c, planningOrganization: failing }, { expectedRevision: 1, operations: [{ type: 'rename_group', groupId: 'one', name: 'Not committed' }] }), { code: 'EIO' });
  assert.deepEqual(await fs.readFile(c.planningOrganization.file), before); assert.equal(c.events.length, 1);
  const abort = new AbortController(); await assert.rejects(c.planningOrganization.edit({ expectedRevision: 1, operations: [{ type: 'rename_group', groupId: 'one', name: 'Cancelled' }] }, { signal: abort.signal, validateTargets: async () => abort.abort() }), { name: 'AbortError' }); assert.deepEqual(await fs.readFile(c.planningOrganization.file), before);
});

test('damaged organization remains visible as unavailable without overwriting it or hiding task records', async t => {
  const c = await fixture(t); await fs.writeFile(c.planningOrganization.file, '{broken');
  const result = await listPlanningWorkspace(c, planningQuery(new URLSearchParams())); assert.equal(result.healthy, false); assert.equal(result.organization.healthy, false); assert.equal(result.organization.revision, null); assert.equal(result.plans.length, 2);
  await assert.rejects(c.edit([{ type: 'create_group', name: 'Cannot overwrite' }]), { code: 'PLANNING_ORGANIZATION_STORAGE' }); assert.equal(await fs.readFile(c.planningOrganization.file, 'utf8'), '{broken');
});

test('project archive preserves name, revision and task identities, blocks all execution entry points, and restores explicitly', async t => {
  const c = await fixture(t), project = await c.createProject(), before = await fs.readFile(c.projects.file);
  await c.edit([{ type: 'update_project', projectId: project.id, archived: true }]);
  const archived = await projectPlanningWorkspace(c, c.projects.get(project.id)); assert.equal(archived.archived, true); assert.equal(archived.id, project.id); assert.equal(archived.revision, project.revision); assert.deepEqual(await fs.readFile(c.projects.file), before);
  for (const method of ['start', 'retryTask', 'reviewTask']) await assert.rejects(c.projects[method](project.id, 'build'), { code: 'PLANNING_PROJECT_ARCHIVED', status: 409 });
  const renamed = await c.projects.update(project.id, { expectedRevision: project.revision, name: 'Renamed while archived' }); assert.equal(renamed.name, 'Renamed while archived'); assert.deepEqual(renamed.tasks, project.tasks);
  await c.edit([{ type: 'update_project', projectId: project.id, archived: false }]); await c.projects.start(project.id); assert.equal(c.projects.get(project.id).status, 'running');
});

test('archive racing a durable project start waits, then rejects the now-running project', async t => {
  const c = await fixture(t), project = await c.createProject(), entered = deferred(), release = deferred(), save = c.projects.save.bind(c.projects); let held = false;
  c.projects.save = async next => { if (!held && next.projects[0].status === 'running') { held = true; entered.resolve(); await release.promise; } return save(next); };
  const starting = c.projects.start(project.id); await entered.promise;
  const archiving = editPlanningOrganization(c, { expectedRevision: 0, operations: [{ type: 'update_project', projectId: project.id, archived: true }] });
  release.resolve(); await starting; await assert.rejects(archiving, { code: 'PLANNING_PROJECT_ACTIVE' }); assert.equal((await c.planningOrganization.get()).revision, 0);
});

test('a project start racing archive publication waits and cannot enter archived work', async t => {
  const c = await fixture(t), project = await c.createProject(), entered = deferred(), release = deferred(), atomic = c.planningOrganization.atomic.bind(c.planningOrganization); let held = false;
  c.planningOrganization.atomic = async (file, ...args) => { if (!held && file === c.planningOrganization.file) { held = true; entered.resolve(); await release.promise; } return atomic(file, ...args); };
  const archiving = c.edit([{ type: 'update_project', projectId: project.id, archived: true }]); await entered.promise;
  const starting = c.projects.start(project.id); release.resolve(); await archiving; await assert.rejects(starting, { code: 'PLANNING_PROJECT_ARCHIVED' }); assert.equal(c.projects.get(project.id).status, 'draft');
});

test('paused projects cannot archive an unsettled original run even after the task looks stopped', async t => {
  const c = await fixture(t), project = await c.createProject(), original = c.projects.get.bind(c.projects), task = { ...project.tasks[0], status: 'blocked', attempts: [{ implementation: { requestId: 'original-request', runId: 'original-run', status: 'interrupted' } }] };
  c.projects.get = id => ({ ...original(id), status: 'paused', tasks: [task] });
  c.engine.runs.set('original-run', { id: 'original-run', status: 'cancelled', settled: false, metadata: { clientRequestId: 'original-request' } });
  await assert.rejects(c.edit([{ type: 'update_project', projectId: project.id, archived: true }]), { code: 'PROJECT_ATTEMPT_ACTIVE' });
  c.engine.runs.get('original-run').settled = true; c.engine.executions.set('original-run', true);
  await assert.rejects(c.edit([{ type: 'update_project', projectId: project.id, archived: true }]), { code: 'PROJECT_ATTEMPT_ACTIVE' });
  c.engine.executions.clear(); await c.edit([{ type: 'update_project', projectId: project.id, archived: true }]); assert.equal((await c.planningOrganization.get()).projects[0].archived, true);
});
