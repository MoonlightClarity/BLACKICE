// Stage the pinned Windows client and its recursive PE imports, never a whole MSYS2 tree.
// PE structures: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const packagePrefix = 'mingw-w64-ucrt-x86_64-';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = values => [...values].sort(compare);
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const safeRelative = name => typeof name === 'string' && /^[A-Za-z0-9_.+~/-]+$/.test(name) &&
  !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..');
const fail = message => { throw new Error(message); };
const opensslPackage = 'mingw-w64-ucrt-x86_64-openssl';
export const OPENSSL_RUNTIME_ENV = Object.freeze({ OPENSSL_MODULES: 'lib/ossl-modules', OPENSSL_CONF: 'etc/ssl/openssl.cnf' });

export function activateOpenSslProviders(source) {
  if (!/^\[provider_sect\]\r?$/m.test(source) || !/^\[default_sect\]\r?$/m.test(source) || /^\[legacy_sect\]/m.test(source)) {
    fail('Pinned OpenSSL configuration does not match the reviewed provider layout.');
  }
  return source.replace(/^\[provider_sect\]\r?$/m, '[provider_sect]\nlegacy = legacy_sect')
    .replace(/^\[default_sect\]\r?$/m, '[default_sect]\nactivate = 1') + '\n[legacy_sect]\nactivate = 1\n';
}

async function providerImports(source, systemDirectory) {
  const bytes = await fs.readFile(source), pe = readPeImports(bytes);
  if (pe.machine !== 0x8664) fail('OpenSSL provider must be x64.');
  const systemNames = new Set((await fs.readdir(systemDirectory)).map(name => name.toLowerCase()));
  const system = [], entries = [];
  for (const dependency of pe.imports) {
    const apiSet = /^(api|ext)-ms-win-[a-z0-9_.-]+\.dll$/.test(dependency.name);
    if (apiSet || systemNames.has(dependency.name)) system.push({ name: dependency.name, kind: apiSet ? 'windows-api-set' : 'windows-system32' });
    else entries.push(dependency.name);
  }
  return { imports: pe.imports, entries, system, sha256: digest(bytes), size: bytes.length };
}

function addSystemImports(closure, additional) {
  const all = new Map([...closure.systemImports, ...additional].map(item => [item.name, item]));
  closure.systemImports = sorted(all.keys()).map(name => all.get(name));
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function readPeImports(bytes) {
  const bounds = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) fail('Truncated or invalid PE data.');
  };
  const u16 = offset => { bounds(offset, 2); return bytes.readUInt16LE(offset); };
  const u32 = offset => { bounds(offset, 4); return bytes.readUInt32LE(offset); };
  if (u16(0) !== 0x5a4d) fail('Expected a Windows PE executable.');
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) fail('Invalid Windows PE signature.');
  const machine = u16(pe + 4), sectionCount = u16(pe + 6), optionalSize = u16(pe + 20);
  if (!sectionCount || sectionCount > 96) fail('Invalid PE section count.');
  const optional = pe + 24, magic = u16(optional);
  if (magic !== 0x20b && magic !== 0x10b) fail('Unsupported PE optional header.');
  const directoryStart = magic === 0x20b ? 112 : 96;
  if (optionalSize < directoryStart) fail('Truncated PE optional header.');
  bounds(optional, optionalSize);
  const directoryCount = u32(optional + directoryStart - 4);
  const imageBase = magic === 0x20b ? bytes.readBigUInt64LE(optional + 24) : BigInt(u32(optional + 28));
  const headerSize = u32(optional + 60), sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const section = optional + optionalSize + index * 40;
    bounds(section, 40);
    sections.push({ rva: u32(section + 12), length: u32(section + 16), offset: u32(section + 20) });
  }
  const fileOffset = (rva, size = 1) => {
    if (rva < headerSize && rva + size <= headerSize) { bounds(rva, size); return rva; }
    for (const section of sections) {
      const relative = rva - section.rva;
      if (relative >= 0 && relative + size <= section.length) {
        bounds(section.offset + relative, size);
        return section.offset + relative;
      }
    }
    fail('PE RVA does not refer to file-backed section data.');
  };
  const libraryName = rva => {
    const start = fileOffset(rva);
    const end = bytes.indexOf(0, start);
    if (end < start || end - start > 260) fail('Invalid PE import library name.');
    fileOffset(rva, end - start + 1);
    if (bytes.subarray(start, end).some(value => value > 0x7f)) fail('Unsafe non-ASCII PE import library name.');
    const name = bytes.toString('ascii', start, end).toLowerCase();
    if (!/^[a-z0-9_+.-]+\.(dll|drv|ocx|exe)$/.test(name)) fail('Unsafe PE import library name.');
    return name;
  };
  const tables = [[1, 20, 'normal'], [13, 32, 'delay']], imports = new Map();
  for (const [index, width, kind] of tables) {
    if (index >= directoryCount) continue;
    if (directoryStart + (index + 1) * 8 > optionalSize) fail('Truncated PE data directory.');
    const directory = optional + directoryStart + index * 8;
    const rva = u32(directory), size = u32(directory + 4);
    if (!rva && !size) continue;
    if (!rva || size < width) fail('Invalid PE import directory size.');
    let terminated = false;
    for (let cursor = 0; cursor + width <= size; cursor += width) {
      const descriptor = fileOffset(rva + cursor, width);
      if (bytes.subarray(descriptor, descriptor + width).every(value => value === 0)) { terminated = true; break; }
      let nameRva;
      if (kind === 'normal') nameRva = u32(descriptor + 12);
      else {
        const attributes = u32(descriptor);
        if (attributes & ~1) fail('Unsupported PE delay import attributes.');
        const address = BigInt(u32(descriptor + 4));
        const relative = attributes & 1 ? address : address - imageBase;
        if (relative < 0 || relative > 0xffffffffn) fail('Invalid PE delay import address.');
        nameRva = Number(relative);
      }
      const name = libraryName(nameRva);
      const kinds = imports.get(name) ?? new Set();
      kinds.add(kind); imports.set(name, kinds);
    }
    if (!terminated) fail('Unterminated PE import directory.');
  }
  return { machine, imports: sorted(imports.keys()).map(name => ({ name, kinds: sorted(imports.get(name)) })) };
}

export async function collectPeClosure({ binDirectory, systemDirectory, entry = 'wfreerdp.exe', additionalEntries = [] }) {
  const binNames = new Map((await fs.readdir(binDirectory)).map(name => [name.toLowerCase(), name]));
  const systemNames = new Set((await fs.readdir(systemDirectory)).map(name => name.toLowerCase()));
  const pending = [entry.toLowerCase(), ...additionalEntries.map(name => name.toLowerCase())], binaries = new Map(), systemImports = new Map();
  while (pending.length) {
    const key = pending.shift();
    if (binaries.has(key)) continue;
    const filename = binNames.get(key);
    if (!filename) fail(`Missing native runtime dependency: ${key}`);
    const source = path.join(binDirectory, filename);
    if (!(await fs.lstat(source)).isFile()) fail(`Native runtime binary must be a regular file: ${filename}`);
    const content = await fs.readFile(source), pe = readPeImports(content);
    if (pe.machine !== 0x8664) fail(`Expected x64 native runtime binary: ${filename}`);
    binaries.set(key, { name: filename, sha256: digest(content), size: content.length, imports: pe.imports });
    for (const dependency of pe.imports) {
      const apiSet = /^(api|ext)-ms-win-[a-z0-9_.-]+\.dll$/.test(dependency.name);
      const system = systemNames.has(dependency.name);
      if (apiSet || system) {
        if (binNames.has(dependency.name)) fail(`Runtime directory shadows a Windows system library: ${dependency.name}`);
        systemImports.set(dependency.name, { name: dependency.name, kind: apiSet ? 'windows-api-set' : 'windows-system32' });
      } else {
        if (!binNames.has(dependency.name)) fail(`Unresolved native import ${dependency.name} required by ${filename}`);
        pending.push(dependency.name);
      }
    }
  }
  return {
    binaries: sorted(binaries.keys()).map(key => binaries.get(key)),
    systemImports: sorted(systemImports.keys()).map(key => systemImports.get(key)),
  };
}

async function readLock(lockPath) {
  const content = await fs.readFile(lockPath), lock = JSON.parse(content);
  if (lock.schema !== 1 || !Array.isArray(lock.packages) || !Array.isArray(lock.packageArtifacts)) fail('Invalid FreeRDP dependency lock.');
  const packages = new Map();
  for (const line of lock.packages.filter(value => value.startsWith(packagePrefix))) {
    const match = /^(mingw-w64-ucrt-x86_64-[A-Za-z0-9_+.-]+) ([A-Za-z0-9_+.~-]+)$/.exec(line);
    if (!match || packages.has(match[1])) fail('Invalid or duplicate FreeRDP package inventory.');
    packages.set(match[1], { name: match[1], version: match[2], archive: `${match[1]}-${match[2]}-any.pkg.tar.zst` });
  }
  const artifacts = new Map();
  for (const item of lock.packageArtifacts) {
    if (!/^mingw-w64-ucrt-x86_64-[A-Za-z0-9_+.~-]+-any\.pkg\.tar\.zst$/.test(item.file) ||
        !/^[a-f0-9]{64}$/i.test(item.sha256) || artifacts.has(item.file)) fail('Invalid or duplicate FreeRDP package artifact.');
    artifacts.set(item.file, item.sha256.toLowerCase());
  }
  if (!packages.size || packages.size !== artifacts.size) fail('FreeRDP inventory/artifact count mismatch.');
  for (const item of packages.values()) {
    if (!artifacts.has(item.archive)) fail(`Package has no pinned archive: ${item.name}`);
    item.sha256 = artifacts.get(item.archive);
  }
  const client = packages.get('mingw-w64-ucrt-x86_64-freerdp');
  if (!client || lock.freerdp?.name !== client.name || lock.freerdp.version !== client.version || lock.freerdp.sha256.toLowerCase() !== client.sha256) {
    fail('FreeRDP client metadata differs from its pinned archive.');
  }
  return { lock, packages, sha256: digest(content) };
}

async function packageOwners(msysRoot, packages, tarExecutable, cache) {
  const owners = new Map();
  for (const pkg of packages.values()) {
    // A cached archive remains authoritative if an unused package's local file
    // inventory was removed; staging must not depend on unrelated development files.
    const list = await fs.readFile(path.join(msysRoot, 'var/lib/pacman/local', `${pkg.name}-${pkg.version}`, 'files'), 'utf8')
      .catch(error => error.code === 'ENOENT' ? tar(tarExecutable, ['-tf', path.join(cache, pkg.archive)]) : Promise.reject(error));
    for (const entry of list.split(/\r?\n/).filter(value => /^ucrt64\/bin\/[^/]+$/.test(value))) {
      if (!safeRelative(entry)) fail(`Unsafe installed package member: ${entry}`);
      const key = entry.toLowerCase();
      if (owners.has(key)) fail(`Duplicate installed binary ownership: ${entry}`);
      owners.set(key, pkg.name);
    }
  }
  return owners;
}

async function tar(tarExecutable, args) {
  const { stdout } = await execute(tarExecutable, args, { windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

function packageInfo(content) {
  const fields = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = /^([a-z]+) = (.*)$/.exec(line);
    if (match) fields.set(match[1], [...fields.get(match[1]) ?? [], match[2]]);
  }
  return { name: fields.get('pkgname')?.[0], version: fields.get('pkgver')?.[0], url: fields.get('url')?.[0] ?? '', licenses: fields.get('license') ?? [] };
}

async function regularFiles(directory, prefix = '') {
  const result = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (item.isDirectory()) result.push(...await regularFiles(path.join(directory, item.name), name + '/'));
    else if (item.isFile()) result.push(name);
    else fail(`Runtime contains a nonregular file: ${name}`);
  }
  return sorted(result);
}

export async function stageFreeRdpRuntime({ buildRoot, outputDirectory, lockPath, systemDirectory, tarExecutable }) {
  const pinned = await readLock(lockPath);
  const msysRoot = path.join(buildRoot, 'msys64'), cache = path.join(msysRoot, 'var/cache/pacman/pkg');
  const binDirectory = path.join(msysRoot, 'ucrt64/bin');
  const resolvedOutput = path.resolve(outputDirectory), parent = path.dirname(resolvedOutput);
  if (await fs.lstat(resolvedOutput).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
    fail('Runtime output already exists. Verify it with --verify-only, or choose a new output directory.');
  }
  // Validate all locked archives before extracting or creating an output, including unused packages.
  for (const pkg of pinned.packages.values()) {
    const actual = await hashFile(path.join(cache, pkg.archive));
    if (actual !== pkg.sha256) fail(`Pinned package SHA-256 mismatch: ${pkg.archive}`);
  }
  let closure = await collectPeClosure({ binDirectory, systemDirectory });
  const needsOpenSsl = closure.binaries.some(binary => binary.name.toLowerCase() === 'libcrypto-3-x64.dll');
  let provider;
  if (needsOpenSsl) {
    if (!pinned.packages.has(opensslPackage)) fail('OpenSSL runtime has no pinned package.');
    provider = await providerImports(path.join(msysRoot, 'ucrt64/lib/ossl-modules/legacy.dll'), systemDirectory);
    closure = await collectPeClosure({ binDirectory, systemDirectory, additionalEntries: provider.entries });
    addSystemImports(closure, provider.system);
  }
  const owners = await packageOwners(msysRoot, pinned.packages, tarExecutable, cache), selected = new Map();
  for (const binary of closure.binaries) {
    const member = `ucrt64/bin/${binary.name}`;
    const owner = owners.get(member.toLowerCase());
    if (!owner) fail(`Runtime binary has no pinned package owner: ${binary.name}`);
    const selection = selected.get(owner) ?? { pkg: pinned.packages.get(owner), binaries: [] };
    selection.binaries.push({ ...binary, member }); selected.set(owner, selection);
  }
  if (needsOpenSsl) {
    const selection = selected.get(opensslPackage);
    if (!selection) fail('OpenSSL library is not owned by its pinned package.');
    selection.resources = [
      { member: 'ucrt64/lib/ossl-modules/legacy.dll', destination: 'lib/ossl-modules/legacy.dll', kind: 'provider', ...provider },
      { member: 'ucrt64/etc/ssl/openssl.cnf.dist', destination: 'etc/ssl/openssl.cnf.dist', kind: 'config-source' },
    ];
  }
  await fs.mkdir(parent, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(parent, '.freerdp-runtime-'));
  try {
    const files = [], packages = [];
    for (const owner of sorted(selected.keys())) {
      const { pkg, binaries, resources = [] } = selected.get(owner), archivePath = path.join(cache, pkg.archive);
      const entries = (await tar(tarExecutable, ['-tf', archivePath])).split(/\r?\n/).filter(Boolean);
      const licenses = entries.filter(name => name.startsWith('ucrt64/share/licenses/') && !name.endsWith('/'));
      const members = [...binaries.map(binary => binary.member), ...resources.map(resource => resource.member), ...licenses];
      if (members.some(name => !safeRelative(name) || !entries.includes(name))) fail(`Unsafe or absent pinned archive member in ${owner}`);
      const info = packageInfo(await tar(tarExecutable, ['-xOf', archivePath, '.PKGINFO']));
      if (info.name !== pkg.name || info.version !== pkg.version || !info.licenses.length) fail(`Pinned archive package metadata mismatch: ${owner}`);
      const extractRoot = path.join(temporary, '.source', owner);
      await fs.mkdir(extractRoot, { recursive: true });
      await tar(tarExecutable, ['-xf', archivePath, '-C', extractRoot, '--', ...members]);
      const licenseOutputs = [];
      for (const member of members) {
        const source = path.join(extractRoot, member);
        if (!(await fs.lstat(source)).isFile()) fail(`Archive member must be a regular file: ${member}`);
        const binary = binaries.find(value => value.member === member);
        const resource = resources.find(value => value.member === member);
        const filename = binary ? `bin/${binary.name}` : resource ? resource.destination : `licenses/${owner}/${member.slice('ucrt64/share/licenses/'.length)}`;
        const sha256 = await hashFile(source), size = (await fs.stat(source)).size;
        if (binary && sha256 !== binary.sha256) fail(`Installed binary differs from the pinned package archive: ${binary.name}`);
        if (resource?.sha256 && sha256 !== resource.sha256) fail(`Installed provider differs from the pinned package archive: ${member}`);
        const destination = path.join(temporary, filename);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(source, destination);
        files.push({ path: filename, kind: binary ? 'binary' : resource ? resource.kind : 'license', sha256, size, package: owner, sourcePath: member,
          ...(binary || resource?.imports ? { imports: binary?.imports ?? resource.imports } : {}) });
        if (!binary && !resource) licenseOutputs.push(filename);
      }
      packages.push({ ...pkg, upstreamUrl: info.url, licenses: info.licenses, licenseFiles: sorted(licenseOutputs), licenseTextMissing: licenseOutputs.length === 0,
        archiveUrl: `https://repo.msys2.org/mingw/ucrt64/${encodeURIComponent(pkg.archive)}` });
    }
    // This tree is exclusively owned by this invocation, and its absolute location
    // is checked before recursive cleanup. No preexisting output is ever removed.
    const sourceTree = path.join(temporary, '.source');
    if (path.dirname(sourceTree) !== temporary) fail('Invalid temporary source location.');
    await fs.rm(sourceTree, { recursive: true, force: true });
    if (needsOpenSsl) {
      const config = activateOpenSslProviders(await fs.readFile(path.join(temporary, 'etc/ssl/openssl.cnf.dist'), 'utf8'));
      await fs.writeFile(path.join(temporary, OPENSSL_RUNTIME_ENV.OPENSSL_CONF), config);
      files.push({ path: OPENSSL_RUNTIME_ENV.OPENSSL_CONF, kind: 'generated-config', sha256: digest(config), size: Buffer.byteLength(config), package: opensslPackage,
        derivedFrom: 'etc/ssl/openssl.cnf.dist', transformation: 'activate-default-and-legacy-providers' });
    }
    const notices = packages.map(pkg => [
      `${pkg.name} ${pkg.version}`, `Upstream: ${pkg.upstreamUrl}`, `Declared licenses: ${pkg.licenses.join(', ')}`,
      `Pinned archive: ${pkg.archiveUrl}`, `Archive SHA-256: ${pkg.sha256}`, ...pkg.licenseFiles.map(name => `License text: ${name}`),
      ...(pkg.licenseTextMissing ? ['License text is absent from this pinned package archive; redistribution review remains required.'] : []), '',
    ].join('\n')).join('\n');
    const noticesName = 'THIRD-PARTY-NOTICES.txt';
    await fs.writeFile(path.join(temporary, noticesName), notices);
    files.push({ path: noticesName, kind: 'notices', sha256: digest(notices), size: Buffer.byteLength(notices) });
    const manifest = {
      schema: 1, architecture: 'x64', entry: 'bin/wfreerdp.exe', sourceLockSHA256: pinned.sha256,
      distributionStatus: 'development-staging', releaseReady: false,
      missingLicenseTexts: packages.filter(pkg => pkg.licenseTextMissing).map(pkg => pkg.name),
      freerdp: pinned.lock.freerdp,
      ...(needsOpenSsl ? { processEnvironment: OPENSSL_RUNTIME_ENV } : {}),
      scope: 'Recursive normal and delay PE imports. Optional LoadLibrary modules, live session behavior, and redistribution obligations require separate validation.',
      packages, systemImports: closure.systemImports, files: files.sort((a, b) => compare(a.path, b.path)),
    };
    await fs.writeFile(path.join(temporary, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await verifyFreeRdpRuntime({ outputDirectory: temporary, lockPath, systemDirectory });
    await fs.rename(temporary, resolvedOutput);
    return manifest;
  } finally {
    if (path.dirname(temporary) !== parent || !path.basename(temporary).startsWith('.freerdp-runtime-')) fail('Invalid temporary runtime location.');
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyFreeRdpRuntime({ outputDirectory, lockPath, systemDirectory }) {
  const pinned = await readLock(lockPath);
  const manifest = JSON.parse(await fs.readFile(path.join(outputDirectory, 'runtime-manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.architecture !== 'x64' || manifest.entry !== 'bin/wfreerdp.exe' ||
      manifest.sourceLockSHA256 !== pinned.sha256 || manifest.distributionStatus !== 'development-staging' || manifest.releaseReady !== false ||
      !Array.isArray(manifest.files) || !Array.isArray(manifest.packages)) fail('Invalid runtime manifest or dependency lock mismatch.');
  const manifestPaths = new Set();
  for (const file of manifest.files) {
    if (!safeRelative(file.path) || manifestPaths.has(file.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('Invalid runtime file manifest.');
    manifestPaths.add(file.path.toLowerCase());
    const target = path.join(outputDirectory, file.path), stat = await fs.lstat(target);
    if (!stat.isFile() || stat.size !== file.size || await hashFile(target) !== file.sha256) fail(`Runtime file verification failed: ${file.path}`);
  }
  const actual = await regularFiles(outputDirectory);
  const expected = sorted([...manifest.files.map(file => file.path), 'runtime-manifest.json']);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('Runtime contains missing or unexpected files.');
  const packageNames = new Set();
  for (const pkg of manifest.packages) {
    const source = pinned.packages.get(pkg.name);
    if (!source || packageNames.has(pkg.name) || pkg.version !== source.version || pkg.archive !== source.archive || pkg.sha256 !== source.sha256 ||
        !Array.isArray(pkg.licenseFiles) || pkg.licenseTextMissing !== (pkg.licenseFiles.length === 0)) fail('Runtime package differs from the pinned dependency lock.');
    packageNames.add(pkg.name);
    for (const license of pkg.licenseFiles) if (!manifest.files.some(file => file.path === license && file.kind === 'license' && file.package === pkg.name)) fail(`Missing runtime license for ${pkg.name}`);
  }
  if (JSON.stringify(manifest.packages.filter(pkg => pkg.licenseTextMissing).map(pkg => pkg.name)) !== JSON.stringify(manifest.missingLicenseTexts)) fail('Runtime license gap report differs from its package inventory.');
  for (const file of manifest.files) {
    if (!['binary', 'license', 'notices', 'provider', 'config-source', 'generated-config'].includes(file.kind) || (file.kind !== 'notices' && !packageNames.has(file.package))) fail('Invalid runtime file ownership.');
  }
  const needsOpenSsl = manifest.files.some(file => file.path.toLowerCase() === 'bin/libcrypto-3-x64.dll');
  let provider;
  if (needsOpenSsl) {
    if (JSON.stringify(manifest.processEnvironment) !== JSON.stringify(OPENSSL_RUNTIME_ENV) ||
        !manifest.files.some(file => file.path === 'lib/ossl-modules/legacy.dll' && file.kind === 'provider' && file.package === opensslPackage) ||
        !manifest.files.some(file => file.path === OPENSSL_RUNTIME_ENV.OPENSSL_CONF && file.kind === 'generated-config' && file.package === opensslPackage) ||
        !manifest.files.some(file => file.path === 'etc/ssl/openssl.cnf.dist' && file.kind === 'config-source' && file.package === opensslPackage)) fail('Missing required process-scoped OpenSSL provider/configuration.');
    const expectedConfig = activateOpenSslProviders(await fs.readFile(path.join(outputDirectory, 'etc/ssl/openssl.cnf.dist'), 'utf8'));
    if (await fs.readFile(path.join(outputDirectory, OPENSSL_RUNTIME_ENV.OPENSSL_CONF), 'utf8') !== expectedConfig) fail('Generated OpenSSL provider configuration differs from its pinned source.');
    provider = await providerImports(path.join(outputDirectory, 'lib/ossl-modules/legacy.dll'), systemDirectory);
    const record = manifest.files.find(file => file.path === 'lib/ossl-modules/legacy.dll');
    if (JSON.stringify(record.imports) !== JSON.stringify(provider.imports)) fail('OpenSSL provider import manifest mismatch.');
  }
  const closure = await collectPeClosure({ binDirectory: path.join(outputDirectory, 'bin'), systemDirectory, additionalEntries: provider?.entries ?? [] });
  if (provider) addSystemImports(closure, provider.system);
  const binaries = manifest.files.filter(file => file.kind === 'binary');
  if (closure.binaries.length !== binaries.length || JSON.stringify(closure.systemImports) !== JSON.stringify(manifest.systemImports)) fail('Runtime PE dependency closure differs from the manifest.');
  for (const binary of closure.binaries) {
    const record = binaries.find(file => file.path === `bin/${binary.name}`);
    if (!record || !packageNames.has(record.package) || JSON.stringify(record.imports) !== JSON.stringify(binary.imports)) fail(`Runtime binary import manifest mismatch: ${binary.name}`);
  }
  return manifest;
}

export async function smokeFreeRdpRuntime({ outputDirectory, systemDirectory }) {
  const binDirectory = path.resolve(outputDirectory, 'bin'), executable = path.join(binDirectory, 'wfreerdp.exe');
  const env = { ...process.env, PATH: [binDirectory, systemDirectory, path.dirname(systemDirectory)].join(path.delimiter) };
  for (const key of Object.keys(env)) {
    if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
    if (/^(MSYSTEM|OPENSSL_CONF|OPENSSL_MODULES|GIO_MODULE_DIR|GDK_PIXBUF_MODULE_FILE|FREERDP_ADDIN_PATH)$/i.test(key)) delete env[key];
  }
  const manifest = JSON.parse(await fs.readFile(path.join(outputDirectory, 'runtime-manifest.json'), 'utf8'));
  for (const [key, relative] of Object.entries(manifest.processEnvironment ?? {})) env[key] = path.resolve(outputDirectory, relative);
  const results = [];
  for (const option of ['/version', '/buildconfig']) {
    const result = await execute(executable, [option], { cwd: binDirectory, env, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    results.push({ option, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
  }
  return results;
}

async function main() {
  const options = new Map(), flags = new Set();
  for (let index = 2; index < process.argv.length; index++) {
    const name = process.argv[index];
    if (['--verify-only', '--smoke'].includes(name)) flags.add(name);
    else if (['--build-root', '--output', '--lock'].includes(name) && process.argv[index + 1]) options.set(name, path.resolve(process.argv[++index]));
    else fail(`Unknown or incomplete option: ${name}`);
  }
  if (process.platform !== 'win32') fail('FreeRDP native runtime staging requires Windows x64.');
  const buildRoot = options.get('--build-root') ?? path.join(repo, '.build/workbench-freerdp');
  const outputDirectory = options.get('--output') ?? path.join(repo, '.build/workbench-freerdp-runtime');
  const lockPath = options.get('--lock') ?? path.join(repo, 'docs/workbench-freerdp-dependencies.lock.json');
  const windows = process.env.SystemRoot ?? process.env.WINDIR;
  if (!windows) fail('Windows directory is unavailable.');
  const systemDirectory = path.join(windows, 'System32');
  const args = { buildRoot, outputDirectory, lockPath, systemDirectory, tarExecutable: path.join(systemDirectory, 'tar.exe') };
  const manifest = flags.has('--verify-only') ? await verifyFreeRdpRuntime(args) : await stageFreeRdpRuntime(args);
  const smoke = flags.has('--smoke') ? await smokeFreeRdpRuntime(args) : undefined;
  console.log(JSON.stringify({ outputDirectory, binaries: manifest.files.filter(file => file.kind === 'binary').length, packages: manifest.packages.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), verified: true, releaseReady: manifest.releaseReady,
    missingLicenseTexts: manifest.missingLicenseTexts.length, ...(smoke ? { smoke } : {}) }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
