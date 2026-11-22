import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatGPTArgs, executeChatGPTCLI, desktopChatGPTArgs } from '../lib/chatgpt-cli.mjs';

test('preparation needs an explicit public choice and selects the requested profile', () => {
  assert.throws(() => parseChatGPTArgs(['chatgpt', 'prepare']), /confirm-public/);
  assert.deepEqual(parseChatGPTArgs(['chatgpt', 'prepare', '--confirm-public', '--profile-dir=C:\\profile']), { command: 'prepare', scopes: [], confirmPublic: true, 'profile-dir': 'C:\\profile' });
  assert.deepEqual(desktopChatGPTArgs(['BLACKICE.exe', 'chatgpt', 'status']), ['chatgpt', 'status']);
});

test('approval requires a matching pending code and offered scopes', async () => {
  const calls = [];
  const connect = async () => ({ request: async (route, body) => {
    calls.push([route, body]);
    return body ? { ok: true } : { oauth: { requests: [{ id: 'request123', displayCode: 'ABCDEF12', scopes: ['read', 'commands:run'] }] } };
  } });
  const options = parseChatGPTArgs(['chatgpt', 'approve', '--code=ABCDEF12', '--scope=read']);
  await executeChatGPTCLI(options, { connect });
  assert.deepEqual(calls[1], ['/api/chatgpt-connector/approve-access', { id: 'request123', scopes: ['read'] }]);
  calls.length = 0;
  await assert.rejects(executeChatGPTCLI({ ...options, scopes: ['files:write'] }, { connect }), /do not match/);
  assert.equal(calls.length, 1);
});

test('prepare selects a separately owned HTTPS 10000 without weakening explicit publication consent', async () => {
  assert.throws(() => parseChatGPTArgs(['chatgpt', 'prepare', '--https-port=10000']), /confirm-public/);
  assert.throws(() => parseChatGPTArgs(['chatgpt', 'prepare', '--confirm-public', '--https-port=10001']), /HTTPS port/);
  assert.throws(() => parseChatGPTArgs(['chatgpt', 'status', '--https-port=10000']), /HTTPS port/);
  const options = parseChatGPTArgs(['chatgpt', 'prepare', '--confirm-public', '--https-port=10000']);
  assert.equal(options.httpsPort, 10000);
  const calls = [];
  const connect = async () => ({ request: async (route, body) => {
    calls.push([route, body]);
    return { enabled: false };
  } });
  await executeChatGPTCLI(options, { connect });
  assert.deepEqual(calls, [['/api/chatgpt-connector/prepare', { confirmPublic: true, httpsPort: 10000 }]]);
});
