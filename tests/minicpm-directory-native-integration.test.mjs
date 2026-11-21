import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ProviderRuntime} from '../lib/providers.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
import {projectTurnMachineTrace} from '../lib/turn-machine-trace.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const payload=result=>JSON.parse(result.contentItems.find(item=>item.type==='inputText').text);
const receipt=result=>result.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
const correctSource="function directorySmoke(value) { return 'ok:' + value; }\nmodule.exports = { directorySmoke };\n";
const wrongSource="function directorySmoke(value) { return 'wrong:' + value; }\nmodule.exports = { directorySmoke };\n";
const publicRunner=`const fs=require('node:fs');const path=require('node:path');
const cases=JSON.parse(fs.readFileSync(path.join(__dirname,'public-cases.json'),'utf8'));
let fn;try{fn=require('./src/index.cjs').directorySmoke;if(typeof fn!=='function')throw Error('Missing directorySmoke export');}
catch(error){console.log(JSON.stringify({pass:false,caseCount:cases.length,executed:0,passed:0,error:error.message}));process.exit(2);}
const results=cases.map(row=>{try{const actual=fn(row.input);return {input:row.input,expected:row.expected,actual,pass:actual===row.expected};}catch(error){return {input:row.input,pass:false,error:error.message};}});
const passed=results.filter(row=>row.pass).length;
console.log(JSON.stringify({pass:passed===cases.length,caseCount:cases.length,executed:results.length,passed,results}));
process.exitCode=passed===cases.length?0:1;
`;
class NoExternalModel extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('A real external model is forbidden in this deterministic fixture.');}
}

test('real native Directory and compatible adapter execute saved failure, repair, pass and receipt-backed observation', {timeout:30000}, async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'minicpm-native-'));
  const workspace=path.join(root,'workspace');
  await mkdir(path.join(workspace,'src'),{recursive:true});
  const scaffold={
    'METHOD.md':'Read TASK.md and src/index.cjs. Use relay_directory_action plan/focus, save src, run node test-public.cjs and observe only the successful check.\n',
    'TASK.md':'Export directorySmoke(value) from src/index.cjs. Return ok: followed by the string value. Fixed public command: node test-public.cjs.\n',
    'public-cases.json':JSON.stringify([{input:'disk',expected:'ok:disk'},{input:'',expected:'ok:'}])+'\n',
    'test-public.cjs':publicRunner
  };
  for(const [name,text]of Object.entries(scaffold))await writeFile(path.join(workspace,name),text);
  await writeFile(path.join(workspace,'src/index.cjs'),"module.exports={directorySmoke(){throw Error('not implemented');}};\n");
  const scaffoldHashes=Object.fromEntries(Object.entries(scaffold).map(([name,text])=>[name,sha(text)]));
  const executed=new Map(),delivered=new Map(),requests=[];let engine,runtime,stage=0,protocolError=null,opening;
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw);requests.push(body);
      const send=message=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message}]}));};
      const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
      const workspaceCall=(id,args)=>tool(id,'relay_workspace',args);
      const directoryCall=(id,args)=>tool(id,'relay_directory_action',args);
      let call;
      switch(stage++){
        case 0:call=workspaceCall('read-method',{action:'read',path:'METHOD.md'});break;
        case 1:call=workspaceCall('read-task',{action:'read',path:'TASK.md'});break;
        case 2:call=workspaceCall('read-initial-source',{action:'read',path:'src/index.cjs'});break;
        case 3:call=workspaceCall('read-public-cases',{action:'read',path:'public-cases.json'});break;
        case 4:call=workspaceCall('wrong-plan',{action:'plan',path:'implement'});break;
        case 5:call=workspaceCall('wrong-focus',{action:'focus',path:'implement'});break;
        case 6:call=workspaceCall('unfocused-write',{action:'write',path:'must-not-exist.txt',text:'not admitted'});break;
        case 7:call=directoryCall('plan',{action:'plan',actions:[{id:'implement',objective:'Save directorySmoke and pass both fixed public cases.',dependsOn:[]}]});break;
        case 8:call=directoryCall('focus',{action:'focus',id:'implement'});break;
        case 9:call=workspaceCall('write-wrong',{action:'write',path:'src/index.cjs',text:wrongSource});break;
        case 10:call=workspaceCall('read-wrong',{action:'read',path:'src/index.cjs'});break;
        case 11:call=workspaceCall('run-failed',{action:'run',command:'node test-public.cjs',timeoutMs:10000});break;
        case 12:call=directoryCall('after-failed-check',{action:'read'});break;
        case 13:call=workspaceCall('write-repaired',{action:'write',path:'src/index.cjs',text:correctSource});break;
        case 14:call=workspaceCall('read-repaired',{action:'read',path:'src/index.cjs'});break;
        case 15:call=workspaceCall('run-passed',{action:'run',command:'node test-public.cjs',timeoutMs:10000});break;
        case 16:call=directoryCall('observe',{action:'observe',outcome:'objective-met',id:'implement',claim:'Saved source was read back; both fixed public cases passed with exit 0.',receipts:[receipt(executed.get('read-repaired').result),receipt(executed.get('run-passed').result)]});break;
        case 17:send({role:'assistant',content:'Saved directorySmoke; both fixed public cases passed.'});return;
        default:throw Error('Unexpected extra provider request at stage '+stage);
      }
      send({role:'assistant',content:null,tool_calls:[call]});
    }catch(error){
      protocolError ||= error;
      res.statusCode=500;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{message:error.message}}));
    }
  });
  t.after(async()=>{await engine?.close();await runtime?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  runtime=new ProviderRuntime({codex:new NoExternalModel(),dataDir:path.join(root,'provider'),modelLimitResolver:{enrich:async(_config,models)=>models}});
  await runtime.store.init();
  await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',maxSteps:null,models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},{preserveDefault:true});
  const executeTool=runtime.executeTool.bind(runtime);
  runtime.executeTool=async(state,call)=>{
    assert(!executed.has(call.id),'No duplicate dispatch in this sequential fixture.');
    const result=await executeTool(state,call);
    executed.set(call.id,{call:structuredClone(call),result:structuredClone(result)});
    return result;
  };
  const runAgent=runtime.runAgent.bind(runtime);
  runtime.runAgent=options=>{
    assert.equal(opening,undefined,'Exactly one synthetic agent opening is expected.');
    opening={prompt:options.prompt,developerInstructions:options.developerInstructions,tools:structuredClone(options.dynamicTools)};
    return runAgent({...options,onToolResultDelivered:event=>{
      // Acceptance can acknowledge the same historical wire result more than once.
      delivered.set(event.call.callId,{call:structuredClone(event.call),result:structuredClone(event.result)});
      return options.onToolResultDelivered?.(event);
    }});
  };
  engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:workspace}).init();
  const graph={name:'Native coding infrastructure',nodes:[
    {id:'i',type:'input'}, {id:'a',type:'agent',name:'Fixture',model:'fixture::fixture',prompt:'Execute the coding fixture.'}, {id:'o',type:'output'}
  ],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
  const started=engine.startRun({workflow:graph,input:{task:'Read METHOD.md and TASK.md, save code under src and verify with node test-public.cjs.',cwd:workspace,directoryActions:'on',chatPlanning:'off',pastChats:'off',directoryDiagnostics:'maximal'}});
  await engine.executions.get(started.id);
  assert.equal(protocolError,null,protocolError?.stack);
  const run=engine.getRun(started.id);
  assert.equal(run.status,'completed',run.error);assert.equal(run.settled,true);
  assert.equal(stage,18);assert.equal(executed.size,17);assert.equal(delivered.size,17);
  const wireTools=requests[0].tools.map(tool=>tool.function.name);
  assert(wireTools.includes('relay_workspace'));assert(wireTools.includes('relay_directory_action'));
  for(const id of ['wrong-plan','wrong-focus']){
    const result=executed.get(id).result;
    assert.equal(result.code,'TOOL_ACTION_INVALID');assert.equal(result.actionDispatched,false);
    assert.match(payload(result).message,/relay_directory_action/);
    assert.match(JSON.stringify(delivered.get(id).result.contentItems),/actionDispatched/,'The diagnostic also reaches the serialized model request.');
  }
  assert.equal(executed.get('unfocused-write').result.code,'DIRECTORY_FOCUS');
  assert.equal(executed.get('unfocused-write').result.actionDispatched,false,'Generic no-dispatch evidence survives the actual compatible adapter.');
  await assert.rejects(access(path.join(workspace,'must-not-exist.txt')),{code:'ENOENT'});
  const failed=payload(executed.get('run-failed').result),passed=payload(executed.get('run-passed').result);
  const failedCheck=JSON.parse(failed.stdout.trim()),passedCheck=JSON.parse(passed.stdout.trim());
  assert.equal(executed.get('run-failed').result.success,false);assert.equal(failed.exitCode,1);
  assert.equal(failedCheck.pass,false);assert.equal(failedCheck.caseCount,2);assert.equal(failedCheck.executed,2);assert.equal(failedCheck.passed,0);
  const afterFailure=payload(executed.get('after-failed-check').result);
  assert.equal(afterFailure.focus,'implement');assert.equal(afterFailure.actions[0].state,'active');
  assert.equal(afterFailure.actions[0].observation,undefined,'Failed check never becomes objective-met.');
  assert.equal(executed.get('run-passed').result.success,true);assert.equal(passed.exitCode,0);
  assert.equal(passedCheck.pass,true);assert.equal(passedCheck.caseCount,2);assert.equal(passedCheck.executed,2);assert.equal(passedCheck.passed,2);
  for(const command of [failed,passed]){assert.equal(command.command,'node test-public.cjs');assert.equal(command.cwd,workspace);assert.equal(command.timedOut,false);assert.equal(command.truncated,false);}
  const bytes=await readFile(path.join(workspace,'src/index.cjs'));
  assert.equal(bytes.toString(),correctSource);assert.equal(sha(bytes),sha(correctSource));
  assert.equal(payload(executed.get('read-repaired').result).sha256,sha(bytes));
  for(const [name,expected]of Object.entries(scaffoldHashes))assert.equal(sha(await readFile(path.join(workspace,name))),expected,'Immutable fixture '+name);
  const directory=await engine.actionDirectories.get(started.id,'Fixture'),state=directory.read();
  assert.equal(state.focus,null);assert.equal(state.actions[0].state,'observed');
  assert.deepEqual(state.actions[0].observation.receipts,[receipt(executed.get('read-repaired').result),receipt(executed.get('run-passed').result)]);
  assert.equal(state.receipts.length,10);assert(state.receipts.every(row=>row.state==='returned'));
  assert.equal(state.receipts.filter(row=>row.success===false).length,1,'Exactly the real failed command is a failed dispatched receipt.');
  assert.equal(directory.finalStatus().ready,true);
  const trace=projectTurnMachineTrace(engine.runs.get(started.id));
  const dispatches=trace.entries.filter(entry=>entry.kind==='directory.effect'&&entry.metadata.phase==='dispatch');
  assert.equal(dispatches.length,10);
  assert(trace.entries.some(entry=>entry.kind==='directory.effect'&&entry.metadata.phase==='gate'&&entry.metadata.code==='DIRECTORY_FOCUS'&&entry.metadata.decision==='reject'));
  console.log('MINICPM_NATIVE_INTEGRATION '+JSON.stringify({
    runId:started.id,status:run.status,settled:run.settled,scriptedResponses:stage,deliveredTools:delivered.size,
    publicChecks:[{exitCode:failed.exitCode,...failedCheck},{exitCode:passed.exitCode,...passedCheck}],
    implementationSha256:sha(bytes),scaffoldHashes,
    observationReceipts:state.actions[0].observation.receipts,returnedReceipts:state.receipts.length,unknownReceipts:state.receipts.filter(row=>row.state==='unknown').length,
    input:{promptCharacters:opening.prompt.length,promptSha256:sha(opening.prompt),developerCharacters:opening.developerInstructions.length,developerSha256:sha(opening.developerInstructions),toolNames:opening.tools.map(tool=>tool.name),toolsSha256:sha(JSON.stringify(opening.tools))}
  }));
});
