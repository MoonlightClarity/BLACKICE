import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessEngine } from '../lib/engine.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';

class NativePlaceholder extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async close() {}
}
test('HTTP 429 leaves the conversation intact and supports a different model on the same API provider', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-switch-provider-')),cwd=path.join(dir,'workspace'),calls=[];
  await mkdir(cwd);
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/v1/models'){
      res.writeHead(200,{'content-type':'application/json'});
      return res.end(JSON.stringify({data:[
        {id:'limited-model',context_length:32768,max_output_tokens:4096},
        {id:'working-model',context_length:32768,max_output_tokens:4096},
      ]}));
    }
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){
      res.writeHead(404);return res.end('Not found');
    }
    let text='';for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text);calls.push({model:body.model,messages:body.messages});
    const limited=body.model==='limited-model';
    res.writeHead(limited?429:200,{'content-type':'application/json',...(limited?{'retry-after':'60'}:{})});
    res.end(limited
      ?JSON.stringify({error:{type:'rate_limit_error',message:'TPM limit 8000, requested 24001.'}})
      :JSON.stringify({choices:[{message:{role:'assistant',content:'Alternative provider model succeeded.'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:6,total_tokens:26}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const runtime=await new ProviderRuntime({codex:new NativePlaceholder(),dataDir:path.join(dir,'providers')}).init();
  const engine=await new HarnessEngine({runtime,defaultCwd:cwd,dataDir:path.join(dir,'runs')}).init();
  engine.runtimeSettings={get:()=>({codexHistory:'relay'})};
  t.after(async()=>{await engine.close();await runtime.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  await runtime.saveProvider({id:'fixture-api',type:'compatible',name:'Fixture',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',models:['limited-model','working-model']},{preserveDefault:true});
  const workflow={id:'switch-model-provider',name:'Model switch conversation',nodes:[
    {id:'input',type:'input'},
    {id:'agent',type:'agent',name:'Assistant',model:'fixture-api::limited-model',prompt:'Respond to the user.'},
    {id:'output',type:'output'}
  ],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}};
  const first=engine.startRun({workflow,input:'Summarize the research.'});
  await engine.executions.get(first.id);
  const failed=engine.getRun(first.id);
  assert.equal(failed.status,'failed',failed.error);
  assert.equal(failed.errorCode,'PROVIDER_RATE_LIMIT');
  assert.equal(calls.length,1);
  const next=engine.continueRun(first.id,{nodeId:'agent',message:'Use the working model in this conversation.',model:'fixture-api::working-model',requestId:'rate-limited-followup'},{historyRuns:[failed]});
  assert.equal(next.parentRunId,first.id);
  assert.equal(next.taskId,failed.taskId);
  assert.equal(next.nodes.agent.resumeThreadId,undefined);
  await engine.executions.get(next.id);
  const recovered=engine.getRun(next.id);
  assert.equal(recovered.status,'completed',recovered.error);
  assert.deepEqual(calls.map(x=>x.model),['limited-model','working-model']);
  assert.match(recovered.output,/Alternative provider model succeeded/);
  assert.equal(engine.getRun(first.id).errorCode,'PROVIDER_RATE_LIMIT');
});
