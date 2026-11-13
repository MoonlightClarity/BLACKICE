import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModularCompletionController} from '../lib/modular-completion.mjs';
import {ShadowdancerDirectory,runShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
const policy={version:2,modules:{verification:true,replanning:true}};
function controller(patch={}){
 let snapshot={request:{text:'Repair; report briefly'},evidence:{records:[{id:'r1',result:'bounded test passed'}]},policy},calls=0;
 const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,
 review:async()=>{calls++;return {decision:'revise_response',summary:'Work sufficiently supported; report needs organization.',
 remaining:[],nextAction:'Summarize existing evidence',evidenceRefs:['r1'],blockers:[],...patch};}});
 return {c,get calls(){return calls;},change:fn=>fn(snapshot)};
}
test('presentation corrections never offer automatic semantic acceptance',async()=>{
 const h=controller(),review=await h.c.beforeFinal({output:'old report'});
 assert.equal(review.responseOnly,true);assert.equal(review.acceptHostReportRevision,undefined);
 await assert.rejects(h.c.assertReady(),{code:'MODULAR_OUTCOME_INCOMPLETE'});
});
test('distinct report-only revisions do not require new task effects',async()=>{
 const h=controller();
 for(const output of ['first','second','third','fourth'])assert.equal((await h.c.beforeFinal({output})).responseOnly,true);
 assert.equal(h.calls,4);await assert.rejects(h.c.assertReady(),{code:'MODULAR_OUTCOME_INCOMPLETE'});
});
test('unchanged report and A-B-A cycles stop without effect replay',async()=>{
 for(const outputs of [['a','a'],['a','b','a']]){
  const h=controller();for(const output of outputs.slice(0,-1))await h.c.beforeFinal({output});
  await assert.rejects(h.c.beforeFinal({output:outputs.at(-1)}),{code:'MODULAR_REPORT_STALLED'});
  await assert.rejects(h.c.assertReady(),{code:'MODULAR_OUTCOME_INCOMPLETE'});
 }
});
test('new evidence permits reassessment of same report',async()=>{
 const h=controller();await h.c.beforeFinal({output:'a'});
 h.change(s=>s.evidence.records.push({id:'r2',result:'new receipt',tool:'test',excerpt:'new receipt'}));
 assert.equal((await h.c.beforeFinal({output:'a'})).responseOnly,true);
});
test('changed receipt result or policy permits reassessment, bookkeeping alone does not',async()=>{
 for(const mutate of [
   s=>{s.evidence.records[0].result={content:'materially changed evidence'};},
   s=>{s.policy={...s.policy,modules:{...s.policy.modules,reflection:true}};}
 ]){
   const h=controller();await h.c.beforeFinal({output:'a'});h.change(mutate);
   assert.equal((await h.c.beforeFinal({output:'a'})).responseOnly,true);
 }
 const h=controller();await h.c.beforeFinal({output:'a'});
 h.change(s=>s.evidence.records[0].at=new Date().toISOString());
 await assert.rejects(h.c.beforeFinal({output:'a'}),{code:'MODULAR_REPORT_STALLED'});
});
test('operational nonprogress still stops',async()=>{
 const h=controller({decision:'continue',remaining:['fix behavior']});
 await h.c.beforeFinal({output:'a'});await h.c.beforeFinal({output:'b'});
 await assert.rejects(h.c.beforeFinal({output:'c'}),{code:'MODULAR_OUTCOME_STALLED'});
});
test('fresh semantic review can accept corrected response',async()=>{
 let calls=0;
 const c=createModularCompletionController({policy,getSnapshot:()=>({policy,evidence:{records:[]}}),
 review:async()=>({decision:++calls===1?'revise_response':'respond',summary:'Exact report reviewed',
 remaining:[],nextAction:'',evidenceRefs:['candidate'],blockers:[]})});
 assert.equal((await c.beforeFinal({output:'first'})).responseOnly,true);
 assert.equal(await c.beforeFinal({output:'corrected'}),null);
 assert.equal(calls,2);assert.equal((await c.assertReady()).ready,true);
});
test('Directory outer loop re-reviews changed report without another work phase',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'report-outer-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const originalRun=ShadowdancerDirectory.prototype.run,originalRevision=ShadowdancerDirectory.prototype.reviseAnswer;
 t.after(()=>{ShadowdancerDirectory.prototype.run=originalRun;ShadowdancerDirectory.prototype.reviseAnswer=originalRevision;});
 let workRuns=0,revisions=0,reviews=0;
 ShadowdancerDirectory.prototype.run=async function(){
   workRuns++;this.summary=async()=>{};this.label=async()=>{};this.work=[];
   return {answer:'old report'};
 };
 ShadowdancerDirectory.prototype.reviseAnswer=async function(){revisions++;return {answer:'corrected report'};};
 const c=createModularCompletionController({policy,getSnapshot:()=>({policy,evidence:{records:[]}}),
   review:async({candidate})=>{
     reviews++;assert.equal(candidate.output,reviews===1?'old report':'corrected report');
     return {decision:reviews===1?'revise_response':'respond',summary:'Exact candidate reviewed',
       remaining:[],nextAction:'',evidenceRefs:['candidate'],blockers:[]};
   }});
 const result=await runShadowdancerDirectory({cwd,runId:'report-outer',conversationId:'report-outer',model:'fixture',
   runtime:{runAgent:async()=>{throw Error('Unexpected model execution in controlled fixture');}},
   input:'Report',onBeforeFinal:candidate=>c.beforeFinal(candidate)});
 assert.equal(result.answer,'corrected report');assert.equal(workRuns,1);assert.equal(revisions,1);assert.equal(reviews,2);
 assert.equal((await c.assertReady()).ready,true);
});
async function fixture(t,changed){
 const dir=await mkdtemp(path.join(os.tmpdir(),'report-comparison-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const finalPath=path.join(dir,'final.json');await writeFile(finalPath,JSON.stringify({answer:'before'}));
 const r=Object.create(ShadowdancerDirectory.prototype);
 Object.assign(r,{integrations:dir,turnRoot:dir,stats:{},label:async()=>{},
 integrate:async()=>({answer:changed?'after':'before',finalPath}),finishRun:async v=>v,
 continueWork:async()=>{throw Error('No work replay');}});
 return {r,dir};
}
test('unchanged report remains unresolved',async t=>{
 const {r,dir}=await fixture(t,false);
 await assert.rejects(r.reviseAnswer('Shorten it'),{code:'DIRECTORY_REPORT_REVISION_UNCHANGED'});
 const saved=JSON.parse(await readFile(path.join(dir,'reports/revision-001/presentation-result.json')));
 assert.equal(saved.changed,false);assert.equal(saved.status,'unresolved_unchanged');
 assert.equal(JSON.parse(await readFile(path.join(dir,'reports/revision-001/previous-final.json'))).answer,'before');
});
test('changed report is progress, not semantic acceptance',async t=>{
 const {r,dir}=await fixture(t,true);assert.equal((await r.reviseAnswer('Shorten it')).answer,'after');
 const saved=JSON.parse(await readFile(path.join(dir,'reports/revision-001/presentation-result.json')));
 assert.equal(saved.changed,true);assert.equal(saved.status,'changed_not_semantically_accepted');
});
