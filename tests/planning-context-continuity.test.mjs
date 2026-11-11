import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {TaskViability,viabilityDefinition,viabilityFingerprint} from '../lib/task-viability.mjs';

const prior="Publish Morgan O'Neill's approved café project report using the saved brief.";
const latest='Morgan café project.';
test('historical readiness definition fingerprints retain literal input and do not silently bind a later request',()=>{
 const workflow={id:'context',nodes:[{id:'agent',type:'agent',model:'fixture'}],edges:[],settings:{planningMode:'on'}};
 const saved=viabilityDefinition({input:prior,cwd:'C:/fixture',workflow,attachmentIds:['source']});
 const copied=structuredClone(saved);
 assert.equal(saved.input,prior);assert.equal(viabilityFingerprint(saved),viabilityFingerprint(copied));
 assert.notEqual(viabilityFingerprint(saved),viabilityFingerprint({...copied,input:latest}));
 assert.deepEqual(saved,copied);
});
test('saved continuity stays readable through reopen while retired assessment, refresh and answers never recollect or overwrite it',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'retired-continuity-'));let store=await new PlanningBrowserStore({dataDir}).init(),reads=0;
 t.after(async()=>{await store.close();await rm(dataDir,{recursive:true,force:true});});
 await store.create({id:'archive',conversationId:'archive',title:'Saved context',objective:latest,cwd:dataDir});
 const continuity={version:1,userRequests:[{source:'user-request',runId:'original',at:'2026-10-30T12:00:00.000Z',text:prior},{source:'user-request',runId:'followup',at:'2026-10-31T00:00:00.000Z',text:latest}],observations:[{source:'tool-receipt',runId:'original',text:'Observed receipt 17, not a new authorization.'}],truncated:false};
 await store.addSource('archive',{title:'Captured conversation context',text:JSON.stringify(continuity)});
 const raw=JSON.parse(await readFile(store.file('archive'),'utf8'));raw.sources[0].id='viability:continuity';raw.responseCycle={version:1,rootCycleId:'historical-cycle',cycles:[]};store._validate(raw);await writeFile(store.file('archive'),JSON.stringify(raw));
 const before=await readFile(store.file('archive'),'utf8');
 const service=Object.create(TaskViability.prototype);
 for(const key of ['store','runner','engine','identity','queues'])Object.defineProperty(service,key,{get(){reads++;throw Error('Retired continuity cannot recollect sources');}});
 const operations=[()=>service.forRun({id:'archive',planningMode:'on'}),()=>service.forRun({id:'archive',planningMode:'off'}),()=>service.ensure({requestId:'archive'}),()=>service.assess('archive'),()=>service.refreshSources({id:'archive'},{}),()=>service.answer('archive',{answer:'A new fact'})];
 for(const operation of operations)await assert.rejects(async()=>operation(),{code:'PLANNING_CYCLE_RETIRED',status:410});
 assert.equal(reads,0);assert.equal(await readFile(store.file('archive'),'utf8'),before);
 await store.close();store=await new PlanningBrowserStore({dataDir}).init();
 const reopened=await store.get('archive'),source=reopened.sources.find(item=>item.id==='viability:continuity');
 assert.deepEqual(JSON.parse(source.text),continuity);assert.equal(reopened.responses.length,0);assert.equal(reopened.attempts.length,0);
 assert.equal(await readFile(store.file('archive'),'utf8'),before);
});
