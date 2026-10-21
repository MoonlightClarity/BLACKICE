import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizeConnection } from './mcp.mjs';

const FORMAT = 'blackice-browser-profile', VERSION = 2;
const browsers = { chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave', neo: 'BrowserOS Neo', chromium: 'Chromium' };
const lockNames = ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];
const cacheNames = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache', 'GrShaderCache', 'ShaderCache', 'Media Cache']);
const idPattern = /^browser-profile-[a-f0-9]{16}$/;
const legacySnapshotPattern = /^browser-profile-[a-f0-9]{16}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const snapshotPattern = /^[a-f0-9]{24}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'BROWSER_PROFILE_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const check = signal => { if (signal?.aborted) throw Object.assign(fail('Browser profile import was cancelled.', 'ABORT_ERR', 409), { name: 'AbortError' }); };
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const changed = () => fail('The browser profile changed during import. Close the source browser and try again; the previous import was preserved.', 'BROWSER_PROFILE_CHANGED', 409);
const busy = () => fail('The source browser is still using this profile. Close it normally before importing; no browser was closed and the previous import was preserved.', 'BROWSER_PROFILE_SOURCE_BUSY', 409);
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
const unchanged = (a, b) => JSON.stringify(identity(a)) === JSON.stringify(identity(b));
const profileName = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;

function component(value) {
  if (typeof value !== 'string' || !value || value.length > 255 || value === '.' || value === '..' || /[\\/\0<>:"|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw fail('Choose a single browser profile directory name.', 'BROWSER_PROFILE_PATH');
  return value;
}
const relativePath = value => value.split('/').map(component).join('/');

/** Known installations only; no process inspection or profile reads. */
export function browserProfileCandidates({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix, candidates = [];
  const add = (browser, root, executablePaths) => { if (root && p.isAbsolute(root)) candidates.push({ browser, name: browsers[browser], userDataDir: root, executablePaths: [...new Set(executablePaths.filter(Boolean))] }); };
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA, program = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(value => typeof value === 'string' && p.isAbsolute(value));
    if (typeof local !== 'string' || !p.isAbsolute(local)) return [];
    add('chrome', p.join(local, 'Google', 'Chrome', 'User Data'), [local, ...program].map(root => p.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')));
    add('edge', p.join(local, 'Microsoft', 'Edge', 'User Data'), [...program, local].map(root => p.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
    add('brave', p.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'), [...program, local].map(root => p.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')));
    add('neo', p.join(local, 'BrowserClaw', 'User Data'), [p.join(local, 'BrowserClaw', 'Application', 'chrome.exe')]);
  } else if (platform === 'darwin') {
    const root = p.join(homeDir, 'Library', 'Application Support');
    for (const [browser, directory, bundle, binary] of [['chrome', 'Google/Chrome', 'Google Chrome', 'Google Chrome'], ['edge', 'Microsoft Edge', 'Microsoft Edge', 'Microsoft Edge'], ['brave', 'BraveSoftware/Brave-Browser', 'Brave Browser', 'Brave Browser'], ['chromium', 'Chromium', 'Chromium', 'Chromium']]) {
      add(browser, p.join(root, directory), ['/Applications', p.join(homeDir, 'Applications')].map(apps => p.join(apps, `${bundle}.app`, 'Contents', 'MacOS', binary)));
    }
  } else if (platform === 'linux') {
    const root = env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(homeDir, '.config');
    add('chrome', p.join(root, 'google-chrome'), ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']);
    add('edge', p.join(root, 'microsoft-edge'), ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge']);
    add('brave', p.join(root, 'BraveSoftware', 'Brave-Browser'), ['/opt/brave.com/brave/brave', '/usr/bin/brave-browser']);
    add('chromium', p.join(root, 'chromium'), ['/usr/lib/chromium/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser']);
  }
  return candidates;
}

/**
 * Offline, byte-preserving snapshots for the original Chromium browser.
 * This class never launches a browser, decrypts a store, or changes the source.
 * Filesystem/fault dependencies are injectable for disposable regression tests.
 */
export class BrowserProfileStore {
  constructor({ dataDir, platform = process.platform, env = process.env, homeDir = os.homedir(), io = fs, isProcessAlive = processAlive, fault = async () => {} } = {}) {
    this.platform = platform; this.path = platform === 'win32' ? path.win32 : path.posix;
    this.env = env; this.homeDir = homeDir; this.io = io; this.isProcessAlive = isProcessAlive; this.fault = fault;
    this.dataDir = this.absolute(dataDir); this.root = this.path.join(this.dataDir, 'browser-profiles');
    this.importsDir = this.path.join(this.root, 'imports'); this.snapshotsDir = this.path.join(this.dataDir, 'bp'); this.locksDir = this.path.join(this.root, 'locks');
    this.manifestsDir = this.path.join(this.root, 'manifests');
    this.pending = new Map(); this.closed = false;
  }

  absolute(value) {
    if (typeof value !== 'string' || value.length > 32760 || value.includes('\0') || !this.path.isAbsolute(value) || this.path.parse(value).root === this.path.resolve(value)) throw fail('Browser profile paths must be absolute folders or files, not filesystem roots.', 'BROWSER_PROFILE_PATH');
    return this.path.resolve(value);
  }
  same(a, b) { return this.platform === 'win32' ? this.path.resolve(a).toLowerCase() === this.path.resolve(b).toLowerCase() : this.path.resolve(a) === this.path.resolve(b); }
  within(root, target) { const relative = this.path.relative(root, target); return !relative || relative !== '..' && !relative.startsWith(`..${this.path.sep}`) && !this.path.isAbsolute(relative); }
  async absent(file) { try { await this.io.lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }
  async plain(file, kind) {
    const stat = await this.io.lstat(file);
    if (stat.isSymbolicLink() || kind === 'directory' && !stat.isDirectory() || kind === 'file' && !stat.isFile() || !stat.isFile() && !stat.isDirectory() || !this.same(await this.io.realpath(file), file)) throw fail('Profile import cannot follow links, junctions, redirected paths, or special files. The previous import was preserved.', 'BROWSER_PROFILE_UNSAFE_PATH');
    return stat;
  }
  async json(file, maxBytes = 16 * 1024 * 1024) {
    if ((await this.plain(file, 'file')).size > maxBytes) throw fail('Browser profile metadata is too large.', 'BROWSER_PROFILE_METADATA');
    try { return JSON.parse(await this.io.readFile(file, 'utf8')); } catch { throw fail('Browser profile metadata is not valid JSON.', 'BROWSER_PROFILE_METADATA'); }
  }
  async init() {
    await this.io.mkdir(this.dataDir, { recursive: true, mode: 0o700 }); await this.plain(this.dataDir, 'directory');
    for (const directory of [this.root, this.importsDir, this.snapshotsDir, this.locksDir, this.manifestsDir]) { await this.io.mkdir(directory, { recursive: true, mode: 0o700 }); await this.plain(directory, 'directory'); }
    return this;
  }
  sourceId(source) {
    const location = this.platform === 'win32' ? `${source.userDataDir}\0${source.profileDirectory}`.toLowerCase() : `${source.userDataDir}\0${source.profileDirectory}`;
    return `browser-profile-${sha(`${source.browser}\0${location}`).slice(0, 16)}`;
  }
  async source(value) {
    if (!browsers[value?.browser]) throw fail('Choose Chrome, Edge, Brave, Neo, or Chromium.', 'BROWSER_PROFILE_BROWSER');
    const source = { browser: value.browser, name: profileName(value.name) || browsers[value.browser], userDataDir: this.absolute(value.userDataDir), profileDirectory: component(value.profileDirectory), executablePath: this.absolute(value.executablePath) };
    if ([this.root, this.snapshotsDir].some(root => this.within(source.userDataDir, root) || this.within(root, source.userDataDir))) throw fail('The import store must be separate from the source browser profile.', 'BROWSER_PROFILE_PATH');
    let state;
    try {
      await this.plain(source.userDataDir, 'directory'); await this.plain(this.path.join(source.userDataDir, source.profileDirectory), 'directory');
      source.profileDirectory = component(this.path.basename(await this.io.realpath(this.path.join(source.userDataDir, source.profileDirectory))));
      await this.plain(this.path.join(source.userDataDir, source.profileDirectory, 'Preferences'), 'file');
      state = await this.json(this.path.join(source.userDataDir, 'Local State'));
    } catch (error) { if (error.code === 'ENOENT') throw fail('The selected browser profile, Preferences, or root Local State is missing. Open that profile in its browser once before importing.', 'BROWSER_PROFILE_SOURCE_MISSING', 404); throw error; }
    // Canonicalizing an executable symlink is legitimate on Linux. Profile
    // links are rejected, so they cannot silently include files outside it.
    try { source.executablePath = this.absolute(await this.io.realpath(source.executablePath)); await this.plain(source.executablePath, 'file'); }
    catch (error) { if (error.code === 'ENOENT') throw fail('The source browser executable is missing. Install or locate the same browser before importing.', 'BROWSER_PROFILE_EXECUTABLE_MISSING', 404); throw error; }
    source.profileName = profileName(value.profileName) || profileName(state?.profile?.info_cache?.[source.profileDirectory]?.name) || source.profileDirectory;
    source.id = this.sourceId(source);
    return source;
  }

  async discover() {
    const sources = [];
    for (const candidate of browserProfileCandidates(this)) {
      try {
        await this.plain(candidate.userDataDir, 'directory');
        const state = await this.json(this.path.join(candidate.userDataDir, 'Local State'));
        let executablePath;
        for (const executable of candidate.executablePaths) { try { const resolved = this.absolute(await this.io.realpath(executable)); await this.plain(resolved, 'file'); executablePath = resolved; break; } catch {} }
        if (!executablePath) continue;
        const known = new Set(Object.keys(state?.profile?.info_cache || {}));
        for (const directory of (await this.io.readdir(candidate.userDataDir)).sort()) {
          try {
            component(directory); const location = this.path.join(candidate.userDataDir, directory); await this.plain(location, 'directory');
            if (!known.has(directory) && !/^(?:Default|Profile \d+)$/.test(directory) && await this.absent(this.path.join(location, 'Preferences'))) continue;
            if (['Guest Profile', 'System Profile'].includes(directory)) continue;
            const source = { browser: candidate.browser, name: candidate.name, userDataDir: candidate.userDataDir, executablePath, profileDirectory: directory, profileName: profileName(state?.profile?.info_cache?.[directory]?.name) || directory };
            let locked = false; try { await this.assertOffline(source); } catch { locked = true; }
            sources.push({ id: this.sourceId(source), ...source, locked, importable: !locked });
          } catch {}
        }
      } catch {}
    }
    return { sources, imports: await this.list() };
  }

  validateRecord(record) {
    if (record?.format !== FORMAT || ![1, VERSION].includes(record.version) || !idPattern.test(record.id) || !(record.version === 1 ? legacySnapshotPattern.test(record.snapshot) && record.snapshot.startsWith(`${record.id}-`) : snapshotPattern.test(record.snapshot)) || !browsers[record.browser] || !Number.isFinite(Date.parse(record.createdAt))) throw fail('Imported browser metadata needs attention; all profile copies were preserved.', 'BROWSER_PROFILE_METADATA');
    component(record.profileDirectory);
    const expected = record.version === 1 ? this.path.join(this.root, 'snapshots', record.snapshot, 'user-data') : this.path.join(this.snapshotsDir, record.snapshot);
    if (!this.same(this.absolute(record.userDataDir), expected) || !this.path.isAbsolute(record.executablePath) || record.executablePath.includes('\0')) throw fail('Imported browser metadata contains an invalid path.', 'BROWSER_PROFILE_METADATA');
    if (record.version === VERSION && (!this.same(this.absolute(record.manifestPath), this.path.join(this.manifestsDir, record.id, `${record.snapshot}.json`)) || !record.source || record.source.profileDirectory !== record.profileDirectory || record.source.executablePath !== record.executablePath || !this.path.isAbsolute(record.source.userDataDir) || this.sourceId({ ...record.source, browser: record.browser }) !== record.id)) throw fail('Imported browser metadata has an invalid snapshot identity.', 'BROWSER_PROFILE_METADATA');
    return record;
  }
  async record(id) {
    if (!idPattern.test(id || '')) throw fail('Choose a valid imported browser profile.', 'BROWSER_PROFILE_ID');
    const file = this.path.join(this.importsDir, `${id}.json`);
    if (await this.absent(file)) return null;
    const record = this.validateRecord(await this.json(file));
    if (record.id !== id) throw fail('Imported browser metadata has the wrong identity.', 'BROWSER_PROFILE_METADATA');
    return record;
  }
  async status(id) {
    const record = await this.record(id); if (!record) return null;
    let available = true;
    try { await this.plain(record.userDataDir, 'directory'); await this.plain(this.path.join(record.userDataDir, record.profileDirectory), 'directory'); await this.plain(this.path.join(record.userDataDir, 'Local State'), 'file'); await this.plain(record.executablePath, 'file'); await this.plain(record.manifestPath || this.path.join(this.root, 'snapshots', record.snapshot, 'manifest.json'), 'file'); } catch { available = false; }
    return { ...record, available, state: available ? 'ready' : 'unavailable', authentication: 'unverified' };
  }
  async list() {
    if (await this.absent(this.importsDir)) return [];
    await this.plain(this.importsDir, 'directory'); const values = [];
    for (const name of (await this.io.readdir(this.importsDir)).sort()) if (/^browser-profile-[a-f0-9]{16}\.json$/.test(name)) values.push(await this.status(name.slice(0, -5)));
    return values;
  }

  async assertOffline(source, signal) {
    check(signal);
    // Windows Chromium opens lockfile with FILE_FLAG_DELETE_ON_CLOSE; POSIX
    // builds use the singleton markers. Never remove or acquire source locks.
    for (const name of lockNames) { try { if (!await this.absent(this.path.join(source.userDataDir, name))) throw busy(); } catch (error) { if (error.code === 'BROWSER_PROFILE_SOURCE_BUSY') throw error; throw busy(); } }
  }
  async walk(source, signal) {
    const entries = [], omitted = [], root = source.userDataDir, selected = source.profileDirectory;
    const state = await this.json(this.path.join(root, 'Local State'));
    const otherProfiles = new Set(Object.keys(state?.profile?.info_cache || {}).filter(name => name !== selected));
    const visit = async (directory, prefix = '') => {
      check(signal); await this.plain(directory, 'directory');
      const names = (await this.io.readdir(directory)).sort();
      const levelDB = names.includes('CURRENT') && names.some(name => /^MANIFEST-\d+$/.test(name));
      for (const name of names) {
        const relative = relativePath(prefix ? `${prefix}/${name}` : name), file = this.path.join(directory, name);
        const stat = await this.plain(file);
        let reason;
        if (!prefix && name !== selected && stat.isDirectory() && (otherProfiles.has(name) || /^(?:Default|Profile \d+|Guest Profile|System Profile)$/.test(name))) reason = 'unselected-profile';
        if (stat.isDirectory() && (!prefix && name !== selected || prefix === selected) && cacheNames.has(name)) reason = 'cache';
        if (stat.isFile() && (!prefix && name === 'DevToolsActivePort' || name === 'LOCK' && levelDB)) reason = 'process-state';
        if (reason) { omitted.push({ path: relative, reason }); continue; }
        // Unlisted custom profile directories are recognized by Preferences.
        if (!prefix && name !== selected && stat.isDirectory() && !await this.absent(this.path.join(file, 'Preferences'))) { omitted.push({ path: relative, reason: 'unselected-profile' }); continue; }
        entries.push({ path: relative, type: stat.isDirectory() ? 'directory' : 'file', identity: identity(stat), mode: stat.mode, mtimeMs: stat.mtimeMs, atimeMs: stat.atimeMs });
        if (stat.isDirectory()) await visit(file, relative);
      }
    };
    await visit(root); return { entries, omitted };
  }
  async transfer(file, target, signal) {
    check(signal); const before = await this.plain(file, 'file'), input = await this.io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let output, size = 0; const digest = createHash('sha256');
    try {
      if (!unchanged(before, await input.stat())) throw changed();
      if (target) output = await this.io.open(target, 'wx', before.mode & 0o777);
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        check(signal); const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
        digest.update(buffer.subarray(0, bytesRead)); size += bytesRead;
        if (output) for (let offset = 0; offset < bytesRead;) { const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null); if (!bytesWritten) throw fail('Copying a browser profile file made no progress.', 'BROWSER_PROFILE_COPY'); offset += bytesWritten; }
      }
      if (!unchanged(before, await input.stat()) || size !== before.size || !unchanged(before, await this.plain(file, 'file'))) throw changed();
      if (output) { await output.utimes(before.atime, before.mtime); await output.sync(); }
    } finally { await Promise.all([input.close(), output?.close()]); }
    return { size, sha256: digest.digest('hex') };
  }
  async write(file, value) {
    const handle = await this.io.open(file, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  }
  async releaseLock(file, handle, token) {
    await handle?.close().catch(() => {});
    try { if ((await this.json(file, 65536)).token === token) await this.io.unlink(file); } catch {}
  }
  async acquireLock(file, token, depth = 0) {
    if (depth > 8) throw fail('Another profile import needs to finish before this one can start.', 'BROWSER_PROFILE_BUSY', 409);
    try { const handle = await this.io.open(file, 'wx', 0o600); try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); return handle; } catch (error) { await handle.close(); throw error; } }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let raw, owner;
    try { owner = await this.json(file, 65536); raw = await this.io.readFile(file, 'utf8'); } catch { throw fail('Another profile import needs attention; all copies were preserved.', 'BROWSER_PROFILE_BUSY', 409); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || await this.isProcessAlive(owner.pid) !== false) throw fail('An import of this profile is already running.', 'BROWSER_PROFILE_BUSY', 409);
    const claim = `${file}.reclaim-${sha(raw).slice(0, 16)}`, handle = await this.acquireLock(claim, token, depth + 1);
    try {
      if (await this.io.readFile(file, 'utf8') !== raw || await this.isProcessAlive(owner.pid) !== false) throw fail('Another profile import started. Try again when it finishes.', 'BROWSER_PROFILE_BUSY', 409);
      await this.io.unlink(file); return await this.acquireLock(file, token, depth + 1);
    } finally { await this.releaseLock(claim, handle, token); }
  }

  async import(value = {}) {
    if (this.closed) throw fail('Browser profile imports are closed for maintenance.', 'BROWSER_PROFILE_CLOSED', 503);
    check(value.signal);
    let selected = value;
    if (value.sourceId) { selected = (await this.discover()).sources.find(source => source.id === value.sourceId); if (!selected) throw fail('The selected browser profile is no longer available.', 'BROWSER_PROFILE_NOT_FOUND', 404); }
    const source = await this.source(selected); check(value.signal);
    if (this.closed) throw fail('Browser profile imports are closed for maintenance.', 'BROWSER_PROFILE_CLOSED', 503);
    if (this.pending.has(source.id)) throw fail('An import of this profile is already running.', 'BROWSER_PROFILE_BUSY', 409);
    const work = this.copy(source, value.signal); this.pending.set(source.id, work);
    try { return await work; } finally { if (this.pending.get(source.id) === work) this.pending.delete(source.id); }
  }
  async copy(source, signal) {
    await this.assertOffline(source, signal); await this.init();
    const token = randomUUID(), lock = this.path.join(this.locksDir, `${source.id}.lock`), handle = await this.acquireLock(lock, token);
    // Chromium's Windows storage engines still encounter MAX_PATH in some
    // native code paths. Do not repeat the stable ID or add user-data layers.
    const snapshot = randomBytes(12).toString('hex'), stage = this.path.join(this.snapshotsDir, `.stage-${snapshot}`), final = this.path.join(this.snapshotsDir, snapshot);
    const manifestDirectory = this.path.join(this.manifestsDir, source.id), manifest = this.path.join(manifestDirectory, `${snapshot}.json`), temporaryManifest = `${manifest}.${token}.tmp`;
    const pointer = this.path.join(this.importsDir, `${source.id}.json`), temporary = `${pointer}.${token}.tmp`;
    let stageCreated = false, promoted = false, published = false, manifestPublished = false;
    try {
      const previous = await this.record(source.id);
      await this.assertOffline(source, signal); const before = await this.walk(source, signal);
      await this.io.mkdir(stage, { mode: 0o700 }); stageCreated = true; const payload = stage;
      await this.io.mkdir(manifestDirectory, { recursive: true, mode: 0o700 }); await this.plain(manifestDirectory, 'directory');
      const entries = [];
      for (const entry of before.entries) {
        check(signal); const from = this.path.join(source.userDataDir, ...entry.path.split('/')), target = this.path.join(payload, ...entry.path.split('/'));
        if (entry.type === 'directory') { await this.io.mkdir(target, { mode: entry.mode & 0o777 }); entries.push({ path: entry.path, type: 'directory' }); }
        else { const copied = await this.transfer(from, target, signal); entries.push({ path: entry.path, type: 'file', ...copied }); }
        await this.fault('entry-copied', { path: entry.path, source, stage, signal });
      }
      await this.assertOffline(source, signal);
      const after = await this.walk(source, signal);
      const topology = result => JSON.stringify({ entries: result.entries.map(({ path, type, identity }) => ({ path, type, identity })), omitted: result.omitted });
      if (topology(before) !== topology(after)) throw changed();
      for (const entry of entries) if (entry.type === 'file') {
        const original = await this.transfer(this.path.join(source.userDataDir, ...entry.path.split('/')), null, signal);
        const copied = await this.transfer(this.path.join(payload, ...entry.path.split('/')), null, signal);
        if (original.size !== entry.size || original.sha256 !== entry.sha256 || copied.size !== entry.size || copied.sha256 !== entry.sha256) throw changed();
      }
      // Preserve directory timestamps after populating their children.
      for (const entry of [...before.entries].reverse()) if (entry.type === 'directory') await this.io.utimes(this.path.join(payload, ...entry.path.split('/')), entry.atimeMs / 1000, entry.mtimeMs / 1000);
      const files = entries.filter(entry => entry.type === 'file');
      const record = {
        format: FORMAT, version: VERSION, id: source.id, browser: source.browser, name: source.name,
        profileDirectory: source.profileDirectory, profileName: source.profileName, executablePath: source.executablePath,
        source: { userDataDir: source.userDataDir, profileDirectory: source.profileDirectory, executablePath: source.executablePath },
        snapshot, userDataDir: final, manifestPath: manifest, createdAt: new Date().toISOString(),
        files: files.length, directories: entries.length - files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), omitted: before.omitted,
        authentication: 'unverified', ...(previous ? { previousSnapshot: previous.userDataDir } : {}),
      };
      this.validateRecord(record);
      await this.write(temporaryManifest, { ...record, entries });
      await this.fault('before-publish', { source, stage, record, signal });
      await this.assertOffline(source, signal); check(signal);
      if (topology(before) !== topology(await this.walk(source, signal))) throw changed();
      await this.io.rename(stage, final); promoted = true;
      // Publish the manifest without overwriting another revision's record.
      // Both it and the runtime directory exist before replacing the pointer.
      await this.io.link(temporaryManifest, manifest); manifestPublished = true;
      await this.write(temporary, record);
      await this.fault('before-pointer', { source, record, signal });
      await this.assertOffline(source, signal); check(signal);
      if (topology(before) !== topology(await this.walk(source, signal))) throw changed();
      // Only this tiny metadata pointer is replaced. The old browser directory
      // remains valid even if it is open, or this process exits during a copy.
      await this.io.rename(temporary, pointer); published = true;
      return { ...record, available: true, state: 'ready' };
    } finally {
      await this.io.rm(temporary, { force: true }).catch(() => {});
      await this.io.rm(temporaryManifest, { force: true }).catch(() => {});
      if (!published) {
        if (promoted || stageCreated) await this.io.rm(promoted ? final : stage, { recursive: true, force: true }).catch(() => {});
        if (manifestPublished) await this.io.rm(manifest, { force: true }).catch(() => {});
      }
      await this.releaseLock(lock, handle, token);
    }
  }

  /** Configuration only. The connection manager owns launch and shutdown. */
  async connection(id, { command = 'npx', headless = false, timeoutMs = 60000 } = {}) {
    const record = await this.status(id);
    if (!record) throw fail('Import a browser profile before connecting it.', 'BROWSER_PROFILE_NOT_FOUND', 404);
    if (!record.available) throw fail('The imported profile or its original browser executable is unavailable.', 'BROWSER_PROFILE_UNAVAILABLE', 409);
    return normalizeConnection({
      id: record.id, name: `${record.name} · ${record.profileName} (imported)`.slice(0, 120), transport: 'stdio', enabled: true, command, timeoutMs,
      args: ['-y', 'chrome-devtools-mcp@latest', `--executablePath=${record.executablePath}`, `--userDataDir=${record.userDataDir}`, `--chromeArg=--profile-directory=${record.profileDirectory}`,
        '--no-usage-statistics', '--no-performance-crux',
        ...['--disable-extensions', '--disable-component-extensions-with-background-pages', '--password-store=basic', '--use-mock-keychain', '--disable-sync', '--disable-background-networking', '--disable-client-side-phishing-detection', '--disable-ipc-flooding-protection'].map(arg => `--ignoreDefaultChromeArg=${arg}`),
        ...(headless ? ['--headless=true'] : [])],
    });
  }
  async close() { this.closed = true; await Promise.allSettled([...this.pending.values()]); }
}
