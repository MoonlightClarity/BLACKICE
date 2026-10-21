import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProfileBackup, verifyProfileBackup, restoreProfileBackup, recoverProfileRestore } from '../lib/profile-backup.mjs';

const binding = { platform: 'win32', userIdHash: 'a'.repeat(64), machineIdHash: 'b'.repeat(64) };
const options = { getBinding: async () => binding, reparseCheck: async () => {}, isProcessAlive: () => false };
const hash = value => createHash('sha256').update(value).digest('hex');
const put = async (root, name, text) => { const file = path.join(root, ...name.split('/')); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
const read = (root, name) => fs.readFile(path.join(root, ...name.split('/')), 'utf8');
const present = async file => { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-profile-backup-')), profileDir = path.join(directory, 'RelayProfile'), backupDir = path.join(directory, 'saved.relay-backup'); await fs.mkdir(profileDir);
  const files = {
    'data/conversations/chat.json': '{"fixture":"saved conversation"}', 'data/providers.json': '{"encrypted":"fixture-ciphertext"}', 'data/identity/SOUL.md': 'Personal agent identity.',
    'workspace/chess.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40"/></svg>', 'workspace/Cache/user-file.txt': 'A project folder called Cache is real content.',
    'Partitions/relay-browser/Network/Cookies': 'fixture-encrypted-cookie-db', 'Partitions/relay-browser/Preferences': '{"browser":"preferences"}',
    'Local Storage/leveldb/000003.log': 'Actual unsaved conversation draft.', 'Preferences': '{"app":"preferences"}', 'Local State': '{"encrypted_key":"fixture-only"}', 'window-state.json': '{"width":1100}', 'desktop-port.json': '{"port":59486}',
  };
  for (const [file, text] of Object.entries(files)) await put(profileDir, file, text);
  for (const file of ['Cache/temporary', 'GPUCache/generated', 'Partitions/relay-browser/Cache/generated', 'Local Storage/leveldb/LOCK', 'SingletonLock']) await put(profileDir, file, 'regenerable fixture');
  await put(profileDir, 'desktop-runtime.json', JSON.stringify({ pid: 123456 }));
  t.after(async () => { assert.match(path.basename(directory), /^relay-profile-backup-/); assert.equal(path.dirname(profileDir), directory); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, profileDir, backupDir, files, args: { ...options, profileDir, backupDir, appVersion: 'release-test' } };
}
async function rewriteManifest(backupDir, transform) {
  const file = path.join(backupDir, 'manifest.json'), value = JSON.parse(await fs.readFile(file, 'utf8')); transform(value);
  const text = JSON.stringify(value); await fs.writeFile(file, text); await fs.writeFile(path.join(backupDir, 'manifest.sha256'), hash(text) + '\n');
}

test('an offline whole-profile backup verifies and restores chats, workspace, browser partitions, preferences and drafts with the previous profile preserved', async t => {
  const f = await fixture(t), backup = await createProfileBackup(f.args);
  assert.equal(backup.files, Object.keys(f.files).length); assert.equal(backup.bindingCompatible, true); assert.equal(backup.requiresReauthentication, false); assert.match(backup.warnings[0], /credentials are not portable/);
  assert.ok(backup.excluded.includes('Cache')); assert.ok(backup.excluded.includes('desktop-runtime.json')); assert.ok(backup.excluded.includes('Local Storage/leveldb/LOCK')); assert.ok(backup.manifest.entries.some(entry => entry.path === 'workspace/Cache/user-file.txt'));
  const verified = await verifyProfileBackup({ ...options, backupDir: f.backupDir }); assert.equal(verified.manifestSha256, backup.manifestSha256); assert.equal(verified.bytes, Object.values(f.files).reduce((sum, text) => sum + Buffer.byteLength(text), 0));
  await put(f.profileDir, 'workspace/current-only.txt', 'Preserve the state immediately before restore.'); await put(f.profileDir, 'data/providers.json', 'Current fixture provider settings.');
  const restored = await restoreProfileBackup(f.args); assert.equal(restored.restored, true); assert.equal(path.dirname(restored.previousProfileDir), f.directory);
  for (const [file, text] of Object.entries(f.files)) assert.equal(await read(f.profileDir, file), text);
  assert.equal(await read(restored.previousProfileDir, 'workspace/current-only.txt'), 'Preserve the state immediately before restore.'); assert.equal(await read(restored.previousProfileDir, 'data/providers.json'), 'Current fixture provider settings.');
  assert.equal(await present(path.join(f.profileDir, 'desktop-runtime.json')), false); assert.equal(await present(path.join(f.profileDir, 'Cache')), false); assert.equal(await present(path.join(f.profileDir, 'workspace/current-only.txt')), false);
  assert.deepEqual(await recoverProfileRestore({ ...options, profileDir: f.profileDir }), { recovered: false, action: 'none' });
});

test('profile backup omits orphan password-import exports while preserving encrypted vaults, queues and unrelated user folders', async t => {
  const f = await fixture(t), profileKey = 'a'.repeat(24), credentialRoot = `data/browser-credentials/${profileKey}`;
  const retained = {
    [`${credentialRoot}/vault.json`]: '{"encoding":"base64","sealed":"fixture-encrypted-vault"}',
    [`${credentialRoot}/vault.json.bak`]: '{"encoding":"base64","sealed":"fixture-encrypted-backup"}',
    [`${credentialRoot}/mirror.json`]: '{"encoding":"base64","sealed":"fixture-encrypted-queue"}',
    [`${credentialRoot}/export-notes/keep.txt`]: 'A separate saved note stays in the backup.',
    'data/browser-credentials/not-a-profile/exports/keep.txt': 'A user folder that is not a credential profile stays.',
    [`workspace/browser-credentials/${profileKey}/exports/keep.txt`]: 'An unrelated workspace folder stays.',
  };
  for (const [name, value] of Object.entries(retained)) await put(f.profileDir, name, value);
  const exportRoots = [`${credentialRoot}/exports`, `data/browser-credentials/${'B'.repeat(24)}/Exports`];
  for (const root of exportRoots) { await put(f.profileDir, root + '/batch-fixture/passwords.csv', 'name,url,username,password\r\nFixture,https://example.test,owned,ORPHAN-PLAINTEXT-FIXTURE\r\n'); await put(f.profileDir, root + '/batch-fixture/owner.json', '{"fixture":"interrupted export"}'); }
  const backup = await createProfileBackup(f.args), payload = path.join(f.backupDir, 'payload');
  for (const root of exportRoots) {
    assert.ok(backup.excluded.some(value => value.toLowerCase() === root.toLowerCase()));
    assert.ok(!backup.manifest.entries.some(entry => entry.path.toLowerCase().startsWith(root.toLowerCase() + '/') || entry.path.toLowerCase() === root.toLowerCase()));
    assert.equal(await present(path.join(payload, ...root.split('/'))), false);
    assert.match(await read(f.profileDir, root + '/batch-fixture/passwords.csv'), /ORPHAN-PLAINTEXT-FIXTURE/, 'Backup exclusion does not mutate the offline source profile.');
  }
  for (const [name, value] of Object.entries(retained)) assert.equal(await read(payload, name), value);
  const verified = await verifyProfileBackup({ ...options, backupDir: f.backupDir }); assert.equal(verified.files, Object.keys(f.files).length + Object.keys(retained).length);
  await restoreProfileBackup(f.args);
  for (const [name, value] of Object.entries(retained)) assert.equal(await read(f.profileDir, name), value);
  for (const root of exportRoots) assert.equal(await present(path.join(f.profileDir, ...root.split('/'))), false);
});

test('a correctly checksummed manifest cannot reintroduce a transient password export during restore', async t => {
  const f = await fixture(t), root = `data/browser-credentials/${'c'.repeat(24)}`;
  await put(f.profileDir, root + '/vault.json', 'fixture-encrypted-record'); await createProfileBackup(f.args);
  const csvPath = root + '/exports/batch-fixture/passwords.csv', secret = 'fixture-transient-password'; await put(path.join(f.backupDir, 'payload'), csvPath, secret);
  await rewriteManifest(f.backupDir, value => { value.entries.push({ path: root + '/exports', type: 'directory' }, { path: root + '/exports/batch-fixture', type: 'directory' }, { path: csvPath, type: 'file', size: Buffer.byteLength(secret), sha256: hash(secret) }); });
  await assert.rejects(verifyProfileBackup({ ...options, backupDir: f.backupDir }), { code: 'PROFILE_BACKUP_INVALID' });
  await assert.rejects(restoreProfileBackup(f.args), { code: 'PROFILE_BACKUP_INVALID' });
  assert.equal(await read(f.profileDir, root + '/vault.json'), 'fixture-encrypted-record'); assert.equal(await present(path.join(f.profileDir, ...csvPath.split('/'))), false);
});

test('same-size and same-mtime backup corruption is detected by content hashes before the live profile changes', async t => {
  const f = await fixture(t); await createProfileBackup(f.args); const target = path.join(f.backupDir, 'payload', 'Preferences'), stat = await fs.stat(target), original = await fs.readFile(target);
  await fs.writeFile(target, Buffer.alloc(original.length, 88)); await fs.utimes(target, stat.atime, stat.mtime);
  await assert.rejects(restoreProfileBackup(f.args), { code: 'PROFILE_BACKUP_CORRUPT' }); assert.equal(await read(f.profileDir, 'Preferences'), f.files.Preferences); assert.equal((await fs.readdir(f.directory)).filter(name => name.includes('.previous-')).length, 0);
});

test('backup creation detects source edits even when their size and mtime are restored and never publishes a partial backup', async t => {
  const f = await fixture(t); let changed = false;
  await assert.rejects(createProfileBackup({ ...f.args, fault: async (phase, value) => {
    if (phase !== 'backup-file-copied' || value.path !== 'Preferences' || changed) return; changed = true;
    const file = path.join(f.profileDir, 'Preferences'), stat = await fs.stat(file), text = await fs.readFile(file); await fs.writeFile(file, Buffer.alloc(text.length, 89)); await fs.utimes(file, stat.atime, stat.mtime);
  } }), { code: 'PROFILE_CHANGED' });
  assert.equal(changed, true); assert.equal(await present(f.backupDir), false); assert.ok((await fs.readdir(f.directory)).every(name => !name.includes('.stage-')));
});

test('malicious or unsupported manifests cannot traverse, collide paths, introduce transient runtime files or create missing parents', async t => {
  const f = await fixture(t); await createProfileBackup(f.args); const original = await read(f.backupDir, 'manifest.json'), checksum = await read(f.backupDir, 'manifest.sha256');
  const changes = [
    value => { value.version = 999; }, value => { value.entries[0].path = '../escape'; }, value => { value.entries[0].path = 'C:/escape'; }, value => { value.entries[0].path = 'data\\escape'; }, value => { value.entries[0].path = 'data/file:stream'; }, value => { value.entries[0].path = 'data/CON'; },
    value => { value.entries.push({ ...value.entries.find(entry => entry.type === 'file'), path: 'desktop-runtime.json' }); },
    value => { value.entries.push({ ...value.entries.find(entry => entry.type === 'file'), path: 'not-a-parent/file' }); },
    value => { value.entries.push({ ...value.entries.find(entry => entry.path === 'Preferences'), path: 'preferences' }); }, value => { value.entries[0].extra = 'untrusted'; },
  ];
  for (const change of changes) { await fs.writeFile(path.join(f.backupDir, 'manifest.json'), original); await fs.writeFile(path.join(f.backupDir, 'manifest.sha256'), checksum); await rewriteManifest(f.backupDir, change); await assert.rejects(restoreProfileBackup(f.args), error => error.code === 'PROFILE_BACKUP_INVALID'); assert.equal(await read(f.profileDir, 'Preferences'), f.files.Preferences); }
  assert.equal(await present(path.join(f.directory, 'escape')), false);
});

test('manifest checksum edits and unlisted payload files are rejected and symlink or junction payloads are never followed', async t => {
  const f = await fixture(t); await createProfileBackup(f.args); const file = path.join(f.backupDir, 'manifest.json'), original = await fs.readFile(file, 'utf8'); await fs.appendFile(file, ' ');
  await assert.rejects(verifyProfileBackup({ ...options, backupDir: f.backupDir }), { code: 'PROFILE_BACKUP_CORRUPT' }); await fs.writeFile(file, original);
  await put(path.join(f.backupDir, 'payload'), 'unlisted.txt', 'No manifest receipt.'); await assert.rejects(verifyProfileBackup({ ...options, backupDir: f.backupDir }), /missing or unlisted/); await fs.unlink(path.join(f.backupDir, 'payload', 'unlisted.txt'));
  const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside); await put(outside, 'untouched.txt', 'External data stays untouched.');
  await fs.symlink(outside, path.join(f.backupDir, 'payload', 'redirected'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(restoreProfileBackup(f.args), { code: 'PROFILE_BACKUP_UNSAFE_PATH' }); assert.equal(await read(outside, 'untouched.txt'), 'External data stays untouched.');
});

test('live profiles and explicit offline guards are rejected while backup verification remains available online', async t => {
  const f = await fixture(t);
  await assert.rejects(createProfileBackup({ ...f.args, isProcessAlive: () => true }), { code: 'PROFILE_BUSY' }); assert.equal(await present(f.backupDir), false);
  await createProfileBackup(f.args);
  await assert.rejects(restoreProfileBackup({ ...f.args, assertOffline: () => false }), { code: 'PROFILE_BUSY' }); assert.equal(await read(f.profileDir, 'Preferences'), f.files.Preferences);
  const verified = await verifyProfileBackup({ ...f.args, isProcessAlive: () => true, assertOffline: () => false }); assert.equal(verified.files, Object.keys(f.files).length);
});

test('foreign-account restore requires explicit migration intent and returns a reauthentication receipt', async t => {
  const f = await fixture(t); await createProfileBackup(f.args); const foreign = { ...binding, machineIdHash: 'c'.repeat(64) }, getBinding = async () => foreign;
  const verified = await verifyProfileBackup({ ...f.args, getBinding }); assert.equal(verified.bindingCompatible, false); assert.equal(verified.requiresReauthentication, true);
  await assert.rejects(restoreProfileBackup({ ...f.args, getBinding }), { code: 'PROFILE_BINDING_MISMATCH' });
  const restored = await restoreProfileBackup({ ...f.args, getBinding, allowForeignBinding: true }); assert.equal(restored.requiresReauthentication, true); assert.match(restored.warnings.join(' '), /require reauthentication/); assert.equal(await read(f.profileDir, 'data/conversations/chat.json'), f.files['data/conversations/chat.json']); assert.equal(await read(f.profileDir, 'data/providers.json'), f.files['data/providers.json'], 'encrypted bytes are copied, never claimed to decrypt on another machine');
});

test('injected restore failures after moving or promoting the profile roll back the complete original profile', async t => {
  for (const phase of ['restore-previous-moved', 'restore-profile-promoted', 'restore-journal-promoted']) {
    const f = await fixture(t); await createProfileBackup(f.args); await put(f.profileDir, 'Preferences', 'CURRENT_COMPLETE_PROFILE'); await put(f.profileDir, 'workspace/current-only.txt', 'Current work survives failed restore.');
    await assert.rejects(restoreProfileBackup({ ...f.args, fault: async current => { if (current === phase) throw Error('Injected restore failure.'); } }), /Injected restore failure/);
    assert.equal(await read(f.profileDir, 'Preferences'), 'CURRENT_COMPLETE_PROFILE'); assert.equal(await read(f.profileDir, 'workspace/current-only.txt'), 'Current work survives failed restore.'); assert.equal((await fs.readdir(f.directory)).filter(name => name.includes('.restore-transaction')).length, 0);
    await verifyProfileBackup({ ...options, backupDir: f.backupDir });
  }
});

test('a real rename failure during publication rolls back and a failed rollback retains a recoverable transaction', async t => {
  const f = await fixture(t); await createProfileBackup(f.args); await put(f.profileDir, 'Preferences', 'CURRENT_PROFILE_BEFORE_RENAME_FAILURE'); let failures = 1;
  const io = { ...fs, rename: async (source, target) => { if (target === f.profileDir && failures-- > 0) throw Object.assign(Error('Injected filesystem rename failure'), { code: 'EACCES' }); return fs.rename(source, target); } };
  await assert.rejects(restoreProfileBackup({ ...f.args, io }), /rename failure/); assert.equal(await read(f.profileDir, 'Preferences'), 'CURRENT_PROFILE_BEFORE_RENAME_FAILURE');
  const broken = { ...fs, rename: async (source, target) => { if (target === f.profileDir) throw Object.assign(Error('Target temporarily unavailable'), { code: 'EACCES' }); return fs.rename(source, target); } };
  await assert.rejects(restoreProfileBackup({ ...f.args, io: broken }), { code: 'PROFILE_RESTORE_RECOVERY_REQUIRED' });
  const recovered = await recoverProfileRestore({ ...options, profileDir: f.profileDir }); assert.equal(recovered.action, 'rolled-back'); assert.equal(await read(f.profileDir, 'Preferences'), 'CURRENT_PROFILE_BEFORE_RENAME_FAILURE');
});

test('startup recovers actual hard exits during every restore swap phase and preserves an unexpectedly recreated profile', async t => {
  const module = new URL('../lib/profile-backup.mjs', import.meta.url).href, runChild = promisify(execFile);
  for (const [phase, recreate] of [['restore-journal-prepared', false], ['restore-previous-moved', false], ['restore-previous-moved', true], ['restore-profile-promoted', false], ['restore-journal-promoted', false]]) {
    const f = await fixture(t); await createProfileBackup(f.args); await put(f.profileDir, 'Preferences', 'ORIGINAL_PROFILE_BEFORE_HARD_EXIT');
    const script = `import {restoreProfileBackup} from ${JSON.stringify(module)}; await restoreProfileBackup({profileDir:${JSON.stringify(f.profileDir)},backupDir:${JSON.stringify(f.backupDir)},getBinding:async()=>(${JSON.stringify(binding)}),reparseCheck:async()=>{},isProcessAlive:()=>false,fault:async phase=>{if(phase===${JSON.stringify(phase)})process.exit(73)}});process.exit(74);`;
    await assert.rejects(runChild(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true }), error => error.code === 73);
    if (recreate) { await fs.mkdir(f.profileDir); await put(f.profileDir, 'unexpected-user-file.txt', 'Never discard a recreated profile.'); }
    const recovered = await recoverProfileRestore({ ...options, profileDir: f.profileDir }); assert.equal(recovered.recovered, true);
    if (phase === 'restore-journal-promoted') { assert.equal(recovered.action, 'completed'); assert.equal(await read(f.profileDir, 'Preferences'), f.files.Preferences); assert.equal(await read(recovered.previousProfileDir, 'Preferences'), 'ORIGINAL_PROFILE_BEFORE_HARD_EXIT'); }
    else { assert.equal(await read(f.profileDir, 'Preferences'), 'ORIGINAL_PROFILE_BEFORE_HARD_EXIT'); assert.ok(['cancelled', 'rolled-back'].includes(recovered.action)); }
    if (recreate) assert.equal(await read(recovered.quarantinedProfileDir, 'unexpected-user-file.txt'), 'Never discard a recreated profile.');
    assert.deepEqual(await recoverProfileRestore({ ...options, profileDir: f.profileDir }), { recovered: false, action: 'none' }); await verifyProfileBackup({ ...options, backupDir: f.backupDir });
  }
});

test('malicious restore journals cannot move or delete paths outside the exact generated profile siblings', async t => {
  const f = await fixture(t), outside = path.join(f.directory, 'outside'); await fs.mkdir(outside); await put(outside, 'keep.txt', 'Protected external fixture.');
  const journal = path.join(f.directory, '.RelayProfile.restore-transaction.json'), record = { format: 'relay-profile-restore', version: 1, profileName: 'RelayProfile', stageName: '../outside', previousName: 'RelayProfile.previous-' + randomUUID(), phase: 'previous-moved', createdAt: new Date().toISOString() };
  await fs.writeFile(journal, JSON.stringify(record)); await assert.rejects(recoverProfileRestore({ ...options, profileDir: f.profileDir }), { code: 'PROFILE_RESTORE_RECOVERY_REQUIRED' }); assert.equal(await read(outside, 'keep.txt'), 'Protected external fixture.'); assert.equal(await present(journal), true); assert.equal(await read(f.profileDir, 'Preferences'), f.files.Preferences);
});

test('recovery never recursively cleans a generated staging folder containing a redirected child', async t => {
  const f = await fixture(t), outside = path.join(f.directory, 'outside'), stageName = 'RelayProfile.restore-stage-' + randomUUID(), stage = path.join(f.directory, stageName); await fs.mkdir(outside); await fs.mkdir(stage); await put(outside, 'keep.txt', 'External bytes stay intact.');
  await fs.symlink(outside, path.join(stage, 'redirected'), process.platform === 'win32' ? 'junction' : 'dir');
  const journal = path.join(f.directory, '.RelayProfile.restore-transaction.json'); await fs.writeFile(journal, JSON.stringify({ format: 'relay-profile-restore', version: 1, profileName: 'RelayProfile', stageName, previousName: 'RelayProfile.previous-' + randomUUID(), phase: 'prepared', createdAt: new Date().toISOString() }));
  await assert.rejects(recoverProfileRestore({ ...options, profileDir: f.profileDir }), { code: 'PROFILE_BACKUP_UNSAFE_PATH' }); assert.equal(await read(outside, 'keep.txt'), 'External bytes stay intact.'); assert.equal(await present(stage), true); assert.equal(await present(journal), true); assert.equal(await read(f.profileDir, 'Preferences'), f.files.Preferences);
});

test('a live maintenance lock blocks concurrent changes and a dead worker lock is safely reclaimed', async t => {
  const f = await fixture(t), lock = path.join(f.directory, '.RelayProfile.profile-maintenance.lock'); await fs.writeFile(lock, JSON.stringify({ pid: 123456, token: 'old-worker' }));
  await assert.rejects(createProfileBackup({ ...f.args, isProcessAlive: () => true }), { code: 'PROFILE_MAINTENANCE_BUSY' }); assert.equal(await present(f.backupDir), false); assert.equal(await present(lock), true);
  const backup = await createProfileBackup(f.args); assert.equal(backup.files, Object.keys(f.files).length); assert.equal(await present(lock), false);
});

test('two workers observing one stale lock cannot delete each other’s live maintenance lock',async t=>{
  const f=await fixture(t),lock=path.join(f.directory,'.RelayProfile.profile-maintenance.lock');await fs.writeFile(lock,JSON.stringify({pid:123456,token:'dead-generation'}));
  let reads=0,releaseReads,started,releaseOperation;const bothRead=new Promise(resolve=>releaseReads=resolve),firstStarted=new Promise(resolve=>started=resolve),operationHeld=new Promise(resolve=>releaseOperation=resolve),entered=[];
  const workerIO=index=>({...fs,readFile:async(file,...args)=>{const text=await fs.readFile(file,...args);if(file===lock&&reads<2){reads++;if(reads===2)releaseReads();await bothRead;}return text;},link:async(source,target)=>{if(index===2&&target.startsWith(lock+'.reclaim-'))await firstStarted;return fs.link(source,target);},unlink:async file=>{if(index===2&&file===lock)await firstStarted;return fs.unlink(file);}});
  const jobs=[1,2].map(index=>createProfileBackup({...f.args,backupDir:path.join(f.directory,`concurrent-${index}`),io:workerIO(index),isProcessAlive:pid=>pid===process.pid,fault:async phase=>{if(phase==='backup-file-copied'){entered.push(index);if(index===1)started();await operationHeld;}}}));
  let refusal;const rejected=Promise.race(jobs.map(job=>job.then(()=>new Promise(()=>{}),error=>{refusal=error;return error;})));let timer;
  try{await firstStarted;const value=await Promise.race([rejected,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),5000);})]);assert.ok(value,'the contender must be refused while the first worker still owns maintenance');assert.equal(refusal.code,'PROFILE_MAINTENANCE_BUSY');assert.deepEqual(entered,[1]);}
  finally{clearTimeout(timer);releaseOperation();await Promise.allSettled(jobs);}
  const results=await Promise.allSettled(jobs);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(await present(path.join(f.directory,'concurrent-1')),true);assert.equal(await present(path.join(f.directory,'concurrent-2')),false);assert.equal(await present(lock),false);
});

test('newer-version backups are refused before restore while an explicit API override retains a compatibility warning',async t=>{
  const f=await fixture(t);await createProfileBackup({...f.args,appVersion:'9.0.0'});await put(f.profileDir,'Preferences','CURRENT_OLDER_APPLICATION_PROFILE');
  await assert.rejects(verifyProfileBackup({...f.args,appVersion:'2.12.0'}),{code:'PROFILE_BACKUP_NEWER_VERSION'});await assert.rejects(restoreProfileBackup({...f.args,appVersion:'2.12.0'}),{code:'PROFILE_BACKUP_NEWER_VERSION'});assert.equal(await read(f.profileDir,'Preferences'),'CURRENT_OLDER_APPLICATION_PROFILE');assert.equal((await fs.readdir(f.directory)).filter(name=>name.includes('.previous-')).length,0);
  const allowed=await restoreProfileBackup({...f.args,appVersion:'2.12.0',allowNewerVersion:true});assert.equal(allowed.restored,true);assert.equal(allowed.versionCompatible,false);assert.match(allowed.warnings.join(' '),/newer Relay version/);
  const compatible=await verifyProfileBackup({...f.args,appVersion:'10.0.0'});assert.equal(compatible.versionCompatible,true);
});

test('a hard exit during stale-lock reclamation leaves a claim that a later worker can safely recover',async t=>{
  const f=await fixture(t),lock=path.join(f.directory,'.RelayProfile.profile-maintenance.lock');await fs.writeFile(lock,JSON.stringify({pid:123456,token:'old-dead-worker'}));
  const module=new URL('../lib/profile-backup.mjs',import.meta.url).href,script=`import{promises as fs}from'node:fs';import{createProfileBackup}from ${JSON.stringify(module)};const io={...fs,link:async(source,target)=>{await fs.link(source,target);if(target.startsWith(${JSON.stringify(lock+'.reclaim-')}))process.exit(73);}};await createProfileBackup({profileDir:${JSON.stringify(f.profileDir)},backupDir:${JSON.stringify(f.backupDir)},io,getBinding:async()=>(${JSON.stringify(binding)}),reparseCheck:async()=>{},isProcessAlive:()=>false});process.exit(74);`;
  await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',script],{windowsHide:true}),error=>error.code===73);
  const backup=await createProfileBackup(f.args);assert.equal(backup.files,Object.keys(f.files).length);assert.equal(await read(f.profileDir,'Preferences'),f.files.Preferences);assert.equal(await present(lock),false);await verifyProfileBackup({...options,backupDir:f.backupDir});
});
