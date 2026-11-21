'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createCompletedBuild,assertCompletedBuild}=require('./build-completion.cjs');
// Synthetic identities only. These cases never launch a compiler or model and
// do not claim the dummy files are an observed completed native build.
const id=(name,value=name)=>({path:'C:\\fixture\\'+name,bytes:Buffer.byteLength(value),sha256:crypto.createHash('sha256').update(value).digest('hex')});
function fixture(){
 const inputs={freshInputs:id('fresh-inputs.json'),sourceState:id('source-state.json'),sourceContentSha256:id('source').sha256,sourceTools:[id('recipe.cjs')],
  toolchainReceipt:id('toolchain.json'),importBoundary:id('imports.json'),toolBinaries:[id('ninja.exe'),id('g++.exe')],
  importLibraries:[id('import.a')],mathLibraries:[id('ggml.dll')],generatedBuildFiles:[id('build.ninja')],
  disabledUi:{complete:true,sourceDistIndexExists:false,binaryDistIndexExists:false,outputs:[id('ui.cpp'),id('ui.h')]}};
 const command=(pending)=>({schema:'blackice.minicpm.fresh-build-command.v1',at:pending?'2026-01-01T00:00:02.000Z':'2026-01-01T00:00:00.000Z',
  command:inputs.toolBinaries[0].path,args:['-C','C:\\fixture\\build',...(pending?['-n']:['-j','2']),'llama-server'],cwd:'C:\\fixture',
  pid:42,exitCode:0,signal:null,error:null,durationMs:1000,modelStarted:false,stdout:pending?'ninja: no work to do.\r\n':'[1/1] Linking CXX executable bin\\llama-server.exe\r\n'});
 const value={at:'2026-01-01T00:00:03.000Z',before:structuredClone(inputs),after:structuredClone(inputs),
  outputs:[id('llama-server.exe','binary-old'),id('libserver.a','library-old')],link:{artifact:id('link.json'),data:command(false)},noPending:{artifact:id('pending.json'),data:command(true)}};
 const receipt=createCompletedBuild(value),observed={inputs:structuredClone(inputs),outputs:structuredClone(value.outputs),link:structuredClone(value.link),noPending:structuredClone(value.noPending)};
 return{value,receipt,observed};
}
test('actual-link receipt and exact observed build bind',()=>{const x=fixture();assert.equal(assertCompletedBuild(x.receipt,x.observed),true);});
test('new source with the old binary and libraries is rejected',()=>{const x=fixture();x.observed.inputs.sourceState=id('source-state.json','source-new');assert.throws(()=>assertCompletedBuild(x.receipt,x.observed),/INPUT_DRIFT/);});
test('changed executable bytes are rejected',()=>{const x=fixture();x.observed.outputs[0]=id('llama-server.exe','binary-new');assert.throws(()=>assertCompletedBuild(x.receipt,x.observed),/OUTPUT_DRIFT/);});
test('changed static-library bytes are rejected',()=>{const x=fixture();x.observed.outputs[1]=id('libserver.a','library-new');assert.throws(()=>assertCompletedBuild(x.receipt,x.observed),/OUTPUT_DRIFT/);});
test('existing outputs without a completed-build receipt are rejected',()=>{const x=fixture();assert.throws(()=>assertCompletedBuild(null,x.observed),/COMPLETED_BUILD_REQUIRED/);});
test('a no-op successful build cannot establish a new receipt',()=>{const x=fixture();x.value.link.data.stdout='ninja: no work to do.\n';assert.throws(()=>createCompletedBuild(x.value),/ACTUAL_FINAL_LINK_REQUIRED/);});
test('pending Ninja work rejects build completion',()=>{const x=fixture();x.value.noPending.data.stdout='[1/1] Linking CXX executable bin\\llama-server.exe\n';assert.throws(()=>createCompletedBuild(x.value),/NO_PENDING/);});
test('failed link cannot establish completion',()=>{const x=fixture();x.value.link.data.exitCode=1;assert.throws(()=>createCompletedBuild(x.value),/SUCCESSFUL_BUILD_COMMAND/);});
test('source mutation during link is rejected',()=>{const x=fixture();x.value.after.sourceState=id('source-state.json','changed-during-link');assert.throws(()=>createCompletedBuild(x.value),/CHANGED_DURING_LINK/);});
test('changed fixture recipe invalidates even byte-identical output',()=>{const x=fixture();x.observed.inputs.sourceTools=[id('recipe.cjs','recipe-new')];assert.throws(()=>assertCompletedBuild(x.receipt,x.observed),/INPUT_DRIFT/);});
test('changed generated build or compiler identity invalidates',()=>{for(const field of ['generatedBuildFiles','toolBinaries','importLibraries']){const x=fixture();x.observed.inputs[field][0].sha256=id('changed').sha256;assert.throws(()=>assertCompletedBuild(x.receipt,x.observed),/INPUT_DRIFT/);}});
test('changed command artifact invalidates completion',()=>{const x=fixture();x.observed.link.artifact.sha256=id('changed').sha256;assert.throws(()=>assertCompletedBuild(x.receipt,x.observed),/COMMAND_DRIFT/);});
