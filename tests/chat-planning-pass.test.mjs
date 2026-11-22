import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_PLANNING_MODULES, createChatPlanningPass } from '../lib/chat-planning-pass.mjs';

const [decomposition, grounding, analysis]=CHAT_PLANNING_MODULES.map(row=>row.id);
const actions=[{id:'scan',objective:'Inspect which import fails',dependsOn:[]},{id:'manifest',objective:'Compare installed manifest',dependsOn:[]}];
const plan={status:'proposed',focus:'scan',reason:'Find the first failing boundary',actions};
const choice={status:'proposed',focus:'manifest',reason:'The first import exists; compare route manifests',sourceRefs:['own_return']};
function fixture({mode='on',invoke,commit,assertAdmission,signal}={}) {
  let ledger={taskId:'chat1',revision:1,actions:[],receipts:[
    {id:'own_return',taskId:'chat1',state:'returned'},
    {id:'own_unknown',taskId:'chat1',state:'unknown'},
    {id:'foreign',taskId:'chat2',state:'returned'},
  ]};
  const events=[], invocations=[], writes=[];
  const possible={[decomposition]:plan,[grounding]:choice,[analysis]:{...choice,alternatives:['manifest','scan']}};
  const pass=createChatPlanningPass({mode,taskId:'chat1',runId:'turn1',nodeId:'agent1',signal,
    read:async()=>ledger,emit:event=>events.push(event),assertAdmission:assertAdmission??(()=>{}),
    invoke:async input=>{invocations.push(input);return invoke?invoke(input):{transport:'completed',output:possible[input.module.id]};},
    commit:async input=>{
      writes.push(input);
      if (commit) return commit(input);
      assert.equal(input.expectedRevision,ledger.revision);
      ledger={...ledger,revision:ledger.revision+1,
        ...(input.proposal.actions?{actions:input.proposal.actions.map(action=>({...action,state:'pending'}))}:{})};
      return {taskId:ledger.taskId,revision:ledger.revision};
    }});
  return {pass,events,invocations,writes};
}
test('ordered registry contains the four explicit built-in modules; disabled mode cannot run',async()=>{
  assert.deepEqual(CHAT_PLANNING_MODULES.map(row=>row.id),['builtin-decomposition','builtin-task-grounding','builtin-structured-analysis','builtin-intent-inference']);
  const f=fixture({mode:'off'});
  await assert.rejects(f.pass.run(decomposition),{code:'PLANNING_MODE_OFF'});
  assert.equal(f.invocations.length,0);
  assert.equal(f.events.length,0);
});
test('host can call each stage and completion follows artifact and same-task ledger CAS',async()=>{
  const f=fixture();
  for (const id of [decomposition,grounding,analysis]) assert.equal((await f.pass.run(id)).status,'completed');
  assert.deepEqual(f.events.map(row=>[row.moduleId,row.phase,row.revision]),[
    [decomposition,'started',1],[decomposition,'completed',2],
    [grounding,'started',2],[grounding,'completed',3],[analysis,'started',3],[analysis,'completed',4],
  ]);
  assert.deepEqual(f.writes.map(row=>[row.expectedRevision,row.proposal.focus]),[[1,'scan'],[2,'manifest'],[3,'manifest']]);
  assert.deepEqual(f.writes[2].proposal.alternatives,['manifest','scan']);
  assert.ok(f.events.every(row=>row.taskId==='chat1' && row.runId==='turn1' && row.nodeId==='agent1'));
  assert.ok(f.events.every(row=>!('reason' in row) && !('output' in row)));
});
test('successful transport, no calls, needs evidence and failed CAS cannot imply completion',async()=>{
  const transport=fixture({invoke:()=>({transport:'completed',text:'done'})});
  assert.equal(transport.events.length,0);
  assert.equal((await transport.pass.run(decomposition)).status,'failed');
  assert.deepEqual(transport.events.map(row=>row.phase),['started','failed']);
  assert.equal(transport.writes.length,0);
  const missing=fixture({invoke:()=>({transport:'completed',output:{status:'needs-evidence',reason:'Need the HTTP status'}})});
  assert.equal((await missing.pass.run(decomposition)).status,'needs-evidence');
  assert.equal(missing.writes.length,0);
  const stale=fixture({commit:()=>({taskId:'chat1',revision:1})});
  assert.equal((await stale.pass.run(decomposition)).code,'PLANNING_LEDGER_RESULT_INVALID');
  assert.deepEqual(stale.events.map(row=>row.phase),['started','failed']);
});
test('foreign or unresolved receipts, cycles, and attempts to smuggle execution state are rejected before committing',async()=>{
  const cases=[{...plan,sourceRefs:['foreign']},{...plan,sourceRefs:['own_unknown']},
    {...plan,actions:[{...actions[0],dependsOn:['manifest']},{...actions[1],dependsOn:['scan']}]},
    {...plan,actions:[{...actions[0],state:'observed'},actions[1]]}];
  for (const output of cases) {
    const f=fixture({invoke:()=>({transport:'completed',output})});
    assert.equal((await f.pass.run(decomposition)).status,'failed');
    assert.equal(f.writes.length,0);
  }
});
test('once per module, no independent admission after cancel, and deadline rechecked at commit',async()=>{
  const f=fixture();
  assert.equal(f.pass.run(decomposition),f.pass.run(decomposition));
  await f.pass.run(decomposition);
  assert.equal(f.writes.length,1);
  const controller=new AbortController();
  const cancelled=fixture({signal:controller.signal,invoke:()=>{controller.abort();return {transport:'completed',output:plan};}});
  assert.equal((await cancelled.pass.run(decomposition)).status,'cancelled');
  assert.equal((await cancelled.pass.run(grounding)).status,'cancelled');
  assert.deepEqual(cancelled.events.map(row=>row.phase),['started','cancelled']);
  assert.equal(cancelled.writes.length,0);
  let gate=0;
  const expired=fixture({assertAdmission:()=>{if (++gate===2) throw Error('expired');}});
  assert.equal((await expired.pass.run(decomposition)).status,'failed');
  assert.equal(expired.writes.length,0);
});

test('invalid planning receipts name the rejected field without recording model output',async()=>{
 const rejected=fixture({invoke:()=>({transport:'completed',output:{...plan,actions:[{...actions[0],dependsOn:['private-not-in-the-outline']}]}})});
 assert.deepEqual(await rejected.pass.run(decomposition),{status:'failed',code:'PLANNING_ARTIFACT_INVALID'});
 assert.equal(rejected.events.at(-1).validationField,'actions.unknownDependency');
 assert.doesNotMatch(JSON.stringify(rejected.events),/private-not-in-the-outline/);
 assert.deepEqual(rejected.writes,[]);
 const malformed=fixture({invoke:()=>({transport:'completed'})});
 await malformed.pass.run(decomposition);
 assert.equal(malformed.events.at(-1).validationField,'providerOutput');
});


test('canonical needs-evidence variants and intent advice never fabricate a Directory action',async()=>{
  for(const id of [decomposition,grounding,analysis]) {
    const extra=id===decomposition?{actions:[]}:id===analysis?{alternatives:[]}:{};
    const f=fixture({invoke:()=>({transport:'completed',output:{status:'needs-evidence',reason:'Need a current observation',
      sourceRefs:[],focus:null,...extra},usage:{inputTokens:7,outputTokens:5,totalTokens:12}})});
    assert.equal((await f.pass.run(id)).status,'needs-evidence');
    assert.equal(f.writes.length,0);assert.equal(f.events.at(-1).usage.totalTokens,12);
    assert.equal(f.events.filter(event=>event.usage).length,1);
  }
  const f=fixture({invoke:()=>({transport:'completed',output:{status:'proposed',interpretation:'Check the stated constraint.',reason:'The current request supplies it.'}})});
  const result=await f.pass.run('builtin-intent-inference');
  assert.equal(result.status,'completed');
  assert.deepEqual(result.advice,{interpretation:'Check the stated constraint.',reason:'The current request supplies it.'});
  assert.equal(f.writes.length,0);
  assert.equal(f.events.at(-1).usage.totalTokens,null);
});

test('parsed JSON missing actions remains a semantic failure with reported usage and no CAS',async()=>{
  const f=fixture({invoke:()=>({transport:'completed',output:{status:'proposed',focus:'scan',reason:'Need the first action',sourceRefs:[]},
    usage:{inputTokens:9,outputTokens:4,totalTokens:13},providerDiagnostics:{parseOutcome:'parsed',threadId:'prep1',turnId:'turn1'}})});
  assert.equal((await f.pass.run(decomposition)).status,'failed');
  assert.equal(f.events.at(-1).validationField,'actions');
  assert.equal(f.events.at(-1).providerDiagnostics.parseOutcome,'parsed');
  assert.equal(f.events.at(-1).usage.totalTokens,13);assert.equal(f.writes.length,0);
  assert.equal(f.events.filter(event=>event.usage).length,1);
  assert.equal(f.pass.run(decomposition),f.pass.run(decomposition));
  await f.pass.run(decomposition);
  assert.equal(f.events.length,2);
});

test('receipt metadata is allowlisted and invalid counts are never presented as measured zero',async()=>{
  const f=fixture({invoke:()=>({transport:'completed',output:plan,
    usage:{inputTokens:-1,outputTokens:false,totalTokens:'not a count',samples:1,private:'SECRET_META'},
    providerDiagnostics:{parseOutcome:'SECRET_META',outputChars:7,outputSha256:'invalid',threadId:'x'.repeat(241),
      turnId:'valid-turn',structuredOutput:'SECRET_META',structuredOutputReason:'SECRET_META',
      hostValidationRequired:false,output:'SECRET_META',parserError:'SECRET_META'}})});
  assert.equal((await f.pass.run(decomposition)).status,'completed');
  const receipt=f.events.at(-1);
  assert.deepEqual(receipt.providerDiagnostics,{turnId:'valid-turn'});
  assert.equal(receipt.usage.totalTokens,null);assert.equal(receipt.usage.inputTokens,null);assert.equal(receipt.usage.outputTokens,null);
  assert.equal(receipt.usage.availability.totalTokens,'unavailable');assert.equal(receipt.usage.samples,1);
  assert.doesNotMatch(JSON.stringify(f.events),/SECRET_META/);
});
