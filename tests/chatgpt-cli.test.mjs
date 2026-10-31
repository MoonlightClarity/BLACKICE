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
