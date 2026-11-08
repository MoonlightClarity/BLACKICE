import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ChatGPTConnector } from '../lib/chatgpt-connector.mjs';
import { ChatGPTOAuth, CHATGPT_OAUTH_CLIENT_ID, CHATGPT_OAUTH_SCOPES } from '../lib/chatgpt-oauth.mjs';
import { DirectExecutionAPI } from '../lib/direct-execution-api.mjs';
import { ChatGPTPlanningAPI } from '../lib/chatgpt-planning.mjs';
import { chatGPTFileImportTool } from '../lib/chatgpt-file-import.mjs';
import { createDirectConnectedBrowserTools, createDirectBrowserProfileTools } from '../lib/connected-browser-tools.mjs';
import { createDirectBrowserCredentialTools } from '../lib/browser-credential-tools.mjs';
import { desktopRestartTool } from '../lib/desktop-restart-tool.mjs';

const ORIGIN = 'https://continuity.example';
const RESOURCE = ORIGIN + '/mcp/chatgpt';
const PROTOCOL = '2025-11-25';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-connection-continuity-'));
  const dataDir = path.join(root, 'profile'), workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  let clock = Date.now(), current;
  const unopenedAdapter = () => assert.fail('This connection-continuity fixture must not invoke a native adapter.');

  async function open() {
    const oauth = await new ChatGPTOAuth({ dataDir, origin: ORIGIN, now: () => clock, fetcher: unopenedAdapter }).init();
    const api = await new DirectExecutionAPI({
      dataDir, allowedRoot: workspace,
      authorizeClient: (client, options) => oauth.isAuthorized(client, options),
      additionalTools: [
        chatGPTFileImportTool({ directory: path.join(workspace, 'imports'), download: unopenedAdapter }),
        ...createDirectConnectedBrowserTools({ manager: {}, connectChrome: unopenedAdapter }),
        ...createDirectBrowserProfileTools({ profiles: {}, manager: {} }),
        desktopRestartTool({ restart: { request: unopenedAdapter }, getJob: unopenedAdapter }),
        ...createDirectBrowserCredentialTools({ vault: {}, browser: {}, reauthorize: unopenedAdapter }),
      ],
    }).init();
    const connector = await new ChatGPTConnector({ dataDir, execution: api, planning: new ChatGPTPlanningAPI({}), oauth, version: 'continuity-fixture' }).init();
    connector.setOrigin(ORIGIN);
    const server = createServer((req, res) => {
      connector.handle(req, res).catch(error => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    current = {
      oauth, api, connector, url,
      async close() {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await connector.close();
      },
    };
    return current;
  }

  t.after(async () => {
    await current?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await open();
  await current.connector.setEnabled(true);

  // Seed one owner-approved grant through the real store. Tests start after
  // initial consent and exercise its continued use, rather than fake auth.
  const now = new Date(clock).toISOString();
  const approved = {
    id: randomUUID(), clientId: CHATGPT_OAUTH_CLIENT_ID, label: 'ChatGPT', resource: RESOURCE,
    scopes: [...CHATGPT_OAUTH_SCOPES], createdAt: now, lastUsedAt: now,
    expiresAt: new Date(clock + 30 * 86400000).toISOString(), accessTokens: [], refresh: null,
  };
  const tokens = current.oauth.mint(approved, []);
  await current.oauth.persist([approved]);

  return {
    workspace, tokens, grantId: approved.id,
    get current() { return current; },
    advance(ms) { clock += ms; },
    async reopen() { await current.close(); return open(); },
  };
}

function client(connection, tokens, label) {
  let sequence = 0;
  async function rpc(method, params = {}) {
    const id = `${label}-${++sequence}`;
    const response = await fetch(connection.url + '/mcp/chatgpt', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
        'MCP-Protocol-Version': PROTOCOL, Authorization: 'Bearer ' + tokens.access_token,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const value = await response.json();
    return { status: response.status, headers: response.headers, value, id };
  }
  async function result(method, params = {}) {
    const response = await rpc(method, params);
    assert.equal(response.status, 200, JSON.stringify(response.value));
    assert.equal(response.value.error, undefined);
    assert.equal(response.value.id, response.id);
    return response.value.result;
  }
  return {
    rpc, result,
    async initialize() {
      const initialized = await result('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: label, version: '1' } });
      assert.equal(initialized.protocolVersion, PROTOCOL);
      const notification = await fetch(connection.url + '/mcp/chatgpt', {
        method: 'POST',
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': PROTOCOL, Authorization: 'Bearer ' + tokens.access_token },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.equal(notification.status, 202);
      await notification.text();
    },
    async tool(name, args = {}) {
      const value = await result('tools/call', { name, arguments: args });
      assert.equal(value.isError, false, JSON.stringify(value));
      assert.equal(value._meta?.['mcp/www_authenticate'], undefined);
      return value.structuredContent;
    },
  };
}

async function settle(who, jobId) {
  const deadline = Date.now() + 7000;
  let job;
  do {
    job = await who.tool('blackice_get_job', { jobId });
    assert.notEqual(job.status, 'awaiting_input', 'Existing authorization must not create a local approval interaction.');
    if (job.settled) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.fail(`The authorized job did not settle: ${JSON.stringify(job)}`);
}

async function assertIdentityAndCatalog(who, grantId, catalog, fingerprint) {
  const status = await who.tool('blackice_direct_status', { nonce: 'connection-continuity' });
  assert.equal(status.connectionId, grantId);
  assert.deepEqual(status.grantedScopes, CHATGPT_OAUTH_SCOPES);
  assert.equal(status.localMutationApproval, false);
  assert.equal(status.modelStarted, false);
  assert.equal(status.providerTurns, false);
  assert.deepEqual(status.toolCatalog, fingerprint);
  assert.deepEqual((await who.result('tools/list')).tools, catalog);
}

test('a dynamically registered chat executes direct tools independently and both grants survive refresh and restart', async t => {
  const f = await fixture(t), redirectUri = 'https://chat.mistral.example/oauth/callback';
  const original = client(f.current, f.tokens, 'existing-chatgpt');
  await original.initialize();
  const catalog = (await original.result('tools/list')).tools, fingerprint = f.current.connector.catalogStatus();
  const registrationResponse = await fetch(f.current.url + '/chatgpt/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Independent MCP chat', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  const registration = await registrationResponse.json();
  assert.equal(registrationResponse.status, 201, JSON.stringify(registration));
  assert.equal(f.current.oauth.status().grants.length, 1, 'Registration alone grants no access.');
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: registration.client_id, redirect_uri: redirectUri, response_type: 'code', state: 'independent-chat-consent',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    resource: RESOURCE, scope: CHATGPT_OAUTH_SCOPES.join(' '),
  });
  const authorization = await fetch(f.current.url + '/chatgpt/oauth/authorize?' + params, { redirect: 'manual' });
  assert.equal(authorization.status, 200);
  await authorization.text();
  const cookie = authorization.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Consent remains bound to its browser.');
  const pending = f.current.oauth.status().requests.find(item => item.clientLabel === 'Independent MCP chat');
  assert.ok(pending);
  assert.equal(pending.clientOrigin, 'https://chat.mistral.example');
  await f.current.oauth.approve(pending.id, { scopes: [...CHATGPT_OAUTH_SCOPES] });
  const decisionResponse = await fetch(f.current.url + '/chatgpt/oauth/pending/' + pending.id, { headers: { Cookie: cookie } });
  const decision = await decisionResponse.json();
  assert.equal(decisionResponse.status, 200);
  const code = new URL(decision.redirect).searchParams.get('code');
  assert.ok(code);
  const tokenResponse = await fetch(f.current.url + '/chatgpt/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registration.client_id, redirect_uri: redirectUri, code, code_verifier: verifier, resource: RESOURCE }),
  });
  const registeredTokens = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200, JSON.stringify(registeredTokens));
  const grant = f.current.oauth.status().grants.find(item => item.id !== f.grantId);
  assert.ok(grant);
  assert.equal(grant.kind, 'mcp');
  const independent = client(f.current, registeredTokens, 'registered-chat');
  await independent.initialize();
  await assertIdentityAndCatalog(independent, grant.id, catalog, fingerprint);
  await assertIdentityAndCatalog(original, f.grantId, catalog, fingerprint);
  const nonce = 'independent-provider-proof';
  const proof = await independent.tool('blackice_direct_status', { nonce });
  assert.equal(proof.nonce, nonce);
  assert.equal(proof.modelStarted, false);
  assert.equal(proof.providerTurns, false);
  const request = { requestId: 'registered-chat-write-once', action: 'write', path: 'registered.txt', text: 'A registered chat executed this direct action.' };
  const admitted = await independent.tool('blackice_workspace_write', request);
  assert.equal((await settle(independent, admitted.jobId)).status, 'succeeded');
  assert.equal(await fs.readFile(path.join(f.workspace, request.path), 'utf8'), request.text);

  f.advance(registeredTokens.expires_in * 1000 + 1);
  const refresh = async (clientId, tokens) => {
    const response = await fetch(f.current.url + '/chatgpt/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: RESOURCE }),
    });
    const renewed = await response.json();
    assert.equal(response.status, 200, JSON.stringify(renewed));
    return renewed;
  };
  const registeredRenewed = await refresh(registration.client_id, registeredTokens);
  const originalRenewed = await refresh(CHATGPT_OAUTH_CLIENT_ID, f.tokens);
  await f.reopen();
  assert.equal(f.current.oauth.status().grants.length, 2);
  const restoredIndependent = client(f.current, registeredRenewed, 'registered-after-restart');
  const restoredOriginal = client(f.current, originalRenewed, 'chatgpt-after-restart');
  await assertIdentityAndCatalog(restoredIndependent, grant.id, catalog, fingerprint);
  await assertIdentityAndCatalog(restoredOriginal, f.grantId, catalog, fingerprint);
  assert.equal((await restoredIndependent.tool('blackice_get_job', { jobId: admitted.jobId })).status, 'succeeded');
  const replay = await restoredIndependent.tool('blackice_workspace_write', request);
  assert.equal(replay.existing, true);
  assert.equal(replay.jobId, admitted.jobId);
  const otherOwner = await restoredOriginal.result('tools/call', { name: 'blackice_get_job', arguments: { jobId: admitted.jobId } });
  assert.equal(otherOwner.isError, true, 'A different provider grant cannot read this chat\'s job.');
});

test('independent MCP clients, token renewal and reconstruction retain one grant, the full catalog and completed action identity', async t => {
  const f = await fixture(t);
  const first = client(f.current, f.tokens, 'first-conversation-turn');
  await first.initialize();
  const catalog = (await first.result('tools/list')).tools;
  assert.equal(catalog.length, 30, 'The fixture must exercise the complete desktop catalog.');
  assert.ok(catalog.some(tool => tool.name === 'blackice_task_contract'));
  assert.ok(catalog.some(tool => tool.name === 'blackice_task_context'));
  const fingerprint = f.current.connector.catalogStatus();
  await assertIdentityAndCatalog(first, f.grantId, catalog, fingerprint);

  const request = { requestId: 'write-once-across-connection-lifecycle', action: 'write', path: 'once.txt', text: 'Original authorized write.\n' };
  const admitted = await first.tool('blackice_workspace_write', request);
  assert.equal(admitted.interaction, null);
  const finished = await settle(first, admitted.jobId);
  assert.equal(finished.status, 'succeeded');
  const writtenFile = path.join(f.workspace, request.path);
  assert.equal(await fs.readFile(writtenFile, 'utf8'), request.text);

  // A second writer makes an accidental repeat observable. Returning the same
  // job ID alone would miss a replay that silently overwrote the same bytes.
  const sentinel = 'Changes made after the original action must survive retries.\n';
  await fs.appendFile(writtenFile, sentinel);
  const expectedBytes = request.text + sentinel;

  f.advance(f.tokens.expires_in * 1000 + 1);
  const expired = await first.rpc('tools/call', { name: 'blackice_get_job', arguments: { jobId: admitted.jobId } });
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('www-authenticate'), /error="invalid_token"/);
  assert.equal(expired.value.result, undefined, 'An expired credential uses HTTP renewal, not tool-level linking.');

  const renewedResponse = await fetch(f.current.url + '/chatgpt/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CHATGPT_OAUTH_CLIENT_ID, refresh_token: f.tokens.refresh_token, resource: RESOURCE }),
  });
  const renewed = await renewedResponse.json();
  assert.equal(renewedResponse.status, 200, JSON.stringify(renewed));
  assert.notEqual(renewed.access_token, f.tokens.access_token);
  assert.equal(f.current.oauth.status().grants.length, 1);
  assert.equal(f.current.oauth.status().grants[0].id, f.grantId);

  const second = client(f.current, renewed, 'second-conversation-turn');
  await second.initialize();
  await assertIdentityAndCatalog(second, f.grantId, catalog, fingerprint);
  const replay = await second.tool('blackice_workspace_write', request);
  assert.equal(replay.existing, true);
  assert.equal(replay.jobId, admitted.jobId);
  assert.equal((await second.tool('blackice_get_job', { jobId: replay.jobId })).result.text.text, finished.result.text.text);
  assert.equal(await fs.readFile(writtenFile, 'utf8'), expectedBytes);
  const diagnostics = (await f.current.connector.status()).authDiagnostics;
  assert.equal(diagnostics.invalidBearerChallenges, 1);
  assert.equal(diagnostics.linkingChallenges, 0);
  assert.equal(diagnostics.scopeChallenges, 0);
  assert.equal(diagnostics.authorizationLostChallenges, 0);

  await f.reopen();
  assert.equal(f.current.connector.enabled, true, 'Reconstruction loads the existing enabled state.');
  assert.equal(f.current.oauth.status().grants.length, 1);
  const third = client(f.current, renewed, 'third-turn-after-reconstruction');
  await third.initialize();
  await assertIdentityAndCatalog(third, f.grantId, catalog, fingerprint);
  const retained = await third.tool('blackice_get_job', { jobId: admitted.jobId });
  assert.equal(retained.status, 'succeeded');
  assert.equal(retained.result.text.text, finished.result.text.text);
  const replayAfterRestart = await third.tool('blackice_workspace_write', request);
  assert.equal(replayAfterRestart.existing, true);
  assert.equal(replayAfterRestart.jobId, admitted.jobId);
  assert.equal(await fs.readFile(writtenFile, 'utf8'), expectedBytes);

  const newWork = await third.tool('blackice_workspace_write', { requestId: 'new-work-after-reconstruction', action: 'write', path: 'new.txt', text: 'Existing grant admits new work.' });
  assert.equal(newWork.interaction, null);
  assert.equal((await settle(third, newWork.jobId)).status, 'succeeded');
  assert.equal(await fs.readFile(path.join(f.workspace, 'new.txt'), 'utf8'), 'Existing grant admits new work.');
  await assertIdentityAndCatalog(third, f.grantId, catalog, fingerprint);
});

test('a failing optional connector observer cannot turn an admitted action into a failed tool response', async t => {
  const f = await fixture(t);
  const who = client(f.current, f.tokens, 'observer-failure');
  await who.initialize();
  f.current.connector.onChange = () => { throw new Error('Disposable UI observer is unavailable.'); };
  const request = { requestId: 'write-with-failed-observer', action: 'write', path: 'observer.txt', text: 'The execution receipt remains authoritative.' };
  const admitted = await who.tool('blackice_workspace_write', request);
  assert.equal(admitted.interaction, null);
  assert.equal((await settle(who, admitted.jobId)).status, 'succeeded');
  assert.equal(await fs.readFile(path.join(f.workspace, request.path), 'utf8'), request.text);
  const retry = await who.tool('blackice_workspace_write', request);
  assert.equal(retry.existing, true);
  assert.equal(retry.jobId, admitted.jobId);
  const diagnostics = (await f.current.connector.status()).authDiagnostics;
  assert.equal(diagnostics.linkingChallenges, 0);
  assert.equal(diagnostics.scopeChallenges, 0);
  assert.equal(diagnostics.authorizationLostChallenges, 0);
});
