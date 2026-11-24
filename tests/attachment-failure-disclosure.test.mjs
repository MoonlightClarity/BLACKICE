import {ProviderRuntime} from '../lib/providers.mjs';
import {ATTACHMENT_TOOL} from '../lib/attachments.mjs';
import {EventEmitter} from 'node:events';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import test from 'node:test';
for (const recover of [false,true]) test('attachment failure with recovery = '+recover,async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-read-failure-'));
  const codex=new EventEmitter();codex.status=()=>({models:[]});codex.close=async()=>{};
  let step=0;const events=[];
  const fetchImpl=async(url,options)=>{
    if(!String(url).includes('chat/completions'))return Response.json({data:[{id:'fixture'}]});
    const body=JSON.parse(options.body);
    if(step===1)assert.match(body.messages.at(-1).content,/Tool failed: relay_files/);
    const calls=[['relay_files',{action:'read',attachmentId:'id'}],recover?['relay_files',{action:'read',attachmentId:'id'}]:['relay_identity',{action:'read'}]];
    const call=calls[step++];
    if(call)return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call'+step,type:'function',function:{name:call[0],arguments:JSON.stringify(call[1])}}]},finish_reason:'tool_calls'}]});
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'Model assessment'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const runtime=await new ProviderRuntime({codex,dataDir:dir,fetchImpl}).init();
  t.after(async()=>{await runtime.close();await fs.rm(dir,{recursive:true,force:true})});
  await runtime.saveProvider({id:'test-local',preset:'compatible',type:'compatible',baseUrl:'http://127.0.0.1:1/v1',models:['fixture'],maxSteps:4});
  const result=await runtime.runAgent({cwd:dir,prompt:'Analyze attachment',model:'test-local::fixture',dynamicTools:[ATTACHMENT_TOOL,{...ATTACHMENT_TOOL,name:'relay_identity'}],onEvent:e=>events.push(e),onToolCall:async()=>({success:step!==1,contentItems:[{type:'inputText',text:step===1?'missing':'{"text":"sample"}'}]})});
  assert.equal(step,3);
  assert.equal(result.output,recover?'Model assessment':'relay_files read failed. I could not verify the requested attachment content.');
  assert.equal(events.some(e=>e.type==='delta'&&e.delta.includes('Model assessment')),recover);
});
