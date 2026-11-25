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
import {submitChat} from '../public/next/chat/send.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {readBundledSkill} from '../lib/skill-library.mjs';
import {EXECUTION_COMPLETION_RULE} from '../lib/task-completion-guidance.mjs';

class Native extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('No native inference in this test');}
}

const outcomeMarker='BLACKICE ORDINARY TASK OUTCOME REVIEW';
function syntheticOutcomeAssessment(request,turn){
  const prompt=request.messages?.find(message=>typeof message.content==='string'&&message.content.includes(outcomeMarker))?.content;
  if(!prompt)return null;
  assert.ok(turn.workers.length,'assessment follows a worker request on this provider');
  const {snapshot}=JSON.parse(prompt.split('\nREVIEW DATA (JSON):\n').at(-1));
  assert.equal(snapshot.request,turn.task,'assessment retains the unchanged current request');
  assert.equal(request.model,turn.workers[0].model,'assessment uses the worker model');
  assert.equal(request.reasoning_effort,turn.workers[0].reasoning_effort,'assessment preserves worker effort');
  assert.equal(request.service_tier,turn.workers[0].service_tier,'assessment preserves worker service tier');
  assert.deepEqual(request.tools||[],[],'inline-evidence assessment has no action tools');
  turn.assessors.push(request);
  // This mock disposition tests transport, not model judgment or an external outcome.
  return {decision:'respond',summary:'Synthetic transport assessment; no real external outcome is verified.',
    remaining:[],nextAction:'',evidenceRefs:snapshot.evidence.records.length?[snapshot.evidence.records.at(-1).citationRef]:['user-request'],blockers:[]};
}
function assertTransport(turn,workers,assessors){
  assert.equal(turn.workers.length,workers,'exact scripted worker and completion-check requests');
  assert.equal(turn.assessors.length,assessors,'exact read-only outcome assessment requests');
  assert.equal(turn.all.length,workers+assessors,'every provider request is accounted for');
  if(assessors){
    const prompt=turn.workers.at(-1).messages.findLast(message=>message.role==='user').content;
    const parts=prompt.split('\n\nCURRENT USER REQUEST (unchanged JSON string):\n');
    assert.equal(parts.length,2,'the extra worker request is the completion evidence check');
    assert.equal(JSON.parse(parts[1]),turn.task,'completion check retains the current request');
  }
}

test('Skill loaded corresponds to a real model tool result, not discovery or a missing skill', {timeout:20000}, async t=>{
  const root=await realpath(tmpdir()),dir=await mkdtemp(path.join(root,'blackice-skill-provider-'));
  const requests=[],observed=[],turns=new Map();
  const skillId='library-pdf-evidence', title='Read a PDF for evidence';
  const [pdfSkill,completionSkill,antiCompletionSkill]=await Promise.all([readBundledSkill(skillId),readBundledSkill('library-what-makes-done'),readBundledSkill('library-anti-completion-bias')]);
  const antiCompletion={type:'skill_context_submitted',skillId:'library-anti-completion-bias',title:'Anti-Completion Bias',source:'bundled',sourceRevision:antiCompletionSkill.provenance.revision,contentMode:'brief'};
  const automatic={type:'skill_context_submitted',skillId:'library-what-makes-done',title:'What Makes Done',source:'bundled',sourceRevision:completionSkill.provenance.revision,contentMode:'brief'};
  const explicit={type:'skill_loaded',skillId,title};
  const pdfAutomatic={type:'skill_context_submitted',skillId,title,source:'bundled',sourceRevision:pdfSkill.provenance.revision,contentMode:'brief'};
  const calls=[
    ['lookup',{action:'search',query:'read PDF for evidence'}],
    ['missing',{action:'read',id:'missing-fixture-skill'}],
    ['load',{action:'read',id:skillId}],
    ['repeat',{action:'read',id:skillId}],
  ];
  let engine,runtime,catalog,currentTurn;
  const server=http.createServer(async(req,res)=>{
    const send=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    try {
      if(req.method==='GET')return send({data:[{id:'fixture'}]});
      let raw='';for await(const part of req)raw+=part;
      const body=JSON.parse(raw);
      currentTurn.all.push(body);
      const assessment=syntheticOutcomeAssessment(body,currentTurn);
      if(assessment)return send({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(assessment)}}]});
      currentTurn.workers.push(body);
      const current=[...engine.runs.values()].at(-1);
      observed.push(structuredClone(current?.skillLoadReceipts??[]));
      const call=calls[requests.length];requests.push(body);
      send({choices:[{index:0,finish_reason:call?'tool_calls':'stop',message:call?{
        role:'assistant',content:null,tool_calls:[{id:call[0],type:'function',function:{name:'relay_skills',arguments:JSON.stringify(call[1])}}],
      }:{role:'assistant',content:'Completed the synthetic task.'}}]});
    } catch(error) {res.statusCode=500;send({error:{message:error.message}});}
  });
  t.after(async()=>{
    await catalog?.close();await engine?.close();await runtime?.close();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    const resolved=await realpath(dir);assert.equal(path.dirname(resolved),root);
    assert.match(path.basename(resolved),/^blackice-skill-provider-/);
    await rm(resolved,{recursive:true,force:true});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  runtime=new ProviderRuntime({codex:new Native(),dataDir:dir,modelLimitResolver:{enrich:async(_config,model)=>model}});
  await runtime.store.init();
  await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},{preserveDefault:true});
  engine=await new HarnessEngine({runtime,dataDir:path.join(dir,'engine'),defaultCwd:dir}).init();
  const api=async(route,_method,body)=>route==='/api/workflows'?body:engine.startRun(body);
  const run=async task=>{
    const turn=currentTurn={task,workerStart:requests.length,workers:[],assessors:[],all:[]};
    const started=await submitChat({api,runs:[],task,model:'fixture::fixture',cwd:dir});
    for(let i=0;i<1000;i++){
      const done=engine.getRun(started.run.id);
      if(done.settled){
        assert.equal(done.status,'completed',done.error);
        assertTransport(turn,turn.workerStart===0?6:2,1);
        turns.set(done.id,turn);
        t.diagnostic(JSON.stringify({workerStart:turn.workerStart,workers:turn.workers.length,assessors:turn.assessors.length,total:turn.all.length}));
        return done;
      }
      await delay(10);
    }
    throw Error('Fixture run did not settle.');
  };
  const done=await run('Read a PDF for evidence.');
  assert.equal(requests.length,6,'four scripted skill calls, final response, and one completion evidence check');
  const audit=Object.values(done.nodes).find(node=>node.instructionAudit)?.instructionAudit;
  assert.equal(audit.captureStage,'adapter-prepared');
  assert.equal(audit.adapter,'compatible');
  assert.equal(audit.delivery,'accepted');
  assert.equal(audit.sections.filter(section=>section.layer==='developer').map(section=>section.text).join(''),
    requests[0].messages.find(message=>message.role==='system').content);
  const loaded=audit.sections.find(section=>section.role==='tool'&&section.source.endsWith(skillId));
  assert.equal(loaded.status,'delivered');assert.equal(loaded.deliveries,2);
  assert.equal(loaded.text,pdfSkill.content);assert.equal(loaded.revision,pdfSkill.provenance.revision);
  assert.ok(requests[0].tools.some(tool=>tool.function?.name==='relay_skills'));
  const toolResult=(step,id)=>requests[step].messages.find(message=>message.role==='tool'&&message.tool_call_id===id)?.content??'';
  assert.match(toolResult(1,'lookup'),new RegExp(skillId));
  assert.ok(JSON.parse(toolResult(1,'lookup')).entries.every(entry=>!('content' in entry)));
  assert.match(toolResult(2,'missing'),/not found/i);
  const deliveredSkill=JSON.parse(toolResult(3,'load')).entry;
  assert.equal(deliveredSkill.content,pdfSkill.content);assert.equal(deliveredSkill.provenance.revision,pdfSkill.provenance.revision);
  assert.deepEqual(observed.slice(0,4),[[],[automatic,antiCompletion,pdfAutomatic],[automatic,antiCompletion,pdfAutomatic],[automatic,antiCompletion,pdfAutomatic]],
    'The automatic prompt receipt starts after first acceptance; discovery, a miss, and a not-yet-accepted body do not emit a skill-loaded receipt.');
  const projected=projectFamily({rootId:done.id,runs:[done]}).runs[0];
  for(const receipts of [observed[4],done.skillLoadReceipts,projected.skillLoadReceipts]){
    assert.deepEqual(receipts,[automatic,antiCompletion,pdfAutomatic,explicit], 'The accepted automatically submitted body and explicit tool read have distinct receipts, even after the repeat.');
    assert.ok(receipts.every(receipt=>!('content' in receipt)));
  }

  const completion=automatic.skillId,wire=index=>requests[index].messages.map(item=>item.content).join('\n');
  const assertCore=text=>{assert.match(text,/EXECUTION COMPLETION/);assert.ok(text.includes(EXECUTION_COMPLETION_RULE));};
  assertCore(wire(0));
  assert.match(wire(0),/WHAT MAKES DONE \(bundled execution method\)/);
  assert.ok(wire(0).includes('Define done by the actual requested result'));
  assert.ok(!wire(0).includes(completionSkill.content),'full automatic skill is available only on demand');
  catalog=createSkillsCatalog({dataDir:path.join(dir,'engine')});
  const packaged=await catalog.detail({id:completion});
  assert.equal(packaged.provenance.revision,completionSkill.provenance.revision);
  const edited=await catalog.save({id:completion,value:{expectedRevision:packaged.revision,content:'# What Makes Done\nOwner completion fixture 9321.'}});
  const editedRun=await run('Use the current completion method.');
  const editedWire=wire(turns.get(editedRun.id).workerStart);
  assertCore(editedWire);
  // Both task execution and supported model skill lookup use the owner-facing choice.
  assert.match(editedWire,/WHAT MAKES DONE \(owner-edited execution method\)[\s\S]*local revision 2/);
  assert.ok(!editedWire.includes('Owner completion fixture 9321'),'owner body remains available on demand');
  assert.ok(!editedWire.includes(completionSkill.content));
  assert.ok(wire(0).includes('packaged revision '+completionSkill.provenance.revision+'.'));
  assert.ok(!wire(0).includes(completionSkill.content));
  const ownerReceipt={...automatic,source:'user',sourceRevision:2};
  assert.deepEqual(editedRun.skillLoadReceipts,[ownerReceipt,antiCompletion]);
  assert.deepEqual(projectFamily({rootId:editedRun.id,runs:[editedRun]}).runs[0].skillLoadReceipts,[ownerReceipt,antiCompletion]);

  const removed=await catalog.delete({id:completion,value:{expectedRevision:edited.revision}});
  const deletedRun=await run('Keep the core completion contract only.');
  const deletedWire=wire(turns.get(deletedRun.id).workerStart);
  assertCore(deletedWire);
  assert.doesNotMatch(deletedWire,/WHAT MAKES DONE \((?:bundled|owner-edited) execution method\)|Owner completion fixture 9321/);
  assert.ok(!deletedWire.includes(completionSkill.content));
  assert.deepEqual(deletedRun.skillLoadReceipts,[antiCompletion]);
  await assert.rejects(catalog.detail({id:completion}),{status:404});
  const restored=await catalog.restore({id:completion,value:{expectedRevision:removed.revision}});
  assert.equal(restored.content,edited.content);
});
