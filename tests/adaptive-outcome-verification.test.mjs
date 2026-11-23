import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
import {directoryOutcomeOutline,bindDirectoryReviewAliases,normalizeVerificationMethod} from '../lib/outcome-verification-methods.mjs';
import {createChatOutcomeReviewer} from '../lib/chat-outcome-review.mjs';

const record=(id,tool='relay_workspace')=>({id,callId:id,source:'admitted-tool-delivery',tool,action:'read',success:true,result:{success:true,contentItems:[{type:'inputText',text:'Observed exact result.'}]}});
const receipt=(id,extra={})=>({id,taskId:'task',runId:'run',nodeId:'a',actionId:'verify',tool:'relay_workspace',state:'returned',success:true,...extra});
const boundary='\nREVIEW DATA (JSON):\n';
const view=options=>JSON.parse(options.prompt.split(boundary).at(-1));
const response=(evidenceRefs,extra={})=>({decision:'respond',summary:'The current evidence supports the result.',remaining:[],nextAction:'',evidenceRefs,blockers:[],...extra});

test('review outline uses only exact current host call bindings; claims and unknown effects remain distinct',()=>{
 const s={taskId:'task',revision:4,actionRevision:3,focus:null,ready:[],
  actions:[{id:'verify',objective:'Verify exact result',state:'observed',dependsOn:[],
   observation:{authority:'agent',claim:'All done',receipts:['r1','r2','r3','r4']}}],
  receipts:[receipt('r1',{at:'2026-11-23T20:00:00.000Z',returnedAt:'2026-11-23T20:00:01.000Z',observationOnly:true}),receipt('r2',{runId:'old-run'}),receipt('r3',{tool:'relay_browser'}),
    receipt('r4',{state:'unknown',success:null}),receipt('r5',{state:'unknown',success:null})]};
 const mapping=new Map([['r1','c1'],['r2','c2'],['r3','c3'],['r4','c4'],['r5','c5']]);
 const outline=directoryOutcomeOutline(s,mapping,['c1','c2','c3','c4','c5'].map(id=>record(id)),{runId:'run',nodeId:'a'});
 assert.deepEqual(outline.receiptLinks.map(x=>[x.receiptId,x.evidenceId]),[['r1','c1'],['r2',null],['r3',null],['r4',null],['r5',null]]);
 assert.equal(outline.actions[0].observation.authority,'agent');
 assert.equal(outline.receiptLinks[0].reservedAt,'2026-11-23T20:00:00.000Z');
 assert.equal(outline.receiptLinks[0].returnedAt,'2026-11-23T20:00:01.000Z');
 assert.equal(outline.receiptLinks[0].observationOnly,true);
 assert.equal(outline.receiptLinks[3].returnedAt,undefined);
 assert.equal(outline.receiptLinks.at(-1).state,'unknown');
 const aliases=bindDirectoryReviewAliases(outline,[{evidenceId:'c1',citationRef:'evidence-0001'}]);
 assert.deepEqual(aliases.receiptLinks.map(x=>x.citationRef),['evidence-0001',null,null,null,null]);
 assert.equal(outline.receiptLinks[0].citationRef,undefined);
});

test('method selection is advisory and supports combinations, not a new completion gate',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'adaptive-review-method-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const events=[],prompts=[];
 let next={methods:['contract-counterexample','requirement-coverage','contract-counterexample'],reason:'Check each public contract and affected integration.',triggers:['on-contradiction-or-failure','before-dependent-action','before-final-report','before-dependent-action']};
 const reviewer=createChatOutcomeReviewer({cwd,model:'fixture',authority:{developerInstructions:'Review the admitted current evidence.'},onUpdate:e=>events.push(e),
  runtime:{status:()=>({models:[{id:'fixture',contextWindowTokens:128000,maxOutputTokens:4096}]}),async runAgent(options){
   prompts.push(options);assert.match(options.prompt,/chronological-waterfall/);
   assert.ok(options.outputSchema.properties.verificationMethod);
   assert.ok(!options.outputSchema.required.includes('verificationMethod'));
   assert.ok(!options.outputSchema.properties.verificationMethod.required.includes('triggers'));
   assert.match(options.prompt,/Do not impose a waterfall on unrelated or simple work/);
   assert.match(options.prompt,/Before a dependent action/);
   return{output:JSON.stringify(response(['evidence-0001'],{verificationMethod:next}))};
  }}});
 const request={input:'Verify the repaired caller contract.',candidate:{output:'The contract check passed.'},evidenceFingerprint:'state',evidence:{records:[record('c1')],total:1,omitted:0}};
 const accepted=await reviewer.assess(request);
 assert.equal(accepted.decision,'respond');
 assert.deepEqual(accepted.verificationMethod.methods,['contract-counterexample','requirement-coverage']);
 assert.equal(events.filter(e=>e.status==='validated').at(-1).verificationMethod.reason,next.reason);
 assert.deepEqual(accepted.verificationMethod.triggers,['on-contradiction-or-failure','before-dependent-action','before-final-report']);
 assert.deepEqual(events.filter(e=>e.status==='validated').at(-1).verificationMethod.triggers,accepted.verificationMethod.triggers);
 next={methods:['invented-method'],reason:'Bad advisory metadata'};
 const corrected=await reviewer.assess({...request,evidenceFingerprint:'state2'});
 assert.equal(corrected.decision,'respond');
 assert.equal(corrected.verificationMethod,undefined);
 next={methods:['direct-result'],reason:'A single result.',triggers:['invented-trigger']};
 const invalidTiming=await reviewer.assess({...request,evidenceFingerprint:'state3'});
 assert.equal(invalidTiming.decision,'respond');
 assert.deepEqual(invalidTiming.verificationMethod,{methods:['direct-result'],reason:'A single result.'});
 assert.equal(prompts.length,3);
 assert.equal(normalizeVerificationMethod({methods:[],reason:'x'}),undefined);
});

test('ordinary Chat reviewer receives actual Directory outline and result aliases after an operational write and read',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'adaptive-directory-review-'));
 let engine,reviewed=0,callCount=0;
 class Runtime extends EventEmitter{
  status(){return {connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true,contextWindowTokens:128000,maxOutputTokens:4096}]};}
  async runAgent(options){
   if(options.prompt.includes('BLACKICE ORDINARY TASK OUTCOME REVIEW')){
    reviewed++;
    const {snapshot}=view(options),outline=snapshot.scope.directoryOutline;
    assert.equal(outline.source,'host-directory-outline');
    assert.equal(outline.actions.length,1);
    assert.equal(outline.actions[0].state,'observed');
    assert.equal(outline.actions[0].observation.authority,'agent');
    assert.match(options.prompt,/observed state is not independent outcome proof/);
    const read=snapshot.evidence.records.find(r=>r.tool==='relay_workspace'&&r.action==='read');
    const write=snapshot.evidence.records.find(r=>r.tool==='relay_workspace'&&r.action==='write');
    assert.ok(read&&write);
    assert.ok(outline.receiptLinks.some(l=>l.evidenceId===read.id&&l.citationRef===read.citationRef));
    assert.ok(outline.receiptLinks.some(l=>l.evidenceId===write.id&&l.citationRef===write.citationRef));
    for(const link of outline.receiptLinks){assert.equal(typeof link.reservedAt,'string');assert.equal(typeof link.returnedAt,'string');assert.ok(Date.parse(link.returnedAt)>=Date.parse(link.reservedAt));}
    return {output:JSON.stringify(response([read.citationRef,write.citationRef],{verificationMethod:{methods:['direct-result'],reason:'One bounded saved file and read-back.'}}))};
   }
   const workerInstructions=String(options.developerInstructions??'')+'\n'+String(options.prompt??'');
   assert.match(workerInstructions,/ADAPTIVE OUTCOME VERIFICATION/);
   assert.match(workerInstructions,/Perform needed checks at their relevant event boundaries during execution/);
   assert.match(workerInstructions,/do not postpone consequential prerequisite checks/);
   const call=async(name,args)=>{
    const c={name,arguments:args,callId:'actual-call-'+(++callCount)};
    const result=await options.onToolCall(c);
    assert.equal(result.success,true,JSON.stringify(result).slice(0,500));
    await options.onToolResultDelivered?.({call:c,result});
    return result;
   };
   const dir=args=>call('relay_directory_action',args);
   await dir({action:'plan',actions:[{id:'save',objective:'Save and read back the exact file',dependsOn:[]}]});
   await dir({action:'focus',id:'save'});
   const p=path.join(cwd,'result.txt');
   const w=await call('relay_workspace',{action:'write',path:p,text:'verified value\n'});
   const r=await call('relay_workspace',{action:'read',path:p});
   const receiptOf=result=>result.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
   await dir({action:'observe',id:'save',outcome:'objective-met',claim:'Saved and read back the exact file.',receipts:[receiptOf(w),receiptOf(r)]});
   const final={output:'Saved and verified result.txt.',signal:options.signal};
   assert.equal((await options.onBeforeFinal(final))?.continue,true);
   assert.equal(await options.onBeforeFinal(final),null);
   return{output:final.output};
  }
 }
 t.after(async()=>{await engine?.close();await rm(cwd,{recursive:true,force:true});});
 const task='Write result.txt with verified value and check the saved contents.';
 const workflow={id:'mission_chat_adaptive_verification_fixture',description:'A focused task started from Mission.',name:'Adaptive verification fixture',
 nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture',prompt:'Perform the current task.'},{id:'o',type:'output'}],
 edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{planningMode:'off',maxParallel:1}};
 engine=await new HarnessEngine({runtime:new Runtime(),dataDir:path.join(cwd,'data'),defaultCwd:cwd}).init();
 const started=engine.startRun({workflow,input:{task,cwd,chatPlanning:'off',directoryActions:'on',directoryDiagnostics:'maximal'}});
 await engine.executions.get(started.id);
 const run=engine.getRun(started.id);
 assert.equal(run.status,'completed',String(run.error));
 assert.equal(reviewed,1);
 assert.equal(await readFile(path.join(cwd,'result.txt'),'utf8'),'verified value\n');
 assert.deepEqual(engine.runs.get(started.id).nodes.a.outcomeAssessment.verificationMethod.methods,['direct-result']);
});
