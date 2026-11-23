// End-to-end BLACKICE Engine -> local MiniCPM -> real workspace tools -> tests.
// Isolated temporary workspace/profile. No installed-app or repository mutation.
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HarnessEngine} from '../lib/engine.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

const exec=promisify(execFile);
const model='MiniCPM-V-4.7-1B-heretic-Q4_K_S',selectedModel='local_llamacpp::'+model;
const parent=await mkdtemp(path.join(os.tmpdir(),'blackice-minicpm-engine-probe-'));
const cwd=path.join(parent,'work'),source=path.join(cwd,'src','math.cjs');
const testFile=path.join(cwd,'test.cjs');
let engine,runtime,runId,timeout=false,terminalError=null;
const task='Fix the bug in src/math.cjs: exported add(a,b) currently subtracts b; it must return a + b. Read src/math.cjs and test.cjs; edit ONLY src/math.cjs, keeping CommonJS module.exports. Then actually run node --test test.cjs using the workspace command tool. The task is complete only if the saved source passes 3 tests. No other edits or external actions.';
class NoNative extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('No native Codex calls permitted');}
}
async function checkTests(){
  try{const result=await exec(process.execPath,['--test','test.cjs'],{cwd,timeout:15000});
    return {exitCode:0,tail:result.stdout.slice(-600)};
  }catch(error){return {exitCode:typeof error.code==='number'?error.code:1,
    head:String(error.stdout||error.stderr||error.message).slice(0,850)};}
}
try{
  await mkdir(path.dirname(source),{recursive:true});
  await writeFile(source,'module.exports = function add(a,b) { return a - b; };\n');
  await writeFile(testFile,`const test=require('node:test'),assert=require('node:assert/strict'),add=require('./src/math.cjs');
test('positive',()=>assert.equal(add(2,3),5));
test('mixed',()=>assert.equal(add(-5,7),2));
test('zero',()=>assert.equal(add(0,4),4));`);
  const before=await checkTests();
  runtime=await new ProviderRuntime({codex:new NoNative(),dataDir:path.join(parent,'provider'),
    modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
  await runtime.saveProvider({id:'local_llamacpp',preset:'llamacpp',type:'compatible',baseUrl:'http://127.0.0.1:8080/v1',
    models:[{id:model,contextWindowTokens:262144,maxOutputTokens:4096}],maxSteps:9},{preserveDefault:true});
  engine=await new HarnessEngine({runtime,dataDir:path.join(parent,'engine'),defaultCwd:cwd}).init();
  const workflow=createMissionWorkflow({task,model:selectedModel,cwd,id:'chatgpt_mission_'+randomUUID().replaceAll('-',''),planningMode:'off',
    context:{preset:'custom',windowTokens:65536,autoCompact:true,outputReserveTokens:4096,headroomTokens:4096}});
  const started=engine.startRun({workflow,input:{task,cwd,planningMode:'off',directoryMode:'off',directoryActions:'off',chatPlanning:'off',pastChats:'off'}});
  runId=started.id;
  let timer;
  try{
    await Promise.race([engine.executions.get(runId),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error('Local smoke exceeded 85-second bounded task window')),85000);
    })]);
  }catch(error){terminalError=error.message;timeout=/85-second/.test(error.message);
    if(timeout)engine.cancelRun(runId);
  }finally{clearTimeout(timer);}
  const run=engine.getRun(runId),after=await checkTests(),saved=await readFile(source,'utf8');
  const a=run?.nodes?.agent;
  const receipt={model:selectedModel,runId,status:run?.status,errorCode:run?.errorCode||a?.errorCode||null,
    terminalError,output:(a?.output||run?.output||'').slice(0,950),
    toolSummary:a?.toolSummary||null,
    outcomeAssessment:a?.outcomeAssessment||null,
    before:before.exitCode,after:after.exitCode,source:saved,
    success:after.exitCode===0};
  console.log('BLACKICE_MINICPM_ENGINE_PROBE '+JSON.stringify(receipt));
  if(!receipt.success)process.exitCode=5;
}catch(error){console.error('BLACKICE_MINICPM_ENGINE_PROBE_ERROR '+JSON.stringify({error:error.message,code:error.code||null}));
  process.exitCode=9;
}finally{
  if(engine)await engine.close().catch(()=>{});
  if(runtime)await runtime.close().catch(()=>{});
  await rm(parent,{recursive:true,force:true}).catch(()=>{});
}
