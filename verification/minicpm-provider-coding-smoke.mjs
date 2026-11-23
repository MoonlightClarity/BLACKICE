// One bounded, disposable coding task through the REAL local compatible provider.
// No desktop restart, other model, user data, or production source edits.
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {ProviderRuntime} from '../lib/providers.mjs';
const exec=promisify(execFile);
class Native extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('Unexpected native fallback');}
}
const dir=await mkdtemp(path.join(os.tmpdir(),'blackice-minicpm-code-probe-'));
const work=path.join(dir,'task'),src=path.join(work,'src','index.cjs'),testFile=path.join(work,'test.cjs');
const model='MiniCPM-V-4.7-1B-heretic-Q4_K_S';
const toolCalls=[],events=[];
let runtime,providerResult,providerError;
const testCode=`const test=require('node:test'),assert=require('node:assert/strict'),clamp=require('./src/index.cjs');
test('below',()=>assert.equal(clamp(-2,0,5),0));
test('above',()=>assert.equal(clamp(12,0,5),5));
test('inside',()=>assert.equal(clamp(3,0,5),3));
test('boundary',()=>assert.equal(clamp(0,0,5),0));
test('inverted range',()=>assert.throws(()=>clamp(1,4,2),RangeError));`;
async function testSource(){
  try{const result=await exec(process.execPath,['--test','test.cjs'],{cwd:work,timeout:12000});
    return {exitCode:0,summary:result.stdout.slice(-500)};
  }catch(error){const output=String(error.stdout||error.stderr||error.message);const problems=output.split(/\r?\n/).filter(line=>/SyntaxError|Unexpected token|ReferenceError|AssertionError|Error:|not ok/.test(line)).slice(0,8);return {exitCode:error.code||1,diagnostic:problems.join(' | ').slice(0,900),outputHead:output.slice(0,1400)};}
}
try{
  await mkdir(path.dirname(src),{recursive:true});
  await writeFile(src,'module.exports=function clamp(value,min,max){return value;};\n');
  await writeFile(testFile,testCode);
  const before=await testSource();
  runtime=await new ProviderRuntime({codex:new Native(),dataDir:path.join(dir,'profile'),fetchImpl:fetch,
    modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
  await runtime.saveProvider({id:'local_llamacpp',preset:'llamacpp',type:'compatible',baseUrl:'http://127.0.0.1:8080/v1',
    models:[{id:model,contextWindowTokens:262144,maxOutputTokens:2048}],maxSteps:10},{preserveDefault:true});
  const dynamicTools=[
    {name:'save_source',description:'Replace the source of src/index.cjs. This is a CommonJS .cjs file: use module.exports = clamp; NEVER use ESM export default.',inputSchema:{
      type:'object',additionalProperties:false,required:['code'],properties:{code:{type:'string',description:'Complete CommonJS src/index.cjs contents.'}}}},
    {name:'run_tests',description:'Run the five tests on the currently saved source file.',inputSchema:{
      type:'object',additionalProperties:false,required:[],properties:{}}}
  ];
  const onToolCall=async call=>{
    let args;try{args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments||{};}catch{args={};}
    const name=call.name;toolCalls.push({name,hasArguments:args&&typeof args==='object',codeLength:typeof args.code==='string'?args.code.length:0});
    if(name==='save_source'){
      if(typeof args.code!=='string'||args.code.length>4000)return {success:false,code:'INVALID_SOURCE',contentItems:[{type:'inputText',text:'Supply a complete CommonJS source string.'}]};
      await writeFile(src,args.code);return {success:true,contentItems:[{type:'inputText',text:'Saved src/index.cjs.'}]};
    }
    if(name==='run_tests'){const result=await testSource();return {success:result.exitCode===0,contentItems:[{type:'inputText',text:JSON.stringify(result)}]};}
    return {success:false,code:'UNKNOWN_TOOL',contentItems:[{type:'inputText',text:'Tool unavailable.'}]};
  };
  try{
    providerResult=await runtime.runAgent({cwd:work,model:'local_llamacpp::'+model,hostOnlyTools:true,
      prompt:'Implement clamp(value,min,max) in src/index.cjs. This file is CommonJS: export with module.exports = clamp; do NOT write export default. Return bounded value below/above bounds; throw RangeError if min>max. First call save_source with complete code; then call run_tests. If tests fail, inspect the diagnostic error, call save_source with a corrected source, and call run_tests again. Never claim success when the test exitCode is nonzero.',
      dynamicTools,onToolCall,onEvent:event=>{if(['capabilities','thread','item'].includes(event.type))events.push({type:event.type,...(event.type==='thread'?{threadId:event.threadId,model:event.model}:{})});}});
  }catch(error){providerError={code:error.code||null,message:error.message};}
  const after=await testSource(),source=await readFile(src,'utf8');
  console.log(JSON.stringify({model:'local_llamacpp::'+model,baseline:before.exitCode,after:after.exitCode,
    tools:toolCalls,source,providerError,output:providerResult?.output?.slice(0,650),status:after.exitCode===0?'source-passes':'source-fails',
    events:events.slice(0,12)}));
  if(after.exitCode!==0)process.exitCode=5;
}catch(error){console.error(JSON.stringify({error:error.message,code:error.code||null}));process.exitCode=9;}
finally{if(runtime)await runtime.close();await rm(dir,{recursive:true,force:true});}
