import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessServer } from '../server.mjs';
import { AgentEmailStore } from '../lib/agent-email.mjs';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';

class Runtime extends EventEmitter {
  status() { return { connected: true, authenticated: true, models: [{ model: 'organization-fixture' }], defaultModel: 'organization-fixture' }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { throw new Error('Organization acceptance must not start a model turn.'); }
}
class Desktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }
function request(url, route, { method = 'GET', headers = {}, body } = {}) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: url.port, path: route, method, agent: false, headers: { Host: url.host, ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, value, text }); });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Organization fixture HTTP timeout.'))); req.end(encoded);
  });
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-organization-http-')), transport = createRemoteTransportFixture(), remoteAccess = new RemoteAccessManager({ dataDir: directory, transport: transport.transport, defaultHttpsPort: 8443 }); let app, cliCalls = 0;
  t.after(async () => { try { await app?.close(); assert.equal(cliCalls, 0); } finally { await rm(directory, { recursive: true, force: true }); } });
  const email = await new AgentEmailStore({ dataDir: directory, runner: async () => { cliCalls++; throw new Error('No mail CLI is allowed in this fixture.'); } }).init();
  app = await createHarnessServer({ port: 0, dataDir: directory, defaultCwd: directory, runtime: new Runtime(), desktop: new Desktop(), email, remoteAccess, autoAttachDesktop: false }); await app.learning.updateSettings({ mode: 'manual' });
  for (const id of ['active-plan', 'archived-plan']) {
    await app.tasks.ensure({ taskId: id, runId: id, cwd: directory, goal: `Goal for ${id}`, defaultPlan: true });
    await app.conversations.capture({ id, taskId: id, input: `Original ${id}`, status: 'completed', settled: true, createdAt: new Date().toISOString(), workflow: { nodes: [{ id: 'agent', type: 'agent' }], edges: [] }, nodes: { agent: { status: 'completed', output: 'Saved fixture result.' } }, events: [] });
  }
  await app.conversations.setState('archived-plan', 'archived');
  const url = new URL(await app.listen()), page = await request(url, '/'), cookie = page.headers['set-cookie'][0].split(';')[0];
  const local = (route, { authenticated = true, headers = {}, ...options } = {}) => request(url, route, { ...options, headers: { ...(authenticated ? { Cookie: cookie } : {}), ...headers } });
  return { app, local, remoteAccess, directory };
}

test('organization HTTP routes preserve plan bytes and expose default-active, names, groups and actionable CAS conflicts', async t => {
  const { app, local } = await fixture(t), body = { expectedRevision: 0, operations: [{ type: 'create_group', id: 'delivery', name: 'Delivery' }, { type: 'update_plan', taskId: 'active-plan', name: 'A renamed plan', groupId: 'delivery' }] }, before = await readFile(app.tasks.file('active-plan'));
  assert.equal((await local('/api/planning/organization', { method: 'POST', body, authenticated: false })).status, 401);
  assert.equal((await local('/api/planning/organization', { method: 'POST', body, headers: { Origin: 'https://unrelated.example' } })).status, 403);
  const initial = await local('/api/planning'); assert.equal(initial.status, 200); assert.deepEqual(initial.value.plans.map(item => item.taskId), ['active-plan']); assert.equal(initial.value.organization.revision, 0);
  const saved = await local('/api/planning/organization', { method: 'POST', body }); assert.equal(saved.status, 200, saved.text); assert.equal(saved.value.revision, 1); assert.deepEqual(saved.value.createdGroupIds, ['delivery']);
  assert.deepEqual(await readFile(app.tasks.file('active-plan')), before);
  const stale = await local('/api/planning/organization', { method: 'POST', body }); assert.equal(stale.status, 409); assert.equal(stale.value.code, 'PLANNING_ORGANIZATION_CONFLICT'); assert.equal(stale.value.currentRevision, 1);
  const exact = await local('/api/planning?taskId=active-plan&groupId=delivery&query=renamed'); assert.equal(exact.value.plans[0].title, 'A renamed plan'); assert.equal(exact.value.plans[0].groupName, 'Delivery'); assert.equal(exact.value.plans[0].organizationRevision, 1);
  assert.equal((await local('/api/planning?state=archived')).value.plans[0].taskId, 'archived-plan');
  assert.equal((await local('/api/planning?taskId=active-plan&taskId=archived-plan')).status, 400);
  const snapshot = await local('/api/planning/organization'); assert.equal(snapshot.value.plans[0].name, 'A renamed plan');
});

test('Swarms HTTP responses share group metadata and archived projects require explicit restore before execution', async t => {
  const { app, local, directory } = await fixture(t);
  const created = await local('/api/projects', { method: 'POST', body: { name: 'Saved project', objective: 'Check a local result.', cwd: directory, tasks: [{ id: 'build', title: 'Build', instructions: 'Make the requested change.', acceptanceCriteria: ['The fixture check passes.'] }] } });
  assert.equal(created.status, 201, created.text); assert.equal(created.value.archived, false); assert.equal(created.value.organizationRevision, 0); const id = created.value.id, before = await readFile(app.projects.file);
  const saved = await local('/api/planning/organization', { method: 'POST', body: { expectedRevision: 0, operations: [{ type: 'create_group', id: 'research', name: 'Research' }, { type: 'update_project', projectId: id, groupId: 'research', archived: true }] } }); assert.equal(saved.status, 200, saved.text); assert.deepEqual(await readFile(app.projects.file), before);
  const snapshot = await local('/api/projects'); assert.equal(snapshot.value.organization.revision, 1); assert.equal(snapshot.value.projects[0].groupName, 'Research'); assert.equal(snapshot.value.projects[0].archived, true);
  for (const action of ['start', 'retry-task', 'review-task']) { const rejected = await local(`/api/projects/${id}/${action}`, { method: 'POST', body: { taskId: 'build' } }); assert.equal(rejected.status, 409, rejected.text); assert.match(rejected.value.error, /Restore.*Archive/); }
  const renamed = await local(`/api/projects/${id}`, { method: 'PUT', body: { expectedRevision: created.value.revision, name: 'Renamed project' } }); assert.equal(renamed.status, 200); assert.equal(renamed.value.name, 'Renamed project'); assert.equal(renamed.value.groupId, 'research'); assert.equal(renamed.value.archived, true);
  assert.equal((await local('/api/planning/organization', { method: 'POST', body: { expectedRevision: 1, operations: [{ type: 'update_project', projectId: id, archived: false }] } })).status, 200);
  const restored = await local(`/api/projects/${id}`); assert.equal(restored.value.archived, false); assert.equal(restored.value.groupId, 'research'); assert.equal(restored.value.tasks[0].id, 'build'); assert.equal(app.engine.listRuns().length, 0);
});

test('paired browser organization writes retain verified identity and machine catalog reads share saved names', async t => {
  const { app, local, remoteAccess } = await fixture(t); await remoteAccess.enable();
  const publicUrl = new URL(remoteAccess.status().url), url = { host: publicUrl.host, port: remoteAccess.gateway.port }, issued = remoteAccess.pair();
  const paired = await request(url, '/remote/pair', { method: 'POST', headers: { Origin: publicUrl.origin }, body: { code: issued.code, label: 'Paired planning editor' } }); assert.equal(paired.status, 200, paired.text);
  const headers = { Cookie: paired.headers['set-cookie'][0].split(';')[0], Origin: publicUrl.origin };
  const saved = await request(url, '/api/planning/organization', { method: 'POST', headers, body: { expectedRevision: 0, operations: [{ type: 'update_plan', taskId: 'active-plan', name: 'Paired title' }] } }); assert.equal(saved.status, 200, saved.text);
  const state = await app.planningOrganization.get(); assert.equal(state.provenance.actor.type, 'human-client'); assert.equal(state.provenance.actor.id, paired.value.device.id); assert.equal(state.provenance.actor.name, 'Paired planning editor');
  const catalog = await request(url, '/api/agent/tasks', { headers }); assert.equal(catalog.status, 200, catalog.text); assert.equal(catalog.value.plans[0].title, 'Paired title'); assert.equal(catalog.value.plans.length, 1);
  assert.equal((await local('/api/planning/organization', { method: 'POST', body: { expectedRevision: 1, actor: { id: 'forged' }, operations: [{ type: 'create_group', name: 'Rejected' }] } })).status, 400);
});
