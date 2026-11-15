import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

class FakeRuntime extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture', activeTurns: 0 }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { return { output: 'No execution requested.', threadId: 'fixture-thread' }; }
}
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'swarm-http-'));
  const cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const app = await createHarnessServer({ runtime: new FakeRuntime(), port: 0,
    dataDir: path.join(directory, 'data'), defaultCwd: cwd, remoteAccess: null });
  const url = await app.listen({ waitForRemote: false });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const home = await fetch(url + '/next/');
  assert.equal(home.status, 200);
  const cookie = home.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const call = async (route, method = 'GET', value, authenticated = true) => {
    const response = await fetch(url + route, { method,
      headers: { ...(authenticated ? { Cookie: cookie } : {}),
        ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: value === undefined ? undefined : JSON.stringify(value) });
    return { code: response.status, body: await response.json() };
  };
  return { app, url, call, cookie };
}

test('Swarm UI HTTP and direct connector share durable state, auth and revision conflicts', async t => {
  const { app, call } = await setup(t);
  const unauthenticated = await call('/api/swarm', 'GET', undefined, false);
  assert.equal(unauthenticated.code, 401);
  const created = await call('/api/swarm/actions', 'POST', { mutationId: 'http-one', action: 'create_project',
    value: { id: 'http_project', name: 'HTTP Swarm', objective: 'Test real HTTP coordination.' } });
  assert.equal(created.code, 200);
  assert.equal(created.body.project.revision, 1);
  const duplicate = await call('/api/swarm/actions', 'POST', { mutationId: 'http-one', action: 'create_project',
    value: { id: 'http_project', name: 'HTTP Swarm', objective: 'Test real HTTP coordination.' } });
  assert.equal(duplicate.body.duplicate, true);
  const worker = await call('/api/swarm/actions', 'POST', { mutationId: 'http-two',
    projectId: 'http_project', expectedProjectRevision: 1, action: 'register_worker',
    value: { id: 'worker_http', label: 'Reviewer', kind: 'agent', scope: 'Read-only QA.' } });
  assert.equal(worker.code, 200);
  const item = await call('/api/swarm/actions', 'POST', { mutationId: 'http-three',
    projectId: 'http_project', expectedProjectRevision: worker.body.project.revision, action: 'propose_item',
    value: { id: 'qa', title: 'QA', scope: 'Focus UI smoke test', requirements: 'Record an observable result.',
      ownerId: 'worker_http', dependsOn: [], verificationTarget: 'integration' } });
  assert.equal(item.code, 200);
  const stale = await call('/api/swarm/actions', 'POST', { mutationId: 'http-four',
    projectId: 'http_project', itemId: 'qa', expectedItemRevision: 999, action: 'request_ready',
    value: { note: 'Lost update attempt.' } });
  assert.equal(stale.code, 409);
  assert.equal(stale.body.code, 'SWARM_REVISION_CONFLICT');
  const current = await call('/api/swarm/projects/http_project');
  assert.equal(current.code, 200);
  assert.equal(current.body.items[0].readiness, 'not_ready');
  const direct = app.directExecution.tools().find(tool => tool.name === 'blackice_swarm_write');
  assert.ok(direct, 'connector surface advertised alongside HTTP');
  assert.equal(direct.requiredScopes.includes('planning:write'), true);
  const all = await call('/api/swarm');
  assert.equal(all.code, 200);
  assert.equal(all.body.projects.length, 1);
  assert.equal(all.body.projects[0].items[0].phase, 'proposed', 'no automatic dispatch');
});
