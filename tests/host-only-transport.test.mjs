import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProviderRuntime} from '../lib/providers.mjs';
import {CodexRuntime} from '../lib/codex.mjs';
class FakeCodex extends EventEmitter{
 constructor(){super();this.calls=0;}
 status(){return {connected:true,authenticated:true,defaultModel:'native',models:[{model:'native'}]};}
 async close(){}
 async runAgent(){this.calls++;throw Error('Native fixture must not execute.');}
}
const tool={name:'relay_browser',description:'Controlled synthetic browser',inputSchema:{type:'object',properties:{action:{type:'string'}},required:['action'],additionalProperties:false}};
async function fixture(t,{type='openai',unknown=false,callTool=true}={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'host-only-transport-')),requests=[],codex=new FakeCodex();let posted=0,calls=0;
 const runtime=await new ProviderRuntime({codex,dataDir:directory,fetchImpl:async(url,options)=>{
  if(options.method==='GET')return new Response(JSON.stringify({data:[{id:'synthetic'}]}),{status:200,headers:{'content-type':'application/json'}});
  const body=JSON.parse(options.body);requests.push(body);const first=posted++===0&&callTool,name=unknown?'exec_command':'relay_browser';
  const data=type==='openai'?{id:'response-'+posted,status:'completed',output:first?[{type:'function_call',id:'item',call_id:'call',name,arguments:'{"action":"read"}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic final'}]}],usage:{input_tokens:1,output_tokens:1}}
   :type==='anthropic'?{id:'message-'+posted,type:'message',role:'assistant',content:first?[{type:'tool_use',id:'call',name,input:{action:'read'}}]:[{type:'text',text:'Synthetic final'}],stop_reason:first?'tool_use':'end_turn',usage:{input_tokens:1,output_tokens:1}}
   :{choices:[{message:{role:'assistant',content:first?null:'Synthetic final',...(first?{tool_calls:[{id:'call',type:'function',function:{name,arguments:'{"action":"read"}'}}]}:{})},finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1}};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 }}).init();
 await runtime.saveProvider({id:'fixture',type,baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic-not-a-real-key',models:['synthetic']});
 t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
 return {runtime,codex,requests,directory,calls:()=>calls,options:{cwd:directory,prompt:'Synthetic protected task',model:'fixture::synthetic',hostOnlyTools:true,dynamicTools:[tool],onToolCall:async call=>{calls++;assert.equal(call.name,'relay_browser');return {success:true,contentItems:[{type:'inputText',text:'{"synthetic":true}'}]};}}};
}
for(const type of ['openai','compatible','anthropic'])test(type+' protected transport sends only attached host functions and dispatches through host callback',async t=>{
 const f=await fixture(t,{type});assert.equal(f.runtime.supportsHostOnlyToolDispatch({model:'fixture::synthetic'}),true);
 assert.equal(f.runtime.supportsHostOnlyToolDispatch({model:'native'}),false);assert.equal(f.runtime.supportsHostOnlyToolDispatch(),false);
 const result=await f.runtime.runAgent(f.options);assert.equal(result.output,'Synthetic final');assert.equal(f.calls(),1);
 assert.equal(f.codex.calls,0);assert.equal(f.requests.length,2);
 for(const body of f.requests){assert.equal(body.tools.length,1);assert.equal(body.tools[0].name||body.tools[0].function?.name,'relay_browser');if(type!=='anthropic')assert.equal(body.tools[0].type,'function');}
 const saved=await f.runtime.readThread(result.threadId);assert.equal(saved.hostOnlyTools,true);assert.match(saved.hostOnlyCatalogHash,/^[a-f0-9]{64}$/);
 const before=f.requests.length;
 await assert.rejects(f.runtime.runAgent({...f.options,threadId:result.threadId,hostOnlyTools:false}),{code:'HOST_ONLY_TOOLS_REQUIRED'});
 await assert.rejects(f.runtime.runAgent({...f.options,threadId:result.threadId,dynamicTools:[]}),{code:'HOST_ONLY_CATALOG_CHANGED'});
 assert.equal(f.requests.length,before);
});
test('unknown API tool cannot invoke an unregistered host capability',async t=>{
 const f=await fixture(t,{unknown:true});await f.runtime.runAgent(f.options);assert.equal(f.calls(),0);assert.equal(f.codex.calls,0);
});
test('unverified native routes still fail before a protected provider turn',async t=>{
 const f=await fixture(t);
 assert.equal(f.runtime.supportsHostOnlyToolDispatch({model:'native'}),false);
 await assert.rejects(f.runtime.runAgent({...f.options,model:'native'}),{code:'HOST_ONLY_TRANSPORT_UNSUPPORTED'});
 await assert.rejects(f.runtime.runAgent({...f.options,model:'native',threadId:'native-old'}),{code:'HOST_ONLY_FRESH_SESSION_REQUIRED'});
 assert.equal(f.requests.length,0);assert.equal(f.codex.calls,0);
 const native=new CodexRuntime({command:process.execPath,spawnImpl(){throw Error('No process may start');}});
 await assert.rejects(native.runAgent({cwd:f.directory,prompt:'Synthetic',hostOnlyTools:true,threadId:'old-native-thread'}),{code:'HOST_ONLY_FRESH_SESSION_REQUIRED'});
});

test('verified native Luna selects native protected transport without an API substitution',async t=>{
 const f=await fixture(t);
 f.codex.supportsHostOnlyToolDispatch=()=>true;
 f.codex.runAgent=async options=>{
  f.codex.calls++;
  assert.equal(options.model,'gpt-6-luna');
  assert.equal(options.hostOnlyTools,true);
  assert.equal(options.dynamicTools?.[0]?.name,'relay_browser');
  return {output:'Protected native result'};
 };
 assert.equal(f.runtime.supportsHostOnlyToolDispatch({model:'gpt-6-luna'}),true);
 const result=await f.runtime.runAgent({...f.options,model:'gpt-6-luna'});
 assert.equal(result.output,'Protected native result');
 assert.equal(f.codex.calls,1);
 assert.equal(f.requests.length,0);
});
test('old unprotected API history cannot silently upgrade to protected execution',async t=>{
 const f=await fixture(t,{callTool:false});const result=await f.runtime.runAgent({...f.options,hostOnlyTools:false});
 const before=f.requests.length;await assert.rejects(f.runtime.runAgent({...f.options,threadId:result.threadId}),{code:'HOST_ONLY_FRESH_SESSION_REQUIRED'});assert.equal(f.requests.length,before);
});
test('response-only API helper keeps the protected boundary and no operational tools',async t=>{
 const f=await fixture(t,{callTool:false});await f.runtime.runAgent({...f.options,responseOnly:true,dynamicTools:[]});assert.deepEqual(f.requests[0].tools,[]);assert.equal(f.requests[0].tool_choice,'none');assert.equal(f.calls(),0);
});
