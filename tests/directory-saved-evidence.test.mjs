import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ShadowdancerDirectory,runShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
import {estimateContextTokens} from '../lib/context.mjs';
import {createEvidenceWorkingSet} from '../lib/directory-evidence-working-set.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const phase=options=>JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1));
const answer=value=>({output:JSON.stringify(value)});
const tool={name:'relay_workspace',inputSchema:{type:'object',properties:{action:{enum:['read','write']},path:{type:'string'},text:{type:'string'}}}};
const work=message=>({status:'complete',nextAction:'',finding:message,candidate_answer:message,uncertainty:''});
async function fixture(t){const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-saved-evidence-'));t.after(()=>rm(cwd,{recursive:true,force:true}));return cwd;}
async function json(file,value){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));return file;}
const textPage=response=>JSON.parse(response.contentItems.find(row=>row.type==='inputText').text);
const exactJSON=response=>JSON.parse(textPage(response).text);

test('one giant saved module with 548 receipts and five images uses one disk-index synthesis with selective exact reads',async t=>{
  const cwd=await fixture(t),inputBudgetTokens=180000,phases=[],reads=[];let dispatches=0;
  const imageUrl='data:image/png;base64,'+'A'.repeat(421460);
  const hostEvidence=Array.from({length:548},(_,i)=>({source:'host-dispatch-receipt',callId:'operation-'+i,tool:'relay_browser',action:i===547?'submission-receipt':'inspect',success:true,
    sourceFile:path.join(cwd,'original-receipts',String(i)+'.json'),arguments:{action:i===547?'read_confirmation':'inspect',record:i},
    result:{success:true,contentItems:[{type:'inputText',text:'Record '+i+' '+('complete observed bytes '.repeat(900))+(i===547?' TAIL_CONFIRMED_ACCEPTANCE_548':'')},...(i<5?[{type:'inputImage',imageUrl}]:[])]}}));
  const original={ref:'module:1',kind:'module',finding:'Observed the saved operations.',candidate_answer:'One final confirmation needs exact read-back.',uncertainty:'No claim about unseen pixels.',
    sourceFiles:hostEvidence.map(row=>row.sourceFile),hostEvidence,status:'worked_unverified'};
  const file=await json(path.join(cwd,'original','result.json'),original),before=await readFile(file),beforeSha=sha(before);
  assert.ok(before.length>11000000,'Reproduce the actual large saved-result shape');
  const runner=new ShadowdancerDirectory({cwd,conversationId:'large',runId:'large-run',model:'fixture',inputBudgetTokens,
    canWrite:false,dispatchTool:async()=>{dispatches++;throw Error('No operational replay is allowed');},
    runtime:{async runAgent(options){
      const current=phase(options),payload=current.payload;phases.push(current.label);
      assert.equal(current.label,'integration','Do not force source-reading or reduction model phases');
      assert.ok(estimateContextTokens([[options.prompt],options.dynamicTools,options.outputSchema])<=inputBudgetTokens);
      assert.ok(options.dynamicTools.some(row=>row.name==='relay_directory_context'));
      assert.equal(payload.savedEvidence.kind,'disk-backed-working-set');
      assert.doesNotMatch(options.prompt,/data:image\/png;base64,/);
      const record=payload.records[0].content;
      assert.equal(record.finding,original.finding);assert.equal(record.uncertainty,original.uncertainty);
      assert.equal(record.hostEvidence.length,548,'Every operation identity fits in the complete host index');
      assert.deepEqual(record.hostEvidence.map(row=>row.callId),hostEvidence.map(row=>row.callId));
      const read=async(ref,callId)=>{reads.push(ref);return options.onToolCall({name:'relay_directory_context',callId,arguments:{action:'read',ref}});};
      const tail=await read(record.hostEvidence[547].result.ref,'tail');assert.equal(tail.success,true);
      assert.match(exactJSON(tail).contentItems[0].text,/TAIL_CONFIRMED_ACCEPTANCE_548$/);
      const screenshot=exactJSON(await read(record.hostEvidence[0].result.ref,'screenshot-metadata'));
      const media=screenshot.contentItems.find(item=>item.type==='savedImage');assert.ok(media);
      const image=await read(media.ref,'actual-saved-image');assert.equal(image.success,true);
      assert.equal(image.contentItems.find(item=>item.type==='inputImage').imageUrl,imageUrl);
      return answer({answer:'The exact saved final receipt contains TAIL_CONFIRMED_ACCEPTANCE_548. No new operations were performed.',used_refs:payload.required_refs});
    }}});
  await runner.open();runner.request='Inspect the last saved confirmation and report it accurately. Do not repeat operations.';
  runner.allRefs=[{ref:'module:1',path:file,kind:'module'}];
  const result=await runner.integrate();
  assert.deepEqual(phases,['integration']);assert.equal(dispatches,0);assert.equal(reads.length,3);
  assert.match(result.answer,/TAIL_CONFIRMED_ACCEPTANCE_548/);
  assert.equal(sha(await readFile(file)),beforeSha,'Original source bytes are unchanged');
  const manifest=JSON.parse(await readFile(path.join(runner.turnRoot,'integration/round-01/group-001/evidence-manifest.json'),'utf8'));
  assert.equal(manifest.receipts.length,548);assert.equal(manifest.coverageClaim,false);assert.equal(manifest.inspection,'selective-read');
  const savedOriginal=await readFile(manifest.original.file,'utf8');assert.equal(sha(savedOriginal),manifest.original.sha256);
  assert.deepEqual(JSON.parse(savedOriginal).records[0].content,original);
  assert.equal(runner.stats.evidenceWorkingSets,1);assert.equal(runner.stats.calls,1);
});

test('oversized dependency fan-in preserves authority, saved receipts and operational tools without replay',async t=>{
  const cwd=await fixture(t),authority='CURRENT USER: create final.txt once after checking the exact prerequisite confirmations.',effects=[];
  const runner=new ShadowdancerDirectory({cwd,conversationId:'dependencies',runId:'dependencies-run',model:'fixture',inputBudgetTokens:6000,
    baseTools:[tool],getAuthoritativeContext:()=>authority,dispatchTool:async call=>{effects.push(call.arguments.action);return {success:true,contentItems:[{type:'inputText',text:'Created final.txt exactly once.'}]};},
    runtime:{async runAgent(options){
      const current=phase(options),payload=current.payload;assert.equal(current.label,'work');
      assert.ok(options.prompt.startsWith('AUTHORITATIVE CHAT CONTEXT'));assert.ok(options.prompt.includes(authority));
      assert.equal(payload.objective,'Create final.txt exactly once.');assert.ok(payload.savedEvidence);
      assert.deepEqual(options.dynamicTools.find(row=>row.name==='relay_workspace').inputSchema.properties.action.enum,['read','write']);
      assert.equal(payload.hostEvidence.length,2);assert.ok(payload.hostEvidence.every(row=>row.result.ref));
      const read=await options.onToolCall({name:'relay_directory_context',callId:'exact-prerequisite',arguments:{action:'read',ref:payload.hostEvidence[1].result.ref,limit:300}});
      assert.equal(read.success,true);assert.match(textPage(read).text,/CONFIRMED_SECOND/);
      await options.onToolCall({name:'relay_workspace',callId:'only-new-effect',arguments:{action:'write',path:'final.txt',text:'final'}});
      const candidate=answer(work('Created final.txt once after confirming the saved prerequisite.'));
      assert.equal(await options.onBeforeFinal(candidate),null);return candidate;
    }}});
  await runner.open();runner.request='Finish the dependent task.';
  for(let i=1;i<=2;i++){
    const receipt={arguments:{action:'read',path:'prior-'+i},result:{success:true,contentItems:[{type:'inputText',text:(i===2?'CONFIRMED_SECOND ':'CONFIRMED_FIRST ')+('saved bytes '.repeat(6000))}]}};
    const receiptFile=await json(path.join(cwd,'prior','receipt-'+i+'.json'),receipt);
    const resultFile=await json(path.join(cwd,'prior','result-'+i+'.json'),{ref:'module:'+i,finding:'Prior effect '+i+' is complete.',candidate_answer:'prior report '.repeat(4000),uncertainty:'',
      hostEvidence:[{source:'host-dispatch-receipt',callId:'prior-'+i,tool:'relay_workspace',action:'read',success:true,sourceFile:receiptFile,result:receipt.result}],status:'worked_unverified'});
    runner.allRefs.push({ref:'module:'+i,path:resultFile,kind:'module'});
  }
  const step={id:'3',dir:'modules/3',file:path.join(runner.turnRoot,'modules/3/module.json'),objective:'Create final.txt exactly once.',dependsOn:['1','2'],doneWhen:'The file exists once.'};
  await json(step.file,step);await runner.workLeaves([step]);
  assert.deepEqual(effects,['write']);assert.equal(runner.stats.calls,1);
});

test('unknown capacity keeps complete text in its original phase instead of inventing a paging budget',async t=>{
  const cwd=await fixture(t),text='FULL_CONTEXT '.repeat(20000)+'UNKNOWN_CAPACITY_TAIL';let calls=0;
  const runner=new ShadowdancerDirectory({cwd,conversationId:'unknown',runId:'unknown-run',model:'fixture',runtime:{async runAgent(options){
    calls++;const payload=phase(options).payload;assert.equal(payload.source,text);assert.equal(payload.savedEvidence,undefined);
    return answer({answer:'Exact source retained',used_refs:[]});
  }}});
  await runner.open();await runner.infer('integration','integration/unknown',{task:'Inspect the saved context.',source:text,instructions:'Use exact saved text.',required_refs:[]});assert.equal(calls,1);
});

test('saved reads use remaining phase capacity and resume after actual native context compaction',async t=>{
  const cwd=await fixture(t),inputBudgetTokens=6000;let runner;
  runner=new ShadowdancerDirectory({cwd,conversationId:'read-budget',runId:'read-budget-run',model:'fixture',inputBudgetTokens,runtime:{async runAgent(options){
    const payload=phase(options).payload,baseline=estimateContextTokens([[options.prompt],options.dynamicTools,options.outputSchema]);
    options.onEvent({type:'context',context:{actualInputTokens:baseline,actualOutputTokens:0}});
    const call={name:'relay_directory_context',callId:'first',arguments:{action:'read',ref:payload.sourceRef}};
    const [first,parallel]=await Promise.all([options.onToolCall(call),options.onToolCall({...call,callId:'parallel'})]);assert.equal(first.success,true);
    assert.equal(parallel.success,false,'Parallel reads cannot each spend the same remaining input window');
    assert.ok(baseline+estimateContextTokens({name:call.name,arguments:call.arguments})+estimateContextTokens(first)<=inputBudgetTokens);
    const firstPage=textPage(first);assert.ok(firstPage.nextOffset>0);assert.ok(firstPage.end<firstPage.total);
    options.onEvent({type:'usage',usage:{last:{inputTokens:baseline,outputTokens:0},total:{inputTokens:baseline*2,outputTokens:0}}});
    options.onEvent({type:'context',context:{actualInputTokens:baseline,actualOutputTokens:0,lastCompaction:{id:'new-marker-with-stale-usage'}}});
    const exhausted=await options.onToolCall({...call,callId:'second',arguments:{...call.arguments,offset:firstPage.nextOffset}});
    assert.equal(exhausted.success,false,'A duplicate context measurement or new compaction marker cannot refund delivered reads');
    options.onEvent({type:'context',context:{actualInputTokens:1200,actualOutputTokens:0,lastCompaction:{id:'native-compaction'}}});
    const next=await options.onToolCall({...call,callId:'after-native-compaction',arguments:{...call.arguments,offset:firstPage.nextOffset}});
    assert.equal(next.success,true);assert.equal(textPage(next).offset,firstPage.nextOffset);
    return answer({answer:'Selected source pages were read in the active context.',used_refs:[]});
  }}});
  await runner.open();const source=await runner.evidenceStore.save('exact 😀 bytes '.repeat(10000),{kind:'source'});
  await runner.infer('integration','integration/read-budget',{task:'Read as needed.',sourceRef:source.ref,instructions:'Read saved source pages.',required_refs:[]});
});

test('atomic outcome review steers the same active work session and host blocks writes during response-only repair',async t=>{
  const cwd=await fixture(t),phases=[],effects=[];let reviews=0,assessment=null;
  const final='The file was created once and its exact contents were verified.';
  const result=await runShadowdancerDirectory({cwd,input:'/directory Create final.txt once and verify it.',conversationId:'atomic',runId:'atomic-run',model:'fixture',baseTools:[tool],supportsAtomicOutcomeReview:true,
    dispatchTool:async call=>{effects.push(call.arguments.action);return {success:true,contentItems:[{type:'inputText',text:call.arguments.action==='write'?'Written once':'Exact final contents'}]};},
    getCompletionAssessment:()=>assessment,getCompletionEvidence:()=>({records:effects.map((action,i)=>({id:'evidence-'+i,action}))}),
    onBeforeFinal:async candidate=>{
      reviews++;
      if(reviews===1){assert.equal(candidate.output,'Created final.txt.');assessment={decision:'continue',summary:'Read back the existing file.'};return {continue:true,prompt:'Read the existing final.txt; do not write it again.'};}
      if(reviews===2){assessment={decision:'revise_response',summary:'State the observed read-back clearly.'};return {continue:true,responseOnly:true,prompt:'Correct the response only.'};}
      assert.equal(candidate.output,final);assessment={decision:'respond',summary:'Exact observed effect and response match.'};return null;
    },
    runtime:{async runAgent(options){
      const current=phase(options);phases.push(current.label);
      if(current.label==='decompose')return answer({atomic:true});
      assert.equal(current.label,'work','No whole-result synthesis session is needed for a reviewed atomic worker');
      await options.onToolCall({name:'relay_workspace',callId:'one-write',arguments:{action:'write',path:'final.txt',text:'final'}});
      const first=await options.onBeforeFinal(answer(work('Created final.txt.')));assert.equal(first.continue,true);assert.match(first.prompt,/same active work session/);
      await options.onToolCall({name:'relay_workspace',callId:'read-back',arguments:{action:'read',path:'final.txt'}});
      const revision=await options.onBeforeFinal(answer(work('Verified the file.')));assert.equal(revision.responseOnly,true);
      const denied=await options.onToolCall({name:'relay_workspace',callId:'forbidden-repeat',arguments:{action:'write',path:'final.txt',text:'again'}});
      assert.equal(denied.success,false);assert.equal(denied.code,'DIRECTORY_RESPONSE_REVISION_READ_ONLY');
      const accepted=answer(work(final));assert.equal(await options.onBeforeFinal(accepted),null);return {...accepted,threadId:'same-active-worker'};
    }}});
  assert.deepEqual(phases,['decompose','work']);assert.deepEqual(effects,['write','read']);assert.equal(reviews,3);
  assert.equal(result.answer,final);assert.equal(result.atomicOutcomeAccepted,true);assert.equal(result.stats.completionAssessments,3);
  const stored=JSON.parse(await readFile(result.finalPath,'utf8'));assert.equal(stored.answerSha256,sha(final));assert.equal(stored.integrationAuthority,'host_outcome_review_of_active_worker');
  const checkpoint=JSON.parse(await readFile(path.join(result.root,'runs/atomic-run/modules/1/checkpoints/0003.json'),'utf8'));
  assert.equal(checkpoint.hostEvidence.length,2);assert.ok(checkpoint.hostEvidence.every(row=>row.source==='host-dispatch-receipt-reference'&&!Object.hasOwn(row,'result')));
  for(const row of checkpoint.hostEvidence){const saved=JSON.parse(await readFile(row.sourceFile,'utf8'));assert.equal(sha(JSON.stringify(saved)),row.sourceSha256);}
});

test('a provider cannot change an atomic candidate after host outcome acceptance',async t=>{
  const cwd=await fixture(t);let assessment=null;
  await assert.rejects(runShadowdancerDirectory({cwd,input:'/directory Complete one observed outcome.',conversationId:'changed',runId:'changed-run',model:'fixture',baseTools:[tool],supportsAtomicOutcomeReview:true,
    dispatchTool:async()=>({success:true,contentItems:[]}),getCompletionAssessment:()=>assessment,
    onBeforeFinal:async()=>{assessment={decision:'respond',summary:'Accepted exact candidate'};return null;},
    runtime:{async runAgent(options){if(phase(options).label==='decompose')return answer({atomic:true});
      assert.equal(await options.onBeforeFinal(answer(work('Accepted exact candidate'))),null);
      return answer(work('Different unreviewed candidate'));
    }}}),{code:'DIRECTORY_ATOMIC_CANDIDATE_CHANGED'});
});

test('Planning Off and other final controllers do not acquire atomic modular review capability from a getter',async t=>{
  const cwd=await fixture(t),phases=[];let reviews=0;
  const result=await runShadowdancerDirectory({cwd,input:'/directory Finish one bounded task.',conversationId:'nonmodular',runId:'nonmodular-run',model:'fixture',baseTools:[tool],
    supportsAtomicOutcomeReview:false,dispatchTool:async()=>({success:true,contentItems:[]}),getCompletionAssessment:()=>null,
    onBeforeFinal:async()=>{reviews++;return null;},runtime:{async runAgent(options){
      const current=phase(options);phases.push(current.label);
      if(current.label==='decompose')return answer({atomic:true});
      if(current.label==='work'){
        const candidate=answer(work('Bounded work finished.'));assert.equal(await options.onBeforeFinal(candidate),null);
        assert.equal(reviews,0,'Do not call another controller at the atomic checkpoint');return candidate;
      }
      assert.equal(current.label,'integration');return answer({answer:'Final bounded result.',used_refs:current.payload.required_refs});
    }}});
  assert.deepEqual(phases,['decompose','work','integration']);assert.equal(reviews,1);assert.equal(result.atomicOutcomeAccepted,undefined);
});

test('the disk index preserves JSON data keys including __proto__ exactly',async t=>{
  const cwd=await fixture(t),source=JSON.parse('{"records":[{"__proto__":{"retained":"exact source value"},"constructor":"ordinary data","prototype":[1,2]}]}');
  const runner=new ShadowdancerDirectory({cwd,conversationId:'json-keys',runId:'json-keys-run',model:'fixture',runtime:{runAgent:async()=>{throw Error('Indexing must not invoke a model');}}});
  const result=await createEvidenceWorkingSet({value:source,store:runner.evidenceStore,fits:()=>true});
  assert.equal(Object.hasOwn(result.context.records[0],'__proto__'),true);
  assert.deepEqual(result.context.records[0].__proto__,{retained:'exact source value'});
  assert.deepEqual(JSON.parse(await readFile(result.manifest.index.file,'utf8')),source);
  assert.equal(Object.getPrototypeOf(source.records[0]),Object.prototype);
});
