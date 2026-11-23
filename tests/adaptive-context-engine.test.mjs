import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';

const graph={name:'Adaptive context threshold',nodes:[
 {id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture',prompt:'Read the investigation log and cite evidence'},
 {id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){return this.execute(options);}
}
test('default adaptive policy retains early source reads and archives later repeated results without losing the exact marker',{timeout:45000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'adaptive-context-engine-'));
 const log=path.join(root,'incident.txt');
 const marker='CRITICAL_VERIFIED_INCIDENT_MARKER';
 await writeFile(log,Array.from({length:260},(_,i)=>String(i).padStart(4,'0')+
   ' investigation evidence '+(i===10?marker:'ordinary event')+' detail '.repeat(17)).join('\n')+'\n');
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'data'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 let kept=0,archived=0,firstSize=0,found=false;
 runtime.execute=async options=>{
  assert(options.dynamicTools.some(x=>x.name==='relay_context_page'));
  let seq=0;
  const call=(name,args)=>options.onToolCall({name,arguments:args,callId:'adaptive-'+(++seq)});
  for(let n=0;n<12;n++){
   const response=await call('relay_workspace',{action:'read',path:log,startLine:1,lineCount:110});
   assert.equal(response.success,true,JSON.stringify(response));
   const text=response.contentItems[0].text,parsed=JSON.parse(text);
   if(n===0){
    firstSize=Buffer.byteLength(text);
    assert(firstSize>12000,'The first returned page must be large enough for this test.');
   }
   if(parsed.externalContext){
    archived++;
    assert(n>0,'Early evidence must remain inline.');
    assert(parsed.bytes>=firstSize);
    if(!found){
     const search=await call('relay_context_page',{action:'search',reference:parsed.reference,needle:marker});
     assert.equal(search.success,true);
     const offset=JSON.parse(search.contentItems[0].text).matches[0]?.offset;
     assert(Number.isInteger(offset));
     const page=await call('relay_context_page',{action:'read',reference:parsed.reference,offset,maxBytes:512});
     assert.equal(page.success,true);
     assert(JSON.parse(page.contentItems[0].text).text.startsWith(marker));
     found=true;
    }
   }else{
    kept++;
    assert(parsed.content.includes(marker));
   }
  }
  assert(kept>=2,'The adaptive controller should retain several early observations.');
  assert(archived>=1,'The cumulative output budget must trigger archival.');
  assert(found);
  return{output:'Evidence preserved, then paged when accumulated.'};
 };
 const run=engine.startRun({workflow:graph,input:{task:'Read the incident repeatedly and locate decisive evidence',directoryActions:'off'}});
 await engine.executions.get(run.id);
 assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
 t.diagnostic('Adaptive model-facing reads: '+kept+' inline, '+archived+' externalized, initial original '+firstSize+' bytes.');
});
