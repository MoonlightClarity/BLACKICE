import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CHATGPT_OAUTH_CLIENT_ID } from '../lib/chatgpt-oauth.mjs';
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

// No external authorization server, account or installed connector is contacted.
// This fixture places an ephemeral approved grant in the *real* OAuth grant store
// so DirectExecutionAPI.require uses the actual host grant-authorization check.
function ephemeralGrant(app) {
  const oauth = app.chatGPTOAuth;
  if (!oauth.origin) oauth.setOrigin('https://swarm-contract-fixture.invalid');
  const now = new Date().toISOString(), expiresAt = new Date(Date.now() + 60_000).toISOString();
  const grant = { id: randomUUID(), clientId: CHATGPT_OAUTH_CLIENT_ID, label: 'ChatGPT',
    resource: oauth.origin + '/mcp/chatgpt', scopes: ['read','planning:write'],
    createdAt: now, expiresAt, lastUsedAt: now, accessTokens: [],
    refresh: { hash: 'a'.repeat(64), expiresAt, usedHashes: [] } };
  oauth.grants.push(grant);
  app.chatGPTConnector.enabled = true; // isolated harness setting; no external session or persisted consent
  const authenticated = oauth.getClient(grant.id);
  assert.ok(authenticated && authenticated.kind === 'chatgpt', 'getClient admitted the exact fixture grant');
  return authenticated;
}

async function directReceipt(app, client, tool, args) {
  const start = await app.directExecution.call(tool, args, client);
  assert.match(start.jobId, /^direct_[a-f0-9]{64}$/);
  for (let index = 0; index < 200; index++) {
    const saved = await app.directExecution.getJob(start.jobId, client, { limit: 30000 });
    if (saved.settled) return saved;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Direct tool never reached a terminal durable receipt for ' + args.requestId);
}

const savedBody = receipt => receipt.result?.text?.text && JSON.parse(receipt.result.text.text);
test('actual authenticated direct adapter and HTTP actions roundtrip against one ledger; same-grant chats share authority', async t => {
  const { app, call } = await setup(t);
  const grantA = ephemeralGrant(app), grantB = ephemeralGrant(app);
  const chatOne = { ...grantA, label: 'Chat one (same OAuth grant)' };
  const chatTwo = { ...grantA, label: 'Chat two (same OAuth grant)' };
  assert.equal(chatOne.id, chatTwo.id, 'different chats do not create different verified principals');
  assert.notEqual(chatOne.id, grantB.id);
  const advertised = app.directExecution.tools(grantA).find(tool => tool.name === 'blackice_swarm_write');
  assert.ok(advertised?.inputSchema?.oneOf?.length >= 12, 'action shapes are in the actual authenticated tool catalog');
  await assert.rejects(app.directExecution.call('blackice_swarm_write', {
    requestId:'invalid_contract_no_integration_reference', mutationId:'invalid_contract_mutation',
    action:'record_integration', projectId:'no_project', itemId:'no_item',
    expectedItemRevision:1, value:{status:'recorded'},
  }, grantA), error => error.code === 'DIRECT_REQUEST_INVALID',
  'the actual authenticated adapter rejects missing action-specific fields before job admission');

  // HTTP write -> actual authenticated direct adapter read, not merely catalog inspection.
  const httpCreated = await call('/api/swarm/actions','POST', { mutationId:'http_direct_roundtrip',
    action:'create_project', value: { id:'http_direct',name:'HTTP-written', objective:'Must be visible through direct read.' } });
  assert.equal(httpCreated.code, 200);
  const directRead = await directReceipt(app, chatOne, 'blackice_swarm_read',
    { requestId:'swarm_http_to_direct_1', projectId:'http_direct' });
  assert.equal(directRead.status, 'succeeded');
  const directView = savedBody(directRead);
  assert.equal(directView.id, 'http_direct');
  assert.equal(directView.self.id, grantA.id);
  assert.equal(directView.self.identityScope, 'oauth-grant');
  assert.equal(directView.identityScope.individualChatVerified, false);
  assert.equal(directView.identityScope.nativeWorkerToolsRegistered, false);

  // Direct authenticated write -> HTTP read, using the real admitted durable job.
  const created = await directReceipt(app, chatOne, 'blackice_swarm_write', {
    requestId:'swarm_direct_to_http_create_1', mutationId:'swarm_direct_create_1',
    action:'create_project', value: { id:'direct_http', name:'Direct-written',
      objective:'Must be visible through the browser HTTP API.' } });
  assert.equal(created.status, 'succeeded');
  const createdResult = savedBody(created);
  assert.equal(createdResult.project.coordinator.kind, 'connector');
  assert.equal(createdResult.project.coordinator.id, grantA.id);
  assert.equal(createdResult.identityScope.kind, 'oauth-grant');
  const browserRead = await call('/api/swarm/projects/direct_http');
  assert.equal(browserRead.code, 200);
  assert.equal(browserRead.body.coordinator.id, grantA.id);

  const registered = await directReceipt(app, chatOne, 'blackice_swarm_write', {
    requestId:'swarm_register_grant_worker_1', mutationId:'swarm_register_grant_worker_mut',
    action:'register_worker', projectId:'direct_http', expectedProjectRevision:browserRead.body.revision,
    value: { id:'worker_a', label:'Shared-grant worker', kind:'agent',
      actorId:grantA.id, scope:'Same grant controls this record; not isolated chats.' } });
  assert.equal(registered.status, 'succeeded');
  const proposed = await directReceipt(app, chatOne, 'blackice_swarm_write', {
    requestId:'swarm_propose_grant_item_1', mutationId:'swarm_propose_grant_item_mut',
    action:'propose_item', projectId:'direct_http',
    expectedProjectRevision:savedBody(registered).project.revision,
    value:{ id:'item_a', title:'Grant-scoped item', scope:'Bound grant only',
      requirements:'Report request but never infer worker delivery.',ownerId:'worker_a',
      dependsOn:[], verificationTarget:'unit' } });
  assert.equal(proposed.status,'succeeded');

  // A separate chat with the SAME grant may request readiness for the item.
  // This is an explicit missing per-chat boundary, not proof of distinct workers.
  const otherChat = await directReceipt(app, chatTwo, 'blackice_swarm_write', {
    requestId:'swarm_same_grant_chat_two_ready', mutationId:'swarm_same_grant_chat_two_mut',
    action:'request_ready', projectId:'direct_http', itemId:'item_a', expectedItemRevision:1,
    value:{note:'Same grant from a distinct chat can make this worker claim.'} });
  assert.equal(otherChat.status,'succeeded');
  assert.equal(savedBody(otherChat).project.items[0].readyRequest.actor.id, grantA.id);
  const current = await call('/api/swarm/projects/direct_http');
  assert.equal(current.body.items[0].readiness, 'ready_requested');
  assert.equal(current.body.items[0].readyDecision, null, 'request did not approve readiness');

  // Same grant, different transport request ID, identical mutation is deduped.
  const original = { mutationId:'swarm_same_grant_dedupe',action:'record_source', projectId:'direct_http',
    expectedProjectRevision:current.body.revision, value:{id:'source_a', text:'Only one source revision.'} };
  const once = await directReceipt(app, chatOne, 'blackice_swarm_write',
    {requestId:'swarm_same_grant_mutation_a', ...original});
  const twice = await directReceipt(app, chatTwo, 'blackice_swarm_write',
    {requestId:'swarm_same_grant_mutation_b', ...original});
  assert.equal(once.status,'succeeded');
  assert.equal(twice.status,'succeeded');
  assert.equal(savedBody(twice).duplicate,true, 'deduplication is grant-scoped across chats');

  const wrongGrant = await directReceipt(app, grantB, 'blackice_swarm_write', {
    requestId:'swarm_other_grant_cannot_ready', mutationId:'swarm_other_grant_cannot_ready_mut',
    action:'request_ready', projectId:'direct_http', itemId:'item_a',
    expectedItemRevision:current.body.items[0].revision,
    value:{note:'A separate grant cannot impersonate the bound owner.'} });
  assert.equal(wrongGrant.status, 'failed');
  assert.equal(wrongGrant.error.code, 'SWARM_OWNER_REQUIRED');
  const wrongCoordinator = await directReceipt(app, grantB, 'blackice_swarm_write', {
    requestId:'swarm_other_grant_cannot_decide', mutationId:'swarm_other_grant_cannot_decide_mut',
    action:'decide_ready', projectId:'direct_http',itemId:'item_a',
    expectedItemRevision:current.body.items[0].revision,
    value:{disposition:'blocked',reason:'Different grant is not coordinator.'} });
  assert.equal(wrongCoordinator.status,'failed');
  assert.equal(wrongCoordinator.error.code,'SWARM_COORDINATOR_REQUIRED');

  await assert.rejects(app.directExecution.call('blackice_swarm_read',
    {requestId:'swarm_revoked_nonexistent_grant'},
    { ...grantA,id:randomUUID() }), error => error.code === 'DIRECT_AUTH_REQUIRED');
  await assert.rejects(app.directExecution.getJob(created.jobId, grantB),
    error => error.code === 'DIRECT_JOB_NOT_FOUND' || error.status === 404,
    'a different grant cannot read another grant\'s durable job');

  // Source candidate has no Swarm entry in the native agent catalog.
  const nativeCatalog = app.engine.nativePlanningTools?.catalog;
  assert.ok(Array.isArray(nativeCatalog), 'the native Planning registry exists');
  assert.equal(nativeCatalog.some(entry => /swarm/i.test(entry.name)), false,
    'native Swarm worker tool parity remains absent');
});
