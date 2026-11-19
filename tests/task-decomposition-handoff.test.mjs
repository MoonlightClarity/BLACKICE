import test from 'node:test';
import assert from 'node:assert/strict';
import {readReleaseSkill} from '../lib/release-skills.mjs';
import {ACTION_DIRECTORY_INSTRUCTIONS,TaskActionDirectory} from '../lib/task-action-directory.mjs';

test('Task decomposition asks for a minimal usable handoff and teaches recovery without broadening authority',()=>{
 const {content}=readReleaseSkill('builtin-decomposition');
 assert.match(content,/Leave a usable handoff/);
 assert.match(content,/stable link or ID[\s\S]*what remains unverified/);
 assert.match(content,/task-owned working artifact it names/);
 assert.match(content,/missing saved link nor a missing old tab is by itself a blocker/);
 assert.match(content,/Recovering an input does not authorize replay of an uncertain external action/);
 assert.match(content,/canonical links or posting IDs[\s\S]*requirements and application route/);
 assert.match(content,/search the current employer site or job board[\s\S]*rereading the résumé/);
 assert.match(content,/Preparing materials does not mean submitting them/);
});

test('Directory makes handoff and recovery guidance visible without changing tool authority',()=>{
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/record stable source locators.*names or receipt IDs alone may not be usable/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/preserve the record and make a fresh task-owned read or search in the ready step \(or add a narrow recovery step\)/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/A missing old tab or link alone is not a blocker/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/Unknown attempts must remain unresolved, never assume absence or replay/);
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
