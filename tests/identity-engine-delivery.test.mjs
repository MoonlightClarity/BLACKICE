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
  calls=[]; soulReads=[]; store={get:()=>({baseUrl:'https://api.example/v1'})};
  status(){return {connected:true,authenticated:true,defaultModel:'fixture::remote',models:[{id:'fixture::remote',supportsTools:true}]};}
  async runAgent(options){
   this.calls.push(options); if(this.calls.length===1){admitted();await gate;}
   if(options.dynamicTools?.some(t=>t.name==='relay_identity')) this.soulReads.push(JSON.parse((await options.onToolCall({name:'relay_identity',arguments:{action:'read',kind:'soul'}})).contentItems[0].text));
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
 assert.match(oldText,/GENERAL ANALYTICAL METHOD/);
 assert.doesNotMatch(oldText,/## Execution and coordination|## Verification and practical learning/);
 const doc=await identity.read('soul');
 await identity.update({kind:'soul',content:'# Custom identity\nCUSTOM_NEXT_TURN',expectedRevision:doc.revision,expectedHash:doc.diskHash});
 release();await engine.executions.get(first.id);
 assert.equal(engine.getRun(first.id).status,'completed',engine.getRun(first.id).error);
 const count=runtime.calls.length, readCount=runtime.soulReads.length;
 assert.ok(readCount>0);assert.ok(runtime.soulReads.every(r=>r.content===doc.content&&r.hash===doc.hash&&r.revision===doc.revision));
 assert.ok(runtime.calls.every(c=>JSON.stringify(c).includes('calibrated inference')));
 assert.ok(runtime.calls.every(c=>!JSON.stringify(c).includes('CUSTOM_NEXT_TURN')));
 if(directoryMode==='on')assert.ok(count>=3);
 const second=engine.startRun({workflow,input:{task:'Reply again.',directoryMode}});await engine.executions.get(second.id);
 assert.equal(engine.getRun(second.id).status,'completed',engine.getRun(second.id).error);
 assert.ok(runtime.calls.slice(count).every(c=>JSON.stringify(c).includes('CUSTOM_NEXT_TURN')));
 assert.equal(JSON.stringify(runtime.calls[0]),oldText);
 assert.ok(runtime.soulReads.length>readCount);assert.ok(runtime.soulReads.slice(readCount).every(r=>r.content==='# Custom identity\nCUSTOM_NEXT_TURN'));
});

test('sequential agent nodes share admission SOUL while USER remains live and next execution sees user edit',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-soul-sequential-'));
 const cwd=path.join(dir,'workspace');await mkdir(cwd);
 const dataDir=path.join(dir,'data'),identity=await new IdentityStore({dataDir}).init();
 const original=await identity.read('soul');
 let enteredA,releaseA;const entered=new Promise(r=>enteredA=r),gate=new Promise(r=>releaseA=r);
 class Runtime extends EventEmitter {
  calls=[];reads=[];store={get:()=>({baseUrl:'https://api.example/v1'})};
  status(){return {connected:true,authenticated:true,defaultModel:'fixture::remote',models:[{id:'fixture::remote',supportsTools:true}]};}
  async runAgent(options){
   this.calls.push(options);
   if(this.calls.length===1){enteredA();await gate;}
   const read=async kind=>JSON.parse((await options.onToolCall({name:'relay_identity',arguments:{action:'read',kind}})).contentItems[0].text);
   this.reads.push({soul:await read('soul'),user:await read('user')});
   return {output:'Fixture complete.',threadId:'sequential-'+this.calls.length};
  }
 }
 const runtime=new Runtime(),engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd,identity}).init();
 engine.runtimeSettings={get:()=>({subagentsEnabled:false,executionGuardrails:false})};
 t.after(async()=>{releaseA();await engine.close();await identity.close();await rm(dir,{recursive:true,force:true});});
 const workflow={name:'Sequential identity',nodes:[{id:'input',type:'input'},{id:'a',type:'agent',model:'fixture::remote',prompt:'First step.'},{id:'b',type:'agent',model:'fixture::remote',prompt:'Second step.'},{id:'output',type:'output'}],edges:[{source:'input',target:'a'},{source:'a',target:'b'},{source:'b',target:'output'}],settings:{planningMode:'off'}};
 const first=engine.startRun({workflow,input:{task:'Two steps.',directoryMode:'off'}});
 await entered;
 const changed=await identity.update({kind:'soul',content:'# NEXT_EXECUTION_SOUL',expectedRevision:original.revision,expectedHash:original.diskHash,provenance:{source:'user'}});
 const user=await identity.read('user');
 await identity.update({kind:'user',content:'# LIVE_USER_EDIT',expectedRevision:user.revision,expectedHash:user.diskHash,provenance:{source:'user'}});
 releaseA();await engine.executions.get(first.id);
 assert.equal(engine.getRun(first.id).status,'completed',engine.getRun(first.id).error);
 assert.equal(runtime.calls.length,2);assert.equal(runtime.reads.length,2);
 for(const {soul,user} of runtime.reads){assert.equal(soul.content,original.content);assert.equal(soul.hash,original.hash);assert.equal(soul.revision,original.revision);assert.equal(user.content,'# LIVE_USER_EDIT');}
 for(const call of runtime.calls){assert.match(JSON.stringify(call),/calibrated inference/);assert.doesNotMatch(JSON.stringify(call),/NEXT_EXECUTION_SOUL/);}
 assert.match(JSON.stringify(runtime.calls[1]),/LIVE_USER_EDIT/);
 const second=engine.startRun({workflow,input:{task:'Two new steps.',directoryMode:'off'}});
 await engine.executions.get(second.id);assert.equal(engine.getRun(second.id).status,'completed',engine.getRun(second.id).error);
 assert.equal(runtime.calls.length,4);
 for(const {soul} of runtime.reads.slice(2)){assert.equal(soul.content,changed.content);assert.equal(soul.hash,changed.hash);assert.equal(soul.revision,changed.revision);}
 for(const call of runtime.calls.slice(2))assert.match(JSON.stringify(call),/NEXT_EXECUTION_SOUL/);
});
