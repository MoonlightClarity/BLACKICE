import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {assessCodexRuntime, resolveCodexCommand} from './lib/codex-discovery.mjs';
import {CodexRuntime} from './lib/codex.mjs';
import {WORKSPACE_TOOL, createWorkspaceToolHandler} from './lib/workspace-tools.mjs';
import {PlanningBrowserStore} from './lib/planning-browser.mjs';
import {createNativePlanningTools} from './lib/native-planning-tools.mjs';

test('registered Store location changes, with no fixed version', () => {
  const env={SystemRoot:'C:\\Windows',LOCALAPPDATA:'C:\\Local',PATH:''};
  const find=location=>resolveCodexCommand({platform:'win32',arch:'x64',env,exists:p=>p.endsWith('resources\\codex.exe'),execFile:()=>location});
  assert.match(find('C:\\Apps\\version1'), /version1/);
  assert.match(find('C:\\Apps\\version2'), /version2/);
});
test('Planning read schema discovers actionable write and dispatch respects write access', async () => {
  const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-plan-audit-'));
  try {
    const store=new PlanningBrowserStore({dataDir});
    const provider=createNativePlanningTools({store});
    const input={taskId:'audit-task',runId:'audit-run',nodeId:'agent'};
    const readonly=await provider({...input,canWrite:false});
    assert.ok(readonly.tools.some(t=>t.name==='relay_planning_read'));
    assert.ok(!readonly.tools.some(t=>t.name==='relay_planning_write'));
    const enabled=await provider({...input,canWrite:true});
    const write=enabled.tools.find(t=>t.name==='relay_planning_write');
    assert.ok(write.inputSchema.properties.action.enum.includes('create_request'));
    const schema=await enabled.handle({name:'relay_planning_read',arguments:{requestId:'read-1',action:'schema',writeAction:'create_request'}});
    const body=JSON.stringify(schema);
    assert.match(body,/objective/); assert.match(body,/title/);
    const result=await enabled.handle({name:'relay_planning_write',arguments:{requestId:'write-1',action:'create_request',title:'Audit',objective:'Test action discovery'}});
    assert.match(JSON.stringify(result),/create_request/);
    const saved=await store.list({conversationId:'audit-task'});
    assert.ok(saved.requests.some(row=>row.title==='Audit'));
    await assert.rejects(readonly.handle({name:'relay_planning_write',arguments:{requestId:'x',action:'create_request',title:'x',objective:'x'}}));
  } finally {await rm(dataDir,{recursive:true,force:true});}
});
test('missing and moved executables are distinguished', () => {
  const opts={current:'C:\\old\\codex.exe',platform:'win32',exists:p=>p==='C:\\new\\codex.exe'};
  assert.equal(assessCodexRuntime({...opts,discovered:'C:\\new\\codex.exe'}).state,'moved');
  assert.equal(assessCodexRuntime({...opts,discovered:'codex'}).state,'missing');
  assert.equal(assessCodexRuntime({...opts,discovered:'C:\\new\\codex.exe',exists:()=>true}).state,'moved');
  assert.equal(assessCodexRuntime({...opts,discovered:'codex',exists:()=>true}).state,'current');
});
test('replacement is connected only when idle; active work is preserved', async () => {
  const rt=new CodexRuntime({command:'old',nativeModelMetadata:false,resolveCommand:()=> 'new',assessRuntime:()=>({state:'moved',command:'new'})});
  rt.command='old'; rt.info.connected=true;
  rt.threads.set('active',{});
  await assert.rejects(rt.start(),{code:'CODEX_RUNTIME_CHANGED_BUSY'});
  assert.equal(rt.threads.size,1);
  rt.threads.clear();
  const child=new EventEmitter(); child.exitCode=null; child.signalCode=null;
  child.stdin={end(){child.exitCode=0; child.emit('exit',0);}}; child.kill=()=>{};
  rt.child=child;
  rt._startWithRecovery=async()=>{rt.info.connected=true;return {command:rt.command};};
  assert.equal((await rt.start()).command,'new');
});
test('no replacement yields a clear error before new work', async () => {
  const rt=new CodexRuntime({nativeModelMetadata:false,resolveCommand:()=> 'codex',assessRuntime:()=>({state:'missing'})});
  await assert.rejects(rt.start(),{code:'CODEX_RUNTIME_MISSING'});
});
test('workspace exposes and dispatches both read and write actions', async () => {
  const cwd=await mkdtemp(path.join(tmpdir(),'blackice-tool-audit-'));
  try {
    const schema=WORKSPACE_TOOL.inputSchema;
    for(const action of ['read','write']) assert.ok(schema.properties.action.enum.includes(action));
    for(const field of ['path','text']) assert.ok(schema.properties[field]);
    const handle=createWorkspaceToolHandler({cwd});
    const written=await handle({name:'relay_workspace',arguments:{action:'write',path:'probe.txt',text:'audit-314'}});
    assert.equal(written.success,true);
    assert.equal(await readFile(path.join(cwd,'probe.txt'),'utf8'),'audit-314');
    const read=await handle({name:'relay_workspace',arguments:{action:'read',path:'probe.txt'}});
    assert.equal(read.success,true);
    assert.match(read.contentItems[0].text,/audit-314/);
    const bad=await handle({name:'relay_workspace',arguments:{action:'write',path:'bad.txt'}});
    assert.equal(bad.success,false);
  } finally {await rm(cwd,{recursive:true,force:true});}
});
