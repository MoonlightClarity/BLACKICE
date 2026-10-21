import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserProfileStore, browserProfileCandidates } from '../lib/browser-profile.mjs';

const execute = promisify(execFile);
const exists = async file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function write(root, relative, text) { const file = path.join(root, ...relative.split('/')); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
async function tree(root) {
  const result = {};
  async function walk(relative = '') {
    for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
      const next = relative ? `${relative}/${name}` : name, file = path.join(root, next), stat = await fs.lstat(file);
      if (stat.isDirectory()) await walk(next);
      else result[next] = stat.isSymbolicLink() ? { link: await fs.readlink(file) } : { size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') };
    }
  }
  await walk(); return result;
}
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-profile-unit-'));
  const userDataDir = path.join(root, 'source'), dataDir = path.join(root, 'store'), executablePath = path.join(root, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
  await fs.mkdir(userDataDir); await fs.writeFile(executablePath, 'synthetic browser executable; never run', { mode: 0o755 });
  const files = {
    'Local State': JSON.stringify({ os_crypt: { encrypted_key: 'synthetic-opaque-key', app_bound_encrypted_key: 'synthetic-opaque-app-key' }, profile: { last_used: 'Default', info_cache: { Default: { name: 'Other' }, 'Profile 2': { name: 'Synthetic selected profile' } } } }),
    'Last Version': '150.0.0.0', 'First Run': '', 'Variations': 'shared root state', 'WidevineCdm/1/component': 'shared installed component',
    'Default/Preferences': '{"other":true}', 'Default/Network/Cookies': 'unselected synthetic cookies',
    'Profile 2/Preferences': '{"profile":{"name":"Synthetic selected profile"}}', 'Profile 2/Secure Preferences': '{"extensions":{"synthetic":true}}',
    'Profile 2/Bookmarks': '{"roots":{"bookmark_bar":{"children":[]}}}', 'Profile 2/History': 'synthetic SQLite bytes',
    'Profile 2/Login Data': 'synthetic encrypted login DB', 'Profile 2/Network/Cookies': Buffer.from([0, 255, 118, 50, 48, 8, 9]),
    'Profile 2/Network/Cookies-wal': 'uncheckpointed data is retained', 'Profile 2/Network/Cookies-shm': 'SQLite shared memory is retained',
    'Profile 2/Local Storage/leveldb/CURRENT': 'MANIFEST-000001\n', 'Profile 2/Local Storage/leveldb/MANIFEST-000001': 'manifest',
    'Profile 2/Local Storage/leveldb/000003.log': 'site storage', 'Profile 2/Local Storage/leveldb/LOCK': '',
    'Profile 2/IndexedDB/site.indexeddb.leveldb/000001.ldb': 'indexed DB', 'Profile 2/File System/000/p/00/00000001': 'file system data',
    'Profile 2/Service Worker/CacheStorage/site/entries': 'offline site data', 'Profile 2/Service Worker/ScriptCache/body': 'offline worker script',
    'Profile 2/Service Worker/Database/CURRENT': 'MANIFEST-000003\n', 'Profile 2/Service Worker/Database/MANIFEST-000003': 'worker registration',
    'Profile 2/Extensions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1.0/manifest.json': '{"manifest_version":3,"name":"Synthetic fixture","version":"1.0"}',
    'Profile 2/Local Extension Settings/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/data': 'extension storage',
    'Profile 2/Sync Data/LevelDB/000002.ldb': 'sync state', 'Profile 2/Sessions/Session_123': 'session tabs',
    'Profile 2/UnknownData/Cache/important': 'a directory name alone is not proof of cache', 'Profile 2/UnknownData/LOCK': 'not a proven LevelDB lock',
    'Profile 2/Cache/Cache_Data/cache': 'ordinary disk cache', 'Profile 2/Code Cache/js/code': 'compiled code cache', 'ShaderCache/cache': 'root GPU cache',
    'DevToolsActivePort': '12345\n/devtools/browser/stale', 'Crashpad/reports/retained': 'not a cache',
  };
  for (const [relative, text] of Object.entries(files)) await write(userDataDir, relative, text);
  const input = { browser: 'chrome', userDataDir, profileDirectory: 'Profile 2', executablePath };
  const store = new BrowserProfileStore({ dataDir, ...overrides });
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, userDataDir, dataDir, executablePath, input, store, files };
}

test('whole selected profile and shared root state are byte-preserved without changing the source', async t => {
  const f = await fixture(t), before = await tree(f.userDataDir);
  const imported = await f.store.import(f.input);
  assert.match(imported.id, /^browser-profile-[a-f0-9]{16}$/); assert.ok(imported.id.length <= 40);
  assert.equal(imported.profileDirectory, 'Profile 2'); assert.equal(imported.profileName, 'Synthetic selected profile');
  assert.equal(imported.executablePath, f.executablePath); assert.notEqual(imported.userDataDir, f.userDataDir);
  assert.match(imported.snapshot, /^[a-f0-9]{24}$/); assert.equal(imported.version, 2);
  assert.equal(imported.userDataDir, path.join(f.dataDir, 'bp', imported.snapshot));
  assert.equal(path.relative(imported.userDataDir, imported.manifestPath).startsWith('..'), true);
  assert.equal(imported.available, true); assert.equal(imported.authentication, 'unverified'); assert.equal(imported.state, 'ready');
  assert.deepEqual(await tree(f.userDataDir), before);
  const expectedOmissions = [
    { path: 'Default', reason: 'unselected-profile' }, { path: 'DevToolsActivePort', reason: 'process-state' },
    { path: 'Profile 2/Cache', reason: 'cache' }, { path: 'Profile 2/Code Cache', reason: 'cache' },
    { path: 'Profile 2/Local Storage/leveldb/LOCK', reason: 'process-state' }, { path: 'ShaderCache', reason: 'cache' },
  ];
  assert.deepEqual(imported.omitted, expectedOmissions);
  const included = Object.entries(f.files).filter(([relative]) => !expectedOmissions.some(entry => relative === entry.path || relative.startsWith(`${entry.path}/`)));
  for (const [relative, bytes] of included) assert.deepEqual(await fs.readFile(path.join(imported.userDataDir, relative)), Buffer.from(bytes), relative);
  for (const omission of imported.omitted) assert.equal(await exists(path.join(imported.userDataDir, omission.path)), false, omission.path);
  assert.equal(imported.files, included.length); assert.equal(imported.bytes, included.reduce((sum, [, bytes]) => sum + Buffer.byteLength(bytes), 0));
  const manifest = JSON.parse(await fs.readFile(imported.manifestPath, 'utf8'));
  assert.equal(manifest.entries.filter(entry => entry.type === 'file').length, included.length);
  assert.ok(manifest.entries.filter(entry => entry.type === 'file').every(entry => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.deepEqual(await f.store.status(imported.id), imported); assert.deepEqual(await f.store.list(), [imported]);
});

test('compact runtime paths leave room for native Windows IndexedDB and CacheStorage filenames', () => {
  for (const dataDir of [
    'C:\\Users\\iris\\AppData\\Roaming\\Relay\\data',
    'C:\\Users\\iris\\AppData\\Local\\Temp\\blackice-profile-smoke-123456\\BLACKICE disposable data',
  ]) {
    const store = new BrowserProfileStore({ dataDir, platform: 'win32' });
    const nativeRoot = path.win32.join(store.snapshotsDir, 'a'.repeat(24));
    assert.equal(path.win32.relative(dataDir, nativeRoot), 'bp\\' + 'a'.repeat(24));
    const cache = path.win32.join(nativeRoot, 'Profile 2', 'Service Worker', 'CacheStorage', 'b'.repeat(40), '12345678-1234-4234-8234-123456789012', 'index');
    const indexed = path.win32.join(nativeRoot, 'Profile 2', 'IndexedDB', 'http_127.0.0.1_65535.indexeddb.leveldb', 'MANIFEST-000001');
    assert.ok(cache.length < 250, `CacheStorage path would use ${cache.length} characters`);
    assert.ok(indexed.length < 250, `IndexedDB path would use ${indexed.length} characters`);
    assert.ok(path.win32.join(nativeRoot, 'Profile 2').length < 135);
  }
});

test('legacy v1 snapshot records remain usable and refresh into compact v2 without moving the old copy', async t => {
  const f = await fixture(t), created = await f.store.import(f.input);
  const legacySnapshot = created.id + '-12345678-1234-4234-8234-123456789012';
  const legacyRoot = path.join(f.store.root, 'snapshots', legacySnapshot), legacyData = path.join(legacyRoot, 'user-data');
  await fs.mkdir(legacyRoot, { recursive: true }); await fs.rename(created.userDataDir, legacyData);
  await fs.rename(created.manifestPath, path.join(legacyRoot, 'manifest.json'));
  const legacy = { ...created, version: 1, snapshot: legacySnapshot, userDataDir: legacyData }; delete legacy.manifestPath;
  await fs.writeFile(path.join(f.store.importsDir, created.id + '.json'), JSON.stringify(legacy));
  assert.equal((await f.store.status(created.id)).available, true);
  assert.ok((await f.store.connection(created.id)).args.includes('--userDataDir=' + legacyData));
  const compact = await f.store.import(f.input);
  assert.equal(compact.version, 2); assert.equal(compact.id, created.id); assert.equal(compact.previousSnapshot, legacyData); assert.equal(await exists(legacyData), true);
  assert.equal(compact.userDataDir, path.join(f.dataDir, 'bp', compact.snapshot));
});

test('compact record validation keeps source identity, revision, runtime root and manifest ownership bound', async t => {
  const f = await fixture(t), record = await f.store.import(f.input);
  for (const tampered of [
    { ...record, snapshot: '../outside' }, { ...record, userDataDir: f.userDataDir },
    { ...record, manifestPath: path.join(f.root, 'outside.json') },
    { ...record, source: { ...record.source, userDataDir: path.join(f.root, 'different-source') } },
    { ...record, manifestPath: path.join(f.store.manifestsDir, 'browser-profile-0000000000000000', record.snapshot + '.json') },
  ]) assert.throws(() => f.store.validateRecord(tampered), error => error.code === 'BROWSER_PROFILE_METADATA' || error.code === 'BROWSER_PROFILE_PATH');
});

test('an imported compact runtime cannot be imported into its own store', async t => {
  const f = await fixture(t), imported = await f.store.import(f.input), before = await tree(imported.userDataDir);
  await assert.rejects(f.store.import({ ...f.input, userDataDir: imported.userDataDir }), { code: 'BROWSER_PROFILE_PATH' });
  assert.deepEqual(await f.store.status(imported.id), imported);
  assert.deepEqual(await tree(imported.userDataDir), before);
});

test('a staging directory collision preserves the directory this import did not create', async t => {
  const f = await fixture(t), imported = await f.store.import(f.input);
  let collided;
  f.store.io = { ...fs, async mkdir(directory, options) {
    if (path.basename(directory).startsWith('.stage-')) {
      collided = directory;
      await fs.mkdir(directory, options); await fs.writeFile(path.join(directory, 'owned-by-another-operation'), 'retain me');
      throw Object.assign(new Error('Synthetic staging collision'), { code: 'EEXIST' });
    }
    return fs.mkdir(directory, options);
  } };
  await assert.rejects(f.store.import(f.input), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(collided, 'owned-by-another-operation'), 'utf8'), 'retain me');
  assert.deepEqual(await f.store.status(imported.id), imported);
});

test('generated official MCP configuration selects the original executable and exact imported profile', async t => {
  const f = await fixture(t), imported = await f.store.import(f.input), config = await f.store.connection(imported.id);
  assert.equal(config.id, imported.id); assert.equal(config.transport, 'stdio'); assert.equal(config.enabled, true); assert.equal(config.command, 'npx');
  assert.equal(config.timeoutMs, 60000); assert.equal(config.args[1], 'chrome-devtools-mcp@latest');
  for (const flag of [`--executablePath=${f.executablePath}`, `--userDataDir=${imported.userDataDir}`, '--chromeArg=--profile-directory=Profile 2', '--no-usage-statistics', '--no-performance-crux']) assert.ok(config.args.includes(flag), flag);
  for (const arg of ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--password-store=basic', '--use-mock-keychain', '--disable-sync', '--disable-background-networking', '--disable-client-side-phishing-detection', '--disable-ipc-flooding-protection']) assert.ok(config.args.includes(`--ignoreDefaultChromeArg=${arg}`), arg);
  assert.equal(config.args.some(arg => /^(--autoConnect|--channel|--isolated|--headless|--acceptInsecureCerts|--no-sandbox)(?:=|$)/.test(arg)), false);
  const hidden = await f.store.connection(imported.id, { command: 'npx.cmd', headless: true, timeoutMs: 90000 });
  assert.equal(hidden.command, 'npx.cmd'); assert.equal(hidden.timeoutMs, 90000); assert.ok(hidden.args.includes('--headless=true'));
});

test('refresh publishes a new immutable snapshot and retains the entire previous one', async t => {
  const f = await fixture(t), first = await f.store.import(f.input), oldTree = await tree(first.userDataDir);
  await write(f.userDataDir, 'Profile 2/Bookmarks', 'updated synthetic bookmarks');
  const second = await f.store.import(f.input);
  assert.equal(second.id, first.id); assert.notEqual(second.userDataDir, first.userDataDir); assert.equal(second.previousSnapshot, first.userDataDir);
  assert.deepEqual(await tree(first.userDataDir), oldTree); assert.equal(await fs.readFile(path.join(second.userDataDir, 'Profile 2/Bookmarks'), 'utf8'), 'updated synthetic bookmarks');
  assert.deepEqual(await f.store.list(), [second]); assert.deepEqual((await f.store.connection(first.id)).args.filter(arg => arg.startsWith('--userDataDir=')), [`--userDataDir=${second.userDataDir}`]);
});

test('every native source singleton marker blocks import and preserves an existing snapshot', async t => {
  const f = await fixture(t), first = await f.store.import(f.input), before = await tree(first.userDataDir);
  for (const marker of ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await write(f.userDataDir, marker, 'synthetic running marker');
    await assert.rejects(f.store.import(f.input), { code: 'BROWSER_PROFILE_SOURCE_BUSY', status: 409 });
    assert.deepEqual(await f.store.status(first.id), first); assert.deepEqual(await tree(first.userDataDir), before);
    await fs.unlink(path.join(f.userDataDir, marker));
  }
});

test('source mutation, topology changes, and a late native lock prevent publication', async t => {
  for (const [phase, mutate, code] of [
    ['entry-copied', f => write(f.userDataDir, 'Profile 2/History', 'mutated source'), 'BROWSER_PROFILE_CHANGED'],
    ['entry-copied', f => write(f.userDataDir, 'Profile 2/new-file', 'late source entry'), 'BROWSER_PROFILE_CHANGED'],
    ['before-publish', f => write(f.userDataDir, 'Profile 2/Preferences', 'late source change'), 'BROWSER_PROFILE_CHANGED'],
    ['before-pointer', f => write(f.userDataDir, 'lockfile', 'source reopened'), 'BROWSER_PROFILE_SOURCE_BUSY'],
  ]) {
    await t.test(`${phase}: ${code}`, async t => {
      const f = await fixture(t), first = await f.store.import(f.input), before = await tree(first.userDataDir); let changed = false;
      f.store.fault = async current => { if (current === phase && !changed) { changed = true; await mutate(f); } };
      await assert.rejects(f.store.import(f.input), { code });
      assert.deepEqual(await f.store.status(first.id), first); assert.deepEqual(await tree(first.userDataDir), before);
      assert.deepEqual(await fs.readdir(f.store.snapshotsDir), [first.snapshot]);
    });
  }
});

test('copy failure, metadata publication failure, and cancellation preserve the old import', async t => {
  for (const failure of ['copy', 'pointer', 'abort']) await t.test(failure, async t => {
    const f = await fixture(t), first = await f.store.import(f.input), oldTree = await tree(first.userDataDir), controller = new AbortController();
    if (failure === 'copy') f.store.fault = async phase => { if (phase === 'entry-copied') throw Object.assign(new Error('Synthetic disk failure'), { code: 'EIO' }); };
    if (failure === 'pointer') f.store.io = { ...fs, rename: async (from, to) => { if (to === path.join(f.store.importsDir, `${first.id}.json`)) throw Object.assign(new Error('Synthetic rename failure'), { code: 'EIO' }); return fs.rename(from, to); } };
    if (failure === 'abort') f.store.fault = async phase => { if (phase === 'before-pointer') controller.abort(); };
    await assert.rejects(f.store.import({ ...f.input, signal: controller.signal }), { code: failure === 'abort' ? 'ABORT_ERR' : 'EIO' });
    assert.deepEqual(await f.store.status(first.id), first); assert.deepEqual(await tree(first.userDataDir), oldTree);
    assert.deepEqual(await fs.readdir(f.store.snapshotsDir), [first.snapshot]); assert.deepEqual(await fs.readdir(f.store.locksDir), []);
    assert.deepEqual(await fs.readdir(f.store.importsDir), [`${first.id}.json`]);
  });
});

test('an abrupt exit before pointer publication preserves the old import and permits lock recovery', async t => {
  const f = await fixture(t), first = await f.store.import(f.input);
  const module = new URL('../lib/browser-profile.mjs', import.meta.url).href;
  const script = `import {BrowserProfileStore} from ${JSON.stringify(module)};const store=new BrowserProfileStore({dataDir:${JSON.stringify(f.dataDir)},fault:async phase=>{if(phase==='before-pointer')process.exit(71);}});await store.import(${JSON.stringify(f.input)});process.exit(72);`;
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', script], { timeout: 20000 }), error => error.code === 71);
  assert.deepEqual(await f.store.status(first.id), first);
  const recovered = await f.store.import(f.input);
  assert.equal(recovered.id, first.id); assert.notEqual(recovered.snapshot, first.snapshot); assert.equal(await exists(first.userDataDir), true);
  assert.deepEqual(await fs.readdir(f.store.locksDir), []);
});

test('concurrent import ownership is enforced across store instances, and close drains admitted work', async t => {
  const entered = deferred(), release = deferred(); let blocked = false;
  const f = await fixture(t, { fault: async phase => { if (phase === 'entry-copied' && !blocked) { blocked = true; entered.resolve(); await release.promise; } } });
  const other = new BrowserProfileStore({ dataDir: f.dataDir });
  const importing = f.store.import(f.input); await entered.promise;
  await assert.rejects(other.import(f.input), { code: 'BROWSER_PROFILE_BUSY' });
  await assert.rejects(f.store.import(f.input), { code: 'BROWSER_PROFILE_BUSY' });
  let closed = false; const closing = f.store.close().then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  await assert.rejects(f.store.import(f.input), { code: 'BROWSER_PROFILE_CLOSED' });
  release.resolve(); const imported = await importing; await closing; assert.equal(closed, true); assert.equal((await other.status(imported.id)).available, true); await other.close();
});

test('links, traversal, missing metadata, and overlapping destinations fail without publishing', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.import({ ...f.input, profileDirectory: '../outside' }), { code: 'BROWSER_PROFILE_PATH' });
  await assert.rejects(f.store.import({ ...f.input, userDataDir: 'relative' }), { code: 'BROWSER_PROFILE_PATH' });
  await assert.rejects(f.store.import({ ...f.input, profileDirectory: 'Absent' }), { code: 'BROWSER_PROFILE_SOURCE_MISSING', status: 404 });
  await assert.rejects(f.store.import({ ...f.input, executablePath: path.join(f.root, 'absent-browser') }), { code: 'BROWSER_PROFILE_EXECUTABLE_MISSING', status: 404 });
  const overlapping = new BrowserProfileStore({ dataDir: path.join(f.userDataDir, 'nested-store') });
  await assert.rejects(overlapping.import(f.input), { code: 'BROWSER_PROFILE_PATH' }); assert.equal(await exists(overlapping.dataDir), false);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await write(outside, 'data', 'outside data');
  try { await fs.symlink(outside, path.join(f.userDataDir, 'Profile 2', 'linked-data'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('This test process cannot create a synthetic junction.'); throw error; }
  await assert.rejects(f.store.import(f.input), { code: 'BROWSER_PROFILE_UNSAFE_PATH' });
  assert.deepEqual(await f.store.list(), []); assert.equal(await fs.readFile(path.join(outside, 'data'), 'utf8'), 'outside data');
  await fs.unlink(path.join(f.userDataDir, 'Profile 2', 'linked-data')); await fs.unlink(path.join(f.userDataDir, 'Local State'));
  await assert.rejects(f.store.import(f.input), { code: 'BROWSER_PROFILE_SOURCE_MISSING' });
});

test('unknown custom profiles are omitted while arbitrary nested names and site caches are preserved', async t => {
  const f = await fixture(t);
  await write(f.userDataDir, 'Custom Identity/Preferences', '{}'); await write(f.userDataDir, 'Custom Identity/data', 'other profile');
  await write(f.userDataDir, 'Profile 9', 'a regular file is not a profile directory'); await write(f.userDataDir, 'Profile 2/GPUCache', 'a regular file is not a cache directory');
  const record = await f.store.import(f.input);
  assert.ok(record.omitted.some(entry => entry.path === 'Custom Identity' && entry.reason === 'unselected-profile'));
  for (const relative of ['Profile 9', 'Profile 2/GPUCache', 'Profile 2/UnknownData/Cache/important', 'Profile 2/UnknownData/LOCK', 'Profile 2/Service Worker/CacheStorage/site/entries', 'Profile 2/Network/Cookies-wal', 'Profile 2/Network/Cookies-shm']) assert.equal(await exists(path.join(record.userDataDir, relative)), true, relative);
});

test('status and connection read the imported snapshot only, and fail honestly for missing executable or copy', async t => {
  const f = await fixture(t); assert.deepEqual(await f.store.list(), []);
  assert.equal(await f.store.status('browser-profile-0000000000000000'), null);
  await assert.rejects(f.store.connection('browser-profile-0000000000000000'), { code: 'BROWSER_PROFILE_NOT_FOUND' });
  const imported = await f.store.import(f.input); await fs.rm(f.userDataDir, { recursive: true });
  assert.equal((await f.store.status(imported.id)).available, true); assert.equal((await f.store.connection(imported.id)).id, imported.id);
  await fs.unlink(f.executablePath); assert.equal((await f.store.status(imported.id)).available, false);
  await assert.rejects(f.store.connection(imported.id), { code: 'BROWSER_PROFILE_UNAVAILABLE' });
});

test('Windows discovery covers Chrome, Edge, Brave and Neo with metadata-only selection and lock status', async () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  const candidates = browserProfileCandidates({ platform: 'win32', env }); assert.deepEqual(candidates.map(item => item.browser), ['chrome', 'edge', 'brave', 'neo']);
  const files = new Map(), directories = new Map(), touched = [];
  for (const candidate of candidates) {
    directories.set(candidate.userDataDir, ['Local State', 'Default', 'Profile 2', 'System Profile']);
    for (const name of ['Default', 'Profile 2', 'System Profile']) directories.set(path.win32.join(candidate.userDataDir, name), []);
    files.set(path.win32.join(candidate.userDataDir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Primary', user_name: 'synthetic@example.invalid' }, 'Profile 2': { name: 'Second' } } } }));
    files.set(candidate.executablePaths[0], 'executable');
  }
  files.set(path.win32.join(candidates[0].userDataDir, 'lockfile'), 'running');
  const io = {
    lstat: async location => { touched.push(location); if (!files.has(location) && !directories.has(location)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { isFile: () => files.has(location), isDirectory: () => directories.has(location), isSymbolicLink: () => false, size: Buffer.byteLength(files.get(location) || '') }; },
    realpath: async location => location,
    readFile: async location => { assert.ok(location.endsWith('Local State'), 'Only profile name metadata is read during discovery'); return files.get(location); },
    readdir: async location => directories.get(location),
    mkdir: () => assert.fail('Discovery must not create a store or a source file'),
  };
  const store = new BrowserProfileStore({ dataDir: 'C:\\Fixture\\Blackice', platform: 'win32', env, io });
  const discovered = await store.discover(); assert.equal(discovered.sources.length, 8); assert.deepEqual(discovered.imports, []);
  assert.equal(discovered.sources.filter(item => item.locked).length, 2); assert.ok(discovered.sources.filter(item => item.browser === 'chrome').every(item => item.importable === false));
  assert.ok(discovered.sources.every(item => item.id.length <= 40 && item.profileDirectory !== 'System Profile'));
  assert.doesNotMatch(JSON.stringify(discovered), /synthetic@example|os_crypt/); assert.equal(touched.some(item => /Cookies|Login Data|Extensions/.test(item)), false);
});

test('platform discovery supports ordinary macOS and Linux locations without guessing unavailable Neo paths', () => {
  const linux = browserProfileCandidates({ platform: 'linux', env: { XDG_CONFIG_HOME: '/fixture/config' }, homeDir: '/fixture' });
  assert.equal(linux.find(item => item.browser === 'chrome').userDataDir, '/fixture/config/google-chrome');
  assert.equal(linux.find(item => item.browser === 'brave').userDataDir, '/fixture/config/BraveSoftware/Brave-Browser');
  const mac = browserProfileCandidates({ platform: 'darwin', env: {}, homeDir: '/Users/fixture' });
  assert.ok(mac.find(item => item.browser === 'edge').executablePaths.includes('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
  assert.deepEqual(browserProfileCandidates({ platform: 'win32', env: {} }), []);
});
