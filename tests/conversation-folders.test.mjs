import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {ConversationFolders, AUTO_BATCH_LIMIT, AUTO_FOLDER_LIMIT} from '../lib/conversation-folders.mjs';

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
const status=(title,rootId,state='active')=>({title,rootId,state,busy:false});
const runAuto=(store,items,options={})=>store.autoStep({
  rootIds:items.map(item=>item.rootId),resolve:id=>items.find(item=>item.rootId===id),...options
});

test('missing .98 metadata migrates in place without touching legacy archive/state files',async t=>{
  const {dir,store}=await fresh(t);
  assert.equal(store.snapshot().revision,0);
  assert.equal(store.snapshot().autoEnabled,true);
  assert.equal(store.forConversation('r1').folderId,null);
  const legacy=path.join(dir,'conversation-state.json');
  await writeFile(legacy,'{"r1":{"state":"archived","title":"Original"}}');
  const folder=await add(store,'BLACKICE');
  await edit(store,[{type:'assign',rootId:'r1',folderId:folder.id}],['r1']);
  assert.deepEqual(JSON.parse(await readFile(legacy,'utf8')), {r1:{state:'archived',title:'Original'}});
  const reloaded=await new ConversationFolders({dataDir:dir}).init();
  assert.equal(reloaded.forConversation('r1').folderId,folder.id);
  assert.equal(reloaded.forConversation('r1').source,undefined);
  assert.equal(reloaded.forConversation('r1').folderSource,'manual');
});

test('unversioned folders prototype migrates and does not create one folder per chat',async t=>{
  const {dir}=await fresh(t);
  await writeFile(path.join(dir,'conversation-folders-v1.json'),JSON.stringify({folders:[],assignments:{},revision:0,autoEnabled:true}));
  const migrated=await new ConversationFolders({dataDir:dir}).init();
  assert.equal(migrated.status().healthy,true);
  assert.equal(migrated.snapshot().version,1);
  const single=[status('Apollo analysis','a')];
  await runAuto(migrated,single);
  assert.equal(migrated.snapshot().folders.length,0);
});

test('manual assign including Ungrouped stays sticky against automatic classification until reset',async t=>{
  const {store}=await fresh(t);
  const folder=await add(store,'BLACKICE');
  await edit(store,[{type:'assign',rootId:'x',folderId:null}],['x']);
  const items=[status('BLACKICE performance investigation','x')];
  await runAuto(store,items);
  assert.equal(store.forConversation('x').folderId,null);
  assert.equal(store.forConversation('x').folderSource,'manual');
  await edit(store,[{type:'reset_auto',rootId:'x'}],['x']);
  await runAuto(store,items);
  assert.equal(store.forConversation('x').folderId,folder.id);
  assert.equal(store.forConversation('x').folderSource,'automatic');
  assert.match(store.forConversation('x').folderReason,/title/i);
});

test('manual move undo restores actual previous source and membership',async t=>{
  const {store}=await fresh(t);
  const one=await add(store,'BLACKICE');
  const two=await add(store,'Phoenix');
  const items=[status('BLACKICE diagnostics','r1')];
  await runAuto(store,items);
  assert.equal(store.forConversation('r1').folderId,one.id);
  const prior=store.data.assignments.r1;
  await edit(store,[{type:'assign',rootId:'r1',folderId:two.id}],['r1']);
  assert.equal(store.forConversation('r1').folderSource,'manual');
  await edit(store,[{type:'restore_assignment',rootId:'r1',previous:prior}],['r1']);
  assert.equal(store.forConversation('r1').folderSource,'automatic');
  assert.equal(store.forConversation('r1').folderId,one.id);
});

test('delete folder retains conversations in Ungrouped, leaves legacy archived/deleted untouched, suppresses recreation',async t=>{
  const {dir,store}=await fresh(t);
  const folder=await add(store,'Phoenix');
  const legacy=path.join(dir,'conversation-state.json');
  const content='{"a":{"state":"archived"},"b":{"state":"deleted"}}';
  await writeFile(legacy,content);
  await edit(store,[
    {type:'assign',rootId:'a',folderId:folder.id},
    {type:'assign',rootId:'b',folderId:folder.id}
  ],['a','b']);
  await edit(store,[{type:'delete_folder',folderId:folder.id}]);
  assert.equal(store.forConversation('a').folderSource,'manual');
  assert.equal(store.forConversation('b').folderId,null);
  assert.equal(store.snapshot().folders.length,0);
  assert.equal(await readFile(legacy,'utf8'),content);
  const items=['a','b','c','d'].map(rootId=>status('Phoenix research',rootId));
  await runAuto(store,items);
  assert.equal(store.snapshot().folders.length,0);
});

test('repeated subject generates one capped folder, ambiguous mixed-topic stays ungrouped with suggestion',async t=>{
  const {store}=await fresh(t);
  const items=['alpha','beta','gamma','mix'].map((rootId,i)=>
    status(i===3?'BLACKICE and Phoenix architecture':'BLACKICE '+['tooling','debugging','release'][i],rootId));
  await runAuto(store,items);
  assert.equal(store.snapshot().folders.length,1);
  assert.equal(store.snapshot().folders[0].name,'BLACKICE');
  assert.equal(store.snapshot().folders[0].origin,'automatic');
  for(const id of ['alpha','beta','gamma'])assert.equal(store.forConversation(id).folderId,store.snapshot().folders[0].id);
  const mixed=store.forConversation('mix');
  assert.equal(mixed.folderId,null);
  assert.equal(mixed.folderSuggestion,store.snapshot().folders[0].id);
  assert.match(mixed.folderReason,/mixed/i);
});

test('a common umbrella product does not absorb separately repeated named subprojects',async t=>{
  const {store}=await fresh(t);
  const umbrella=await add(store,'BLACKICE');
  const items=['Swarm','Skills'].flatMap(project=>[1,2,3].map(n=>status(
    'BLACKICE '+project+' detailed work '+n,project.toLowerCase()+n
  )));
  await runAuto(store,items);
  const names=store.snapshot().folders.map(folder=>folder.name);
  assert.ok(names.includes('BLACKICE'));
  assert.ok(names.includes('Swarm'));
  assert.ok(names.includes('Skills'));
  const swarmId=store.snapshot().folders.find(folder=>folder.name==='Swarm').id;
  const skillsId=store.snapshot().folders.find(folder=>folder.name==='Skills').id;
  assert.notEqual(swarmId,umbrella.id);
  assert.notEqual(skillsId,umbrella.id);
  for(const item of items)assert.equal(store.forConversation(item.rootId).folderId,
    item.rootId.startsWith('swarm')?swarmId:skillsId);
  const mixed=status('BLACKICE Swarm and Skills integration','mixed');
  await runAuto(store,[mixed]);
  assert.equal(store.forConversation('mixed').folderId,null);
  assert.match(store.forConversation('mixed').folderReason,/Mixed topics/);
});

test('title change alone does not oscillate automatically assigned folders; reset is meaningful explicit trigger',async t=>{
  const {store}=await fresh(t);
  const blackice=await add(store,'BLACKICE');
  const phoenix=await add(store,'Phoenix');
  const one=[status('BLACKICE internal refactor','root')];
  await runAuto(store,one);
  assert.equal(store.forConversation('root').folderId,blackice.id);
  one[0].title='Phoenix roadmap';
  await runAuto(store,one);
  assert.equal(store.forConversation('root').folderId,blackice.id);
  await edit(store,[{type:'reset_auto',rootId:'root'}],['root']);
  await runAuto(store,one);
  assert.equal(store.forConversation('root').folderId,phoenix.id);
});

test('no auto when disabled, busy, excluded current, archived auto can be organized and trash excluded',async t=>{
  const {store}=await fresh(t);
  const folder=await add(store,'BLACKICE');
  const items=[status('BLACKICE one','root'),status('BLACKICE two','busy'),status('BLACKICE three','open'),
    status('BLACKICE archive','archived','archived'),status('BLACKICE trash','trash','deleted')];
  items[1].busy=true;
  await edit(store,[{type:'toggle_auto',enabled:false}]);
  await runAuto(store,items);
  assert.equal(Object.keys(store.data.scans).length,0);
  await edit(store,[{type:'toggle_auto',enabled:true}]);
  await runAuto(store,items,{excludeRootId:'open'});
  assert.equal(store.forConversation('root').folderId,folder.id);
  assert.equal(store.forConversation('archived').folderId,folder.id);
  for(const id of ['busy','open','trash'])assert.equal(store.data.scans[id],undefined);
});

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

test('budget maximum 40, automatic folders maximum 8 and active exclusion',async t=>{
  const {store}=await fresh(t);
  await assert.rejects(runAuto(store,Array.from({length:41},(_,i)=>status('BLACKICE '+i,'a'+i))),
    error=>error.status===400&&error.code==='FOLDER_AUTO_BATCH');
  let all=[];
  for(const label of ['BLACKICE','Phoenix','Apollo','Mercury','Neptune','Jupiter','Saturn','Venus','Mars']) {
    for(let n=0;n<3;n++)all.push(status(label+' detailed '+n,'r'+all.length));
  }
  for(let i=0;i<all.length;i+=AUTO_BATCH_LIMIT)await runAuto(store,all.slice(i,i+AUTO_BATCH_LIMIT));
  assert.ok(store.snapshot().folders.filter(f=>f.origin==='automatic').length<=AUTO_FOLDER_LIMIT);
});

test('synthetic 2,400 titles, bounded 40-item scans, scaling time and serialized byte footprint',async t=>{
  const {store}=await fresh(t);
  const items=Array.from({length:2400},(_,i)=>status('BLACKICE synthetic note '+i,'s'+i));
  const started=performance.now();
  let maxBatchMs=0;
  for(let i=0;i<items.length;i+=AUTO_BATCH_LIMIT) {
    const now=performance.now();
    await runAuto(store,items.slice(i,i+AUTO_BATCH_LIMIT));
    maxBatchMs=Math.max(maxBatchMs,performance.now()-now);
  }
  const elapsedMs=Math.round(performance.now()-started);
  const bytes=(await readFile(store.file)).byteLength;
  assert.equal(Object.keys(store.data.scans).length,2400);
  assert.equal(store.snapshot().folders.length,1);
  assert.ok(bytes<8*1024*1024);
  console.log(JSON.stringify({case:'synthetic-title-only',chats:2400,batch:AUTO_BATCH_LIMIT,
    elapsedMs,maxBatchMs:Math.ceil(maxBatchMs),storedBytes:bytes,
    modelCalls:0,transcriptReads:0,measuredCategorizationAccuracy:null}));
});
