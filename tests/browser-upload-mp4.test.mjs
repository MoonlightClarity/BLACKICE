import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const driver = readFileSync(fileURLToPath(new URL('../desktop/browser-driver.mjs', import.meta.url)), 'utf8');
const start = driver.indexOf('const uploadMimeTypes = new Map(Object.entries({');
const end = driver.indexOf('}));', start);
assert.ok(start >= 0 && end > start, 'Browser upload MIME map is present');
const entries = [...driver.slice(start, end).matchAll(/'(\.[^']+)':\s*'([^']+)'/g)];
const mimeTypes = new Map(entries.map(([, extension, type]) => [extension, type]));

test('MP4 files are delivered with video/mp4 rather than application/octet-stream', () => {
  assert.equal(mimeTypes.get('.mp4'), 'video/mp4');
  assert.match(driver, /type:\s*uploadMimeTypes\.get\(path\.extname\(file\)\.toLowerCase\(\)\)\s*\|\|\s*'application\/octet-stream'/);
});

test('Existing image and document upload types remain intact', () => {
  assert.equal(mimeTypes.get('.png'), 'image/png');
  assert.equal(mimeTypes.get('.jpg'), 'image/jpeg');
  assert.equal(mimeTypes.get('.pdf'), 'application/pdf');
});
