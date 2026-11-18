import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {DirectExecutionAPI,DIRECT_EXECUTION_SCOPES} from '../lib/direct-execution-api.mjs';
test('receipt lookup never injects another conversation, archived, or trashed resource history',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'blackice-context-isolation-'));const api=new DirectExecutionAPI({dataDir:root,allowedRoot:root});await api.init();t.after(async()=>{await api.close();await rm(root,{recursive:true,force:true});});
 const client={id:'same-grant',scopes:[...DIRECT_EXECUTION_SCOPES]};let current;
 for(const [id,conversationId,text] of [['archived','archived-conversation','SECRET_ARCHIVE'],['trash','trashed-conversation','SECRET_TRASH'],['other','other-folder','SECRET_OTHER'],['current','current-conversation','CURRENT']]){
  const job=(await api.jobs.admit({ownerId:client.id,requestId:id,tool:'blackice_browser_read',arguments:{action:'read',url:'https://example.test/shared',conversationId},requiredScopes:['browser:read'],client,mutating:false})).job;
  await api.jobs.update(job.id,()=>({status:'succeeded',result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify({url:'https://example.test/shared',text})}]}}));current=job.id;
 }
 api.jobs.resourceHistory=()=>{throw Error('Must not call contextual history');};
 const value=await api.getJob(current,client);assert.equal(value.resourceHistory,undefined);assert.match(value.result.text.text,/CURRENT/);assert.doesNotMatch(JSON.stringify(value),/SECRET_/);
});
