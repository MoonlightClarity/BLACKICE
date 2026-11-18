
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {DirectExecutionJobs} from '../lib/direct-execution-jobs.mjs';
import {connectorBrowserOwner} from '../lib/connector-browser-owner.mjs';
import {stoppedBrowserOwnerStatus,activeBrowserOwnerStatus,readStoppedTabEffects} from '../lib/browser-stopped-adoption.mjs';
test('SQLite lifecycle retain exact owner identity and interrupted effects after restart',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'packed-owner-'));let jobs=await new DirectExecutionJobs({dataDir:dir}).init();
 t.after(async()=>{await jobs.close();await rm(dir,{recursive:true,force:true});});
 const owner=connectorBrowserOwner('packed-client'),conversation={taskId:'conversation-a',runId:'old',nodeId:'conversation',conversationId:'conversation-a'};
 const engine={runs:new Map([['new',{id:'new',taskId:conversation.taskId,status:'completed',settled:true}]]),executionEntries:()=>[]};
 const direct={jobs,active:new Map()};
 for (const [id,args] of [['connector',{}],['conversation',{conversationId:conversation.taskId}]]) {
  const row=(await jobs.admit({ownerId:'packed-client',requestId:id,tool:'blackice_browser_action',arguments:{action:'click',...args},requiredScopes:['browser:write'],client:{id:'packed-client',scopes:['browser:write']},mutating:true})).job;
  await jobs.update(row.id,()=>({status:'interrupted',dispatched:true,finishedAt:new Date().toISOString(),effects:{possible:true,confirmed:false}}));
 }
 assert.equal(stoppedBrowserOwnerStatus(owner,engine,direct).eligible,true);
 assert.equal(stoppedBrowserOwnerStatus(conversation,engine,direct).eligible,true);
 await jobs.close();jobs=await new DirectExecutionJobs({dataDir:dir}).init();direct.jobs=jobs;
 const inherited=await readStoppedTabEffects(owner,engine,direct);
 assert.equal(inherited.directJobs.length,1);assert.equal(inherited.uncertain,true);
 const convRows=jobs.ownerSnapshot({ownerTaskId:conversation.taskId}).filter(j=>j.browserConversationId===conversation.taskId);assert.equal(convRows.length,1);
 assert.equal(stoppedBrowserOwnerStatus(owner,engine,direct).eligible,true);assert.equal(stoppedBrowserOwnerStatus(conversation,engine,direct).eligible,true);
 const live=(await jobs.admit({ownerId:'packed-client',requestId:'live',tool:'blackice_browser_action',arguments:{action:'click',conversationId:conversation.taskId},requiredScopes:['browser:write'],client:{id:'packed-client',scopes:['browser:write']},mutating:true})).job;
 await jobs.update(live.id,()=>({status:'running'}));
 assert.equal(stoppedBrowserOwnerStatus(conversation,engine,direct).eligible,false);assert.equal(activeBrowserOwnerStatus(conversation,engine,direct),true);
 assert.equal(stoppedBrowserOwnerStatus(owner,engine,direct).eligible,true);
});
