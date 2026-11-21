import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, writeFile, readFile, access, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
import {WORKSPACE_TOOL} from '../lib/workspace-tools.mjs';
import {ACTION_DIRECTORY_TOOL} from '../lib/task-action-directory.mjs';
import {toolActionDenial} from '../lib/tool-action-validation.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = result => JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
const receipt = result => result.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
const graph = {name:'Directory contract',nodes:[
  {id:'i',type:'input'}, {id:'a',type:'agent',name:'Fixture',model:'fixture-model',prompt:'Perform the fixture'},
  {id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],
  settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter {
  status(){return {connected:true,authenticated:true,models:[{id:'fixture-model',supportsTools:true}]};}
  async runAgent(options){return this.execute(options);}
}
async function setup(t, execute) {
  const root = await mkdtemp(path.join(tmpdir(),'minicpm-contract-'));
  const workspace = path.join(root,'workspace');
  await mkdir(workspace);
  const runtime = new Runtime(); runtime.execute = execute;
  const engine = await new HarnessEngine({runtime,dataDir:path.join(root,'data'),defaultCwd:workspace}).init();
  t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
  return {root,workspace,engine};
}

test('attached action diagnostic distinguishes wrong tool, malformed input and supported actions',()=>{
  const tools=[WORKSPACE_TOOL,ACTION_DIRECTORY_TOOL];
  for(const action of ['plan','focus']) {
    const denied=toolActionDenial({name:'relay_workspace',arguments:{action}},tools);
    assert.equal(denied.code,'TOOL_ACTION_INVALID');
    assert.equal(denied.success,false);assert.equal(denied.actionDispatched,false);
    assert.match(json(denied).message,/relay_directory_action/);
    assert.deepEqual(json(denied).allowedActions,WORKSPACE_TOOL.inputSchema.properties.action.enum);
  }
  for(const args of ['{',null,[]]) {
    assert.equal(toolActionDenial({name:'relay_workspace',arguments:args},tools).code,'TOOL_ARGUMENTS_INVALID');
  }
  for(const action of ['read','write','run']) assert.equal(toolActionDenial({name:'relay_workspace',arguments:{action}},tools),null);
  assert.equal(toolActionDenial({name:'relay_workspace',namespace:'external',arguments:{action:'focus'}},tools),null);
  assert.equal(toolActionDenial({name:'unattached',arguments:{}},tools),null,'Provider owns unattached-tool admission.');
  assert.doesNotMatch(json(toolActionDenial({name:'relay_workspace',arguments:{action:'focus'}},[WORKSPACE_TOOL])).message,/relay_directory_action/,'Never suggest an unattached tool.');
});

test('native Directory validates wrong workspace actions before focus and accepts repaired tool use', {timeout:20000}, async t=>{
  let runId;
  const {engine,workspace}=await setup(t,async options=>{
    const call=(name,args,id)=>options.onToolCall({name,arguments:args,callId:id});
    const dir=(action,rest={},id='dir-'+action)=>call('relay_directory_action',{action,...rest},id);
    assert(options.dynamicTools.some(tool=>tool.name==='relay_workspace'));
    assert(options.dynamicTools.some(tool=>tool.name==='relay_directory_action'));
    assert.equal(options.hostOnlyTools,true);
    const read=await call('relay_workspace',{action:'read',path:'METHOD.md'},'read-method');
    assert.equal(read.success,true);
    const ledger=await engine.actionDirectories.get(runId,'Contract');
    const before=ledger.read();
    for(const action of ['plan','focus']){
      const denied=await call('relay_workspace',{action,path:'implement'},'wrong-'+action);
      assert.equal(denied.code,'TOOL_ACTION_INVALID',JSON.stringify(denied));
      assert.equal(denied.actionDispatched,false);
      assert.match(json(denied).message,/relay_directory_action/);
      assert.deepEqual(ledger.read(),before,'Invalid action cannot reserve a Directory receipt.');
    }
    const blocked=await call('relay_workspace',{action:'write',path:'result.txt',text:'blocked'},'unfocused-write');
    assert.equal(blocked.code,'DIRECTORY_FOCUS',JSON.stringify(blocked));
    assert.equal(blocked.actionDispatched,false);
    assert.match(blocked.contentItems[0].text,/relay_directory_action.*focus/);
    assert.deepEqual(ledger.read(),before);
    await assert.rejects(access(path.join(workspace,'result.txt')),{code:'ENOENT'});
    assert.equal((await dir('plan',{actions:[{id:'save',objective:'Save and read back the fixture',dependsOn:[]}]})).success,true);
    assert.equal((await dir('focus',{id:'save'})).success,true);
    const saved=await call('relay_workspace',{action:'write',path:'result.txt',text:'contract-ok\n'},'focused-write');
    assert.equal(saved.success,true);
    const checked=await call('relay_workspace',{action:'read',path:'result.txt'},'read-result');
    assert.equal(checked.success,true);
    const bytes=await readFile(path.join(workspace,'result.txt'));
    assert.equal(bytes.toString(),'contract-ok\n');assert.equal(json(checked).sha256,sha(bytes));
    assert.equal((await dir('observe',{outcome:'objective-met',id:'save',claim:'The saved bytes were read back.',receipts:[receipt(saved),receipt(checked)]})).success,true);
    assert.equal((await options.onBeforeFinal({output:'Saved and checked the fixture.',signal:options.signal}))==null,true);
    return {output:'Saved and checked the fixture.'};
  });
  await writeFile(path.join(workspace,'METHOD.md'),'Use the current attached schemas.\n');
  const started=engine.startRun({workflow:graph,input:{task:'Save and verify the fixture',cwd:workspace,directoryActions:'on',chatPlanning:'off',pastChats:'off',directoryDiagnostics:'maximal'}});
  runId=started.id;
  await engine.executions.get(started.id);
  const run=engine.getRun(started.id);
  assert.equal(run.status,'completed',run.error);assert.equal(run.settled,true);
  const state=(await engine.actionDirectories.get(started.id,'Contract')).read();
  assert.equal(state.actions[0].state,'observed');assert.equal(state.focus,null);
  assert.equal(state.receipts.length,3);assert(state.receipts.every(row=>row.state==='returned'&&row.success===true));
});

test('ordinary Chat still writes without a Directory plan or focus', {timeout:20000}, async t=>{
  const {engine,workspace}=await setup(t,async options=>{
    assert(!options.dynamicTools.some(tool=>tool.name==='relay_directory_action'));
    const result=await options.onToolCall({name:'relay_workspace',arguments:{action:'write',path:'ordinary.txt',text:'ordinary-ok'},callId:'ordinary-write'});
    assert.equal(result.success,true,JSON.stringify(result));
    return {output:'Saved ordinary fixture.'};
  });
  const started=engine.startRun({workflow:graph,input:{task:'Save the ordinary fixture',cwd:workspace,directoryActions:'off',chatPlanning:'off',pastChats:'off'}});
  await engine.executions.get(started.id);
  assert.equal(engine.getRun(started.id).status,'completed',engine.getRun(started.id).error);
  assert.equal(await readFile(path.join(workspace,'ordinary.txt'),'utf8'),'ordinary-ok');
});
