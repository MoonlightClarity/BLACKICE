import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { ChatGPTOAuth, CHATGPT_OAUTH_CLIENT_ID, CHATGPT_OAUTH_SCOPES, CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_REDIRECT, oauthApprovalLocation } from '../lib/chatgpt-oauth.mjs';
import { createChatGPTToolCatalog } from '../lib/chatgpt-tool-catalog.mjs';
import { ChatGPTGrantAdmission } from '../lib/chatgpt-grant-admission.mjs';
import { connectorProgress } from '../public/chatgpt-connector-ui.mjs';
import { nativeBrowserPopupHandoff, nativeBrowserPopupReturn } from '../public/next/workspaces/browser-native.mjs';

const origin = 'https://blackice.example.test';
const claudeMetadata = { client_id: CLAUDE_OAUTH_CLIENT_ID, client_name: 'Claude', redirect_uris: [CLAUDE_OAUTH_REDIRECT], token_endpoint_auth_method: 'none' };
async function fixture(t, fetcher = async () => Response.json(claudeMetadata)) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-cross-client-'));
  const oauth = new ChatGPTOAuth({ dataDir, origin, fetcher });
  await oauth.init();
  t.after(async () => { await oauth.close(); await rm(dataDir, { recursive: true, force: true }); });
  return oauth;
}
function grant(clientId, label, requestedScopes = ['read']) {
  const createdAt = new Date(), expiresAt = new Date(createdAt.getTime() + 3600000).toISOString();
  return { id: randomUUID(), clientId, label, resource: origin + '/mcp/chatgpt', scopes: requestedScopes,
    createdAt: createdAt.toISOString(), expiresAt, lastUsedAt: createdAt.toISOString(),
    accessTokens: [], refresh: { hash: randomBytes(32).toString('hex'), expiresAt, usedHashes: [] } };
}

test('Claude, ChatGPT, and Gemini retain independent grants with full BLACKICE tool access', async t => {
  const oauth = await fixture(t);
  const claude = grant(CLAUDE_OAUTH_CLIENT_ID, 'Claude');
  const chatgpt = grant(CHATGPT_OAUTH_CLIENT_ID, 'ChatGPT', [...CHATGPT_OAUTH_SCOPES]);
  const gemini = grant('registered-google-client', 'Google');
  oauth.grants = [claude, chatgpt, gemini];
  for (const item of [claude, chatgpt, gemini]) {
    assert.deepEqual(oauth.getClient(item.id)?.scopes, [...CHATGPT_OAUTH_SCOPES], item.label);
  }
  const admission = new ChatGPTGrantAdmission({
    async authenticateRequest() { return oauth.getClient(claude.id); },
    getClient(id) { return oauth.getClient(id); },
  });
  const actual = await admission.authenticate({ headers: {} }, ['read', 'browser:write', 'commands:run']);
  assert.equal(actual.id, claude.id);
  assert.equal((await admission.revalidate({ headers: {} }, actual, ['browser:write', 'commands:run'])).id, claude.id);
  oauth.revoked.add(claude.id);
  assert.equal(oauth.getClient(claude.id), null);
  assert.ok(oauth.getClient(chatgpt.id), 'ChatGPT must survive Claude revocation');
  assert.ok(oauth.getClient(gemini.id), 'Gemini must survive Claude revocation');
});

test('the entire MCP tool catalog advertises one OAuth transport scope', () => {
  const provider = { tools: () => [
    { name: 'blackice_direct_status', scope: 'read', inputSchema: { type: 'object' } },
    { name: 'blackice_run_command', scope: 'commands:run', inputSchema: { type: 'object' } },
    { name: 'blackice_browser_action', requiredScopes: ['browser:write'], inputSchema: { type: 'object' } },
  ], call: (name, args, client) => ({ name, args, id: client.id }) };
  const catalog = createChatGPTToolCatalog({ providers: [provider], version: 'test' });
  for (const tool of catalog.tools()) {
    assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['read'] }], tool.name);
    assert.deepEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['read'] }]);
  }
  assert.deepEqual(catalog.get('blackice_run_command').requiredScopes, ['read', 'commands:run']);
  assert.equal(catalog.tools().length, 3);
});

test('Claude authorization validates published metadata and points to Claude settings', async t => {
  const oauth = await fixture(t);
  const verified = await oauth.claudeClientMetadata();
  assert.equal(verified.clientId, CLAUDE_OAUTH_CLIENT_ID);
  assert.equal(verified.redirectUri, CLAUDE_OAUTH_REDIRECT);
  const url = '/chatgpt/oauth/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: CLAUDE_OAUTH_CLIENT_ID, redirect_uri: CLAUDE_OAUTH_REDIRECT,
    code_challenge_method: 'S256', code_challenge: randomBytes(32).toString('base64url'),
    state: 'cross-client-fixture', resource: origin + '/mcp/chatgpt', scope: 'read',
  });
  const res = { destroyed: false, status: null, body: '', headers: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = '') { this.body += String(body); },
  };
  await oauth.handle({ method: 'GET', url, headers: {}, rawHeaders: [] }, res, { enabled: true });
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /Settings → Claude connector/);
  assert.match(res.body, /grants access to all BLACKICE MCP tools/);
  assert.doesNotMatch(res.body, /then Settings → ChatGPT connector/);
  assert.equal(oauth.status().requests.at(-1).clientLabel, 'Claude');
  assert.equal(oauthApprovalLocation({ clientId: CHATGPT_OAUTH_CLIENT_ID }), 'Settings → ChatGPT connector');
  assert.equal(oauthApprovalLocation({ clientId: 'google-id', clientLabel: 'Google' }), 'Settings → Gemini connector');
});

test('a forged Claude redirect URL cannot pass published-client validation', async t => {
  const oauth = await fixture(t, async () => Response.json({ ...claudeMetadata, redirect_uris: ['https://attacker.example/callback'] }));
  await assert.rejects(oauth.claudeClientMetadata(), /could not be verified/);
});

test('ChatGPT connector status ignores Claude and Google pending requests', () => {
  const base = { enabled: true, available: true, remoteAccess: { enabled: true, mode: 'public' },
    setup: { ready: true }, oauth: { healthy: true,
      grants: [{ id: 'chatgpt', kind: 'chatgpt', label: 'ChatGPT' }],
      requests: [{ id: 'claude', clientLabel: 'Claude' }] } };
  const state = current => ({ current, loading: false, checking: false, busy: '' });
  assert.equal(connectorProgress(state(base)).key, 'authorized');
  assert.equal(connectorProgress(state({ ...base, oauth: { ...base.oauth, requests: [{ clientLabel: 'Google' }] } })).key, 'authorized');
  assert.equal(connectorProgress(state({ ...base, oauth: { ...base.oauth, requests: [{ clientLabel: 'ChatGPT' }] } })).key, 'approval');
});

test('contained OAuth popup follows its opener and returns when popup closes', () => {
  const opener = { tabId: 'claude', parentTabId: null };
  const popup = { tabId: 'google-popup', parentTabId: 'claude' };
  const unrelated = { tabId: 'other-task', parentTabId: null };
  assert.equal(nativeBrowserPopupHandoff([opener, unrelated], [opener, popup, unrelated], 'claude'), 'google-popup');
  assert.equal(nativeBrowserPopupHandoff([opener, unrelated], [opener, popup, unrelated], 'other-task'), null);
  assert.equal(nativeBrowserPopupReturn([opener, popup, unrelated], [opener, unrelated], 'google-popup'), 'claude');
  assert.equal(nativeBrowserPopupReturn([opener, popup, unrelated], [opener, popup, unrelated], 'google-popup'), null);
});
