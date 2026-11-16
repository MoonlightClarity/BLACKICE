import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {IdentityStore,DEFAULT_SOUL,createIdentityToolHandler,IDENTITY_INSTRUCTIONS} from '../lib/identity.mjs';
const exact=await fs.readFile(new URL('./fixtures/soul-default-20261116.md',import.meta.url));
const previous=await fs.readFile(new URL('./fixtures/soul-default-20261115.md',import.meta.url),'utf8');
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(tmpdir(),'blackice-release-soul-'));const stores=[];const open=async()=>{const s=await new IdentityStore({dataDir}).init();stores.push(s);return s;};t.after(async()=>{for(const s of stores)await s.close();await fs.rm(dataDir,{recursive:true,force:true});});return {dataDir,open};}
test('fresh profile receives exact owner supplied release text and restart is idempotent',async t=>{
 const {dataDir,open}=await fixture(t);const s=await open(),doc=await s.read('soul');
 assert.equal(createHash('sha256').update(exact).digest('hex'),'456f447a1a43dc8bc9682572333836c92768276abc75383a323a4b80e564a649');
 assert.deepEqual(Buffer.from(DEFAULT_SOUL),exact);assert.deepEqual(await fs.readFile(path.join(dataDir,'identity','SOUL.md')),exact);
 assert.equal((await (await open()).read('soul')).revision,doc.revision);
 const snap=await s.snapshot();assert.equal(snap.documents.soul.truncated,false);assert.equal(snap.documents.soul.hash,doc.hash);assert.ok(Object.isFrozen(snap.documents.soul));
});
for(const source of [{source:'seed'},{source:'development',reason:'Refreshed the unchanged shipped identity for calibrated user advocacy.'}])test('upgrades exact prior system default only: '+source.source,async t=>{
 const {open}=await fixture(t);const s=await open(),before=await s.read('soul');
 const old=await s.update({kind:'soul',content:previous,expectedRevision:before.revision,expectedHash:before.diskHash,provenance:source});
 const snap=await s.snapshot(),user=await s.read('user');const upgraded=await open(),next=await upgraded.read('soul');
 assert.equal(next.content,DEFAULT_SOUL);assert.equal(next.revision,old.revision+1);assert.equal((await upgraded.readVersion('soul',old.revision)).content,previous);
 assert.equal(snap.documents.soul.content,previous);assert.deepEqual(await upgraded.read('user'),user);
 assert.equal((await (await open()).read('soul')).revision,next.revision);
});
for(const [label,content,source] of [
 ['user owned prior default',previous,{source:'user'}],
 ['externally imported prior default',previous,{source:'external'}],
 ['custom text',previous+'\nMy additions.',{source:'seed'}],
 ['empty user identity','',{source:'user'}],
 ['current user supplied text',DEFAULT_SOUL,{source:'user'}]
])test('preserves existing '+label,async t=>{
 const {open}=await fixture(t);const s=await open(),before=await s.read('soul');
 const owned=await s.update({kind:'soul',content,expectedRevision:before.revision,expectedHash:before.diskHash,provenance:source});
 const after=await (await open()).read('soul');assert.equal(after.content,content);assert.equal(after.revision,owned.revision);
});
test('model identity tool cannot mutate SOUL even with explicit user quote; user editor and next snapshot remain available',async t=>{
 const {open}=await fixture(t);const s=await open(),before=await s.read('soul'),snap=await s.snapshot();
 const handler=createIdentityToolHandler({store:s,trustedUserText:'Change your SOUL now.'});
 const args={action:'update',kind:'soul',content:'not allowed',expectedRevision:before.revision,expectedHash:before.diskHash,sourceQuote:'Change your SOUL now.'};
 await assert.rejects(handler({name:'relay_identity',arguments:args}),{status:403});
 assert.equal((await s.read('soul')).hash,before.hash);
 const read=await handler({name:'relay_identity',arguments:{action:'read',kind:'soul'}});assert.equal(JSON.parse(read.contentItems[0].text).hash,before.hash);
 await s.update({kind:'soul',content:'# User applied next version',expectedRevision:before.revision,expectedHash:before.diskHash,provenance:{source:'user'}});
 assert.equal(snap.documents.soul.content,DEFAULT_SOUL);assert.equal((await s.snapshot()).documents.soul.content,'# User applied next version');
 assert.match(IDENTITY_INSTRUCTIONS,/only the user may apply/i);assert.doesNotMatch(IDENTITY_INSTRUCTIONS,/perform that requested change/);
});
