import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserCredentialVault, BROWSER_CREDENTIAL_PROFILE } from '../lib/browser-credentials.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cryptography = key => ({
  storageBackend: 'dpapi', isEncryptionAvailable: () => true,
  encryptSecret: value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
  decryptSecret: value => { const bytes = Buffer.from(value), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); },
});
async function fixture(t, extra = {}) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-credential-vault-')), security = cryptography(randomBytes(32)), stores = [];
  const open = async options => { const vault = await new BrowserCredentialVault({ dataDir, ...security, ...extra, ...options }).init(); stores.push(vault); return vault; };
  const vault = await open(); t.after(async () => { await Promise.allSettled(stores.map(store => store.close())); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, security, vault, open };
}
const request = (requestId = 'signup:one') => ({ origin: 'https://example.test', username: 'person@example.test', requestId });
const ref = entry => ({ credentialId: entry.credentialId, revision: entry.revision, origin: entry.origin });
const context = expectedRevision => ({ source: 'user', expectedRevision });

test('generated secrets are committed encrypted before use, survive restart and never appear in metadata or backups', async t => {
  const c = await fixture(t), entry = await c.vault.generate(request()); let password;
  const receipt = await c.vault.withSecret(ref(entry), async value => { password = value.password; assert.ok((await fs.stat(c.vault.store.file)).size > 0); return { filled: true }; });
  assert.deepEqual(receipt, { filled: true }); assert.equal(password.length, 24);
  for (const pattern of [/[A-Z]/, /[a-z]/, /[0-9]/, /[!@#$%*_=+?\-]/]) assert.match(password, pattern);
  await c.vault.generate({ ...request('signup:two'), origin: 'https://second.test' });
  for (const filename of [c.vault.store.file, c.vault.store.file + '.bak']) { const bytes = await fs.readFile(filename, 'utf8'); assert.ok(!bytes.includes(password)); assert.ok(!bytes.includes(entry.username)); }
  assert.ok(!JSON.stringify(await c.vault.status()).includes(password)); assert.ok(!JSON.stringify(entry).includes(password));
  const reopened = await c.open(); await reopened.withSecret(ref(entry), value => { assert.equal(value.password, password); });
  assert.equal((await reopened.status()).profileId, BROWSER_CREDENTIAL_PROFILE); assert.equal((await reopened.status()).entries.length, 2);
});

test('same owner and request retries return the original credential across concurrent store instances', async t => {
  const c = await fixture(t), other = await c.open();
  const results = await Promise.all([c.vault.generate(request(), { ownerId: 'tool_a' }), other.generate(request(), { ownerId: 'tool_a' })]);
  assert.equal(results[0].credentialId, results[1].credentialId); assert.equal(results.filter(value => value.existing).length, 1); assert.equal((await other.status()).revision, 1);
  await assert.rejects(other.generate({ ...request(), length: 32 }, { ownerId: 'tool_a' }), { code: 'CREDENTIAL_REQUEST_CONFLICT' });
  await assert.rejects(other.generate(request(), { ownerId: 'tool_b' }), { code: 'CREDENTIAL_EXISTS' });
  const deleted = await c.vault.delete({ credentialId: results[0].credentialId, revision: 1, requestId: 'remove.1' }, context(1));
  assert.equal(deleted.deleted, true); const retry = await other.generate(request(), { ownerId: 'tool_a' }); assert.equal(retry.existing, true); assert.equal(retry.credentialId, results[0].credentialId); assert.equal((await other.list()).length, 0);
  await assert.rejects(other.withSecret(ref(retry), () => assert.fail('Deleted credential used')), { code: 'CREDENTIAL_MISSING' });
});

test('protected storage is mandatory and encryption failure or identity callbacks never write a credential', async t => {
  const c = await fixture(t);
  for (const options of [{ storageBackend: 'basic_text' }, { storageBackend: 'unknown' }, { isEncryptionAvailable: () => false }, { encryptSecret: null }]) {
    const vault = await c.open(options); assert.equal((await vault.status()).available, false); await assert.rejects(vault.generate(request()), { code: 'CREDENTIAL_STORAGE_UNAVAILABLE' });
  }
  for (const encryptSecret of [value => value, value => Buffer.from(value), () => { throw new Error('sensitive crypto failure'); }]) {
    const vault = await c.open({ encryptSecret }); await assert.rejects(vault.generate(request()), error => error.code === 'CREDENTIAL_STORAGE' && !error.message.includes('sensitive')); await assert.rejects(fs.stat(vault.store.file), { code: 'ENOENT' });
  }
});

test('vault handles and encrypted envelopes are bound to their browser profile', async t => {
  const c = await fixture(t), saved = await c.vault.generate(request()), other = await c.open({ profileId: 'persist:another-browser-profile' });
  assert.notEqual(other.store.directory, c.vault.store.directory); assert.deepEqual(await other.list(), []);
  await assert.rejects(other.withSecret(ref(saved), () => assert.fail('Cross-profile credential used')), { code: 'CREDENTIAL_MISSING' });
  await fs.copyFile(c.vault.store.file, other.store.file); assert.equal((await other.status()).healthy, false); assert.equal((await c.vault.status()).healthy, true);
});

test('wrong unlock key, damaged state, missing established state and symlink substitution fail closed without overwriting data', async t => {
  const c = await fixture(t); await c.vault.generate(request()); const original = await fs.readFile(c.vault.store.file);
  const locked = await c.open(cryptography(randomBytes(32))); assert.equal((await locked.status()).healthy, false); await assert.rejects(locked.generate({ ...request('other'), origin: 'https://other.test' }), { code: 'CREDENTIAL_STORAGE' }); assert.deepEqual(await fs.readFile(c.vault.store.file), original);
  await fs.writeFile(c.vault.store.file, '{broken'); assert.equal((await c.vault.status()).healthy, false); await assert.rejects(c.vault.generate(request('different')), { code: 'CREDENTIAL_STORAGE' }); assert.equal(await fs.readFile(c.vault.store.file, 'utf8'), '{broken');
  await fs.writeFile(c.vault.store.file, original); await c.vault.generate({ ...request('second'), origin: 'https://second.test' }); await fs.unlink(c.vault.store.file);
  assert.equal((await c.vault.status()).healthy, false); const fresh = await c.open(); assert.equal((await fresh.status()).healthy, false);
  if (process.platform !== 'win32') { const outside = path.join(c.dataDir, 'outside'); await fs.writeFile(outside, original); await fs.symlink(outside, c.vault.store.file); await assert.rejects(fresh.generate(request()), { code: 'CREDENTIAL_STORAGE' }); assert.deepEqual(await fs.readFile(outside), original); }
});

test('local save and replacement enforce independent vault and credential revisions and preserve passwords on conflicts', async t => {
  const c = await fixture(t), input = { ...request('local-save'), password: 'one,quoted"secret\nline', label: 'Site' };
  await assert.rejects(c.vault.save(input, { expectedRevision: 0 }), { code: 'CREDENTIAL_LOCAL_ONLY' });
  const saved = await c.vault.save(input, context(0)); assert.equal(saved.revision, 1);
  const replacement = { ...input, credentialId: saved.credentialId, revision: 1, password: 'new-secret-value', requestId: 'replace' };
  await assert.rejects(c.vault.save(replacement, context(0)), { code: 'CREDENTIAL_REVISION_CONFLICT' });
  await assert.rejects(c.vault.save({ ...replacement, revision: 2 }, context(1)), { code: 'CREDENTIAL_REVISION_CONFLICT' });
  const updated = await c.vault.save(replacement, context(1)); assert.equal(updated.revision, 2); assert.equal(updated.credentialId, saved.credentialId);
  await assert.rejects(c.vault.withSecret(ref(saved), () => assert.fail('Stale secret used')), { code: 'CREDENTIAL_REVISION_CONFLICT' });
  await c.vault.withSecret(ref(updated), value => { assert.equal(value.password, replacement.password); });
  assert.equal((await c.vault.save(replacement, context(0))).existing, true);
  await assert.rejects(c.vault.save({ ...replacement, password: 'changed-after-uncertain-reply' }, context(2)), { code: 'CREDENTIAL_REQUEST_CONFLICT' });
});

test('host secret access requires exact HTTPS origin and revision, serializes with edits, and redacts callback errors and results', async t => {
  const c = await fixture(t), saved = await c.vault.save({ ...request('safe'), password: 'fixture-private-password' }, context(0));
  for (const origin of ['http://example.test', 'https://example.test/path', 'https://person:secret@example.test', 'https://other.test']) await assert.rejects(c.vault.withSecret({ ...ref(saved), origin }, () => assert.fail('Cross-origin use')));
  await assert.rejects(c.vault.withSecret(ref(saved), value => ({ nested: { leaked: value.password } })), error => error.code === 'CREDENTIAL_SECRET_RESULT' && !error.message.includes('fixture-private-password'));
  await assert.rejects(c.vault.withSecret(ref(saved), value => { throw Object.assign(new Error(value.password), { code: 'PAGE_REJECTED' }); }), error => error.code === 'PAGE_REJECTED' && !error.message.includes('fixture-private-password'));
  const entered = deferred(), release = deferred(); let updated = false;
  const fill = c.vault.withSecret(ref(saved), async () => { entered.resolve(); await release.promise; return { filled: true }; }); await entered.promise;
  const update = c.vault.save({ ...request('replace'), credentialId: saved.credentialId, revision: 1, password: 'different-secret' }, context(1)).then(value => { updated = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(updated, false); release.resolve(); await fill; assert.equal((await update).revision, 2);
});

test('authorization is rechecked after lock wait and after encryption, and denied retries never return the saved receipt', async t => {
  const c = await fixture(t), saved = await c.vault.generate(request()), enter = deferred(), release = deferred(); let allowed = true;
  const authorize = () => { if (!allowed) throw Object.assign(new Error('No current permission'), { code: 'AUTH_LOST', status: 403 }); };
  const hold = c.vault.withSecret(ref(saved), async () => { enter.resolve(); await release.promise; }); await enter.promise;
  const pending = c.vault.generate({ ...request('wait'), origin: 'https://wait.test' }, { beforeCommit: authorize }); allowed = false; release.resolve(); await hold; await assert.rejects(pending, { code: 'AUTH_LOST' });
  await assert.rejects(c.vault.generate(request(), { beforeCommit: authorize }), { code: 'AUTH_LOST' });
  allowed = true; const encrypt = c.security.encryptSecret, other = await c.open({ encryptSecret: value => { const result = encrypt(value); allowed = false; return result; } });
  await assert.rejects(other.generate({ ...request('encrypt'), origin: 'https://encrypt.test' }, { beforeCommit: authorize }));
  assert.equal((await c.vault.list()).length, 1);
});

test('CSV import is bounded and atomic, accepts quoted values, and reports duplicate-password conflicts without replacing them', async t => {
  const c = await fixture(t), csv = 'name,url,username,password\r\n"Example","https://example.test/login","person@example.test","quoted,""value""\nnext"\r\n';
  await assert.rejects(c.vault.importCSV({ csv, requestId: 'import' }, { expectedRevision: 0 }), { code: 'CREDENTIAL_LOCAL_ONLY' });
  const imported = await c.vault.importCSV({ csv, requestId: 'import' }, context(0)); assert.equal(imported.imported.length, 1);
  await c.vault.withSecret(ref(imported.imported[0]), value => { assert.equal(value.password, 'quoted,"value"\nnext'); });
  const duplicate = await c.vault.importCSV({ csv: 'url,username,password\nhttps://example.test,person@example.test,different\nhttps://new.test,n,newsecret\n', requestId: 'import2' }, context(1)); assert.equal(duplicate.conflicts.length, 1); assert.equal(duplicate.imported.length, 1);
  const before = await fs.readFile(c.vault.store.file);
  await assert.rejects(c.vault.importCSV({ csv: 'url,username,password\nhttps://valid.test,n,p\nhttp://invalid.test,n,p\n', requestId: 'invalid' }, context(2)), { code: 'CREDENTIAL_INVALID' }); assert.deepEqual(await fs.readFile(c.vault.store.file), before);
  assert.equal((await c.vault.importCSV({ csv, requestId: 'import' }, context(0))).existing, true);
});

test('publication errors and cancellation never issue a newly generated usable handle', async t => {
  const c = await fixture(t), saved = await c.vault.generate(request()), original = await fs.readFile(c.vault.store.file);
  const failing = await c.open({ io: { ...fs, rename: async (from, to) => { if (to === c.vault.store.file) throw Object.assign(new Error('private disk error'), { code: 'EIO' }); return fs.rename(from, to); } } });
  await assert.rejects(failing.generate({ ...request('disk'), origin: 'https://disk.test' }), { code: 'CREDENTIAL_STORAGE' }); assert.deepEqual(await fs.readFile(c.vault.store.file), original);
  const controller = new AbortController(); controller.abort(); await assert.rejects(c.vault.withSecret(ref(saved), () => assert.fail('Cancelled callback ran'), { signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.equal((await c.vault.status()).revision, 1);
});

test('separate processes publish one idempotent generation through the on-disk lock', async t => {
  const c = await fixture(t), moduleURL = new URL('../lib/browser-credentials.mjs', import.meta.url).href, key = randomBytes(32).toString('hex'), run = promisify(execFile);
  const code = `import {BrowserCredentialVault} from ${JSON.stringify(moduleURL)}; import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto'; import {writeFile} from 'node:fs/promises';
    const key=Buffer.from(process.argv[2],'hex'); const vault=await new BrowserCredentialVault({dataDir:process.argv[1],storageBackend:'dpapi',encryptSecret:async value=>{await new Promise(r=>setTimeout(r,35));const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([c.update(value),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]);},decryptSecret:value=>{const b=Buffer.from(value),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString();}}).init();
    try {const saved=await vault.generate({origin:'https://shared.test',username:'shared',requestId:'same'});await writeFile(process.argv[3],JSON.stringify({credentialId:saved.credentialId,existing:saved.existing}));}finally{await vault.close();}`;
  const results = await Promise.all([1, 2].map(async index => { const output = path.join(c.dataDir, `process-${index}.json`); await run(process.execPath, ['--input-type=module', '--eval', code, c.dataDir, key, output], { timeout: 8000 }); return JSON.parse(await fs.readFile(output, 'utf8')); }));
  assert.equal(results[0].credentialId, results[1].credentialId); assert.equal(results.filter(value => value.existing).length, 1);
  await assert.rejects(fs.stat(c.vault.store.file + '.lock'), { code: 'ENOENT' });
});
