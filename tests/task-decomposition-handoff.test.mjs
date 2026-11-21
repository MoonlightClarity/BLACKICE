import test from 'node:test';
import assert from 'node:assert/strict';
import {readReleaseSkill} from '../lib/release-skills.mjs';
import {ACTION_DIRECTORY_INSTRUCTIONS,TaskActionDirectory} from '../lib/task-action-directory.mjs';

test('Task decomposition asks for a minimal usable handoff and teaches recovery without broadening authority',()=>{
 const {content,revision}=readReleaseSkill('builtin-decomposition');
 assert.equal(revision,1);
 assert.match(content,/Preserve useful handoffs/);
 assert.match(content,/actual link, file, ID, relevant finding, and remaining question/);
 assert.match(content,/title or receipt ID alone may not locate the source/);
 assert.match(content,/prior handoff lacks a link, search with the known identifiers and recover it rather than restarting unrelated work/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/obtain a new task-owned read without discarding the earlier record/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/earlier action may have run, record unresolved-effect and inspect its destination before repeating it/);
 assert.match(content,/Job application: check the posting and materials, submit, then inspect the result/);
 assert.match(content,/Deeper employer preparation belongs at a screen or interview unless it changes today's application/);
 assert.match(content,/report what was completed, the observed limitation, and what is still missing/);
});

test('Directory makes handoff and recovery guidance visible without changing tool authority',()=>{
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/Save source locators and findings that dependent work can retrieve/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/old locator no longer works, obtain a new task-owned read without discarding the earlier record/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/A stale reference, failed click or elapsed-time estimate does not establish exhaustion/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/observe with outcome partial keeps the action active/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/Check the next useful source/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/Before a file change, form submission or message, plan and focus the action that makes that change/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/earlier action may have run, record unresolved-effect and inspect its destination before repeating it/);
});

test('a names-only discovery remains observed while its dependent step retrieves a usable source',async()=>{
 const ledger=new TaskActionDirectory({taskId:'diagnostic',objective:'Discover and prepare a hypothetical item'});
 const edit=payload=>ledger.edit(payload,{expectedActionRevision:ledger.read().actionRevision});
 const tool=(name,text)=>ledger.execute({name},async()=>({success:true,contentItems:[{type:'inputText',text}]}),{runId:'run',nodeId:'agent',observationOnly:true,expectedActionRevision:ledger.read().actionRevision});
 await edit({action:'plan',actions:[{id:'find',objective:'Find a name',dependsOn:[]},{id:'prepare',objective:'Prepare from verified source',dependsOn:['find']}]});
 await edit({action:'focus',id:'find'});
 const names=await tool('relay_browser','Company X: Role Y');
 const observed=await edit({action:'observe',id:'find',claim:'Found the name Company X: Role Y only',receipts:[names.receiptId]});
 assert.deepEqual(observed.ready,['prepare']);
 await edit({action:'focus',id:'prepare'});
 const source=await tool('relay_browser','Posting ID fixture-y; form unavailable; prepare notes only');
 const after=await edit({action:'observe',id:'prepare',claim:'Fresh read verified fixture-y; prepared notes; no external action',receipts:[source.receiptId]});
 assert.equal(after.actions[0].observation.claim,'Found the name Company X: Role Y only');
 assert.equal(after.actions[1].state,'observed');
 assert.deepEqual(after.receipts.map(r=>r.actionId),['find','prepare']);
});
