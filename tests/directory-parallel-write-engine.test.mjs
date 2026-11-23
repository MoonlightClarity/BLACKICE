import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProviderRuntime} from '../lib/providers.mjs';
import {HarnessEngine} from '../lib/engine.mjs';

class NoNative extends EventEmitter{
 status(){return{connected:false,authenticated:false,models:[]};}
 async close(){}
 async runAgent(){throw Error('Unexpected native fallback');}
}
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('real compatible-provider Engine accepts concurrent distinct writes within one Planning+Directory repair action',{timeout:45000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'directory-concurrent-engine-'));
 let runtime,engine,server,stage=0,planning=0;
 const targetA=path.join(root,'a.mjs'),targetB=path.join(root,'b.mjs');
 server=http.createServer(async(req,res)=>{
  try{
   res.setHeader('Content-Type','application/json');
   if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
   let body='';for await(const part of req)body+=part;
   const request=JSON.parse(body),messages=JSON.stringify(request.messages);
   const send=(message)=>res.end(JSON.stringify({choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message}],usage:{prompt_tokens:90,completion_tokens:25,total_tokens:115}}));
   if(messages.includes('This is one bounded planning phase')){
     planning++;
     send({role:'assistant',content:JSON.stringify({artifact:{status:'proposed',focus:'repair',
       reason:'Both writes are required to deliver the current request.',sourceRefs:[],
       actions:[{id:'repair',objective:'Write and verify both source files',dependsOn:[]}]}})});
     return;
   }
   let calls;
   switch(stage++){
     case 0: calls=[call('focus','relay_directory_action',{action:'focus',id:'repair'})];break;
     case 1: calls=[
       call('write-a','relay_workspace',{action:'write',path:targetA,text:'export const a=1;\n'}),
       call('write-b','relay_workspace',{action:'write',path:targetB,text:'export const b=2;\n'}),
     ];break;
     case 2: calls=[call('observe','relay_directory_action',{action:'observe',outcome:'objective-met',id:'repair',
       claim:'Both workspace files were written successfully.',
       receipts:['receipt-1','receipt-2']})];break;
     default:send({role:'assistant',content:'Both source files were written.'});return;
   }
   send({role:'assistant',content:null,tool_calls:calls});
  }catch(error){
   res.statusCode=500;res.end(JSON.stringify({error:{message:error.message}}));
  }
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{
   await engine?.close();
   await runtime?.close();
   server.closeAllConnections();
   if(server.listening)await new Promise(resolve=>server.close(resolve));
   await rm(root,{recursive:true,force:true});
 });
 runtime=await new ProviderRuntime({codex:new NoNative(),dataDir:path.join(root,'provider'),
   modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
 await runtime.saveProvider({id:'fixture',type:'compatible',
   baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',
   models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},
   {preserveDefault:true});
 engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:root}).init();
 const graph={name:'Parallel fixes',nodes:[
   {id:'i',type:'input'},{id:'a',type:'agent',name:'Repairer',model:'fixture::fixture',
     prompt:'Perform both writes and record the exact returned receipts.'},{id:'o',type:'output'}],
   edges:[{source:'i',target:'a'},{source:'a',target:'o'}],
   settings:{maxParallel:1,planningMode:'off'}};
 const task='Write both independent source files in this workspace.';
 const started=engine.startRun({workflow:graph,input:{task,cwd:root,directoryActions:'on',chatPlanning:'on'}});
 await engine.executions.get(started.id);
 const run=engine.getRun(started.id);
 const ledger=(await engine.actionDirectories.get(started.id,task)).read();
 assert.equal(planning,1,'The actual Planning decomposition pass must run.');
 assert.equal(stage,4,'The agent must reach final after the parallel write batch.');
 assert.equal(await readFile(targetA,'utf8'),'export const a=1;\n');
 assert.equal(await readFile(targetB,'utf8'),'export const b=2;\n');
 assert.equal(ledger.receipts.length,2);
 assert(ledger.receipts.every(row=>row.state==='returned'&&row.success===true),
   'There is no spurious in-flight UNKNOWN receipt or duplicate effect.');
 assert.equal(ledger.actions[0].state,'observed',JSON.stringify(ledger.actions));
 assert.equal(run.status,'completed',run.error);
});
