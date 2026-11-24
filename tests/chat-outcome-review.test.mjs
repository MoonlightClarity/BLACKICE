import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createChatOutcomeReviewer} from '../lib/chat-outcome-review.mjs';
import {strictProviderSchema} from '../lib/provider-output-schema.mjs';

const boundary='\nREVIEW DATA (JSON):\n';
const data=options=>JSON.parse(options.prompt.split(boundary).at(-1));
const response=(patch={})=>({decision:'respond',summary:'The requested result is supported.',remaining:[],nextAction:'',
  evidenceRefs:['user-request'],blockers:[],...patch});
const row=(id,result)=>({id,source:'admitted-tool-delivery',tool:'relay_workspace',action:'read',success:true,
  fullResultSha256:createHash('sha256').update(JSON.stringify(result)).digest('hex'),result});
const request=(input='Summarize the recorded output.',records=[])=>({input,candidate:{output:'The recorded output is ready.'},
  evidenceFingerprint:'canonical-state-1',pendingEffects:[],evidence:{source:'current-admitted-tool-receipts',total:records.length,omitted:0,records}});
async function fixture(t,respond,extra={}){
  const cwd=await mkdtemp(path.join(tmpdir(),'blackice-chat-outcome-')),calls=[],events=[],usage=[];
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const runtime={status:()=>({models:[{id:'fixture::same-model',contextWindowTokens:65536,maxOutputTokens:4096}]}),
    runAgent:async options=>{calls.push(options);return {output:JSON.stringify(await respond(options,calls.length)),usage:{inputTokens:10,outputTokens:3,totalTokens:13}};}};
  const authority={developerInstructions:'EXACT_WORKER_DEVELOPER\nUse the current user request and genuine evidence.',
    sections:[{id:'owner',role:'user',source:'owner-fixture',revision:3,text:'OWNER_STANDING_LIMIT\nDo not upload local notes.'}]};
  const reviewer=createChatOutcomeReviewer({runtime,cwd,model:'fixture::same-model',effort:'low',serviceTier:'fast',
    authority,auditRoot:path.join(cwd,'host-review'),onUpdate:event=>events.push(event),onUsage:value=>usage.push(value),...extra});
  return {reviewer,runtime,cwd,calls,events,usage,authority};
}

test('ordinary assessment preserves exact authority, model, effort, tier and current request without operational tools',async t=>{
  const input='Turn the existing notes into a brief summary. Do not upload them.';
  const record=row('current-receipt',{text:'The requested summary is saved.'});
  const f=await fixture(t,options=>{
    const seen=data(options);assert.equal(seen.snapshot.request,input);
    assert.equal(seen.snapshot.evidence.records[0].fullResultSha256,record.fullResultSha256);
    assert.equal(seen.snapshot.evidence.records[0].source,'admitted-tool-delivery');
    assert.deepEqual(seen.snapshot.evidence.records[0].result,record.result);
    return response({evidenceRefs:[seen.snapshot.evidence.records[0].citationRef]});
  });
  const result=await f.reviewer.assess(request(input,[record]));
  assert.equal(result.decision,'respond');assert.equal(result.verified,false);
  assert.deepEqual(result.evidenceRefs,['current-receipt']);
  assert.deepEqual(result.citationBindings,[{citationRef:'evidence-0001',evidenceId:'current-receipt'}]);
  assert.equal(f.calls.length,1);const o=f.calls[0];
  assert.equal(o.model,'fixture::same-model');assert.equal(o.effort,'low');assert.equal(o.serviceTier,'fast');
  assert.equal(o.developerInstructions,f.authority.developerInstructions);
  assert.ok(o.prompt.includes(f.authority.sections[0].text));assert.ok(o.prompt.includes('"role":"user"'));
  assert.equal(o.sandbox,'read-only');assert.equal(o.hostOnlyTools,true);assert.equal(o.responseOnly,true);
  assert.equal(o.threadId,undefined);assert.equal(o.continuity,undefined);assert.equal(o.onBeforeFinal,undefined);
  assert.deepEqual(o.dynamicTools||[],[]);assert.equal(o.onToolCall,undefined);
  assert.equal(f.usage.length,1);assert.ok(f.events.every(event=>event.verified===false));
  assert.doesNotMatch(JSON.stringify(f.events),/EXACT_WORKER_DEVELOPER|OWNER_STANDING_LIMIT/);
});

test('local MiniCPM reviewer uses a closed six-field wire grammar and still binds host evidence',async t=>{
  const receipt=row('local-source-read',{text:'The export is null.'});
  const f=await fixture(t,options=>{
    assert.equal(options.responseOnly,true);
    assert.equal(strictProviderSchema(options.outputSchema),true,'Local reviewer output must be grammar compatible.');
    assert.deepEqual(options.outputSchema.required,
      ['decision','summary','remaining','nextAction','evidenceRefs','blockers']);
    assert.equal(options.outputSchema.properties.concerns,undefined);
    assert.equal(options.outputSchema.properties.outcomeChecks,undefined);
    assert.match(options.prompt,/BLACKICE LOCAL OUTCOME REVIEW/);
    assert.match(options.prompt,/A syntax check is not a file read/);
    assert.doesNotMatch(options.prompt,/BLACKICE ORDINARY TASK OUTCOME REVIEW/);
    return response({summary:'The saved read showed that the export is null.',evidenceRefs:['evidence-0001']});
  },{model:'local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S'});
  const result=await f.reviewer.assess(request('Report the export value.',[receipt]));
  assert.equal(result.decision,'respond');
  assert.deepEqual(result.evidenceRefs,['local-source-read']);
  assert.equal(result.verified,false,'Structured syntax is not independent effect verification.');
});

test('content, history and prepare-only requests do not require invented external work',async t=>{
  const f=await fixture(t,()=>response());
  for(const input of ['Explain the supplied calculation.','Report when the earlier export finished. Do not create one.','Prepare the note. Do not send it.']){
    assert.equal((await f.reviewer.assess(request(input))).decision,'respond');
    assert.equal(data(f.calls.at(-1)).snapshot.request,input);
    assert.match(f.calls.at(-1).prompt,/content-only, existing-state, history and prepare-only/);
  }
  assert.ok(f.calls.every(options=>!options.dynamicTools?.length));
});

test('local failure can continue an independent route while grounded fixed-target blockage stays incomplete',async t=>{
  const f=await fixture(t,(_options,index)=>index===1
    ?response({decision:'continue',summary:'One route failed; a permitted alternative remains.',remaining:['The requested result'],nextAction:'Inspect the alternate route.',evidenceRefs:['evidence-0001']})
    :response({decision:'blocked',summary:'The only requested source explicitly denies access.',remaining:['Read the fixed source'],evidenceRefs:['evidence-0001'],
      blockers:[{scope:'The fixed source',whyNotRepairable:'The recorded access denial applies to the only source permitted by the user.',evidenceRefs:['evidence-0001']}]}));
  const first=await f.reviewer.assess(request('Find one usable source.',[row('denial',{status:403})]));
  assert.equal(first.decision,'continue');assert.match(first.nextAction,/alternate route/);
  const second=await f.reviewer.assess(request('Read only this source. Do not use alternatives.',[row('denial',{status:403})]));
  assert.equal(second.decision,'blocked');assert.equal(second.verified,false);
  assert.deepEqual(second.blockers[0].evidenceRefs,['denial']);
});

test('unknown effects remain explicit evidence and an ungrounded blocker cannot become an accepted outcome',async t=>{
  const f=await fixture(t,options=>{
    assert.deepEqual(data(options).snapshot.scope.pendingEffects,[{callId:'uncertain-write',state:'outcome-unresolved'}]);
    return response({decision:'blocked',remaining:['Reconcile prior delivery'],blockers:[]});
  });
  const r=request('Verify the earlier operation.',[row('uncertain-write',{status:'unknown'})]);
  r.pendingEffects=[{callId:'uncertain-write',state:'outcome-unresolved'}];
  const result=await f.reviewer.assess(r);
  assert.equal(result.decision,'continue');assert.match(result.nextAction,/Inspect/);
  assert.equal(f.calls[0].onToolCall,undefined,'assessment itself cannot replay the uncertain write');
});

test('invalid references receive bounded review-only repair then explicit unreviewed status',async t=>{
  const f=await fixture(t,()=>response({evidenceRefs:['invented-business-receipt']}));
  const result=await f.reviewer.assess(request('Report the current result.',[row('actual',{text:'Actual receipt'})]));
  assert.equal(result.decision,'unreviewed');assert.equal(f.calls.length,3);
  assert.equal(result.reason,'MODULAR_REVIEW_EVIDENCE');
  assert.ok(f.calls.every(options=>!options.dynamicTools?.length));
  assert.equal(f.events.filter(event=>event.status==='validated').length,0);
  assert.equal(f.events.at(-1).status,'unreviewed');
});

test('schema-constrained local reviewer cannot certify success with an empty final summary',async t=>{
  const f=await fixture(t,()=>response({summary:''}),{model:'local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S'});
  const result=await f.reviewer.assess(request('Report the observed result.',[row('read',{text:'Actual value'})]));
  assert.equal(result.decision,'unreviewed');assert.equal(result.reason,'MODULAR_REVIEW_INVALID');
  assert.equal(f.calls.length,3,'Format repair is bounded.');
  assert.equal(f.events.some(event=>event.status==='validated'),false);
});

test('missing evidence or unresolved default model never silently selects another reviewer',async t=>{
  const f=await fixture(t,()=>assert.fail('No model may run with incomplete admitted evidence.'));
  const r=request();r.evidence.omitted=1;
  assert.equal((await f.reviewer.assess(r)).reason,'CHAT_OUTCOME_EVIDENCE_INCOMPLETE');
  const absent=createChatOutcomeReviewer({runtime:f.runtime,cwd:f.cwd,model:'default',authority:f.authority});
  assert.equal((await absent.assess(request())).reason,'CHAT_OUTCOME_AUTHORITY_UNAVAILABLE');
  assert.equal(f.calls.length,0);
});

test('report correction uses isolated read-only synthesis and re-assessment, never a worker continuation',async t=>{
  const corrected='The requested file was saved; no upload was performed.';
  const f=await fixture(t,(options,index)=>{
    if(index===1)return response({decision:'revise_response',summary:'The report denies a recorded save.',nextAction:'Correct the report from the saved receipt.',evidenceRefs:['evidence-0001']});
    if(index===2){assert.match(options.prompt,/READ-ONLY REPORT SYNTHESIS/);return response({summary:corrected,evidenceRefs:['evidence-0001']});}
    assert.equal(data(options).candidate.output,corrected);
    return response({summary:'The corrected report matches the completed save.',evidenceRefs:['evidence-0001']});
  });
  const result=await f.reviewer.assess(request('Save the note locally. Do not upload it.',[row('saved',{path:'note.txt',saved:true})]));
  assert.equal(result.decision,'respond');assert.equal(result.replacementOutput,corrected);assert.equal(f.calls.length,3);
  assert.ok(f.calls.every(options=>options.hostOnlyTools&&options.sandbox==='read-only'&&!options.dynamicTools?.length&&!options.onBeforeFinal));
  assert.ok(f.calls.every(options=>options.model==='fixture::same-model'&&options.effort==='low'&&options.developerInstructions===f.authority.developerInstructions));
  assert.deepEqual(f.events.filter(event=>event.status==='validated').map(event=>event.phase),['assessment','report-synthesis','report-reassessment']);
  assert.doesNotMatch(JSON.stringify(f.events.filter(event=>event.phase==='report-synthesis')),/The requested file was saved/,'draft is not emitted before re-assessment');
  assert.equal(f.usage.length,3);
});

test('local compact reviewer preserves report-only correction and independent reassessment',async t=>{
  const corrected='The saved record contains the expected result.';
  const f=await fixture(t,(options,index)=>{
    assert.equal(strictProviderSchema(options.outputSchema),true);
    if(index===1)return response({decision:'revise_response',summary:'Candidate report is wrong.',
      nextAction:'Rewrite the report.',evidenceRefs:['evidence-0001']});
    if(index===2){assert.match(options.prompt,/READ-ONLY REPORT SYNTHESIS/);
      return response({summary:corrected,evidenceRefs:['evidence-0001']});}
    assert.equal(data(options).candidate.output,corrected);
    return response({summary:'The corrected report is supported.',evidenceRefs:['evidence-0001']});
  },{model:'local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S'});
  const result=await f.reviewer.assess(request('Report the saved result.',[row('receipt',{status:'saved'})]));
  assert.equal(result.decision,'respond');assert.equal(result.replacementOutput,corrected);
  assert.equal(f.calls.length,3);
  assert.ok(f.calls.every(options=>options.sandbox==='read-only' && options.hostOnlyTools===true));
});

test('report-only repair remains finite and does not publish an unaccepted draft',async t=>{
  const f=await fixture(t,(_options,index)=>index===2
    ?response({summary:'Draft correction.'})
    :response({decision:'revise_response',summary:'Report still needs correction.',nextAction:'Correct the report.'}));
  await assert.rejects(f.reviewer.assess(request()),{code:'CHAT_OUTCOME_STALLED'});
  assert.equal(f.calls.length,3);assert.equal(f.events.at(-1).status,'stalled');
});

test('candidate cancellation and admission changes stop nested work rather than grant completion',async t=>{
  const outer=new AbortController(),candidate=new AbortController();
  const f=await fixture(t,async options=>{
    candidate.abort();assert.equal(options.signal.aborted,true);return response();
  },{signal:outer.signal});
  await assert.rejects(f.reviewer.assess({...request(),candidate:{output:'Candidate',signal:candidate.signal}}),{code:'ABORT_ERR'});
  assert.equal(outer.signal.aborted,false);assert.equal(f.events.some(event=>event.status==='validated'),false);
  let admitted=true;
  const g=await fixture(t,()=>{admitted=false;return response();},{canContinue:()=>admitted});
  await assert.rejects(g.reviewer.assess(request()),{code:'CHAT_OUTCOME_INTERRUPTED'});
  assert.equal(g.events.some(event=>event.status==='validated'),false);
});

test('large receipts have host-only exact-reference reads and model JSON cannot forge inspection',async t=>{
  const record=row('large-current-result',{text:'The current report is available. '+ 'x'.repeat(300000)});
  const f=await fixture(t,options=>{
    const s=data(options).snapshot;
    assert.equal(s.savedReview.mode,'indexed-exact-sources');
    assert.equal(options.dynamicTools.length,1);assert.equal(options.dynamicTools[0].name,'relay_directory_context');
    assert.equal(options.responseOnly,false);
    return response({evidenceRefs:['evidence-0001'],metadataOnlyRefs:[],
      evidenceInspection:{inlineEvidenceIds:['large-current-result'],reads:[{evidenceIds:['large-current-result'],field:'result'}]}});
  });
  const rejected=await f.reviewer.assess(request('Report what the current receipt says.',[record]));
  assert.equal(rejected.decision,'unreviewed');assert.equal(f.calls.length,3);
  const g=await fixture(t,async options=>{
    const s=data(options).snapshot,ref=s.evidence.records[0].savedSource.ref;
    const denied=await options.onToolCall({name:'relay_browser',arguments:{action:'click',ref:'send'}});
    assert.equal(denied.success,false);assert.equal(denied.code,'MODULAR_REVIEW_READ_ONLY');
    const wrong=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:'arbitrary-file'}});
    assert.equal(wrong.success,false);
    const receipt=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref,offset:0,limit:4096}});
    assert.equal(receipt.success,true,JSON.stringify(receipt));
    return response({evidenceRefs:['evidence-0001'],metadataOnlyRefs:[]});
  });
  const accepted=await g.reviewer.assess(request('Report the observed opening text of this receipt.',[record]));
  assert.equal(accepted.decision,'respond');assert.equal(accepted.evidenceInspection.source,'host-observed-evidence-access');
  assert.ok(accepted.evidenceInspection.reads.some(read=>read.evidenceIds.includes(record.id)&&read.field==='result'));
  assert.equal(g.calls.length,1);assert.ok(g.events.every(event=>event.verified===false));
});


test('contradictory local respond verdict is repaired in the reviewer, not coerced into operational continuation',async t=>{
  const receipt=row('exact-match',{text:'The observed result is available.'});
  const f=await fixture(t,(options,index)=>{
    if(index===1)return response({decision:'respond',summary:'The evidence supports the result.',
      remaining:['Identify the result already returned by the tool'],nextAction:'Respond with the verified result.',evidenceRefs:['evidence-0001']});
    assert.match(options.prompt,/respond requires remaining/);
    assert.match(options.prompt,/Do not list satisfied requirements as remaining/);
    return response({decision:'respond',summary:'The result is supported.',evidenceRefs:['evidence-0001']});
  },{model:'local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S'});
  const result=await f.reviewer.assess(request('Report the observed result.',[receipt]));
  assert.equal(result.decision,'respond');
  assert.deepEqual(result.remaining,[]);
  assert.equal(result.nextAction,'');
  assert.equal(f.calls.length,2);
  assert.equal(f.events.filter(event=>event.status==='repairing').length,1);
  assert.equal(f.events.filter(event=>event.status==='validated').length,1);
  assert.ok(f.calls.every(call=>call.hostOnlyTools&&call.sandbox==='read-only'&&!call.onBeforeFinal));
});

test('persistent contradictory respond verdict is unreviewed, not a fabricated task-action instruction',async t=>{
  const f=await fixture(t,()=>response({decision:'respond',remaining:[],nextAction:'Repeat the existing read.',evidenceRefs:['evidence-0001']}),
    {model:'local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S'});
  const result=await f.reviewer.assess(request('Report the observed result.',[row('read',{text:'Existing result'})]));
  assert.equal(result.decision,'unreviewed');
  assert.equal(result.reason,'MODULAR_REVIEW_INVALID');
  assert.equal(f.calls.length,3);
  assert.equal(f.events.filter(event=>event.status==='validated').length,0);
});


test('review distinguishes authorship from transport role and retains owner constraints while omitting redundant worker methods',async t=>{
  const authority={developerInstructions:'Exact developer constraints.',sections:[
    {id:'owner',role:'user',origin:'owner-skill',source:'Owner skill: custom',text:'OWNER_EXACT_REQUIREMENT'},
    {id:'workflow',role:'user',origin:'workflow',source:'workflow node',text:'WORKFLOW_DEFAULT'},
    {id:'runtime',role:'user',origin:'host-runtime',source:'lib/engine.mjs',text:'HOST_CAPABILITY_BOUNDARY'},
    {id:'bundled',role:'user',origin:'bundled-skill',reviewAudience:'worker',source:'Bundled skill: method',text:'WORKER_ONLY_BUNDLED_METHOD'},
    {id:'duplicate',role:'user',origin:'host-runtime',reviewAudience:'worker',source:'lib/engine.mjs',text:'WORKER_ONLY_DUPLICATE'}
  ]};
  const f=await fixture(t,options=>{
    assert.ok(options.prompt.indexOf('CURRENT TASK REQUEST')<options.prompt.indexOf('OWNER_EXACT_REQUIREMENT'));
    assert.match(options.prompt,/DELIVERED USER INSTRUCTION .*"origin":"owner-skill"/);
    assert.match(options.prompt,/OWNER_EXACT_REQUIREMENT/);
    assert.match(options.prompt,/DELIVERED WORKFLOW INSTRUCTIONS .*"origin":"workflow"/);
    assert.match(options.prompt,/DELIVERED HOST RUNTIME GUIDANCE .*"origin":"host-runtime"/);
    assert.match(options.prompt,/HOST_CAPABILITY_BOUNDARY/);
    assert.doesNotMatch(options.prompt,/WORKER_ONLY_BUNDLED_METHOD|WORKER_ONLY_DUPLICATE/);
    assert.equal(options.developerInstructions,authority.developerInstructions);
    return response();
  },{model:'local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S',authority});
  const result=await f.reviewer.assess(request('Exact current task.'));
  assert.equal(result.decision,'respond');
  const start=f.events.find(e=>e.status==='started');
  assert.equal(start.authorityIdentities.length,5,'Audit preserves all delivered instruction sources.');
  assert.ok(start.authorityIdentities.some(s=>s.origin==='bundled-skill'&&s.reviewAudience==='worker'));
});


test('affirmative ordinary review cannot use the request alone as proof of an admitted tool result',async t=>{
  const receipt={...row('current-read',{text:'Observed source content.'}),callId:'current-read'};
  const f=await fixture(t,(options,index)=>{
    if(index===1)return response({summary:'The source was inspected.',evidenceRefs:['user-request']});
    assert.match(options.prompt,/missingResultCitation/);
    assert.match(options.prompt,/Correct the review using the existing receipts/);
    return response({summary:'The admitted receipt records the observation.',evidenceRefs:['evidence-0001']});
  },{model:'local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S'});
  const result=await f.reviewer.assess(request('Report the observed source content.',[receipt]));
  assert.equal(result.decision,'respond');
  assert.deepEqual(result.evidenceRefs,['current-read']);
  assert.equal(f.calls.length,2);
  assert.ok(f.events.some(event=>event.status==='repairing'&&event.validation?.missingResultCitation));
});

test('an affirmative assessment with unresolved blockers is repaired rather than accepted',async t=>{
  const f=await fixture(t,(options,index)=>{
    if(index===1)return response({blockers:[{scope:'current result',evidenceRefs:['user-request'],whyNotRepairable:'Still missing'}]});
    assert.match(options.prompt,/respond requires remaining/);
    assert.match(options.prompt,/blockers: \[\]/);
    return response();
  });
  assert.equal((await f.reviewer.assess(request('Answer the supplied question.'))).decision,'respond');
  assert.equal(f.calls.length,2);
});
