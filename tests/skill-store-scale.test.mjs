import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {SkillEditStore} from '../lib/skill-edits.mjs';
import {SkillStoreDatabase,promoteSkillEdits,skillStoreVersion,bumpSkillStoreVersion} from '../lib/skill-store.mjs';
import {SkillFolderStore} from '../lib/skill-folders.mjs';
import {skillBodySearchTerms} from '../lib/skill-library.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,entries){
 const dataDir=await mkdtemp(path.join(tmpdir(),'skill-store-scale-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const legacyFile=path.join(dataDir,'skill-edits','skills.json');
 await mkdir(path.dirname(legacyFile));
 const legacy=entries===undefined?undefined:JSON.stringify({version:1,entries});
 if(legacy!==undefined)await writeFile(legacyFile,legacy);
 const store=new SkillEditStore({dataDir,bundledHas:()=>false});
 return {dataDir,legacyFile,legacy,store};
}
const installed=(db,id,content,revision=2)=>db.prepare('INSERT INTO installed_skills(id,metadata_json,content,content_hash,revision) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,content_hash=excluded.content_hash,revision=excluded.revision').run(id,JSON.stringify({id,title:id}),content,hash(content),revision);

test('more than ten thousand records and eight MiB migrate once with exact content, revisions and body-free metadata',async t=>{
 const entries=Object.fromEntries(Array.from({length:10020},(_,i)=>['owner-'+i,{revision:2,content:'# Method '+i+'\n\nDistinct purpose '+i+'.\n\n'+('calculation '.repeat(100))}]));
 entries.special={revision:7,content:'# Exact\r\n\r\nUnicode π and 🧊.\r\n'};
 entries.deleted={revision:9,content:'# Retained deleted body\n',deleted:true};
 const {dataDir,legacyFile,legacy,store}=await fixture(t,entries);
 assert.ok(Buffer.byteLength(legacy)>8*1024*1024);
 const metadata=await store.listMetadata();
 assert.equal(Object.keys(metadata.entries).length,10022);
 assert.ok(Object.values(metadata.entries).every(row=>!Object.hasOwn(row,'content')));
 assert.ok(Buffer.byteLength(JSON.stringify(metadata))<Buffer.byteLength(legacy)/2);
 assert.deepEqual(await store.readOne('special'),entries.special);
 assert.deepEqual(await store.readOne('deleted'),entries.deleted);
 assert.equal(await readFile(legacyFile,'utf8'),legacy,'migration preserves original bytes');
 const created=await store.create({content:'# Beyond former capacity\n\nA new method.\n'});
 assert.equal(created.revision,2);
 assert.equal(Object.keys((await store.listMetadata()).entries).length,10023);
 const fresh=new SkillEditStore({dataDir,bundledHas:()=>false});
 assert.deepEqual(await fresh.readOne('special'),entries.special);
 assert.equal((await fresh.readOne(created.id)).content,created.content);
 assert.equal(await readFile(legacyFile,'utf8'),legacy,'new writes do not rewrite the complete legacy corpus');
});

test('migration is atomic on malformed rows and later legacy writes are visible conflicts',async t=>{
 const original={ok:{revision:3,content:'# Original\n\nKeep exact text.\n'},bad:{revision:0,content:'# Invalid\n'}};
 const {dataDir,legacyFile,legacy,store}=await fixture(t,original);
 await assert.rejects(store.listMetadata());
 assert.equal(await readFile(legacyFile,'utf8'),legacy);
 const inspect=new DatabaseSync(path.join(dataDir,'skill-edits','skills.sqlite'));
 assert.equal(inspect.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='skill_edits'").get().n,0);
 inspect.close();
 const repaired=JSON.stringify({version:1,entries:{ok:original.ok}});
 await writeFile(legacyFile,repaired);
 const fresh=new SkillEditStore({dataDir,bundledHas:()=>false});
 assert.deepEqual(await fresh.readOne('ok'),original.ok);
 await writeFile(legacyFile,JSON.stringify({version:1,entries:{ok:{revision:4,content:'# Old version wrote this\n'}}}));
 await assert.rejects(fresh.readOne('ok'),{code:'SKILL_LEGACY_CHANGED'});
 await assert.rejects(fresh.save('ok',{expectedRevision:3,content:'# New version draft\n'}),{code:'SKILL_LEGACY_CHANGED'});
 await writeFile(legacyFile,repaired);
 assert.deepEqual(await fresh.readOne('ok'),original.ok);
});

test('CAS, transaction rollback and independent instances preserve one winning edit',async t=>{
 const {dataDir,store}=await fixture(t);
 const created=await store.create({content:'# Initial\n\nPurpose.\n'});
 const other=new SkillEditStore({dataDir,bundledHas:()=>false});
 const outcomes=await Promise.allSettled([
  store.save(created.id,{expectedRevision:2,content:'# First writer\n'}),
  other.save(created.id,{expectedRevision:2,content:'# Second writer\n'})
 ]);
 assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
 assert.equal(outcomes.find(row=>row.status==='rejected').reason.status,409);
 assert.equal((await other.readOne(created.id)).revision,3);
 const generation=await store.getVersion();
 await assert.rejects(store.database.transaction(db=>{
  db.prepare("UPDATE skill_edits SET record_json='{}' WHERE id=?").run(created.id);
  bumpSkillStoreVersion(db);
  throw Error('abort this transaction');
 }),/abort this transaction/);
 assert.equal(await store.getVersion(),generation);
 assert.equal((await other.readOne(created.id)).revision,3);
});

test('indexed body search preserves exact normalized words and changes atomically with owner edits',async t=>{
 const {store}=await fixture(t);
 const content='# Index fixture\n\nBrief purpose.\n\n'+('filler '.repeat(2000))+'SECRET_BODY_NOT_METADATA invariant-based studies.';
 const created=await store.create({content});
 const terms=skillBodySearchTerms('SECRET_BODY_NOT_METADATA invariant-based studies');
 const results=await store.searchBodyTerms(terms);
 assert.deepEqual(new Set(results[created.id]),new Set(terms));
 assert.equal((await store.listMetadata()).entries[created.id].description,'Brief purpose.');
 const updated=await store.save(created.id,{expectedRevision:2,content:'# Changed\n\nReplacement purpose.\n'});
 assert.deepEqual(await store.searchBodyTerms(terms),{});
 assert.equal((await store.listMetadata()).entries[created.id].title,'Changed');
 await store.delete(created.id,{expectedRevision:updated.revision});
 assert.deepEqual(await store.searchBodyTerms(skillBodySearchTerms('Replacement')),{[created.id]:['replacement']});
});

test('atomic installation promotes only exact expected owner copies and preserves base CAS continuity',async t=>{
 const same='# Same method\n\nPurpose.\n',different='# Owner changed\n\nKeep this.\n';
 const entries={
  same:{revision:2,content:same},
  changed:{revision:3,content:different},
  deleted:{revision:2,content:same,deleted:true}
 };
 const {dataDir,store}=await fixture(t,entries);
 await store.listMetadata();
 const requests=['same','changed','deleted'].map(id=>({id,expectedRevision:2,contentHash:hash(same)}));
 const before=await store.getVersion();
 await assert.rejects(store.database.transaction(db=>{
  for(const id of ['same','changed','deleted'])installed(db,id,same,2);
  promoteSkillEdits(db,requests);
  throw Error('installer failed');
 }),/installer failed/);
 assert.deepEqual(await store.readOne('same'),entries.same);
 assert.equal(await store.getVersion(),before);
 const result=await store.database.transaction(db=>{
  for(const id of ['same','changed','deleted'])installed(db,id,same,2);
  return promoteSkillEdits(db,requests);
 });
 assert.deepEqual(result.promoted,['same']);
 assert.deepEqual(result.skipped,[{id:'changed',reason:'revision-changed'},{id:'deleted',reason:'deleted'}]);
 assert.equal(await store.readOne('same'),undefined);
 assert.deepEqual(await store.readOne('changed'),entries.changed);
 assert.deepEqual(await store.readOne('deleted'),entries.deleted);
 const editing=new SkillEditStore({dataDir,bundledHas:()=>true,bundledRevision:()=>2});
 await assert.rejects(editing.save('same',{expectedRevision:1,content:'# Stale base\n'}),{status:409});
 const saved=await editing.save('same',{expectedRevision:2,content:'# Valid edit\n'});
 assert.equal(saved.revision,3);
});

test('an installed base update during preflight rejects the stale editor revision',async t=>{
 const {dataDir,store}=await fixture(t);
 await store.database.transaction(db=>installed(db,'base','# Base\n',2));
 let started,release;
 const entering=new Promise(resolve=>{started=resolve;});
 const gate=new Promise(resolve=>{release=resolve;});
 const editing=new SkillEditStore({dataDir,bundledHas:()=>true,bundledRevision:async()=>{started();await gate;return 2;}});
 const pending=editing.save('base',{expectedRevision:2,content:'# Stale owner draft\n'});
 await entering;
 await store.database.transaction(db=>installed(db,'base','# Updated base\n',3));
 release();
 await assert.rejects(pending,{status:409});
 assert.equal(await store.readOne('base'),undefined);
});

test('Runtime folder metadata supports thousands of installed assignments beyond prior size and count limits',async t=>{
 const {dataDir,store}=await fixture(t);
 const ids=Array.from({length:12000},(_,i)=>'installed-'+String(i).padStart(5,'0')+'-'+('a'.repeat(70)));
 await store.database.transaction(db=>{for(const id of ids)installed(db,id,'# Installed\n',1);});
 const folders=Array.from({length:300},(_,i)=>({id:'topic-'+i,name:'Topic '+i,parentId:'runtime:skill'}));
 const state={version:1,revision:4,folders,assignments:Object.fromEntries(ids.map((id,i)=>[id,folders[i%folders.length].id])),removedCategories:[],runtimeAssignments:{}};
 const raw=JSON.stringify(state,null,2);
 assert.ok(Buffer.byteLength(raw)>1024*1024);
 await writeFile(path.join(dataDir,'skills-folders.json'),raw);
 let fallbackCalls=0;
 const organization=new SkillFolderStore({dataDir,skillExists:()=>{fallbackCalls++;return false;}});
 assert.equal((await organization.read()).folders.length,300);
 const moved=await organization.mutate({action:'assign',skillId:ids[11999],folderId:'topic-0',expectedRevision:4});
 assert.equal(Object.keys(moved.assignments).length,12000);
 assert.equal(moved.assignments[ids[11999]],'topic-0');
 const added=await organization.mutate({action:'create',id:'topic-new',name:'New topic',parentId:'runtime:skill',expectedRevision:5});
 assert.equal(added.folders.length,301);
 assert.equal(fallbackCalls,0,'canonical membership uses one ID snapshot, not thousands of catalog calls');
 assert.equal((await new SkillFolderStore({dataDir}).read()).assignments[ids[0]],'topic-0');
});

test('a valid very long heading cannot turn metadata retrieval into a body read',async t=>{
 const {store}=await fixture(t);
 const created=await store.create({content:'# '+('x'.repeat(190000))+'\n'});
 const projected=(await store.listMetadata()).entries[created.id];
 assert.equal(projected.title.length,200);
 assert.ok(JSON.stringify(projected).length<1000);
 assert.equal((await store.readOne(created.id)).content.length,190003);
});
