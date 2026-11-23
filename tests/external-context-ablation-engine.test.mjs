import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';

const graph={name:'Ablation same runtime',nodes:[
 {id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture',prompt:'Read and inspect a saved result'},
 {id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){return this.execute(options);}
}
test('explicit context-paging ablation keeps full tool text with the same Engine and model, without adding retrieval tools',{timeout:40000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'context-ablation-'));
 const file=path.join(root,'log.txt'),marker='TAIL-VERIFIED-CONTEXT';
 await writeFile(file,'start\n'+('a b c d e '.repeat(1600))+'\n'+marker);
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'data'),defaultCwd:root,contextPagingEnabled:false}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 runtime.execute=async options=>{
  assert(!options.dynamicTools.some(tool=>tool.name==='relay_context_page'));
  const read=await options.onToolCall({name:'relay_workspace',arguments:{action:'read',path:file},callId:'ablation-read'});
  assert.equal(read.success,true);
  const raw=read.contentItems[0].text;
  assert(Buffer.byteLength(raw,'utf8')>12000);
  const object=JSON.parse(raw);
  assert(!object.externalContext);
  assert(object.content.includes(marker));
  return{output:'Read exact original, including final marker.'};
 };
 const run=engine.startRun({workflow:graph,input:{task:'Read the incident log',directoryActions:'off'}});
 await engine.executions.get(run.id);
 assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
});
