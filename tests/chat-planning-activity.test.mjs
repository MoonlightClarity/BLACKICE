import test from 'node:test';
import assert from 'node:assert/strict';
import {applyChatPlanningModuleEvent, mergeChatRunUpdate, projectPlanningModuleReceipts} from '../public/next/chat/model.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';

const run=()=>({id:'r1',taskId:'t1',nodes:{agent:{}},chatPlanning:'on'});
const data=(phase,extra={})=>({type:'planning.module',runId:'r1',taskId:'t1',nodeId:'agent',
 moduleId:'builtin-decomposition',artifact:'pending-actions',phase,...extra});
const event=(phase,extra)=>({type:'agent.event',runId:'r1',nodeId:'agent',data:data(phase,extra)});

test('Planning selector alone and foreign/legacy/model-like events do not display module activity',()=>{
 const current=run();
 assert.deepEqual(projectPlanningModuleReceipts(current),[]);
 for(const [phase,extra] of [['started',{taskId:'other'}],['completed',{runId:'past'}],['started',{nodeId:'old'}],
  ['started',{moduleId:'builtin-personal-context'}],['started',{artifact:'scratch-work'}],['provider-completed',{}],
  ['started',{type:'skill_loaded'}],['started',{moduleId:'toString'}]])
  assert.equal(applyChatPlanningModuleEvent(current,event(phase,extra)),false);
 assert.equal(applyChatPlanningModuleEvent({...current,chatPlanning:'off'},event('started')),false);
});
test('live Planning phases deduplicate, render latest safe result, and survive stale updates and reopen',()=>{
 const current=run();
 assert.equal(applyChatPlanningModuleEvent(current,event('started')),true);
 assert.equal(applyChatPlanningModuleEvent(current,event('started')),false);
 assert.equal(current.planningModuleReceipts[0].label,'Started');
 assert.equal(applyChatPlanningModuleEvent(current,event('completed',{reason:'PRIVATE',code:'SECRET',revision:3})),true);
 assert.equal(current.planningModuleReceipts[0].label,'Plan recorded');
 assert.equal(applyChatPlanningModuleEvent(current,event('started')),false);
 const merged=mergeChatRunUpdate(current,{...run(),planningModuleReceipts:[data('started')]});
 assert.equal(merged.planningModuleReceipts[0].phase,'completed');
 const file=projectFamily({rootId:'r1',runs:[{...run(),planningModuleReceipts:[data('started'),data('completed',{reason:'PRIVATE',output:'SECRET'})]}]}).runs[0];
 assert.equal(file.planningModuleReceipts[0].phase,'completed');
 assert.doesNotMatch(JSON.stringify(file),/PRIVATE|SECRET/);
});
test('failure, not needed and needs evidence have distinct labels only if a trusted exact event exists',()=>{
 for(const [phase,label] of [['failed','Did not complete'],['needs-evidence','Needs evidence'],['not-needed','Not needed'],['cancelled','Cancelled']]){
   const current=run();
   assert.equal(applyChatPlanningModuleEvent(current,event(phase)),true);
   assert.equal(current.planningModuleReceipts[0].label,label);
 }
});
