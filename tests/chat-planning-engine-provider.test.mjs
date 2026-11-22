import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ProviderRuntime} from '../lib/providers.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';
import {commitChatPlanningProposal} from '../lib/chat-planning-engine.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {readBundledSkill} from '../lib/skill-library.mjs';

class Native extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('No native inference in this test');}
}
const wait=async fn=>{
  for(let i=0;i<700;i++){const value=fn();if(value)return value;await delay(10);}
  assert.fail('Timed out waiting for fixture');
};
const plan={
  status:'proposed',focus:'inspect_a',reason:'Check the first observed boundary',
  actions:[{id:'inspect_a',objective:'Inspect route A',dependsOn:[]}],
};
const catalog = [
  'builtin-decomposition','builtin-task-grounding','builtin-structured-analysis','builtin-intent-inference',
];
test('explicit Chat Planning reaches a real compatible provider and advances the one Directory, unlike ordinary Off', {timeout:20000},async t=>{
  const root=await realpath(tmpdir()), dir=await mkdtemp(path.join(root,'blackice-planning-provider-'));
  const requests=[];
  const receivedText=index=>requests[index].body.messages.map(message=>message.content).join('\n');
  const [completionSkill,antiCompletionSkill]=await Promise.all([readBundledSkill('library-what-makes-done'),readBundledSkill('library-anti-completion-bias')]);
  let answerToPlanning=JSON.stringify(plan), heldResponse;
  let engine,runtime,skillCatalog;
  const server=http.createServer(async(req,res)=>{
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw);
    const allText=JSON.stringify(body.messages);
    const prep=allText.includes('This is one bounded planning phase');
    requests.push({prep,body,allText});
    if(allText.includes('UNACCEPTED SYNTHETIC PROMPT')){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic request rejection'}}));return;}
    const respond=content=>{
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],
        usage:prep?{prompt_tokens:2136,completion_tokens:49,total_tokens:2185}:{prompt_tokens:10,completion_tokens:7,total_tokens:17}}));
    };
    if(prep && allText.includes('PAUSE FOR CANCEL')){heldResponse=()=>respond(answerToPlanning);return;}
    respond(prep?answerToPlanning:'Ordinary synthetic final, not an action receipt.');
  });
  t.after(async()=>{
    await engine?.close();await runtime?.close();await skillCatalog?.close();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    const resolved=await realpath(dir);
    assert.equal(path.dirname(resolved),root);
    assert.match(path.basename(resolved),/^blackice-planning-provider-/);
    await rm(resolved,{recursive:true,force:true});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  runtime=new ProviderRuntime({codex:new Native(),dataDir:dir,modelLimitResolver:{enrich:async(_config,model)=>model}});
  await runtime.store.init();
  await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},{preserveDefault:true});
  engine=await new HarnessEngine({runtime,dataDir:path.join(dir,'engine'),defaultCwd:dir}).init();
  const seed=await engine.instructionSettings.read();
  const ownerCore=await engine.instructionSettings.update({content:'OWNER_PROVIDER_CORE\n',expectedRevision:seed.revision,expectedHash:seed.hash});
  skillCatalog=createSkillsCatalog({dataDir:engine.dataDir});
  const method=await skillCatalog.detail({id:'builtin-decomposition'});
  const editedMethod=await skillCatalog.save({id:method.id,value:{expectedRevision:method.revision,content:'# Owner decomposition\nOWNER_PREPARATION_METHOD'}});
  const start=(task,fields)=>engine.startRun({input:{task,cwd:dir,...fields},workflow:{id:'mission_chat_fixture',
    name:'Fixture',nodes:[{id:'input',type:'input',name:'Request'},{id:'agent',type:'agent',name:'Assistant',model:'fixture::fixture',prompt:'Answer directly.'},{id:'output',type:'output',name:'Result'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}]}});
  const done=run=>wait(()=>{const latest=engine.getRun(run.id);return latest.settled?latest:null;});
  const off=await done(await start('A normal turn',{chatPlanning:'off'}));
  assert.equal(off.status,'completed',off.error);
  assert.equal(requests.length,1);
  assert.equal(requests[0].prep,false);
  assert.doesNotMatch(requests[0].allText,/CRITICAL PATH|LONG-TERM JUDGMENT/);
  assert.match(requests[0].allText,/OWNER_PROVIDER_CORE/);
  assert.doesNotMatch(requests[0].body.messages[0].content,/EXECUTION COMPLETION|BLACKICE AGENT HARNESS/);
  assert.match(requests[0].allText,/WHAT MAKES DONE \(bundled execution method\)/);
  assert.ok(receivedText(0).includes(completionSkill.content));
  assert.equal(off.planningModuleReceipts,undefined);
  const antiCompletion={type:'skill_context_submitted',skillId:'library-anti-completion-bias',title:'Anti-Completion Bias',source:'bundled',sourceRevision:antiCompletionSkill.provenance.revision};
  const bundled={type:'skill_context_submitted',skillId:'library-what-makes-done',title:'What Makes Done',source:'bundled',sourceRevision:completionSkill.provenance.revision};
  assert.deepEqual(off.skillLoadReceipts,[bundled,antiCompletion]);
  const on=await done(await start('Check the startup route',{chatPlanning:'on'}));
  assert.equal(on.status,'completed',on.error);
  assert.deepEqual(on.skillLoadReceipts,[bundled,antiCompletion]);
  assert.equal(on.events.filter(event=>event.data.type===bundled.type).length,2);
  assert.deepEqual(requests.map(row=>row.prep),[false,true,false]);
  assert.ok(!requests[1].body.tools?.length);
  assert.equal(requests[1].body.model,'fixture');
  assert.equal(requests[1].body.response_format,undefined,'unknown catalog support remains prompt fallback');
  assert.match(requests[1].allText,/complete output schema/);
  const planningReceipt=on.planningModuleReceipts.find(row=>row.phase==='completed');
  assert.equal(planningReceipt.providerDiagnostics.structuredOutput,'prompt-and-host-validation');
  assert.equal(planningReceipt.providerDiagnostics.structuredOutputReason,'structured_output_support_unknown');
  assert.equal(planningReceipt.providerDiagnostics.parseOutcome,'parsed');
  assert.match(planningReceipt.providerDiagnostics.threadId,/^provider_/);
  assert.equal(on.planningModuleReceipts[0].usage,undefined);
  assert.equal(on.planningUsage.inputTokens,2136);assert.equal(on.planningUsage.outputTokens,49);
  assert.equal(on.planningUsage.totalTokens,2185);assert.equal(on.planningUsage.samples,1);
  assert.equal(on.operationalUsage.totalTokens,17);assert.equal(on.usage.totalTokens,2202);assert.equal(on.usage.samples,2);
  assert.match(requests[1].allText,/OWNER_PROVIDER_CORE/);
  assert.match(requests[2].allText,/ADVISORY PLANNING CHOICE/);
  assert.match(requests[1].allText,/OWNER_PREPARATION_METHOD/);
  assert.match(requests[2].allText,/WHAT MAKES DONE \(bundled execution method\)/);
  assert.ok(receivedText(2).includes(completionSkill.content));
  assert.doesNotMatch(requests[1].allText,/CRITICAL PATH|LONG-TERM JUDGMENT/);
  const parentAudit=on.nodes.agent.instructionAudit,preparation=parentAudit.preparations[0];
  assert.equal(parentAudit.preparations.length,1);
  assert.equal(preparation.id,'builtin-decomposition');assert.equal(preparation.audit.delivery,'accepted');
  assert.equal(preparation.audit.sections.find(row=>row.id==='core').text,ownerCore.content);
  assert.equal(preparation.audit.sections.find(row=>row.id==='core').revision,ownerCore.revision);
  assert.equal(preparation.audit.sections.find(row=>row.id==='skill-builtin-decomposition').revision,editedMethod.revision);
  assert.equal(preparation.audit.sections.filter(row=>row.layer==='developer').map(row=>row.text).join(''),requests[1].body.messages[0].content);
  assert.equal(parentAudit.sections.filter(row=>row.layer==='developer').map(row=>row.text).join(''),requests[2].body.messages[0].content);
  assert.doesNotMatch(JSON.stringify(preparation.audit),/Check the startup route/);
  assert.deepEqual(on.planningModuleReceipts.map(row=>[row.moduleId,row.phase]),[[catalog[0],'started'],[catalog[0],'completed']]);
  const ledger=await engine.actionDirectories.get(on.taskId||on.id,on.input);
  assert.equal(ledger.read().revision,1);
  assert.equal(ledger.read().actions[0].state,'pending');
  assert.equal(ledger.read().actions[0].reason,plan.reason);
  assert.equal(ledger.read().receipts.length,0);
  await skillCatalog.delete({id:method.id,value:{expectedRevision:editedMethod.revision}});
  answerToPlanning='A normal transport final but not a structured artifact.';
  const failed=await done(await start('Prove malformed prep is visible',{chatPlanning:'on'}));
  assert.equal(failed.status,'completed',failed.error);
  assert.deepEqual(failed.planningModuleReceipts.map(row=>row.phase),['started','failed']);
  assert.equal(failed.planningModuleReceipts.at(-1).providerDiagnostics.parseOutcome,'invalid-json');
  assert.equal(failed.planningUsage.totalTokens,2185);assert.equal(failed.planningUsage.samples,1);
  assert.equal(failed.usage.totalTokens,2202);assert.equal(failed.usage.samples,2);
  assert.equal((await engine.actionDirectories.get(failed.id,failed.input)).read().revision,0);
  const skipped=failed.nodes.agent.instructionAudit.preparations[0].audit.sections.find(row=>row.id==='skill-builtin-decomposition');
  assert.equal(skipped.status,'unavailable');assert.equal(skipped.text,'');
  assert.doesNotMatch(requests.at(-2).allText,/OWNER_PREPARATION_METHOD/);
  assert.ok(!requests.at(-1).allText.includes('ADVISORY PLANNING CHOICE'));
  const cancelledStart=await start('PAUSE FOR CANCEL',{chatPlanning:'on'});
  await wait(()=>heldResponse);
  await engine.cancelRun(cancelledStart.id);
  heldResponse();
  const cancelled=await done(cancelledStart);
  assert.equal(cancelled.status,'cancelled');
  assert.deepEqual(cancelled.planningModuleReceipts.map(row=>row.phase),['started','cancelled']);
  assert.equal((await engine.actionDirectories.get(cancelled.id,cancelled.input)).read().revision,0);
  assert.equal(cancelled.skillLoadReceipts,undefined);
  const rejected=await done(await start('UNACCEPTED SYNTHETIC PROMPT',{chatPlanning:'off'}));
  assert.equal(rejected.status,'failed');
  assert.equal(rejected.skillLoadReceipts,undefined);
  assert.equal(requests.filter(row=>row.allText.includes('PAUSE FOR CANCEL')).length,1);
});

test('deadline and steering are rechecked inside the canonical CAS queue',async()=>{
  let release,entered;
  const held=new Promise(resolve=>release=resolve), waiting=new Promise(resolve=>entered=resolve);
  const directory=new TaskActionDirectory({taskId:'scope',objective:'A bounded task',persist:async()=>{entered();await held;}});
  const first=directory.edit({action:'plan',revision:0,actions:[{id:'stable',objective:'Prior pending step',dependsOn:[]}]});
  await waiting;
  let permitted=true;
  const result=commitChatPlanningProposal(directory,{taskId:'scope',expectedRevision:0,proposal:plan},()=>{
    if(!permitted)throw Object.assign(Error('steered before CAS'),{code:'STALE_DIRECTION'});
  });
  permitted=false;
  release();
  await first;
  await assert.rejects(result,{code:'STALE_DIRECTION'});
  assert.deepEqual(directory.read().actions.map(action=>action.id),['stable']);
  assert.equal(directory.read().revision,1);
});


test('snapshot accounts for terminal module usage once alongside existing planning usage',()=>{
  const measured=(inputTokens,outputTokens)=>({inputTokens,outputTokens,totalTokens:inputTokens+outputTokens,samples:1});
  const run={id:'usage-fixture',status:'completed',settled:true,nodes:{},workflow:{edges:[]},
    planningAttempts:[{usage:measured(3,2)}],
    planningModuleReceipts:[
      {moduleId:'builtin-decomposition',phase:'started',usage:measured(900,900)},
      {moduleId:'builtin-decomposition',phase:'completed',usage:measured(10,5)},
      {moduleId:'builtin-task-grounding',phase:'failed',usage:measured(8,2)},
      {moduleId:'builtin-structured-analysis',phase:'needs-evidence',usage:measured(5,1)},
      {moduleId:'builtin-intent-inference',phase:'cancelled',usage:measured(4,3)},
    ]};
  const host={executionStatus:()=>({availableSlots:1}),conversationBusy:()=>false};
  const first=HarnessEngine.prototype.snapshot.call(host,run),second=HarnessEngine.prototype.snapshot.call(host,run);
  assert.equal(first.planningUsage.inputTokens,30);assert.equal(first.planningUsage.outputTokens,13);
  assert.equal(first.planningUsage.totalTokens,43);assert.equal(first.planningUsage.samples,5);
  assert.equal(first.usage.totalTokens,43);assert.equal(first.usage.samples,5);
  assert.deepEqual(second.planningUsage,first.planningUsage);
  assert.equal(run.planningUsage,undefined,'snapshot does not persist a second accumulated count');
  const unknown=HarnessEngine.prototype.snapshot.call(host,{...run,planningAttempts:[],planningModuleReceipts:[{phase:'failed'}]});
  assert.equal(unknown.planningUsage.totalTokens,null);
  assert.equal(unknown.planningUsage.availability.totalTokens,'unavailable');
});
