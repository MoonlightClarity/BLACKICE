import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseConnectionImport } from '../lib/connection-import.mjs';

test('common local and Streamable HTTP server configuration becomes real normalized connections', () => {
  const result = parseConnectionImport({ mcpServers: { 'My Files': { command: 'node', args: ['server.mjs', 'folder with spaces'], cwd: path.resolve('.') }, Search: { type: 'streamable-http', url: 'https://tools.example/mcp', headers: { Authorization: 'Bearer private-value' } } } });
  assert.equal(result.candidates[0].id, 'my-files'); assert.deepEqual(result.candidates[0].args, ['server.mjs', 'folder with spaces']); assert.equal(result.candidates[1].transport, 'http'); assert.equal(result.candidates[1].headers.Authorization, 'Bearer private-value'); assert.equal(result.candidates[0].enabled, true);
});
test('preview never exposes environment/header credentials or command argument values', () => {
  const { candidates, preview, warnings } = parseConnectionImport(JSON.stringify({ mcpServers: { local: { command: 'node', args: ['server.mjs', '--key', 'private-arg'], env: { TOKEN: 'private-env' } }, remote: { url: 'https://tools.example/mcp', headers: { Authorization: 'private-header' } } } }));
  assert.match(JSON.stringify(candidates), /private-env/); assert.doesNotMatch(JSON.stringify({ preview, warnings }), /private-env|private-header|private-arg|server\.mjs/); assert.deepEqual(preview[0].envKeys, ['TOKEN']); assert.equal(preview[0].argumentCount, 3); assert.deepEqual(preview[1].headerNames, ['Authorization']);
});
test('stable IDs do not overwrite existing or colliding imported names and stay within server ID constraints', () => {
  const configuration = { mcpServers: { 'My Files': { command: 'node' }, 'My.Files': { command: 'node' }, '123 helper': { command: 'node' }, '日本語': { command: 'node' }, ['x'.repeat(100)]: { command: 'node' } } };
  const first = parseConnectionImport(configuration, { existingIds: ['my-files', 'my-files-2', 'tools'] }), second = parseConnectionImport(configuration, { existingIds: ['my-files', 'my-files-2', 'tools'] });
  assert.deepEqual(first.candidates.map(item => item.id), second.candidates.map(item => item.id)); assert.equal(first.candidates[0].id, 'my-files-3'); assert.equal(first.candidates[1].id, 'my-files-4'); for (const entry of first.candidates) assert.match(entry.id, /^[a-z][a-z0-9_-]{0,39}$/); assert.equal(new Set(first.candidates.map(item => item.id)).size, 5);
});
test('Relay arrays preserve enabled state and allocate new IDs when an explicit ID is already used', () => {
  const result = parseConnectionImport({ connections: [{ id: 'files', name: 'Files', transport: 'stdio', command: 'node', args: [], enabled: false }, { name: 'Remote', transport: 'http', url: 'http://127.0.0.1:8080/mcp' }] }, { existingIds: ['files'] });
  assert.equal(result.candidates[0].id, 'files-2'); assert.equal(result.candidates[0].enabled, false); assert.equal(result.candidates[1].transport, 'http');
  assert.equal(parseConnectionImport({ mcpServers: { disabled: { command: 'node', disabled: true } } }).candidates[0].enabled, false);
});
test('unsupported SSE, OAuth, invalid maps, ambiguous transports and malformed JSON fail before applying', () => {
  for (const config of [{ type: 'sse', url: 'https://tools.example/sse' }, { url: 'https://tools.example/sse' }, { url: 'https://tools.example/mcp', oauth: {} }, { url: 'https://tools.example/mcp', auth: { type: 'oauth' } }, { command: 'node', url: 'https://tools.example/mcp' }, { command: 'node', args: 'server.mjs' }, { command: 'node', env: { PORT: 3000 } }, { url: 'https://tools.example/mcp', headers: { Authorization: 'bad\nheader' } }]) assert.throws(() => parseConnectionImport({ mcpServers: { bad: config } }));
  assert.throws(() => parseConnectionImport('{"env":"secret-value",}'), error => !error.message.includes('secret-value') && /not valid JSON/.test(error.message));
  assert.throws(() => parseConnectionImport({ mcpServers: {}, connections: [] }), /one format/);
  assert.throws(() => parseConnectionImport({ mcpServers: {} }), /no tool servers/);
});
test('all candidates are validated first and total capacity is enforced', () => {
  assert.throws(() => parseConnectionImport({ mcpServers: { good: { command: 'node' }, bad: { url: 'file:///secret' } } }), /bad:/);
  assert.throws(() => parseConnectionImport({ mcpServers: { first: { command: 'node' }, second: { command: 'node' } } }, { existingIds: Array.from({ length: 39 }, (_, index) => `existing-${index}`) }), /1 more fit/);
});
test('encrypted credentials and auto-start settings are represented honestly without returning their contents', () => {
  const { candidates, preview, warnings } = parseConnectionImport({ connections: [{ name: 'Imported', command: 'node', autoStart: true, secret: { data: 'opaque-secret' }, envKeys: ['TOKEN'] }] });
  assert.equal(candidates[0].secret, undefined); assert.doesNotMatch(JSON.stringify(preview), /opaque-secret/); assert.equal(warnings.length, 2); assert.match(warnings[0], /credentials were not imported/); assert.match(warnings[1], /on demand/);
});
