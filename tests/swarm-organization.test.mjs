import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {SwarmBoardStore} from '../lib/swarm-board.mjs';
import {swarmWriteInputSchema,SWARM_ACTION_NAMES} from '../lib/swarm-action-contract.mjs';
import {validDirectArguments} from '../lib/direct-execution-api.mjs';
import {createNativeSwarmTools,nativeSwarmActorId} from '../lib/swarm-native-tools.mjs';
const human={kind:'human',id:'local-session',label:'Fixture user'};
async function fixture(t){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'swarm-folders-'));
 const store=await new SwarmBoardStore({dataDir}).init();let n=0;
 t.after(async()=>{await store.close();await rm(dataDir,{recursive:true,force:true});});
 const apply=(action,value,more={})=>store.apply({mutationId:'m'+(++n),action,value,...more},human);
 const org=(action,value,more={})=>apply(action,value,{expectedOrganizationRevision:store.snapshot().organization.revision,...more});
 const create=async id=>{await apply('create_project',{id,name:id,objective:'Independent workflow'});await apply('propose_item',{id:'task',title:'Task',scope:'One outcome',requirements:'Observed evidence'},{projectId:id,expectedProjectRevision:store.snapshot(id).revision});};
 return {store,dataDir,apply,org,create};
}
test('folders nest independent projects and individual tasks; filing preserves every work and proof field',async t=>{
 const f=await fixture(t);await f.create('one');await f.create('two');
 await f.apply('record_source',{id:'source',text:'Retained failed observation'},{projectId:'one',expectedProjectRevision:f.store.snapshot('one').revision});
 await f.apply('record_evidence',{id:'failed',claim:'Result',epistemic:'observed',authority:'integration',outcome:'fail',sourceId:'source',sourceRevision:1,requirementRevision:1,note:'Keep the failure'},{projectId:'one',itemId:'task'});
 const before=structuredClone(f.store.snapshot().projects);
 await f.org('create_folder',{id:'campaign',name:'Campaign'});await f.org('create_folder',{id:'research',name:'Research',parentId:'campaign'});
 await f.org('file_project',{folderId:'campaign'},{projectId:'one'});await f.org('file_project',{folderId:'campaign'},{projectId:'two'});
 await f.org('file_item',{folderId:'research'},{projectId:'two',itemId:'task'});
 assert.deepEqual(f.store.snapshot().projects,before);
 assert.equal(f.store.snapshot().organization.itemFolders['two/task'],'research');
 await f.org('edit_folder',{id:'research',name:'Evidence'});
 await f.org('remove_folder',{id:'campaign'});
 const org=f.store.snapshot().organization;
 assert.equal(org.folders[0].parentId,null);assert.equal(org.projectFolders.one,null);
 assert.equal(org.itemFolders['two/task'],'research');assert.deepEqual(f.store.snapshot().projects,before);
 const restarted=await new SwarmBoardStore({dataDir:f.dataDir}).init();
 assert.deepEqual(restarted.snapshot().organization,org);await restarted.close();
});
test('legacy ledger is untouched on read; organization additions preserve stored work and old events',async t=>{
 const f=await fixture(t);await f.create('old');
 const file=path.join(f.dataDir,'swarm-board.json'),before=await readFile(file,'utf8');
 const restarted=await new SwarmBoardStore({dataDir:f.dataDir}).init();
 assert.deepEqual(restarted.snapshot().organization,{revision:0,folders:[],projectFolders:{},itemFolders:{}});
 assert.equal(await readFile(file,'utf8'),before);await restarted.close();
 const previous=JSON.parse(before);await f.org('create_folder',{id:'folder',name:'Folder'});
 const after=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(after.events.slice(0,previous.events.length),previous.events);
 assert.deepEqual(after.projects,previous.projects);
});
test('organization retries deduplicate; stale revisions, cycles and malformed input are atomic',async t=>{
 const f=await fixture(t);const req={mutationId:'stable',action:'create_folder',expectedOrganizationRevision:0,value:{id:'a',name:'A'}};
 const saved=await f.store.apply(req,human);assert.equal(saved.duplicate,false);
 assert.equal((await f.store.apply(req,human)).duplicate,true);
 await assert.rejects(f.store.apply({...req,value:{id:'a',name:'other'}},human),{code:'SWARM_MUTATION_CONFLICT'});
 await f.org('create_folder',{id:'b',name:'B',parentId:'a'});const before=f.store.snapshot();
 for(const [action,value,more] of [['edit_folder',{id:'a',parentId:'b'},{}],['create_folder',[],{}],['file_item',{folderId:'a'},{projectId:'absent',itemId:'x'}],['file_project',{folderId:undefined},{projectId:'absent'}],['edit_folder',{id:'a',extra:true},{}]]){
   await assert.rejects(f.org(action,value,more));assert.deepEqual(f.store.snapshot(),before);
 }
 await assert.rejects(f.store.apply({mutationId:'stale',action:'edit_folder',expectedOrganizationRevision:0,value:{id:'a',name:'new'}},human),{code:'SWARM_REVISION_CONFLICT',currentRevision:2});
});
test('save failure and cancellation retain memory and disk state',async t=>{
 const f=await fixture(t);await f.org('create_folder',{id:'a',name:'A'});
 const before=f.store.snapshot(),raw=await readFile(f.store.file,'utf8'),save=f.store.save;
 f.store.save=async()=>{throw Error('synthetic write failure');};
 await assert.rejects(f.org('edit_folder',{id:'a',name:'Changed'}),/synthetic write failure/);f.store.save=save;
 assert.deepEqual(f.store.snapshot(),before);assert.equal(await readFile(f.store.file,'utf8'),raw);
 await assert.rejects(f.store.apply({mutationId:'aborted',action:'remove_folder',expectedOrganizationRevision:1,value:{id:'a'}},human,{signal:AbortSignal.abort()}),{code:'SWARM_NATIVE_CANCELLED'});
 assert.deepEqual(f.store.snapshot(),before);
});
test('prototype-named valid project IDs survive durable filing without changing object prototypes',async t=>{
 const f=await fixture(t);await f.create('__proto__');await f.org('create_folder',{id:'constructor',name:'Prototype-safe'});
 await f.org('file_project',{folderId:'constructor'},{projectId:'__proto__'});
 const org=f.store.snapshot().organization;assert.equal(Object.hasOwn(org.projectFolders,'__proto__'),true);assert.equal(org.projectFolders.__proto__,'constructor');
 assert.equal(Object.getPrototypeOf(org.projectFolders),Object.prototype);
 const restarted=await new SwarmBoardStore({dataDir:f.dataDir}).init();assert.equal(restarted.snapshot().organization.projectFolders.__proto__,'constructor');await restarted.close();
});
test('every organization action is discoverable with exact nonnegative organization revision',()=>{
 const values={create_folder:{id:'a',name:'A'},edit_folder:{id:'a',parentId:null},remove_folder:{id:'a'},file_project:{folderId:null},file_item:{folderId:'a'}};
 for(const [action,value] of Object.entries(values)){
  assert.ok(SWARM_ACTION_NAMES.includes(action));
  const args={requestId:'transport',mutationId:'stable',action,expectedOrganizationRevision:0,value,...(action.startsWith('file_')?{projectId:'p'}:{}),...(action==='file_item'?{itemId:'i'}:{})};
  assert.equal(validDirectArguments(args,swarmWriteInputSchema),true,action);
  assert.equal(validDirectArguments({...args,expectedOrganizationRevision:-1},swarmWriteInputSchema),false);
 }
});
test('native coordinator organization is scoped; delegated worker cannot manipulate unrelated folders',async t=>{
 const f=await fixture(t),provider=createNativeSwarmTools({board:f.store});
 const a=await provider({taskId:'a',runId:'r',nodeId:'agent'}),b=await provider({taskId:'b',runId:'s',nodeId:'agent'});
 const call=(p,action,value,more={})=>p.handle({name:'relay_swarm_write',arguments:{requestId:'r'+action,mutationId:'n'+action,action,value,...more}});
 await call(a,'create_folder',{id:'private_a',name:'A'},{expectedOrganizationRevision:0});
 const read=await b.handle({name:'relay_swarm_read',arguments:{requestId:'read'}});
 assert.deepEqual(JSON.parse(read.contentItems[0].text).organization.folders,[]);
 await assert.rejects(call(b,'edit_folder',{id:'private_a',name:'B'},{expectedOrganizationRevision:1}),{code:'SWARM_NATIVE_SCOPE'});
 const worker=await provider({taskId:'a',runId:'delegate',nodeId:'agent',isWorker:true});
 await assert.rejects(call(worker,'create_folder',{id:'no',name:'No'},{expectedOrganizationRevision:1}),{code:'SWARM_NATIVE_SCOPE'});
});

test('same-revision concurrent folder saves admit once and retain the loser draft intent externally',async t=>{
 const f=await fixture(t);
 const requests=['a','b'].map(id=>f.store.apply({mutationId:'concurrent_'+id,action:'create_folder',expectedOrganizationRevision:0,value:{id,name:id}},human));
 const outcomes=await Promise.allSettled(requests);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='SWARM_REVISION_CONFLICT').length,1);
 assert.equal(f.store.snapshot().organization.folders.length,1);
});
test('shared local/direct folder editing adds no approval gate; foreign task ownership is unchanged',async t=>{
 const f=await fixture(t);await f.create('human_project');await f.org('create_folder',{id:'shared',name:'Shared'});
 const connector={kind:'connector',id:'grant',label:'Shared grant'};
 await f.store.apply({mutationId:'rename',action:'edit_folder',expectedOrganizationRevision:1,value:{id:'shared',name:'Renamed'}},connector);
 assert.equal(f.store.snapshot().organization.folders[0].name,'Renamed');
 await assert.rejects(f.store.apply({mutationId:'file',action:'file_project',expectedOrganizationRevision:2,projectId:'human_project',value:{folderId:'shared'}},connector),{code:'SWARM_COORDINATOR_REQUIRED'});
});

test('create project and task filing is one atomic save, with null override and invalid target rollback',async t=>{
 const f=await fixture(t);await f.org('create_folder',{id:'folder',name:'Folder'});
 const p=await f.apply('create_project',{id:'filed',name:'Filed',objective:'Atomic workflow',folderId:'folder'});
 assert.equal(p.project.revision,1);assert.equal(f.store.snapshot().organization.projectFolders.filed,'folder');
 assert.equal(f.store.snapshot().organization.revision,2);
 await f.apply('propose_item',{id:'root_task',title:'Explicit root',scope:'Task',requirements:'Evidence',folderId:null},{projectId:'filed',expectedProjectRevision:1});
 assert.equal(f.store.snapshot().organization.itemFolders['filed/root_task'],null);
 assert.equal(f.store.snapshot().organization.revision,3);
 await f.apply('propose_item',{id:'inherited',title:'Inherited',scope:'Task',requirements:'Evidence'},{projectId:'filed',expectedProjectRevision:2});
 assert.equal(Object.hasOwn(f.store.snapshot().organization.itemFolders,'filed/inherited'),false);
 assert.equal(f.store.snapshot().organization.revision,3);
 const before=f.store.snapshot(),raw=await readFile(f.store.file,'utf8');
 await assert.rejects(f.apply('create_project',{id:'missing',name:'Missing',objective:'No effect',folderId:'absent'}),{code:'SWARM_NOT_FOUND'});
 await assert.rejects(f.apply('propose_item',{id:'missing',title:'Missing',scope:'No effect',requirements:'Evidence',folderId:'absent'},{projectId:'filed',expectedProjectRevision:3}),{code:'SWARM_NOT_FOUND'});
 assert.deepEqual(f.store.snapshot(),before);assert.equal(await readFile(f.store.file,'utf8'),raw);
 for(const [action,value,more] of [['create_project',{id:'p',name:'P',objective:'O',folderId:null},{}],['propose_item',{id:'i',title:'I',scope:'S',requirements:'R',folderId:'folder'},{projectId:'p',expectedProjectRevision:1}]]){
   assert.equal(validDirectArguments({requestId:'r',mutationId:'m',action,value,...more},swarmWriteInputSchema),true);
 }
});
test('native create-and-file and filing cannot discover an unrelated folder by guessing its ID',async t=>{
 const f=await fixture(t);await f.org('create_folder',{id:'foreign',name:'Foreign'});
 const provider=await createNativeSwarmTools({board:f.store})({taskId:'coordinator',runId:'run',nodeId:'agent'});
 await assert.rejects(provider.handle({name:'relay_swarm_write',arguments:{requestId:'r',mutationId:'m',action:'create_project',value:{id:'p',name:'P',objective:'O',folderId:'foreign'}}}),{code:'SWARM_NATIVE_SCOPE'});
 const res=await provider.handle({name:'relay_swarm_write',arguments:{requestId:'r2',mutationId:'m2',action:'create_project',value:{id:'p',name:'P',objective:'O',folderId:null}}});
 assert.equal(JSON.parse(res.contentItems[0].text).project.id,'p');
});
