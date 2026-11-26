import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readBundledSkill} from '../lib/skill-library.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {ACTION_DIRECTORY_TOOL,TaskActionDirectory} from '../lib/task-action-directory.mjs';
import {TASK_COMPLETION_GUIDANCE} from '../lib/task-completion-guidance.mjs';

async function readCurrentGuidance(id){
 const root=new URL('../lib/skill-library/',import.meta.url);
 const manifest=JSON.parse(await readFile(new URL('index.json',root),'utf8'));
 const declaration=manifest.entries.find(entry=>entry.id===id);
 assert.ok(declaration,'current bundled guidance is declared');
 const skill=await readBundledSkill(id);
 assert.deepEqual(skill.provenance,declaration.source);
 const expectedRevisions={
  'library-what-makes-done':'agency-efficiency-20261125',
  'library-simplest-complete-path':'clarity-20261121',
  'library-long-term-judgment':'skill-allocation-20261125',
 };
 assert.ok(Object.hasOwn(expectedRevisions,id),'guidance has an explicit current revision expectation');
 assert.equal(skill.provenance.revision,expectedRevisions[id]);
 assert.equal(skill.content,await readFile(new URL(declaration.bodyFile,root),'utf8'));
 return skill;
}

test('What Makes Done is a discoverable advisory skill with actionable examples',async()=>{
 const catalog=createSkillsCatalog();
 const row=(await catalog.list({query:'definition of done'})).entries.find(x=>x.id==='library-what-makes-done');
 assert.equal(row?.title,'What Makes Done');
 const {content}=await readCurrentGuidance('library-what-makes-done');
 for(const pattern of [
  /empty file-search page with a cursor calls for the next page/,
  /Finish independent parts when one part is blocked/,
  /submitted application ends at employer acceptance, not an eventual hiring decision/,
  /Check the clock or host event before saying time ran out/,
  /export containing 40 of 61 required batches is partial; fetch the other 21/,
  /Read the file's required contents, check the service's confirmation, or verify the source/,
  /successful receipt must support the specific claim/,
  /A plan, open form, click, saved draft, or normal model return is progress only when it advances the requested outcome/,
  /Stop when the requested result is supported[\s\S]*real cutoff is reached[\s\S]*State unfinished work accurately/,
  /Report a continuation only when one is actually running/,
  /requires two verified matches[\s\S]*cap, not a completion minimum/,
  /A hard requirement imposed by the user remains distinct from a counterparty preference/,
  /failed candidate closes that candidate, not the whole search/
 ])assert.match(content,pattern);
 assert.match(content,/every exported method[^.]*read-only getters/, 'Code contracts must cover query methods as well as mutations');
 assert.match(content,/Promise-returning methods?[^.]*reject[^.]*synchronously/, 'Async API contracts must reject promises instead of throwing synchronously');
 assert.match(TASK_COMPLETION_GUIDANCE,/result the user requested and check that result at its destination/);
 assert.match(TASK_COMPLETION_GUIDANCE,/A time limit stops work; it does not complete it/);
 assert.match(TASK_COMPLETION_GUIDANCE,/When a route fails, try the next useful route within scope/);
 assert.match(ACTION_DIRECTORY_TOOL.description,/add and take the next useful authorized step/);
});

test('What Makes Done revisits working methods while preserving direct requirements and prior effects',async()=>{
 const {content}=await readCurrentGuidance('library-what-makes-done');
 for(const expected of [
  "Keep direct user requirements distinct from working steps and optional improvements",
  "Treat inferred preferences, hypotheses, filters, and earlier plans as revisable strategy",
  "Compare feasible approaches when the choice could affect the result",
  "Results selected by your own filter do not independently establish that excluded possibilities are unsuitable",
  "Honor explicitly fixed scope and methods",
  "Preserve pending work and inspect uncertain effects before any replay",
 ])assert.ok(content.includes(expected),expected);
});

test('required follow-up confirmation allows delivery latency and preserves the requested outcome',async()=>{
 const {content}=await readCurrentGuidance('library-what-makes-done');
 for(const expected of [
  "A requested action includes its required follow-up confirmations",
  "check the user's matching mailbox through available tools, including connected Gmail when available",
  "Match the message to this attempt and complete its required link or code step, then inspect the destination outcome",
  "Keep the attempt pending until the required confirmation and requested outcome are observed",
  "minimum 90-second delivery window",
  "no earlier than 90 seconds after the observed request",
  "A user cutoff still stops work on time",
  "Use short waits and continue independent requested work between checks, within the user's actual cutoff",
  "Report a failed route accurately and continue independent work or allowed alternatives toward the requested outcome",
  "Preserve an explicitly fixed target; a different result does not complete it",
  "Inspect uncertain prior effects before repeating them; do not resubmit merely because a message is delayed"
])assert.ok(content.includes(expected),expected);
});

test('What Makes Done reconciles exact duplicate risk without importing old conversations or flattening evidence',async()=>{
 const {content}=await readCurrentGuidance('library-what-makes-done');
 assert.match(content,/Check the exact target and operation in current authorized records/);
 assert.match(content,/Respect the current Past Chats setting/);
 assert.match(content,/current service record or separately authorized task ledger can establish an effect without looking up old conversations/);
 assert.match(content,/Verified effect within the current request's time and count \| Count it once and continue/);
 assert.match(content,/Reported effect without confirmation \| Check a stronger source, or set that item aside while continuing others/);
 assert.match(content,/Unknown after timeout\/lost response \| Inspect the destination before repeating the action/);
 assert.match(content,/This attempt was not dispatched \| Repair it and retry if still needed; consider any other known attempts/);
 assert.match(content,/“Not established” is different from “confirmed failure\.”/);
 assert.match(content,/worker's “done” message does not replace the original result/);
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
 const {content}=await readCurrentGuidance('library-simplest-complete-path');
 for(const expected of [
  /several next actions compete or one dependency blocks delivery/,
  /Use the smallest useful check and then act/,
  /Investigate uncertainty only when the answer could change that action/,
  /Choose an available action that meets that condition, unlocks later work, or delivers the result directly/,
  /Save deeper employer research for a screen or interview unless a missing fact changes the application now/,
  /try another route to the same result or advance an independent deliverable/,
  /Keep a prerequisite open while trying candidates that could satisfy it/,
  /dataset lacks a required field: record the gap and check another source/,
  /Keep finished work and unaffected verification/
 ])assert.match(content,expected);
 assert.doesNotMatch(content,/token (?:budget|conservation|saving)|(?:save|conserve|reduce) tokens/i);
});

test('Long-Term Judgment teaches action under uncertainty without making reversibility a gate',async()=>{
 const {content}=await readCurrentGuidance('library-long-term-judgment');
 for(const expected of [
  /Identify who will use the result, how often, how failure would appear, and what recovery would take/,
  /Make delegated implementation choices using the best available evidence/,
  /preserve a practical way to restore prior state when useful/,
  /An easy undo is a reason to act sooner, not a prerequisite for every action/,
  /Compare feasible approaches by benefit, effort, delay, maintenance, and the consequences of failure/,
  /simplest approach that meets the whole requirement/,
  /report both what works and what remains unexplained/,
  /later compensating action does not erase an earlier effect/,
  /do not silently discard the result/
 ])assert.match(content,expected);
});

test('shared completion distinguishes new effects from existing-state and history requests',async()=>{
 const {content}=await readCurrentGuidance('library-what-makes-done');
 for(const expected of [
  "Match evidence to the current request's time and count",
  "Distinguish a new or additional action from checking an existing state or reporting past work",
  "Reading an old receipt now does not make its action new",
  "Earlier effects can satisfy a state or history request",
  "they do not count as new work when another action is requested",
  "Count effects produced for this same request once, including earlier or resumed attempts",
  "| Verified effect within the current request's time and count | Count it once and continue. |"
 ])assert.ok(content.includes(expected),expected);
 assert.match(content,/Unknown after timeout\/lost response \| Inspect the destination before repeating the action/);
});
