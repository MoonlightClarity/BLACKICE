import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HarnessEngine} from '../lib/engine.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

class NoNative extends EventEmitter {
 status(){return {connected:false,authenticated:false,models:[]};}
 async close(){}
 async runAgent(){throw Error('Native model must not run.');}
}
const reply=content=>({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],
  usage:{prompt_tokens:75,completion_tokens:24,total_tokens:99}});
test('ordinary Chat at final provider step does not accept a false completion when review says work remains',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'blackice-last-step-review-'));
 const cwd=path.join(root,'work');await mkdir(cwd);
 const source=path.join(cwd,'result.cjs'),original='module.exports=()=>0;\n';
 await writeFile(source,original);
 const requests={worker:0,review:0},server=http.createServer(async(req,res)=>{
   try{
     res.setHeader('Content-Type','application/json');
     if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}
     let raw='';for await(const chunk of req)raw+=chunk;
     const body=JSON.parse(raw);
     if(JSON.stringify(body.messages).includes('BLACKICE ORDINARY TASK OUTCOME REVIEW')){
       requests.review++;
       res.end(JSON.stringify(reply(JSON.stringify({
         decision:'continue',summary:'There is no saved fix or passing test receipt.',
         remaining:['Save the fix','Run the tests'],nextAction:'Edit result.cjs and run its test.',
         evidenceRefs:['user-request'],blockers:[]
       }))));return;
     }
     requests.worker++;
     res.end(JSON.stringify(reply('I fixed result.cjs and all tests pass.')));
   }catch(error){res.statusCode=500;res.end(JSON.stringify({error:{message:error.message}}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let runtime,engine;
 t.after(async()=>{
   await engine?.close();await runtime?.close();
   server.closeAllConnections();
   if(server.listening)await new Promise(resolve=>server.close(resolve));
   await rm(root,{recursive:true,force:true});
 });
 runtime=await new ProviderRuntime({codex:new NoNative(),dataDir:path.join(root,'provider'),
   modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
 await runtime.saveProvider({id:'fixture',type:'compatible',
   baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',
   models:[{id:'fixture-model',contextWindowTokens:65536,maxOutputTokens:2048}],maxSteps:1},
   {preserveDefault:true});
 engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:cwd}).init();
 const task='Fix result.cjs so it returns 1, and verify with an actual test before reporting success.';
 const workflow=createMissionWorkflow({task,model:'fixture::fixture-model',cwd,
   id:'chatgpt_mission_'+randomUUID().replaceAll('-',''),planningMode:'off'});
 const run=engine.startRun({workflow,input:{task,cwd,planningMode:'off',
   directoryMode:'off',directoryActions:'off',chatPlanning:'off',pastChats:'off'}});
 await engine.executions.get(run.id);
 const settled=engine.getRun(run.id);
 assert.equal(settled.status,'failed','The unsupported success must not be published.');
 assert.equal(settled.nodes.agent.errorCode,'CHAT_OUTCOME_STEP_BUDGET',settled.error);
 assert.equal(requests.worker,1,'Provider step limit remains enforced.');
 assert.equal(requests.review,1,'A separate read-only final review occurs despite zero worker steps.');
 assert.equal(await readFile(source,'utf8'),original,'Reviewer did not perform task effects.');
});
