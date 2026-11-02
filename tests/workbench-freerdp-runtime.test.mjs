import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPeImports, collectPeClosure, stageFreeRdpRuntime, verifyFreeRdpRuntime, activateOpenSslProviders, OPENSSL_RUNTIME_ENV } from '../scripts/package-workbench-freerdp.mjs';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// A small valid PE32+ image with distinct RVAs/file offsets and normal/delay tables.
function image(normal = [], delay = [], { machine = 0x8664, legacyDelay = false } = {}) {
  const data = Buffer.alloc(0x1400), pe = 0x80, optional = pe + 24, section = optional + 240;
  data.writeUInt16LE(0x5a4d, 0); data.writeUInt32LE(pe, 0x3c); data.writeUInt32LE(0x4550, pe);
  data.writeUInt16LE(machine, pe + 4); data.writeUInt16LE(1, pe + 6); data.writeUInt16LE(240, pe + 20);
  data.writeUInt16LE(0x20b, optional); data.writeBigUInt64LE(0x400000n, optional + 24);
  data.writeUInt32LE(0x200, optional + 60); data.writeUInt32LE(16, optional + 108);
  data.writeUInt32LE(0x1200, section + 8); data.writeUInt32LE(0x1000, section + 12);
  data.writeUInt32LE(0x1200, section + 16); data.writeUInt32LE(0x200, section + 20);
  const rva = offset => 0x1000 + offset - 0x200;
  let nameOffset = 0xa00;
  for (const [libraries, index, start, width] of [[normal, 1, 0x200, 20], [delay, 13, 0x600, 32]]) {
    if (!libraries.length) continue;
    data.writeUInt32LE(rva(start), optional + 112 + index * 8);
    data.writeUInt32LE((libraries.length + 1) * width, optional + 112 + index * 8 + 4);
    libraries.forEach((name, item) => {
      const descriptor = start + item * width;
      if (index === 1) data.writeUInt32LE(rva(nameOffset), descriptor + 12);
      else {
        data.writeUInt32LE(legacyDelay ? 0 : 1, descriptor);
        data.writeUInt32LE(rva(nameOffset) + (legacyDelay ? 0x400000 : 0), descriptor + 4);
      }
      data.write(name + '\0', nameOffset, 'ascii'); nameOffset += name.length + 1;
    });
  }
  return data;
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-freerdp-runtime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('PE import reader handles normal, RVA delay, and legacy VA delay imports', () => {
  const parsed = readPeImports(image(['KERNEL32.dll', 'liba.dll'], ['LIBA.dll', 'late.dll']));
  assert.equal(parsed.machine, 0x8664);
  assert.deepEqual(parsed.imports, [
    { name: 'kernel32.dll', kinds: ['normal'] }, { name: 'late.dll', kinds: ['delay'] }, { name: 'liba.dll', kinds: ['delay', 'normal'] },
  ]);
  assert.deepEqual(readPeImports(image([], ['late.dll'], { legacyDelay: true })).imports, [{ name: 'late.dll', kinds: ['delay'] }]);
});

test('PE import reader rejects malformed bounds, unterminated tables, and path imports', () => {
  assert.throws(() => readPeImports(Buffer.alloc(3)), /Windows PE|Truncated/);
  const outside = image(['library.dll']); outside.writeUInt32LE(0xfffffff0, 0x200 + 12);
  assert.throws(() => readPeImports(outside), /RVA/);
  const unterminated = image(['library.dll']); unterminated.writeUInt32LE(20, 0x80 + 24 + 112 + 8 + 4);
  assert.throws(() => readPeImports(unterminated), /Unterminated/);
  assert.throws(() => readPeImports(image(['../library.dll'])), /Unsafe/);
});

test('closure follows recursive/cyclic/delay imports and excludes unused and Windows libraries', async t => {
  const directory = await temporary(t), binDirectory = path.join(directory, 'bin'), systemDirectory = path.join(directory, 'system');
  await fs.mkdir(binDirectory); await fs.mkdir(systemDirectory);
  await fs.writeFile(path.join(systemDirectory, 'kernel32.dll'), 'Windows-owned');
  await fs.writeFile(path.join(binDirectory, 'wfreerdp.exe'), image(['liba.dll', 'KERNEL32.dll', 'api-ms-win-crt-runtime-l1-1-0.dll']));
  await fs.writeFile(path.join(binDirectory, 'liba.dll'), image([], ['libb.dll']));
  await fs.writeFile(path.join(binDirectory, 'libb.dll'), image(['liba.dll']));
  await fs.writeFile(path.join(binDirectory, 'unused.dll'), image());
  const result = await collectPeClosure({ binDirectory, systemDirectory });
  assert.deepEqual(result.binaries.map(value => value.name), ['liba.dll', 'libb.dll', 'wfreerdp.exe']);
  assert.deepEqual(result.systemImports.map(value => value.name), ['api-ms-win-crt-runtime-l1-1-0.dll', 'kernel32.dll']);
  await fs.rm(path.join(binDirectory, 'libb.dll'));
  await assert.rejects(collectPeClosure({ binDirectory, systemDirectory }), /Unresolved native import libb/);
  await fs.writeFile(path.join(binDirectory, 'libb.dll'), image([], [], { machine: 0x14c }));
  await assert.rejects(collectPeClosure({ binDirectory, systemDirectory }), /Expected x64/);
});

const tarExecutable = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? process.env.WINDIR, 'System32/tar.exe') : 'tar';

async function fixture(t, { openssl = false } = {}) {
  const directory = await temporary(t), buildRoot = path.join(directory, 'toolchain'), msysRoot = path.join(buildRoot, 'msys64');
  const cache = path.join(msysRoot, 'var/cache/pacman/pkg'), bin = path.join(msysRoot, 'ucrt64/bin');
  const systemDirectory = path.join(directory, 'system'), lockPath = path.join(directory, 'lock.json'), outputDirectory = path.join(directory, 'runtime');
  await fs.mkdir(cache, { recursive: true }); await fs.mkdir(bin, { recursive: true }); await fs.mkdir(systemDirectory);
  await fs.writeFile(path.join(systemDirectory, 'kernel32.dll'), 'Windows-owned');
  const names = ['mingw-w64-ucrt-x86_64-freerdp', 'mingw-w64-ucrt-x86_64-library'];
  const contents = [
    { 'ucrt64/bin/wfreerdp.exe': image(['liba.dll', 'kernel32.dll', ...(openssl ? ['libcrypto-3-x64.dll'] : [])]), 'ucrt64/share/licenses/freerdp/LICENSE': Buffer.from('Fixture license text') },
    { 'ucrt64/bin/liba.dll': image(), 'ucrt64/bin/unused.dll': image() },
  ];
  if (openssl) {
    names.push('mingw-w64-ucrt-x86_64-openssl');
    contents.push({
      'ucrt64/bin/libcrypto-3-x64.dll': image(['kernel32.dll']),
      'ucrt64/lib/ossl-modules/legacy.dll': image(['libcrypto-3-x64.dll', 'kernel32.dll']),
      'ucrt64/etc/ssl/openssl.cnf.dist': Buffer.from('openssl_conf = openssl_init\n[openssl_init]\nproviders = provider_sect\n[provider_sect]\ndefault = default_sect\n[default_sect]\n# activate = 1\n'),
      'ucrt64/share/licenses/openssl/LICENSE': Buffer.from('Fixture OpenSSL license text'),
    });
  }
  const artifacts = [];
  for (let index = 0; index < names.length; index++) {
    const name = names[index], source = path.join(directory, `source-${index}`), members = contents[index];
    members['.PKGINFO'] = Buffer.from(`pkgname = ${name}\npkgver = 1.0-1\nurl = https://example.invalid/source\nlicense = MIT\n`);
    for (const [member, bytes] of Object.entries(members)) {
      const file = path.join(source, member); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
      if (member.startsWith('ucrt64/')) {
        const installed = path.join(msysRoot, member); await fs.mkdir(path.dirname(installed), { recursive: true }); await fs.writeFile(installed, bytes);
      }
    }
    const archive = `${name}-1.0-1-any.pkg.tar.zst`;
    // Tar autodetects the archive encoding; tiny fixtures need no zstd dependency.
    await execute(tarExecutable, ['-cf', path.join(cache, archive), '-C', source, ...Object.keys(members)], { windowsHide: true });
    artifacts.push({ file: archive, sha256: hash(await fs.readFile(path.join(cache, archive))) });
    const db = path.join(msysRoot, 'var/lib/pacman/local', `${name}-1.0-1`); await fs.mkdir(db, { recursive: true });
    await fs.writeFile(path.join(db, 'files'), '%FILES%\n' + Object.keys(members).filter(value => value !== '.PKGINFO').join('\n') + '\n');
  }
  await fs.writeFile(lockPath, JSON.stringify({ schema: 1, packages: names.map(name => `${name} 1.0-1`), packageArtifacts: artifacts,
    freerdp: { name: names[0], version: '1.0-1', sha256: artifacts[0].sha256 } }));
  return { buildRoot, outputDirectory, lockPath, systemDirectory, tarExecutable, cache, bin, artifacts };
}

test('staging extracts only required binaries and available licenses from verified archives', async t => {
  const args = await fixture(t), manifest = await stageFreeRdpRuntime(args);
  assert.deepEqual(manifest.files.filter(value => value.kind === 'binary').map(value => value.path), ['bin/liba.dll', 'bin/wfreerdp.exe']);
  assert.equal(manifest.files.filter(value => value.kind === 'license').length, 1);
  assert.equal(manifest.releaseReady, false);
  assert.deepEqual(manifest.missingLicenseTexts, ['mingw-w64-ucrt-x86_64-library']);
  assert.equal((await verifyFreeRdpRuntime(args)).files.length, manifest.files.length);
  await assert.rejects(stageFreeRdpRuntime(args), /already exists/);
  await fs.writeFile(path.join(args.outputDirectory, 'bin/unexpected.dll'), image());
  await assert.rejects(verifyFreeRdpRuntime(args), /unexpected files/);
  await fs.rm(path.join(args.outputDirectory, 'bin/unexpected.dll'));
  await fs.appendFile(path.join(args.outputDirectory, 'bin/liba.dll'), 'corruption');
  await assert.rejects(verifyFreeRdpRuntime(args), /verification failed/);
});

test('staging refuses corrupt archives and changed installed binaries without leaving an output', async t => {
  const corrupt = await fixture(t);
  await fs.appendFile(path.join(corrupt.cache, corrupt.artifacts[1].file), 'corruption');
  await assert.rejects(stageFreeRdpRuntime(corrupt), /SHA-256 mismatch/);
  await assert.rejects(fs.stat(corrupt.outputDirectory), { code: 'ENOENT' });
  const changed = await fixture(t);
  await fs.appendFile(path.join(changed.bin, 'liba.dll'), 'changed installed bytes');
  await assert.rejects(stageFreeRdpRuntime(changed), /Installed binary differs/);
  await assert.rejects(fs.stat(changed.outputDirectory), { code: 'ENOENT' });
});

test('OpenSSL legacy module and source-derived configuration are explicit verified runtime dependencies', async t => {
  const args = await fixture(t, { openssl: true });
  const manifest = await stageFreeRdpRuntime(args);
  assert.deepEqual(manifest.processEnvironment, OPENSSL_RUNTIME_ENV);
  assert.ok(manifest.files.some(file => file.path === 'lib/ossl-modules/legacy.dll' && file.kind === 'provider' && file.sourcePath === 'ucrt64/lib/ossl-modules/legacy.dll'));
  const source = await fs.readFile(path.join(args.outputDirectory, 'etc/ssl/openssl.cnf.dist'), 'utf8');
  const config = await fs.readFile(path.join(args.outputDirectory, 'etc/ssl/openssl.cnf'), 'utf8');
  assert.equal(config, activateOpenSslProviders(source));
  assert.match(config, /\[default_sect\]\nactivate = 1/);
  assert.match(config, /legacy = legacy_sect/);
  assert.match(config, /\[legacy_sect\]\nactivate = 1/);
  await verifyFreeRdpRuntime(args);
  await fs.appendFile(path.join(args.outputDirectory, 'lib/ossl-modules/legacy.dll'), 'corruption');
  await assert.rejects(verifyFreeRdpRuntime(args), /verification failed/);
  assert.throws(() => activateOpenSslProviders('[unreviewed]\n'), /reviewed provider layout/);
});
