import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ConversationFolders} from '../lib/conversation-folders.mjs';

const fresh=async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'blackice-conversation-folders-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return {dir,store:await new ConversationFolders({dataDir:dir}).init()};
};
const edit=(store,operations,ids=[])=>store.edit({
  expectedRevision:store.snapshot().revision,operations
},{exists:id=>ids.includes(id)});
const add=async(store,name)=> {
  const old=new Set(store.snapshot().folders.map(folder=>folder.id));
  await edit(store,[{type:'create_folder',name}]);
  return store.snapshot().folders.find(folder=>!old.has(folder.id));
};
test('concurrent revisions and locks reject stale or ambiguous edits without replay',async t=>{
  const {dir,store}=await fresh(t);
  const another=await new ConversationFolders({dataDir:dir}).init();
  await add(store,'One');
  await assert.rejects(another.edit({expectedRevision:0,operations:[{type:'create_folder',name:'Two'}]}),
    error=>error.status===409&&error.code==='FOLDER_REVISION'&&error.currentRevision===1);
  assert.deepEqual((await new ConversationFolders({dataDir:dir}).init()).snapshot().folders.map(f=>f.name),['One']);
  await mkdir(store.lock);
  await assert.rejects(edit(store,[{type:'create_folder',name:'Three'}]),
    error=>error.status===423&&error.code==='FOLDER_LOCKED');
  await rm(store.lock,{recursive:true,force:true});
});

test('backup recovery, corrupted unsupported version fail closed; archive bytes untouched',async t=>{
  const {dir,store}=await fresh(t);
  const legacy=path.join(dir,'conversation-state.json'),text='{"r":{"state":"active"}}';
  await writeFile(legacy,text);
  await add(store,'One');await add(store,'Two'); // backup now contains One
  await writeFile(store.file,'broken JSON');
  const recovered=await new ConversationFolders({dataDir:dir}).init();
  assert.equal(recovered.status().healthy,true);
  assert.equal(recovered.status().recovered,true);
  assert.deepEqual(recovered.snapshot().folders.map(f=>f.name),['One']);
  await writeFile(store.file,JSON.stringify({version:999}));
  await writeFile(store.file+'.bak','broken');
  const failed=await new ConversationFolders({dataDir:dir}).init();
  assert.equal(failed.status().healthy,false);
  await assert.rejects(failed.edit({expectedRevision:0,operations:[{type:'create_folder',name:'No'}]}),
    error=>error.status===503);
  assert.equal(await readFile(legacy,'utf8'),text);
});

test('distinct profile data directories cannot leak catalog or manual assignments',async t=>{
  const {dir,store:a}=await fresh(t);
  const bDir=await mkdtemp(path.join(os.tmpdir(),'blackice-other-profile-'));
  t.after(()=>rm(bDir,{recursive:true,force:true}));
  const b=await new ConversationFolders({dataDir:bDir}).init();
  const folder=await add(a,'Personal');
  await edit(a,[{type:'assign',rootId:'same-root',folderId:folder.id}],['same-root']);
  assert.equal(b.snapshot().folders.length,0);
  assert.equal(b.forConversation('same-root').folderId,null);
  const other=await add(b,'Different');
  assert.notEqual(other.id,folder.id);
  assert.equal(a.snapshot().folders[0].name,'Personal');
});


test('manual hierarchy moves whole branches, rejects cycles, reloads and preserves assignments',async t=>{
 const {dir,store}=await fresh(t);let parent=null;const ids=[];
 for(let i=0;i<20;i++){await edit(store,[{type:'create_folder',name:'Level '+i,parentId:parent}]);parent=store.snapshot().folders.at(-1).id;ids.push(parent);}
 await edit(store,[{type:'assign',rootId:'a',folderId:parent}],['a']);const other=await add(store,'Other');
 await edit(store,[{type:'move_folder',folderId:ids[0],parentId:other.id}]);assert.equal(store.forConversation('a').folderId,parent);
 const before=await readFile(store.file,'utf8');await assert.rejects(edit(store,[{type:'move_folder',folderId:other.id,parentId:parent}]),e=>e.code==='FOLDER_PARENT');assert.equal(await readFile(store.file,'utf8'),before);
 await assert.rejects(edit(store,[{type:'create_folder',name:'Missing',parentId:'unknown'}]),e=>e.code==='FOLDER_PARENT');
 const loaded=await new ConversationFolders({dataDir:dir}).init();assert.equal(loaded.snapshot().folders.find(f=>f.id===ids[0]).parentId,other.id);assert.equal(loaded.forConversation('a').folderId,parent);
 await assert.rejects(edit(loaded,[{type:'delete_folder',folderId:ids[0]}]),e=>e.code==='FOLDER_NOT_EMPTY');await edit(loaded,[{type:'move_folder',folderId:ids[1],parentId:other.id}]);await edit(loaded,[{type:'delete_folder',folderId:ids[0]}]);assert.equal(loaded.forConversation('a').folderId,parent);
});
test('existing saved folders and provenance are read unchanged but no automation exists',async t=>{
 const {dir,store}=await fresh(t);const folder=await add(store,'Saved');await edit(store,[{type:'assign',rootId:'a',folderId:folder.id}],['a']);const saved=JSON.parse(await readFile(store.file,'utf8'));saved.autoEnabled=true;saved.scans={a:{title:'Old'}};saved.folders[0].origin='automatic';saved.assignments.a.source='automatic';const bytes=JSON.stringify(saved);await writeFile(store.file,bytes);
 const loaded=await new ConversationFolders({dataDir:dir}).init();assert.equal(await readFile(store.file,'utf8'),bytes);assert.equal(loaded.forConversation('a').folderId,folder.id);assert.equal(loaded.autoStep,undefined);assert.equal(loaded.snapshot().autoEnabled,undefined);
 for(const type of ['toggle_auto','reset_auto'])await assert.rejects(edit(loaded,[{type,rootId:'a',enabled:true}],['a']),e=>e.code==='FOLDER_EDIT');assert.equal(await readFile(store.file,'utf8'),bytes);
});
test('same folder names may exist under different parents, but sibling collisions reject atomically',async t=>{const {store}=await fresh(t);const a=await add(store,'A'),b=await add(store,'B');await edit(store,[{type:'create_folder',name:'Child',parentId:a.id}]);const child=store.snapshot().folders.at(-1);await edit(store,[{type:'create_folder',name:'Child',parentId:b.id}]);await assert.rejects(edit(store,[{type:'move_folder',folderId:child.id,parentId:b.id}]));assert.equal(store.snapshot().folders.find(f=>f.id===child.id).parentId,a.id);});
