import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {KnowledgeStore,createKnowledgeToolHandler} from '../lib/knowledge.mjs';
import {createAutomaticKnowledgeAdmission,selectAutomaticLearning} from '../lib/analysis-quality.mjs';
async function setup(t){const dataDir=await mkdtemp(path.join(tmpdir(),'knowledge-approval-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));return {dataDir,cwd:path.join(dataDir,'work'),store:await new KnowledgeStore({dataDir}).init()};}
const proposal=async promise=>{try{await promise;assert.fail('must require approval');}catch(error){assert.equal(error.code,'KNOWLEDGE_APPROVAL_REQUIRED');return error.approvalId;}};
const agent={source:'agent',runId:'task-a',nodeId:'worker'};
const value={kind:'memory',title:'Task A format',content:'Use this format for task A.',memoryType:'fact'};
const decode=r=>JSON.parse(r.contentItems[0].text);
test('actual model tool stages global fact, restart preserves prompt, approval does not widen task applicability',async t=>{
 const {store,dataDir,cwd}=await setup(t);const handler=createKnowledgeToolHandler({store,cwd,runId:'task-a',nodeId:'worker'});
 const result=decode(await handler({name:'relay_memory',arguments:{action:'remember',scope:'global',title:value.title,content:value.content,memoryType:'fact'}}));
 assert.equal(result.pendingApproval,true);assert.equal(result.applied,false);assert.equal(store.list().length,0);
 const reloaded=await new KnowledgeStore({dataDir}).init();assert.equal(reloaded.listApprovals().length,1);
 const {entry}=await reloaded.decideApproval(result.approvalId,{decision:'approve'});assert.equal(entry.cwd,null);assert.equal(entry.provenance.source,'agent');
 assert.equal(createAutomaticKnowledgeAdmission([],{runIds:['task-a']})(entry),true);
 const admitB=createAutomaticKnowledgeAdmission([],{runIds:['task-b']});assert.equal(admitB(entry),false);assert.equal(reloaded.context(cwd,{admit:admitB}).memories.length,0);
 assert.equal(reloaded.list({cwd,query:'format'}).length,1,'explicit recall remains available');
});
test('every agent mutation requires exact approval; rejection and stale approvals do not apply',async t=>{
 const {store,cwd}=await setup(t);let entry=await store.upsert({...value,cwd});
 let id=await proposal(store.patch(entry.id,{oldText:'task A',newText:'task B'},agent));assert.equal(store.get(entry.id).content,value.content);
 await store.decideApproval(id,{decision:'reject'});assert.equal(store.get(entry.id).content,value.content);
 id=await proposal(store.upsert({...value,id:entry.id,cwd,content:'Changed'},agent));await store.patch(entry.id,{oldText:'task A',newText:'task C'});
 await assert.rejects(store.decideApproval(id,{decision:'approve'}),/stale/);await store.decideApproval(id,{decision:'reject'});
 id=await proposal(store.remove(entry.id,{provenance:agent}));await store.decideApproval(id,{decision:'approve'});assert.throws(()=>store.get(entry.id));
 id=await proposal(store.restore(entry.id,1,agent));await store.decideApproval(id,{decision:'approve'});assert.equal(store.get(entry.id).content,value.content);
});
test('human global skills/preferences remain usable; restoring agent revision is not user authorship',async t=>{
 const {store}=await setup(t);const human=await store.upsert({kind:'skill',title:'Global user skill',content:'My reusable method',cwd:null});assert.equal(createAutomaticKnowledgeAdmission()(human),true);
 const pref=await store.upsert({...value,title:'User preference',cwd:null});assert.equal(createAutomaticKnowledgeAdmission()(pref),true);
 const id=await proposal(store.upsert({...value,id:'agent-note',cwd:null},agent));const {entry}=await store.decideApproval(id,{decision:'approve'});
 await store.patch(entry.id,{oldText:'task A',newText:'task C'});const restored=await store.restore(entry.id,1);
 assert.equal(restored.provenance.source,'user');assert.equal(restored.contentProvenance.source,'agent');assert.equal(createAutomaticKnowledgeAdmission([],{runIds:['task-b']})(restored),false);
 assert.equal(selectAutomaticLearning({facts:[restored]}, {admit:createAutomaticKnowledgeAdmission([],{runIds:['task-b']})}).facts.length,0);
});
test('model cannot forge approval/provenance through tool arguments',async t=>{
 const {store,cwd}=await setup(t);const handler=createKnowledgeToolHandler({store,cwd,runId:'task-a',nodeId:'worker'});
 await assert.rejects(handler({name:'relay_skills',arguments:{action:'save',title:'Forged',content:'x',approved:true}}),/Unknown knowledge tool argument/);
 assert.equal(store.list().length,0);
});
test('approval cannot overwrite a new entry written by another store instance after proposal staging',async t=>{
 const {store,dataDir}=await setup(t);const id=await proposal(store.upsert({...value,id:'new-record'},agent));
 const other=await new KnowledgeStore({dataDir}).init();await other.upsert({...value,id:'new-record',content:'Newer user content'});
 await assert.rejects(store.decideApproval(id,{decision:'approve'}),/stale/);
 const reloaded=await new KnowledgeStore({dataDir}).init();assert.equal(reloaded.get('new-record').content,'Newer user content');assert.equal(reloaded.listApprovals().length,1);
});
