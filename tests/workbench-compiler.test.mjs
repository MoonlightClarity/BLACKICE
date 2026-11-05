import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readMtreeChecksums } from '../scripts/verify-workbench-compiler.mjs';

test('compiler verification reads archive SHA-256 and size with mtree defaults and escaped names', () => {
  const sha256 = 'a'.repeat(64);
  assert.deepEqual(readMtreeChecksums(`#mtree\n/set type=file mode=644\n./.PKGINFO size=1 sha256digest=${sha256}\n./ucrt64 type=dir\n./ucrt64/include/test\\040file.h size=17 sha256digest=${sha256}\n`), [
    { path: 'ucrt64/include/test file.h', size: 17, sha256 },
  ]);
  assert.deepEqual(readMtreeChecksums('#mtree\n/set type=file\n./.PKGINFO size=1\n'), []); // A metapackage has no installed payload.
});

test('compiler verification refuses traversal, absent hashes, symlink payloads, and duplicates', () => {
  const sha256 = 'a'.repeat(64);
  for (const line of [
    `./ucrt64/../outside size=1 sha256digest=${sha256}`,
    './ucrt64/bin/compiler.exe size=1',
    './ucrt64/bin/compiler.exe type=link link=outside',
    `./ucrt64/bin/compiler.exe size=1 sha256digest=${sha256}\n./ucrt64/bin/compiler.exe size=1 sha256digest=${sha256}`,
  ]) assert.throws(() => readMtreeChecksums('#mtree\n/set type=file\n' + line), /Unsafe|checksum|Unsupported|Duplicate/);
});

test('compiler lock pins a separate complete GCC package set and original FreeRDP headers', async () => {
  const lock = JSON.parse(await readFile(new URL('../docs/workbench-freerdp-compiler.lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.compiler.name, 'mingw-w64-ucrt-x86_64-gcc');
  const headerLockBytes = await readFile(new URL('../' + lock.freerdpHeaders.lock, import.meta.url));
  assert.equal(createHash('sha256').update(headerLockBytes).digest('hex'), lock.freerdpHeaders.sha256.toLowerCase(),
    'The compiler must pin the exact dependency-lock bytes in the canonical checkout.');
  const inventory = lock.packages.filter(value => value.startsWith('mingw-w64-ucrt-x86_64-'));
  assert.equal(inventory.length, lock.packageArtifacts.length);
  for (const entry of inventory) assert.ok(lock.packageArtifacts.some(artifact => artifact.file === entry.replace(' ', '-') + '-any.pkg.tar.zst'));
  const source = await readFile(new URL('../scripts/setup-workbench-freerdp-compiler.ps1', import.meta.url), 'utf8');
  assert.match(source, /\.build\\workbench-freerdp-compiler/);
  assert.match(source, /compiler must use a separate build folder/);
  assert.doesNotMatch(source, /pacman[^\r\n]*\s-S[y\s]/);
  assert.match(source, /verify-workbench-compiler\.mjs/);
});
