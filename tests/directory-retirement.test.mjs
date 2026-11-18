import test from 'node:test';
import assert from 'node:assert/strict';
import {DIRECTORY_RETIREMENT} from '../lib/directory-retirement.mjs';
import {assertCompatibleDirectoryMode,executionModesFrom,usesDirectory} from '../lib/conversation-execution-modes.mjs';
import {runPreparedDirectoryAgent} from '../lib/shadowdancer-engine.mjs';
import {runShadowdancerDirectory,ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
import {readManagedDirectoryContext} from '../lib/shadowdancer-context.mjs';
import {handleShadowdancerContextHttp} from '../lib/shadowdancer-context-http.mjs';
const retired={code:'DIRECTORY_RETIRED',status:410};
test('Directory admission rejects explicit, prefix, legacy and inherited requests without silently changing them',()=>{
 assert.equal(DIRECTORY_RETIREMENT.available,false);
 for(const [input,mode] of [['task','on'],['/directory task',undefined],['@directory task','auto'],['@shadowdancer task',undefined]])assert.throws(()=>assertCompatibleDirectoryMode(input,mode),retired);
 const resumed=executionModesFrom({}, {directoryMode:'on'});assert.equal(resumed.directoryMode,'on');assert.throws(()=>assertCompatibleDirectoryMode('continue',resumed.directoryMode),retired);
 assert.doesNotThrow(()=>assertCompatibleDirectoryMode('ordinary task','off'));assert.equal(usesDirectory('ordinary task','off'),false);
});
test('all model execution entrypoints reject before provider or file access',async()=>{
 assert.throws(()=>new ShadowdancerDirectory({}),retired);
 await assert.rejects(runPreparedDirectoryAgent({}),retired);
 await assert.rejects(runShadowdancerDirectory({}),retired);
 await assert.rejects(ShadowdancerDirectory.prototype.run.call({},'task'),retired);
 await assert.rejects(readManagedDirectoryContext({}),retired);
});
test('retired context API cannot reload, edit, import or delete records',async()=>{
 for(const suffix of ['', '/file','/audit','/edit','/delete','/import','/conversations','/activity']){
  let response;
  const handled=await handleShadowdancerContextHttp({req:{},res:{},pathname:'/api/shadowdancer/context'+suffix,json:(_res,status,body)=>response={status,body}});
  assert.equal(handled,true);assert.equal(response.status,410);assert.equal(response.body.code,'DIRECTORY_RETIRED');
 }
 assert.equal(await handleShadowdancerContextHttp({pathname:'/unrelated'}),false);
});

test('engine dispatch rejects persisted Directory before execution starts',async()=>{
 const {HarnessEngine}=await import('../lib/engine.mjs');
 let executionStarted=false;
 const fake={conversationAdmission:()=>{},runs:new Map(),runtimeSettings:{get:()=>({})},nativeHistoryPolicy:()=>({}),executions:new Map(),execute:()=>{executionStarted=true;}};
 const run={id:'saved-directory',input:'continue',workflow:{settings:{}},executionModes:{directoryMode:'on'}};
 assert.throws(()=>HarnessEngine.prototype.dispatchRun.call(fake,run),retired);
 assert.equal(executionStarted,false);assert.equal(fake.executions.size,0);
});
