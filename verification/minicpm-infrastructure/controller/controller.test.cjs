'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const api=require('./native-api.cjs'),core=require('./controller.cjs'),ev=require('./evidence.cjs');
const at='2026-11-20T23:00:00.000Z';
function config(){const text='Inspect, write, run the public tests, and repair.\n';return{controllerId:'test_controller',requestId:'chat_test_001',workflowId:'mission_chat_test_001',caseId:'D0',connectionId:'connection-test',origin:'http://127.0.0.1:53151',workspace:'C:/isolated/D0/original',task:'Build the saved artifact.\nBEGIN METHOD\n'+text+'END METHOD',method:{text,sha256:api.sha(text)},model:'minicpm_directory_experiment::MiniCPM-test',context:{preset:'custom',windowTokens:262144,autoCompact:false,outputReserveTokens:4096,headroomTokens:512},budgets:{wallMs:300000,settlementGraceMs:60000,pollIntervalMs:1000,windowMs:4000,fetchTimeoutMs:1000,maxReceiptPages:8},allowedCommands:['node test-public.cjs']};}
function run(c=config()){return{id:'owned_run',taskId:'owned_run',createdAt:at,status:'running',settled:false,cwd:c.workspace,input:c.task.trim(),metadata:{clientRequestId:c.requestId},workflow:{id:c.workflowId,nodes:[{id:'agent',type:'agent',model:c.model}]},executionModes:{directoryMode:'off'},directoryActions:'on',directoryDiagnostics:'maximal',nodes:{agent:{threadId:'provider_owned',directoryContext:{runId:'owned_run',taskId:'owned_run',nodeId:'agent',hostTools:{received:0,returned:0,threw:0}}}},events:[],eventRetention:{omittedEvents:0}};}
function preparedBody(c){return{requestId:c.requestId,workflow:{id:c.workflowId,nodes:[{id:'agent',model:c.model}]},input:{task:c.task,cwd:c.workspace,directoryMode:'off',directoryActions:'on',directoryDiagnostics:'maximal'}};}
function completeOp(s,value){const p=core.planNext(s,at);s=core.commitOperation(s,p);const jobId='direct_'+String(s.nextIndex).padStart(64,'0');s=core.recordSubmission(s,{jobId,connectionId:s.config.connectionId,requestId:s.pending.requestId});return core.acceptResponse(s,{jobId,connectionId:s.config.connectionId,jobStatus:'succeeded',jobSettled:true,value,evidence:{path:'/saved/raw.json',sha256:'a'.repeat(64)}},at);}
function runningState(){let s=core.createState(config(),at);s=completeOp(s,{kind:'prepare',body:preparedBody(s.config)});return completeOp(s,{kind:'start',run:run(s.config)});}
function fixture(){const c=config(),r=run(c);r.status='completed';r.settled=true;const rows=[],calls=[],transcript=[{role:'user',content:'Native prefix\n'+c.task}],entries=[];let count=0;
  function add(tool,args,result,receiptId,success=true){const id='call_'+(++count),messageIndex=transcript.length;transcript.push({role:'assistant',tool_calls:[{id,function:{name:tool,arguments:JSON.stringify(args)}}]});const text=JSON.stringify(result)+(receiptId?'\nDIRECTORY HOST RECEIPT '+receiptId+'; current revision '+count+'. This is handler activity, not verified task completion.':'');transcript.push({role:'tool',tool_call_id:id,content:text});r.events.push({id:'event_'+count,runId:r.id,nodeId:'agent',at,type:'agent.event',data:{type:'tool.result',callId:id,tool,action:args.action,status:success?'completed':'failed',success}});entries.push({sequence:count,kind:'tool.result',callRef:ev.callRef(r.id,id),metadata:{success}});calls.push({id,tool,args,messageIndex});if(receiptId)rows.push({id:receiptId,taskId:r.id,runId:r.id,nodeId:'agent',actionId:args.action==='read'?null:'implement',tool,state:'returned',success,at,returnedAt:at,...(args.action==='read'?{observationOnly:true}: {})});return id;}
  add('relay_workspace',{action:'read',path:'TASK.md'},{path:c.workspace+'/TASK.md',content:'1: Build it.',truncated:false},'receipt-1');
  add('relay_directory_action',{action:'plan',actions:[{id:'implement',objective:'Save and test',dependsOn:[]}]},{taskId:r.id,actions:[{id:'implement',state:'pending'}],focus:null,revision:1,receipts:[]});
  add('relay_directory_action',{action:'focus',id:'implement'},{taskId:r.id,actions:[{id:'implement',state:'active'}],focus:'implement',revision:2,receipts:rows.slice()});
  add('relay_workspace',{action:'write',path:'src/index.cjs',text:'module.exports={x:1};'},{path:c.workspace+'/src/index.cjs',bytesWritten:21,atomic:true},'receipt-2');
  const report={schema:'blackice.minicpm.public-smoke.v1',taskId:'D0',semanticPass:true,caseCount:2,executedCases:2,passedCases:2,sourceSnapshotSha256:'d'.repeat(64)};
  add('relay_workspace',{action:'run',command:'node test-public.cjs',timeoutMs:10000},{command:'node test-public.cjs',cwd:c.workspace,exitCode:0,signal:null,stdout:JSON.stringify(report,null,2)+'\n',stderr:'',timedOut:false,truncated:false,durationMs:10},'receipt-3');
  const state={taskId:r.id,actions:[{id:'implement',state:'observed',observation:{receipts:['receipt-2','receipt-3'],claim:'Done'}}],focus:null,receipts:rows,revision:8};
  add('relay_directory_action',{action:'observe',id:'implement',outcome:'objective-met',receipts:['receipt-2','receipt-3'],claim:'Done'},state);
  r.nodes.agent.toolNames=['relay_workspace','relay_directory_action'];r.nodes.agent.directoryContext.hostTools={received:3,returned:3,threw:0};r.events.push({id:'final',runId:r.id,nodeId:'agent',at,type:'agent.event',data:{type:'message',phase:'final_answer',text:'Saved and checked.'}});
  const receiptPages=Object.fromEntries(['context','tools','decisions'].map(view=>[view,{complete:true,pages:[{view,runId:r.id,taskId:r.id,actions:[],revision:'revision-'+view,offset:0,nextOffset:null}]}]));
  return{config:c,bundle:{run:r,providerThreadId:'provider_owned',ledger:{runId:r.id,taskId:r.id,state,final:{ready:true,reason:'ready',unknown:[]}},machine:{audience:'machine',runId:r.id,taskId:r.id,coverage:{source:'maximal-host-envelopes',dropped:0,entryMetadataOmitted:0,gaps:[]},entries},receiptPages},providerThread:{version:1,id:'provider_owned',providerId:'minicpm_directory_experiment',providerType:'compatible',model:'MiniCPM-test',cwd:c.workspace,hostOnlyTools:true,messages:transcript,transcript},calls};
}
async function simulate(op,answers,{start=Date.parse(at)}={}){let now=start,requests=[];class Clock extends Date{constructor(...x){super(...(x.length?x:[now]));}static now(){return now;}}
  const context={location:{origin:config().origin},Date:Clock,AbortSignal:{timeout:ms=>({ms})},setTimeout:cb=>{now+=1000;cb();},fetch:async(route,options)=>{requests.push({route,options});const a=answers.shift();if(typeof a==='function')return a({advance:n=>now+=n});if(a instanceof Error)throw a;return{ok:true,status:200,text:async()=>JSON.stringify(a)};}};
  const value=await vm.runInNewContext(op.arguments.expression,context);return{value:JSON.parse(JSON.stringify(value)),requests};
}
test('C1 raw file hashes use bytes, including Uint8Array',()=>{const b=Buffer.from([0,255,10]);const expected=crypto.createHash('sha256').update(b).digest('hex');assert.equal(api.sha(b),expected);assert.equal(api.sha(new Uint8Array(b)),expected);});
test('C1 rejects relative cwd and unsupported sampler/budget fields',()=>{assert.throws(()=>api.validate({...config(),workspace:'relative'}));assert.throws(()=>api.validate({...config(),temperature:.8}));assert.throws(()=>api.validate({...config(),maxSteps:18}));assert.throws(()=>api.validate({...config(),budgets:{...config().budgets,windowMs:60000}}));});
test('C1 exact Directory modes and authenticated origin appear in request builder',()=>{const op=api.prepare(config(),0);assert.match(op.arguments.expression,/directoryMode:'off',directoryActions:'on'/);assert.match(op.arguments.expression,/import\('\/mission-model\.mjs'\)/);assert.doesNotMatch(op.arguments.expression,/fetch\(/);new Function('return '+op.arguments.expression);});
test('C1 ownership accepts native absent/null parent fields and rejects another run',()=>{const r=run();r.parentRunId=null;r.retryOf=null;assert.equal(api.assertOwned(r,config(),'owned_run'),r);assert.throws(()=>api.assertOwned(r,config(),'other'));r.metadata.clientRequestId='other';assert.throws(()=>api.assertOwned(r,config()));});
test('C2 uncertain submission retains exact args and ID through serialization',()=>{let s=core.createState(config(),at);s=core.commitOperation(s,core.planNext(s,at));const reloaded=JSON.parse(JSON.stringify(s)),p=core.planNext(reloaded,at);assert.equal(p.type,'recover-same-operation');assert.deepEqual(p.operation.arguments,s.pending.arguments);assert.equal(core.planNext(s,at,'new-grant').reason,'connection-changed');});
test('C2 native admission fixes deadline from native createdAt',()=>{const s=runningState();assert.equal(s.phase,'running');assert.equal(Date.parse(s.deadlineAt)-Date.parse(s.run.createdAt),300000);assert.equal(Date.parse(s.cleanupDeadlineAt)-Date.parse(s.deadlineAt),60000);});
test('C2 terminal but unsettled continues observation',()=>{const s=runningState();s.run.status='cancelled';s.run.settled=false;assert.equal(core.planNext(s,at).operation.kind,'observe');s.run.settled=true;assert.equal(core.planNext(s,at).operation.kind,'collect');});
test('C2 deadline cancels only the proved owned run and waits for settlement',async()=>{const c=config(),r=run(c),deadline=at,end=new Date(Date.parse(at)+60000).toISOString(),cancel={...r,status:'cancelled'},done={...cancel,settled:true};const result=await simulate(api.observe(c,0,r.id,deadline,end),[r,cancel,done]);assert.equal(result.requests.filter(x=>x.options.method==='POST').length,1);assert.equal(result.requests[1].route,'/api/runs/owned_run/cancel');assert.deepEqual(JSON.parse(result.requests[1].options.body),{});assert.equal(result.value.run.settled,true);assert.equal(result.value.cancellations[0].status,'cancelled');});
test('C2 foreign identity blocks cancellation',async()=>{const r=run();r.metadata.clientRequestId='foreign';const result=await simulate(api.observe(config(),0,r.id,at,new Date(Date.parse(at)+60000).toISOString()),[r]);assert.equal(result.requests.length,1);assert.match(result.value.error.message,/IDENTITY_MISMATCH/);});
test('C2 ordinary polling-window timeout is distinct from unknown cancellation',async()=>{const c=config(),r=run(c),future=new Date(Date.parse(at)+300000).toISOString(),end=new Date(Date.parse(at)+360000).toISOString();const timeout=({advance})=>{advance(4000);const e=Error('fetch timed out');e.name='TimeoutError';throw e;};let out=await simulate(api.observe(c,0,r.id,future,end),[r,timeout]);assert.equal(out.value.windowExhausted,true);assert.equal(out.value.error,null);out=await simulate(api.observe(c,1,r.id,at,end),[r,timeout]);assert.equal(out.value.error.unknownCancel,true);assert.equal(out.value.cancellations[0].status,'unknown');});
test('C2 cleanup deadline returns an explicit block, never another start',()=>{const s=runningState();assert.equal(core.planNext(s,s.cleanupDeadlineAt).reason,'settlement-deadline-exceeded');});
test('C2 invalid/missing projection cannot become complete',()=>{const s=runningState();s.phase='needs-provider-transcript';const p=core.attachProjection(s,{path:'/tmp/thread',sha256:'b'.repeat(64)},{});assert.equal(p.phase,'blocked');});
test('C2 journal and evidence files are read back and hashed by raw bytes',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'controller-test-'));try{const file=path.join(dir,'journal.json'),s=core.createState(config(),at),receipt=core.saveJournal(file,s);assert.equal(receipt.sha256,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));assert.throws(()=>core.saveJournal(file,s));const evidence=core.saveEvidence(dir,'raw',{a:1});assert.equal(evidence.sha256,api.sha(fs.readFileSync(evidence.path)));}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('C3 full JSON is parsed without mistaking host suffix or escaped braces for JSON',()=>{const value={stdout:'a } \\" b',nested:[{ok:true}]};assert.deepEqual(ev.firstJson(JSON.stringify(value)+'\nDIRECTORY HOST RECEIPT receipt-1; current revision 1.'),value);assert.equal(ev.firstJson('{"truncated"'),null);});
test('C3 native transcript+ledger produces command exits and chronological Directory proof',()=>{const f=fixture(),p=ev.projectEvidence(f);assert.deepEqual(p.validation.issues,[]);assert.equal(p.receipt.actions.settled,true);assert.equal(p.receipt.actions.commands[0].report.executedCases,2);assert.equal(p.receipt.actions.commands[0].receiptId,'receipt-3');assert.equal(p.receipt.evidence.methodDelivery.proven,true);const cs=p.directoryProof.calls;assert.ok(cs[1].resultMessageIndex<cs[2].messageIndex&&cs[2].resultMessageIndex<cs[3].messageIndex);});
test('C3 a real failed public command is recorded as failure, not a transport gap',()=>{const f=fixture(),call=f.calls.find(x=>x.args.action==='run'),message=f.providerThread.transcript[call.messageIndex+1];const result=ev.firstJson(message.content);result.exitCode=1;result.stdout=JSON.stringify({...JSON.parse(result.stdout),semanticPass:false,passedCases:1});message.content=JSON.stringify(result)+'\nDIRECTORY HOST RECEIPT receipt-3; current revision 5.';f.bundle.run.events.find(e=>e.data.callId===call.id).data.success=false;f.bundle.machine.entries.find(e=>e.callRef===ev.callRef('owned_run',call.id)).metadata.success=false;f.bundle.ledger.state.receipts.find(r=>r.id==='receipt-3').success=false;const p=ev.projectEvidence(f);assert.equal(p.validation.valid,true);assert.equal(p.receipt.actions.commands[0].exitCode,1);assert.equal(p.receipt.actions.failures.length,1);});
test('C3 terminal cancelled run may be settled while Directory remains logically active',()=>{const f=fixture();f.bundle.run.status='cancelled';f.bundle.ledger.state.actions[0].state='active';f.bundle.ledger.final={ready:false,reason:'pending-actions',unknown:[]};const p=ev.projectEvidence(f);assert.equal(p.validation.valid,true);assert.equal(p.receipt.actions.settled,true);assert.equal(p.receipt.actions.activeCount,0);assert.equal(p.receipt.actions.ledgerActiveCount,1);assert.equal(p.receipt.completion.agentCompleted,false);});
test('C3 unknown effects and missing command output block grading',()=>{const f=fixture();f.bundle.ledger.state.receipts[1].state='unknown';f.bundle.ledger.final.unknown=['receipt-2'];const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false);assert.equal(p.receipt.actions.settled,false);assert.equal(p.receipt.actions.pendingWriteCount,1);});
test('C3 omitted full tool exchange cannot pass with apparently settled counters',()=>{const f=fixture();f.providerThread.transcript=f.providerThread.transcript.slice(0,1);f.bundle.ledger.state.receipts=[];const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false);assert.match(p.validation.issues.join('\n'),/handler count/);});
test('C3 zero calls can be gradeable when host counters are zero and task was delivered',()=>{const f=fixture();f.providerThread.transcript=f.providerThread.transcript.slice(0,1);f.bundle.run.nodes.agent.directoryContext.hostTools={received:0,returned:0,threw:0};f.bundle.run.events=[];f.bundle.machine.entries=[];f.bundle.ledger.state.receipts=[];f.bundle.ledger.state.actions=[];f.bundle.ledger.final={ready:false,reason:'no-actions',unknown:[]};const p=ev.projectEvidence(f);assert.equal(p.validation.valid,true);assert.equal(p.receipt.actions.commands.length,0);assert.equal(p.receipt.completion.agentCompleted,false);});
test('C3 missing inline task/method delivery and unexpected descendants remain unproven',()=>{const f=fixture();f.providerThread.transcript[0].content='Only a filename was supplied.';f.bundle.machine.entries.push({kind:'subagent.started',sequence:999});const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false);assert.equal(p.receipt.evidence.methodDelivery.proven,false);assert.ok(p.receipt.actions.unexpectedWork.length);});
test('C3 full native command JSON is required; a compact timeline excerpt cannot replace it',()=>{const f=fixture(),call=f.calls.find(c=>c.args.action==='run');f.providerThread.transcript[call.messageIndex+1].content='{"preview":"short"}\nDIRECTORY HOST RECEIPT receipt-3; current revision 5.';const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false);assert.match(p.validation.issues.join('\n'),/Full command receipt/);});
test('CLI commits exact pending operation before exposing arguments and accepts native wrapper',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'controller-cli-')),cli=require('./controller-cli.cjs').main;try{const configPath=path.join(dir,'config.json'),journal=path.join(dir,'journal.json');fs.writeFileSync(configPath,JSON.stringify(config()));core.saveJournal(journal,core.createState(config(),at));const next=cli(['next','--journal',journal,'--connection','connection-test']);const saved=JSON.parse(fs.readFileSync(journal));assert.deepEqual(saved.pending.arguments,next.operation.arguments);const jobId='direct_'+'c'.repeat(64),admission=path.join(dir,'admission.json');fs.writeFileSync(admission,JSON.stringify({structuredContent:{jobId,requestId:next.operation.requestId}}));cli(['record-submission','--journal',journal,'--admission',admission,'--connection','connection-test']);const raw=path.join(dir,'raw.json'),text=JSON.stringify({target:'frontend',method:'Runtime.evaluate',result:{result:{type:'object',value:{kind:'prepare',body:preparedBody(config())}}}});fs.writeFileSync(raw,JSON.stringify({structuredContent:{jobId,status:'succeeded',settled:true,result:{success:true,text:{text,offset:0,totalCharacters:text.length,nextOffset:null}}}}));const accepted=cli(['accept','--journal',journal,'--result',raw,'--connection','connection-test']);assert.equal(accepted.phase,'prepared');assert.equal(JSON.parse(fs.readFileSync(journal)).history[0].evidence.sha256,api.sha(fs.readFileSync(raw)));}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('C2 complete oversized frontend artifact remains attached to original pending job',()=>{let s=core.createState(config(),at);s=core.commitOperation(s,core.planNext(s,at));const jobId='direct_'+'e'.repeat(64);s=core.recordSubmission(s,{jobId,requestId:s.pending.requestId,connectionId:s.config.connectionId});s=core.acceptResponse(s,{jobId,connectionId:s.config.connectionId,jobStatus:'succeeded',jobSettled:true,value:{artifactRequired:{path:'C:/evidence/full.json',sha256:'f'.repeat(64),bytes:1024,complete:true}},evidence:{path:'/raw.json',sha256:'a'.repeat(64)}},at);assert.equal(core.planNext(s,at).type,'retrieve-complete-saved-artifact');assert.equal(s.pending.jobId,jobId);assert.equal(s.history.length,0);});
test('C3 exact owned native thread copy preserves bytes and rejects evidence overwrite',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thread-copy-'));try{const f=fixture(),threadDir=path.join(dir,'provider-threads'),out=path.join(dir,'copied.json');fs.mkdirSync(threadDir);const bytes=Buffer.from(JSON.stringify(f.providerThread)+'\n');fs.writeFileSync(path.join(threadDir,'provider_owned.json'),bytes);const copy=require('./read-owned-thread.cjs').readOwnedThread;const receipt=copy({run:f.bundle.run,config:f.config,dataDir:dir,out});assert.equal(receipt.sha256,api.sha(bytes));assert.ok(fs.readFileSync(out).equals(bytes));assert.throws(()=>copy({run:f.bundle.run,config:f.config,dataDir:dir,out}));}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('C3 host-proven unavailable delegation is a model tool error with no phantom handler',()=>{const f=fixture(),id='unavailable_call';f.providerThread.transcript.push({role:'assistant',tool_calls:[{id,function:{name:'relay_delegate',arguments:'{"action":"start"}'}}]},{role:'tool',tool_call_id:id,content:'This tool is not attached to the active agent.'});f.bundle.run.events.push({id:'unavailable_event',runId:'owned_run',nodeId:'agent',data:{type:'tool.result',callId:id,tool:'relay_delegate',action:'start',success:false,status:'failed',code:'TOOL_UNAVAILABLE'}});const p=ev.projectEvidence(f);assert.equal(p.validation.valid,true);assert.equal(p.receipt.actions.unexpectedWork.length,0);assert.equal(p.receipt.actions.failures.length,1);assert.equal(p.directoryProof.calls.at(-1).knownNoDispatch,true);});

function fileFixture(){
  const f=fixture(),text='# Method\nRead TASK.md.',id='call_method',receiptId='receipt-4';
  f.config.task='Read METHOD.md using relay_workspace with {"action":"read","path":"METHOD.md"}.';
  f.config.method={deliveryMode:'file-read',path:'METHOD.md',sha256:api.sha(text)};
  f.bundle.run.input=f.config.task;
  f.providerThread.transcript[0].content='Native prefix\n'+f.config.task;
  const args={action:'read',path:'METHOD.md'},result={path:f.config.workspace+'/METHOD.md',size:Buffer.byteLength(text),sha256:api.sha(text),startLine:1,endLine:2,content:'1: # Method\n2: Read TASK.md.',truncated:false,nextStartLine:null,totalLines:2};
  f.providerThread.transcript.splice(1,0,{role:'assistant',tool_calls:[{id,function:{name:'relay_workspace',arguments:JSON.stringify(args)}}]},{role:'tool',tool_call_id:id,content:JSON.stringify(result)+'\nDIRECTORY HOST RECEIPT receipt-4; current revision 1.'});
  f.bundle.run.events.push({id:'event_method',runId:'owned_run',nodeId:'agent',at,type:'agent.event',data:{type:'tool.result',callId:id,tool:'relay_workspace',action:'read',status:'completed',success:true}});
  f.bundle.machine.entries.push({sequence:7,kind:'tool.result',callRef:ev.callRef('owned_run',id),metadata:{success:true}});
  f.bundle.ledger.state.receipts.push({id:receiptId,taskId:'owned_run',runId:'owned_run',nodeId:'agent',actionId:null,tool:'relay_workspace',state:'returned',success:true,observationOnly:true,at,returnedAt:at});
  f.bundle.run.nodes.agent.directoryContext.hostTools={received:4,returned:4,threw:0};
  return f;
}
function changeMethodResult(f,change){const message=f.providerThread.transcript.find(x=>x.role==='tool'&&x.tool_call_id==='call_method'),result=ev.firstJson(message.content);change(result);message.content=JSON.stringify(result)+'\nDIRECTORY HOST RECEIPT receipt-4; current revision 1.';}
test('V2 file mode accepts pinned filename/hash without inline text, and rejects invented modes',()=>{const f=fileFixture();assert.equal(api.validate(f.config).method.deliveryMode,'file-read');assert.throws(()=>api.validate({...f.config,method:{...f.config.method,deliveryMode:'automatic'}}));assert.throws(()=>api.validate({...f.config,method:{...f.config.method,path:'OTHER.md'}}));assert.throws(()=>api.validate({...f.config,method:{...f.config.method,sha256:'bad'}}));assert.doesNotMatch(api.prepare(f.config,0).arguments.expression,/# Method/);});
test('V2 complete same-run method read proves file delivery before effects',()=>{const p=ev.projectEvidence(fileFixture());assert.deepEqual(p.validation.issues,[]);assert.equal(p.receipt.evidence.methodDelivery.proven,true);assert.equal(p.receipt.evidence.methodDelivery.acceptedCallId,'call_method');assert.equal(p.receipt.evidence.methodDelivery.acceptedReceiptId,'receipt-4');assert.equal(p.receipt.evidence.taskDelivery.proven,true);assert.equal(p.directoryProof.calls.filter(c=>c.arguments?.action==='read').length,2);});
test('V2 missing read cannot be rescued by an inline copy in file mode',()=>{const f=fileFixture();f.providerThread.transcript.splice(1,2);f.providerThread.transcript[0].content+='\n# Method\nRead TASK.md.';f.bundle.run.events=f.bundle.run.events.filter(e=>e.data?.callId!=='call_method');f.bundle.machine.entries=f.bundle.machine.entries.filter(e=>e.callRef!==ev.callRef('owned_run','call_method'));f.bundle.ledger.state.receipts=f.bundle.ledger.state.receipts.filter(r=>r.id!=='receipt-4');f.bundle.run.nodes.agent.directoryContext.hostTools={received:3,returned:3,threw:0};const p=ev.projectEvidence(f);assert.equal(p.receipt.evidence.methodDelivery.proven,false);assert.deepEqual(p.validation.issues,['Exact method packet delivery to provider is unproven']);});
test('V2 partial, truncated, empty or unpaged method result is rejected',()=>{for(const delta of [{startLine:2},{endLine:1},{truncated:true},{nextStartLine:3},{totalLines:undefined},{content:''}]){const f=fileFixture();changeMethodResult(f,r=>Object.assign(r,delta));const p=ev.projectEvidence(f);assert.equal(p.receipt.evidence.methodDelivery.proven,false,JSON.stringify(delta));assert.equal(p.validation.valid,false);}});
test('V2 stale method bytes or a foreign file cannot establish delivery',()=>{for(const delta of [{sha256:'f'.repeat(64)},{path:'C:/other/METHOD.md'}]){const f=fileFixture();changeMethodResult(f,r=>Object.assign(r,delta));const p=ev.projectEvidence(f);assert.equal(p.receipt.evidence.methodDelivery.proven,false);assert.equal(p.validation.valid,false);}});
test('V2 failed or unlinked read cannot establish delivery',()=>{for(const mode of ['failed','unlinked','foreign-receipt']){const f=fileFixture();if(mode==='failed'){f.bundle.run.events.find(e=>e.data?.callId==='call_method').data.success=false;f.bundle.machine.entries.find(e=>e.callRef===ev.callRef('owned_run','call_method')).metadata.success=false;f.bundle.ledger.state.receipts.find(r=>r.id==='receipt-4').success=false;}else if(mode==='unlinked'){f.providerThread.transcript[2].content=f.providerThread.transcript[2].content.split('\nDIRECTORY HOST RECEIPT')[0];}else f.bundle.ledger.state.receipts.find(r=>r.id==='receipt-4').runId='foreign';const p=ev.projectEvidence(f);assert.equal(p.receipt.evidence.methodDelivery.proven,false,mode);assert.equal(p.validation.valid,false);}});
test('V2 method read after the first plan is late even when before the write',()=>{const f=fileFixture(),messages=f.providerThread.transcript.splice(1,2);f.providerThread.transcript.splice(5,0,...messages);const p=ev.projectEvidence(f);assert.equal(p.receipt.evidence.methodDelivery.proven,false);assert.equal(p.receipt.evidence.methodDelivery.reads.find(x=>x.callId==='call_method').checks.beforeEffects,false);});
test('V2 task must match native input and precede the first model response',()=>{for(const mode of ['wrong-input','late-task']){const f=fileFixture();if(mode==='wrong-input')f.bundle.run.input='Another task';else{f.providerThread.transcript[0].content='Unrelated context';f.providerThread.transcript.push({role:'user',content:f.config.task});}const p=ev.projectEvidence(f);assert.equal(p.receipt.evidence.taskDelivery.proven,false);assert.equal(p.receipt.evidence.methodDelivery.proven,true);assert.equal(p.validation.valid,false);}});
test('V2 journals reject old v1 journal identity without changing inline compatibility',()=>{const s=core.createState(config(),at);assert.equal(s.schema,'blackice.minicpm.directory-controller.v2');s.schema='blackice.minicpm.directory-controller.v1';assert.throws(()=>core.planNext(s,at));});
test('V2 corrupted returned body fails even with intact path, hash and full-range metadata',()=>{for(const content of ['1: # Method\n2: Read WRONG.md.','1: # Method','1: # Method\n2: Read TASK.md.\n3: injected']){const f=fileFixture();changeMethodResult(f,r=>{r.content=content;});const p=ev.projectEvidence(f),read=p.receipt.evidence.methodDelivery.reads.find(r=>r.callId==='call_method');assert.equal(p.receipt.evidence.methodDelivery.proven,false);assert.equal(read.checks.expectedHash,true);assert.equal(read.checks.completeFile,true);assert.equal(read.checks.deliveredBodyHash,false);}});
test('V2 numbered read rejects gaps, duplicate numbers, reordered lines and malformed prefixes',()=>{for(const content of ['1: # Method\n3: Read TASK.md.','1: # Method\n1: Read TASK.md.','2: # Method\n1: Read TASK.md.','01: # Method\n2: Read TASK.md.','1:# Method\n2: Read TASK.md.']){const f=fileFixture();changeMethodResult(f,r=>{r.content=content;});const p=ev.projectEvidence(f),read=p.receipt.evidence.methodDelivery.reads.find(r=>r.callId==='call_method');assert.equal(p.receipt.evidence.methodDelivery.proven,false);assert.equal(read.checks.deliveredBodySequential,false);}});
test('V2 exact delivered body requires UTF8 byte size and the numbered trailing LF line',()=>{const text='# Method\nRead TASK.md. π\n',f=fileFixture();f.config.method.sha256=api.sha(text);changeMethodResult(f,r=>{r.sha256=api.sha(text);r.size=Buffer.byteLength(text,'utf8');r.content='1: # Method\n2: Read TASK.md. π\n3: ';r.totalLines=3;r.endLine=3;});let p=ev.projectEvidence(f);assert.equal(p.receipt.evidence.methodDelivery.proven,true);changeMethodResult(f,r=>{r.size=text.length;});p=ev.projectEvidence(f);assert.equal(p.receipt.evidence.methodDelivery.proven,false);assert.equal(p.receipt.evidence.methodDelivery.reads[0].checks.deliveredBodySize,false);changeMethodResult(f,r=>{r.size=Buffer.byteLength(text,'utf8');r.content=r.content.slice(0,-4);});p=ev.projectEvidence(f);assert.equal(p.receipt.evidence.methodDelivery.proven,false);});
test('V2 deployed LF METHOD reconstructs to its exact frozen bytes including final newline',()=>{const bytes=fs.readFileSync(path.join(__dirname,'../packet/METHOD.md')),text=bytes.toString('utf8'),lines=text.split('\n'),f=fileFixture();assert.equal(api.sha(bytes),'f3c64b8bac8c52ef73833be34c857fbb5242eef6f2ebf9bcc5f8d321f8b4ccf5');assert.equal(text.includes('\r'),false);assert.equal(lines.length,60);assert.equal(lines.at(-1),'');f.config.method.sha256=api.sha(bytes);changeMethodResult(f,r=>Object.assign(r,{sha256:api.sha(bytes),size:bytes.length,totalLines:lines.length,endLine:lines.length,content:lines.map((line,i)=>(i+1)+': '+line).join('\n')}));const p=ev.projectEvidence(f),read=p.receipt.evidence.methodDelivery.reads.find(r=>r.callId==='call_method');assert.deepEqual(p.validation.issues,[]);assert.equal(p.receipt.evidence.methodDelivery.proven,true);assert.deepEqual(read.deliveredBody,{sha256:api.sha(bytes),bytes:bytes.length,lineCount:60});});

// Shape copied from settled native D0-original-a1: failed plain-text tool return,
// DIRECTORY_FOCUS gate rejection, no Directory receipt, no process result.
function rejectedCommandFixture(){
  const f=fileFixture(),call=f.calls.find(c=>c.args.action==='run'),r=f.bundle.run;
  f.providerThread.transcript.find(m=>m.tool_call_id===call.id).content='This tool call did not run. If the outline has no step for this change, add it with plan. Focus that step before calling the tool again.';
  const returned=r.events.find(e=>e.data?.callId===call.id);Object.assign(returned.data,{success:false,status:'failed',code:'DIRECTORY_FOCUS'});returned.timelineOrder=41;
  r.events.splice(r.events.indexOf(returned),0,{at,runId:r.id,nodeId:'agent',timelineOrder:39,type:'agent.event',data:{type:'directory.effect',callId:call.id,tool:'relay_workspace',operation:'run',phase:'gate',decision:'reject',code:'DIRECTORY_FOCUS',focusId:null,callClass:'effect'}});
  const ref=ev.callRef(r.id,call.id),entry=f.bundle.machine.entries.find(e=>e.callRef===ref);entry.sequence=50;Object.assign(entry.metadata,{tool:'relay_workspace',action:'run',success:false,status:'failed',code:'DIRECTORY_FOCUS'});
  f.bundle.machine.entries.push({at,sequence:48,kind:'directory.effect',callRef:ref,metadata:{tool:'relay_workspace',operation:'run',phase:'gate',decision:'reject',code:'DIRECTORY_FOCUS',callClass:'effect'}});
  f.bundle.machine.coverage.entryMetadataOmitted=0;
  f.bundle.ledger.state.receipts=f.bundle.ledger.state.receipts.filter(x=>x.id!=='receipt-3');
  r.status='failed';r.nodes.agent.directoryContext.hostTools={received:4,returned:3,threw:1};
  f.bundle.ledger.final={ready:false,reason:'pending-actions',unknown:[]};
  return {f,callId:call.id,ref};
}
test('V2 native DIRECTORY_FOCUS denial is an unexecuted attempt, never a public test',()=>{const {f,callId}=rejectedCommandFixture(),p=ev.projectEvidence(f);assert.deepEqual(p.validation.issues,[]);assert.equal(p.receipt.actions.settled,true);assert.equal(p.receipt.actions.commands.length,0);assert.equal(p.receipt.actions.unexecutedCommandAttempts.length,1);const a=p.receipt.actions.unexecutedCommandAttempts[0];assert.equal(a.callId,callId);assert.equal(a.executed,false);assert.equal(a.exitCode,null);assert.equal(a.report,null);assert.equal(a.receiptId,null);assert.equal(p.receipt.actions.failures.length,1);assert.equal(p.receipt.actions.failures[0].code,'DIRECTORY_FOCUS');assert.equal(p.receipt.evidence.hostReceived,4);assert.equal(p.receipt.completion.agentCompleted,false);});
test('V2 denial text or error code without positive gate proof remains unverified',()=>{for(const missing of ['raw-gate','machine-gate','complete-coverage']){const {f,ref}=rejectedCommandFixture();if(missing==='raw-gate')f.bundle.run.events=f.bundle.run.events.filter(e=>e.data?.type!=='directory.effect');else if(missing==='machine-gate')f.bundle.machine.entries=f.bundle.machine.entries.filter(e=>e.callRef!==ref||e.kind!=='directory.effect');else f.bundle.machine.coverage.entryMetadataOmitted=1;const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false,missing);assert.equal(p.receipt.actions.settled,false);assert.equal(p.receipt.actions.unexecutedCommandAttempts.length,0);assert.match(p.validation.issues.join('\n'),/Full command receipt/);}});
test('V2 dispatch evidence or an unknown effect defeats a command-denial inference',()=>{for(const mode of ['raw-dispatch','machine-dispatch','unknown-receipt']){const {f,callId,ref}=rejectedCommandFixture();if(mode==='raw-dispatch')f.bundle.run.events.push({runId:'owned_run',nodeId:'agent',data:{type:'directory.effect',callId,phase:'dispatch'}});else if(mode==='machine-dispatch')f.bundle.machine.entries.push({sequence:49,kind:'directory.effect',callRef:ref,metadata:{phase:'dispatch'}});else{f.bundle.ledger.state.receipts.push({id:'receipt-9',runId:'owned_run',nodeId:'agent',tool:'relay_workspace',state:'unknown',success:null});f.bundle.ledger.final.unknown=['receipt-9'];}const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false,mode);assert.equal(p.receipt.actions.settled,false);if(mode!=='unknown-receipt')assert.equal(p.receipt.actions.unexecutedCommandAttempts.length,0);else assert.equal(p.receipt.actions.unknownEffectCount,1);}});


// M3: completeness is a property of independently checked evidence, not a supplied flag.
const incompleteTraceCases=[
  ['missing coverage',f=>{delete f.bundle.machine.coverage;}],
  ['missing dropped count',f=>{delete f.bundle.machine.coverage.dropped;}],
  ['dropped events',f=>{f.bundle.machine.coverage.dropped=1;}],
  ['missing metadata omission count',f=>{delete f.bundle.machine.coverage.entryMetadataOmitted;}],
  ['omitted metadata',f=>{f.bundle.machine.coverage.entryMetadataOmitted=1;}],
  ['missing gap inventory',f=>{delete f.bundle.machine.coverage.gaps;}],
  ['recorded gap',f=>{f.bundle.machine.coverage.gaps=['missing segment'];}],
  ['invalid gap inventory',f=>{f.bundle.machine.coverage.gaps={};}],
  ['missing event inventory',f=>{delete f.bundle.machine.entries;}]
];
for(const [name,change]of incompleteTraceCases)test('M3 rejects '+name+' from an otherwise successful run',()=>{
  const f=fixture();change(f);const p=ev.projectEvidence(f);
  assert.equal(p.validation.valid,false);assert.equal(p.receipt.actions.settled,false);
  assert.equal(p.receipt.evidence.toolTimelineComplete,false);assert.equal(p.receipt.completion.agentCompleted,false);
  assert.match(p.validation.issues.join('\n'),/machine trace/);
});
function pagedFixture(){
  const f=fixture(),page=f.bundle.receiptPages.tools.pages[0];
  f.bundle.receiptPages.tools.pages=[{...page,offset:0,nextOffset:50},{...page,offset:50,nextOffset:null}];
  return f;
}
test('M3 accepts contiguous pages with one revision per view and independent revisions across views',()=>{
  const p=ev.projectEvidence(pagedFixture());assert.deepEqual(p.validation.issues,[]);
  assert.equal(p.receipt.actions.settled,true);assert.equal(p.receipt.completion.agentCompleted,true);
});
const incompletePageCases=[
  ['missing revision',pages=>{for(const p of pages)delete p.revision;}],
  ['missing cursor',pages=>{delete pages[0].offset;}],
  ['nonzero initial cursor',pages=>{pages[0].offset=10;}],
  ['changed revision',pages=>{pages[1].revision='different-revision';}],
  ['skipped cursor',pages=>{pages[1].offset=51;}],
  ['nonadvancing cursor',pages=>{pages[0].nextOffset=0;pages[1].offset=0;}],
  ['unfinished final cursor',pages=>{pages[1].nextOffset=100;}]
];
for(const [name,change]of incompletePageCases)test('M3 rejects '+name+' despite a complete receipt-view flag',()=>{
  const f=pagedFixture();change(f.bundle.receiptPages.tools.pages);const p=ev.projectEvidence(f);
  assert.equal(p.validation.valid,false);assert.equal(p.receipt.actions.settled,false);
  assert.equal(p.receipt.evidence.toolTimelineComplete,false);assert.equal(p.receipt.completion.agentCompleted,false);
  assert.match(p.validation.issues.join('\n'),/Native receipt pages incomplete or mismatched: tools/);
});
function unavailableFixture(){
  const f=fixture(),id='unavailable_call';
  f.providerThread.transcript.push({role:'assistant',tool_calls:[{id,function:{name:'relay_delegate',arguments:'{"action":"start"}'}}]},{role:'tool',tool_call_id:id,content:'This tool is not attached to the active agent.'});
  f.bundle.run.events.push({id:'unavailable_event',runId:'owned_run',nodeId:'agent',data:{type:'tool.result',callId:id,tool:'relay_delegate',action:'start',success:false,status:'failed',code:'TOOL_UNAVAILABLE'}});
  return {f,id};
}
for(const kind of ['raw','machine'])test('M3 '+kind+' dispatch defeats unavailable-tool no-dispatch evidence',()=>{
  const {f,id}=unavailableFixture();
  if(kind==='raw')f.bundle.run.events.push({runId:'owned_run',nodeId:'agent',data:{type:'directory.effect',callId:id,tool:'relay_delegate',phase:'dispatch'}});
  else f.bundle.machine.entries.push({sequence:999,kind:'directory.effect',callRef:ev.callRef('owned_run',id),metadata:{tool:'relay_delegate',phase:'dispatch'}});
  const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false);assert.equal(p.receipt.actions.settled,false);
  assert.equal(p.directoryProof.calls.at(-1).knownNoDispatch,false);assert.equal(p.receipt.actions.failures.length,1);
  assert.ok(p.receipt.actions.unexpectedWork.some(x=>x.callId===id));assert.match(p.validation.issues.join('\n'),/Dispatch contradicts unavailable-tool result/);
});
test('M3 raw dispatch keeps an interrupted tool result unresolved',()=>{
  const {f,id}=unavailableFixture();
  f.providerThread.transcript.at(-1).content='This tool was interrupted before its result could be confirmed';
  f.bundle.run.events.push({runId:'owned_run',nodeId:'agent',data:{type:'directory.effect',callId:id,tool:'relay_delegate',phase:'dispatch'}});
  const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false);assert.equal(p.receipt.actions.settled,false);
  assert.match(p.validation.issues.join('\n'),/Interrupted operation absence\/settlement unproven/);
});

function explicitRefusalFixture({code='TOOL_ACTION_INVALID',hostHandlerEntered=true,args={action:'focus'}}={}){
 const f=fixture(),run=f.bundle.run,id='explicit_refusal',tool='relay_workspace';
 const result={code,actionDispatched:false,message:'Rejected before an effect.'};
 f.providerThread.transcript.push({role:'assistant',tool_calls:[{id,function:{name:tool,arguments:JSON.stringify(args)}}]},{role:'tool',tool_call_id:id,content:JSON.stringify(result)});
 run.events.push({id:'explicit_refusal_event',runId:run.id,nodeId:'agent',at,timelineOrder:99,type:'agent.event',data:{type:'tool.result',callId:id,tool,action:args?.action||'call',success:false,status:'failed',code,actionDispatched:false,hostHandlerEntered}});
 const ref=ev.callRef(run.id,id);f.bundle.machine.entries.push({sequence:99,kind:'tool.result',callRef:ref,metadata:{tool,action:args?.action||'call',success:false,status:'failed',code,actionDispatched:false,hostHandlerEntered}});
 if(hostHandlerEntered){run.nodes.agent.directoryContext.hostTools.received++;run.nodes.agent.directoryContext.hostTools.returned++;}
 run.status='failed';f.bundle.ledger.final={ready:false,reason:'pending-actions',unknown:[]};
 return {f,id,ref};
}
test('M3 explicit M1 denial counts handler entry without inventing a dispatch or receipt',()=>{
 const {f,id}=explicitRefusalFixture(),p=ev.projectEvidence(f),call=p.directoryProof.calls.find(x=>x.id===id);
 assert.deepEqual(p.validation.issues,[]);assert.equal(call.knownNoDispatch,true);assert.equal(call.hostHandlerEntered,true);assert.equal(call.receipt,null);
 assert.equal(p.receipt.evidence.hostReceived,4);assert.equal(p.receipt.actions.settled,true);assert.equal(p.receipt.completion.agentCompleted,false);
});
test('M3 explicit M6 command refusal is an unexecuted attempt outside host handler counters',()=>{
 const {f,id}=explicitRefusalFixture({code:'BENCHMARK_COMMAND',hostHandlerEntered:false,args:{action:'run',command:'node test-public.cjs; echo hidden'}}),p=ev.projectEvidence(f);
 assert.deepEqual(p.validation.issues,[]);assert.equal(p.receipt.evidence.hostReceived,3);assert.equal(p.receipt.actions.commands.length,1);
 const attempt=p.receipt.actions.unexecutedCommandAttempts.find(x=>x.callId===id);assert.ok(attempt);assert.equal(attempt.executed,false);assert.equal(attempt.exitCode,null);assert.equal(attempt.report,null);assert.equal(attempt.receiptId,null);
 assert.equal(p.receipt.actions.unexpectedWork.length,0);assert.equal(p.directoryProof.calls.find(x=>x.id===id).hostHandlerEntered,false);
});
for(const code of ['BENCHMARK_PATH','BENCHMARK_SCOPE','BENCHMARK_SCAFFOLD_CHANGED'])test('M3 '+code+' pre-counter refusal has exact corroborated no-effect proof',()=>{
 const {f,id}=explicitRefusalFixture({code,hostHandlerEntered:false,args:{action:'read',path:'../private'}}),p=ev.projectEvidence(f);
 assert.equal(p.validation.valid,true);assert.equal(p.directoryProof.calls.find(x=>x.id===id).knownNoDispatch,true);assert.equal(p.receipt.evidence.hostReceived,3);
});
test('M3 malformed arguments with complete explicit rejection proof are opaque failed attempts',()=>{
 const {f,id}=explicitRefusalFixture({code:'TOOL_ARGUMENTS_INVALID',args:[]}),p=ev.projectEvidence(f),call=p.directoryProof.calls.find(x=>x.id===id);
 assert.deepEqual(p.validation.issues,[]);assert.equal(call.knownNoDispatch,true);assert.equal(call.arguments,null);assert.equal(call.argumentInterpretation,'opaque-host-rejected');
 assert.equal(p.receipt.actions.failures.at(-1).opaqueArguments,true);assert.equal(p.receipt.actions.failures.at(-1).argumentsSha256,api.sha('[]'));
 assert.equal(p.receipt.actions.commands.length,1);assert.equal(p.receipt.actions.unexecutedCommandAttempts.length,0);
});
test('M3 refusal proof requires every raw and machine dispatch/handler/code field',()=>{
 for(const [view,key]of [['raw','actionDispatched'],['raw','hostHandlerEntered'],['raw','code'],['machine','actionDispatched'],['machine','hostHandlerEntered'],['machine','code']]){
  const {f,id,ref}=explicitRefusalFixture({code:'BENCHMARK_PATH',hostHandlerEntered:false});
  const data=view==='raw'?f.bundle.run.events.find(x=>x.data?.callId===id).data:f.bundle.machine.entries.find(x=>x.callRef===ref).metadata;
  delete data[key];const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false,view+' '+key);assert.equal(p.directoryProof.calls.find(x=>x.id===id).knownNoDispatch,false);
 }
});
test('M3 a transcript JSON assertion alone cannot prove non-dispatch',()=>{
 const {f,id,ref}=explicitRefusalFixture({code:'BENCHMARK_COMMAND',hostHandlerEntered:false,args:{action:'run',command:'node test-public.cjs'}});
 for(const data of [f.bundle.run.events.find(x=>x.data?.callId===id).data,f.bundle.machine.entries.find(x=>x.callRef===ref).metadata]){delete data.actionDispatched;delete data.hostHandlerEntered;}
 const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false);assert.equal(p.receipt.actions.unexecutedCommandAttempts.length,0);assert.ok(p.validation.issues.some(x=>x.includes('Full command receipt')));
});
test('M3 either raw or machine dispatch defeats explicit refusal proof',()=>{
 for(const view of ['raw','machine']){
  const {f,id,ref}=explicitRefusalFixture({code:'BENCHMARK_PATH',hostHandlerEntered:false});
  if(view==='raw')f.bundle.run.events.push({runId:f.bundle.run.id,nodeId:'agent',data:{type:'directory.effect',callId:id,phase:'dispatch'}});
  else f.bundle.machine.entries.push({sequence:100,kind:'directory.effect',callRef:ref,metadata:{phase:'dispatch'}});
  const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false);assert.equal(p.directoryProof.calls.find(x=>x.id===id).knownNoDispatch,false);
 }
});
test('M3 contradictory handler entry cannot reconcile a refusal',()=>{
 const {f,id,ref}=explicitRefusalFixture({code:'BENCHMARK_PATH',hostHandlerEntered:false});
 f.bundle.machine.entries.find(x=>x.callRef===ref).metadata.hostHandlerEntered=true;
 const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false);assert.equal(p.directoryProof.calls.find(x=>x.id===id).knownNoDispatch,false);
});
test('M3 refusal proof does not repair an incorrect actual handler counter',()=>{
 const {f}=explicitRefusalFixture({code:'BENCHMARK_PATH',hostHandlerEntered:false});f.bundle.run.nodes.agent.directoryContext.hostTools={received:4,returned:4,threw:0};
 const p=ev.projectEvidence(f);assert.equal(p.validation.valid,false);assert.ok(p.validation.issues.some(x=>x.includes('handler count')));
});
test('M3 unknown refusal codes and incomplete coverage cannot establish absence',()=>{
 for(const mutate of [
  x=>{x.f.bundle.machine.coverage.entryMetadataOmitted=1;},
  x=>{x.f.bundle.run.events.find(e=>e.data?.callId===x.id).data.code='BENCHMARK_INVENTED';x.f.bundle.machine.entries.find(e=>e.callRef===x.ref).metadata.code='BENCHMARK_INVENTED';x.f.providerThread.transcript.at(-1).content=JSON.stringify({code:'BENCHMARK_INVENTED',actionDispatched:false});},
  x=>{x.f.bundle.run.events.find(e=>e.data?.callId===x.id).nodeId='foreign';}
 ]){
  const x=explicitRefusalFixture({code:'BENCHMARK_PATH',hostHandlerEntered:false});mutate(x);const p=ev.projectEvidence(x.f);
  assert.equal(p.validation.valid,false);assert.equal(p.directoryProof.calls.find(c=>c.id===x.id).knownNoDispatch,false);
 }
});

test('M3 opaque syntax failure cannot become METHOD or command evidence through substring repair',()=>{
 const {f,id}=explicitRefusalFixture({code:'TOOL_ARGUMENTS_INVALID',args:[]});
 f.providerThread.transcript.find(x=>x.tool_calls?.[0]?.id===id).tool_calls[0].function.arguments='{"action":"run","command":"node test-public.cjs",broken';
 let p=ev.projectEvidence(f);assert.equal(p.validation.valid,true);assert.equal(p.receipt.actions.failures.at(-1).opaqueArguments,true);assert.equal(p.receipt.actions.commands.length,1);assert.equal(p.receipt.actions.unexecutedCommandAttempts.length,0);
 f.config.method={deliveryMode:'file-read',path:'METHOD.md',sha256:f.config.method.sha256};
 f.providerThread.transcript.find(x=>x.tool_calls?.[0]?.id===id).tool_calls[0].function.arguments='{"action":"read","path":"METHOD.md",broken';
 p=ev.projectEvidence(f);assert.equal(p.validation.valid,false);assert.equal(p.receipt.evidence.methodDelivery.proven,false);assert.equal(p.receipt.evidence.methodDelivery.reads.length,1);
});
test('M3 opaque arguments remain invalid when rejection provenance is absent, contradictory or dispatching',()=>{
 for(const mutate of [
  ({f,id})=>{delete f.bundle.run.events.find(e=>e.data?.callId===id).data.actionDispatched;},
  ({f,ref})=>{delete f.bundle.machine.entries.find(e=>e.callRef===ref).metadata.hostHandlerEntered;},
  ({f,ref})=>{f.bundle.machine.entries.find(e=>e.callRef===ref).metadata.hostHandlerEntered=false;},
  ({f,id})=>{f.bundle.run.events.push({runId:f.bundle.run.id,nodeId:'agent',data:{type:'directory.effect',callId:id,phase:'dispatch'}});},
  ({f})=>{f.bundle.machine.coverage.dropped=1;}
 ]){
  const value=explicitRefusalFixture({code:'TOOL_ARGUMENTS_INVALID',args:[]});mutate(value);const p=ev.projectEvidence(value.f);
  assert.equal(p.validation.valid,false);assert.ok(p.validation.issues.includes('Unparseable tool call '+value.id));assert.equal(p.directoryProof.calls.find(c=>c.id===value.id).argumentInterpretation,'unresolved');
 }
});
