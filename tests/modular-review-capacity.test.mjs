import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {reviewModularOutcome,createModularCompletionController} from '../lib/modular-completion.mjs';
import {directoryContextConfiguration} from '../lib/directory-conversation-scope.mjs';
import {estimateContextTokens} from '../lib/context.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';

const policy={version:2,modules:{inference:true,feasibility:true,decomposition:true,branching:true,replanning:true,metacognition:true,anti_overalignment:true,verification:true,subagents:true}};
const model={id:'fixture',supportsTools:true,contextWindowTokens:258400,runtimeDefaultContextWindowTokens:272000,maxContextWindowTokens:872000,effectiveContextWindowPercent:95};
const assessment={decision:'respond',summary:'The requested content-only answer is complete.',remaining:[],nextAction:'',evidenceRefs:['user-request'],blockers:[]};

test('outcome review forwards the exact configured context into a fresh tool-free session',async()=>{
  const context={preset:'custom',windowTokens:42000,outputReserveTokens:2000,headroomTokens:1000},calls=[];
  const result=await reviewModularOutcome({runtime:{async runAgent(options){calls.push(options);return {output:JSON.stringify(assessment)};}},
    cwd:os.tmpdir(),model:'fixture',context,snapshot:{request:{id:'user-request',text:'Say ready'},evidence:{records:[]}},candidate:{output:'Ready'}});
  assert.deepEqual(result,assessment);assert.equal(calls.length,1);
  assert.deepEqual(calls[0].context,context);assert.equal(calls[0].responseOnly,true);assert.equal(calls[0].sandbox,'read-only');
  assert.equal(calls[0].threadId,undefined);assert.equal(calls[0].continuity,undefined);assert.equal(calls[0].dynamicTools,undefined);assert.equal(calls[0].onToolCall,undefined);
});

class Runtime extends EventEmitter {
  calls=[];
  status(){return {connected:true,authenticated:true,defaultModel:'fixture',models:[model]};}
  async start(){return this.status();}
  async close(){}
  async runAgent(options){
    this.calls.push(options);
    if(options.prompt.startsWith('BLACKICE MODULAR OUTCOME REVIEW.'))return {output:JSON.stringify(assessment)};
    const marker='CURRENT_DIRECTORY:\n',index=options.prompt.indexOf(marker);
    if(index>=0){
      const {label,payload}=JSON.parse(options.prompt.slice(index+marker.length));
      if(label==='decompose')return {output:'{"atomic":true}'};
      if(label==='integration')return {output:JSON.stringify({answer:'Ready',used_refs:payload.required_refs})};
      return {output:JSON.stringify({status:'complete',nextAction:'',finding:'Answered the content-only request.',candidate_answer:'Ready',uncertainty:''})};
    }
    const candidate={output:'Ready'};
    if(options.onBeforeFinal)assert.equal((await options.onBeforeFinal(candidate))??null,null);
    return candidate;
  }
}

test('engine completion review keeps Directory extended capacity and ordinary Chat authored capacity',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'modular-review-window-')),runtime=new Runtime();
  const app=await createHarnessServer({runtime,port:0,dataDir:path.join(root,'data'),defaultCwd:path.join(root,'workspace')});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  await app.learning.updateSettings({mode:'manual'});
  const authored={preset:'custom',windowTokens:36000,outputReserveTokens:2000,headroomTokens:1000};
  for(const directoryMode of ['on','off']){
    const context=directoryMode==='on'?{preset:'model'}:authored;
    const workflow={name:'Review context fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture',prompt:'Answer the current request.',context},{id:'output',type:'output'}],
      edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'ontology',planningOntology:policy}};
    const start=runtime.calls.length,run=app.engine.startRun({workflow,input:{task:'Reply with Ready.',directoryMode,subagentsMode:'off',planningMode:'ontology',planningOntology:policy}});
    await app.engine.executions.get(run.id);
    const saved=app.engine.getRun(run.id);
    assert.equal(saved.status,'completed',saved.error);
    const reviews=runtime.calls.slice(start).filter(call=>call.prompt.startsWith('BLACKICE MODULAR OUTCOME REVIEW.'));
    assert.equal(reviews.length,1);
    if(directoryMode==='on'){
      assert.deepEqual(reviews[0].context,directoryContextConfiguration({model,context}).options);
      assert.equal(reviews[0].context.preset,'extended');
      assert.equal(reviews[0].context.compactAtTokens,812016);
    }else{
      assert.deepEqual(reviews[0].context,saved.workflow.nodes.find(node=>node.id==='agent').context);
      assert.equal(reviews[0].context.windowTokens,36000);assert.equal(reviews[0].context.preset,'custom');
    }
  }
});

test('large review indexes exact sources, repairs an unread valid citation, and reads only its needed receipt',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'modular-disk-review-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const content='Submission accepted: ACCEPT-EXACT-9. '+('saved observed data 😀 '.repeat(22000))+' RECEIPT_TAIL';
  const rows=Array.from({length:3},(_,index)=>({id:'owned-operation-'+index,source:'host-dispatch-receipt',tool:'relay_browser',action:'read',status:'completed',success:true,
    result:{success:true,contentItems:[{type:'inputText',text:index===0?content:'Other observed source '+index}]}}));
  const snapshot={request:{id:'user-request',text:'Report the verified receipt for the first submission.'},policy,evidence:{auditRoot:path.join(cwd,'receipts'),records:rows,total:rows.length,omitted:0}};
  const candidate={output:'The first submission was accepted with receipt ACCEPT-EXACT-9.'},context={preset:'custom',windowTokens:12000,outputReserveTokens:1000,headroomTokens:1000};
  const calls=[],updates=[],usage=[];let returns=0;
  const runtime={status:()=>({models:[{id:'fixture',contextWindowTokens:12000}]}),async runAgent(options){
    calls.push(options);assert.ok(options.prompt.startsWith('BLACKICE MODULAR OUTCOME REVIEW.'),'No eager page summarization calls');
    assert.equal(options.hostOnlyTools,true);assert.equal(options.responseOnly,false);assert.equal(options.sandbox,'read-only');
    assert.equal(options.threadId,undefined);assert.equal(options.continuity,undefined);
    assert.deepEqual(options.dynamicTools.map(tool=>tool.name),['relay_directory_context']);
    const base=estimateContextTokens([[options.prompt],options.dynamicTools,options.outputSchema]);assert.ok(base<10000);
    const packet=JSON.parse(options.prompt.split('\n\n').find(part=>part.startsWith('{"snapshot":')));
    assert.equal(packet.snapshot.savedReview.mode,'indexed-exact-sources');assert.equal(packet.snapshot.evidence.records.length,3);
    assert.equal(options.prompt.includes(content),false);assert.match(options.prompt,/index is host metadata/);
    const original=packet.snapshot.savedReview.original,bytes=await readFile(original.file,'utf8');
    assert.equal(createHash('sha256').update(bytes).digest('hex'),original.sha256);assert.deepEqual(JSON.parse(bytes),{snapshot,candidate});
    const first=packet.snapshot.evidence.records[0];
    if(calls.length===2){
      assert.match(options.prompt,/uninspectedReferences/);
      const forbidden=await options.onToolCall({name:'relay_browser',arguments:{action:'click'}});assert.equal(forbidden.code,'MODULAR_REVIEW_READ_ONLY');
      let consumed=0;
      for(const args of [{action:'read',ref:first.savedSource.ref,limit:1800},{action:'read',ref:first.savedSource.ref,offset:null,limit:200}]){
        if(args.offset===null)args.offset=runtime.total-200;
        const receipt=await options.onToolCall({name:'relay_directory_context',arguments:args});
        assert.equal(receipt.success,true);consumed+=estimateContextTokens({name:'relay_directory_context',arguments:args})+estimateContextTokens(receipt);
        assert.ok(base+consumed<=10000,'Reads share remaining input capacity with the full prompt and preceding reads');
        const page=JSON.parse(receipt.contentItems[0].text);runtime.total=page.total;assert.equal(page.complete,false);
        if(args.offset===undefined){assert.match(page.text,/ACCEPT-EXACT-9/);assert.notEqual(page.nextOffset,null);}else assert.match(page.text,/RECEIPT_TAIL/);
      }
    }else assert.equal(calls.length,1,'Only bounded review repair may open another reviewer');
    options.onEvent({type:'usage',usage:{total:{inputTokens:400000},last:{inputTokens:6000,outputTokens:200},modelContextWindow:12000}});
    return {output:JSON.stringify({...assessment,evidenceRefs:[first.citationRef],metadataOnlyRefs:[]}),usage:{inputTokens:500000,total:{inputTokens:500000},last:{inputTokens:4200,outputTokens:100},modelContextWindow:12000}};
  }};
  const controller=createModularCompletionController({policy,getSnapshot:()=>snapshot,onReturn:()=>returns++,onUpdate:row=>updates.push(row),
    review:args=>reviewModularOutcome({runtime,cwd,model:'fixture',context,...args,onUsage:row=>usage.push(row)})});
  assert.equal(await controller.beforeFinal(candidate),null);assert.equal(returns,0);assert.equal(calls.length,2);
  const rejected=updates.find(row=>row.status==='rejected-repairing');assert.deepEqual(rejected.validation.uninspectedReferences,['evidence-0001']);
  const accepted=(await controller.assertReady()).assessment;assert.deepEqual(accepted.evidenceRefs,['owned-operation-0']);
  assert.deepEqual(accepted.evidenceInspection.inlineEvidenceIds,[]);assert.equal(accepted.evidenceInspection.indexedRecords,3);
  assert.deepEqual([...new Set(accepted.evidenceInspection.reads.flatMap(read=>read.evidenceIds))],['owned-operation-0']);
  assert.ok(accepted.evidenceInspection.reads.every(read=>read.completeSource===false));
  assert.equal(usage.at(-1).inputTokens,500000);assert.equal(usage.at(-1).last.inputTokens,4200);assert.equal(usage.at(-1).modelContextWindow,12000);
  assert.equal(usage.at(-1).reviewContext.peakInputTokens,6000);assert.equal(usage.at(-1).reviewContext.lastInputTokens,4200);
  assert.deepEqual(usage.at(-1).reviewContext.reportedModelWindows,[12000]);
});

test('indexed metadata counts can be cited without claiming receipt contents were inspected',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'modular-index-count-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const snapshot={request:{id:'user-request',text:'How many tool calls are recorded?'},policy,evidence:{auditRoot:path.join(cwd,'receipts'),records:[
    {id:'only-call',source:'host-dispatch-receipt',tool:'relay_workspace',action:'read',success:true,result:{contentItems:[{type:'inputText',text:'data '.repeat(40000)}]}}]}};
  const context={preset:'custom',windowTokens:12000,outputReserveTokens:1000,headroomTokens:1000};
  const controller=createModularCompletionController({policy,getSnapshot:()=>snapshot,review:args=>reviewModularOutcome({cwd,model:'fixture',context,...args,
    runtime:{async runAgent(options){assert.ok(options.dynamicTools);return {output:JSON.stringify({...assessment,summary:'There is one recorded tool call.',evidenceRefs:['evidence-0001'],metadataOnlyRefs:['evidence-0001']})};}}})});
  assert.equal(await controller.beforeFinal({output:'One tool call is recorded.'}),null);
  const result=await controller.assertReady();assert.deepEqual(result.assessment.metadataOnlyRefs,['only-call']);assert.deepEqual(result.assessment.evidenceInspection.reads,[]);
});

test('an ID-only index requires an actual metadata read before accepting metadata-only citations',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'modular-id-index-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const records=Array.from({length:16},(_,index)=>({id:'indexed-call-'+index,source:'host-dispatch-receipt',tool:'relay_workspace',action:'read',success:true,
    target:index===0?'first-source.json':'recorded-location/'.repeat(160),result:{contentItems:[{type:'inputText',text:'observed '.repeat(12000)}]}}));
  const snapshot={request:{id:'user-request',text:'Which action was recorded for the first call?'},policy,evidence:{auditRoot:path.join(cwd,'receipts'),records}};
  const context={preset:'custom',windowTokens:12000,outputReserveTokens:1000,headroomTokens:1000},updates=[];let attempts=0;
  const controller=createModularCompletionController({policy,getSnapshot:()=>snapshot,onUpdate:row=>updates.push(row),review:args=>reviewModularOutcome({cwd,model:'fixture',context,...args,
    runtime:{async runAgent(options){
      attempts++;
      const packet=JSON.parse(options.prompt.split('\n\n').find(part=>part.startsWith('{"snapshot":')));
      assert.deepEqual(Object.keys(packet.snapshot.evidence.records[0]),['id','citationRef']);
      assert.match(options.prompt,/partial read exposes only its returned range/);
      if(attempts===2){
        assert.match(options.prompt,/uninspectedReferences/);
        const receipt=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:packet.snapshot.savedReview.index.ref,limit:1000}});
        assert.equal(receipt.success,true);const page=JSON.parse(receipt.contentItems[0].text);
        assert.match(page.text,/"id":"indexed-call-0"/);assert.match(page.text,/"action":"read"/);assert.equal(page.complete,false);
      }
      return {output:JSON.stringify({...assessment,summary:'The first recorded action is read.',evidenceRefs:['evidence-0001'],metadataOnlyRefs:['evidence-0001']})};
    }}})});
  assert.equal(await controller.beforeFinal({output:'The first recorded action is read.'}),null);assert.equal(attempts,2);
  const rejected=updates.find(row=>row.status==='rejected-repairing');
  assert.deepEqual(rejected.validation.uninspectedReferences,['evidence-0001']);assert.deepEqual(rejected.evidenceInspection.inlineMetadataIds,[]);
  const accepted=(await controller.assertReady()).assessment;
  assert.deepEqual(accepted.metadataOnlyRefs,['indexed-call-0']);assert.deepEqual(accepted.evidenceInspection.inlineMetadataIds,[]);
  assert.deepEqual(accepted.evidenceInspection.reads.map(row=>({field:row.field,evidenceIds:row.evidenceIds,completeSource:row.completeSource})),[
    {field:'metadata',evidenceIds:['indexed-call-0'],completeSource:false},
  ]);
});

test('review reads share capacity and duplicate context notifications cannot refund delivered bytes',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'modular-read-budget-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const snapshot={request:{id:'user-request',text:'Inspect the recorded data as needed.'},policy,evidence:{auditRoot:path.join(cwd,'receipts'),records:[
    {id:'budget-call',source:'host-dispatch-receipt',tool:'relay_workspace',action:'read',success:true,result:{contentItems:[{type:'inputText',text:'observed-data '.repeat(30000)}]}}]}};
  const context={preset:'custom',windowTokens:12000,outputReserveTokens:1000,headroomTokens:1000},usage=[];
  await reviewModularOutcome({cwd,model:'fixture',context,snapshot,candidate:{output:'The recorded data is available.'},onUsage:value=>usage.push(value),
    runtime:{async runAgent(options){
      const packet=JSON.parse(options.prompt.split('\n\n').find(part=>part.startsWith('{"snapshot":'))),ref=packet.snapshot.evidence.records[0].savedSource.ref;
      options.onEvent({type:'usage',usage:{last:{inputTokens:9300,outputTokens:0},total:{inputTokens:9300},modelContextWindow:12000}});
      const call={name:'relay_directory_context',arguments:{action:'read',ref,limit:100000}};
      const replies=await Promise.all([options.onToolCall(call),options.onToolCall(call)]);
      assert.equal(replies[0].success,true);assert.equal(replies[1].success,false,'Parallel reads cannot each spend the same remaining capacity');
      assert.ok(estimateContextTokens(call)+estimateContextTokens(replies[0])<=700);
      const firstPage=JSON.parse(replies[0].contentItems[0].text);
      options.onEvent({type:'context',context:{actualInputTokens:9300,actualOutputTokens:0,compactionCount:1,lastCompaction:{id:'compaction-with-stale-usage'},remainingTokens:700,remainingIsEstimate:true}});
      assert.equal((await options.onToolCall(call)).success,false,'A compaction marker with unchanged actual usage cannot refund earlier replies');
      options.onEvent({type:'usage',usage:{last:{inputTokens:9300,outputTokens:0},total:{inputTokens:18600},modelContextWindow:12000}});
      assert.equal((await options.onToolCall(call)).success,false,'Repeated actual values cannot refund capacity through a different event or cumulative total');
      options.onEvent({type:'context',context:{actualInputTokens:3000,actualOutputTokens:0,compactionCount:1,lastCompaction:{id:'compaction-with-stale-usage'},remainingTokens:0,remainingIsEstimate:true}});
      const replenished=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref,offset:firstPage.end,limit:10000}});
      assert.equal(replenished.success,true,'A genuinely smaller measured context restores capacity despite a stale remaining estimate');
      const nextPage=JSON.parse(replenished.contentItems[0].text);assert.equal(nextPage.offset,firstPage.end);assert.equal(nextPage.end-nextPage.offset,10000);
      return {output:JSON.stringify({...assessment,metadataOnlyRefs:[]})};
    }}});
  assert.equal(usage[0].reviewContext.peakInputTokens,9300);assert.equal(usage[0].reviewContext.lastInputTokens,3000);
  assert.equal(usage[0].reviewContext.compactionCount,1);
});

test('the real API provider transports the isolated evidence-read tool and its saved receipt reply',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'modular-provider-read-')),requests=[];
  const codex=new EventEmitter();codex.status=()=>({connected:false,authenticated:false,models:[]});codex.close=async()=>{};
  const runtime=await new ProviderRuntime({dataDir:path.join(cwd,'data'),codex,fetchImpl:async(url,options={})=>{
    if(options.method==='GET')return new Response(JSON.stringify({data:[{id:'fixture-model'}]}),{headers:{'content-type':'application/json'}});
    const body=JSON.parse(options.body);requests.push(body);
    assert.deepEqual(body.tools.map(tool=>tool.function.name),['relay_directory_context']);
    if(requests.length===1){
      const prompt=body.messages.find(message=>message.role==='user').content;
      const packet=JSON.parse(prompt.split('\n\n').find(part=>part.startsWith('{"snapshot":'))),ref=packet.snapshot.evidence.records[0].savedSource.ref;
      return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'read-exact-receipt',type:'function',function:{name:'relay_directory_context',arguments:JSON.stringify({action:'read',ref,limit:2500})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:3200,completion_tokens:40}}),{headers:{'content-type':'application/json'}});
    }
    assert.equal(requests.length,2);assert.match(JSON.stringify(body.messages.find(message=>message.role==='tool')),/API-SAVED-ACCEPTANCE-17/);
    return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({...assessment,evidenceRefs:['evidence-0001'],metadataOnlyRefs:[]})},finish_reason:'stop'}],usage:{prompt_tokens:4100,completion_tokens:70}}),{headers:{'content-type':'application/json'}});
  }}).init();
  t.after(async()=>{await runtime.close();await rm(cwd,{recursive:true,force:true});});
  await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic-test-key',models:[{id:'fixture-model',supportsTools:true}]});
  const snapshot={request:{id:'user-request',text:'Report the recorded acceptance.'},policy,evidence:{auditRoot:path.join(cwd,'receipts'),records:[
    {id:'api-operation',source:'host-dispatch-receipt',tool:'relay_browser',action:'read',success:true,result:{success:true,contentItems:[{type:'inputText',text:'API-SAVED-ACCEPTANCE-17 '+('observed text '.repeat(30000))}]}}]}};
  const controller=createModularCompletionController({policy,getSnapshot:()=>snapshot,
    review:args=>reviewModularOutcome({runtime,cwd,model:'fixture::fixture-model',context:{preset:'custom',windowTokens:12000,outputReserveTokens:1000,headroomTokens:1000},...args})});
  assert.equal(await controller.beforeFinal({output:'Accepted with receipt API-SAVED-ACCEPTANCE-17.'}),null);
  const result=await controller.assertReady();assert.equal(requests.length,2);assert.equal(result.assessment.evidenceInspection.reads.length,1);
  assert.deepEqual(result.assessment.evidenceInspection.reads[0].evidenceIds,['api-operation']);
});
