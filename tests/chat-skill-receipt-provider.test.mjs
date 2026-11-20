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

class Native extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('No native inference in this test');}
}

test('Skill loaded corresponds to a real model tool result, not discovery or a missing skill', {timeout:20000}, async t=>{
  const root=await realpath(tmpdir()),dir=await mkdtemp(path.join(root,'blackice-skill-provider-'));
  const requests=[],observed=[];
  const skillId='library-pdf-evidence', title='Read a PDF for evidence';
  const automatic={type:'skill_context_submitted',skillId:'library-what-makes-done',title:'What Makes Done',source:'bundled',sourceRevision:'blackice-what-makes-done-v4'};
  const explicit={type:'skill_loaded',skillId,title};
  const calls=[
    ['lookup',{action:'search',query:'read PDF for evidence'}],
    ['missing',{action:'read',id:'missing-fixture-skill'}],
    ['load',{action:'read',id:skillId}],
    ['repeat',{action:'read',id:skillId}],
  ];
  let engine,runtime,catalog;
  const server=http.createServer(async(req,res)=>{
    const send=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    try {
      if(req.method==='GET')return send({data:[{id:'fixture'}]});
      let raw='';for await(const part of req)raw+=part;
      const body=JSON.parse(raw);
      const current=[...engine.runs.values()][0];
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
    const started=await submitChat({api,runs:[],task,model:'fixture::fixture',cwd:dir});
    for(let i=0;i<1000;i++){const done=engine.getRun(started.run.id);if(done.settled){assert.equal(done.status,'completed',done.error);return done;}await delay(10);}
    throw Error('Fixture run did not settle.');
  };
  const done=await run('Read a PDF for evidence.');
  assert.equal(requests.length,5);
  assert.ok(requests[0].tools.some(tool=>tool.function?.name==='relay_skills'));
  const toolResult=(step,id)=>requests[step].messages.find(message=>message.role==='tool'&&message.tool_call_id===id)?.content??'';
  assert.match(toolResult(1,'lookup'),new RegExp(skillId));
  assert.doesNotMatch(toolResult(1,'lookup'),/Get to the relevant page/);
  assert.match(toolResult(2,'missing'),/not found/i);
  assert.match(toolResult(3,'load'),/Get to the relevant page/);
  assert.deepEqual(observed.slice(0,4),[[],[automatic],[automatic],[automatic]],
    'The automatic prompt receipt starts after first acceptance; discovery, a miss, and a not-yet-accepted body do not emit a skill-loaded receipt.');
  const projected=projectFamily({rootId:done.id,runs:[done]}).runs[0];
  for(const receipts of [observed[4],done.skillLoadReceipts,projected.skillLoadReceipts]){
    assert.deepEqual(receipts,[automatic,explicit], 'The accepted tool body adds one distinct receipt even after the repeat.');
    assert.doesNotMatch(JSON.stringify(receipts),/Get to the relevant page/);
  }

  const completion=automatic.skillId,wire=index=>requests[index].messages.map(item=>item.content).join('\n');
  const core=/EXECUTION COMPLETION[\s\S]*Do not end the turn until you are really done/;
  assert.match(wire(0),core);
  assert.match(wire(0),/WHAT MAKES DONE \(bundled execution method\)[\s\S]*What just happened\?/);
  catalog=createSkillsCatalog({dataDir:path.join(dir,'engine')});
  const packaged=await catalog.detail({id:completion});
  assert.equal(packaged.provenance.revision,'blackice-what-makes-done-v4');
  const edited=await catalog.save({id:completion,value:{expectedRevision:packaged.revision,content:'# What Makes Done\nOwner completion fixture 9321.'}});
  const editedRun=await run('Use the current completion method.');
  assert.match(wire(5),core);
  // Both task execution and supported model skill lookup use the owner-facing choice.
  assert.match(wire(5),/WHAT MAKES DONE \(owner-edited execution method\)[\s\S]*local revision 2[\s\S]*Owner completion fixture 9321/);
  assert.doesNotMatch(wire(5),/What just happened\?/);
  assert.match(wire(0),/WHAT MAKES DONE \(bundled execution method\)[\s\S]*blackice-what-makes-done-v4[\s\S]*What just happened\?/);
  const ownerReceipt={...automatic,source:'user',sourceRevision:2};
  assert.deepEqual(editedRun.skillLoadReceipts,[ownerReceipt]);
  assert.deepEqual(projectFamily({rootId:editedRun.id,runs:[editedRun]}).runs[0].skillLoadReceipts,[ownerReceipt]);

  const removed=await catalog.delete({id:completion,value:{expectedRevision:edited.revision}});
  const deletedRun=await run('Keep the core completion contract only.');
  assert.match(wire(6),core);
  assert.doesNotMatch(wire(6),/WHAT MAKES DONE \((?:bundled|owner-edited) execution method\)|Owner completion fixture 9321|What just happened\?/);
  assert.equal(deletedRun.skillLoadReceipts,undefined);
  await assert.rejects(catalog.detail({id:completion}),{status:404});
  const restored=await catalog.restore({id:completion,value:{expectedRevision:removed.revision}});
  assert.equal(restored.content,edited.content);
});
