'use strict';
// Pure validation shared by the actual build/fixture path and focused negative
// cases. All filesystem/process observations are supplied by native-build-common.
const path=require('node:path');
const SCHEMA='blackice.minicpm.fresh-build-completion.v1';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const identity=x=>x&&typeof x.path==='string'&&path.win32.isAbsolute(x.path)&&Number.isSafeInteger(x.bytes)&&x.bytes>=0&&/^[a-f0-9]{64}$/.test(x.sha256);
function requireValue(ok,code){if(!ok)throw Error(code);}
function successful(command){
 requireValue(command&&command.schema==='blackice.minicpm.fresh-build-command.v1'&&command.exitCode===0&&command.signal===null&&command.error===null&&Number.isSafeInteger(command.pid)&&command.pid>0&&Number.isSafeInteger(command.durationMs)&&command.durationMs>=0&&Number.isFinite(Date.parse(command.at))&&typeof command.stdout==='string'&&command.modelStarted===false,'SUCCESSFUL_BUILD_COMMAND_REQUIRED');
}
function inputShape(value){
 requireValue(value&&identity(value.freshInputs)&&identity(value.sourceState)&&/^[a-f0-9]{64}$/.test(value.sourceContentSha256)&&identity(value.toolchainReceipt)&&identity(value.importBoundary),'BUILD_INPUT_BINDING_REQUIRED');
 for(const name of ['sourceTools','toolBinaries','importLibraries','mathLibraries','generatedBuildFiles']){
  requireValue(Array.isArray(value[name])&&value[name].length>0&&value[name].every(identity),'BUILD_INPUT_IDENTITIES_REQUIRED:'+name);
 }
 requireValue(value.disabledUi?.complete===true&&value.disabledUi.sourceDistIndexExists===false&&value.disabledUi.binaryDistIndexExists===false&&value.disabledUi.outputs?.length===2&&value.disabledUi.outputs.every(identity),'DISABLED_UI_PROOF_REQUIRED');
}
function outputShape(outputs){
 requireValue(Array.isArray(outputs)&&outputs.length>=2&&outputs.every(identity)&&new Set(outputs.map(x=>x.path.toLowerCase())).size===outputs.length,'BUILD_OUTPUT_IDENTITIES_REQUIRED');
 requireValue(outputs.filter(x=>path.win32.basename(x.path)==='llama-server.exe').length===1&&outputs.some(x=>x.path.endsWith('.a')),'EXECUTABLE_AND_STATIC_LIBRARIES_REQUIRED');
}
function commandProof(proof,inputs,mode){
 requireValue(identity(proof?.artifact),'BUILD_COMMAND_ARTIFACT_REQUIRED');successful(proof.data);
 const command=proof.data,ninja=inputs.toolBinaries.find(x=>path.win32.basename(x.path)==='ninja.exe');
 requireValue(ninja&&command.command===ninja.path&&Array.isArray(command.args)&&command.args.at(-1)==='llama-server','NINJA_SERVER_TARGET_REQUIRED');
 if(mode==='link'){
  requireValue(!command.args.includes('-n')&&/Linking CXX executable (?:bin[\\/])?llama-server\.exe(?:\s|$)/.test(command.stdout),'ACTUAL_FINAL_LINK_REQUIRED');
 }else{
  requireValue(command.args.includes('-n')&&/^ninja: no work to do\.$/m.test(command.stdout.replaceAll('\r',''))&&!/\[\d+\/\d+\]/.test(command.stdout),'NO_PENDING_NINJA_WORK_REQUIRED');
 }
}
function createCompletedBuild({at,before,after,outputs,link,noPending}){
 inputShape(before);inputShape(after);outputShape(outputs);
 requireValue(same(before,after),'BUILD_INPUT_CHANGED_DURING_LINK');
 commandProof(link,after,'link');commandProof(noPending,after,'pending');
 requireValue(Date.parse(noPending.data.at)>=Date.parse(link.data.at)+link.data.durationMs,'POST_LINK_DRY_RUN_REQUIRED');
 return{schema:SCHEMA,at,complete:true,modelStarted:false,before,after,outputs,link,noPending};
}
function assertCompletedBuild(receipt,observed){
 requireValue(receipt?.schema===SCHEMA&&receipt.complete===true&&receipt.modelStarted===false,'COMPLETED_BUILD_REQUIRED');
 createCompletedBuild(receipt);
 inputShape(observed?.inputs);outputShape(observed?.outputs);
 requireValue(same(receipt.after,observed.inputs),'COMPLETED_BUILD_INPUT_DRIFT');
 requireValue(same(receipt.outputs,observed.outputs),'COMPLETED_BUILD_OUTPUT_DRIFT');
 requireValue(same(receipt.link,observed.link)&&same(receipt.noPending,observed.noPending),'COMPLETED_BUILD_COMMAND_DRIFT');
 return true;
}
module.exports={SCHEMA,createCompletedBuild,assertCompletedBuild};
