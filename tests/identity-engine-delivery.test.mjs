import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {IdentityStore} from '../lib/identity.mjs';
for (const directoryMode of ['off','on']) test('identity delivered in '+directoryMode+' mode stays frozen during active turn, updates next turn', async t => {
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-soul-engine-'));
 const cwd=path.join(dir,'workspace'); await mkdir(cwd);
 const dataDir=path.join(dir,'data'), identity=await new IdentityStore({dataDir}).init();
 let admitted, release;const entered=new Promise(r=>admitted=r), gate=new Promise(r=>release=r);
 class Runtime extends EventEmitter {
  calls=[]; store={get:()=>({baseUrl:'https://api.example/v1'})};
  status(){return {connected:true,authenticated:true,defaultModel:'fixture::remote',models:[{id:'fixture::remote',supportsTools:true}]};}
  async runAgent(options){
   this.calls.push(options); if(this.calls.length===1){admitted();await gate;}
   const phase=options.prompt.includes('SHADOWDANCER DIRECTORY MODE.')?JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1).split('\nREPOSITORY ')[0]):null;
   const result=!phase?'Fixture complete.':phase.label==='decompose'?{atomic:true}:phase.label==='integration'?{answer:'Fixture complete.',used_refs:phase.payload.required_refs}:{status:'complete',nextAction:'',finding:'Fixture finding.',candidate_answer:'Fixture complete.',uncertainty:''};
   return {output:typeof result==='string'?result:JSON.stringify(result),threadId:'fixture-'+this.calls.length};
  }
 }
 const runtime=new Runtime(),engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd,identity}).init();
 engine.runtimeSettings={get:()=>({subagentsEnabled:false,executionGuardrails:false})};
 t.after(async()=>{release();await engine.close();await identity.close();await rm(dir,{recursive:true,force:true});});
 const workflow={name:'Identity delivery',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture::remote',prompt:'Reply briefly.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off'}};
 const first=engine.startRun({workflow,input:{task:'Reply briefly.',directoryMode}});
 await entered;const oldText=JSON.stringify(runtime.calls[0]);
 assert.match(oldText,/calibrated inference/);
 const doc=await identity.read('soul');
 await identity.update({kind:'soul',content:'# Custom identity\nCUSTOM_NEXT_TURN',expectedRevision:doc.revision,expectedHash:doc.diskHash});
 release();await engine.executions.get(first.id);
 assert.equal(engine.getRun(first.id).status,'completed',engine.getRun(first.id).error);
 const count=runtime.calls.length;
 assert.ok(runtime.calls.every(c=>JSON.stringify(c).includes('calibrated inference')));
 assert.ok(runtime.calls.every(c=>!JSON.stringify(c).includes('CUSTOM_NEXT_TURN')));
 if(directoryMode==='on')assert.ok(count>=3);
 const second=engine.startRun({workflow,input:{task:'Reply again.',directoryMode}});await engine.executions.get(second.id);
 assert.equal(engine.getRun(second.id).status,'completed',engine.getRun(second.id).error);
 assert.ok(runtime.calls.slice(count).every(c=>JSON.stringify(c).includes('CUSTOM_NEXT_TURN')));
 assert.equal(JSON.stringify(runtime.calls[0]),oldText);
});
