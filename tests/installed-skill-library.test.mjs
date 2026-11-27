import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {InstalledSkillLibrary} from '../lib/installed-skill-library.mjs';
import {SkillEditStore} from '../lib/skill-edits.mjs';
import {createSkillLibrary} from '../lib/skill-library.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const skill=(slug,extra={})=>({
 id:'library-installed-'+slug,title:'Installed '+slug,
 description:'Trace causal mechanisms and compare evidence for this method.',
 tags:['causal','evidence'],aliases:['latent denominator'],
 source:{kind:'first-party',revision:'fixture-1'},bodyFile:slug+'.md',
 body:'# Installed '+slug+'\n\nA reusable installed procedure.\n',...extra,
});
async function writePack(root,rows){
 await fs.mkdir(root,{recursive:true});
 await fs.writeFile(path.join(root,'index.json'),JSON.stringify({version:1,entries:rows.map(({body,...row})=>row)}));
 for(const row of rows)if(row.body!==null)await fs.writeFile(path.join(root,row.bodyFile),row.body);
}
async function fixture(t,rows,bundled=[]){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-installed-skills-'));
 const source=path.join(root,'source'),packaged=path.join(root,'packaged'),dataDir=path.join(root,'data');
 await writePack(source,rows);await writePack(packaged,bundled);
 const library=createSkillLibrary({root:packaged}),installed=new InstalledSkillLibrary({dataDir});
 const catalog=createSkillsCatalog({dataDir,library}),owners=new SkillEditStore({dataDir});
 t.after(async()=>{await Promise.all([installed.close(),catalog.close(),owners.close()]);await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 return {root,source,packaged,dataDir,library,installed,catalog,owners};
}

test('native installation preserves metadata and survives source removal with one effective ID',async t=>{
 const row=skill('base');
 const f=await fixture(t,[row],[{...row,title:'Older packaged title',description:'Old packaged description',aliases:['older phrase']}]);
 const before=await f.catalog.list();
 const receipt=await f.installed.install({root:f.source,expectedVersion:0});
 assert.equal(receipt.version,1);assert.equal(receipt.installed,1);
 const found=await f.catalog.list({query:'latent denominator'});
 assert.equal(found.entries[0].id,row.id);
 assert.equal(found.entries[0].catalog,'installed');assert.equal(found.entries[0].source,'bundled');
 assert.equal(found.entries[0].title,row.title);assert.equal(found.entries[0].description,row.description);
 assert.notEqual(found.catalogVersion,before.catalogVersion);
 assert.equal((await f.catalog.list()).entries.filter(x=>x.id===row.id).length,1);
 const metadata=(await f.catalog.taskMetadata()).find(x=>x.id===row.id);
 assert.deepEqual(metadata.tags,row.tags);assert.deepEqual(metadata.aliases,row.aliases);
 assert.equal(metadata.ownerCreated,false);assert.match(metadata.revision,/^installed:1:/);
 await fs.rm(f.source,{recursive:true,force:true});
 const read=await f.catalog.detail({id:row.id});assert.equal(read.content,row.body);
 assert.equal(read.provenance.packageRevision,'fixture-1');
 const reopened=new InstalledSkillLibrary({dataDir:f.dataDir});
 try{assert.equal((await reopened.read(row.id)).content,row.body);}finally{await reopened.close();}
});

test('exact owner-copy promotion preserves revisions, edits, deletion and future update behavior',async t=>{
 const rows=['untouched','edited','deleted','revised'].map(x=>skill(x));
 const f=await fixture(t,rows);
 const [untouched,edited,deleted,revised]=rows;
 const originals={
  [untouched.id]:{content:untouched.body,revision:2},
  [edited.id]:{content:'# Owner adjustment\n\nPreserve this edited method.',revision:3},
  [deleted.id]:{content:deleted.body,revision:2,deleted:true},
  [revised.id]:{content:revised.body,revision:5},
 };
 const legacyFile=path.join(f.dataDir,'skill-edits','skills.json');
 await fs.mkdir(path.dirname(legacyFile),{recursive:true});
 const legacyText=JSON.stringify({version:1,entries:originals});await fs.writeFile(legacyFile,legacyText);
 const receipt=await f.installed.install({root:f.source,expectedVersion:0,
  promotions:rows.map(row=>({id:row.id,expectedRevision:2,contentHash:hash(row.body)}))});
 assert.deepEqual(receipt.promoted,[untouched.id]);
 assert.deepEqual(receipt.skipped.map(x=>[x.id,x.reason]),[
  [edited.id,'revision-changed'],[deleted.id,'deleted'],[revised.id,'revision-changed'],
 ]);
 assert.equal(await f.owners.readOne(untouched.id),undefined);
 for(const row of [edited,deleted,revised])assert.deepEqual(await f.owners.readOne(row.id),originals[row.id]);
 assert.equal(await fs.readFile(legacyFile,'utf8'),legacyText);
 const base=await f.catalog.detail({id:untouched.id});
 assert.equal(base.revision,2);assert.equal(base.source,'bundled');assert.equal(base.catalog,'installed');
 assert.equal((await f.catalog.detail({id:edited.id})).content,originals[edited.id].content);
 await assert.rejects(f.catalog.detail({id:deleted.id}),{status:404});
 assert.equal(await f.catalog.has(deleted.id),true);
 assert.equal(await f.catalog.has(deleted.id,{includeDeleted:false}),false);
 const updated={...untouched,body:untouched.body+'\nUpdated native method.\n'};
 await writePack(f.source,[updated,...rows.slice(1)]);
 await f.installed.install({root:f.source,ids:[untouched.id],expectedVersion:1});
 const current=await f.catalog.detail({id:untouched.id});
 assert.equal(current.revision,3);assert.equal(current.content,updated.body);
 await assert.rejects(f.catalog.save({id:untouched.id,value:{expectedRevision:2,content:'# Stale draft'}}),{status:409});
 const owner=await f.catalog.save({id:untouched.id,value:{expectedRevision:3,content:'# Owner method\n\nKeep this actual owner revision.'}});
 assert.equal(owner.revision,4);assert.equal(owner.source,'user');
 await writePack(f.source,[{...updated,body:updated.body+'\nAnother base update.\n'},...rows.slice(1)]);
 await f.installed.install({root:f.source,ids:[untouched.id],expectedVersion:2});
 assert.equal((await f.catalog.detail({id:untouched.id})).content,owner.content);
 assert.deepEqual(await f.owners.readOne(edited.id),originals[edited.id]);
});

test('installation stages all documents and rejects stale versions without partial writes',async t=>{
 const a=skill('first'),b=skill('missing',{body:null});
 const f=await fixture(t,[a,b]);
 await assert.rejects(f.installed.install({root:f.source,expectedVersion:0}),/body is unavailable/);
 assert.equal(await f.installed.getVersion(),0);assert.deepEqual(await f.installed.list(),[]);
 await fs.writeFile(path.join(f.source,b.bodyFile),'# Installed missing\n\nNow complete.');
 const first=await f.installed.install({root:f.source,expectedVersion:0});
 assert.equal(first.changed.length,2);assert.equal(first.version,1);
 await assert.rejects(f.installed.install({root:f.source,expectedVersion:0}),{status:409});
 await assert.rejects(f.installed.install({root:f.source,expectedVersion:1,
  promotions:[{id:a.id,expectedRevision:2,contentHash:'0'.repeat(64)}]}),{status:409});
 assert.equal(await f.installed.getVersion(),1);assert.equal((await f.installed.read(a.id)).content,a.body);
 const again=await f.installed.install({root:f.source,expectedVersion:1});
 assert.equal(again.version,1);assert.deepEqual(again.changed,[]);
});

test('metadata paging never reads bodies and catalog versions track both mutable layers',async t=>{
 const rows=Array.from({length:30},(_,i)=>skill('page-'+String(i).padStart(2,'0')));
 const f=await fixture(t,rows);
 await f.installed.install({root:f.source,expectedVersion:0});
 const owner=await f.catalog.create({value:{content:'# Owner example\n\nAn ordinary purpose.\n\n## Details\nSECRET_BODY_NOT_METADATA\n'}});
 t.mock.method(SkillEditStore.prototype,'read',()=>{throw Error('Full owner corpus read');});
 t.mock.method(SkillEditStore.prototype,'readOne',()=>{throw Error('Owner body read during metadata lookup');});
 t.mock.method(InstalledSkillLibrary.prototype,'read',()=>{throw Error('Installed body read during metadata lookup');});
 const first=await f.catalog.list({limit:7}),second=await f.catalog.list({offset:first.nextOffset,limit:7});
 assert.equal(first.entries.length,7);assert.equal(second.entries.length,7);
 assert.equal(first.catalogVersion,second.catalogVersion);
 assert.equal(new Set([...first.entries,...second.entries].map(row=>row.id)).size,14);
 assert.ok(first.entries.every(row=>!('content'in row)&&!('bodyFile'in row)&&!('aliases'in row)));
 const metadata=await f.catalog.taskMetadata();
 assert.equal(metadata.some(row=>JSON.stringify(row).includes('SECRET_BODY_NOT_METADATA')),false);
 assert.equal((await f.catalog.list({query:'SECRET_BODY_NOT_METADATA'})).entries[0].id,owner.id);
 metadata.find(row=>row.id===rows[0].id).tags.push('poison');
 assert.equal((await f.catalog.taskMetadata()).find(row=>row.id===rows[0].id).tags.includes('poison'),false);
 t.mock.restoreAll();
 await f.catalog.create({value:{content:'# Another owner method\n\nUse for another purpose.'}});
 const ownerChanged=await f.catalog.list({limit:7});assert.notEqual(ownerChanged.catalogVersion,first.catalogVersion);
 rows[0]={...rows[0],description:'A changed installed purpose.',aliases:['new phrase']};
 await writePack(f.source,rows);
 await f.installed.install({root:f.source,ids:[rows[0].id],expectedVersion:1});
 const baseChanged=await f.catalog.list({limit:7});assert.notEqual(baseChanged.catalogVersion,ownerChanged.catalogVersion);
 assert.equal((await f.catalog.list({query:'new phrase'})).entries[0].id,rows[0].id);
});

test('restored installed bases advance draft revisions when their source changes',async t=>{
 const row=skill('restored');
 const f=await fixture(t,[row]);
 await f.installed.install({root:f.source,expectedVersion:0});
 const initial=await f.catalog.detail({id:row.id});
 const deleted=await f.catalog.delete({id:row.id,value:{expectedRevision:initial.revision}});
 const restored=await f.catalog.restore({id:row.id,value:{expectedRevision:deleted.revision}});
 await writePack(f.source,[{...row,body:row.body+'\nChanged after restore.\n'}]);
 await f.installed.install({root:f.source,expectedVersion:await f.installed.getVersion()});
 const current=await f.catalog.detail({id:row.id});
 assert.ok(current.revision>restored.revision,'changing the effective body advances the current draft revision');
 await assert.rejects(f.catalog.save({id:row.id,value:{expectedRevision:restored.revision,content:'# Stale restored draft'}}),{status:409});
 assert.equal(current.content,row.body+'\nChanged after restore.\n');
 assert.equal(await f.owners.readOne(row.id),undefined);
});

test('historical inherited markers fold into installed revisions while deleted markers remain',async t=>{
 const active=skill('inherited',{body:'# Installed inherited\n\nNew installed body.'});
 const hidden=skill('hidden-marker');
 const f=await fixture(t,[active,hidden],[{...active,body:'# Installed inherited\n\nEarlier packaged body.'},hidden]);
 const records={[active.id]:{revision:7,bundled:true},[hidden.id]:{revision:9,deleted:true}};
 const file=path.join(f.dataDir,'skill-edits','skills.json');
 await fs.mkdir(path.dirname(file),{recursive:true});
 await fs.writeFile(file,JSON.stringify({version:1,entries:records}));
 const old=await f.catalog.detail({id:active.id});assert.equal(old.revision,7);
 const page=await f.catalog.list();
 const result=await f.installed.install({root:f.source,expectedVersion:0});
 assert.deepEqual(result.foldedMarkers,[active.id]);
 assert.equal(await f.owners.readOne(active.id),undefined);
 assert.deepEqual(await f.owners.readOne(hidden.id),records[hidden.id]);
 const current=await f.catalog.detail({id:active.id});
 assert.ok(current.revision>old.revision);assert.equal(current.content,active.body);
 assert.notEqual((await f.catalog.list()).catalogVersion,page.catalogVersion);
 await assert.rejects(f.catalog.save({id:active.id,value:{expectedRevision:old.revision,content:'# Stale inherited draft'}}),{status:409});
 await assert.rejects(f.catalog.detail({id:hidden.id}),{status:404});
});
