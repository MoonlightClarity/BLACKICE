import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { IdentityStore, DEFAULT_SOUL } from '../lib/identity.mjs';

const old = await fs.readFile(new URL('./fixtures/soul-default-20261029.md', import.meta.url), 'utf8');
async function fixture(t, content = old, provenance = { source: 'seed' }) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-soul-refresh-'));
  const stores = [];
  const open = async () => { const s = await new IdentityStore({dataDir}).init(); stores.push(s); return s; };
  t.after(async () => { for (const s of stores) await s.close(); await fs.rm(dataDir, {recursive:true, force:true}); });
  const store = await open(), before = await store.read('soul');
  await store.update({kind:'soul', content, expectedRevision:before.revision, expectedHash:before.diskHash, provenance});
  return {dataDir, store, open};
}
test('identity refresh is concise and prior seed is exact', () => {
  assert.equal(createHash('sha256').update(old).digest('hex'), '18658fa7e02228a5288c9e66c73e08991b192b4735f344ae7e7988ab92928039');
  assert.ok(DEFAULT_SOUL.length <= old.length);
  assert.match(DEFAULT_SOUL, /calibrated inference/);
  assert.match(DEFAULT_SOUL, /not new authority/);
  assert.match(DEFAULT_SOUL, /actual authorization and tool limits/);
});
for (const provenance of [{source:'seed'}, {source:'development', reason:'Updated the unchanged starter identity to the fixed BLACKICE identity.'}]) {
  test('refreshes exact shipped identity with '+provenance.source+' provenance once', async t => {
    const {dataDir, store, open} = await fixture(t, old, provenance);
    const prior = await store.snapshot(), user = await store.read('user');
    const upgraded = await open(), current = await upgraded.read('soul');
    assert.equal(current.content, DEFAULT_SOUL);
    assert.equal(current.revision, prior.documents.soul.revision + 1);
    assert.equal(prior.documents.soul.content, old);
    assert.equal((await upgraded.readVersion('soul', current.revision - 1)).content, old);
    assert.equal(await fs.readFile(path.join(dataDir,'identity','SOUL.md.bak'),'utf8'), old);
    assert.deepEqual(await upgraded.read('user'), user);
    assert.equal((await (await open()).read('soul')).revision, current.revision);
    assert.ok((await upgraded.snapshot()).text.includes('calibrated inference'));
  });
}
for (const [label,content,provenance] of [
 ['custom','# My identity',{source:'seed'}], ['empty','',{source:'user'}],
 ['edited seed',old+'\n',{source:'seed'}], ['user restored seed',old,{source:'user',restoredFrom:1}],
 ['other development change',old,{source:'development',reason:'Custom edit'}], ['external seed',old,{source:'external'}]
]) test('preserves '+label, async t => {
 const {store,open}=await fixture(t,content,provenance), before=await store.read('soul');
 const after=await (await open()).read('soul');
 assert.equal(after.content,content); assert.equal(after.revision,before.revision);
});
