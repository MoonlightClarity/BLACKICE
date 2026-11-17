import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimeManagement} from '../lib/time-management.mjs';
import {normalizePlanningOntology,planningOntologyInstructions} from '../public/planning-module-policy.mjs';
import {modularCompletionEnabled,createModularCompletionController,createModularEvidenceJournal,modularReviewPrompt} from '../lib/modular-completion.mjs';

test('new tasks get immediate time management without enabling a review; saved choices are preserved',()=>{
 const p=normalizePlanningOntology();
 assert.equal(p.modules.time_management,true);assert.equal(modularCompletionEnabled(p),false);
 const old={version:2,modules:{anti_overalignment:true}},before=JSON.stringify(old);
 assert.equal(normalizePlanningOntology(old).modules.time_management,true);assert.equal(JSON.stringify(old),before);
 assert.equal(normalizePlanningOntology({version:2,modules:{time_management:false}}).modules.time_management,false);
 assert.match(planningOntologyInstructions(p),/At task start, before optional research or planning/);
 assert.match(planningOntologyInstructions(p),/explicit hard constraints/);
 assert.match(planningOntologyInstructions(p),/User steering/);
 assert.equal(createTimeManagement({policy:normalizePlanningOntology({modules:{time_management:false}})}),null);
});
test('host clock supplies bounded feedback through existing calls without changing effect or receipt',async()=>{
 let at=0,effects=0;const receipt={success:true,contentItems:[{type:'inputText',text:'effect confirmed'}]};
 const c=createTimeManagement({policy:normalizePlanningOntology(),now:()=>at});
 const call=c.wrap(async()=>{effects++;at+=1000;return receipt;});
 assert.equal(await call({}),receipt);at=30000;
 const enriched=await call({});assert.equal(effects,2);assert.equal(receipt.contentItems.length,1);
 assert.equal(enriched.contentItems.length,2);assert.match(enriched.contentItems[1].text,/"elapsedMs":31000/);
 assert.match(enriched.contentItems[1].text,/"toolCalls":2/);
 assert.match(enriched.contentItems[1].text,/not-inferred-from-tool-calls/);
 assert.equal(await call({}),receipt,'no repeated reminder within observation interval');
 at=99999999;assert.equal((await call({})).success,true,'elapsed time never creates a stop');
 assert.equal(effects,4);
});
test('failed tools and thrown errors remain unchanged, not converted into success',async()=>{
 let at=0;const c=createTimeManagement({policy:normalizePlanningOntology(),now:()=>at});
 const error=Error('real failure');await assert.rejects(c.wrap(async()=>{at+=20;throw error;})({}),e=>e===error);
 const failure={success:false,contentItems:[{type:'inputText',text:'failed'}]};
 assert.equal(await c.wrap(async()=>failure)({}),failure);
 assert.equal(c.snapshot().toolErrors,2);assert.equal(c.snapshot().toolCalls,2);
});
test('clock observations do not invalidate a reviewed outcome or masquerade as new work',async()=>{
 let at=0;const policy=normalizePlanningOntology({version:2,modules:{time_management:true,verification:true}});
 const c=createTimeManagement({policy,now:()=>at});let reviews=0;
 const controller=createModularCompletionController({policy,getSnapshot:async()=>({request:'x',policy,evidence:{records:[]},timeManagement:c.snapshot()}),
 review:async()=>{reviews++;return {decision:'respond',summary:'answered',remaining:[],nextAction:'',evidenceRefs:[],blockers:[]};}});
 assert.equal(await controller.beforeFinal({output:'answer'}),null);at+=99999;
 assert.equal((await controller.assertReady()).ready,true);assert.equal(reviews,1);
});

test('reviewer receives guidance only when selected; journal retains original effects without clock text',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),path=await import('node:path');
 const directory=await mkdtemp(path.join(tmpdir(),'blackice-time-journal-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 let at=0;const policy=normalizePlanningOntology(),c=createTimeManagement({policy,now:()=>at});
 const journal=createModularEvidenceJournal({directory}),receipt={success:true,contentItems:[{type:'inputText',text:'exact original result'}]};
 const handler=c.wrap(journal.wrap(async()=>{at=40000;return receipt;}));
 const result=await handler({name:'fixture',callId:'only-effect',arguments:{action:'write'}});
 assert.equal(result.contentItems.length,2);
 const snapshot=await journal.snapshot();
 assert.equal(snapshot.records.length,1);
 assert.doesNotMatch(JSON.stringify(snapshot),/TIME MANAGEMENT OBSERVATION/);
 const base={request:'bounded',policy,evidence:{records:[]}};
 assert.match(modularReviewPrompt(base,{output:'done'}),/IMMEDIATE EFFORT CALIBRATION/);
 assert.doesNotMatch(modularReviewPrompt({...base,policy:normalizePlanningOntology({modules:{time_management:false}})},{output:'done'}),/IMMEDIATE EFFORT CALIBRATION/);
});

test('timing wrapper forwards context identity, per-call AbortSignal and all extra arguments',async()=>{
 const abort=new AbortController(),context={signal:abort.signal,marker:{}},extra={marker:'third'},call={name:'fixture'};
 const clock=createTimeManagement({policy:normalizePlanningOntology()});
 const result=await clock.wrap(async(...args)=>{assert.deepEqual(args,[call,context,extra]);assert.equal(args[1],context);assert.equal(args[1].signal,abort.signal);return {success:true};})(call,context,extra);
 assert.equal(result.success,true);
 abort.abort();
 await assert.rejects(clock.wrap(async(_call,ctx)=>{ctx.signal.throwIfAborted();})(call,context),{name:'AbortError'});
});
test('old saved defaults migrate missing time management for fresh chats, not explicit Off or saved bytes',async()=>{
 const {readConversationOntology}=await import('../public/next/chat/ontology-preferences.mjs');
 const old={version:2,modules:{inference:false,verification:false}},before=JSON.stringify(old);
 const migrated=readConversationOntology({defaults:old});
 assert.equal(migrated.planningOntology.modules.time_management,true);
 assert.equal(migrated.planningOntology.modules.inference,false);
 assert.equal(JSON.stringify(old),before);
 const disabled={version:2,modules:{...old.modules,time_management:false}};
 assert.equal(readConversationOntology({defaults:disabled}).planningOntology.modules.time_management,false);
});
