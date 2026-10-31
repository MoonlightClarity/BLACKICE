import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ResponseCycleService} from '../lib/response-cycle.mjs';

const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const at='2026-10-31T02:00:00.000Z';
const event=(id,body,extra={})=>({type:'agent.event',runId:'record-run',nodeId:'worker',at,data:{type:'item',stage:'completed',threadId:'record-thread',turnId:'record-turn',item:{type:'dynamicToolCall',id,tool:'relay_browser',arguments:{action:'snapshot'},status:'completed',success:true,contentItems:[{type:'inputText',text:typeof body==='string'?body:JSON.stringify(body)}],...extra}}});
const summary=(id,extra={})=>({type:'agent.event',runId:'record-run',nodeId:'worker',at,data:{type:'tool.result',callId:id,tool:'relay_browser',action:'snapshot',status:'completed',success:true,message:'The requested observation was returned.',...extra}});
const output=receipts=>({nodeId:'worker',title:'Record worker',status:'completed',output:'The worker recorded the observed results in [the report](record://saved-report).',toolReceipts:receipts});

function fixture(t,{outcome='partial',afterWrite}={}){
  let request={id:'request-current',sources:[],nodes:[
    {id:'plan-current',revision:1,readiness:{cycle:{analysisReady:true}},response:{id:'plan-response'}},
    {id:'response-current',readiness:{cycle:{analysisReady:true,outcome}},response:{id:'evaluated-response',values:{answer:'The evaluator retained the observed result and its stated limitations.'}}}
  ],responseCycle:{rootCycleId:'cycle-current',cycles:[{id:'cycle-current',state:'executing',stageNodeIds:{plan:'plan-current',respond:'response-current'},effectReceipts:[]}]}};
  const captured=[];
  const writer={configureResponseCycle:async(id,value)=>{
    assert.equal(id,request.id);
    if(value.replaceSourcePrefix)request.sources=request.sources.filter(source=>!source.id.startsWith(value.replaceSourcePrefix));
    if(value.sources)request.sources.push(...structuredClone(value.sources));
    if(value.cyclePatch)Object.assign(request.responseCycle.cycles[0],structuredClone(value.cyclePatch));
    await afterWrite?.(value);
    return structuredClone(request);
  }};
  const service=new ResponseCycleService({store:{runtimeWriter:()=>writer,get:async()=>structuredClone(request)},runner:{start:()=>{throw Error('This transport fixture must not start a provider.');}}});
  service.drive=async()=>{captured.push(structuredClone(request.sources));return structuredClone(request);};
  t.after(()=>service.close());
  const run={id:'record-run',planningMode:'on',responseCycle:{requestId:request.id,cycleId:'cycle-current',planRef:{requestId:request.id,nodeId:'plan-current',nodeRevision:1,responseId:'plan-response'}}};
  return {service,run,captured,get request(){return structuredClone(request);}};
}
function projected(f){
  assert.equal(f.captured.length,1,'the evaluator must receive the projection exactly once');
  const sources=f.captured[0].filter(source=>source.id.startsWith('cycle:execution:'));
  assert.ok(sources.length>0&&sources.length<=90);
  for(const source of sources){assert.ok(source.text.length<=36000);assert.equal(source.contentHash,sha(source.text));}
  const records=sources.map(source=>JSON.parse(source.text)),manifest=records.find(record=>record.projection),texts=new Map(records.flatMap(record=>record.texts||[]).map(row=>[row.id,row]));
  const calls=records.flatMap(record=>record.calls||[]).map(call=>({...call,records:call.records.map(row=>{
    const shared=row.metadataRef===undefined?null:manifest.projection.receiptMetadataTable?.[row.metadataRef];
    if(row.metadataRef!==undefined)assert.ok(shared,'each receipt metadata reference must resolve to exact status and provenance');
    return {...shared,...row};
  }),observations:(call.observations||[]).map(row=>{
    const shared=row.textRef?texts.get(row.textRef):null;
    if(row.textRef)assert.ok(shared,'each exact-text reference must resolve across packed sources');
    return {...row,...shared,path:row.path??manifest.projection.pathTable?.[row.pathRef]};
  })}));
  return {sources,records,manifest,calls};
}
const observations=calls=>calls.flatMap(call=>call.observations||[]);
const visibleText=rows=>rows.flatMap(row=>(row.ranges||[]).map(range=>range.text)).join('\n');

test('large textual tool histories finalize through bounded parseable evidence with every call identity',async t=>{
  const f=fixture(t),receipts=[];
  for(let index=0;index<214;index++){
    const status=index===107?'MIDDLE_STATUS_RECORD_107 was returned by the record service.':'';
    const frameText=(index===0?'EARLY_VISIBLE_RECORD_00. ':index===213?'LATE_VISIBLE_RECORD_213. ':'')+'Ordinary visible page text. '.repeat(650);
    receipts.push(event('observed-'+index,{tabId:'record-tab',url:'https://example.test/records/'+index,documentId:'document-'+index,title:'Record page',tabs:[{title:'Unneeded tab inventory '+index}],frames:[{frame:0,url:'https://example.test/records/'+index,readyState:'complete',text:frameText,elements:[{ref:'status-'+index,role:status?'status':'button',name:status||'Inspect',tag:'div',disabled:false}]}]}));
    if(index<213)receipts.push(summary('observed-'+index));
  }
  const outputs=[output(receipts)],before=structuredClone(outputs);
  assert.ok(JSON.stringify(outputs).length>3240000,'this must reproduce the original ninety-chunk overflow using text alone');
  const final=await f.service.finishRun(f.run,{outputs}),capture=projected(f);
  assert.equal(final.state,'completed');assert.equal(final.outcome,'partial','projection cannot turn a qualified evaluator result into full success');
  assert.deepEqual(new Set(capture.calls.map(call=>call.callId)),new Set(Array.from({length:214},(_,index)=>'observed-'+index)));
  assert.equal(capture.calls.flatMap(call=>call.records).length,receipts.length);
  const refs=capture.calls.flatMap(call=>call.records);
  for(const receipt of receipts){
    const raw=JSON.stringify(receipt),ref=refs.find(record=>record.sha256===sha(raw));assert.ok(ref);assert.equal(ref.length,raw.length);assert.equal(ref.success,true);
    for(const field of ['threadId','turnId','at']){
      const expected=receipt.data[field]??receipt[field],actual=ref[field]??capture.manifest.projection.provenanceTables?.[field]?.[ref[field+'Ref']];
      assert.equal(actual,expected,'compact provenance must resolve to the original value');
    }
  }
  assert.equal(capture.manifest.projection.textBudgetChars,96000);assert.equal(capture.manifest.projection.truncated,true);
  assert.ok(capture.sources.reduce((total,source)=>total+source.text.length,0)<260000,'raw page histories must not re-enter evaluation at megabyte scale');
  const text=visibleText(observations(capture.calls));
  assert.match(text,/EARLY_VISIBLE_RECORD_00/);assert.match(text,/MIDDLE_STATUS_RECORD_107/);assert.match(text,/LATE_VISIBLE_RECORD_213/);
  assert.deepEqual(outputs,before,'raw operational evidence remains unchanged');
  assert.deepEqual(f.request.responseCycle.cycles[0].effectReceipts,[],'a compressed observation is not a host effect certification');
});

test('long visible text retains verifiable head, middle, and tail ranges',async t=>{
  const f=fixture(t),padding='Ordinary record detail. '.repeat(1800),body='HEAD_RECORD_17\n'+padding+'\nMIDDLE_RECORD_18\n'+padding+'\nTAIL_RECORD_19';
  const receipt=event('large-visible-record',{tabId:'record-tab',url:'https://example.test/records/large',documentId:'large-document',title:'Large record',frames:[{frame:0,text:body,elements:[],readyState:'complete',url:'https://example.test/records/large'}]});
  await f.service.finishRun(f.run,{outputs:[output([receipt])]});
  const capture=projected(f),row=observations(capture.calls).find(row=>row.path.endsWith('/frames/0/text'));
  assert.ok(row);assert.equal(row.length,body.length);assert.equal(row.truncated,true);
  for(const range of row.ranges){assert.equal(range.text,body.slice(range.start,range.end));assert.equal(range.end-range.start,range.text.length);}
  const text=visibleText([row]);assert.match(text,/HEAD_RECORD_17/);assert.match(text,/MIDDLE_RECORD_18/);assert.match(text,/TAIL_RECORD_19/);
  assert.equal(capture.calls[0].records[0].sha256,sha(receipt));
});

test('short observations, real failures, and duplicate event provenance survive without success inference',async t=>{
  const f=fixture(t),clicked=event('click-record','Clicked the requested control.'),failed=summary('failed-record',{status:'failed',success:false,code:'RECORD_UNAVAILABLE',message:'The requested record could not be read.'});
  const receipts=[clicked,summary('click-record'),failed],outputs=[output(receipts)],before=structuredClone(outputs);
  await f.service.finishRun(f.run,{outputs});
  const capture=projected(f),click=capture.calls.find(call=>call.callId==='click-record'),failure=capture.calls.find(call=>call.callId==='failed-record');
  assert.equal(click.records.length,2);assert.ok(click.records.some(record=>record.threadId==='record-thread'&&record.turnId==='record-turn'));
  assert.ok(failure.records.some(record=>record.status==='failed'&&record.success===false&&record.code==='RECORD_UNAVAILABLE'));
  const row=click.observations.find(row=>visibleText([row])==='Clicked the requested control.');
  assert.ok(row);assert.equal(row.truncated,false);assert.deepEqual(row.ranges,[{start:0,end:'Clicked the requested control.'.length,text:'Clicked the requested control.'}]);
  assert.match(visibleText(failure.observations),/could not be read/);
  assert.deepEqual(f.request.responseCycle.cycles[0].effectReceipts,[]);assert.deepEqual(outputs,before);
  assert.match(JSON.stringify(capture.records),/record:\/\/saved-report/,'the worker deliverable remains available to the evaluator');
});

test('a worker failure remains a failed execution while the evaluator keeps its own qualified outcome',async t=>{
  const f=fixture(t),item={...output([summary('failed-call',{status:'failed',success:false,code:'TOOL_FAILED',message:'The operation failed.'})]),status:'failed',output:'The worker reported the unresolved operation.'};
  const result=await f.service.finishRun(f.run,{outputs:[item]});
  const capture=projected(f);
  assert.equal(f.request.responseCycle.cycles[0].execution.state,'failed');assert.equal(result.outcome,'partial');
  assert.equal(capture.manifest.nodes[0].status,'failed');assert.equal(capture.calls[0].records[0].success,false);
});

test('identity metadata overflow preserves records and reports an unperformed review without a workflow exception',async t=>{
  const f=fixture(t),receipts=Array.from({length:2000},(_,index)=>summary('indexed-call-'+index)),outputs=[output(receipts)],before=structuredClone(outputs);
  const result=await f.service.finishRun(f.run,{outputs});
  assert.equal(result.state,'needs_evidence');assert.equal(result.partial,true);assert.equal(f.captured.length,0);
  assert.match(result.output,/review was not performed/);assert.match(result.output,/record:\/\/saved-report/);assert.match(result.output,/worker recorded the observed results/);assert.equal(result.outcome,undefined);
  const sources=f.request.sources.filter(source=>source.id.startsWith('cycle:execution:')),body=JSON.parse(sources[0].text);
  assert.ok(sources.every(source=>source.text.length<=36000));assert.ok(sources.reduce((total,source)=>total+source.text.length,0)<=240000);
  assert.equal(body.projection.reviewLimited,true);assert.equal(body.projection.omittedCallCount,2000);assert.match(body.projection.callIndex.sha256,/^[a-f0-9]{64}$/);
  assert.equal(f.request.responseCycle.cycles[0].execution.state,'completed');assert.equal(f.request.responseCycle.cycles[0].state,'needs_evidence');
  assert.deepEqual(outputs,before);
});

test('cancellation during evidence persistence cannot return a completed or partially reviewed result',async t=>{
  for(const receipts of [[summary('one-record')],Array.from({length:2000},(_,index)=>summary('indexed-call-'+index))]){
    const controller=new AbortController(),f=fixture(t,{afterWrite:()=>controller.abort()});
    await assert.rejects(f.service.finishRun(f.run,{outputs:[output(receipts)],signal:controller.signal}),error=>error.name==='AbortError');
    assert.equal(f.captured.length,0);
  }
});

test('embedded browser errors survive a successful tool transport and stringified arguments retain the action',async t=>{
  const f=fixture(t),receipt=event('browser-error-record',{success:false,status:'failed',code:'FRAME_UNAVAILABLE',error:{message:'The observed frame could not be read.'},frames:[]},{arguments:JSON.stringify({action:'snapshot',tabId:'record-tab'})});
  await f.service.finishRun(f.run,{outputs:[output([receipt])]});
  const capture=projected(f),call=capture.calls[0],document=call.documents[0];
  assert.equal(call.action,'snapshot');assert.equal(call.records[0].success,true);
  assert.equal(document.success,false);assert.equal(document.status,'failed');assert.equal(document.code,'FRAME_UNAVAILABLE');
  assert.match(visibleText(call.observations),/frame could not be read/);assert.deepEqual(f.request.responseCycle.cycles[0].effectReceipts,[]);
});

test('a substantive frame survives auxiliary boilerplate and realistic metadata across 432 receipts',async t=>{
  const f=fixture(t),receipts=[],marker='MAIN_RECORD_57_'+'R'.repeat(50),targetId='exec-'+String(57).padStart(32,'0');
  const targetText=('Visible record heading. '.repeat(10).slice(0,165)+marker+' Ordinary supporting record text. ').padEnd(6246,'x');
  const texts=Array.from({length:68},(_,index)=>('Repeated visible record '+index+'. '+'Ordinary content. '.repeat(130)).slice(0,1716));
  for(let index=0;index<216;index++){
    const id='exec-'+String(index).padStart(32,'0'),url='https://example.test/records/'+index+'?view='+'v'.repeat(index===0?120:20);
    const body={url,title:index===0?('Observed record '+index+'. '+'Page details. '.repeat(12)).slice(0,143):'Observed record page '+index,frames:[{frame:0,text:'Auxiliary UI.',elements:[]},{frame:1,text:index===57?targetText:texts[index%texts.length],elements:[]}]};
    const rich=event(id,body),brief=summary(id);
    rich.at=new Date(Date.parse(at)+index*2).toISOString();brief.at=new Date(Date.parse(at)+index*2+1).toISOString();
    receipts.push(rich,brief);
  }
  const outputs=[output(receipts)],before=structuredClone(outputs);
  await f.service.finishRun(f.run,{outputs});
  const capture=projected(f),target=capture.calls.find(call=>call.callId===targetId),main=target.observations.find(row=>row.path.endsWith('/frames/1/text'));
  assert.equal(capture.calls.length,216);assert.equal(capture.calls.flatMap(call=>call.records).length,432);
  assert.ok(main);assert.match(visibleText([main]),new RegExp(marker));
  assert.ok(main.ranges.some(range=>range.start===0&&range.end>=230),'the substantive page retains a useful initial observation');
  for(const range of main.ranges)assert.equal(range.text,targetText.slice(range.start,range.end));
  assert.ok(capture.sources.reduce((total,source)=>total+source.text.length,0)<=240000);
  assert.deepEqual(outputs,before);
});

test('shared receipt metadata preserves mixed native and MCP results while funding distinct observations',async t=>{
  const f=fixture(t),receipts=[],marker='MIXED_MAIN_RESULT_'+'R'.repeat(47),targetId='exec-'+String(57).padStart(32,'0');
  const target=('Visible record heading. '.repeat(10).slice(0,165)+marker).padEnd(6246,'x');
  const browserTexts=Array.from({length:69},(_,index)=>'Visible record '+index+'. '+'Ordinary page content. '.repeat(140));
  const fileTexts=Array.from({length:56},(_,index)=>'File record '+index+'. '+'Recorded source detail. '.repeat(140));
  for(let index=0;index<216;index++){
    const id='exec-'+String(index).padStart(32,'0');let rich;
    if(index<140){
      const status=index===70?'OBSERVED_STATUS_70.':index===100?'OBSERVED_STATUS_100.':'';
      rich=event(id,{url:'https://example.test/records/'+index+'?view='+'v'.repeat(45),title:'Observed source record '+index,frames:[{frame:0,text:['Auxiliary UI.','Small auxiliary status widget.','Auxiliary page marker.'][index%3],elements:[]},{frame:1,text:index===57?target:browserTexts[index%69],elements:status?[{role:'status',name:status,ref:'status-ref'}]:[]},{frame:2,text:'',elements:[]}]});
    }else if(index<200)rich=event(id,fileTexts[(index-140)%56],{tool:'relay_files',arguments:{action:'read',path:'/fixture/records.txt'}});
    else{
      rich=event(id,'');rich.data.item={type:'mcpToolCall',id,server:'fixture-records',tool:'read_record',status:'completed',result:{content:[{type:'text',text:'Connected source '+index+'. '+'Returned record details. '.repeat(140)}]}};
    }
    rich.data.threadId='thread-'+String(1).padStart(32,'0');rich.data.turnId='turn-'+String(1).padStart(32,'0');rich.data.duringSettlement=false;
    const brief=summary(id,{tool:rich.data.item.tool,action:index<140?'snapshot':'read',...(index>=197&&index<200?{success:false,status:'failed',code:'RECORD_UNAVAILABLE',message:'The requested record could not be read.'}:{})});
    rich.at=new Date(Date.parse(at)+index*2).toISOString();brief.at=new Date(Date.parse(at)+index*2+1).toISOString();
    receipts.push(rich,brief);
  }
  const outputs=[output(receipts)],before=structuredClone(outputs);
  await f.service.finishRun(f.run,{outputs});
  const capture=projected(f),refs=capture.calls.flatMap(call=>call.records),table=capture.manifest.projection.receiptMetadataTable;
  assert.equal(capture.calls.length,216);assert.equal(refs.length,432);assert.ok(table.length>0);
  for(const receipt of receipts){
    const ref=refs.find(row=>row.sha256===sha(receipt)),original=receipt.data.item||receipt.data;
    assert.ok(ref);assert.equal(ref.length,JSON.stringify(receipt).length);
    for(const field of ['type','status','success','code','exitCode'])assert.deepEqual(ref[field],original[field]);
    for(const field of ['threadId','turnId','at','stage','duringSettlement'])assert.equal(ref[field]??capture.manifest.projection.provenanceTables?.[field]?.[ref[field+'Ref']],receipt.data[field]??receipt[field]);
  }
  const rawRefs=capture.records.flatMap(body=>body.calls||[]).flatMap(call=>call.records),compactIndex=JSON.stringify(rawRefs).length+JSON.stringify(table).length;
  assert.ok(compactIndex<JSON.stringify(refs).length-20000,'lossless metadata sharing reserves room for observed text');
  const main=capture.calls.find(call=>call.callId===targetId).observations.find(row=>row.path.endsWith('/frames/1/text'));
  assert.match(visibleText([main]),new RegExp(marker));assert.ok(main.ranges.some(range=>range.start===0&&range.end>=230));
  assert.match(visibleText(observations(capture.calls)),/OBSERVED_STATUS_70/);assert.match(visibleText(observations(capture.calls)),/OBSERVED_STATUS_100/);
  assert.ok(capture.sources.reduce((sum,source)=>sum+source.text.length,0)<=240000);assert.deepEqual(outputs,before);
});
