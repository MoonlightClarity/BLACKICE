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

test('authorized agent save/update preserves existing vault identity, restart and retries', async t => {
  const c = await fixture(t); let checks = 0;
  const options = revision => ({ source: 'agent', ownerId: 'tool_owned', expectedRevision: revision, beforeCommit: async () => { checks++; } });
  const input = { ...request('agent_save'), password: 'Synthetic-Saved-1!' };
  const saved = await c.vault.save(input, options(0));
  assert.equal(saved.revision, 1); assert.ok(checks >= 2);
  assert.equal((await c.vault.save(input, options(0))).existing, true);
  await assert.rejects(c.vault.save({ ...input, password: 'Different-1!' }, options(1)), { code: 'CREDENTIAL_REQUEST_CONFLICT' });
  const reopened = await c.open();
  await reopened.withSecret(ref(saved), row => { assert.equal(row.password, input.password); });
  const update = { ...input, credentialId: saved.credentialId, revision: 1, requestId: 'agent_update', password: 'Synthetic-Updated-2!' };
  await assert.rejects(reopened.save(update, options(0)), { code: 'CREDENTIAL_REVISION_CONFLICT' });
  const changed = await reopened.save(update, options(1));
  assert.equal(changed.credentialId, saved.credentialId); assert.equal(changed.revision, 2);
  assert.equal((await reopened.save(update, options(1))).existing, true);
  await assert.rejects(reopened.save({ ...update, requestId: 'stale_entry' }, options(2)), { code: 'CREDENTIAL_REVISION_CONFLICT' });
  const final = await c.open(); await final.withSecret(ref(changed), row => { assert.equal(row.password, update.password); });
});
test('agent save needs trusted owner and authorization, revoked writes leave store unchanged', async t => {
  const c = await fixture(t), input = { ...request('agent_authority'), password: 'Synthetic-Only-1!' };
  for (const options of [{source:'agent'}, {source:'agent',ownerId:'tool_a'}, {source:'agent',beforeCommit:()=>{} }]) {
    await assert.rejects(c.vault.save(input, {...options,expectedRevision:0}), {code:'CREDENTIAL_SAVE_AUTHORITY'});
  }
  let checks=0;
  await assert.rejects(c.vault.save(input, {source:'agent',ownerId:'tool_a',expectedRevision:0,beforeCommit:()=>{if(++checks>1) throw Error('revoked');}}));
  assert.equal((await c.vault.status()).revision,0);
  await assert.rejects(c.vault.importCSV({csv:'url,username,password\nhttps://example.test,u,p',requestId:'import'}, {source:'agent',expectedRevision:0}), {code:'CREDENTIAL_LOCAL_ONLY'});
});

test('agent password-only update preserves omitted metadata and explicit empty clears it', async t => {
  const c=await fixture(t), opts=expectedRevision=>({source:'agent',ownerId:'tool_metadata',expectedRevision,beforeCommit:async()=>{}});
  const saved=await c.vault.save({...request('metadata_create'),label:'Important account',password:'Synthetic-First-1!'},opts(0));
  const input={origin:saved.origin,credentialId:saved.credentialId,revision:saved.revision,password:'Synthetic-Second-2!',requestId:'metadata_update'};
  const updated=await c.vault.save(input,opts(1));
  assert.equal(updated.username,saved.username);assert.equal(updated.label,saved.label);
  const reopened=await c.open(), replay=await reopened.save(input,opts(1));assert.equal(replay.existing,true);assert.equal(replay.username,saved.username);
  await reopened.withSecret(ref(updated),value=>{assert.equal(value.username,saved.username);assert.equal(value.password,input.password)});
  const cleared=await reopened.save({...input,revision:updated.revision,username:'',label:'',requestId:'metadata_clear'},opts(2));
  assert.equal(cleared.username,'');assert.equal(cleared.label,'');
});

test('SSO associations bind exact account, persist opaque credentials, and revoke without changing password', async t => {
  const {vault,open}=await fixture(t), saved=await vault.generate(request()), loginOrigin='https://login.sso.test';
  const input={...ref(saved),username:saved.username,loginOrigin,operation:'allow',requestId:'associate.1'};
  const options={source:'agent',ownerId:'owned_task',expectedRevision:1,beforeCommit:async()=>{}};
  await assert.rejects(vault.withLoginSecret({...ref(saved),origin:loginOrigin},()=>assert.fail()),{code:'CREDENTIAL_ORIGIN_MISMATCH'});
  for (const extra of [{username:'different'}, {origin:'https://different.test'}]) await assert.rejects(vault.associate({...input,...extra},options),{code:'CREDENTIAL_ACCOUNT_MISMATCH'});
  await assert.rejects(vault.associate(input,{...options,beforeCommit:undefined}),{code:'CREDENTIAL_ASSOCIATION_AUTHORITY'});
  await assert.rejects(vault.associate(input,{...options,beforeCommit:()=>{throw Error('revoked')}}),/revoked/);
  let original;await vault.withSecret(ref(saved),value=>{original=value.password});
  const linked=await vault.associate(input,options), retry=await vault.associate(input,options);
  assert.equal(linked.revision,2);assert.equal(retry.existing,true);assert.equal(retry.revision,2);
  assert.deepEqual(linked.loginOrigins,[loginOrigin]);assert.ok(!JSON.stringify(linked).includes(original));
  const reopened=await open();assert.deepEqual((await reopened.list({origin:loginOrigin})).map(value=>value.credentialId),[saved.credentialId]);
  const selection={...ref(linked),origin:loginOrigin};
  await reopened.withLoginSecret(selection,value=>{assert.equal(value.password,original);assert.equal(value.origin,loginOrigin);assert.equal(value.username,saved.username)});
  // Export/mirror still cannot silently relocate a credential.
  await assert.rejects(vault.withSecret(selection,()=>assert.fail()),{code:'CREDENTIAL_ORIGIN_MISMATCH'});
  await assert.rejects(vault.withLoginSecret({...selection,origin:loginOrigin+'.evil.test'},()=>assert.fail()),{code:'CREDENTIAL_ORIGIN_MISMATCH'});
  await assert.rejects(vault.withLoginSecret({...selection,revision:1},()=>assert.fail()),{code:'CREDENTIAL_REVISION_CONFLICT'});
  const removed=await vault.associate({...input,revision:2,operation:'remove',requestId:'remove.1'},{...options,expectedRevision:2});
  await assert.rejects(vault.withLoginSecret({...ref(removed),origin:loginOrigin},()=>assert.fail()),{code:'CREDENTIAL_ORIGIN_MISMATCH'});
  await vault.withSecret(ref(removed),value=>{assert.equal(value.password,original)});
});
test('SSO fill uses the same opaque account through real browser routing; authentication remains single-dispatch', async t=>{
  const {BrowserWorkspace}=await import('../lib/browser.mjs');
  const {vault}=await fixture(t), saved=await vault.generate(request()), loginOrigin='https://login.sso.test';
  const linked=await vault.associate({...ref(saved),username:saved.username,loginOrigin,operation:'allow',requestId:'link'},context(1));
  let fills=0,auths=0;
  const target={browser:'relay',tabId:'ordinary',credentialId:linked.credentialId,revision:linked.revision,origin:loginOrigin,expectedUrl:loginOrigin+'/account',expectedDocumentId:'doc',passwordRef:'password'};
  const browser=new BrowserWorkspace({driver:{status:()=>({available:true,contained:true,tabs:[{tabId:'ordinary',browser:'relay',url:target.expectedUrl}]}),async prepareCredentialFill(args){assert.equal(args.origin,loginOrigin);return async value=>{assert.equal(value.username,saved.username);assert.equal(value.origin,loginOrigin);fills++;return {filled:true}}}}});
  t.after(()=>browser.close());
  assert.equal((await browser.fillCredential(target,{vault})).filled,true);assert.equal(fills,1);
  const auth={...target,requestId:'auth',intent:'login',submitRef:'submit'};
  const operation=async(value,mark)=>{assert.equal(value.origin,loginOrigin);assert.equal(value.username,saved.username);await mark();auths++;return{submissionRequested:true}};
  const options={ownerId:'owned',beforeDispatch:async()=>{}};
  assert.equal((await vault.authenticateOnce(auth,operation,options)).outcome,'dispatched');
  assert.equal((await vault.authenticateOnce(auth,operation,options)).existing,true);assert.equal(auths,1);
});
test('SSO association rejects nonexact origins and account updates clear associations',async t=>{
  const {vault}=await fixture(t),saved=await vault.generate(request());
  const args={...ref(saved),username:saved.username,loginOrigin:'https://login.sso.test',operation:'allow',requestId:'link'};
  for(const loginOrigin of ['http://sso.test','https://sso.test/path','https://user:pass@sso.test','https://sso.test?foo','https://*.sso.test',saved.origin]){
    // URL accepts wildcard host syntax, but associations must reject it.
    await assert.rejects(vault.associate({...args,loginOrigin},context(1)));
  }
  const linked=await vault.associate(args,context(1));
  const updated=await vault.save({...ref(linked),username:saved.username,password:'new-fixture-only',requestId:'update'},context(2));
  assert.equal(updated.loginOrigins,undefined);
  await assert.rejects(vault.withLoginSecret({...ref(updated),origin:args.loginOrigin},()=>assert.fail()),{code:'CREDENTIAL_ORIGIN_MISMATCH'});
});

test('SSO storage round-trips through the exact .104 strict reader without migrating entries',async t=>{
  const {BrowserCredentialVault:LegacyVault}=await import('./fixtures/browser-credentials-239104.mjs');
  const c=await fixture(t),saved=await c.vault.generate(request());
  const legacy=await new LegacyVault({dataDir:c.dataDir,...c.security}).init();t.after(()=>legacy.close());
  const linked=await c.vault.associate({...ref(saved),username:saved.username,loginOrigin:'https://login.sso.test',operation:'allow',requestId:'link'},context(1));
  const raw=await c.vault.store.read();assert.ok(raw.entries.every(entry=>!Object.hasOwn(entry,'loginOrigins')));
  assert.equal(raw.loginAssociations.length,1);
  const oldStatus=await legacy.status();assert.equal(oldStatus.healthy,true);assert.equal(oldStatus.entries[0].credentialId,saved.credentialId);
  let original;await legacy.withSecret(ref(linked),value=>{original=value.password});
  // A legacy writer preserves the top-level extension while creating another account.
  await legacy.generate({...request('legacy_extra'),origin:'https://other.test'});
  await c.vault.withLoginSecret({...ref(linked),origin:'https://login.sso.test'},value=>{assert.equal(value.password,original)});
  const cleared=await c.vault.associate({...ref(linked),username:saved.username,loginOrigin:'https://login.sso.test',operation:'remove',requestId:'clear'},context(3));
  assert.equal((await legacy.status()).healthy,true);
  await legacy.withSecret(ref(cleared),value=>{assert.equal(value.password,original)});
  await assert.rejects(c.vault.withLoginSecret({...ref(cleared),origin:'https://login.sso.test'},()=>assert.fail()),{code:'CREDENTIAL_ORIGIN_MISMATCH'});
});
test('legacy password update and deletion invalidate stale SSO associations on upgrade',async t=>{
  const {BrowserCredentialVault:LegacyVault}=await import('./fixtures/browser-credentials-239104.mjs');
  const c=await fixture(t),saved=await c.vault.generate(request());
  const legacy=await new LegacyVault({dataDir:c.dataDir,...c.security}).init();t.after(()=>legacy.close());
  const linked=await c.vault.associate({...ref(saved),username:saved.username,loginOrigin:'https://login.sso.test',operation:'allow',requestId:'link'},context(1));
  const updated=await legacy.save({...ref(linked),username:saved.username,password:'updated-only-fixture',requestId:'legacy_update'},context(2));
  assert.deepEqual(await c.vault.list({origin:'https://login.sso.test'}),[]);
  await assert.rejects(c.vault.withLoginSecret({...ref(updated),origin:'https://login.sso.test'},()=>assert.fail()),{code:'CREDENTIAL_ORIGIN_MISMATCH'});
  const relinked=await c.vault.associate({...ref(updated),username:updated.username,loginOrigin:'https://login.sso.test',operation:'allow',requestId:'relink'},context(3));
  await c.vault.withLoginSecret({...ref(relinked),origin:'https://login.sso.test'},value=>{assert.equal(value.password,'updated-only-fixture')});
  await legacy.delete({credentialId:relinked.credentialId,revision:relinked.revision,requestId:'legacy_delete'},context(4));
  assert.deepEqual(await c.vault.list({origin:'https://login.sso.test'}),[]);
  assert.equal((await c.vault.status()).healthy,true);
  const another=await c.vault.generate({...request('replacement')});
  assert.notEqual(another.credentialId,saved.credentialId);
  await assert.rejects(c.vault.withLoginSecret({...ref(another),origin:'https://login.sso.test'},()=>assert.fail()),{code:'CREDENTIAL_ORIGIN_MISMATCH'});
});
test('SSO association state accepts only bounded exact extension records',async t=>{
  const c=await fixture(t),saved=await c.vault.generate(request());
  await c.vault.associate({...ref(saved),username:saved.username,loginOrigin:'https://login.sso.test',operation:'allow',requestId:'link'},context(1));
  const raw=await c.vault.store.read();
  for(const mutation of [state=>state.loginAssociations.push({...state.loginAssociations[0]}),state=>state.loginAssociations[0].loginOrigins=['https://*.sso.test'],state=>state.loginAssociations[0].extra='unexpected']){
    const state=structuredClone(raw);mutation(state);assert.throws(()=>c.vault.store.validate(state));
  }
});

test('restoring protected pre-association backup preserves original login without granting an SSO alias',async t=>{
  const {BrowserCredentialVault:LegacyVault}=await import('./fixtures/browser-credentials-239104.mjs');
  const c=await fixture(t),saved=await c.vault.generate(request());let original;
  await c.vault.withSecret(ref(saved),value=>{original=value.password});
  await c.vault.associate({...ref(saved),username:saved.username,loginOrigin:'https://login.sso.test',operation:'allow',requestId:'link'},context(1));
  // Synthetic isolated backup restore only, never the user's vault.
  await fs.copyFile(c.vault.store.file+'.bak',c.vault.store.file);
  const legacy=await new LegacyVault({dataDir:c.dataDir,...c.security}).init();t.after(()=>legacy.close());
  assert.equal((await legacy.status()).healthy,true);
  await legacy.withSecret(ref(saved),value=>{assert.equal(value.password,original)});
  const upgraded=await c.open();assert.deepEqual(await upgraded.list({origin:'https://login.sso.test'}),[]);
  await assert.rejects(upgraded.withLoginSecret({...ref(saved),origin:'https://login.sso.test'},()=>assert.fail()),{code:'CREDENTIAL_ORIGIN_MISMATCH'});
});

test('human reveal retrieves only an exact current login without changing stored state', async t => {
 const c=await fixture(t), entry=await c.vault.generate(request()), before=await fs.readFile(c.vault.store.file);
 const result=await c.vault.reveal(ref(entry),context());
 assert.equal(result.password.length,24);assert.equal(result.credentialId,entry.credentialId);
 assert.deepEqual(await fs.readFile(c.vault.store.file),before);
 assert.ok(!JSON.stringify(await c.vault.status()).includes(result.password));
 await assert.rejects(c.vault.reveal(ref(entry),{source:'agent'}),{code:'CREDENTIAL_LOCAL_ONLY'});
 await assert.rejects(c.vault.reveal({...ref(entry),revision:999},context()),{code:'CREDENTIAL_REVISION_CONFLICT'});
 await assert.rejects(c.vault.reveal({...ref(entry),origin:'https://other.test'},context()),{code:'CREDENTIAL_ORIGIN_MISMATCH'});
});
