import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {BrowserWorkspace} from '../lib/browser.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {createApplicationHistoryGate} from '../lib/application-history.mjs';

const urlA='https://jobs.ashbyhq.com/ExampleCo/11111111-1111-4111-8111-111111111111';
const urlB='https://jobs.ashbyhq.com/ExampleCo/22222222-2222-4222-8222-222222222222';
const call=(tabId,url,id)=>({name:'relay_browser',callId:id,arguments:{
  action:'click',browser:'relay',tabId,ref:'submit',expectedUrl:url,expectedDocumentId:'document-1',
}});
const code=result=>result.code||JSON.parse(result.contentItems?.find(item=>item.type==='inputText')?.text||'{}').code;
test('real HarnessEngine browser pathway preserves ATS history claims and minimal-scope blocking with Planning Off',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-ops-browser-engine-')),cwd=path.join(directory,'workspace');
  await mkdir(cwd);
  const tasks=await new TaskStateStore({dataDir:directory}).init();
  let activeRunId=null,dispatches=0,providerTurns=0;
  const tabs=[{tabId:'job-a',url:urlA},{tabId:'job-b',url:urlB}];
  const driver={
    status:()=>({available:true,contained:true,activeTab:'job-a',
      tabs:tabs.map(tab=>({...tab,browser:'relay',purpose:'task',documentId:'document-1',
        owner:{taskId:activeRunId,runId:activeRunId,nodeId:'agent'}}))}),
    observeOperation:async args=>{
      const tab=tabs.find(item=>item.tabId===args.tabId);
      return{current:true,tabId:tab.tabId,url:tab.url,documentId:'document-1',frameId:'frame-1',loaderId:'loader-1',
        title:'Senior Data Engineer | ExampleCo',control:{ref:'submit',kind:'form-submit',form:{
          id:'form-1',documentId:'document-1',method:'POST',enctype:'application/x-www-form-urlencoded',
          target:'_self',action:tab.url+'/application',payloadDigest:'a'.repeat(64),
          attachmentDigests:[],submitLabel:'Submit application',
        }}};
    },
    perform:async args=>{dispatches++;return{actionDispatched:true,tabId:args.tabId,
      url:tabs.find(item=>item.tabId===args.tabId).url,documentId:'document-1',frames:[]};},
    close:async()=>{},
  };
  const browser=new BrowserWorkspace({driver});
  class Runtime extends EventEmitter {
    status(){return{connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',supportsTools:true}]};}
    async runAgent(options){
      providerTurns++;
      assert.ok(options.dynamicTools.find(tool=>tool.name==='relay_browser'),'browser must be attached');
      const a=await options.onToolCall(call('job-a',urlA,'submit-a'));
      assert.equal(a.success,true);
      const duplicate=await options.onToolCall(call('job-a',urlA,'submit-again'));
      assert.equal(duplicate.success,false);
      assert.equal(code(duplicate),'APPLICATION_HISTORY_RESERVED');
      const b=await options.onToolCall(call('job-b',urlB,'submit-b'));
      assert.equal(b.success,true,'a different requisition must continue');
      return{output:'Two submissions dispatched, outcome not verified',threadId:'test-browser-thread'};
    }
    async close(){}
  }
  const engine=await new HarnessEngine({runtime:new Runtime(),browser,tasks,dataDir:directory,defaultCwd:cwd}).init();
  engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:false})};
  t.after(async()=>{await engine.close();await tasks.close();await browser.close();await rm(directory,{recursive:true,force:true});});
  const workflow=createMissionWorkflow({task:'Submit two distinct test applications',model:'fixture-model',cwd,planningMode:'off'});
  const started=engine.startRun({workflow,input:{task:'Submit two distinct test applications',cwd,planningMode:'off'}});
  activeRunId=started.id;
  let done;
  for(let i=0;i<150;i++){
    done=engine.getRun(started.id);
    if(done?.settled)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(done.status,'completed',done.error||done.nodes.agent?.error);
  assert.equal(dispatches,2);
  assert.equal(providerTurns,1,'no mandatory planning or extra review model turn');
  await assert.rejects(createApplicationHistoryGate({store:tasks,cwd,taskId:'different-task'}).check({
    descriptor:{effect:'commit',applicationPage:{url:urlA,title:'Senior Data Engineer | ExampleCo',submission:'final'},
      commit:{effectKey:'any',pageUrl:urlA,destinationKey:'destination:'+urlA+'/application'}}}),
    {code:'APPLICATION_HISTORY_RESERVED'});
});
