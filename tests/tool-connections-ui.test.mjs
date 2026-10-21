import test from 'node:test';
import assert from 'node:assert/strict';
import { toolConnectionPayload } from '../public/tool-connections-ui.mjs';

const local = { name: 'Local files', transport: 'stdio', command: 'node', args: 'server.mjs\nC:\\folder with spaces', timeoutSeconds: '30', enabled: true };

test('local arguments preserve spaces, shell characters and explicit empty arguments literally', () => {
  const value = toolConnectionPayload({ ...local, args: 'server.mjs\r\nC:\\folder with spaces\r\n\r\n$(literal)\r\n', cwd: ' C:\\workspace ' }, { id: 'files' });
  assert.equal(value.id, 'files'); assert.equal(value.command, 'node'); assert.equal(value.cwd, 'C:\\workspace');
  assert.deepEqual(value.args, ['server.mjs', 'C:\\folder with spaces', '', '$(literal)']);
  assert.equal(value.timeoutMs, 30000); assert.equal(value.enabled, true);
});

test('blank secrets are omitted to preserve backend values; explicit empty objects clear them', () => {
  const preserved = toolConnectionPayload({ ...local, env: ' \n', headers: '' }, { id: 'files' });
  assert.equal(Object.hasOwn(preserved, 'env'), false); assert.equal(Object.hasOwn(preserved, 'headers'), false);
  const cleared = toolConnectionPayload({ ...local, env: '{}', headers: ' {} ' }, { id: 'files' });
  assert.deepEqual(cleared.env, {}); assert.deepEqual(cleared.headers, {});
});

test('credentials are explicit text mappings and never copied back from a public connection', () => {
  const value = toolConnectionPayload({ ...local, env: '{"TOKEN":"replacement"}' }, { id: 'files', env: { TOKEN: 'old' }, headers: { Authorization: 'old' }, envKeys: ['TOKEN'] });
  assert.deepEqual(value.env, { TOKEN: 'replacement' }); assert.equal(Object.hasOwn(value, 'headers'), false);
  for (const invalid of ['[]', 'null', '"string"', '{"PORT":3000}', '{bad}']) assert.throws(() => toolConnectionPayload({ ...local, env: invalid }), /Environment variables/);
});

test('HTTP endpoints reject credential, query and non-HTTP destinations before saving', () => {
  const http = { ...local, transport: 'http', url: 'https://tools.example/mcp', command: 'ignored', args: 'ignored', enabled: false };
  const value = toolConnectionPayload(http, { id: 'remote' });
  assert.equal(value.url, 'https://tools.example/mcp'); assert.equal(value.enabled, false);
  assert.equal(Object.hasOwn(value, 'command'), false); assert.equal(Object.hasOwn(value, 'args'), false);
  for (const url of ['file:///C:/secret', 'https://name:secret@tools.example/mcp', 'https://tools.example/mcp?key=secret', 'https://tools.example/mcp#fragment']) assert.throws(() => toolConnectionPayload({ ...http, url }), /HTTP or HTTPS/);
});

test('required executable, name, and bounded whole-second timeouts are actionable', () => {
  assert.throws(() => toolConnectionPayload({ ...local, command: ' ' }), /executable/);
  assert.throws(() => toolConnectionPayload({ ...local, name: '' }), /name/);
  for (const timeoutSeconds of ['', 0, 181, '2.5', 'not-a-number']) assert.throws(() => toolConnectionPayload({ ...local, timeoutSeconds }), /between 1 and 180/);
  assert.equal(toolConnectionPayload({ ...local, timeoutSeconds: '180' }).timeoutMs, 180000);
});
