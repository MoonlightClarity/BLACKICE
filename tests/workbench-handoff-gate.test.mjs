import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
import {createWorkbenchAgentToolHandler,workbenchAgentToolForAuthorization} from '../lib/workbench-agent-tools.mjs';
import {verificationScriptHash} from '../lib/workbench-effect-verification.mjs';

const ref={requestId:'p',cycleId:'c',nodeId:'plan',nodeRevision:1,responseId:'r'};
const hostId='blackice-host-control-restoration';
const hostCriterion={id:hostId,label:'Host-owned control restoration',verification:'effect'};
const value=result=>JSON.parse(result.contentItems[0].text);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const declarations=()=>({reason:'completed',planRef:{...ref},deferredControlVerification:{criterionIds:[hostId],assertions:[
  {criterionId:hostId,path:'control.owner',operator:'equals',expected:'user'},
  {criterionId:hostId,path:'control.authorizedReturn',operator:'equals',expected:true},
  {criterionId:hostId,path:'control.featuresRestored',operator:'equals',expected:true}
]}});
function bmp(){const bytes=Buffer.alloc(70);bytes.write('BM');bytes.writeUInt32LE(70,2);bytes.writeUInt32LE(54,10);bytes.writeUInt32LE(40,14);bytes.writeInt32LE(2,18);bytes.writeInt32LE(-2,22);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(32,28);bytes[54]=255;return {bytes,width:2,height:2,sequence:2};}
async function fixture(t,options={}){
  const control=new WorkbenchConsoleControl(),auth={scope:'configured-vm',control:'agent',source:'explicit-user-task',consumed:true,agentRevision:0};
  const events=[],effects=new Set(),bindings=new Map();let restored=0,contextFailure=null;
  const c={state:{vmName:'Fixture VM',capability:{}},agent:{guestName:'GUEST',guestSessionId:2,agentId:'a'.repeat(32)},bridge:{request:async()=>({status:'completed',agentId:'a'.repeat(32),guestSessionId:2,result:{windows:[]}})}};
  const workbench={consoleControl:control,nativeConsoleAdapter:{open:async()=>{},surface:async()=>({width:2,height:2}),input:async(_,check)=>{check();return {accepted:true};}},
    guestNativeConsoleOpen:async check=>{check();return {opened:true,displayReady:true};},guestNativeConsoleFrame:async()=>bmp(),
    guestNativeConsoleWake:async(_,check)=>{check();return {surface:{sequence:1},wake:{queued:true}};},
    onAgentControlRestored:async receipt=>{restored++;assert.equal(receipt.owner,'user');assert.equal(typeof receipt.controlToken,'string');}};
  const jobs={active:null,context:async check=>{check?.();if(contextFailure)throw contextFailure;return c;},checkIdentity:async(_,check)=>check?.(),inspect:async()=>({status:'completed'}),
    start:async(_scope,args,_signal,beforeDispatch)=>{
      const meta={jobId:createHash('sha256').update(_scope+'\n'+args.requestId).digest('hex').slice(0,32),agentId:c.agent.agentId,guestSessionId:2,guestName:'GUEST',ownerRevision:control.status().revision,scriptSha256:verificationScriptHash(args.script)};
      await beforeDispatch(meta,()=>control.assert());
      return {...meta,status:'completed',exitCode:0,childrenStopped:true,stdout:'{"browser":{"installed":true},"settings":{"verified":true}}',stderr:'',stdoutTruncated:false,stderrTruncated:false,outputDrained:true,outputComplete:true,finishedAt:new Date().toISOString()};
    }};
  const readiness=async args=>{
    if(options.readiness)return options.readiness(args);
    const deferredIds=args.deferredControlVerification?.criterionIds||[];
    const pending=['browser','settings'].filter(id=>!effects.has(id));if(!deferredIds.includes(hostId))pending.push(hostId);
    const blocked=args.reason==='blocked'&&args.evidence?.verified===true&&args.evidence.resolved===false&&args.evidence.prerequisite==='guest_identity_changed';
    return {ready:blocked||pending.length===0,planRef:{...ref},pendingCriterionIds:blocked?pending:pending,eligibleDeferredControlCriteria:[hostCriterion],deferredCriterionIds:deferredIds,reason:blocked?'confirmed-current-identity-blocker':'pending-effects',progressKey:'fixture-progress'};
  };
  const handler=createWorkbenchAgentToolHandler({workbench,scope:'handoff-gate-test',jobs,getAuthorization:()=>auth,persistAuthorization:async()=>{},
    getHandoffReadiness:readiness,withHandoffReadiness:options.withGate||((args,dispatch)=>readiness(args).then(dispatch)),
    getVerificationContext:async()=>({planRef:{...ref},criterionIds:['browser','settings',hostId]}),
    getVerificationBinding:id=>bindings.get(id),recordVerificationBinding:async binding=>bindings.set(binding.jobId,binding),
    recordVerifiedEffects:async record=>{assert.equal(record.stdout,'{"browser":{"installed":true},"settings":{"verified":true}}');assert.equal(record.exitCode,0);for(const id of record.criterionIds)effects.add(id);return {receipts:record.criterionIds.map(id=>({criterionIds:[id],effectVerified:true}))};},
    recordVerifiedControlEffects:async record=>{assert.equal(record.control.owner,'user');return {receipts:[{criterionIds:[hostId],effectVerified:true}]};},onEvent:event=>events.push(event),...options.handler});
  const call=(args,callId,context={})=>handler({name:'relay_workbench',arguments:args,...(callId?{callId}:{})},context);
  t.after(()=>handler.close());
  return {handler,call,control,auth,effects,jobs,workbench,events,get restored(){return restored;},failContext:error=>{contextFailure=error;}};
}

test('Firefox11 public 13-call pattern cannot return after only successful viewer/pixel work and zero guest proofs',async t=>{
  const f=await fixture(t),human=await f.control.take();f.auth.consumed=false;delete f.auth.agentRevision;
  const trace=[
    ['relay_workbench',{action:'status'}],['relay_workspace',{action:'read'}],['relay_workbench',{action:'claim_agent_control',expectedRevision:human.revision}],
    ['relay_workbench',{action:'open_viewer'}],['relay_workbench',{action:'capture'}],['relay_workbench',{action:'windows'}],['relay_workbench',{action:'wake_display'}],['relay_workbench',{action:'capture'}],
    ['relay_workbench',{action:'return_user_control',expectedRevision:2}],['relay_workbench',{action:'status'}],['relay_workbench',{action:'verify_control_state'}],['relay_workspace',{action:'patch'}],['relay_workspace',{action:'read'}]
  ];
  for(let index=0;index<8;index++)if(trace[index][0]==='relay_workbench')assert.equal((await f.call(trace[index][1],'trace-'+index)).success,true,'successful original call '+index);
  assert.equal(f.auth.agentRevision,2);assert.equal(f.effects.size,0);
  const rejected=await f.call(trace[8][1],'trace-return');assert.equal(rejected.code,'WORKBENCH_HANDOFF_DECLARATION_REQUIRED');
  assert.deepEqual(value(rejected).handoffReadiness.pendingCriterionIds,['browser','settings',hostId]);assert.deepEqual(value(rejected).authority,{owner:'agent',revision:2,agentControlBound:true});
  assert.deepEqual(f.control.status(),{owner:'agent',revision:2});assert.equal(f.auth.returned,undefined);assert.equal(f.restored,0);
  const fakeBlocker=await f.call({action:'return_user_control',expectedRevision:2,handoff:{reason:'blocked',planRef:ref,evidence:{callId:'trace-return',code:rejected.code}}});
  assert.equal(fakeBlocker.code,'WORKBENCH_HANDOFF_EVIDENCE_INVALID','Gate rejection is not blocker evidence.');
  assert.equal(trace.length,13);
});

test('pending guest effects reject a well-formed completed declaration without consuming authority',async t=>{
  const f=await fixture(t);const rejected=await f.call({action:'return_user_control',expectedRevision:0,handoff:declarations()});
  assert.equal(rejected.code,'WORKBENCH_HANDOFF_PENDING');assert.deepEqual(value(rejected).handoffReadiness.pendingCriterionIds,['browser','settings']);
  assert.equal(f.control.status().owner,'agent');assert.equal(f.auth.returned,undefined);assert.equal(f.restored,0);
});

test('declared guest verification observations, reserved host deferral, ordinary return and actual host verification pass',async t=>{
  const f=await fixture(t),proof=await f.call({action:'verify_guest_script',requestId:'observe-browser-settings',script:'Write-BLACKICEObservation -Data $selected',planRef:ref,assertions:[
    {criterionId:'browser',path:'browser.installed',operator:'equals',expected:true},{criterionId:'settings',path:'settings.verified',operator:'equals',expected:true}
  ]});
  assert.equal(proof.success,true);assert.equal(value(proof).verification?.status,'verified',JSON.stringify(value(proof)));assert.deepEqual([...f.effects],['browser','settings']);
  const handoff=await f.call({action:'return_user_control',expectedRevision:0,handoff:declarations()});assert.equal(handoff.success,true);assert.equal(f.control.status().owner,'user');assert.equal(f.auth.featuresRestored,true);assert.equal(f.auth.handoff.completed,true);assert.equal(f.restored,1);
  const checked=await f.call({action:'verify_control_state',requestId:'host-proof',planRef:ref,...declarations().deferredControlVerification});assert.equal(checked.success,true);assert.equal(value(checked).control.authorizedReturn,true);assert.equal(value(checked).control.featuresRestored,true);assert.equal(JSON.stringify(handoff).includes('controlToken'),false);
});

test('actor-selected guest IDs cannot be reclassified as deferred host control',async t=>{
  const f=await fixture(t);f.effects.add('browser');f.effects.add('settings');const declaration=declarations();
  declaration.deferredControlVerification.criterionIds=['browser'];declaration.deferredControlVerification.assertions.forEach(a=>a.criterionId='browser');
  assert.equal((await f.call({action:'return_user_control',expectedRevision:0,handoff:declaration})).code,'WORKBENCH_HANDOFF_DEFERRED_INVALID');
  assert.equal(f.control.status().owner,'agent');assert.equal(f.auth.returned,undefined);
});

test('changed plan, malformed readiness and a missing plan serialization fence never dispatch Take',async t=>{
  const cases=[{readiness:async()=>({ready:true,planRef:{...ref,nodeRevision:2},pendingCriterionIds:[]})},
    {readiness:async()=>({ready:true,planRef:ref,pendingCriterionIds:'browser'})},
    {handler:{withHandoffReadiness:undefined},readiness:async()=>({ready:true,planRef:ref,pendingCriterionIds:[]})}];
  for(const options of cases){const f=await fixture(t,options);assert.equal((await f.call({action:'return_user_control',expectedRevision:0,handoff:{reason:'completed',planRef:ref}})).success,false);assert.deepEqual(f.control.status(),{owner:'agent',revision:0});assert.equal(f.auth.returned,undefined);}
});

test('a human Take while readiness is awaited cannot be superseded by the returning agent',async t=>{
  const entered=deferred(),wait=deferred(),f=await fixture(t,{readiness:async()=>{entered.resolve();await wait.promise;return {ready:true,planRef:ref,pendingCriterionIds:[],eligibleDeferredControlCriteria:[hostCriterion]};}});
  const returning=f.call({action:'return_user_control',expectedRevision:0,handoff:declarations()});await entered.promise;
  const taking=f.control.take();wait.resolve();assert.equal((await returning).code,'WORKBENCH_CONSOLE_CONTROL_CONFLICT');const human=await taking;assert.deepEqual(f.control.status(),{owner:'user',revision:human.revision});assert.equal(f.auth.returned,undefined);assert.equal(f.restored,0);
});

test('a cancelled task may return safely while a fabricated cancelled reason cannot bypass pending effects',async t=>{
  const f=await fixture(t);assert.equal((await f.call({action:'return_user_control',expectedRevision:0,handoff:{reason:'cancelled'}})).code,'WORKBENCH_HANDOFF_CANCELLATION_REQUIRED');
  const controller=new AbortController();controller.abort();const returned=await f.call({action:'return_user_control',expectedRevision:0,handoff:{reason:'cancelled'}},'cancelled-return',{signal:controller.signal});
  assert.equal(returned.success,true);assert.equal(f.control.status().owner,'user');assert.equal(f.auth.handoff.completed,false);assert.equal(f.auth.handoff.reason,'cancelled');
});

test('only current verified failure evidence reaches the host blocker decision; stale/repaired evidence is rejected',async t=>{
  const f=await fixture(t),failure=Object.assign(Error('Guest identity changed.'),{code:'WORKBENCH_AGENT_UNAVAILABLE',prerequisite:'guest_identity_changed'});
  f.failContext(failure);const failed=await f.call({action:'status'},'actual-failure');assert.equal(failed.code,failure.code);assert.deepEqual(value(failed).handoffEvidence,{callId:'actual-failure',code:failure.code,action:'status',prerequisite:'guest_identity_changed'});
  const returned=await f.call({action:'return_user_control',expectedRevision:0,handoff:{reason:'blocked',planRef:ref,evidence:{callId:'actual-failure',code:failure.code}}});
  assert.equal(returned.success,true);assert.equal(f.auth.handoff.completed,false);assert.equal(f.auth.handoff.evidence.verified,true);assert.equal(f.auth.handoff.reason,'blocked');
  const g=await fixture(t);g.failContext(failure);await g.call({action:'status'},'repaired-failure');g.failContext(null);assert.equal((await g.call({action:'status'})).success,true);
  assert.equal((await g.call({action:'return_user_control',expectedRevision:0,handoff:{reason:'blocked',planRef:ref,evidence:{callId:'repaired-failure',code:failure.code}}})).code,'WORKBENCH_HANDOFF_EVIDENCE_INVALID');
  assert.equal(g.control.status().owner,'agent');
});

test('trusted stalled cleanup returns only this run owned revision and never exposes its bypass as a model reason',async t=>{
  const f=await fixture(t);assert.equal((await f.call({action:'return_user_control',expectedRevision:0,handoff:{reason:'trusted-stalled'}})).code,'WORKBENCH_HANDOFF_INVALID');
  const result=await f.handler.safeReturn('stalled');assert.equal(result.userControlRestored,true);assert.equal(f.auth.handoff.reason,'trusted-stalled');assert.equal(f.auth.handoff.completed,false);assert.equal(f.auth.handoff.trusted,true);
  const g=await fixture(t);await g.control.take();assert.equal((await g.handler.safeReturn()).status,'skipped');assert.equal(g.auth.returned,undefined);assert.equal(g.restored,0);
  const h=await fixture(t);h.auth.consumed=false;assert.equal((await h.handler.safeReturn()).status,'skipped');assert.equal(h.control.status().owner,'agent');
});

test('trusted cleanup waits owned process termination and refuses an unknown termination proof',async t=>{
  const f=await fixture(t),entered=deferred(),wait=deferred();let stopped=false;
  // Obtain the real internal owner key via the job start callback rather than
  // exposing an engine cleanup token through the model action.
  f.jobs.start=async(_s,_a,_signal,_before,ownerKey)=>{f.jobs.active={ownerKey,dispatched:true,work:wait.promise.then(()=>{stopped=true;})};entered.resolve();return {status:'running',jobId:'c'.repeat(32)};};
  await f.call({action:'run_guest_script',requestId:'owned-job',script:'fixture',timeoutMs:1000});await entered.promise;
  let returned=false;const cleanup=f.handler.safeReturn().then(result=>{returned=true;return result;});await tick();assert.equal(returned,false);assert.equal(f.control.status().owner,'agent');wait.resolve();assert.equal((await cleanup).userControlRestored,true);assert.equal(stopped,true);f.jobs.active=null;
  const g=await fixture(t);g.jobs.start=async(_s,_a,_signal,_before,ownerKey)=>{const work=Promise.reject(Error('No child termination proof.'));work.catch(()=>{});g.jobs.active={ownerKey,dispatched:true,work};return {status:'running',jobId:'d'.repeat(32)};};
  await g.call({action:'run_guest_script',requestId:'unknown-job',script:'fixture',timeoutMs:1000});await assert.rejects(g.handler.safeReturn(),/termination proof/);assert.equal(g.control.status().owner,'agent');g.jobs.active=null;
});

test('delegated workers retain guest inspection/input but cannot claim or return the shared coordinator grant',async t=>{
  const f=await fixture(t,{handler:{controlCoordinator:false}}),before=f.control.status();
  const advertised=workbenchAgentToolForAuthorization(f.auth,f.workbench,{controlCoordinator:false}).inputSchema.properties.action.enum;
  assert.equal(advertised.includes('claim_agent_control'),false);assert.equal(advertised.includes('return_user_control'),false);
  assert.equal((await f.call({action:'claim_agent_control',expectedRevision:0})).code,'WORKBENCH_AGENT_COORDINATOR_ONLY');
  assert.equal((await f.call({action:'return_user_control',expectedRevision:0,handoff:declarations()})).code,'WORKBENCH_AGENT_COORDINATOR_ONLY');
  assert.equal((await f.handler.safeReturn('stalled')).reason,'delegated-worker');
  assert.equal((await f.call({action:'status'})).success,true);assert.equal((await f.call({action:'capture'})).success,true);
  assert.equal((await f.call({action:'input',input:{kind:'mouse',x:1,y:1,flags:2048}})).success,true);
  assert.deepEqual(f.control.status(),before);assert.equal(f.auth.returned,undefined);assert.equal(f.restored,0);
});

test('concurrent guest proof recording finishes before guarded return acquires the Plan queue',async t=>{
  let planTail=Promise.resolve(),proofFinished=false,gateEntered=false;
  const planSerialize=fn=>{const work=planTail.then(fn);planTail=work.catch(()=>{});return work;};
  const f=await fixture(t,{withGate:(_args,dispatch)=>planSerialize(async()=>{gateEntered=true;assert.equal(proofFinished,true);return dispatch({ready:true,planRef:ref,pendingCriterionIds:[],eligibleDeferredControlCriteria:[hostCriterion]});})});
  const entered=deferred(),release=deferred();
  // finishVerification already owns the existing input queue while its actual
  // effect recorder needs the Plan/store queue. The return must queue behind
  // that owner, rather than acquiring Plan first and deadlocking the recorder.
  const recording=f.control.run(async check=>{entered.resolve();await release.promise;check();await planSerialize(async()=>{check();proofFinished=true;});});
  await entered.promise;const returning=f.call({action:'return_user_control',expectedRevision:0,handoff:declarations()});await tick();
  assert.equal(gateEntered,false);release.resolve();await recording;
  const result=await Promise.race([returning,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Proof/return queue deadlock.')),1000);timer.unref();})]);
  assert.equal(result.success,true);assert.equal(proofFinished,true);assert.equal(f.control.status().owner,'user');
});

test('a guarded ownership transfer cannot commit without permission or commit twice',async()=>{
  const control=new WorkbenchConsoleControl();
  let late;
  await assert.rejects(control.takeGuarded(0,async commit=>{late=commit;return {ready:false};}),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});assert.deepEqual(control.status(),{owner:'agent',revision:0});
  assert.throws(()=>late(),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});assert.deepEqual(control.status(),{owner:'agent',revision:0});
  await assert.rejects(control.takeGuarded(0,async commit=>{await commit();return commit();}),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});assert.deepEqual(control.status(),{owner:'user',revision:1});
});

test('a guard that forgets to await its commit still holds ownership until native release acknowledgement',async()=>{
  const ack=deferred(),entered=deferred(),control=new WorkbenchConsoleControl({beforeOwnerChange:async()=>{entered.resolve();await ack.promise;}});
  let returned=false;const transfer=control.takeGuarded(0,async commit=>{commit();return 'guard-value';}).then(result=>{returned=true;return result;});
  await entered.promise;await tick();assert.equal(returned,false);assert.equal(control.status().owner,'agent');ack.resolve();
  assert.equal(await transfer,'guard-value');assert.equal(control.status().owner,'user');
});
