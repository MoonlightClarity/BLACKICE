import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserWorkspace,createBrowserToolHandler} from '../lib/browser.mjs';
import {createWorkspaceToolHandler} from '../lib/workspace-tools.mjs';
import {observeGoalToolOutcome} from '../lib/goal-recovery-policy.mjs';
import {diagnosticAlarmCopy,recordDiagnosticAlarm} from '../public/next/chat/tool-failure.mjs';

test('trusted pre-pointer rejection preserves no-input evidence through browser tool receipt and Goal assessment',async(t)=>{
 const driver={
  status:()=>({available:true,contained:true,tabs:[{tabId:'one'}],activeTab:'one'}),
  async perform(args){
   if(args.action==='snapshot')throw Object.assign(new Error('Fresh observation unavailable'),{code:'BROWSER_SNAPSHOT_DOCUMENT_CHANGED'});
   throw Object.assign(new Error('Current observed control changed before click'),{code:'BROWSER_REF_STALE',inputDispatched:false,pointerStage:'pre-pointer-identity'});
  },
  close:async()=>{}
 };
 const browser=new BrowserWorkspace({driver});t.after(()=>browser.close());
 const handler=createBrowserToolHandler({browser});
 const call={name:'relay_browser',arguments:{action:'click',browser:'relay',tabId:'one',ref:'observed-ref',expectedUrl:'https://fixture.example.test/',expectedDocumentId:'one:4'}};
 const returned=await handler(call);
 assert.equal(returned.success,false);
 assert.equal(returned.code,'BROWSER_REF_STALE');
 assert.equal(returned.inputDispatched,false);
 assert.equal(returned.pointerStage,'pre-pointer-identity');
 assert.equal(JSON.parse(returned.contentItems[0].text).pointerStage,'pre-pointer-identity');
 const classification=observeGoalToolOutcome(call,returned);
 assert.equal(classification.kind,'recoverable_no_input','Trusted pre-pointer evidence must not become an uncertain submitted effect');
 assert.equal(classification.inputDispatched,false);
 const ambiguous={...returned,inputDispatched:undefined,pointerStage:undefined,contentItems:[{type:'inputText',text:JSON.stringify({code:'BROWSER_REF_STALE',error:'Unknown effect'})}]};
 assert.equal(observeGoalToolOutcome(call,ambiguous).kind,'uncertain_external_effect','An unproven pre-input boundary must remain uncertain');
});

test('invalid format-specific paging is explicitly coded and suggests a safe corrected read',async()=>{
 const handler=createWorkspaceToolHandler({cwd:process.cwd()});
 const call={name:'relay_workspace',arguments:{action:'read',path:'fixture-not-opened.pdf',startLine:1}};
 const value=await handler(call);
 assert.equal(value.success,false);
 const detail=JSON.parse(value.contentItems.find(x=>x.type==='inputText').text);
 assert.equal(detail.code,'WORKSPACE_READ_OPTIONS_INVALID');
 assert.match(detail.recovery.nextAction,/PDF page\/character options/);
 const alarm=recordDiagnosticAlarm(null,{type:'tool.result',tool:'relay_workspace',action:'read',success:false,code:detail.code});
 assert.equal(alarm.rows[0].code,detail.code);
 assert.match(diagnosticAlarmCopy(alarm.rows[0]).observed,/paging/);
});
