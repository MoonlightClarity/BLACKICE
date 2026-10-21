import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rename,mkdir,rmdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CapabilityStore} from '../lib/capabilities.mjs';

const copy=value=>structuredClone(value);
const verdict=criterion=>({passed:true,summary:'Read the saved file and checked its exact contents.',criteria:[{criterion,passed:true,evidence:'The saved proof.txt contains exactly VERIFIED followed by one newline.'}]});
const project=()=>({id:'source-project',revision:7,status:'completed',name:'Verified export method',objective:'Produce an export and independently inspect its output.',cwd:path.resolve('capability-fixture'),model:'implement-model',verifierModel:'verify-model',maxRepairs:2,tasks:[{id:'write',title:'Write the export',instructions:'Write proof.txt and verify its contents.',acceptanceCriteria:['proof.txt has the requested contents.'],dependsOn:[],model:'task-model',verifierModel:'task-verifier',maxRepairs:1,status:'completed',round:1,attempts:[{implementation:{status:'completed',runId:'old-implementation'},verification:{status:'completed',runId:'old-verification',verdict:{passed:false}}},{implementation:{status:'completed',runId:'implementation-run',requestId:'implementation-request'},verification:{status:'completed',runId:'verification-run',requestId:'verification-request',verdict:verdict('proof.txt has the requested contents.'),provenance:{kind:'agent-verifier',runId:'verification-run',requestId:'verification-request',verifiedAt:'2026-10-17T12:00:00.000Z',limitation:'Agent-reported verification of the saved criteria.'}}}]}]});

async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-capabilities-test-')),source=project(),calls=[];
  const projects={get(id){if(id!==source.id)throw Object.assign(new Error('Project not found.'),{status:404});return copy(source);},async create(value){calls.push(copy(value));return{...copy(value),id:`new-project-${calls.length}`,revision:1,status:'draft',tasks:value.tasks.map(task=>({...copy(task),status:'pending',attempts:[]}))};}};
  const stores=[],open=async()=>{const store=await new CapabilityStore({dataDir:directory,projects}).init();stores.push(store);return store;},store=await open();
  t.after(async()=>{for(const value of stores)await value.close();assert.match(path.basename(directory),/^blackice-capabilities-test-/);await rm(directory,{recursive:true,force:true});});
  return{directory,source,projects,calls,store,open,file:path.join(directory,'capabilities.json')};
}

test('capabilities save only completed projects whose final task attempts passed acceptance review',async t=>{
  const {source,store,directory}=await fixture(t),valid=project();
  const invalid=[{...valid,status:'running'},{...valid,status:'draft'},{...valid,tasks:[]},{...valid,tasks:[{...valid.tasks[0],status:'blocked'}]},{...valid,tasks:[{...valid.tasks[0],attempts:[]}]},{...valid,tasks:[{...valid.tasks[0],attempts:[{implementation:{status:'completed',runId:'implementation-run'},verification:{status:'completed',runId:'verification-run',verdict:{passed:false}}}]}]}];
  for(const candidate of invalid){Object.assign(source,copy(candidate));await assert.rejects(store.save({projectId:source.id}),{status:409});}
  assert.equal(store.status().count,0);assert.deepEqual(await readdir(directory),[]);Object.assign(source,valid);assert.ok((await store.save({projectId:source.id})).id);
});

test('capabilities retain actual final implementation and verification receipts without promoting historical success into future state',async t=>{
  const {source,store}=await fixture(t),saved=await store.save({projectId:source.id,name:'Reusable export',description:'A method with specific recorded evidence.'});
  assert.equal(saved.sourceProjectId,source.id);assert.equal(saved.sourceRevision,7);assert.equal(saved.verification,'agent-reviewed');
  assert.equal(saved.evidence.length,1);assert.equal(saved.evidence[0].implementationRunId,'implementation-run');assert.equal(saved.evidence[0].verificationRunId,'verification-run');assert.deepEqual(saved.evidence[0].verdict,source.tasks[0].attempts.at(-1).verification.verdict);
  assert.deepEqual(saved.definition.tasks[0].acceptanceCriteria,source.tasks[0].acceptanceCriteria);assert.deepEqual(saved.definition.tasks[0].dependsOn,[]);assert.equal(saved.definition.tasks[0].model,'task-model');assert.equal(saved.definition.tasks[0].verifierModel,'task-verifier');assert.equal(saved.definition.tasks[0].maxRepairs,1);
  for(const field of ['status','attempts','verification','round','cycle'])assert.equal(Object.hasOwn(saved.definition.tasks[0],field),false,field);
  assert.equal(Object.hasOwn(saved.definition,'id'),false);assert.equal(Object.hasOwn(saved.definition,'revision'),false);
  saved.evidence[0].verdict.criteria[0].evidence='Mutated caller result';saved.definition.tasks[0].instructions='Mutated caller result';const listed=store.list();listed[0].name='Mutated list';assert.equal(store.get(saved.id).name,'Reusable export');assert.match(store.get(saved.id).evidence[0].verdict.criteria[0].evidence,/saved proof.txt/);assert.equal(store.get(saved.id).definition.tasks[0].instructions,source.tasks[0].instructions);
});

test('capability evidence rejects missing or non-independent run receipts and incomplete criterion verdicts',async t=>{
  const {source,store}=await fixture(t),valid=project();
  const mutate=[attempt=>{delete attempt.implementation;},attempt=>{delete attempt.implementation.runId;},attempt=>{attempt.verification.runId=attempt.implementation.runId;},attempt=>{attempt.verification.status='running';},attempt=>{attempt.verification.verdict.criteria=[];},attempt=>{attempt.verification.verdict.criteria[0].passed=false;}];
  for(const change of mutate){Object.assign(source,copy(valid));change(source.tasks[0].attempts.at(-1));await assert.rejects(store.save({projectId:source.id}),{status:409});assert.equal(store.status().count,0);}
});

test('repeated and simultaneous saves deduplicate one exact source revision while a later reviewed revision is distinct',async t=>{
  const {source,store}=await fixture(t),saved=await Promise.all([store.save({projectId:source.id}),store.save({projectId:source.id,name:'Second label'}),store.save({projectId:source.id})]);
  assert.equal(new Set(saved.map(value=>value.id)).size,1);assert.equal(store.status().count,1);assert.equal(saved[1].name,source.name);
  source.revision++;const next=await store.save({projectId:source.id});assert.notEqual(next.id,saved[0].id);assert.equal(next.sourceRevision,8);assert.equal(store.status().count,2);
});

test('using a capability creates a fresh unverified project draft without invoking execution or copying old receipts',async t=>{
  const {source,store,calls}=await fixture(t),saved=await store.save({projectId:source.id}),cwd=path.resolve('new-capability-workspace');
  const reused=await store.use(saved.id,{name:'New export project',cwd,objective:'Produce a new export for a different dataset.'});assert.equal(reused.status,'draft');assert.notEqual(reused.id,source.id);assert.equal(calls.length,1);assert.equal(calls[0].cwd,cwd);assert.equal(calls[0].name,'New export project');assert.equal(calls[0].objective,'Produce a new export for a different dataset.');assert.ok(reused.tasks.every(task=>task.status==='pending'&&task.attempts.length===0));
  for(const field of ['sourceProjectId','sourceRevision','evidence','verification','status'])assert.equal(Object.hasOwn(calls[0],field),false,field);
  const second=await store.use(saved.id);assert.notEqual(second.id,reused.id);assert.equal(second.status,'draft');assert.equal(second.name,saved.name);assert.equal(store.status().count,1);assert.equal(calls.length,2);
});

test('multi-task capability reuse preserves task dependencies, independent criteria and per-task execution choices',async t=>{
  const {source,store,calls}=await fixture(t),second=copy(source.tasks[0]);second.id='inspect';second.title='Inspect the export';second.instructions='Read proof.txt without changing it.';second.acceptanceCriteria=['The independent inspection confirms the saved file.'];second.dependsOn=['write'];second.model='inspect-model';second.verifierModel='inspect-verifier';second.maxRepairs=0;second.attempts=[{implementation:{status:'completed',runId:'inspect-implementation'},verification:{status:'completed',runId:'inspect-verification',verdict:verdict(second.acceptanceCriteria[0])}}];source.tasks.push(second);
  const saved=await store.save({projectId:source.id});await store.use(saved.id);assert.equal(calls[0].tasks.length,2);assert.deepEqual(calls[0].tasks[1].dependsOn,['write']);assert.deepEqual(calls[0].tasks[1].acceptanceCriteria,second.acceptanceCriteria);assert.equal(calls[0].tasks[1].model,'inspect-model');assert.equal(calls[0].tasks[1].verifierModel,'inspect-verifier');assert.equal(calls[0].tasks[1].maxRepairs,0);assert.deepEqual(saved.evidence.map(value=>value.verificationRunId),['verification-run','inspect-verification']);
});

test('one old run receipt cannot certify multiple capability tasks even when their acceptance text matches',async t=>{
  const {source,store,directory,open,file}=await fixture(t),second=copy(source.tasks[0]);second.id='second-export';second.title='Produce a second export';second.dependsOn=['write'];second.attempts=[{implementation:{status:'completed',runId:'second-implementation'},verification:{status:'completed',runId:'verification-run',verdict:verdict(second.acceptanceCriteria[0])}}];source.tasks.push(second);
  await assert.rejects(store.save({projectId:source.id}),error=>error.status===409&&/own implementation and separate review receipts/.test(error.message));assert.equal(store.status().count,0);assert.deepEqual(await readdir(directory),[]);
  second.attempts[0].verification.runId='second-verification';source.tasks[1]=second;const saved=await store.save({projectId:source.id});await store.close();
  const malformed=copy(saved);malformed.evidence[1].implementationRunId=malformed.evidence[0].verificationRunId;const original=JSON.stringify({version:1,items:[malformed]});await writeFile(file,original);const broken=await open();assert.equal(broken.status().healthy,false);assert.match(broken.status().error,/own implementation and separate review receipts/);await assert.rejects(broken.use(saved.id),{status:503});assert.equal(await readFile(file,'utf8'),original,'invalid library evidence is preserved for inspection');
});

test('invalid capability requests and downstream project creation failures leave the library unchanged',async t=>{
  const {source,store,projects,calls}=await fixture(t);await assert.rejects(store.save({projectId:'missing'}),{status:404});await assert.rejects(store.save({projectId:source.id,name:'x'.repeat(161)}),{status:400});await assert.rejects(store.save({projectId:source.id,description:'x'.repeat(2001)}),{status:400});assert.equal(store.status().count,0);
  const saved=await store.save({projectId:source.id});await assert.rejects(store.use('missing'),{status:404});projects.create=async()=>{throw Object.assign(new Error('The selected working folder is missing.'),{status:400});};await assert.rejects(store.use(saved.id),{status:400});assert.equal(store.status().count,1);assert.equal(calls.length,0);
});

test('capability definitions and evidence persist across reopen and a corrupt primary recovers the acknowledged backup',async t=>{
  const {source,store,open,file}=await fixture(t),first=await store.save({projectId:source.id});source.revision++;const second=await store.save({projectId:source.id});await store.close();const restored=await open();assert.equal(restored.status().healthy,true);assert.equal(restored.status().count,2);assert.deepEqual(restored.get(second.id).evidence,second.evidence);await restored.close();
  await writeFile(file,'{incomplete primary');const recovered=await open();assert.equal(recovered.status().healthy,true);assert.equal(recovered.status().count,1);assert.equal(recovered.get(first.id).sourceRevision,7);assert.equal(JSON.parse(await readFile(file,'utf8')).items[0].id,first.id);
});

test('a missing primary also recovers a valid backup instead of silently dropping the library',async t=>{
  const {source,store,open,file}=await fixture(t),first=await store.save({projectId:source.id});source.revision++;await store.save({projectId:source.id});await store.close();await rm(file);const recovered=await open();assert.equal(recovered.status().healthy,true);assert.equal(recovered.status().count,1);assert.equal(recovered.get(first.id).sourceRevision,7);assert.equal(JSON.parse(await readFile(file,'utf8')).items[0].id,first.id);
});

test('corrupt library files fail closed and preserve both originals instead of accepting new methods or creating drafts',async t=>{
  const {source,store,open,file,calls}=await fixture(t);await store.close();const primary='{corrupt-primary',backup='{corrupt-backup';await writeFile(file,primary);await writeFile(file+'.bak',backup);const broken=await open();assert.equal(broken.status().healthy,false);assert.ok(broken.status().error);await assert.rejects(broken.save({projectId:source.id}),{status:503});await assert.rejects(broken.use('anything'),{status:503});assert.equal(calls.length,0);assert.equal(await readFile(file,'utf8'),primary);assert.equal(await readFile(file+'.bak','utf8'),backup);
});

test('well-formed JSON with duplicate identities or malformed saved evidence is rejected as corrupt library data',async t=>{
  const {source,store,open,file}=await fixture(t),saved=await store.save({projectId:source.id});await store.close();
  const invalid=[];
  for(const change of [item=>{item.definition.tasks[0].dependsOn=['missing'];},item=>{item.definition.tasks[0].dependsOn=['write'];},item=>{item.definition.tasks[0].acceptanceCriteria.push(item.definition.tasks[0].acceptanceCriteria[0]);},item=>{item.definition.methodContext='An unowned input block';},item=>{item.evidence[0].taskId='missing';},item=>{item.evidence[0].verificationRunId=item.evidence[0].implementationRunId;},item=>{item.evidence[0].verdict.criteria[0].criterion='A different unreviewed criterion.';}]){const item=copy(saved);change(item);invalid.push([item]);}
  for(const items of [[copy(saved),copy(saved)],[{...copy(saved),definition:{}}],[{...copy(saved),evidence:[{taskId:'write',verdict:{passed:true}}]}],...invalid]){
    await writeFile(file,JSON.stringify({version:1,items}));await rm(file+'.bak',{force:true});const broken=await open();assert.equal(broken.status().healthy,false);await assert.rejects(broken.save({projectId:source.id}),{status:503});await broken.close();
  }
});

test('failed capability persistence keeps the acknowledged state and removes temporary partial files',async t=>{
  const {source,store,file,directory}=await fixture(t),first=await store.save({projectId:source.id}),held=path.join(directory,'held-capabilities.json');source.revision++;await rename(file,held);await mkdir(file);
  try{await assert.rejects(store.save({projectId:source.id}));assert.equal(store.status().count,1);assert.equal(store.get(first.id).sourceRevision,7);assert.equal(JSON.parse(await readFile(held,'utf8')).items[0].id,first.id);assert.ok(!(await readdir(directory)).some(name=>name.startsWith('capabilities.json.tmp-')));}finally{await rmdir(file);await rename(held,file);}
});

test('closing the capability library drains an admitted save and rejects later save or reuse requests',async t=>{
  const {source,store}=await fixture(t),persist=store.persist.bind(store);let release,entered;const arrived=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});store.persist=async next=>{entered();await blocked;return persist(next);};
  const saving=store.save({projectId:source.id});await arrived;let closed=false;const closing=store.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);const rejectedSave=assert.rejects(store.save({projectId:source.id}),{status:503});await assert.rejects(store.use('anything'),{status:503});release();const saved=await saving;await Promise.all([closing,rejectedSave]);assert.equal(store.get(saved.id).sourceProjectId,source.id);
});

test('capability reuse preserves method input and step provenance without copying manual milestones or old ownership',async t=>{
  const {source,store,open,calls}=await fixture(t);
  source.methodContext='Supplied source: fixture.txt';source.context='Keep the authored source constraints.\n\n'+source.methodContext;source.method={id:'source-method',revision:4,name:'Evidence inspection',taskType:'analysis',origin:'custom'};
  source.owner='Previous coordinator';source.dueDate='2026-10-18';source.milestones=[{id:'manual',title:'Planning done',taskIds:[],done:true}];
  Object.assign(source.tasks[0],{stepType:'check',inputs:['Supplied source'],result:'A checked proof.txt file.'});
  const saved=await store.save({projectId:source.id});await store.close();const restored=await open();
  assert.deepEqual(restored.get(saved.id).definition.method,source.method);assert.equal(restored.get(saved.id).definition.methodContext,source.methodContext);assert.equal(restored.get(saved.id).definition.tasks[0].result,source.tasks[0].result);
  const draft=await restored.use(saved.id);assert.equal(draft.status,'draft');assert.equal(draft.tasks[0].attempts.length,0);assert.deepEqual(draft.tasks[0].inputs,['Supplied source']);assert.equal(draft.context,source.context);assert.equal(draft.methodContext,source.methodContext);
  assert.equal(Object.hasOwn(calls[0],'owner'),false);assert.equal(Object.hasOwn(calls[0],'dueDate'),false);assert.equal(Object.hasOwn(calls[0],'milestones'),false);assert.equal(saved.verification,'agent-reviewed');
});
