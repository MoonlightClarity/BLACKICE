import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
const count=(text,value)=>text.split(value).length-1;
const userBlock=prompt=>prompt.split(/(?:^|\n)USER TASK\n/)[1].split(/\n\n(?:HOST TURN AUTHORITY|UPSTREAM RESULTS \(context from previous agents\))\n/)[0];
const upstreamBlock=prompt=>prompt.split('\nUPSTREAM RESULTS (context from previous agents)\n')[1].split('\n\nUse the configured working folder')[0];
const input={id:'i',type:'input',name:'User input'};
const output={id:'o',type:'output'};
const agent=(id,name)=>({id,type:'agent',name,model:'fixture-model',prompt:'Inspect the assigned fixture.'});
const graph=(nodes,edges)=>({name:'Composition fixture',nodes,edges:edges.map(([source,target])=>({source,target})),settings:{maxParallel:1,planningMode:'off'}});
class Runtime extends EventEmitter {
  status(){return {connected:true,authenticated:true,models:[{id:'fixture-model',supportsTools:true}]};}
  async runAgent(options){return this.execute(options);}
}
async function setup(t,execute){
  const root=await mkdtemp(path.join(tmpdir(),'minicpm-composition-'));
  const runtime=new Runtime();runtime.execute=execute;
  const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'data'),defaultCwd:root}).init();
  t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
  return {root,engine};
}

test('native composed Directory input keeps canonical user task and state but omits duplicate direct input context', {timeout:20000}, async t=>{
  const task='CURRENT_TASK_MARKER_c5e31: inspect the fixture file.';
  let captured;
  const {root,engine}=await setup(t,async options=>{
    captured=options.prompt;
    const call=(name,args,id)=>options.onToolCall({name,arguments:args,callId:id});
    for(const [action,rest]of [['plan',{actions:[{id:'inspect',objective:'Read the fixture file.',dependsOn:[]}]}],['focus',{id:'inspect'}]])
      assert.equal((await call('relay_directory_action',{action,...rest},action)).success,true);
    const read=await call('relay_workspace',{action:'read',path:'fixture.txt'},'read');
    assert.equal(read.success,true);
    const receipt=read.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
    assert.equal((await call('relay_directory_action',{action:'observe',outcome:'objective-met',id:'inspect',claim:'The fixture was read.',receipts:[receipt]},'observe')).success,true);
    assert.equal((await options.onBeforeFinal({output:'Fixture inspected.',signal:options.signal}))==null,true);
    return {output:'Fixture inspected.'};
  });
  await writeFile(path.join(root,'fixture.txt'),'Fixture evidence.\n');
  const started=engine.startRun({workflow:graph([input,agent('a','Capture'),output],[['i','a'],['a','o']]),input:{task,directoryActions:'on',chatPlanning:'off',pastChats:'off'}});
  await engine.executions.get(started.id);
  const run=engine.getRun(started.id);assert.equal(run.status,'completed',run.error);assert.equal(run.settled,true);
  assert.equal(userBlock(captured),task);assert.equal(upstreamBlock(captured),'');
  const heading='CURRENT TASK ACTION DIRECTORY (host-owned; claims are agent-authored)\n';
  const directory=JSON.parse(captured.split(heading)[1].split('\n')[0]);
  assert.equal(directory.objective,task,'Directory binding remains explicit.');
  assert.equal(count(captured,task),2,'One task instruction plus one explicit Directory objective.');
  console.log('MINICPM_INSTRUCTION_COMPOSITION '+JSON.stringify({promptCharacters:captured.length,promptSha256:sha(captured),canonicalUserTaskCopies:1,upstreamTaskCopies:0,directoryObjectiveCopies:1,totalLiteralTaskCopies:count(captured,task)}));
});

for(const identical of [false,true])test('native composition preserves non-input upstream '+(identical?'output identical to the task':'evidence and label'), {timeout:20000}, async t=>{
  const task='CURRENT_TASK_MARKER_98bb2: inspect the upstream result.';
  const evidence=identical?task:'VERIFIED_UPSTREAM_MARKER_6fbe0';
  const prompts=[];
  const {engine}=await setup(t,async options=>{
    prompts.push(options.prompt);
    return {output:prompts.length===1?evidence:'Consumer inspected upstream result.'};
  });
  const workflow=graph([input,agent('producer','Producer'),agent('consumer','Consumer'),output],[['i','producer'],['i','consumer'],['producer','consumer'],['consumer','o']]);
  const started=engine.startRun({workflow,input:{task,directoryActions:'off',chatPlanning:'off',pastChats:'off'}});
  await engine.executions.get(started.id);
  const run=engine.getRun(started.id);assert.equal(run.status,'completed',run.error);assert.equal(run.settled,true);
  assert.equal(prompts.length,2);
  assert.equal(userBlock(prompts[0]),task);assert.equal(upstreamBlock(prompts[0]),'');
  assert.equal(userBlock(prompts[1]),task);
  assert.equal(upstreamBlock(prompts[1]),'[Producer]\n'+evidence,'Input duplicate removed without changing result label/order/content.');
});
