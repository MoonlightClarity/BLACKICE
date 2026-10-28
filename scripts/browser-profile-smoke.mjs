/**
 * Native Windows profile-fidelity smoke. Run with Node 22+, never the installed
 * BLACKICE app. All browser state is created in a new disposable directory.
 *
 * node scripts/browser-profile-smoke.mjs --executable=<chrome.exe>
 *   --mcp-entry=<cached chrome-devtools-mcp build/src/index.js>
 *   --output=<absolute report.json outside the source checkout>
 * Optional: --source=<checkout> --keep
 *
 * No discovery of real profiles, credential decryption, site sign-in, browser
 * restart, or Internet navigation occurs. The official MCP entry must already
 * be installed; this fixture never invokes npx or downloads a package.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
if (process.argv.includes('--help')) {
  console.log('node scripts/browser-profile-smoke.mjs --executable=<absolute chrome.exe> --mcp-entry=<absolute cached MCP entry.js> --output=<absolute report outside source> [--source=<checkout>] [--keep]');
  process.exit(0);
}
const source = path.resolve(option('source') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const executablePath = option('executable'), mcpEntry = option('mcp-entry'), output = option('output');
for (const [name, value] of Object.entries({ executable: executablePath, 'mcp-entry': mcpEntry, output })) {
  if (!value || !path.isAbsolute(value)) throw Error(`Supply --${name}=<absolute path>.`);
}
const reportPath = path.resolve(output), relativeReport = path.relative(source, reportPath);
if (!relativeReport || (!relativeReport.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeReport))) throw Error('Keep machine-specific evidence outside the source checkout.');
if (process.platform !== 'win32') throw Error('This native profile smoke must run on Windows. No profile was opened.');
if (typeof WebSocket !== 'function') throw Error('Node 22 or newer with WebSocket support is required.');
for (const file of [executablePath, mcpEntry]) if (!(await fs.stat(file)).isFile()) throw Error(`Required executable/entry is not a file: ${file}`);

const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-profile-smoke-'));
const userDataDir = path.join(root, 'Synthetic source with spaces');
const profileDirectory = 'Profile 2';
const selectedSource = path.join(userDataDir, profileDirectory);
const nonce = randomUUID(), marker = 'BLACKICE_DISPOSABLE_PROFILE_SMOKE_V1';
const keep = process.argv.includes('--keep');
const report = {
  format: 2, suite: 'browser-profile-native', source, platform: process.platform, node: process.versions.node,
  startedAt: new Date().toISOString(), actualUserProfileAccessed: false, actualCredentialRequests: 0,
  fixtureURLsAreLoopbackOnly: true, sourceProfileCreatedByFixture: true,
  syntheticProfileDirectory: profileDirectory, launchPath: 'official-chrome-devtools-mcp',
  realAppBoundLoginPortabilityTested: false, extensionExecutionTested: false,
  stages: [], checks: [], failures: [], observations: {},
};
let server, origin, sourceChild, sourceCdp, client, mcpChild, cleanupPromise, finished = false;
const sockets = new Set();
async function save() { await fs.mkdir(path.dirname(reportPath), { recursive: true }); await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
async function stage(name) { report.stage = name; report.stages.push({ name, at: new Date().toISOString() }); await save(); console.log(`[profile-smoke] ${name}`); }
function verify(label, check) {
  try { check(); report.checks.push(label); }
  catch (error) { report.failures.push({ label, error: error.message }); }
}
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function deadline(work, milliseconds, label) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function poll(read, label, milliseconds = 15000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { const value = await read(); if (value) return value; await wait(100); }
  throw Error(`${label} timed out`);
}
const sha256 = value => createHash('sha256').update(value).digest('hex');

class CDP {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(Error(message.error.message)); else pending.resolve(message.result || {});
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('Disposable Chrome CDP connection closed.')); }
      this.pending.clear();
    });
  }
  static async open(url) {
    const socket = new WebSocket(url);
    await deadline(new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(Error('Disposable Chrome CDP connection failed.')), { once: true });
    }), 10000, 'CDP connection');
    return new CDP(socket);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP ${method} timed out`)); }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.socket.close(); }
}

// This page and worker belong only to the loopback fixture. No cookie contents
// are returned: the server reports whether its own synthetic cookie arrived.
function fixtureBootstrap(expected, evidenceMarker) {
  const dbName = 'blackice-profile-smoke-db', cacheName = 'blackice-profile-smoke-cache';
  const request = operation => new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error || Error('IndexedDB request failed'));
  });
  async function seed() {
    localStorage.setItem('blackice-profile-smoke', expected);
    sessionStorage.setItem('blackice-profile-smoke', expected);
    const opening = indexedDB.open(dbName, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('values');
    const db = await request(opening), transaction = db.transaction('values', 'readwrite');
    const committed = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || Error('IndexedDB transaction aborted'));
    });
    transaction.objectStore('values').put(expected, 'marker'); await committed; db.close();
    const cache = await caches.open(cacheName); await cache.put('/cached-marker', new Response(expected));
    await navigator.serviceWorker.register('/smoke-worker.js'); await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Service worker did not take control')), 7000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    return read();
  }
  async function read() {
    const databases = await indexedDB.databases(); let indexedDBPreserved = false;
    if (databases.some(db => db.name === dbName)) {
      const db = await request(indexedDB.open(dbName));
      indexedDBPreserved = await request(db.transaction('values').objectStore('values').get('marker')) === expected; db.close();
    }
    const cacheNames = await caches.keys();
    const cached = await caches.match('/cached-marker', { cacheName });
    const worker = await navigator.serviceWorker.getRegistration('/');
    const workerReply = await fetch('/worker-marker', { cache: 'no-store' }).then(response => response.text());
    const cookiePreserved = await fetch('/cookie-status', { cache: 'no-store', credentials: 'include' }).then(response => response.json());
    return {
      marker: evidenceMarker, origin: location.origin, cookiePreserved: cookiePreserved.present === true,
      localStoragePreserved: localStorage.getItem('blackice-profile-smoke') === expected,
      indexedDBPreserved, cacheStoragePreserved: !!cached && await cached.text() === expected,
      serviceWorkerRegistrationPreserved: !!worker?.active,
      serviceWorkerControlsPage: !!navigator.serviceWorker.controller,
      serviceWorkerResponsePreserved: workerReply === expected,
      databaseNames: databases.map(database => database.name), cacheNames,
      storageEstimate: await navigator.storage.estimate(),
    };
  }
  globalThis.BLACKICEProfileSmoke = { seed, read };
}

async function startFixture() {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, origin || 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/cookie-status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ present: String(req.headers.cookie || '').split(/;\s*/).includes(`blackice_smoke_cookie=${nonce}`) })); return;
    }
    if (url.pathname === '/smoke-worker.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(`self.addEventListener('install', event => event.waitUntil(self.skipWaiting())); self.addEventListener('activate', event => event.waitUntil(self.clients.claim())); self.addEventListener('fetch', event => { if (new URL(event.request.url).pathname === '/worker-marker') event.respondWith(Promise.resolve(new Response(${JSON.stringify(nonce)}))); });`); return;
    }
    if (url.pathname === '/worker-marker') { res.end('network-fallback'); return; }
    if (!['/seed', '/verify'].includes(url.pathname)) { res.statusCode = 404; res.end('Fixture route not found'); return; }
    if (url.pathname === '/seed') res.setHeader('Set-Cookie', `blackice_smoke_cookie=${nonce}; HttpOnly; Max-Age=604800; Path=/; SameSite=Lax`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>BLACKICE disposable profile fixture</title><h1>Disposable local profile fixture</h1><button id="vision-fixture" style="position:fixed;left:100px;top:100px;width:120px;height:80px">Vision fixture</button><script>window.visionFixture={count:0,trusted:false};document.querySelector('#vision-fixture').addEventListener('click',e=>{window.visionFixture.count++;window.visionFixture.trusted=e.isTrusted});(${fixtureBootstrap.toString()})(${JSON.stringify(nonce)},${JSON.stringify(marker)})</script>`);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
}

async function launchSource({ profileRoot = userDataDir, seed = true, label = 'source' } = {}) {
  const relative = path.relative(root, path.resolve(profileRoot));
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Native control must use a disposable profile created inside this fixture');
  await fs.mkdir(profileRoot, { recursive: true });
  // A clean prior shutdown may leave its obsolete debugging endpoint file.
  // Only this fixture-owned metadata is removed; never a browser lock.
  await fs.rm(path.join(profileRoot, 'DevToolsActivePort'), { force: true });
  const route = seed ? 'seed' : 'verify';
  const args = [`--user-data-dir=${profileRoot}`, `--profile-directory=${profileDirectory}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `${origin}/${route}`];
  sourceChild = spawn(executablePath, args, { shell: false, windowsHide: true, stdio: 'ignore' });
  let launchError;
  sourceChild.on('error', error => { launchError = error; });
  const endpoint = await poll(async () => {
    if (launchError) throw launchError;
    if (sourceChild.exitCode !== null) throw Error(`Disposable Chrome exited before CDP became available (${sourceChild.exitCode}).`);
    const value = await fs.readFile(path.join(profileRoot, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const [port, pathname] = value.trim().split(/\r?\n/);
    return /^\d+$/.test(port || '') && /^\/devtools\/browser\//.test(pathname || '') ? `ws://127.0.0.1:${port}${pathname}` : null;
  }, 'Disposable Chrome launch', 25000);
  sourceCdp = await CDP.open(endpoint);
  const browserVersion = await sourceCdp.send('Browser.getVersion');
  if (seed) report.observations.browserVersion = browserVersion;
  report.observations[`${label}NativeLaunch`] = { browserVersion, arguments: args };
  const target = await poll(async () => (await sourceCdp.send('Target.getTargets')).targetInfos.find(item => item.type === 'page' && item.url === `${origin}/${route}`), `Loopback ${route} page`);
  const { sessionId } = await sourceCdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await poll(async () => {
    const result = await sourceCdp.send('Runtime.evaluate', { expression: 'typeof globalThis.BLACKICEProfileSmoke === "object"', returnByValue: true }, sessionId);
    return result.result?.value === true;
  }, 'Fixture script');
  const seeded = await sourceCdp.send('Runtime.evaluate', { expression: `globalThis.BLACKICEProfileSmoke.${seed ? 'seed' : 'read'}()`, awaitPromise: true, returnByValue: true }, sessionId);
  if (seeded.exceptionDetails) {
    report.observations[`${label}EvaluationError`] = seeded.exceptionDetails;
    const detail = seeded.exceptionDetails.exception?.description || seeded.exceptionDetails.exception?.value || seeded.exceptionDetails.text;
    throw Error(`${seed ? 'Seeding' : 'Reading'} ${label} failed: ${String(detail)}`);
  }
  return seeded.result.value;
}

async function stopSource() {
  if (!sourceChild) return;
  const child = sourceChild, closed = child.exitCode === null ? once(child, 'exit').catch(() => {}) : Promise.resolve();
  if (sourceCdp) await sourceCdp.send('Browser.close').catch(() => {});
  await deadline(closed, 10000, 'Disposable source clean shutdown');
  sourceCdp?.close(); sourceCdp = null;
  child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); sourceChild = null;
}

async function seedStaticFiles() {
  const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const entries = {
    [`Extensions/${extensionId}/1.0.0/manifest.json`]: JSON.stringify({ manifest_version: 3, name: 'BLACKICE synthetic file fidelity fixture', version: '1.0.0' }),
    [`Local Extension Settings/${extensionId}/blackice-smoke-marker`]: nonce,
    [`Extension State/blackice-smoke-marker`]: nonce,
    ['Bookmarks']: JSON.stringify({ checksum: '', roots: { bookmark_bar: { children: [{ date_added: '0', guid: randomUUID(), id: '1', name: 'Disposable fixture', type: 'url', url: `${origin}/verify` }], date_added: '0', date_modified: '0', guid: randomUUID(), id: '0', name: 'Bookmarks bar', type: 'folder' }, other: { children: [], date_added: '0', date_modified: '0', guid: randomUUID(), id: '2', name: 'Other bookmarks', type: 'folder' }, synced: { children: [], date_added: '0', date_modified: '0', guid: randomUUID(), id: '3', name: 'Mobile bookmarks', type: 'folder' } }, version: 1 }),
  };
  for (const [relative, content] of Object.entries(entries)) {
    const file = path.join(selectedSource, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  }
  return Object.keys(entries);
}

async function inventory(directory) {
  const files = {};
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name), file = path.join(directory, name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files[name.split(path.sep).join('/')] = sha256(await fs.readFile(file));
      else throw Error(`Unexpected link/special file in disposable profile: ${name}`);
    }
  }
  await walk(); return files;
}
function checkState(label, state) {
  verify(`${label}: correct loopback fixture`, () => { assert.equal(state.marker, marker); assert.equal(state.origin, origin); });
  for (const key of ['cookiePreserved', 'localStoragePreserved', 'indexedDBPreserved', 'cacheStoragePreserved', 'serviceWorkerRegistrationPreserved', 'serviceWorkerControlsPage', 'serviceWorkerResponsePreserved']) {
    verify(`${label}: ${key}`, () => assert.equal(state[key], true));
  }
}
function resultText(result) { return (result?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n'); }
function findEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.marker === marker) return value;
  for (const child of Object.values(value)) { const match = findEvidence(child); if (match) return match; }
  return null;
}
function parseEvidence(result) {
  const structured = findEvidence(result?.structuredContent); if (structured) return structured;
  const text = resultText(result), candidates = [text, ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1])];
  for (const candidate of candidates) { try { const found = findEvidence(JSON.parse(candidate)); if (found) return found; } catch {} }
  throw Error('The official evaluate_script response did not contain the disposable fixture evidence.');
}

async function importedState(connection, MCPClient) {
  const packageIndex = connection.args.findIndex(value => /^chrome-devtools-mcp(?:@[^\s]+)?$/.test(value));
  assert.notEqual(packageIndex, -1, 'The generated config must use the official MCP package');
  const args = connection.args.slice(packageIndex + 1);
  client = new MCPClient({ config: { ...connection, command: process.execPath, args: [mcpEntry, ...args], timeoutMs: 60000 }, secrets: { env: { CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1', CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' } } });
  await client.start();
  mcpChild = client.child;
  report.observations.mcpServer = client.serverInfo;
  for (const name of ['new_page', 'list_pages', 'evaluate_script']) assert.ok(client.tools.some(tool => tool.name === name), `Official MCP tool ${name} is missing`);
  const newPage = client.tools.find(tool => tool.name === 'new_page');
  const opened = await client.call('new_page', { url: `${origin}/verify`, ...(newPage.inputSchema?.properties?.background ? { background: true } : {}) });
  if (opened.isError) throw Error(`Opening disposable imported page failed: ${resultText(opened)}`);
  const evaluate = client.tools.find(tool => tool.name === 'evaluate_script');
  const argumentsForEvaluation = { function: 'async () => { if (!globalThis.BLACKICEProfileSmoke) throw new Error("Disposable fixture is not loaded"); return await globalThis.BLACKICEProfileSmoke.read(); }' };
  if (evaluate.inputSchema?.properties?.pageId || evaluate.inputSchema?.required?.includes('pageId')) {
    const listing = await client.call('list_pages', {});
    const line = resultText(listing).split('\n').find(value => value.includes(`${origin}/verify`));
    const pageId = line?.match(/^\s*(\d+)\s*:/)?.[1];
    if (!pageId) throw Error('Cannot identify the disposable page in the official list_pages response.');
    argumentsForEvaluation.pageId = Number(pageId);
  }
  const result = await client.call('evaluate_script', argumentsForEvaluation);
  if (result.isError) throw Error(`Reading disposable imported state failed: ${resultText(result)}`);
  const restored = parseEvidence(result);
  for (const name of ['take_screenshot', 'click_at']) assert.ok(client.tools.some(tool => tool.name === name), `Vision tool ${name} is missing`);
  const pageArgs = argumentsForEvaluation.pageId === undefined ? {} : { pageId: argumentsForEvaluation.pageId };
  const shot = await client.call('take_screenshot', pageArgs);
  assert.ok(!shot.isError && shot.content?.some(item => item.type === 'image'), 'The same imported page must return a screenshot');
  const geometry = await client.call('evaluate_script', { ...pageArgs, function: `() => { const r=document.querySelector('#vision-fixture').getBoundingClientRect(); return {marker:${JSON.stringify(marker)},x:r.left+r.width/2,y:r.top+r.height/2,width:innerWidth,height:innerHeight}; }` });
  if (geometry.isError) throw Error(`Reading fixture geometry failed: ${resultText(geometry)}`);
  const point = parseEvidence(geometry);
  assert.ok(point.x > 0 && point.y > 0 && point.x < point.width && point.y < point.height, 'Fixture point must be in the visible viewport');
  const clicked = await client.call('click_at', { ...pageArgs, x: point.x, y: point.y });
  if (clicked.isError) throw Error(`Native coordinate click failed: ${resultText(clicked)}`);
  const observed = await client.call('evaluate_script', { ...pageArgs, function: `() => ({marker:${JSON.stringify(marker)},...window.visionFixture})` });
  if (observed.isError) throw Error(`Reading fixture click state failed: ${resultText(observed)}`);
  const clickState = parseEvidence(observed);
  verify('same imported page receives one trusted coordinate click', () => { assert.equal(clickState.count, 1); assert.equal(clickState.trusted, true); });
  return restored;
}

function cleanup() {
  return cleanupPromise ||= cleanDisposableState();
}
async function cleanDisposableState() {
  await client?.close().catch(error => { report.cleanupError = error.message; }); client = null;
  if (mcpChild) {
    mcpChild.stdin?.destroy(); mcpChild.stdout?.destroy(); mcpChild.stderr?.destroy(); mcpChild.unref(); mcpChild = null;
  }
  if (sourceChild) {
    try { await stopSource(); }
    catch (error) {
      report.cleanupError = error.message;
      // Only the child this fixture spawned can be retired; no process-name kill.
      const child = sourceChild;
      if (child?.pid && child.exitCode === null) await new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => { killer.kill(); resolve(); }, 3000);
        const done = () => { clearTimeout(timer); resolve(); }; killer.once('error', done); killer.once('exit', done);
      });
      sourceCdp?.close(); sourceCdp = null; sourceChild = null;
    }
  }
  for (const socket of sockets) socket.destroy();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  if (keep) report.fixtureDirectory = root;
  else {
    try { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); report.disposableProfilesRemoved = true; }
    catch (error) { report.cleanupError = error.message; report.fixtureDirectory = root; }
  }
}
const watchdog = setTimeout(() => {
  if (finished) return;
  report.failures.push({ label: 'watchdog', error: 'Native profile fixture exceeded 150 seconds.' });
  report.passed = false; report.finishedAt = new Date().toISOString();
  void cleanup().finally(() => save().finally(() => process.exit(1)));
}, 150000);

try {
  await stage('prepare');
  const { BrowserProfileStore } = await import(pathToFileURL(path.join(source, 'lib/browser-profile.mjs')).href);
  const { MCPClient } = await import(pathToFileURL(path.join(source, 'lib/mcp.mjs')).href);
  report.sourceHashes = Object.fromEntries(await Promise.all(['lib/browser-profile.mjs', 'lib/mcp.mjs'].map(async relative => [relative, sha256(await fs.readFile(path.join(source, relative)))])));
  await startFixture();
  await stage('seed-disposable-native-profile');
  const initial = await launchSource(); report.observations.initial = initial; checkState('source', initial);
  if (report.failures.length) throw Error('The native source fixture could not establish its own storage baseline.');
  await stopSource();
  await stage('reopen-original-with-native-launch');
  const reopened = await launchSource({ seed: false, label: 'reopenedSource' });
  report.observations.reopenedSource = reopened; checkState('source after clean native reopen', reopened);
  await stopSource();
  const staticFiles = await seedStaticFiles();
  const before = await inventory(userDataDir), profileBefore = await inventory(selectedSource);
  await stage('import-with-production-library');
  const store = await new BrowserProfileStore({ dataDir: path.join(root, 'BLACKICE disposable data') }).init();
  const imported = await store.import({ browser: 'chrome', userDataDir, profileDirectory, executablePath });
  assert.ok(imported?.id && path.isAbsolute(imported.userDataDir), 'Import must return its completed metadata');
  assert.notEqual(path.resolve(imported.userDataDir), path.resolve(userDataDir));
  const relativeDestination = path.relative(root, path.resolve(imported.userDataDir));
  assert.ok(relativeDestination && !relativeDestination.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeDestination), 'Import must remain inside the disposable store');
  report.observations.import = { id: imported.id, browser: imported.browser, profileDirectory: imported.profileDirectory, files: imported.files, bytes: imported.bytes, omitted: imported.omitted, authentication: imported.authentication };
  const afterImport = await inventory(userDataDir);
  verify('import never rewrites the source tree', () => assert.deepEqual(afterImport, before));
  verify('import preserves selected profile identity', () => { assert.equal(imported.profileDirectory, profileDirectory); assert.equal(imported.source.profileDirectory, profileDirectory); assert.equal(path.resolve(imported.executablePath), path.resolve(executablePath)); });
  verify('copy does not claim verified authentication', () => assert.equal(imported.authentication, 'unverified'));
  const copied = await inventory(path.join(imported.userDataDir, profileDirectory));
  // These are regenerable top-level browser caches, not origin CacheStorage,
  // IndexedDB or service-worker state. Keep this independent of the importer.
  const regenerableCaches = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache', 'GrShaderCache', 'ShaderCache', 'Media Cache']);
  const omitted = new Map((imported.omitted || []).map(entry => [entry.path, entry.reason]));
  const processLock = name => {
    if (path.posix.basename(name) !== 'LOCK') return false;
    const parent = path.posix.dirname(name), prefix = parent === '.' ? '' : `${parent}/`;
    return Object.hasOwn(profileBefore, `${prefix}CURRENT`) && Object.keys(profileBefore).some(file => file.startsWith(prefix) && /^MANIFEST-\d+$/.test(file.slice(prefix.length)));
  };
  const expected = Object.entries(profileBefore).filter(([name]) => !regenerableCaches.has(name.split('/')[0]) && !processLock(name));
  const pathBudget = profileRoot => {
    const names = expected.map(([name]) => name);
    const longest = prefix => Math.max(0, ...names.filter(name => !prefix || name.startsWith(prefix)).map(name => path.join(profileRoot, profileDirectory, ...name.split('/')).length));
    return { profileRootLength: path.join(profileRoot, profileDirectory).length, longestDurableFile: longest(), longestIndexedDBFile: longest('IndexedDB/'), longestCacheStorageFile: longest('Service Worker/CacheStorage/') };
  };
  report.observations.sourcePathLengths = pathBudget(userDataDir);
  report.observations.importedPathLengths = pathBudget(imported.userDataDir);
  verify('only explicit regenerable caches and proven LevelDB locks are omitted', () => {
    for (const name of Object.keys(profileBefore)) {
      const top = name.split('/')[0];
      if (regenerableCaches.has(top)) assert.equal(omitted.get(`${profileDirectory}/${top}`), 'cache', `Unreported cache omission: ${top}`);
      else if (processLock(name)) assert.equal(omitted.get(`${profileDirectory}/${name}`), 'process-state', `Unreported process lock: ${name}`);
    }
    for (const [name, reason] of omitted) if (name.startsWith(`${profileDirectory}/`)) {
      const relative = name.slice(profileDirectory.length + 1);
      assert.ok(reason === 'cache' && !relative.includes('/') && regenerableCaches.has(relative) || reason === 'process-state' && processLock(relative), `Unexpected profile omission: ${name} (${reason})`);
    }
  });
  verify('every durable source profile file has identical copied bytes', () => {
    for (const [name, digest] of expected) assert.equal(copied[name], digest, `Changed or missing copied file: ${name}`);
  });
  const sourceLocalState = await fs.readFile(path.join(userDataDir, 'Local State'));
  const copyLocalState = await fs.readFile(path.join(imported.userDataDir, 'Local State'));
  verify('Local State keeps exact source bytes', () => assert.deepEqual(copyLocalState, sourceLocalState));
  for (const relative of staticFiles) verify(`full-profile files: ${relative}`, () => assert.equal(copied[relative], profileBefore[relative]));
  for (const prefix of ['Local Storage/', 'IndexedDB/', 'Service Worker/', 'Session Storage/', 'History']) verify(`native storage files retained: ${prefix}`, () => {
    const entries = expected.filter(([name]) => name.startsWith(prefix)); assert.ok(entries.length, `Source did not generate ${prefix}`);
    for (const [name, digest] of entries) assert.equal(copied[name], digest);
  });
  const connection = await store.connection(imported.id, { headless: true, timeoutMs: 60000 });
  const allArgs = connection.args;
  verify('generated launch uses the source browser and imported profile', () => {
    assert.ok(allArgs.includes(`--executablePath=${executablePath}`));
    assert.ok(allArgs.includes(`--userDataDir=${imported.userDataDir}`));
    assert.ok(allArgs.includes(`--chromeArg=--profile-directory=${profileDirectory}`));
    assert.ok(allArgs.includes('--headless=true'));
    assert.equal(allArgs.some(value => /^--(?:autoConnect|auto-connect|channel|isolated)(?:=|$)/.test(value)), false);
  });
  for (const defaultArgument of ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--password-store=basic', '--use-mock-keychain', '--disable-sync', '--disable-background-networking', '--disable-client-side-phishing-detection', '--disable-ipc-flooding-protection']) verify(`native launch removes automation override ${defaultArgument}`, () => assert.ok(allArgs.includes(`--ignoreDefaultChromeArg=${defaultArgument}`)));
  await stage('open-separate-import-with-native-launch');
  const nativeStore = await new BrowserProfileStore({ dataDir: path.join(root, 'Native control data') }).init();
  const nativeImport = await nativeStore.import({ browser: 'chrome', userDataDir, profileDirectory, executablePath });
  report.observations.nativeControlPathLengths = pathBudget(nativeImport.userDataDir);
  const nativeRestored = await launchSource({ profileRoot: nativeImport.userDataDir, seed: false, label: 'nativeControl' });
  report.observations.nativeControl = nativeRestored; checkState('imported with direct native launch', nativeRestored);
  await stopSource(); await nativeStore.close();
  await stage('open-import-through-official-mcp');
  const restored = await importedState(connection, MCPClient); report.observations.restored = restored; checkState('imported', restored);
  const afterLaunch = await inventory(userDataDir);
  verify('running the imported browser leaves its source unchanged', () => assert.deepEqual(afterLaunch, before));
  report.passed = report.failures.length === 0;
} catch (error) {
  report.passed = false; report.error = error.message; report.failures.push({ label: report.stage || 'setup', error: error.message });
} finally {
  clearTimeout(watchdog); finished = true;
  await cleanup();
  if (report.cleanupError) { report.passed = false; report.failures.push({ label: 'cleanup', error: report.cleanupError }); }
  report.remainingResourceTypes = process.getActiveResourcesInfo();
  report.finishedAt = new Date().toISOString(); await save();
  // This standalone fixture has completed its bounded cleanup and durable
  // report. A platform WebSocket/child pipe must not leave the caller waiting.
  const exitCode = report.passed ? 0 : 1;
  process.stdout.write(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, report: reportPath }) + '\n', () => process.exit(exitCode));
}
