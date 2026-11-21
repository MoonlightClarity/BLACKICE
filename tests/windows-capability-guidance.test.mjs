import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {WORKSPACE_INSTRUCTIONS,WORKSPACE_TOOL} from '../lib/workspace-tools.mjs';
import {capabilityGuidance} from '../lib/tool-routing.mjs';
const workflow={id:'windows-guidance',name:'Windows guidance',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',prompt:'Inspect available tools.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off'}};
for(const available of [false,true])test('engine native Windows guidance follows actual availability '+available,async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'windows-guidance-'));let sent;
 class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,defaultModel:'test-model'};}async runAgent(options){sent=options;return{output:'Observed catalog',threadId:'fixture'};}}
 const engine=await new HarnessEngine({runtime:new Runtime(),dataDir:dir,defaultCwd:dir,nativeWindows:{availability:()=>({available})}}).init();
 t.after(async()=>{await engine.close();await rm(dir,{recursive:true,force:true});});
 const run=engine.startRun({workflow,input:'Inspect actual capabilities'});await engine.executions.get(run.id);
 assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
 const text=JSON.stringify(sent);assert.equal(text.includes('NATIVE APPLICATIONS'),available);
 assert.equal(engine.getRun(run.id).nodes.agent.toolNames.includes('relay_windows'),available);
 assert.doesNotMatch(text,/Live Windows desktop UIA is retired; do not operate existing user windows/);
 if(!available)assert.doesNotMatch(text,/relay_windows manages arbitrary real Windows applications/);
});
test('worker catalog does not advertise native Windows capability',()=>{
 const text=WORKSPACE_INSTRUCTIONS+capabilityGuidance([WORKSPACE_TOOL],{planningMode:'off'});
 assert.doesNotMatch(text,/relay_windows|NATIVE APPLICATIONS|do not operate existing user windows/);
 assert.match(text,/ATTACHED TOOLS\nrelay_workspace(?:\n|$)/);
});
test('native instructions are emitted after worker and unavailable-model catalog filtering',async()=>{
 const source=await readFile(new URL('../lib/engine.mjs',import.meta.url),'utf8');
 const emit=source.indexOf('if (dynamicTools.some(tool => tool.name === NATIVE_WINDOWS_TOOL.name)) appendHarness(NATIVE_WINDOWS_INSTRUCTIONS');
 assert.ok(emit>source.indexOf('if (scopedWorker) dynamicTools = dynamicTools.filter'));
 assert.ok(emit>source.indexOf('if(toolCapability.available===false){dynamicTools=[]'));
 assert.equal(source.split('appendHarness(NATIVE_WINDOWS_INSTRUCTIONS').length-1,1);
});
