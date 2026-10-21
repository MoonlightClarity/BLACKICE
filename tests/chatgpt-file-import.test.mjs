import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { publicFileAddress, validateChatGPTDownloadURL, downloadChatGPTFile, chatGPTFileImportTool } from '../lib/chatgpt-file-import.mjs';

test('file imports reject private, reserved, mapped and tunnelling addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '172.16.4.5', '192.168.1.2', '192.0.2.1', '198.18.0.1', '203.0.113.4', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::', '2001:0::1']) assert.equal(publicFileAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicFileAddress(address), true, address);
  for (const value of ['http://files.example/file', 'https://127.0.0.1/file', 'https://user:secret@files.example/file', 'https://files.example:8443/file', 'https://files.example/file#token']) assert.throws(() => validateChatGPTDownloadURL(value));
});

test('a mixed public/private DNS answer is rejected before any request', async () => {
  let requests = 0;
  await assert.rejects(downloadChatGPTFile('https://files.example/file', { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], request: () => { requests++; } }), { code: 'CHATGPT_FILE_ADDRESS_BLOCKED' });
  assert.equal(requests, 0);
});

test('download sockets use pinned public DNS and never forward credentials or follow redirects', async () => {
  let captured;
  const request = (url, options, callback) => {
    captured = { url, options }; const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => { const response = new EventEmitter(); Object.assign(response, { statusCode: 302, headers: { location: 'http://127.0.0.1/private' }, resume() {}, destroy() {} }); callback(response); });
    return req;
  };
  await assert.rejects(downloadChatGPTFile('https://files.example/signed?token=secret', { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request }), { code: 'CHATGPT_FILE_DOWNLOAD_REJECTED' });
  assert.equal(captured.options.agent, false); assert.equal(captured.options.headers.Authorization, undefined);
  const resolved = await new Promise((resolve, reject) => captured.options.lookup('files.example', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(resolved, { address: '8.8.8.8', family: 4 });
});

test('a selected file is imported once with a matching hash and no signed URL in durable arguments', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-file-import-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tool = chatGPTFileImportTool({ directory, download: async () => Buffer.from('hello') });
  const args = { requestId: 'first', file: { file_id: 'file_test', file_name: '../../hello.txt', download_url: 'https://files.example/input?token=secret' } };
  assert.deepEqual(tool.definition._meta['openai/fileParams'], ['file']);
  const durable = tool.durableArguments(args); assert.doesNotMatch(JSON.stringify(durable), /secret|download_url/); assert.equal(durable.sourceOrigin, 'https://files.example');
  const output = JSON.parse((await tool.execute(args, { jobId: 'job-one' })).contentItems[0].text);
  assert.equal(output.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(path.dirname(output.path), directory); assert.equal(await fs.readFile(output.path, 'utf8'), 'hello');
  await assert.rejects(tool.execute(args, { jobId: 'job-one' }), { code: 'CHATGPT_FILE_ALREADY_SAVED' });
  assert.deepEqual(await fs.readdir(directory), ['job-one-hello.txt']);
});

test('cancelled imports never create an output file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-file-cancel-')), directory = path.join(root, 'imports'), controller = new AbortController();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tool = chatGPTFileImportTool({ directory, download: async () => { controller.abort(); return Buffer.from('private'); } });
  await assert.rejects(tool.execute({ requestId: 'cancel', file: { file_id: 'file_test', download_url: 'https://files.example/file' } }, { jobId: 'job-cancel', signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('DNS resolution obeys the download deadline and cancellation without starting a late socket', async () => {
  let requests = 0, resolveDNS;
  const lookup = () => new Promise(resolve => { resolveDNS = resolve; });
  await assert.rejects(downloadChatGPTFile('https://files.example/file', { resolve: lookup, request: () => requests++, timeoutMs: 15 }), { code: 'CHATGPT_FILE_DOWNLOAD_TIMEOUT' });
  resolveDNS([{ address: '8.8.8.8', family: 4 }]);
  const controller = new AbortController();
  const waiting = downloadChatGPTFile('https://files.example/file', { resolve: lookup, request: () => requests++, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  resolveDNS([{ address: '8.8.8.8', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
});
