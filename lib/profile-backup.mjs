import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile), FORMAT = 'relay-profile-backup', TRANSACTION = 'relay-profile-restore';
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'PROFILE_BACKUP_INVALID') => Object.assign(new Error(message), { code });
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const within = (root, target) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const check = signal => { if (signal?.aborted) throw Object.assign(fail('Profile maintenance was cancelled.', 'ABORT_ERR'), { name: 'AbortError' }); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const bindingValid = value => exact(value, ['platform', 'userIdHash', 'machineIdHash']) && /^[a-z0-9_-]{1,32}$/.test(value.platform || '') && /^[a-f0-9]{64}$/.test(value.userIdHash || '') && /^[a-f0-9]{64}$/.test(value.machineIdHash || '');
const matchesBinding = (a, b) => a.platform === b.platform && a.userIdHash === b.userIdHash && a.machineIdHash === b.machineIdHash;
const warning = 'Backups contain private chats, files and browser data. Windows-encrypted API keys and website sign-ins are bound to the original Windows account and machine; copied credentials are not portable.';
const rootFiles = new Set(['desktop-runtime.json', 'singletonlock', 'singletoncookie', 'singletonsocket', 'devtoolsactiveport', 'lockfile']);
const caches = new Set(['cache', 'code cache', 'gpucache', 'dawncache', 'dawngraphitecache', 'dawnwebgpucache', 'shadercache', 'grshadercache', 'crashpad', 'crash reports']);
const excluded = relative => {
  const parts = relative.toLowerCase().split('/');
  // A forced exit can leave a short-lived native password-import CSV behind.
  // Never turn that plaintext handoff into a durable backup or restore it.
  if (parts[0] === 'data' && parts[1] === 'browser-credentials' && /^[a-f0-9]{24}$/.test(parts[2] || '') && parts[3] === 'exports') return true;
  if (parts.length === 1 && (rootFiles.has(parts[0]) || caches.has(parts[0]))) return true;
  if (parts[0] === 'partitions' && parts.length === 3 && (rootFiles.has(parts[2]) || caches.has(parts[2]))) return true;
  return !['data', 'workspace', 'downloads'].includes(parts[0]) && parts.at(-1) === 'lock';
};
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 32760 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw fail('The backup contains an unsafe path.');
  return value;
}
async function absent(io, target) { try { await io.lstat(target); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }
async function plain(io, target, type) {
  const stat = await io.lstat(target);
  if (stat.isSymbolicLink() || type === 'directory' && !stat.isDirectory() || type === 'file' && !stat.isFile() || !stat.isFile() && !stat.isDirectory()) throw fail('Profile backups cannot follow symbolic links, junctions or special files.', 'PROFILE_BACKUP_UNSAFE_PATH');
  if (!samePath(await io.realpath(target), target)) throw fail('Profile backups cannot follow redirected profile paths.', 'PROFILE_BACKUP_UNSAFE_PATH');
  return stat;
}
async function rootPath(io, target, allowRoot = false) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || !allowRoot && samePath(target, path.parse(target).root)) throw fail('Choose an absolute profile or backup folder, not a filesystem root.', 'PROFILE_BACKUP_UNSAFE_PATH');
  const resolved = path.resolve(target); await plain(io, resolved, 'directory'); return resolved;
}
async function rejectWindowsReparse(root) {
  if (process.platform !== 'win32') return;
  const script = '$ErrorActionPreference="Stop";$root=[IO.Path]::GetFullPath($env:RELAY_BACKUP_CHECK_ROOT);$p=$root;while($p){if(([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw "Reparse point"};$next=[IO.Path]::GetDirectoryName($p);if($next -eq $p){break};$p=$next};$pending=[Collections.Generic.Stack[string]]::new();$pending.Push($root);while($pending.Count){foreach($item in [IO.Directory]::EnumerateFileSystemEntries($pending.Pop())){$a=[IO.File]::GetAttributes($item);if(($a -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw "Reparse point"};if(($a -band [IO.FileAttributes]::Directory) -ne 0){$pending.Push($item)}}}';
  try { await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, RELAY_BACKUP_CHECK_ROOT: root }, maxBuffer: 1024 * 1024 }); }
  catch { throw fail('The profile contains a reparse point or could not be checked safely. No profile files were changed.', 'PROFILE_BACKUP_UNSAFE_PATH'); }
}
export async function profileBackupBinding() {
  if (process.platform === 'win32') {
    try {
      const [account, machine] = await Promise.all([execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true }), execute('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true })]);
      const sid = account.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0], guid = machine.stdout.match(/MachineGuid\s+REG_SZ\s+([a-fA-F0-9-]+)/)?.[1];
      if (!sid || !guid) throw Error('Identity unavailable');
      return { platform: 'win32', userIdHash: sha(sid), machineIdHash: sha(guid.toLowerCase()) };
    } catch { throw fail('Windows account and machine identity could not be verified for this profile backup.', 'PROFILE_BINDING_UNAVAILABLE'); }
  }
  const user = os.userInfo();
  return { platform: process.platform, userIdHash: sha(String(user.uid) + ':' + user.username + ':' + user.homedir), machineIdHash: sha(os.hostname()) };
}
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
async function offline(profileDir, options, phase) {
  check(options.signal);
  if (options.assertOffline && await options.assertOffline({ profileDir, phase }) === false) throw fail('Close Relay before backing up or restoring its profile.', 'PROFILE_BUSY');
  const marker = path.join(profileDir, 'desktop-runtime.json');
  if (await absent(options.io, marker)) return;
  await plain(options.io, marker, 'file');
  let value; try { if ((await options.io.stat(marker)).size > 65536) throw Error('Invalid marker'); value = JSON.parse(await options.io.readFile(marker, 'utf8')); } catch { throw fail('Relay may still be using this profile. Close it before continuing.', 'PROFILE_BUSY'); }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || await options.isProcessAlive(value.pid) !== false) throw fail('Relay is still using this profile. Close it before continuing.', 'PROFILE_BUSY');
}
function settings(options) { return { io: fs, isProcessAlive: processAlive, getBinding: profileBackupBinding, reparseCheck: rejectWindowsReparse, fault: async () => {}, ...options }; }
async function hashFile(io, file, signal) {
  check(signal); const before = await plain(io, file, 'file'), handle = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)), digest = createHash('sha256'); let bytes = 0;
  try {
    const opened = await handle.stat(); if (opened.dev !== before.dev || opened.ino !== before.ino) throw fail('A profile file changed while it was being read.', 'PROFILE_CHANGED');
    const buffer = Buffer.alloc(1024 * 1024); for (;;) { check(signal); const result = await handle.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break; bytes += result.bytesRead; digest.update(buffer.subarray(0, result.bytesRead)); }
    const after = await handle.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes !== after.size) throw fail('A profile file changed while it was being read.', 'PROFILE_CHANGED');
  } finally { await handle.close(); }
  await plain(io, file, 'file'); return { size: bytes, sha256: digest.digest('hex') };
}
async function walk(io, root, { exclude = () => false, signal } = {}) {
  const entries = [], omitted = []; const visit = async (directory, prefix = '') => {
    check(signal); await plain(io, directory, 'directory');
    for (const name of (await io.readdir(directory)).sort()) {
      const relative = safeRelative(prefix ? prefix + '/' + name : name); if (exclude(relative)) { omitted.push(relative); continue; }
      const file = path.join(directory, name), stat = await plain(io, file);
      if (stat.isDirectory()) { entries.push({ path: relative, type: 'directory' }); await visit(file, relative); }
      else entries.push({ path: relative, type: 'file', size: stat.size });
    }
  }; await visit(root); return { entries, omitted };
}
async function copyFile(io, source, target, signal) {
  check(signal); const before = await plain(io, source, 'file'), input = await io.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)), digest = createHash('sha256'); let bytes = 0, output;
  try {
    output = await io.open(target, 'wx', before.mode & 0o777);
    const opened = await input.stat(); if (opened.dev !== before.dev || opened.ino !== before.ino) throw fail('A profile file changed while copying.', 'PROFILE_CHANGED');
    const buffer = Buffer.alloc(1024 * 1024); for (;;) { check(signal); const result = await input.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break; digest.update(buffer.subarray(0, result.bytesRead)); bytes += result.bytesRead; let offset = 0; while (offset < result.bytesRead) { const written = await output.write(buffer, offset, result.bytesRead - offset, null); if (!written.bytesWritten) throw Error('Profile file write made no progress.'); offset += written.bytesWritten; } }
    const after = await input.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes !== after.size) throw fail('A profile file changed while copying.', 'PROFILE_CHANGED');
    await output.sync();
  } finally { await Promise.all([input.close(), output?.close()]); }
  return { size: bytes, sha256: digest.digest('hex') };
}
async function writeDurable(io, file, text) { const handle = await io.open(file, 'wx', 0o600); try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); } }
async function atomicJournal(io, file, journal) { const temporary = file + '.' + randomUUID() + '.tmp'; try { await writeDurable(io, temporary, JSON.stringify(journal)); await io.rename(temporary, file); } finally { await io.rm(temporary, { force: true }).catch(() => {}); } }
function locations(profileDir) { const parent = path.dirname(profileDir), name = path.basename(profileDir); return { parent, name, lock: path.join(parent, '.' + name + '.profile-maintenance.lock'), journal: path.join(parent, '.' + name + '.restore-transaction.json') }; }
async function publishLock(file, options, token) {
  const temporary = file + '.' + randomUUID() + '.tmp'; let handle, published = false;
  try {
    handle = await options.io.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync();
    // Linking is an atomic exclusive publish: readers never see an empty lock.
    await options.io.link(temporary, file); published = true; return handle;
  } finally { if (!published) await handle?.close(); await options.io.rm(temporary, { force: true }).catch(() => {}); }
}
async function releaseLock(file, handle, options, token) {
  await handle.close(); try { if (JSON.parse(await options.io.readFile(file, 'utf8')).token === token) await options.io.unlink(file); } catch {}
}
async function acquireLock(file, options, token, depth = 0) {
  if (depth > 16) throw fail('Profile maintenance recovery needs attention. Existing files were preserved.', 'PROFILE_MAINTENANCE_BUSY');
  try { return await publishLock(file, options, token); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  let previous, raw;
  try { if ((await plain(options.io, file, 'file')).size > 65536) throw Error('Invalid lock'); raw = await options.io.readFile(file, 'utf8'); previous = JSON.parse(raw); }
  catch { throw fail('A profile maintenance lock needs attention. Existing files were preserved.', 'PROFILE_MAINTENANCE_BUSY'); }
  if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || await options.isProcessAlive(previous.pid) !== false) throw fail('Profile maintenance is already running.', 'PROFILE_MAINTENANCE_BUSY');
  // All workers that observed this dead generation contend for the same claim.
  // A dead claim is reclaimed through its own generation, so a hard exit during
  // reclamation can recover without deleting a successor's live lock.
  const claim = file + '.reclaim-' + sha(raw).slice(0, 24), handle = await acquireLock(claim, options, token, depth + 1);
  try {
    if (await options.io.readFile(file, 'utf8') !== raw || await options.isProcessAlive(previous.pid) !== false) throw fail('Profile maintenance changed while recovery was waiting. Try again.', 'PROFILE_MAINTENANCE_BUSY');
    await options.io.unlink(file);
    try { return await publishLock(file, options, token); } catch (error) { if (error.code === 'EEXIST') throw fail('Profile maintenance is already running.', 'PROFILE_MAINTENANCE_BUSY'); throw error; }
  } finally { await releaseLock(claim, handle, options, token); }
}
async function maintenance(profileDir, options, operation) {
  const { lock } = locations(profileDir), token = randomUUID(), handle = await acquireLock(lock, options, token);
  try { return await operation(); }
  finally { await releaseLock(lock, handle, options, token); }
}
function parseManifest(value) {
  if (!exact(value, ['format', 'version', 'createdAt', 'appVersion', 'binding', 'entries', 'excluded']) || value.format !== FORMAT || value.version !== 1 || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.appVersion !== 'string' || value.appVersion.length > 100 || !bindingValid(value.binding) || !Array.isArray(value.entries) || !Array.isArray(value.excluded)) throw fail('This is not a supported Relay profile backup.');
  const byPath = new Map();
  for (const entry of value.entries) {
    if (!exact(entry, ['path', 'type', 'size', 'sha256']) || !['file', 'directory'].includes(entry.type)) throw fail('The backup manifest contains an invalid file record.');
    const relative = safeRelative(entry.path), key = relative.toLowerCase();
    if (byPath.has(key) || excluded(relative)) throw fail('The backup manifest contains duplicate or transient file paths.');
    if (entry.type === 'file' ? !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') : entry.size !== undefined || entry.sha256 !== undefined) throw fail('The backup manifest contains invalid file integrity metadata.');
    byPath.set(key, entry);
  }
  for (const entry of value.entries) { const segments = entry.path.split('/'); segments.pop(); while (segments.length) { if (byPath.get(segments.join('/').toLowerCase())?.type !== 'directory') throw fail('The backup manifest has a missing parent directory.'); segments.pop(); } }
  for (const item of value.excluded) safeRelative(item);
  return value;
}
function summary(manifest, manifestSha256, binding) {
  const files = manifest.entries.filter(entry => entry.type === 'file'), compatible = matchesBinding(manifest.binding, binding);
  return { manifest, manifestSha256, createdAt: manifest.createdAt, files: files.length, directories: manifest.entries.length - files.length, bytes: files.reduce((total, entry) => total + entry.size, 0), excluded: [...manifest.excluded], bindingCompatible: compatible, requiresReauthentication: !compatible, warnings: [warning, ...(!compatible ? ['This backup belongs to another account or machine. Restore content only with explicit migration intent; API keys and browser sign-ins may require reauthentication.'] : [])] };
}
async function verifyPayload(root, manifest, options) {
  await options.reparseCheck(root); const actual = await walk(options.io, root, options), expected = new Map(manifest.entries.map(entry => [entry.path, entry]));
  if (actual.entries.length !== expected.size) throw fail('The backup has missing or unlisted files.');
  for (const entry of actual.entries) { const saved = expected.get(entry.path); if (!saved || saved.type !== entry.type) throw fail('The backup file structure differs from its manifest.'); if (entry.type === 'file') { const result = await hashFile(options.io, path.join(root, ...entry.path.split('/')), options.signal); if (result.size !== saved.size || result.sha256 !== saved.sha256) throw fail('A backup file failed SHA-256 verification.', 'PROFILE_BACKUP_CORRUPT'); } }
}
export async function verifyProfileBackup(value) {
  const options = settings(value), backupDir = await rootPath(options.io, options.backupDir); await options.reparseCheck(backupDir);
  const names = (await options.io.readdir(backupDir)).sort(); if (JSON.stringify(names) !== JSON.stringify(['manifest.json', 'manifest.sha256', 'payload'])) throw fail('The backup contains unexpected top-level files.');
  const file = path.join(backupDir, 'manifest.json'); if ((await plain(options.io, file, 'file')).size > 32 * 1024 * 1024) throw fail('The backup manifest is too large to verify safely.');
  if ((await plain(options.io, path.join(backupDir, 'manifest.sha256'), 'file')).size > 128) throw fail('The backup checksum record is invalid.'); const text = await options.io.readFile(file, 'utf8'), expected = (await options.io.readFile(path.join(backupDir, 'manifest.sha256'), 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(expected) || sha(text) !== expected) throw fail('The backup manifest failed SHA-256 verification.', 'PROFILE_BACKUP_CORRUPT');
  let manifest; try { manifest = parseManifest(JSON.parse(text)); } catch (error) { if (error.code) throw error; throw fail('The backup manifest is not valid JSON.'); }
  const versionParts = version => typeof version === 'string' ? version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)?.slice(1).map(value => BigInt(value)) : null;
  const savedVersion = versionParts(manifest.appVersion), currentVersion = versionParts(options.appVersion);
  const newer = savedVersion && currentVersion && savedVersion.some((part, index) => part > currentVersion[index] && savedVersion.slice(0, index).every((previous, before) => previous === currentVersion[before]));
  if (newer && options.allowNewerVersion !== true) throw fail(`This backup was created by Relay ${manifest.appVersion}, which is newer than Relay ${options.appVersion}. Use that version or newer to restore it.`, 'PROFILE_BACKUP_NEWER_VERSION');
  await verifyPayload(path.join(backupDir, 'payload'), manifest, options); const binding = await options.getBinding(); if (!bindingValid(binding)) throw fail('The current account binding could not be verified.', 'PROFILE_BINDING_UNAVAILABLE');
  const result = { ...summary(manifest, expected, binding), backupDir, versionCompatible: savedVersion && currentVersion ? !newer : null };
  if (newer) result.warnings.push('This backup was created by a newer Relay version. Explicit compatibility override was requested; profile formats may not be readable by this application.');
  else if (options.appVersion && !savedVersion) result.warnings.push('The backup application version is unknown. Profile compatibility could not be confirmed.');
  return result;
}
async function removeStage(io, parent, stage, name, reparseCheck) {
  if (!samePath(path.dirname(stage), parent) || !path.basename(stage).startsWith(name) || samePath(stage, parent)) throw fail('An unsafe maintenance cleanup path was rejected.', 'PROFILE_BACKUP_UNSAFE_PATH');
  if (await absent(io, stage)) return; await plain(io, stage, 'directory'); await reparseCheck(stage); await walk(io, stage); await io.rm(stage, { recursive: true, force: true });
}
export async function createProfileBackup(value) {
  const options = settings(value), profileDir = await rootPath(options.io, options.profileDir), backupDir = path.resolve(options.backupDir || '');
  if (!options.backupDir || !path.isAbsolute(options.backupDir) || within(profileDir, backupDir) || within(backupDir, profileDir)) throw fail('Save the backup outside the Relay profile.', 'PROFILE_BACKUP_UNSAFE_PATH');
  const parent = await rootPath(options.io, path.dirname(backupDir), true); if (!await absent(options.io, backupDir)) throw fail('That backup folder already exists. Choose a new backup name.', 'PROFILE_BACKUP_EXISTS');
  return maintenance(profileDir, options, async () => {
    if (!await absent(options.io, locations(profileDir).journal)) throw fail('Complete profile restore recovery before creating another backup.', 'PROFILE_RESTORE_RECOVERY_REQUIRED');
    await offline(profileDir, options, 'backup-start'); await options.reparseCheck(profileDir);
    const stageName = path.basename(backupDir) + '.stage-', stage = path.join(parent, stageName + randomUUID());
    try {
      await options.io.mkdir(stage, { mode: 0o700 }); const payload = path.join(stage, 'payload'); await options.io.mkdir(payload);
      const source = await walk(options.io, profileDir, { ...options, exclude: excluded }), entries = [];
      for (const entry of source.entries) { check(options.signal); const target = path.join(payload, ...entry.path.split('/')); if (entry.type === 'directory') { await options.io.mkdir(target); entries.push(entry); } else { const from = path.join(profileDir, ...entry.path.split('/')), copied = await copyFile(options.io, from, target, options.signal); await options.fault('backup-file-copied', { path: entry.path }); const current = await hashFile(options.io, from, options.signal); if (current.size !== copied.size || current.sha256 !== copied.sha256) throw fail('A profile file changed during backup. Close Relay and try again.', 'PROFILE_CHANGED'); entries.push({ path: entry.path, type: 'file', ...copied }); } }
      const after = await walk(options.io, profileDir, { ...options, exclude: excluded }); if (JSON.stringify(after.entries.map(({ path, type }) => ({ path, type }))) !== JSON.stringify(source.entries.map(({ path, type }) => ({ path, type })))) throw fail('The profile changed during backup.', 'PROFILE_CHANGED');
      for (const entry of entries) if (entry.type === 'file') { const current = await hashFile(options.io, path.join(profileDir, ...entry.path.split('/')), options.signal); if (current.size !== entry.size || current.sha256 !== entry.sha256) throw fail('A profile file changed during backup. Close Relay and try again.', 'PROFILE_CHANGED'); }
      const binding = await options.getBinding(); if (!bindingValid(binding)) throw fail('The profile account binding could not be verified.', 'PROFILE_BINDING_UNAVAILABLE');
      const manifest = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), appVersion: String(options.appVersion || ''), binding, entries, excluded: source.omitted }, text = JSON.stringify(manifest, null, 2) + '\n'; parseManifest(manifest);
      await writeDurable(options.io, path.join(stage, 'manifest.json'), text); await writeDurable(options.io, path.join(stage, 'manifest.sha256'), sha(text) + '\n');
      await verifyProfileBackup({ ...options, backupDir: stage }); await offline(profileDir, options, 'backup-publish'); await options.fault('backup-before-publish', { stage, backupDir });
      if (!await absent(options.io, backupDir)) throw fail('That backup folder already exists.', 'PROFILE_BACKUP_EXISTS'); await options.io.rename(stage, backupDir);
      return { ...summary(manifest, sha(text), binding), backupDir };
    } catch (error) { await removeStage(options.io, parent, stage, stageName, options.reparseCheck).catch(() => {}); throw error; }
  });
}
function transaction(value, profileDir) {
  const { name } = locations(profileDir);
  if (!exact(value, ['format', 'version', 'profileName', 'stageName', 'previousName', 'phase', 'createdAt']) || value.format !== TRANSACTION || value.version !== 1 || value.profileName !== name || !['prepared', 'previous-moved', 'promoted'].includes(value.phase) || !Number.isFinite(Date.parse(value.createdAt))) throw fail('Restore recovery needs attention. All profile folders were preserved.', 'PROFILE_RESTORE_RECOVERY_REQUIRED');
  for (const [field, prefix] of [['stageName', name + '.restore-stage-'], ['previousName', name + '.previous-']]) if (typeof value[field] !== 'string' || path.basename(value[field]) !== value[field] || !value[field].startsWith(prefix) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value[field].slice(prefix.length))) throw fail('Unsafe restore recovery paths were rejected. All profile folders were preserved.', 'PROFILE_RESTORE_RECOVERY_REQUIRED');
  return value;
}
async function recover(profileDir, options) {
  const { journal, parent, name } = locations(profileDir); if (await absent(options.io, journal)) return { recovered: false, action: 'none' };
  await plain(options.io, journal, 'file'); let record;
  try { if ((await options.io.stat(journal)).size > 65536) throw Error('Invalid journal'); record = transaction(JSON.parse(await options.io.readFile(journal, 'utf8')), profileDir); } catch (error) { if (error.code === 'PROFILE_RESTORE_RECOVERY_REQUIRED') throw error; throw fail('Restore recovery metadata could not be verified. Existing folders were preserved.', 'PROFILE_RESTORE_RECOVERY_REQUIRED'); }
  const stage = path.join(parent, record.stageName), previous = path.join(parent, record.previousName), hasProfile = !await absent(options.io, profileDir), hasPrevious = !await absent(options.io, previous), hasStage = !await absent(options.io, stage);
  if (hasProfile) await plain(options.io, profileDir, 'directory'); if (hasPrevious) await plain(options.io, previous, 'directory'); if (hasStage) await plain(options.io, stage, 'directory');
  if (record.phase === 'promoted' && hasProfile && hasPrevious && !hasStage) { await options.io.unlink(journal); return { recovered: true, action: 'completed', previousProfileDir: previous }; }
  if (hasPrevious) {
    await offline(previous, options, 'restore-recovery'); let quarantine;
    if (hasProfile) { await offline(profileDir, options, 'restore-recovery'); quarantine = path.join(parent, name + '.restore-quarantine-' + randomUUID()); await options.io.rename(profileDir, quarantine); }
    try { await options.io.rename(previous, profileDir); } catch (error) { throw fail('The previous Relay profile could not be recovered automatically. All folders and recovery metadata were preserved.', 'PROFILE_RESTORE_RECOVERY_REQUIRED'); }
    await removeStage(options.io, parent, stage, name + '.restore-stage-', options.reparseCheck); await options.io.unlink(journal); return { recovered: true, action: 'rolled-back', ...(quarantine ? { quarantinedProfileDir: quarantine } : {}) };
  }
  if (hasProfile && record.phase === 'prepared') { await offline(profileDir, options, 'restore-recovery'); await removeStage(options.io, parent, stage, name + '.restore-stage-', options.reparseCheck); await options.io.unlink(journal); return { recovered: true, action: 'cancelled' }; }
  throw fail('Restore recovery could not establish a complete profile. All folders were preserved.', 'PROFILE_RESTORE_RECOVERY_REQUIRED');
}
export async function recoverProfileRestore(value) {
  const options = settings(value); if (typeof options.profileDir !== 'string' || !path.isAbsolute(options.profileDir)) throw fail('Use an absolute profile folder.', 'PROFILE_BACKUP_UNSAFE_PATH');
  const profileDir = path.resolve(options.profileDir); if (samePath(profileDir, path.parse(profileDir).root)) throw fail('A filesystem root cannot be a Relay profile.', 'PROFILE_BACKUP_UNSAFE_PATH'); await rootPath(options.io, path.dirname(profileDir), true); return maintenance(profileDir, options, () => recover(profileDir, options));
}
export async function restoreProfileBackup(value) {
  const options = settings(value), profileDir = await rootPath(options.io, options.profileDir), backupDir = await rootPath(options.io, options.backupDir);
  if (within(profileDir, backupDir) || within(backupDir, profileDir)) throw fail('The backup and live profile must be separate folders.', 'PROFILE_BACKUP_UNSAFE_PATH');
  return maintenance(profileDir, options, async () => {
    await recover(profileDir, options); await offline(profileDir, options, 'restore-preflight');
    const verified = await verifyProfileBackup(options); if (!verified.bindingCompatible && options.allowForeignBinding !== true) throw fail('This backup belongs to another account or machine. Explicit migration is required and credentials will need reauthentication.', 'PROFILE_BINDING_MISMATCH');
    const { parent, name, journal } = locations(profileDir), stageName = name + '.restore-stage-' + randomUUID(), previousName = name + '.previous-' + randomUUID(), stage = path.join(parent, stageName), previous = path.join(parent, previousName);
    const record = { format: TRANSACTION, version: 1, profileName: name, stageName, previousName, phase: 'prepared', createdAt: new Date().toISOString() }; let journalWritten = false, promoted = false;
    try {
      await options.io.mkdir(stage, { mode: 0o700 });
      for (const entry of verified.manifest.entries) { const target = path.join(stage, ...entry.path.split('/')); if (entry.type === 'directory') await options.io.mkdir(target); else { const copied = await copyFile(options.io, path.join(backupDir, 'payload', ...entry.path.split('/')), target, options.signal); if (copied.size !== entry.size || copied.sha256 !== entry.sha256) throw fail('A backup file changed during restore staging.', 'PROFILE_BACKUP_CORRUPT'); } }
      await verifyPayload(stage, verified.manifest, options); await options.fault('restore-stage-verified', { stage, previous }); await offline(profileDir, options, 'restore-swap'); await options.reparseCheck(profileDir);
      await atomicJournal(options.io, journal, record); journalWritten = true; await options.fault('restore-journal-prepared', { stage, previous });
      await options.io.rename(profileDir, previous); record.phase = 'previous-moved'; await atomicJournal(options.io, journal, record); await options.fault('restore-previous-moved', { stage, previous });
      await options.io.rename(stage, profileDir); promoted = true; await options.fault('restore-profile-promoted', { profileDir, previous }); record.phase = 'promoted'; await atomicJournal(options.io, journal, record); await options.fault('restore-journal-promoted', { profileDir, previous });
      await options.io.unlink(journal); return { ...verified, profileDir, previousProfileDir: previous, restored: true };
    } catch (error) {
      if (journalWritten) {
        // A reported failure always rolls back; only a hard exit after the
        // durable promoted receipt is treated as committed during startup.
        try { if (promoted) { record.phase = 'previous-moved'; await atomicJournal(options.io, journal, record); } await recover(profileDir, options); }
        catch (recoveryError) { throw Object.assign(fail('Restore failed and automatic rollback needs attention. Previous profile and recovery folders were preserved.', 'PROFILE_RESTORE_RECOVERY_REQUIRED'), { cause: error, recoveryError }); }
      } else await removeStage(options.io, parent, stage, name + '.restore-stage-', options.reparseCheck).catch(() => {});
      throw error;
    }
  });
}
