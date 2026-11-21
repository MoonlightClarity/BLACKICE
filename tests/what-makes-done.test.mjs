import test from 'node:test';
import assert from 'node:assert/strict';
import {readBundledSkill} from '../lib/skill-library.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {ACTION_DIRECTORY_TOOL,TaskActionDirectory} from '../lib/task-action-directory.mjs';
import {TASK_COMPLETION_GUIDANCE} from '../lib/task-completion-guidance.mjs';

test('What Makes Done is a discoverable advisory skill with actionable examples',async()=>{
 const catalog=createSkillsCatalog();
 const row=(await catalog.list({query:'definition of done'})).entries.find(x=>x.id==='library-what-makes-done');
 assert.equal(row?.title,'What Makes Done');
 const {content}=await readBundledSkill('library-what-makes-done');
 for(const pattern of [/same query and cursor/,/continue with the others/,/when the employer or application service confirms it/,/cutoff is in the future/,/representative totals/,/from the complete source/,/calculation included/,/does not verify its contents/,/open draft is not a send/,/check Sent or the receipt/,/Do not end the turn until you are really done/,/real reason to stop/])assert.match(content,pattern);
 assert.match(TASK_COMPLETION_GUIDANCE,/Continue useful authorized work while the outcome remains unmet/);
 assert.match(ACTION_DIRECTORY_TOOL.description,/add and take the next useful authorized step/);
});

test('What Makes Done reconciles exact duplicate risk without importing old conversations or flattening evidence',async()=>{
 const {content,provenance}=await readBundledSkill('library-what-makes-done');
 assert.equal(provenance.revision,'blackice-what-makes-done-v4');
 assert.match(content,/the smallest check in records the current request lets you use/);
 assert.match(content,/Do not automatically ingest an old ledger or turn Past Chats on/);
 assert.match(content,/If Past Chats is off, do not look up past chats through another tool or source/);
 assert.match(content,/\*\*Verified:\*\*[\s\S]*do not count it as a new action/);
 assert.match(content,/\*\*Reported:\*\*[\s\S]*continue with an eligible alternative, but it is not a verified submission/);
 assert.match(content,/\*\*Unknown:\*\*[\s\S]*Check before retrying/);
 assert.match(content,/\*\*Not dispatched:\*\*[\s\S]*This says nothing about other attempts/);
 assert.match(content,/same ATS employer and posting ID[\s\S]*across URL variants/);
 assert.match(content,/Different posting IDs with the same title are not by themselves a duplicate/);
 assert.match(content,/An empty email search does not clear a portal submission/);
 assert.match(content,/Match the account, merchant, and cart or order reference/);
});
test('receipt-backed discovery advances to delivery; a confirmation is a separate action',async()=>{
 const d=new TaskActionDirectory({taskId:'fixture',objective:'Submit one synthetic application'});
 const opt=()=>({expectedActionRevision:d.read().actionRevision});
 const edit=x=>d.edit(x,opt());
 await edit({action:'plan',actions:[{id:'source',objective:'Find a usable posting',dependsOn:[]},{id:'apply',objective:'Submit fixture form and observe confirmation',dependsOn:['source']}]});
 const result=(text,observationOnly)=>d.execute({name:'relay_browser'},async()=>({success:true,contentItems:[{type:'inputText',text}]}),{runId:'run',nodeId:'agent',observationOnly,...opt()});
 await edit({action:'focus',id:'source'});
 const source=await result('Fixture posting link',true);
 await edit({action:'observe',id:'source',claim:'Usable posting located',receipts:[source.receiptId]});
 assert.deepEqual(d.read().ready,['apply']);
 assert.equal(d.finalStatus().ready,false);
 await edit({action:'focus',id:'apply'});
 const confirmation=await result('Fixture receiving service confirmed submission #1',false);
 await edit({action:'observe',id:'apply',claim:'Receiving service confirmed fixture submission #1',receipts:[confirmation.receiptId]});
 assert.equal(d.finalStatus().ready,true);
});

test('Critical Path distinguishes the action that unlocks delivery from a tempting detour',async()=>{
 const {content}=await readBundledSkill('library-simplest-complete-path');
 for(const expected of [/research, writing, operations, and software/,/smallest informative check/,/another comparison would not change the next action/,/not on the critical path/,/research if you get an interview/,/continue other eligible applications/,/Keep the prerequisite open when an option fails/,/Find a usable dataset/,/necessary verification/])assert.match(content,expected);
 assert.doesNotMatch(content,/token (?:budget|conservation|saving)|(?:save|conserve|reduce) tokens/i);
});

test('Long-Term Judgment teaches action under uncertainty without making reversibility a gate',async()=>{
 const {content}=await readBundledSkill('library-long-term-judgment');
 for(const expected of [/Calibrate effort to reliance/,/trusted implementer/,/exactly how to restore it/,/Reversibility is a reason to act sooner, not a condition for acting/,/If a step is irreversible, stay proactive/,/If the action is authorized and the evidence is good enough for the stakes, carry it out/,/do not silently retire, hide, or narrow/,/Two illustrations/])assert.match(content,expected);
});
