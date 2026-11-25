import test from 'node:test';
import assert from 'node:assert/strict';
import { projectExecutionSkill } from '../lib/execution-skill-brief.mjs';
import { BROWSER_TOOL, createBrowserToolHandler } from '../lib/browser.mjs';
import { WORKSPACE_TOOL } from '../lib/workspace-tools.mjs';
import {NATIVE_BROWSER_CLEANUP_PROTOCOL} from '../lib/browser-cleanup-policy.mjs';
import { normalizePlanningOntology } from '../public/planning-module-policy.mjs';

const skill=(id,content='# Method\n\nOwner context and examples.')=>({id,content,title:'Method',source:'user',revision:4});

test('automatic methods are bounded and full owner revisions remain available explicitly',()=>{
  const long=skill('library-job-search','# Job Search\n\n'+ 'Owner-specific context. '.repeat(3000));
  const projected=projectExecutionSkill(long);
  assert.equal(projected.mode,'brief');
  assert.ok(projected.text.length<1400);
  assert.match(projected.text,/actual duties and transferable skills/);
  assert.match(projected.text,/one concrete duty or deliverable plausibly supported/);
  assert.match(projected.text,/Unverified work authorization or sponsorship/);
  assert.match(projected.text,/NOT evidence every role is ineligible/);
  assert.match(projected.text,/specific field or form/);
  assert.doesNotMatch(projected.text,/Owner-specific context/);
  const explicit=projectExecutionSkill(long,{explicit:true});
  assert.equal(explicit.mode,'full');
  assert.equal(explicit.text,long.content,'an explicit read or method selection never loses owner content');
});

test('generic automatic skills use purpose metadata rather than unbounded prose',()=>{
  const user=skill('library-specialized-method','---\ndescription: Evaluate source documents once and verify actual outcomes.\n---\n# Method\n\n'+'Unrelated examples.\n'.repeat(1000));
  const brief=projectExecutionSkill(user);
  assert.equal(brief.mode,'brief');
  assert.match(brief.text,/Evaluate source documents once/);
  assert.ok(brief.text.length<500);
});

test('time management is optional telemetry; browser and workspace descriptions are bounded',()=>{
  assert.equal(normalizePlanningOntology().modules.time_management,false);
  assert.ok(BROWSER_TOOL.description.replace(NATIVE_BROWSER_CLEANUP_PROTOCOL,'').length<1500);
  assert.ok(BROWSER_TOOL.description.endsWith(NATIVE_BROWSER_CLEANUP_PROTOCOL));
  assert.ok(WORKSPACE_TOOL.description.length<1100);
  assert.match(BROWSER_TOOL.description,/BROWSER_TAB_NOT_FOUND/);
});

test('missing browser tab is a definite pre-dispatch failure with a recovery call, not an unknown site error',async()=>{
  let performed=0;
  const browser={status:()=>({available:true,contained:true,tabs:[],folders:[],activeTab:null,browsers:{relay:{available:true,contained:true,tabs:[]}}}),
    perform:async()=>{performed++;throw Error('The browser must not dispatch a missing tab');}};
  const handler=createBrowserToolHandler({browser,owner:{taskId:'task',runId:'run',nodeId:'agent'}});
  const result=await handler({name:'relay_browser',arguments:{action:'snapshot',browser:'relay',tabId:'missing'}});
  assert.equal(result.success,false);
  assert.equal(result.code,'BROWSER_TAB_NOT_FOUND');
  assert.equal(result.actionDispatched,false);
  assert.equal(performed,0);
  const details=JSON.parse(result.contentItems[0].text);
  assert.equal(details.actionDispatched,false);
  assert.deepEqual(details.recovery.nextCall,{action:'tabs',browser:'relay'});
  assert.equal(details.recovery.replayOriginal,false);
  assert.match(details.recovery.nextStep,/current task-owned tab/);
});
