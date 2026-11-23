import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';

const graph={name:'Ordinary Chat context',nodes:[
 {id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture-model',prompt:'Answer using workspace files'},
 {id:'o',type:'output'}],
 edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,models:[{id:'fixture-model',supportsTools:true}]};}
 async runAgent(options){return this.execute(options);}
}
test('new ordinary Chat stores large read results externally and can search/page exact evidence without Action Directory',{timeout:40000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'ordinary-context-engine-'));
 const dataDir=path.join(root,'data'),file=path.join(root,'incident.log');
 const marker='CRITICAL_FINAL_DIAGNOSIS_20261123';
 await writeFile(file,'trace-0\n'+Array.from({length:300},(_,i)=>String(i+1).padStart(4,'0')+' opaque event '.repeat(8)).join('\n')+'\n'+marker);
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir,defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 let originalBytes=0,modelBytes=0;
 runtime.execute=async o=>{
  const tools=o.dynamicTools.map(x=>x.name);
  assert(tools.includes('relay_context_page'),'Paging should be available with Directory Off.');
  assert(!tools.includes('relay_directory_action'));
  const call=async(name,args,id)=>o.onToolCall({name,arguments:args,callId:id});
  const read=await call('relay_workspace',{action:'read',path:file,startLine:150,lineCount:153},'read-input');
  assert.equal(read.success,true);
  const text=read.contentItems[0].text;
  modelBytes=Buffer.byteLength(text);
  const pointer=JSON.parse(text);
  assert(pointer.externalContext,JSON.stringify(pointer).slice(0,800));
  assert.equal(pointer.tool,'relay_workspace');
  assert.match(JSON.stringify(pointer.preview.tail),/CRITICAL_FINAL_DIAGNOSIS/);
  originalBytes=pointer.bytes;
  assert(modelBytes<originalBytes/4);
  const search=await call('relay_context_page',{action:'search',reference:pointer.reference,needle:marker},'search-tail');
  assert.equal(search.success,true);
  const hits=JSON.parse(search.contentItems[0].text).matches;
  assert.equal(hits.length,1);
  const page=await call('relay_context_page',{action:'read',reference:pointer.reference,offset:hits[0].offset,maxBytes:512},'read-tail');
  assert.equal(page.success,true);
  assert(JSON.parse(page.contentItems[0].text).text.startsWith(marker));
  const short=await call('relay_workspace',{action:'read',path:file,startLine:1,lineCount:1},'short-read');
  assert.equal(short.success,true);
  assert(!JSON.parse(short.contentItems[0].text).externalContext);
  assert.equal(await o.onBeforeFinal?.({output:'Verified a diagnostic marker in original tool result.',signal:o.signal}),undefined);
  return{output:'Verified a diagnostic marker in original tool result.'};
 };
 const run=engine.startRun({workflow:graph,input:{task:'Inspect incident and locate final diagnosis',directoryActions:'off'}});
 await engine.executions.get(run.id);
 assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
 assert(modelBytes<originalBytes/4);
});
