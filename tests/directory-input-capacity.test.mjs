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

test('large Directory messages reach the model through start and continue HTTP admission',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'directory-input-capacity-')),runtime=new Runtime();
  const app=await createHarnessServer({runtime,port:0,dataDir:path.join(root,'data'),defaultCwd:path.join(root,'workspace')});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  await app.learning.updateSettings({mode:'manual'});
  const base=await app.listen(),home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
  const post=async(route,value)=>{
    const response=await fetch(new URL(route,base),{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(value)});
    const data=await response.json();assert.equal(response.status,201,data.error);return data;
  };
  const task='QUESTION:\nExplain the source.\nSOURCE:\n'+'x'.repeat(1100000)+'LONG_SOURCE_TAIL';
  const first=await post('/api/runs',{workflow,input:{task,directoryMode:'on',subagentsMode:'off'}});
  await app.engine.executions.get(first.id);
  assert.equal(app.engine.getRun(first.id).status,'completed',app.engine.getRun(first.id).error);
  assert.ok(runtime.calls.some(call=>call.prompt.includes('x'.repeat(1100000)+'LONG_SOURCE_TAIL')),'the complete source reaches a fresh phase');
  const second=await post('/api/runs/'+first.id+'/continue',{nodeId:'agent',message:task});
  await app.engine.executions.get(second.id);
  assert.equal(app.engine.getRun(second.id).status,'completed',app.engine.getRun(second.id).error);
  assert.equal(app.engine.getRun(second.id).input,task);
});

test('direct Chat start admits long Directory tasks while preserving explicit ordinary-Chat admission',async()=>{
  const calls=[],engine={startRun:value=>(calls.push(value),{id:'fixture-run',status:'queued'}),runtime:{status:()=>({defaultModel:'fixture'})}};
  const tool=chatGPTStartChatTool({engine,defaultCwd:os.tmpdir()}),message='a'.repeat(50001)+'LAST_CHARACTER';
  assert.equal(tool.definition.inputSchema.properties.message.maxLength,undefined);
  await tool.execute({requestId:'large-directory',message},{client:{id:'fixture-owner'}});
  assert.equal(calls[0].input.task,message);assert.equal(calls[0].input.directoryMode,'on');
  await assert.rejects(tool.execute({requestId:'large-ordinary',message,directoryMode:'off'},{client:{id:'fixture-owner'}}),/50,000/);
});
