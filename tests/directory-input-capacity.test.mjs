import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {chatGPTStartChatTool} from '../lib/chatgpt-start-chat.mjs';

class Runtime extends EventEmitter {
  calls=[];
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
  async start(){return this.status();}
  async close(){}
  async runAgent(options){
    this.calls.push(options);
    const phase=JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1));
    const result=phase.label==='decompose'?{atomic:true}:phase.label==='integration'?{answer:'The complete fixture was considered.',used_refs:phase.payload.required_refs}:phase.label==='source-page'?{items:[{key:'tail',value:'LONG_SOURCE_TAIL',quote:'LONG_SOURCE_TAIL'}]}:{status:'complete',nextAction:'',finding:'The complete fixture was considered.',candidate_answer:'The complete fixture was considered.',uncertainty:''};
    return{output:JSON.stringify(result)};
  }
}
const workflow={name:'Large Directory input',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture',prompt:'Answer the current request.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off'}};

test('retired Directory rejects large start and continuation without invoking the model; ordinary capacity remains usable',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'directory-input-capacity-')),runtime=new Runtime();
 runtime.runAgent=async options=>{runtime.calls.push(options);return{output:'Ready'};};
 const app=await createHarnessServer({runtime,port:0,dataDir:path.join(root,'data'),defaultCwd:path.join(root,'workspace')});
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const base=await app.listen(),home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
 const post=async(route,value)=>{const response=await fetch(new URL(route,base),{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(value)});return{status:response.status,data:await response.json()};};
 const task='x'.repeat(1100000)+'LONG_SOURCE_TAIL';
 const denied=await post('/api/runs',{workflow,input:{task,directoryMode:'on',subagentsMode:'off'}});
 assert.equal(denied.status,410);assert.match(denied.data.error,/Directory execution is unavailable because conversation-folder context isolation is not established/);assert.equal(runtime.calls.length,0);
 const ordinary='x'.repeat(49996)+'TAIL';
 const first=await post('/api/runs',{workflow,input:{task:ordinary,directoryMode:'off'}});
 assert.equal(first.status,201,first.data.error);await app.engine.executions.get(first.data.id);
 assert.equal(app.engine.getRun(first.data.id).status,'completed');assert.ok(runtime.calls[0].prompt.includes(ordinary));
 const rejected=await post('/api/runs/'+first.data.id+'/continue',{nodeId:'agent',message:task,directoryMode:'on'});
 assert.equal(rejected.status,410);assert.match(rejected.data.error,/Directory execution is unavailable because conversation-folder context isolation is not established/);assert.equal(runtime.calls.length,1);
 const tooLong=await post('/api/runs',{workflow,input:{task:ordinary+'x',directoryMode:'off'}});
 assert.equal(tooLong.status,400);assert.match(tooLong.data.error,/50,000/);assert.equal(runtime.calls.length,1);
 const next=await post('/api/runs/'+first.data.id+'/continue',{nodeId:'agent',message:ordinary,directoryMode:'off'});
 assert.equal(next.status,201,next.data.error);await app.engine.executions.get(next.data.id);
 assert.equal(app.engine.getRun(next.data.id).status,'completed');assert.equal(app.engine.getRun(next.data.id).input,ordinary);assert.equal(runtime.calls.length,2);
});
test('direct Chat rejects retired Directory and oversized ordinary tasks before admission, but accepts the ordinary boundary',async()=>{
 const calls=[],engine={startRun:value=>(calls.push(value),{id:'fixture-run',status:'queued'}),runtime:{status:()=>({defaultModel:'fixture'})}};
 const tool=chatGPTStartChatTool({engine,defaultCwd:os.tmpdir()}),message='a'.repeat(50001)+'LAST_CHARACTER';
 await assert.rejects(tool.execute({requestId:'large-directory',directoryMode:'on',message},{client:{id:'fixture-owner'}}),error=>error.code==='DIRECTORY_RETIRED');
 await assert.rejects(tool.execute({requestId:'large-ordinary',message,directoryMode:'off'},{client:{id:'fixture-owner'}}),/50,000/);
 assert.equal(calls.length,0);
 await tool.execute({requestId:'ordinary-boundary',message:message.slice(0,50000),directoryMode:'off'},{client:{id:'fixture-owner'}});
 assert.equal(calls.length,1);assert.equal(calls[0].input.task,message.slice(0,50000));assert.equal(calls[0].input.directoryMode,'off');
});
