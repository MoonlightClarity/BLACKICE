import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { CONNECTION_TOOL, createConnectionToolHandler } from '../lib/mcp.mjs';
import { ATTACHMENT_LIMITS } from '../lib/attachments.mjs';

const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1; } return (value ^ 0xffffffff) >>> 0; };
function chunk(name, bytes) { const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); result.write(name, 4); bytes.copy(result, 8); result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4); return result; }
function png() { const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]); }
const pixels = png(), image = () => ({ type: 'image', mimeType: 'image/png', data: pixels.toString('base64') });
const call = imageOutputPath => ({ name: 'relay_connections', arguments: { action: 'call', connectionId: 'fixture', name: 'screenshot', arguments: { page: 7 }, ...(imageOutputPath === undefined ? {} : { imageOutputPath }) } });
const manager = work => ({ redact: value => String(value), async call(...args) { return work(...args); } });
async function folder(t) { const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-image-output-')); t.after(async () => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.match(path.basename(directory), /^blackice-image-output-/); await fs.rm(directory, { recursive: true, force: true }); }); return directory; }
const receipt = result => result.contentItems.filter(item => item.type === 'inputText').map(item => { try { return JSON.parse(item.text)?.savedImage; } catch { return null; } }).find(Boolean);

test('explicit screenshot output saves exact first-image bytes with a verified receipt and retains inline pixels', async t => {
  const directory = await folder(t), destination = path.join(directory, 'screenshot.png');
  assert.equal(CONNECTION_TOOL.inputSchema.properties.imageOutputPath.type, 'string');
  const handler = createConnectionToolHandler({ manager: manager(async (id, name, args) => { assert.equal(id, 'fixture'); assert.equal(name, 'screenshot'); assert.deepEqual(args, { page: 7 }); return { content: [{ type: 'text', text: 'Actual screen.' }, image(), { ...image(), data: 'second-inline-image' }] }; }) });
  const result = await handler(call(destination));
  assert.equal(result.success, true); assert.deepEqual(await fs.readFile(destination), pixels);
  assert.deepEqual(receipt(result), { path: destination, mimeType: 'image/png', bytes: pixels.length, sha256: createHash('sha256').update(pixels).digest('hex'), width: 1, height: 1 });
  assert.equal(result.contentItems[0].text, 'Actual screen.'); assert.equal(result.contentItems[1].imageUrl, `data:image/png;base64,${pixels.toString('base64')}`);
  assert.deepEqual(await fs.readdir(directory), ['screenshot.png']);
});

test('image responses remain observations and write no files unless explicitly requested', async t => {
  const directory = await folder(t), handler = createConnectionToolHandler({ manager: manager(async () => ({ content: [image()] })) });
  const result = await handler(call()); assert.equal(result.success, true); assert.equal(receipt(result), undefined); assert.equal(result.contentItems[0].type, 'inputImage'); assert.deepEqual(await fs.readdir(directory), []);
});

test('invalid paths and existing files are rejected before the external tool runs', async t => {
  const directory = await folder(t), destination = path.join(directory, 'existing.png'); await fs.writeFile(destination, 'preserve this file');
  let invoked = 0; const handler = createConnectionToolHandler({ manager: manager(async () => { invoked++; return { content: [image()] }; }) });
  for (const target of ['relative.png', '', destination, path.join(directory, 'missing', 'image.png')]) { const result = await handler(call(target)); assert.equal(result.success, false); assert.equal(receipt(result), undefined); }
  const invalidAction = call(path.join(directory, 'unused.png')); invalidAction.arguments.action = 'tools'; assert.equal((await handler(invalidAction)).success, false);
  assert.equal(invoked, 0); assert.equal(await fs.readFile(destination, 'utf8'), 'preserve this file'); assert.deepEqual(await fs.readdir(directory), ['existing.png']);
});

test('failed tools and absent, damaged, mismatched or oversized images cannot create saved receipts', async t => {
  const directory = await folder(t), damaged = Buffer.from(pixels); damaged[damaged.length - 5] ^= 1;
  const cases = [
    { isError: true, content: [image()] }, { content: [{ type: 'text', text: 'No image.' }] },
    { content: [{ ...image(), mimeType: 'image/gif' }] }, { content: [{ ...image(), mimeType: 'image/jpeg' }] },
    { content: [{ ...image(), data: '!!!!' }] }, { content: [{ ...image(), data: 'Zh==' }] },
    { content: [{ ...image(), data: damaged.toString('base64') }] },
    { content: [{ ...image(), data: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1).toString('base64') }] },
    { content: [{ ...image(), data: 'A'.repeat(Math.ceil(ATTACHMENT_LIMITS.fileBytes / 3) * 4 + 4) }] },
  ];
  for (const [index, value] of cases.entries()) {
    const result = await createConnectionToolHandler({ manager: manager(async () => value) })(call(path.join(directory, `invalid-${index}.png`)));
    assert.equal(result.success, false, `case ${index}`); assert.equal(receipt(result), undefined); assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('a file created while the external screenshot runs wins the race and is never overwritten', async t => {
  const directory = await folder(t), destination = path.join(directory, 'raced.png');
  const handler = createConnectionToolHandler({ manager: manager(async () => { await fs.writeFile(destination, 'concurrent data'); return { content: [image()] }; }) });
  const result = await handler(call(destination)); assert.equal(result.success, false); assert.match(result.contentItems[0].text, /never overwritten/); assert.equal(receipt(result), undefined);
  assert.equal(await fs.readFile(destination, 'utf8'), 'concurrent data'); assert.deepEqual(await fs.readdir(directory), ['raced.png']);
});

test('cancellation after image publication removes the owned file and staged bytes', async t => {
  const directory = await folder(t), destination = path.join(directory, 'cancelled.png'), controller = new AbortController(), originalLink = fs.link;
  t.mock.method(fs, 'link', async (source, target) => { assert.deepEqual(await fs.readFile(source), pixels); await assert.rejects(fs.stat(target), { code: 'ENOENT' }); await originalLink(source, target); controller.abort(); });
  const handler = createConnectionToolHandler({ signal: controller.signal, manager: manager(async () => ({ content: [image()] })) });
  await assert.rejects(handler(call(destination)), { name: 'AbortError', code: 'ABORT_ERR' }); assert.deepEqual(await fs.readdir(directory), []);
});

test('publication failures leave neither partial destination nor staging files', async t => {
  const directory = await folder(t), destination = path.join(directory, 'failed.png');
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Publication unavailable.'), { code: 'EIO' }); });
  const result = await createConnectionToolHandler({ manager: manager(async () => ({ content: [image()] })) })(call(destination));
  assert.equal(result.success, false); assert.match(result.contentItems[0].text, /Publication unavailable/); assert.equal(receipt(result), undefined); assert.deepEqual(await fs.readdir(directory), []);
});
