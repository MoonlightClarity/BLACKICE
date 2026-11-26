import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWorkspaceToolHandler} from '../lib/workspace-tools.mjs';
import {readWorkspaceCommandOutcome} from '../lib/workspace-command-outcome.mjs';
import {toolResultEvent} from '../lib/tool-outcomes.mjs';

test('run_js passes literal JavaScript directly to Node without PowerShell quote interpretation',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-runjs-fixture-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const handler=createWorkspaceToolHandler({cwd});
 const script=`const sample={employer:"O'Brien's Lab",note:'Mixed "quotes", dollars $PATH, braces { }, and Unicode ☃'}; console.log(JSON.stringify(sample));`;
 const call={name:'relay_workspace',callId:'direct-js-1',arguments:{action:'run_js',script}};
 const result=await handler(call);
 assert.equal(result.success,true,JSON.stringify(result));
 const body=JSON.parse(result.contentItems[0].text);
 assert.equal(body.exitCode,0);assert.equal(body.shell,'none');assert.equal(body.directScript,true);
 assert.equal(body.language,'javascript');assert.equal(body.stderr,'');
 assert.deepEqual(JSON.parse(body.stdout),{employer:"O'Brien's Lab",note:'Mixed "quotes", dollars $PATH, braces { }, and Unicode ☃'});
 assert.equal(body.command,undefined);assert.equal(body.script,undefined);
 const native=readWorkspaceCommandOutcome(call,result);
 assert.equal(native?.status,'exited');assert.equal(native.exitCode,0);
 const wrong={...call,arguments:{action:'run_js',script:'console.log("different");'}};
 assert.equal(readWorkspaceCommandOutcome(wrong,result),null);
});
test('run_js syntax failures are native process exits with exact failure codes, not adapter outages',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-runjs-fixture-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const handler=createWorkspaceToolHandler({cwd});
 const call={name:'relay_workspace',callId:'direct-js-2',arguments:{action:'run_js',script:'const bad = ;'}};
 const result=await handler(call);
 assert.equal(result.success,false);assert.equal(result.code,'WORKSPACE_COMMAND_EXIT_NONZERO');
 const body=JSON.parse(result.contentItems[0].text);
 assert.equal(body.exitCode,1);assert.equal(body.shell,'none');assert.match(body.stderr,/SyntaxError/);
 assert.equal(readWorkspaceCommandOutcome(call,result)?.effectOutcome,'not-assessed');
 const event=toolResultEvent(call,result);
 assert.equal(event.code,'WORKSPACE_COMMAND_EXIT_NONZERO');
 assert.equal(event.commandExecution.exitCode,1);
});
test('run_js rejects ambiguous script/command combinations without launching',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-runjs-fixture-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const handler=createWorkspaceToolHandler({cwd});
 for(const args of [
   {action:'run_js',script:'console.log(1)',command:'echo 2'},
   {action:'run_js',script:' '},
   {action:'run',command:'echo 1',script:'console.log(2)'},
   {action:'run_js',script:'a'.repeat(12001)}
 ]){
   const result=await handler({name:'relay_workspace',arguments:args});
   assert.equal(result.success,false);
   const body=JSON.parse(result.contentItems[0].text);
   assert.match(body.error,/script|JavaScript|command/i);
   assert.equal(body.actionDispatched,false);
 }
});
