import test from 'node:test';
import assert from 'node:assert/strict';
import {TOOL_FAILURE_LIMITS,repeatedToolFailure,hostToolStopCode} from '../lib/tool-failure-loop.mjs';

const result=(code='INVALID_TASK_VIEW',extra={})=>({success:false,code,contentItems:[{type:'inputText',text:'Host tool rejected invalid cursor'}],...extra});
const call=(name='relay_task',action='read',extra={})=>({name,arguments:{action,offset:10,...extra}});
test('one provider response with many independent read failures is one recovery opportunity',()=>{
 const state={};
 for(let i=0;i<15;i++)assert.equal(repeatedToolFailure(state,call('relay_workspace','read',{path:'secret-'+i}),result(),{progressEpoch:0}),null);
 assert.equal(state.dynamicToolFailure.count,1);assert.equal(state.dynamicToolFailure.total,15);
 for(let epoch=1;epoch<TOOL_FAILURE_LIMITS.repeatedFailure;epoch++){
  const stopped=repeatedToolFailure(state,call('relay_workspace','read'),result(),{progressEpoch:epoch});
  assert.equal(Boolean(stopped),epoch===TOOL_FAILURE_LIMITS.repeatedFailure-1);
  if(stopped){assert.equal(stopped.count,8);assert.equal(stopped.total,22);assert.doesNotMatch(stopped.message,/secret-/);}
 }
});
test('unproven mutations remain subject to strict cap within a single burst',()=>{
 const state={};
 for(let i=1;i<=8;i++){const stopped=repeatedToolFailure(state,call('relay_workspace','run',{command:'private '+i}),result('WORKSPACE_ERROR'),{progressEpoch:0});
  assert.equal(Boolean(stopped),i===8);
  if(stopped)assert.doesNotMatch(stopped.message,/private|command/);
 }
 repeatedToolFailure(state,call(),{success:true,contentItems:[]});assert.equal(state.dynamicToolFailure,null);
});
test('namespace, action, and failure code remain separate recovery categories',()=>{
 const s={};
 repeatedToolFailure(s,{name:'read',namespace:'alpha',arguments:{action:'read'}},result());
 repeatedToolFailure(s,{name:'read',namespace:'beta',arguments:{action:'read'}},result());
 assert.equal(s.dynamicToolFailure.count,1);
 repeatedToolFailure(s,call('relay_task','edit'),result());assert.equal(s.dynamicToolFailure.count,1);
 repeatedToolFailure(s,call('relay_task','edit'),result('REQUIRES_REVISION'));assert.equal(s.dynamicToolFailure.count,1);
});
test('trusted proof distinguishes no-input stale refs from uncertain or dispatched outcomes',()=>{
 for(const flag of [true,undefined]){const state={};
  const bogus={...result('BROWSER_REF_STALE',flag===undefined?{}:{actionDispatched:flag}),contentItems:[{type:'inputText',text:JSON.stringify({actionDispatched:false})}]};
  for(let i=1;i<=8;i++){const stopped=repeatedToolFailure(state,call('relay_browser','fill'),bogus,{progressEpoch:0});
   assert.equal(Boolean(stopped),i===8,'Untrusted content text cannot prove a pre-dispatch rejection');
  }
 }
 const state={};for(let i=0;i<14;i++)repeatedToolFailure(state,call('relay_browser','fill'),result('BROWSER_REF_STALE',{actionDispatched:false}),{progressEpoch:0});
 assert.equal(state.dynamicToolFailure.count,1);
});
test('dedicated Directory recovery receives an extra bounded window but cannot spin forever',()=>{
 const state={};for(let i=1;i<=TOOL_FAILURE_LIMITS.repeatedFailure*2;i++){
  const stopped=repeatedToolFailure(state,call('relay_workspace','write'),result('DIRECTORY_FOCUS',{actionDispatched:false}),{ignoreDirectoryFocus:true,progressEpoch:i});
  assert.equal(Boolean(stopped),i===TOOL_FAILURE_LIMITS.repeatedFailure*2);
 }
 assert.equal(state.dynamicToolFailure.total,16);
 repeatedToolFailure(state,call(),{success:true,contentItems:[]});assert.equal(state.dynamicToolFailure,null);
});
test('only host-enforced tool-loop/limit codes avoid provider generation-health penalties',()=>{
 assert.equal(hostToolStopCode('TOOL_FAILURE_LOOP'),true);assert.equal(hostToolStopCode('TOOL_CALL_LIMIT'),true);
 for(const code of ['PROVIDER_NETWORK','PROVIDER_MODEL','BROWSER_REF_STALE','WORKSPACE_ERROR','INVALID_TASK_VIEW'])
   assert.equal(hostToolStopCode(code),false);
});