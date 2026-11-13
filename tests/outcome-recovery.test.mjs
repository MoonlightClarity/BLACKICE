import test from 'node:test';
import assert from 'node:assert/strict';
import {createModularCompletionController} from '../lib/modular-completion.mjs';
import {planningActivityForEvent,mergePlanningActivity} from '../public/next/chat/planning-timeline.mjs';
const policy={modules:{verification:true}};
const state=()=>({request:{id:'user-request',text:'Finish authorized work'},policy,evidence:{records:[]}});
const decision={decision:'continue',summary:'One attempt failed, not all approaches.',remaining:['requested outcome'],nextAction:'Inspect the specific prerequisite',evidenceRefs:['user-request'],blockers:[]};
test('unchanged final warns and steers before stopping; no acceptance or effect replay',async()=>{
 const updates=[],s=state();const c=createModularCompletionController({policy,getSnapshot:()=>s,review:async()=>decision,onUpdate:r=>updates.push(r)});
 assert.equal((await c.beforeFinal({output:'blocked'})).recovery,undefined);
 const recovery=await c.beforeFinal({output:'blocked again'});
 assert.equal(recovery.recovery,true);assert.match(recovery.prompt,/CHANGE STRATEGY/);assert.match(recovery.prompt,/Do not bypass an explicit denial/);
 assert.equal(updates.at(-1).status,'recovering');assert.equal(updates.at(-1).source,undefined);assert.equal(updates.filter(r=>r.source).length,2);
 await assert.rejects(c.assertReady(),{code:'MODULAR_OUTCOME_INCOMPLETE'});
 await assert.rejects(c.beforeFinal({output:'rewritten answer'}),{code:'MODULAR_OUTCOME_STALLED'});
 assert.equal(updates.at(-1).recovery.stage,'exhausted');
});
test('new evidence resets recovery and permits acceptance only through review',async()=>{
 const s=state();let complete=false;const c=createModularCompletionController({policy,getSnapshot:()=>s,review:async()=>complete?{...decision,decision:'respond',remaining:[],nextAction:''}:decision});
 await c.beforeFinal({output:'not done'});await c.beforeFinal({output:'not done'});
 s.evidence.records.push({id:'observed',tool:'relay_workspace',action:'read',success:true,excerpt:'new evidence'});
 assert.equal((await c.beforeFinal({output:'still unfinished'})).recovery,undefined);
 complete=true;assert.equal(await c.beforeFinal({output:'verified'}),null);assert.equal((await c.assertReady()).ready,true);
});
test('yellow recovery is public saved activity, not completion',()=>{
 const rows=planningActivityForEvent('run',{nodeId:'n',data:{type:'planning.reassessment',module:'modular-outcome',sequence:2,reviewStatus:'recovering',reviewReason:'Trying a different approach'}});
 assert.equal(rows[0].status,'recovering');assert.equal(mergePlanningActivity([],rows)[0].status,'recovering');assert.match(rows[0].title,/Efficiency warning/);
});
