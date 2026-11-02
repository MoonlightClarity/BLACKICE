import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
import {WorkbenchAgentJobs,createWorkbenchAgentToolHandler,workbenchAgentToolForAuthorization,workbenchFramePng,validateWorkbenchVerification,evaluateWorkbenchAssertions,WORKBENCH_AGENT_TOOL,WORKBENCH_AGENT_INSTRUCTIONS} from '../lib/workbench-agent-tools.mjs';
import {createWorkbenchJobLease} from '../lib/workbench-job-lease.mjs';

const agentId='a'.repeat(32),scope='test-vm-task';
function bmp(){const b=Buffer.alloc(70);b.write('BM');b.writeUInt32LE(70,2);b.writeUInt32LE(54,10);b.writeUInt32LE(40,14);b.writeInt32LE(2,18);b.writeInt32LE(-2,22);b.writeUInt16LE(1,26);b.writeUInt16LE(32,28);Buffer.from([0,0,255,0,0,255,0,0,255,0,0,0,255,255,255,0]).copy(b,54);return {bytes:b,width:2,height:2,sequence:7};}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-agent-tools-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'.blackice-workbench'));const supervisor=path.join(root,'safe-supervisor.ps1');await fs.writeFile(supervisor,'# source-only fake supervisor');
  const agent={online:true,paired:true,sharedReadWriteVerified:true,guestName:'GUEST',guestSessionId:2,agentId,heartbeatAt:new Date().toISOString(),expectedGuestRoot:'W:\\',capabilities:['launch','windows','capture','type']};
  const calls=[],events=[];let state;
  const bridge={workspace:root,agentStatus:async()=>({...agent}),request:async(kind,args)=>{calls.push({kind,args});return {status:'completed',kind,requestId:'b'.repeat(32),agentId,guestSessionId:2,result:{processId:42}};}};
  const workbench={consoleControl:new WorkbenchConsoleControl(),bridge:()=>bridge,status:async()=>structuredClone(state),guestNativeConsoleFrame:async()=>bmp(),nativeConsoleAdapter:{surface:async()=>({width:2,height:2}),input:async(value,check)=>{check();calls.push({input:value});return {accepted:true};}}};
  workbench.guestNativeConsoleWake=()=>workbench.consoleControl.run(async assertCurrent=>{assertCurrent();calls.push({kind:'wake'});return {requested:true,consoleControl:workbench.consoleControl.status()};});
  state={backend:'hyper-v',vmName:'BLACKICE-Workbench',guest:{running:true},canRunNativeApps:true,capability:{hostName:'HOST'},config:{folders:[{id:'workspace',hostPath:root,readWrite:true,guestMountVerified:true,hostSharePrepared:true}]}};
  const jobs=new WorkbenchAgentJobs({workbench,hostName:()=> 'HOST',supervisor,leaseKeeperFactory:()=>({ready:Promise.resolve(),error:null,stop:async()=>{}})});
  const handler=createWorkbenchAgentToolHandler({workbench,scope,jobs,onEvent:event=>events.push(event)});
  const call=(action,args={})=>handler({name:'relay_workbench',arguments:{action,...args}});
  return {root,agent,bridge,calls,events,workbench,jobs,call,state,handler};
}
const value=result=>JSON.parse(result.contentItems.find(x=>x.type==='inputText').text);
async function complete(f,jobId,changes={}){const folder=path.join(f.root,'.blackice-workbench','agent-jobs',jobId),meta=JSON.parse(await fs.readFile(path.join(folder,'job.json'),'utf8'));const result={version:1,jobId,scopeHash:meta.scopeHash,scriptSha256:meta.scriptSha256,agentId:meta.agentId,guestSessionId:meta.guestSessionId,status:'completed',exitCode:0,stdout:'verified install receipt',stderr:'',childrenStopped:true,finishedAt:new Date().toISOString(),...changes};await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(result));return meta;}

test('verification metadata leaves the frozen tool catalog and instructions byte-identical',()=>{
  const sha=value=>createHash('sha256').update(value).digest('hex');
  assert.equal(sha(JSON.stringify(WORKBENCH_AGENT_TOOL)),'c6d372e60f46a6d69b97fb8af2ff366c00a24aa9c4cca94db9bdbaece93bedfa');
  assert.equal(sha(WORKBENCH_AGENT_INSTRUCTIONS),'68af7ae9c85547fc14393246e5dcdad09cdfcf4a6026469734746c39c5d296d8');
});

test('existing primitive equality, case-sensitive substrings and trimmed-string checks retain their semantics',()=>{
  const observations={text:' Receipt-A ',empty:' \t\n',number:1,flag:true,nil:null,ids:['private-receipt-A'],object:{private:'value'}};
  const check=(path,operator,expected)=>evaluateWorkbenchAssertions(JSON.stringify(observations),[{criterionId:'proof',path,operator,...(expected===undefined?{}:{expected})}]).results[0];
  assert.equal(check('text','equals',' Receipt-A ').passed,true);assert.equal(check('text','equals',' receipt-a ').passed,false);
  assert.equal(check('number','equals',1).passed,true);assert.equal(check('number','equals','1').passed,false);
  assert.equal(check('flag','equals',true).passed,true);assert.equal(check('nil','equals',null).passed,true);
  assert.equal(check('text','includes','Receipt-A').passed,true);assert.equal(check('text','includes','receipt-a').passed,false);
  assert.equal(check('text','notEmpty').passed,true);assert.equal(check('empty','notEmpty').passed,false);
  for(const [path,operator,type] of [['ids','includes','array'],['object','equals','object'],['number','notEmpty','number'],['nil','includes','null']]){
    const result=check(path,operator,operator==='equals'?null:operator==='includes'?'private-receipt-A':undefined);
    assert.equal(result.passed,false);assert.equal(result.diagnostic.code,'WORKBENCH_VERIFICATION_TYPE_MISMATCH');assert.equal(result.diagnostic.actualType,type);
    assert.equal(JSON.stringify(result).includes('private-receipt-A'),false,'A type diagnostic does not echo observation contents.');
  }
  assert.equal(check('ids.0','includes','private-receipt-A').passed,false,'Array traversal is not an own-object field path.');
});

test('the actual receipt-ID array mistake reports its type and cannot issue an effect receipt',async t=>{
  const f=await fixture(t),bindings=new Map(),effects=[],planRef={requestId:'p',cycleId:'c',nodeId:'plan',nodeRevision:1,responseId:'r'};
  const handler=createWorkbenchAgentToolHandler({workbench:f.workbench,scope,jobs:f.jobs,getVerificationContext:async()=>({planRef,criterionIds:['artifact']}),getVerificationBinding:id=>bindings.get(id),recordVerificationBinding:async binding=>bindings.set(binding.jobId,binding),recordVerifiedEffects:async record=>effects.push(record)});
  const call=(action,args={})=>handler({name:'relay_workbench',arguments:{action,...args}});
  const started=value(await call('verify_guest_script',{requestId:'actual-array-misuse',script:'Read the persisted receipt IDs.',timeoutMs:4000,planRef,criterionIds:['artifact'],assertions:[{criterionId:'artifact',path:'checks.recordedEffectIds',operator:'includes',expected:'effect-installation'}]}));
  await complete(f,started.jobId,{stdout:JSON.stringify({checks:{recordedEffectIds:['effect-installation','effect-roundtrip']}}),stdoutTruncated:false,stderrTruncated:false,outputDrained:true});await f.jobs.active.work;
  const result=await call('guest_job',{jobId:started.jobId}),failed=value(result);
  assert.equal(result.success,false);assert.equal(failed.executionStatus,'completed');assert.equal(failed.verification.code,'WORKBENCH_VERIFICATION_TYPE_MISMATCH');
  assert.match(failed.verification.message,/checks\.recordedEffectIds is array/);assert.match(failed.verification.message,/case-sensitive STRING substring only/);assert.match(failed.verification.message,/do not replay/);
  assert.equal(failed.verification.assertions[0].diagnostic.actualType,'array');assert.equal(effects.length,0);await handler.close();
});

test('status exposes the exact host-verifier request shape and only current host-bound assertion targets',async t=>{
  const f=await fixture(t),planRef={requestId:'p',cycleId:'c',nodeId:'plan',nodeRevision:1,responseId:'r'},auth={scope:'configured-vm',control:'agent',source:'explicit-user-task',consumed:true,agentRevision:0};let readinessRef=planRef,effects=0;
  const handler=createWorkbenchAgentToolHandler({workbench:f.workbench,scope,jobs:f.jobs,getAuthorization:()=>auth,getVerificationContext:async()=>({planRef,criterionIds:['installation','handback']}),getHandoffReadiness:async()=>({ready:false,planRef:readinessRef,pendingCriterionIds:['handback'],eligibleDeferredControlCriteria:[{id:'handback',verification:'effect'}]}),recordVerificationBinding:async()=>{},recordVerifiedEffects:async()=>{},recordVerifiedControlEffects:async()=>{effects++;return {receipts:[]}}});
  const call=(action,args={})=>handler({name:'relay_workbench',arguments:{action,...args}});
  const before=value(await call('status')).verification,contract=before.controlState;
  assert.deepEqual(contract.requiredFields,['action','requestId','planRef','assertions']);assert.deepEqual(contract.allowedFields,['action','requestId','planRef','criterionIds','assertions']);
  assert.equal(contract.requestId.pattern,'^[A-Za-z0-9_-]{1,80}$');assert.match(contract.expectedRevision,/Not accepted/);assert.deepEqual(contract.planRef,planRef);
  assert.equal(contract.readyForObservation,false);assert.equal(contract.assertionTargets.length,3);assert.equal(contract.assertionTargets.some(a=>a.path==='control.revision'),false,'No future USER revision is invented.');
  assert.deepEqual(contract.eligibleCriterionIds,['handback']);assert.match(before.operatorContracts.includes.comparison,/STRING substring only/);assert.deepEqual(before.operatorContracts.notEmpty.observationTypes,['string']);
  before.operatorContracts.includes.observationTypes.push('array');assert.deepEqual(value(await call('status')).verification.operatorContracts.includes.observationTypes,['string'],'Response metadata cannot mutate the contract.');
  const args={requestId:'host-proof',planRef:contract.planRef,criterionIds:contract.eligibleCriterionIds,assertions:contract.assertionTargets};
  assert.equal((await call('verify_control_state',args)).code,'WORKBENCH_VERIFICATION_STALE');assert.equal(effects,0);
  const user=await f.workbench.consoleControl.take();Object.assign(auth,{returned:true,userRevision:user.revision,featuresRestored:true});
  const after=value(await call('status')).verification.controlState;assert.equal(after.readyForObservation,true);assert.equal(after.assertionTargets.at(-1).expected,user.revision);assert.equal(after.assertionTargets.at(-1).path,'control.revision');
  assert.equal((await call('verify_control_state',{...args,expectedRevision:user.revision})).code,'WORKBENCH_AGENT_INVALID');
  assert.equal((await call('verify_control_state',{planRef,assertions:after.assertionTargets})).code,'WORKBENCH_AGENT_INVALID');
  assert.equal((await call('verify_control_state',{requestId:'host-proof',planRef:after.planRef,criterionIds:after.eligibleCriterionIds,assertions:after.assertionTargets})).success,true);assert.equal(effects,1);
  readinessRef={...planRef,responseId:'new-plan'};const stale=value(await call('status')).verification.controlState;
  assert.equal(stale.readyForObservation,false);assert.equal(Object.hasOwn(stale,'assertionTargets'),false);assert.equal(Object.hasOwn(stale,'planRef'),false,'Different Plan snapshots cannot supply host assertion targets.');
  await handler.close();
});

test('native capture is a real PNG with decoded BGR orientation and no pixels in events',async t=>{
  const f=await fixture(t);await f.workbench.consoleControl.take();const result=await f.call('capture');assert.equal(result.success,true);assert.equal(value(result).basis,'native-decoded-surface');assert.equal(value(result).sequence,7);
  const png=Buffer.from(result.contentItems[1].imageUrl.split(',')[1],'base64');assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  let at=8,compressed=[];while(at<png.length){const len=png.readUInt32BE(at),kind=png.toString('ascii',at+4,at+8);if(kind==='IDAT')compressed.push(png.subarray(at+8,at+8+len));at+=len+12;}
  assert.deepEqual([...inflateSync(Buffer.concat(compressed))],[0,255,0,0,0,255,0,0,0,0,255,255,255,255]);
  assert.equal(JSON.stringify(f.events).includes('base64'),false);assert.throws(()=>workbenchFramePng({...bmp(),width:4097}));
});

test('USER and unknown ownership reject guest input and scripts before staging/dispatch',async t=>{
  const f=await fixture(t);await f.workbench.consoleControl.take();
  assert.equal((await f.call('input',{input:{kind:'mouse',x:0,y:0,flags:0x800}})).success,false);
  assert.equal((await f.call('run_guest_script',{requestId:'install-1',script:'Write-Output test'})).success,false);
  assert.equal(f.calls.length,0);await assert.rejects(fs.stat(path.join(f.root,'.blackice-workbench','agent-jobs')),{code:'ENOENT'});
  f.workbench.consoleControl.owner='none';assert.equal((await f.call('input',{input:{kind:'mouse',x:0,y:0,flags:0x800}})).success,false);
});

test('fresh guest pairing and actual surface bounds fence native input',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('input',{input:{kind:'mouse',x:1,y:1,flags:0x800}})).success,true);
  assert.equal((await f.call('input',{input:{kind:'mouse',x:2,y:1,flags:0x800}})).success,false);
  f.agent.paired=false;assert.equal((await f.call('input',{input:{kind:'mouse',x:0,y:0,flags:0x800}})).success,false);assert.equal(f.calls.length,1);
});

test('fresh paired readiness replaces only older derived guest flags and preserves every concrete prerequisite',async t=>{
  const f=await fixture(t);f.state.canRunNativeApps=false;f.state.config.folders[0].guestMountVerified=false;
  assert.equal((await f.call('input',{input:{kind:'mouse',x:1,y:1,flags:0x0800}})).success,true,'Fresh paired mount/capabilities must supersede stale derived status flags.');
  f.state.config.folders[0].hostSharePrepared=false;let rejected=await f.call('input',{input:{kind:'mouse',x:1,y:1,flags:0x0800}});assert.equal(value(rejected).prerequisite,'host_share');
  f.state.config.folders[0].hostSharePrepared=true;f.agent.online=false;rejected=await f.call('input',{input:{kind:'mouse',x:1,y:1,flags:0x0800}});assert.equal(value(rejected).prerequisite,'guest_online');
  f.agent.online=true;f.state.guest.agent={agentId:'d'.repeat(32),guestSessionId:2};rejected=await f.call('input',{input:{kind:'mouse',x:1,y:1,flags:0x0800}});assert.equal(value(rejected).prerequisite,'guest_identity_changed');
  assert.equal(f.calls.length,1);
});

test('verification derives only explicit assertion IDs and still rejects unknown or mismatched criteria',async t=>{
  const f=await fixture(t),planRef={requestId:'p',cycleId:'c',nodeId:'n',nodeRevision:1,responseId:'r'},assertions=[{criterionId:'handback',path:'control.owner',operator:'equals',expected:'user'}];
  assert.deepEqual(validateWorkbenchVerification({planRef,assertions}).criterionIds,['handback']);
  assert.throws(()=>validateWorkbenchVerification({planRef,criterionIds:['different'],assertions}),{code:'WORKBENCH_VERIFICATION_INVALID'});
  assert.throws(()=>validateWorkbenchVerification({planRef,assertions:[{path:'control.owner',operator:'equals',expected:'user'}]}),{code:'WORKBENCH_VERIFICATION_INVALID'});
  let effects=0;const h=createWorkbenchAgentToolHandler({workbench:f.workbench,scope,jobs:f.jobs,getVerificationContext:async()=>({planRef,criterionIds:['handback']}),recordVerificationBinding:async()=>{},recordVerifiedEffects:async()=>{},recordVerifiedControlEffects:async()=>{effects++;}});
  const result=await h({name:'relay_workbench',arguments:{action:'verify_control_state',requestId:'unknown-criterion',planRef,assertions:[{criterionId:'not-in-plan',path:'control.owner',operator:'equals',expected:'user'}]}});assert.equal(result.code,'WORKBENCH_VERIFICATION_STALE');assert.equal(effects,0);await h.close();
});

test('explicit display wake uses only the existing guest-native ownership fence and never claims visible pixels',async t=>{
  const f=await fixture(t),before=f.workbench.consoleControl.status(),wake=await f.call('wake_display');
  assert.equal(wake.success,true);assert.equal(value(wake).requested,true);assert.equal(value(wake).displayAwake,undefined);assert.equal(value(wake).movesRequested,2);assert.match(value(wake).meaning,/Capture again/);assert.deepEqual(f.workbench.consoleControl.status(),before);assert.deepEqual(f.calls,[{kind:'wake'},{input:{kind:'mouse',x:0,y:1,flags:0x0800}},{input:{kind:'mouse',x:1,y:1,flags:0x0800}}]);
  await f.workbench.consoleControl.take();assert.equal((await f.call('wake_display')).success,false);assert.equal(f.calls.length,3);
  f.workbench.consoleControl.owner='none';assert.equal((await f.call('wake_display')).success,false);assert.equal(f.calls.length,3);
});

test('a human Take during the wake pair fences its return move and waits for dispatched input',async t=>{
  const f=await fixture(t);let release,started;const held=new Promise(r=>{release=r}),began=new Promise(r=>{started=r});
  f.workbench.nativeConsoleAdapter.input=async(input,check)=>{check();f.calls.push({input});started();await held;return {accepted:true};};
  const waking=f.call('wake_display');await began;let taken=false;const take=f.workbench.consoleControl.take().then(value=>{taken=true;return value;});
  await new Promise(r=>setTimeout(r,10));assert.equal(taken,false);release();
  assert.equal((await waking).success,false);assert.equal((await take).owner,'user');assert.equal(f.calls.filter(x=>x.input).length,1,'A revoked wake never sends its second MOVE after the human takes control.');
});

test('the real manager lease keeper survives a blocked main thread until actual fake-guest completion',async t=>{
  const f=await fixture(t);f.jobs.leaseKeeperFactory=createWorkbenchJobLease;
  const started=value(await f.call('run_guest_script',{requestId:'worker-real-manager',script:'Write-Output synthetic',timeoutMs:6000})),work=f.jobs.active.work;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2500);
  const lease=JSON.parse(await fs.readFile(path.join(f.root,'.blackice-workbench','agent-jobs',started.jobId,'lease.json'),'utf8'));
  assert.ok(Date.parse(lease.expiresAt)>Date.now()+800,'The manager must use the worker, not the stalled main-thread renewal loop.');
  await complete(f,started.jobId,{terminationReason:'script_exit',stage:'cleanup'});await work;
  const final=value(await f.call('guest_job',{jobId:started.jobId}));assert.equal(final.terminationReason,'script_exit');assert.equal(final.stage,'cleanup');
});

test('durable guest script ID launches only guest hidden STA and polls actual matching completion',async t=>{
  const f=await fixture(t),args={requestId:'install-one',script:'Write-Output "你好 test"',timeoutMs:4000};
  const started=value(await f.call('run_guest_script',args));assert.equal(started.status,'running');assert.match(started.jobId,/^[a-f0-9]{32}$/);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.appPath,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');assert.ok(f.calls[0].args.arguments.includes('-Sta'));assert.ok(f.calls[0].args.arguments.includes('Hidden'));assert.match(f.calls[0].args.arguments.at(-1),/^W:\\.blackice-workbench\\agent-jobs\\[a-f0-9]{32}\\supervisor.ps1$/);
  const again=value(await f.call('run_guest_script',args));assert.equal(again.jobId,started.jobId);assert.equal(f.calls.length,1);
  assert.equal((await f.call('run_guest_script',{...args,script:'different'})).code,'WORKBENCH_AGENT_REQUEST_CONFLICT');
  await complete(f,started.jobId);await f.jobs.active.work;const final=value(await f.call('guest_job',{jobId:started.jobId}));assert.equal(final.status,'completed');assert.equal(final.stdout,'verified install receipt');assert.equal(final.childrenStopped,true);
  assert.equal(JSON.stringify(f.events).includes('你好'),false);
});

test('Take waits for actual cancelled child-tree receipt before acknowledging USER',async t=>{
  const f=await fixture(t);const job=value(await f.call('run_guest_script',{requestId:'cancel-on-take',script:'Start-Sleep 30',timeoutMs:4000}));
  let acknowledged=false;const take=f.workbench.consoleControl.take().then(value=>{acknowledged=true;return value;});
  const cancel=path.join(f.root,'.blackice-workbench','agent-jobs',job.jobId,'cancel.json');
  for(let i=0;i<100;i++){try{await fs.stat(cancel);break;}catch{await new Promise(r=>setTimeout(r,10));}}
  assert.equal(acknowledged,false);assert.equal(f.workbench.consoleControl.status().owner,'agent');
  await complete(f,job.jobId,{status:'cancelled',exitCode:-1});assert.equal((await take).owner,'user');
  assert.equal(value(await f.call('guest_job',{jobId:job.jobId})).status,'cancelled');
});

test('job IDs are task-scoped and mismatched receipts are rejected',async t=>{
  const f=await fixture(t);const job=value(await f.call('run_guest_script',{requestId:'receipt',script:'Write-Output ok',timeoutMs:4000}));
  const other=createWorkbenchAgentToolHandler({workbench:f.workbench,scope:'another-task',jobs:f.jobs});assert.equal((await other({name:'relay_workbench',arguments:{action:'guest_job',jobId:job.jobId}})).success,false);
  await complete(f,job.jobId,{agentId:'c'.repeat(32)});assert.equal((await f.call('guest_job',{jobId:job.jobId})).code,'WORKBENCH_AGENT_RECEIPT');
  await complete(f,job.jobId);await f.jobs.active.work;assert.equal((await f.call('guest_job',{jobId:'../bad'})).success,false);
});

test('normal guest GUI launch and text are first-class guest operations; interpreters stay bounded',async t=>{
  const f=await fixture(t);
  const launched=await f.call('launch',{appPath:'C:\\Program Files\\Mozilla Firefox\\firefox.exe',arguments:['about:preferences']});assert.equal(launched.success,true);assert.equal(f.calls[0].kind,'launch');assert.equal(f.calls[0].args.appPath,'C:\\Program Files\\Mozilla Firefox\\firefox.exe');assert.match(value(launched).meaning,/inspect windows and capture/);
  const typed=await f.call('type_text',{text:'https://addons.mozilla.org/'});assert.equal(typed.success,true);assert.equal(f.calls[1].kind,'type');
  assert.equal((await f.call('launch',{appPath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',arguments:['-Command','Write-Output nope']})).success,false);assert.equal(f.calls.length,2);
  await f.workbench.consoleControl.take();assert.equal((await f.call('type_text',{text:'blocked'})).success,false);assert.equal(f.calls.length,2);
});

test('trusted one-use grant can bind pre-existing AGENT control without inventing a handoff',async t=>{
  const f=await fixture(t),auth={scope:'configured-vm',control:'agent',source:'explicit-user-task'},h=createWorkbenchAgentToolHandler({workbench:f.workbench,scope,jobs:f.jobs,getAuthorization:()=>auth});
  const claimed=await h({name:'relay_workbench',arguments:{action:'claim_agent_control',expectedRevision:0}});assert.equal(claimed.success,true);assert.equal(value(claimed).authorizedHandoff,false);assert.equal(auth.agentRevision,0);
  const taken=await f.workbench.consoleControl.take();assert.equal((await h({name:'relay_workbench',arguments:{action:'claim_agent_control',expectedRevision:taken.revision}})).success,false);
});

test('ending one worker drains its guest process proof and does not cancel another handler job',async t=>{
  const f=await fixture(t),job=value(await f.call('run_guest_script',{requestId:'worker-lifetime',script:'Start-Sleep 10',timeoutMs:4000}));
  const other=createWorkbenchAgentToolHandler({workbench:f.workbench,scope,jobs:f.jobs});await other.close();
  const marker=path.join(f.root,'.blackice-workbench','agent-jobs',job.jobId,'cancel.json');await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  const closed=f.handler.close();
  for(let i=0;i<100;i++){try{await fs.stat(marker);break;}catch{await new Promise(r=>setTimeout(r,10));}}
  let settled=false;closed.catch(()=>{settled=true;});await new Promise(r=>setTimeout(r,20));assert.equal(settled,false,'Closing waits for actual process-tree proof.');
  await complete(f,job.jobId,{status:'cancelled',exitCode:-1});await assert.rejects(closed,{code:'WORKBENCH_AGENT_UNFINISHED'});assert.equal(f.workbench.consoleControl.status().owner,'agent');
});

test('ordinary execution exit zero never emits an effect receipt and cannot be promoted afterward',async t=>{
  const f=await fixture(t),bindings=new Map(),effects=[];
  const planRef={requestId:'p',cycleId:'c',nodeId:'plan',nodeRevision:1,responseId:'r'},callbacks={getVerificationContext:async()=>({planRef,criterionIds:['installed']}),getVerificationBinding:id=>bindings.get(id),recordVerificationBinding:async b=>bindings.set(b.jobId,b),recordVerifiedEffects:async r=>effects.push(r)};
  const h=createWorkbenchAgentToolHandler({workbench:f.workbench,scope,jobs:f.jobs,...callbacks}),call=(action,args={})=>h({name:'relay_workbench',arguments:{action,...args}}),script='Write-Output "{}"',started=value(await call('run_guest_script',{requestId:'ordinary',script,timeoutMs:4000}));
  await complete(f,started.jobId,{stdout:'{"installed":true}'});await f.jobs.active.work;
  assert.equal((await call('guest_job',{jobId:started.jobId})).success,true);assert.equal(effects.length,0);
  const attempted=await call('verify_guest_script',{requestId:'ordinary',script,timeoutMs:4000,planRef,criterionIds:['installed'],assertions:[{criterionId:'installed',path:'installed',operator:'equals',expected:true}]});assert.equal(attempted.code,'WORKBENCH_VERIFICATION_INVALID');assert.equal(effects.length,0);assert.equal(bindings.size,0);await h.close();
});

test('guest job metadata binds either signed measured clock offset without widening the lease',async t=>{
  for(const offset of [3200,-3200]){
    const f=await fixture(t),now=Date.now();f.jobs.clock=()=>now;f.agent.heartbeatAt=new Date(now-offset).toISOString();
    const started=value(await f.call('run_guest_script',{requestId:'clock-'+String(offset).replace('-','minus'),script:'Write-Output clock',timeoutMs:4000}));
    const folder=path.join(f.root,'.blackice-workbench','agent-jobs',started.jobId),meta=JSON.parse(await fs.readFile(path.join(folder,'job.json'),'utf8')),lease=JSON.parse(await fs.readFile(path.join(folder,'lease.json'),'utf8'));
    assert.equal(meta.hostToGuestOffsetMs,offset);assert.equal(Date.parse(lease.expiresAt)-now,1500);assert.equal(Date.parse(meta.deadlineAt)-now,4000);
    await complete(f,started.jobId);await f.jobs.active.work;
  }
});

test('missing, malformed or out-of-bounds heartbeat clocks reject before guest dispatch',async t=>{
  const now=Date.now();
  for(const heartbeatAt of [undefined,'not-a-date',new Date(now+5001).toISOString(),new Date(now-20000).toISOString()]){
    const f=await fixture(t);f.jobs.clock=()=>now;f.agent.heartbeatAt=heartbeatAt;
    const result=await f.call('run_guest_script',{requestId:'clock-invalid',script:'Write-Output blocked',timeoutMs:4000});assert.equal(result.code,'WORKBENCH_AGENT_CLOCK');assert.equal(f.calls.length,0);
  }
});

test('lease failures retain only bounded worker stage and errno diagnostics across terminal inspection',async t=>{
  const f=await fixture(t),raw='PRIVATE C:\\private\\path OS error details',error=Object.assign(Error(raw),{code:'WORKBENCH_JOB_LEASE',leaseStage:'replace',leaseCode:'EPERM'});
  f.jobs.leaseKeeperFactory=()=>({ready:Promise.resolve(),error,stop:async()=>{}});
  const started=value(await f.call('run_guest_script',{requestId:'lease-failure',script:'Write-Output synthetic',timeoutMs:4000})),work=f.jobs.active.work;
  await complete(f,started.jobId,{status:'cancelled',exitCode:1,stage:'script',terminationReason:'lease_expired'});await work;
  const result=await f.call('guest_job',{jobId:started.jobId});assert.deepEqual(value(result).leaseFailure,{stage:'replace',code:'EPERM'});assert.equal(JSON.stringify(result).includes(raw),false);
  const diagnostic=JSON.parse(await fs.readFile(path.join(f.root,'.blackice-workbench','agent-jobs',started.jobId,'lease-diagnostic.json'),'utf8'));assert.equal(JSON.stringify(diagnostic).includes('private'),false);
  const g=await fixture(t);g.jobs.leaseKeeperFactory=()=>({ready:Promise.reject(error),error,stop:async()=>{}});
  const rejected=await g.call('run_guest_script',{requestId:'lease-ready-failure',script:'Write-Output blocked',timeoutMs:4000});assert.deepEqual(value(rejected).leaseFailure,{stage:'replace',code:'EPERM'});assert.equal(JSON.stringify(rejected).includes(raw),false);assert.equal(g.calls.length,0);
});

test('owned preflight failures retain bounded diagnostic detail without accepting malformed receipts',async t=>{
  const f=await fixture(t),meta={jobId:'a'.repeat(32),scopeHash:'b'.repeat(64),scriptSha256:'c'.repeat(64),agentId,guestSessionId:2,guestName:'GUEST'},receipt={version:1,jobId:meta.jobId,scopeHash:meta.scopeHash,scriptSha256:meta.scriptSha256,agentId,guestSessionId:2,status:'failed',exitCode:-1,stdout:'',stderr:'Preflight failed.',childrenStopped:true,stage:'preflight',terminationReason:'supervisor_error',finishedAt:new Date().toISOString(),diagnostic:{errorType:'System.IO.FileNotFoundException',line:47,message:'The paired guest agent metadata was missing.'}};
  assert.deepEqual(f.jobs.validateResult(meta,receipt).diagnostic,receipt.diagnostic);
  for(const diagnostic of [{...receipt.diagnostic,line:-1},{...receipt.diagnostic,message:'x'.repeat(2049)},{...receipt.diagnostic,errorType:'bad\0type'},{...receipt.diagnostic,unboundedExtra:'no'}])assert.throws(()=>f.jobs.validateResult(meta,{...receipt,diagnostic}),{code:'WORKBENCH_AGENT_RECEIPT'});
});

test('one-use trusted grant hands off exact USER revision and restores privately without model tokens',async t=>{
  const f=await fixture(t),auth={scope:'configured-vm',control:'agent',source:'explicit-user-task'},persisted=[],restored=[];
  const initial=await f.workbench.consoleControl.take();f.workbench.onAgentControlRestored=async receipt=>restored.push(receipt);
  assert.equal(workbenchAgentToolForAuthorization(null).inputSchema.properties.action.enum.includes('claim_agent_control'),false);
  assert.equal((await f.call('claim_agent_control',{expectedRevision:initial.revision})).code,'WORKBENCH_AGENT_AUTHORIZATION');
  const h=createWorkbenchAgentToolHandler({workbench:f.workbench,scope,jobs:f.jobs,getAuthorization:()=>auth,persistAuthorization:async()=>persisted.push({...auth}),getHandoffReadiness:async()=>({ready:true,planRef:null,pendingCriterionIds:[]})});
  const claimed=await h({name:'relay_workbench',arguments:{action:'claim_agent_control',expectedRevision:initial.revision}});assert.equal(claimed.success,true);assert.equal(persisted[0].consumed,true);assert.equal(persisted[0].agentRevision,undefined);assert.equal(f.workbench.consoleControl.status().owner,'agent');
  const returned=await h({name:'relay_workbench',arguments:{action:'return_user_control',expectedRevision:value(claimed).consoleControl.revision,handoff:{reason:'completed'}}});assert.equal(returned.success,true);assert.equal(value(returned).userControlRestored,true);assert.equal(typeof restored[0].controlToken,'string');assert.equal(JSON.stringify(returned).includes('controlToken'),false);
  assert.equal((await h({name:'relay_workbench',arguments:{action:'claim_agent_control',expectedRevision:f.workbench.consoleControl.status().revision}})).success,false);
});
