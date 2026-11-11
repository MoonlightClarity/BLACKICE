import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateWorkbenchAssertions,validateWorkbenchVerification,assertWorkbenchVerificationBinding,validateWorkbenchControlVerification,verificationScriptHash} from '../lib/historical-guest-verification.mjs';

const context={planRef:{requestId:'request-a',cycleId:'cycle-a',nodeId:'plan-a',nodeRevision:4,responseId:'response-a'},criterionIds:['installed','extension']};
function record(){
  const script='[ordered]@{ observations = @{ version = "128.0"; extension = $true } } | ConvertTo-Json -Compress';
  return {jobId:'a'.repeat(32),requestId:'verify-firefox-1',planRef:structuredClone(context.planRef),script,scriptSha256:verificationScriptHash(script),
    stdout:'{"observations":{"version":"128.0","extension":true}}',assertions:[{criterionId:'installed',path:'observations.version',operator:'notEmpty'},{criterionId:'extension',path:'observations.extension',operator:'equals',expected:true}],
    guestName:'paired-guest',guestSessionId:2,agentId:'b'.repeat(32),ownerRevision:7,status:'completed',exitCode:0,childrenStopped:true,finishedAt:'2026-11-02T02:40:00.000Z'};
}

test('verification compares actual primitive stdout observations for only the declared criteria',()=>{
  const result=validateWorkbenchVerification(record(),context);
  assert.deepEqual(result.criterionIds,['installed','extension']);
  assert.equal(result.scriptEncoding,'utf8-bom');assert.equal(result.assertions.every(item=>item.passed),true);
  const only=record();only.assertions=only.assertions.slice(0,1);
  assert.deepEqual(validateWorkbenchVerification(only,context).criterionIds,['installed'],'Unasserted criteria never acquire receipts.');
});

test('ordinary successful completion, changed bodies/plans and failed assertions do not verify effects',()=>{
  const mutations=[r=>delete r.assertions,r=>r.assertions=[],r=>r.exitCode=1,r=>r.childrenStopped=false,r=>r.status='running',r=>r.script+=' changed',r=>r.planRef.nodeRevision++,r=>r.stdout+=' prose',r=>r.observations={observations:{version:'invented'}},r=>r.assertions[1].expected=false,r=>r.assertions[0].criterionId='foreign',r=>r.criterionIds=['installed','extension','unasserted'],r=>r.ownerRevision=-1,r=>r.agentId='different'];
  for(const mutate of mutations){const value=record();mutate(value);assert.throws(()=>validateWorkbenchVerification(value,context),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});}
});

test('assertions are bounded own-property comparisons, not expressions or prototype access',()=>{
  const observations={details:{version:'Firefox 128',enabled:true,count:2,blank:' '}};
  assert.equal(evaluateWorkbenchAssertions(observations,[{criterionId:'installed',path:'details.version',operator:'includes',expected:'128'}],context.criterionIds)[0].passed,true);
  for(const item of [
    {path:'details.constructor',operator:'notEmpty'},
    {path:'details.__proto__.version',operator:'notEmpty'},
    {path:'details.version.toString()',operator:'notEmpty'},
    {path:'details',operator:'equals',expected:{}},
    {path:'details.blank',operator:'notEmpty'},
    {path:'details.enabled',operator:'equals',expected:'true'},
    {path:'details.version',operator:'includes',expected:''},
    {path:'missing.value',operator:'equals',expected:null}
  ])assert.throws(()=>evaluateWorkbenchAssertions(observations,[{criterionId:'installed',...item}],context.criterionIds),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
  assert.throws(()=>evaluateWorkbenchAssertions(observations,Array(17).fill({criterionId:'installed',path:'details.version',operator:'notEmpty'}),context.criterionIds),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
});

test('effect evidence cannot be promoted without its exact immutable host declaration',()=>{
  const r=record();r.criterionIds=['installed','extension'];
  const binding={...r,version:1,status:'declared',declaredAt:'2026-11-02T02:39:00.000Z',timeoutMs:30000};
  assert.ok(assertWorkbenchVerificationBinding(r,binding).bindingSha256);
  for(const mutate of [b=>b.status='completed',b=>b.script+=' changed',b=>b.ownerRevision++,b=>b.agentId='c'.repeat(32),b=>b.planRef={...b.planRef,nodeRevision:99},b=>b.assertions=[],b=>b.declaredAt='invalid']){
    const changed=structuredClone(binding);mutate(changed);assert.throws(()=>assertWorkbenchVerificationBinding(r,changed),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
  }
  assert.throws(()=>assertWorkbenchVerificationBinding(r,undefined),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
  assert.ok(assertWorkbenchVerificationBinding(r,{...binding,declaredAt:'2026-11-02T02:41:00.000Z'}),'Guest completion timestamps need not match the host clock; declaration persistence proves execution ordering.');
});

test('host control receipts cannot substitute guest assertions or stale human restoration',()=>{
  const control={owner:'user',revision:8,authorizedReturn:true,featuresRestored:true},r={verificationId:'c'.repeat(32),requestId:'verify-control',planRef:context.planRef,criterionIds:['installed'],control,observedAt:'2026-11-02T02:40:00.000Z',assertions:[{criterionId:'installed',path:'control.owner',operator:'equals',expected:'user'}]};
  const result=validateWorkbenchControlVerification(r,context,control);
  assert.equal(result.kind,'host-control-state');assert.equal(result.script,undefined);
  assert.throws(()=>validateWorkbenchControlVerification(r,context,{...control,revision:9}),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
  assert.throws(()=>validateWorkbenchControlVerification({...r,assertions:[{criterionId:'installed',path:'observations.version',operator:'notEmpty'}]},context,control),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
  assert.throws(()=>validateWorkbenchControlVerification({...r,control:{...control,featuresRestored:false}},context,{...control,featuresRestored:false}),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
});
