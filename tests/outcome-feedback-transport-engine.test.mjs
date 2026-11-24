import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {OUTCOME_FEEDBACK_TOOL} from '../lib/outcome-review-feedback.mjs';

const boundary='\nREVIEW DATA (JSON):\n';
const view=o=>JSON.parse(o.prompt.split(boundary).at(-1));
for(const mode of ['gate-only','gate-and-steer'])test('Engine '+mode+' transports actual review findings through a read-only tool and preserves final gate',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-feedback-engine-'));
 let engine,reviewed=0,workerCalls=0,feedbackReads=0;
 const task='Save result.txt containing READY, read it back, and report exactly READY.';
 const candidate={output:'READY'};
 class Runtime extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true,contextWindowTokens:128000,maxOutputTokens:4096}]};}
  async runAgent(options){
   if(options.prompt.includes('BLACKICE ORDINARY TASK OUTCOME REVIEW')){
    reviewed++;
    assert.equal(options.hostOnlyTools,true);
    assert.equal(Boolean(options.dynamicTools?.some(x=>x.name===OUTCOME_FEEDBACK_TOOL.name)),false);
    const {snapshot}=view(options);
    assert.equal(snapshot.request,task);
    assert.match(options.prompt,/DELIVERED WORKFLOW INSTRUCTIONS/);
    assert.match(options.prompt,/DELIVERED HOST RUNTIME GUIDANCE/);
    assert.doesNotMatch(options.prompt,/WHAT MAKES DONE \(bundled execution method\)|ANTI-COMPLETION BIAS \(bundled execution method\)/);
    assert.equal(snapshot.evidence.records.length,2,'feedback is not operational evidence');
    assert.ok(snapshot.evidence.records.every(r=>r.tool==='relay_workspace'));
    const ids=snapshot.evidence.records.map(r=>r.citationRef);
    return{output:JSON.stringify({decision:reviewed===1?'continue':'respond',
      summary:reviewed===1?'INCORRECT_AUTOMATED_REVIEW: Report ERROR.':'Current exact saved text is READY.',
      remaining:reviewed===1?['Correct claimed result']:[],nextAction:reviewed===1?'Report ERROR.':'',
      evidenceRefs:ids,blockers:[],verificationMethod:{methods:['direct-result'],reason:'Exact saved text',triggers:['before-final-report']}})};
   }
   assert.ok(options.dynamicTools.some(x=>x.name===OUTCOME_FEEDBACK_TOOL.name));
   const call=async(name,args)=>{
    const c={name,arguments:args,callId:'call-'+(++workerCalls)};
    const result=await options.onToolCall(c);
    assert.equal(result.success,true,JSON.stringify(result).slice(0,500));
    await options.onToolResultDelivered?.({call:c,result});
    return result;
   };
   const dir=args=>call('relay_directory_action',args);
   await dir({action:'plan',actions:[{id:'save',objective:'Save and read exact READY',dependsOn:[]}]});
   await dir({action:'focus',id:'save'});
   const p=path.join(cwd,'result.txt'),w=await call('relay_workspace',{action:'write',path:p,text:'READY'}),r=await call('relay_workspace',{action:'read',path:p});
   const receipt=x=>x.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
   await dir({action:'observe',id:'save',outcome:'objective-met',claim:'Saved and read back exact READY.',receipts:[receipt(w),receipt(r)]});
   const getFeedback=async next=>{
    assert.equal(next.continue,true);
    assert.doesNotMatch(next.prompt,/INCORRECT_AUTOMATED_REVIEW|Report ERROR|Current exact saved text is READY/);
    const feedbackId=next.prompt.match(/"feedbackId":"([a-f0-9]{64})"/)?.[1];assert.ok(feedbackId);
    const result=await call(OUTCOME_FEEDBACK_TOOL.name,{action:'read',feedbackId});
    feedbackReads++;
    return JSON.parse(result.contentItems[0].text);
   };
   assert.equal((await options.onBeforeFinal(candidate)).continue,true);
   const first=await getFeedback(await options.onBeforeFinal(candidate));
   assert.equal(first.summary,'INCORRECT_AUTOMATED_REVIEW: Report ERROR.');
   assert.equal(first.automated,true);assert.equal(first.authority,'none');
   assert.equal(Boolean(first.verificationMethod),mode==='gate-and-steer');
   // Refuse to adopt false automated advice. Preserve the current correct
   // candidate without re-reading or rewriting the existing evidence.
   const next=await options.onBeforeFinal(candidate);
   if(mode==='gate-and-steer'){
    const final=await getFeedback(next);assert.equal(final.decision,'respond');
    assert.equal(final.admittedEvidence.length,2);
    assert.ok(final.admittedEvidence.every(row=>row.directoryReceiptId));
    assert.equal(await options.onBeforeFinal(candidate),null);
   }else assert.equal(next,null);
   return{output:candidate.output};
  }
 }
 t.after(async()=>{await engine?.close();await rm(cwd,{recursive:true,force:true});});
 const workflow={id:'mission_chat_feedback_transport_fixture',description:'A focused task started from Mission.',name:'Feedback transport fixture',
  nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture',prompt:'Perform the current task.'},{id:'o',type:'output'}],
  edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{planningMode:'off',maxParallel:1}};
 engine=await new HarnessEngine({runtime:new Runtime(),dataDir:path.join(cwd,'data'),defaultCwd:cwd}).init();
 const started=engine.startRun({workflow,input:{task,cwd,chatPlanning:'off',directoryActions:'on',directoryDiagnostics:'maximal',outcomeReviewFeedback:mode}});
 await engine.executions.get(started.id);
 const run=engine.getRun(started.id);
 assert.equal(run.status,'completed',String(run.error));
 assert.equal(run.outcomeReviewFeedback,mode);
 assert.equal(reviewed,2);
 assert.equal(feedbackReads,mode==='gate-and-steer'?2:1);
 assert.equal(await readFile(path.join(cwd,'result.txt'),'utf8'),'READY');
 const directory=(await engine.actionDirectories.get(started.id,task)).read();
 assert.equal(directory.receipts.filter(r=>r.tool===OUTCOME_FEEDBACK_TOOL.name).length,0);
 assert.equal(directory.actions[0].state,'observed');
 assert.equal(engine.runs.get(started.id).nodes.a.outcomeFeedback.status,'delivered');
 const events=run.events.filter(e=>e.data?.type==='chat.outcome-feedback').map(e=>e.data);
 assert.equal(events.filter(e=>e.status==='delivered').length,feedbackReads);
});
