import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HarnessEngine} from '../lib/engine.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

class NoNative extends EventEmitter{
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('Unexpected native/Codex fallback');}
}
const jsonResponse=(message,tools=false)=>({choices:[{index:0,finish_reason:tools?'tool_calls':'stop',message}],
  usage:{prompt_tokens:85,completion_tokens:30,total_tokens:115}});
const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

async function exercise(t,{workerRetrieves=false}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'blackice-archive-review-'));
  const cwd=path.join(root,'workspace');await mkdir(cwd);
  const marker='MIDDLE_DIAGNOSIS_Q7M2';
  const source=path.join(cwd,'incident.log');
  const lines=Array.from({length:300},(_,i)=>
    String(i).padStart(4,'0')+' '+'z'.repeat(100)+(i===155?' '+marker:''));
  await writeFile(source,lines.join('\n')+'\n');
  const trace={worker:[],reviews:[],source,marker};
  let runtime,engine,server;
  server=http.createServer(async(req,res)=>{
    try{
      res.setHeader('Content-Type','application/json');
      if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture-mini'}]}));return;}
      let raw='';for await(const block of req)raw+=block;
      const body=JSON.parse(raw);
      const prompt=JSON.stringify(body.messages);
      if(prompt.includes('BLACKICE LOCAL OUTCOME REVIEW')){
        const user=body.messages.find(m=>String(m.content).includes('BLACKICE LOCAL OUTCOME REVIEW'));
        const data=JSON.parse(user.content.split('\nREVIEW DATA (JSON):\n').at(-1));
        const rowText=JSON.stringify(data.snapshot.evidence.records);
        const hasMiddle=rowText.includes(marker);
        const containsArchived= /externalContext/.test(rowText);
        trace.reviews.push({hasMiddle,containsArchived,records:data.snapshot.evidence.records.length,
          bytes:rowText.length,evidenceExcerpts:rowText.slice(0,280)});
        const value=hasMiddle?{
          decision:'respond',summary:'The decoded middle source contains the diagnosis.',
          remaining:[],nextAction:'',evidenceRefs:['evidence-0001'],blockers:[]
        }:{
          decision:'continue',summary:'The middle source was not inspected in available evidence.',
          remaining:['Verify exact middle source content'],nextAction:'Retrieve the archived source page.',
          evidenceRefs:['candidate'],blockers:[]
        };
        res.end(JSON.stringify(jsonResponse({role:'assistant',content:JSON.stringify(value)})));return;
      }
      const stage=trace.worker.length, message=body.messages.at(-1);
      trace.worker.push({stage,tools:body.tools?.map(t=>t.function?.name),lastRole:message?.role});
      if(stage===0){res.end(JSON.stringify(jsonResponse({role:'assistant',content:null,
        tool_calls:[tool('large-read','relay_workspace',{action:'read',path:source,startLine:1,lineCount:300})]},true)));return;}
      if(workerRetrieves&&stage===1){
        let pointer;
        for(const row of body.messages){
          if(row.role!=='tool')continue;
          try{const value=JSON.parse(row.content);if(value.externalContext)pointer=value;}catch{}
        }
        if(!pointer?.reference)throw Error('Worker did not receive an external context reference');
        res.end(JSON.stringify(jsonResponse({role:'assistant',content:null,
          tool_calls:[tool('search-middle','relay_context_page',{action:'search',reference:pointer.reference,needle:marker})]},true)));return;
      }
      if(workerRetrieves&&stage===2){
        let offset;
        for(const row of body.messages){
          if(row.role!=='tool')continue;
          try{const value=JSON.parse(row.content);
            if(value.matches?.length)offset=value.matches[0].offset;
          }catch{}
        }
        if(!Number.isInteger(offset))throw Error('Search did not return a match position');
        let pointer;
        for(const row of body.messages){
          if(row.role!=='tool')continue;
          try{const value=JSON.parse(row.content);if(value.externalContext)pointer=value;}catch{}
        }
        res.end(JSON.stringify(jsonResponse({role:'assistant',content:null,
          tool_calls:[tool('read-middle','relay_context_page',{action:'read',reference:pointer.reference,offset,maxBytes:512})]},true)));return;
      }
      res.end(JSON.stringify(jsonResponse({role:'assistant',
        content:'The exact incident diagnosis is '+marker+'.'})));
    }catch(error){res.statusCode=500;res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({error:{message:error.message}}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await engine?.close();await runtime?.close();
    server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));
    await rm(root,{recursive:true,force:true});
  });
  runtime=await new ProviderRuntime({codex:new NoNative(),dataDir:path.join(root,'provider'),
    modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
  await runtime.saveProvider({id:'local_llamacpp',type:'compatible',
    baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',
    models:[{id:'fixture-mini',contextWindowTokens:65536,maxOutputTokens:2048}],maxSteps:workerRetrieves?4:2},
    {preserveDefault:true});
  engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:cwd}).init();
  const task='Read incident.log and report the exact diagnosis from the middle, supported by actual source evidence.';
  const workflow=createMissionWorkflow({task,model:'local_llamacpp::fixture-mini',
    cwd,id:'chatgpt_mission_'+randomUUID().replaceAll('-',''),planningMode:'off'});
  const run=engine.startRun({workflow,input:{task,cwd,directoryActions:'off',
    chatPlanning:'off',pastChats:'off',directoryMode:'off'}});
  await engine.executions.get(run.id);
  const final=engine.getRun(run.id);
  return {trace,run:final};
}
test('archived middle source is not falsely established by a model-facing preview',{timeout:30000},async t=>{
  const {trace,run}=await exercise(t);
  assert.equal(trace.reviews.length,1,'The last step must trigger read-only review.');
  assert.equal(trace.reviews[0].containsArchived,true);
  assert.equal(trace.reviews[0].hasMiddle,false,'The preview excludes the middle evidence.');
  assert.equal(run.status,'failed','A candidate-only assertion must not establish completion.');
  assert.equal(run.nodes.agent.errorCode,'CHAT_OUTCOME_STEP_BUDGET');
});
test('model-retrieved exact archive page can ground a final review',{timeout:30000},async t=>{
  const {trace,run}=await exercise(t,{workerRetrieves:true});
  assert.equal(trace.reviews.length,1);
  assert.equal(trace.reviews[0].hasMiddle,true,'The actual retrieved result must reach the reviewer.');
  assert.equal(run.status,'completed',run.error);
});
