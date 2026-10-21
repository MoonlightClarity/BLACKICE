import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Real gateway, OAuth, Settings and durable actions; deliberately NOT a ChatGPT chat-surface test. */
export async function chatGPTConnectorUIJourney({ api, app, runtime, report, cwd, evaluate, until, waitVisible, click, resize, screenshot, geometry, check }) {
  const evidence = report.recovery.chatGPTConnector = { fixtureOnly: true, chatSurfaceVerified: false, modelTurnsBefore: runtime.calls.length };
  const chatDraft = await evaluate(() => document.querySelector('#mission-task').value);
  const controlReady = selector => until('the settled connector control ' + selector, () => evaluate(selector => {
    const node = document.querySelector(selector);
    return Boolean(node && !node.disabled && node.getAttribute('aria-disabled') !== 'true' && node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }));
  }, selector));
  const press = async selector => { await controlReady(selector); await click(selector); };
  const originalFetcher = app.chatGPTOAuth.fetcher;
  app.chatGPTOAuth.fetcher = async url => {
    assert.equal(url, 'https://chatgpt.com/oauth/client.json');
    return new Response(JSON.stringify({ client_id: url, client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], token_endpoint_auth_method: 'private_key_jwt', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), { headers: { 'Content-Type': 'application/json' } });
  };
  await api('/api/remote-access/enable', 'POST', { mode: 'public', confirmPublic: true });
  const remote = app.remoteAccess.status(), endpoint = remote.url + '/mcp/chatgpt';
  const send = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: remote.gateway.port, path: route, method, headers: { Host: new URL(remote.url).host, ...headers } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) req.destroy(Error('Fixture response exceeded its bound.')); else chunks.push(chunk); });
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let value; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, value }); }); res.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(Error('Fixture gateway request timed out.'))); req.on('error', reject); req.end(body);
  });
  let token, serial = 0;
  const rpc = (method, params = {}, authenticated = true) => send('/mcp/chatgpt', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++serial, method, params }) });
  await resize(1440, 900); await click('#workspace-modes [data-mode="configure"]'); await waitVisible('.chatgpt-connector');
  await press('[data-connector-action="refresh"]'); await until('connector Settings readiness', () => evaluate(() => !document.querySelector('[data-connector-action="enable"]').hasAttribute('aria-disabled')));
  await press('[data-connector-action="enable"]'); await until('connector enabled through Settings', async () => (await api('/api/chatgpt-connector')).enabled === true);
  const metadata = await send('/.well-known/oauth-protected-resource/mcp/chatgpt'); assert.equal(metadata.status, 200); assert.equal(metadata.value.resource, endpoint);
  const catalog = await rpc('tools/list', {}, false); assert.equal(catalog.status, 200); assert.ok(catalog.value.result.tools.some(tool => tool.name === 'blackice_direct_status')); assert.ok(!catalog.value.result.tools.some(tool => /start_task|worker|run_agent/.test(tool.name)));
  const challenge = await rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce: 'must-authenticate' } }, false); assert.equal(challenge.value.result.isError, true); assert.ok(challenge.value.result._meta['mcp/www_authenticate']);
  assert.match(challenge.value.result._meta['mcp/www_authenticate'][0], /error="invalid_token"/);
  assert.match(challenge.value.result._meta['mcp/www_authenticate'][0], /error_description="[^"\r\n]+"/);
  check('The real isolated gateway publishes OAuth discovery and direct tools, and challenges unauthenticated execution');
  const verifier = randomBytes(32).toString('base64url'), challengeHash = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({ client_id: 'https://chatgpt.com/oauth/client.json', redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', response_type: 'code', state: 'isolated-ui-state', code_challenge_method: 'S256', code_challenge: challengeHash, resource: endpoint, scope: 'read files:read files:write' });
  const authorization = await send('/chatgpt/oauth/authorize?' + params); assert.equal(authorization.status, 200); assert.match(authorization.text, /consent\.js/);
  const browserCookie = authorization.headers['set-cookie'][0].split(';')[0], request = app.chatGPTOAuth.pending()[0]; assert.ok(request?.id);
  await press('[data-connector-action="refresh"]'); await waitVisible(`[data-connector-request="${request.id}"]`);
  assert.equal(await evaluate(() => document.querySelector('[data-connector-scope="files:write"]').checked), false);
  await click('[data-connector-scope="files:read"]'); await click('[data-connector-scope="files:write"]');
  await evaluate(() => { globalThis.__connectorPermission = document.querySelector('[data-connector-scope="files:write"]'); globalThis.__connectorPermission.focus(); });
  await api('/api/desktop/background', 'POST', {});
  await until('unrelated desktop status update', () => evaluate(() => Boolean(document.querySelector('#desktop-show'))));
  assert.equal(await evaluate(() => document.querySelector('[data-connector-scope="files:write"]') === globalThis.__connectorPermission && document.activeElement === globalThis.__connectorPermission && globalThis.__connectorPermission.checked), true);
  await press(`[data-connector-request="${request.id}"] button[type="submit"]`);
  const poll = await until('the authorized automatic OAuth callback', async () => { const value = await send('/chatgpt/oauth/pending/' + request.id, { headers: { Cookie: browserCookie } }); return value.value?.redirect && value; });
  const callback = new URL(poll.value.redirect); assert.equal(callback.searchParams.get('state'), 'isolated-ui-state'); assert.equal(callback.searchParams.get('iss'), remote.url);
  const exchange = await send('/chatgpt/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'https://chatgpt.com/oauth/client.json', redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code: callback.searchParams.get('code'), code_verifier: verifier, resource: endpoint }).toString() });
  assert.equal(exchange.status, 200); assert.ok(exchange.value.access_token); token = exchange.value.access_token;
  const nonce = 'isolated-ui-' + randomBytes(8).toString('hex'), probe = await rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce } });
  assert.equal(probe.value.result.isError, false); assert.equal(probe.value.result.structuredContent.nonce, nonce); assert.equal(probe.value.result.structuredContent.modelStarted, false); evidence.nonce = nonce;
  check('Settings approves only selected scopes, preserves focused permission controls, and the real PKCE exchange returns a matching authenticated nonce without a model turn');
  const action = await rpc('tools/call', { name: 'blackice_workspace_write', arguments: { requestId: 'connector-ui-write', action: 'write', path: 'connector-proof.txt', text: 'A direct action in disposable QA storage.\n' } });
  const job = action.value.result.structuredContent; assert.notEqual(job.status, 'awaiting_input'); evidence.jobId = job.jobId;
  const completed = await until('the direct write receipt without a local approval prompt', async () => { const value = await rpc('tools/call', { name: 'blackice_get_job', arguments: { jobId: job.jobId } }); const result = value.value?.result?.structuredContent; assert.notEqual(result?.status, 'awaiting_input'); return result?.settled && result; });
  assert.equal(completed.status, 'succeeded'); assert.equal(await fs.readFile(path.join(cwd, 'connector-proof.txt'), 'utf8'), 'A direct action in disposable QA storage.\n');
  await press('[data-connector-action="refresh"]'); assert.equal(await evaluate(() => Boolean(document.querySelector('[data-connector-action="approve-action"]'))), false);
  await screenshot('57-chatgpt-connector-direct-desktop.jpg');
  await resize(390, 844); check('ChatGPT connector permission and status controls remain within the narrow viewport', await geometry('ChatGPT connector mobile')); await screenshot('58-chatgpt-connector-mobile.jpg'); await resize(1440, 900);
  const replay = await rpc('tools/call', { name: 'blackice_workspace_write', arguments: { requestId: 'connector-ui-write', action: 'write', path: 'connector-proof.txt', text: 'A direct action in disposable QA storage.\n' } });
  assert.equal(replay.value.result.structuredContent.jobId, job.jobId); assert.equal(replay.value.result.structuredContent.existing, true);
  check('A concrete write executes without local approval, produces a real durable result, and an identical retry retrieves the same job');
  await press('[data-connector-action="refresh"]'); const grant = app.chatGPTOAuth.status().grants[0]; await waitVisible(`[data-connector-action="revoke"][data-connector-id="${grant.id}"]`); await press(`[data-connector-action="revoke"][data-connector-id="${grant.id}"]`);
  await until('revocation from Settings', () => app.chatGPTOAuth.status().grants.length === 0);
  const revoked = await rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce: 'revoked' } }); assert.equal(revoked.value.result.isError, true);
  await press('[data-connector-action="disable"]'); await until('connector disabled', () => app.chatGPTConnector.enabled === false); await api('/api/remote-access/disable', 'POST', {});
  assert.equal(runtime.calls.length, evidence.modelTurnsBefore); evidence.revoked = true; evidence.modelTurnsAfter = runtime.calls.length;
  app.chatGPTOAuth.fetcher = originalFetcher;
  check('Revocation rejects the old access token and the entire direct connector journey starts no model or provider'); report.features.chatGPTDirectConnector = true;
  await click('#workspace-modes [data-mode="view"]'); await waitVisible('#mission-task');
  assert.equal(await evaluate(() => document.querySelector('#mission-task').value), chatDraft);
}
