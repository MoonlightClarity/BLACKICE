import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { promises as filesystem } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LearningStore, buildLearningEvidence, LEARNING_LIMITS } from '../lib/learning.mjs';
import { KnowledgeStore } from '../lib/knowledge.mjs';
import { IdentityStore } from '../lib/identity.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const waitFor=async(check,label='learning condition')=>{const until=Date.now()+5000;while(Date.now()<until){const result=check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(`${label} did not settle`);};
const within=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(`${label} did not settle`)),5000);})]);}finally{clearTimeout(timer);}};
const call=(options,args,context)=>options.onToolCall({name:'relay_learn',arguments:args},context);
const finish=options=>call(options,{action:'finish',summaryOfReview:'Saved only evidence-backed observations and a verification method.'});
const evidence=options=>JSON.parse(options.prompt.split('OBSERVED RUN EVIDENCE\n')[1]);
const proposal=(options,extra={})=>({action:'record',kind:'skill',key:'verify-export',title:'Verify an export',summary:'Check the exported artifact before reporting completion.',content:'Inspect the completed export and compare its contents with the requested result.',whenToUse:'When exporting an artifact in this working folder.',verification:'Read the exported file and confirm the requested content exists.',evidence:[{id:'node_agent',quote:'Verified document list in browser.'}],...extra});
function runFixture(cwd,id='source-run',extra={}){return{id,cwd,workflowName:'Export task',input:'Please use concise output and verify the export.',status:'completed',settled:true,createdAt:'2026-10-16T10:00:00.000Z',finishedAt:'2026-10-16T10:00:10.000Z',output:'Export completed. All checks passed.',workflow:{nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Exporter',model:'selected-fixture-model'},{id:'output',type:'output'}],edges:[]},nodes:{agent:{status:'completed',output:'Verified document list in browser.'}},events:[{at:'2026-10-16T10:00:04.000Z',nodeId:'agent',data:{type:'thread',model:'selected-fixture-model'}},{at:'2026-10-16T10:00:05.000Z',nodeId:'agent',data:{type:'item',item:{type:'commandExecution',command:'verify export',exitCode:0,aggregatedOutput:'All checks passed.'}}}],...extra};}
async function harness(t,execute,extra={}){
  const {learningMode='auto',...storeOptions}=extra;
  const directory=await mkdtemp(path.join(tmpdir(),'relay-learning-test-')),cwd=path.join(directory,'project-a'),otherCwd=path.join(directory,'project-b');
  const knowledge=await new KnowledgeStore({dataDir:directory}).init(),runs=new Map(),calls=[],runtime={status:()=>({defaultModel:'fallback-model',models:[{model:'selected-fixture-model',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]}),runAgent:async options=>{calls.push(options);return execute?execute(options,calls.length):finish(options).then(()=>({output:'Review complete',usage:{totalTokens:12}}));}};
  const options={dataDir:directory,runtime,knowledge,getRun:id=>{const run=runs.get(id);if(!run)throw Object.assign(new Error('Run not found'),{status:404});return structuredClone(run);},delayMs:0,...storeOptions};
  const learning=await new LearningStore(options).init();
  if(learningMode)await learning.updateSettings({mode:learningMode});
  const stores=[learning];
  t.after(async()=>{for(const store of stores)await store.close();await knowledge.writeChain.catch(()=>{});assert.match(path.basename(directory),/^relay-learning-test-/);await rm(directory,{recursive:true,force:true});});
  const add=(id='source-run',value={})=>{const run=runFixture(cwd,id,value);runs.set(id,run);return run;};
  const done=id=>waitFor(()=>{const review=learning.getReview(id);return!['queued','running','committing'].includes(review.status)&&review;},'review completion');
  return{directory,cwd,otherCwd,learning,knowledge,runtime,calls,runs,options,add,done,stores};
}

test('new profiles learn automatically without a setup step and that default survives restart',async t=>{
  const {learning,add,done,calls,options,stores}=await harness(t,null,{learningMode:null});
  assert.equal(learning.status().mode,'auto');
  const automatic=await learning.scheduleAfterRun(add());
  assert.equal(automatic.reason,'automatic');
  assert.equal((await done(automatic.id)).status,'no_changes');
  assert.equal(calls.length,1);
  assert.equal(calls[0].codexHistory,'codex','Standalone stores preserve their library compatibility default.');
  await learning.close();
  const restored=await new LearningStore(options).init();stores.push(restored);
  assert.equal(restored.status().mode,'auto');
  const scheduled=await restored.scheduleAfterRun(add('another-run'));
  await waitFor(()=>restored.getReview(scheduled.id).status==='no_changes');
  assert.equal(calls.length,2);
});

test('legacy saved manual and off choices are not silently converted to automatic learning',async t=>{
  const {learning,options,stores,directory,add,calls}=await harness(t,null,{learningMode:'manual'});
  add();await learning.close();
  // Old version-one files contain no marker distinguishing their original default from an explicit choice.
  const file=path.join(directory,'learning.json'),saved=JSON.parse(await readFile(file,'utf8'));
  for(const mode of ['manual','off']){
    saved.settings={mode};await writeFile(file,JSON.stringify(saved));
    const restored=await new LearningStore(options).init();stores.push(restored);
    assert.equal(restored.status().mode,mode);
    assert.equal(await restored.scheduleAfterRun(add(`saved-${mode}`)),null);
    assert.equal(JSON.parse(await readFile(file,'utf8')).settings.mode,mode);
    await restored.close();
  }
  assert.equal(calls.length,0);
});

test('manual and off ratings save locally without model calls; explicit review includes the saved feedback',async t=>{
  const {learning,add,done,calls,directory}=await harness(t,null,{learningMode:'manual'});add();
  const feedback=await learning.feedback('source-run','bad','The artifact was missing a section.');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(calls.length,0);
  assert.equal(learning.status().queued,0);
  assert.equal(learning.listReviews().length,0);
  assert.equal(JSON.parse(await readFile(path.join(directory,'learning.json'),'utf8')).feedback[0].id,feedback.id);
  const review=await learning.learnNow('source-run');
  assert.equal((await done(review.id)).status,'no_changes');
  assert.match(calls[0].prompt,/The artifact was missing a section/);
  await learning.updateSettings({mode:'off'});
  await learning.feedback('source-run','good','The revised artifact is useful.');
  assert.equal(calls.length,1);
  assert.equal(learning.feedbackEntries.length,2);
  await assert.rejects(learning.learnNow('source-run'),/Learning is off/);
});

test('turning automatic learning off cancels queued feedback reviews while retaining explicit requests',async t=>{
  const {learning,add}=await harness(t,null,{isForegroundBusy:()=>true});add();
  await learning.feedback('source-run','good','Keep the verification approach.');
  const feedbackReview=learning.listReviews()[0];
  const requested=await learning.learnNow('source-run',{force:true});
  assert.equal(feedbackReview.reason,'feedback');
  assert.equal(learning.status().queued,2);
  await learning.updateSettings({mode:'manual'});
  assert.equal(learning.getReview(feedbackReview.id).status,'cancelled');
  assert.equal(learning.getReview(requested.id).status,'queued');
  assert.equal(learning.status().queued,1);
});

test('failed admission never enters the dispatch queue and concurrent retries cannot recover a phantom receipt',async t=>{
  const entered=deferred(),release=deferred();let failNext=false;
  const io={...filesystem,rename:async(source,target)=>{
    if(failNext&&path.basename(target)==='learning.json'){failNext=false;entered.resolve();await release.promise;throw Object.assign(Error('Fixture disk is full.'),{code:'ENOSPC'});}
    return filesystem.rename(source,target);
  }};
  const {learning,add,calls,directory}=await harness(t,null,{io,isForegroundBusy:()=>true});add('first');add('second');
  const before=await readFile(path.join(directory,'learning.json'),'utf8');
  failNext=true;
  const failed=learning.learnNow('first');
  failed.catch(()=>{});
  let outcomes;
  try{
    await within(entered.promise,'Held admission write');
    assert.equal(learning.status().queued,0,'Uncommitted work cannot be dispatched.');
    assert.equal(learning.listReviews().length,0,'Uncommitted work cannot become a dedupe receipt.');
    const second=learning.learnNow('second'),duplicate=learning.learnNow('second');
    const unrelatedWrite=learning.persist();
    outcomes=Promise.allSettled([failed,second,duplicate,unrelatedWrite]);
  }finally{release.resolve();}
  const result=await outcomes;
  assert.equal(result[0].status,'rejected');
  assert.equal(result[0].reason.code,'ENOSPC');
  assert.equal(result[1].status,'fulfilled');
  assert.equal(result[2].status,'fulfilled');
  assert.equal(result[3].status,'fulfilled');
  assert.equal(result[1].value.id,result[2].value.id,'Concurrent duplicate requests share only a committed review.');
  assert.equal(learning.status().queued,1);
  assert.equal(learning.listReviews().length,1);
  assert.equal(learning.listReviews()[0].runId,'second');
  const saved=JSON.parse(await readFile(path.join(directory,'learning.json'),'utf8'));
  assert.deepEqual(saved.reviews.map(item=>item.runId),['second']);
  assert.equal(JSON.parse(before).reviews.length,0);
  const retried=await learning.learnNow('first');
  assert.notEqual(retried.id,result[1].value.id);
  assert.equal(learning.status().queued,2);
  assert.equal(calls.length,0);
  assert.ok((await readdir(directory)).every(file=>!file.endsWith('.tmp')));
  assert.equal(learning.status().healthy,true);
});

test('a failed feedback save stays absent in memory and a successful retry can still be reviewed',async t=>{
  let failNext=false;
  const io={...filesystem,rename:async(source,target)=>{if(failNext&&path.basename(target)==='learning.json'){failNext=false;throw Object.assign(Error('Fixture save refused.'),{code:'EACCES'});}return filesystem.rename(source,target);}};
  const {learning,add,directory,calls}=await harness(t,null,{io,learningMode:'manual'});add();
  failNext=true;
  await assert.rejects(learning.feedback('source-run','bad','This save must fail.'),{code:'EACCES'});
  assert.equal(learning.feedbackEntries.length,0);
  assert.equal(JSON.parse(await readFile(path.join(directory,'learning.json'),'utf8')).feedback.length,0);
  await learning.feedback('source-run','good','A successful retry.');
  assert.equal(learning.feedbackEntries.length,1);
  assert.equal(learning.status().healthy,true);
  assert.equal(calls.length,0);
});

test('review history preference is captured at admission and does not change while queued or active',async t=>{
  let preference='relay',busy=true;const entered=deferred(),release=deferred();
  const {learning,add,done,calls,directory}=await harness(t,async options=>{entered.resolve();await release.promise;await finish(options);return{};},{learningMode:null,isForegroundBusy:()=>busy,getRuntimeSettings:()=>({codexHistory:preference})});
  add('first');add('second');
  const first=await learning.learnNow('first');
  assert.equal(first.codexHistory,'relay');
  preference='codex';busy=false;learning.kick(0);
  try{
    await within(entered.promise,'First private review');
    assert.equal(calls[0].codexHistory,'relay');
    assert.equal(learning.getReview(first.id).codexHistory,'relay');
  }finally{release.resolve();}
  await done(first.id);
  const second=await learning.learnNow('second');
  assert.equal(second.codexHistory,'codex');await done(second.id);
  assert.equal(calls[1].codexHistory,'codex');
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,'learning.json'),'utf8')).reviews.map(item=>item.codexHistory),['relay','codex']);
});

test('legacy reviews without a history snapshot use the app preference at execution',async t=>{
  let preference='codex',busy=true;
  const {learning,add,done,calls}=await harness(t,null,{learningMode:null,isForegroundBusy:()=>busy,getRuntimeSettings:()=>({codexHistory:preference})});add();
  const review=await learning.learnNow('source-run');
  delete learning.reviews.find(item=>item.id===review.id).codexHistory;
  await learning.persist();
  preference='relay';busy=false;learning.kick(0);
  await done(review.id);
  assert.equal(calls[0].codexHistory,'relay');
  assert.equal(learning.getReview(review.id).codexHistory,'relay');
});

test('learning queue has no task-count cap and never drops unfinished reviews at the history boundary',async t=>{
  const {learning,add,options,directory,calls,stores}=await harness(t,null,{isForegroundBusy:()=>true});
  const ids=[];
  for(let index=0;index<LEARNING_LIMITS.reviews+7;index++)ids.push((await learning.scheduleAfterRun(add(`queued-${index}`))).id);
  assert.equal(calls.length,0);
  assert.equal(learning.status().queued,ids.length);
  const saved=JSON.parse(await readFile(path.join(directory,'learning.json'),'utf8'));
  assert.equal(saved.reviews.length,ids.length);
  assert.deepEqual(saved.reviews.map(item=>item.id),ids);
  // Simulate a separate process recovering the last durable snapshot, without starting paid work.
  const restored=await new LearningStore(options).init();stores.push(restored);
  assert.equal(restored.reviews.length,ids.length);
  assert.ok(restored.reviews.every(item=>item.status==='interrupted'));
  assert.deepEqual(restored.reviews.map(item=>item.id),ids);
  assert.equal(calls.length,0);
});

test('a real runtime reflection records a durable skill, evidence and usage, and later context exposes that actual skill',async t=>{
  const {learning,knowledge,add,done,calls,cwd,directory,options,stores}=await harness(t,async options=>{await call(options,proposal(options));await finish(options);return{output:'Saved a skill',usage:{totalTokens:17}};});
  const review=await learning.scheduleAfterRun(add());assert.equal(review.status,'queued');const completed=await done(review.id);
  assert.equal(completed.status,'completed',completed.error);assert.equal(completed.usage.totalTokens,17);assert.equal(calls.length,1);assert.equal(calls[0].model,'selected-fixture-model');assert.equal(calls[0].effort,'medium','review chooses a supported effort instead of assuming low exists');
  assert.deepEqual(calls[0].dynamicTools.map(tool=>tool.name),['relay_learn']);
  const lesson=learning.listLessons()[0];assert.equal(lesson.kind,'skill');assert.equal(lesson.confidence,'observed_once');assert.equal(lesson.evidence[0].runId,'source-run');assert.equal(lesson.evidence[0].quote,'Verified document list in browser.');
  const actual=knowledge.get(lesson.knowledgeId);assert.equal(actual.kind,'skill');assert.match(actual.content,/## Verification/);assert.match(actual.content,/not a measured performance improvement/);assert.equal(actual.provenance.nodeId,`learning-${review.id}`);
  const context=learning.getContext(cwd,{query:'export'});assert.equal(context.skills[0].knowledgeId,actual.id);assert.ok(JSON.stringify(context).length<=LEARNING_LIMITS.contextChars);
  // A completed review can still be flushing its final state; a restart closes that writer first.
  await learning.close();
  const restored=new LearningStore(options);stores.push(restored);await restored.init();
  assert.equal(restored.getReview(review.id).status,'completed');assert.deepEqual(restored.getReview(review.id).usage,completed.usage);assert.deepEqual(restored.listLessons()[0].evidence,lesson.evidence);
  assert.equal(restored.getContext(cwd).skills[0].knowledgeId,actual.id);assert.equal(JSON.parse(await readFile(path.join(directory,'learning.json'),'utf8')).lessons.length,1);await restored.close();
});

test('background reviews see a bounded direct knowledge catalog for this folder and global scope only',async t=>{
  const {learning,knowledge,add,done,cwd,otherCwd}=await harness(t,async options=>{
    assert.match(options.prompt,/Do not duplicate direct saved entries/);
    const catalog=JSON.parse(options.prompt.split('EXISTING SAVED KNOWLEDGE (metadata only)\n')[1].split('\n\nEXISTING LEARNING')[0]);
    assert.ok(JSON.stringify(catalog).length<=LEARNING_LIMITS.contextChars);
    assert.equal(catalog.memories.find(item=>item.id==='direct-workspace-memory').scope,'workspace');
    assert.equal(catalog.memories.find(item=>item.id==='direct-global-memory').scope,'global');
    assert.ok(catalog.skills.some(item=>item.id==='direct-workspace-skill'));
    assert.ok(!JSON.stringify(catalog).includes('other-folder-private'));
    assert.ok(!JSON.stringify(catalog).includes('deleted-private'));
    assert.ok(!JSON.stringify(catalog).includes('FULL_PROCEDURE_BODY_ONLY'));
    assert.ok(!JSON.stringify(catalog).includes('sk-fixturecatalogcredential123456789'));
    assert.ok(catalog.skills.length<41,'A full library does not inflate every review prompt.');
    assert.ok(catalog.skills.every(item=>Object.keys(item).sort().join(',')==='id,revision,scope,summary,title'));
    await finish(options);return{};
  });
  for(let index=0;index<40;index++)await knowledge.upsert({id:`filler-skill-${index}`,kind:'skill',title:`Filler ${index} `+'x'.repeat(100),summary:'Metadata only '.repeat(28),content:'FULL_PROCEDURE_BODY_ONLY '+String(index),cwd},{source:'agent',runId:'catalog-source',nodeId:'agent'});
  await knowledge.upsert({id:'direct-workspace-memory',kind:'memory',title:'Project convention',summary:'Use concise output in this folder.',content:'Keep this complete memory body out of the metadata catalog.',cwd},{source:'agent',runId:'source-run',nodeId:'agent'});
  await knowledge.upsert({id:'direct-global-memory',kind:'memory',title:'Shared preference',summary:'Prefer sourced status reports.',content:'A globally shared preference.',cwd:null});
  await knowledge.upsert({id:'direct-workspace-skill',kind:'skill',title:'Verify an export',summary:'api_key=sk-fixturecatalogcredential123456789',content:'FULL_PROCEDURE_BODY_ONLY verify export',cwd},{source:'agent',runId:'source-run',nodeId:'agent'});
  await knowledge.upsert({id:'other-folder-private',kind:'memory',title:'Other folder private',summary:'other-folder-private',content:'Other folder content.',cwd:otherCwd});
  await knowledge.upsert({id:'deleted-private',kind:'skill',title:'Deleted procedure',summary:'deleted-private',content:'Deleted content.',cwd});await knowledge.remove('deleted-private');
  const review=await learning.scheduleAfterRun(add());assert.equal((await done(review.id)).status,'no_changes');
});

test('identical foreground memory and skill saves remain single entries with their original audit history',async t=>{
  const memoryBody='Inspect the completed export before reporting completion.',skillBody=proposal(null).content;
  const {learning,knowledge,add,done,cwd}=await harness(t,async options=>{
    const skill=await call(options,proposal(options)),memory=await call(options,proposal(options,{kind:'strategy',key:'export-memory',title:'Inspect the export',content:memoryBody}));
    for(const result of [skill,memory]){const receipt=JSON.parse(result.contentItems[0].text);assert.equal(receipt.alreadySaved,true);assert.equal(receipt.recordedForCommit,false);}
    await finish(options);return{};
  });
  const first=await knowledge.upsert({id:'foreground-memory',kind:'memory',title:'Inspect the export',summary:'Check the completed export.',content:memoryBody,cwd},{source:'agent',runId:'source-run',nodeId:'agent'});
  const second=await knowledge.upsert({id:'foreground-skill',kind:'skill',title:'Verify an export',summary:'Check the exported artifact.',content:skillBody,cwd},{source:'agent',runId:'source-run',nodeId:'agent'});
  const review=await learning.scheduleAfterRun(add()),result=await done(review.id);
  assert.equal(result.status,'no_changes');assert.match(result.summary,/already exists in the library/);
  assert.deepEqual(new Set(result.existingKnowledgeIds),new Set([first.id,second.id]));assert.equal(result.acceptedProposalCount,0);assert.equal(result.appliedIds.length,0);
  assert.equal(learning.listLessons().length,0);assert.equal(knowledge.list().length,2);
  assert.deepEqual(knowledge.get(first.id),first);assert.deepEqual(knowledge.get(second.id),second);
  assert.ok(result.toolReceipts.filter(item=>item.action==='record').every(item=>item.success&&item.noop&&item.knowledgeId));
});

test('repeated reviews deduplicate, revisions accumulate distinct-run evidence, and deleted skills restore explicitly',async t=>{
  const {learning,knowledge,add,done,calls}=await harness(t,async options=>{await call(options,proposal(options));await finish(options);return{};});
  const first=await learning.scheduleAfterRun(add());await done(first.id);const duplicate=await learning.scheduleAfterRun(add());assert.equal(duplicate.id,first.id);assert.equal(calls.length,1);
  const forced=await learning.learnNow('source-run',{force:true});assert.equal((await done(forced.id)).status,'no_changes');let lesson=learning.listLessons()[0];assert.equal(lesson.revision,1);assert.equal(knowledge.get(lesson.knowledgeId).revision,1);
  const next=await learning.scheduleAfterRun(add('second-run'));await done(next.id);lesson=learning.listLessons()[0];assert.equal(lesson.revision,2);assert.equal(lesson.confidence,'supported_by_multiple_runs');assert.deepEqual(new Set(lesson.evidence.map(item=>item.runId)),new Set(['source-run','second-run']));assert.equal(lesson.history.length,1);
  await learning.removeLesson(lesson.id);assert.equal(learning.getContext(lesson.cwd).skills.length,0);assert.throws(()=>knowledge.get(lesson.knowledgeId),{status:404});
  const restored=await learning.restoreLesson(lesson.id,1);assert.equal(restored.status,'active');assert.equal(restored.revision,3);assert.equal(restored.confidence,'observed_once');assert.equal(learning.getContext(lesson.cwd).skills.length,1);
});

test('fabricated evidence, inferred user facts and a failed-run working skill are rejected before any write',async t=>{
  const {learning,knowledge,add,done}=await harness(t,async options=>{
    await assert.rejects(call(options,proposal(options,{evidence:[{id:'node_agent',quote:'Invented tool success not in the record'}]})),/exactly match/);
    await assert.rejects(call(options,proposal(options,{kind:'fact',key:'invented-personality',content:'The user is a developer.'})),/direct-user/);
    await assert.rejects(call(options,proposal(options)),/failed or negatively rated/i);
    await call(options,proposal(options,{kind:'strategy',key:'verify-on-failure',title:'Inspect before retrying',summary:'A failure needs observation before repeating actions.',content:'Inspect the current export state before retrying. The previous task failed; the working recovery is not yet known.'}));await finish(options);return{};
  });
  const review=await learning.scheduleAfterRun(add('failed-run',{status:'failed',output:'',error:'Export check failed'}));const result=await done(review.id);assert.equal(result.status,'completed',result.error);assert.equal(knowledge.list().length,1);assert.equal(learning.listLessons()[0].confidence,'tentative_after_failure');assert.equal(knowledge.list()[0].kind,'memory');
});

test('profile facts require exact direct-user statements and the profile callback receives trusted source text',async t=>{
  const profile=[];
  const {learning,add,done}=await harness(t,async options=>{
    await call(options,proposal(options,{kind:'fact',key:'concise-output',title:'Concise output',summary:'The user requested concise output for this working folder.',content:'Use concise output for this working folder.',evidence:[{id:'task',quote:'Please use concise output'}]}));await finish(options);return{};
  },{onProfileFact:async value=>profile.push(value)});
  const review=await learning.scheduleAfterRun(add());await done(review.id);assert.equal(profile.length,1);assert.equal(profile[0].sourceQuote,'Please use concise output');assert.match(profile[0].trustedUserText,/Please use concise output/);assert.equal(profile[0].sourceRunId,'source-run');assert.equal(learning.listLessons()[0].profileUpdated,true);
});

test('automatic fact and skill changes apply without approval, retain their source and model, and can be undone after use',async t=>{
  const profile=[],providerModel='openrouter::fixture/model';
  const {learning,knowledge,add,done,calls,cwd,runtime}=await harness(t,async(options,index)=>{
    assert.equal(options.model,providerModel);
    assert.match(options.prompt,/Routine task completion, one-off requests/);
    if(index===1)await call(options,proposal(options,{kind:'fact',key:'concise-output',title:'Use concise output in this folder',summary:'The user requested concise output in this working folder.',content:'Use concise output in this working folder.',evidence:[{id:'task',quote:'Please use concise output'}]}));
    await call(options,proposal(options,index===1?{}:{summary:'Read both the export and the requested appendix.',content:'Read the export and its appendix and compare both with the requested result.'}));
    await finish(options);return{};
  },{learningMode:null,onProfileFact:async value=>profile.push(value)});
  runtime.status=()=>({defaultModel:providerModel,models:[{model:providerModel,supportedReasoningEfforts:['medium']}]});
  const observed=id=>add(id,{events:[{data:{type:'thread',model:providerModel}}]});
  const first=await learning.scheduleAfterRun(observed('provider-source-a'));
  assert.equal((await done(first.id)).status,'completed');
  assert.equal(learning.listLessons().length,2);assert.equal(knowledge.list().length,2);assert.equal(profile.length,1);
  const skill=learning.listLessons().find(item=>item.kind==='skill'),fact=learning.listLessons().find(item=>item.kind==='fact');
  assert.deepEqual(skill.provenance,{source:'learning',action:'created',reviewId:first.id,runId:'provider-source-a',trigger:'automatic',model:providerModel,at:skill.provenance.at});
  assert.equal(fact.evidence[0].quote,'Please use concise output');assert.equal(fact.profileUpdated,true);
  assert.equal(knowledge.get(skill.knowledgeId).provenance.nodeId,`learning-${first.id}`);
  const next=learning.getContext(cwd,{query:'export concise'});
  assert.equal(next.skills[0].knowledgeId,skill.knowledgeId);assert.equal(next.facts[0].id,fact.id);
  assert.deepEqual(next.skills[0].evidenceRunIds,['provider-source-a']);
  const second=await learning.scheduleAfterRun(observed('provider-source-b'));
  assert.equal((await done(second.id)).status,'completed');assert.equal(calls.length,2);
  const updated=learning.listLessons().find(item=>item.id===skill.id);
  assert.equal(updated.revision,2);assert.equal(updated.provenance.action,'updated');assert.equal(updated.provenance.reviewId,second.id);
  assert.equal(updated.history[0].content,skill.content);assert.equal(updated.history[0].provenance.reviewId,first.id);
  assert.match(updated.content,/appendix/);
  const undone=await learning.restoreLesson(skill.id,1);
  assert.equal(undone.content,skill.content);assert.equal(knowledge.get(skill.knowledgeId).content,skill.content);
  assert.equal(undone.revision,3);assert.equal(undone.provenance.action,'restored');assert.equal(undone.provenance.restoredFrom,1);
  assert.equal(undone.history.at(-1).content,updated.content);
  await learning.removeLesson(fact.id);
  assert.equal(learning.getContext(cwd).facts.length,0,'Undoing a memory removes its future learned guidance.');
});

test('automatic reviews preserve user corrections and keep rejected replacement receipts',async t=>{
  const {learning,knowledge,add,done}=await harness(t,async(options,index)=>{
    if(index===1){await call(options,proposal(options));await finish(options);return{};}
    const existing=JSON.parse(options.prompt.split('EXISTING LEARNING\n')[1].split('\n\nOBSERVED RUN EVIDENCE')[0]);
    assert.equal(existing[0].userEdited,true);
    await assert.rejects(call(options,proposal(options,{content:'Discard the user correction and run the old export routine.'})),/edited by the user/);
    return{};
  });
  const first=await learning.scheduleAfterRun(add());await done(first.id);
  const original=learning.listLessons()[0],correction='User correction: verify this export against the signed reference before using it.';
  const edited=await knowledge.upsert({...knowledge.get(original.knowledgeId),content:correction},{source:'user'});
  await learning.recordKnowledgeChange(edited);
  const second=await learning.scheduleAfterRun(add('after-user-correction'));
  const rejected=await done(second.id);
  assert.equal(rejected.status,'failed');assert.match(rejected.toolReceipts[0].error,/edited by the user/);
  const kept=learning.listLessons()[0];assert.equal(kept.content,correction);assert.equal(kept.revision,2);
  assert.equal(kept.provenance.source,'user');assert.equal(kept.provenance.action,'edited');
  assert.equal(kept.history[0].content,original.content);assert.equal(knowledge.get(kept.knowledgeId).content,correction);
});

test('undoing or restoring learned facts also reverses the exact USER.md entry and keeps both audits',async t=>{
  const {learning,knowledge,add,done,directory,cwd}=await harness(t,async(options,index)=>{
    await call(options,proposal(options,{kind:'fact',key:'communication-output',title:'Output preference',summary:index===1?'Use concise output.':'Use concise output with source links.',content:index===1?'Use concise output.':'Use concise output and include source links.',evidence:[{id:'task',quote:index===1?'use concise output':'use concise output and include source links'}]}));
    await finish(options);return{};
  },{learningMode:null});
  const identity=await new IdentityStore({dataDir:directory}).init();t.after(()=>identity.close());
  learning.onProfileFact=value=>identity.recordFact(value);learning.onProfileFactUndo=value=>identity.removeFact(value);
  const input='For future tasks, use concise output and include source links.';
  const first=await learning.scheduleAfterRun(add('profile-one',{input}));await done(first.id);
  const initial=learning.listLessons()[0],firstProfile=await identity.read('user');
  assert.match(firstProfile.content,/Use concise output\./);assert.equal(initial.profileEntry.sourceLearningId,initial.id);
  const second=await learning.scheduleAfterRun(add('profile-two',{input}));assert.equal((await done(second.id)).status,'completed');
  let current=learning.listLessons()[0];const secondKnowledge=knowledge.get(current.knowledgeId);
  assert.equal(current.profileUpdated,true);assert.match((await identity.read('user')).content,/Use concise output with source links\./);
  assert.ok(!(await identity.read('user')).content.includes('- Use concise output.\n'));
  await learning.restoreLesson(current.id,1);
  assert.match((await identity.read('user')).content,/Use concise output\./);assert.ok(!(await identity.read('user')).content.includes('with source links.'));
  // The Library's own undo reaches this same path after it restores a stored knowledge revision.
  const restoredKnowledge=await knowledge.upsert({...secondKnowledge},{source:'user',reason:'Undo library change'});
  await learning.recordKnowledgeChange(restoredKnowledge);
  current=learning.listLessons()[0];assert.equal(current.provenance.action,'restored');assert.equal(current.profileUpdated,true);
  assert.match((await identity.read('user')).content,/Use concise output with source links\./);
  await learning.removeLesson(current.id);
  assert.equal(learning.getContext(cwd).facts.length,0);assert.ok(!(await identity.read('user')).content.includes('Use concise output'));
  await learning.restoreLesson(current.id,1);
  assert.equal(learning.getContext(cwd).facts.length,1);assert.match((await identity.read('user')).content,/Use concise output\./);
  const beforeDeletion=knowledge.get(current.knowledgeId);await knowledge.remove(current.knowledgeId);await learning.recordKnowledgeDeletion(current.knowledgeId,beforeDeletion);
  assert.ok(!(await identity.read('user')).content.includes('Use concise output'));assert.equal(learning.getContext(cwd).facts.length,0);
  const history=await identity.versions('user');assert.ok(history.length>=7);assert.ok(history.some(item=>item.provenance.reason==='Undid an automatically learned profile fact.'));
  assert.match((await identity.readVersion('user',firstProfile.revision)).content,/Use concise output\./);
});

test('credentials hidden in skill metadata and mixed tool citations for a user fact cannot be committed',async t=>{
  const {learning,knowledge,add,done}=await harness(t,async options=>{
    for(const field of ['whenToUse','verification'])await assert.rejects(call(options,proposal(options,{[field]:'api_key=sk-fixturecredentialvalue1234567890'})),/Credentials and secrets/);
    await assert.rejects(call(options,proposal(options,{kind:'fact',key:'mixed-fact',evidence:[{id:'task',quote:'Please use concise output'},{id:'node_agent',quote:'Verified document list in browser.'}]})),/direct-user/);
    await call(options,proposal(options,{kind:'strategy',key:'inspect-export',content:'Read the exported file before reporting that the export is complete.'}));
    await finish(options);return{};
  });
  const review=await learning.scheduleAfterRun(add()),saved=await done(review.id);
  assert.equal(saved.status,'completed');assert.equal(saved.appliedIds.length,1);assert.equal(knowledge.list().length,1);
  assert.deepEqual(saved.toolReceipts.slice(0,3).map(item=>item.success),[false,false,false]);
  assert.ok(!JSON.stringify(learning.snapshot()).includes('sk-fixturecredentialvalue1234567890'));
});

test('feedback triggers another actual review and negative feedback keeps its strategy tentative',async t=>{
  const {learning,add,done,calls}=await harness(t,async options=>{const pack=evidence(options),feedback=pack.entries.find(item=>item.kind==='user_feedback');await call(options,proposal(options,{kind:'strategy',key:'check-incomplete-export',content:'Inspect the artifact before declaring completion; verify every requested section.',evidence:[{id:feedback?.id||'node_agent',quote:feedback?.text||'Verified document list in browser.'}]}));await finish(options);return{};});
  const first=await learning.scheduleAfterRun(add());await done(first.id);await learning.feedback('source-run','bad','The export omitted the requested appendix.');const latest=learning.listReviews()[0];assert.notEqual(latest.id,first.id);assert.equal((await done(latest.id)).status,'completed');assert.equal(calls.length,2);assert.match(calls[1].prompt,/The export omitted the requested appendix/);assert.equal(learning.listLessons()[0].confidence,'tentative_after_negative_feedback');
});

test('cancellation discards uncommitted model proposals and rejects late tool callbacks',async t=>{
  const entered=deferred();let savedOptions;
  const {learning,knowledge,add,done}=await harness(t,async options=>{savedOptions=options;await call(options,proposal(options));entered.resolve();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Cancelled fixture review'),{name:'AbortError'})),{once:true}));});
  const review=await learning.scheduleAfterRun(add());await entered.promise;await learning.cancelBackground('User stopped this review.');assert.equal((await done(review.id)).status,'cancelled');assert.equal(knowledge.list().length,0);assert.equal(learning.listLessons().length,0);await assert.rejects(call(savedOptions,proposal(savedOptions)),{name:'AbortError'});
});

test('foreground preemption waits for runtime acknowledgement and automatically resumes the queued review after foreground work',async t=>{
  let busy=false;const entered=deferred(),release=deferred();
  const {learning,add,done,calls}=await harness(t,async(options,index)=>{if(index===1){entered.resolve();await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));await release.promise;throw Object.assign(new Error('Preempted'),{name:'AbortError'});}await finish(options);return{};},{isForegroundBusy:()=>busy});
  const review=await learning.scheduleAfterRun(add());await entered.promise;busy=true;let stopped=false;const stopping=learning.cancelBackground().then(()=>{stopped=true;});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stopped,false);release.resolve();await stopping;assert.equal(learning.getReview(review.id).status,'queued');assert.equal(calls.length,1);
  busy=false;learning.kick(0);assert.equal((await done(review.id)).status,'no_changes');assert.equal(calls.length,2);
});

test('a foreground task and shutdown wait for an already-started durable commit without half-cancelling it',async t=>{
  const entered=deferred(),release=deferred();
  const {learning,knowledge,add,done}=await harness(t,async options=>{await call(options,proposal(options));await finish(options);return{};});
  const upsert=knowledge.upsert.bind(knowledge);knowledge.upsert=async(...args)=>{entered.resolve();await release.promise;return upsert(...args);};
  const review=await learning.scheduleAfterRun(add());await entered.promise;assert.equal(learning.getReview(review.id).status,'committing');let stopped=false;const stopping=learning.cancelBackground().then(()=>{stopped=true;});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stopped,false);release.resolve();await stopping;assert.equal((await done(review.id)).status,'completed');assert.equal(knowledge.list().length,1);await learning.close();assert.equal(learning.status().healthy,true);
});

test('manual and off modes are durable, context is workspace scoped, and free text alone never changes learning',async t=>{
  const {learning,add,done,calls,otherCwd,cwd,options,knowledge}=await harness(t,async()=>({output:'I learned many things, but called no recording tool.'}));
  await learning.updateSettings({mode:'manual'});assert.equal(await learning.scheduleAfterRun(add()),null);assert.equal(calls.length,0);const review=await learning.learnNow('source-run');assert.equal((await done(review.id)).status,'failed');assert.equal(knowledge.list().length,0);
  await learning.updateSettings({mode:'off'});await assert.rejects(learning.learnNow('source-run'),/Learning is off/);assert.deepEqual(learning.getContext(cwd),{lessons:[],skills:[],facts:[],truncated:false});const restored=await new LearningStore(options).init();assert.equal(restored.settings.mode,'off');assert.equal(restored.getContext(otherCwd).skills.length,0);await restored.close();
});

test('user edits remain authoritative, deletions are not automatically resurrected, and Restore recovers an inspectable revision',async t=>{
  const {learning,knowledge,add,done,cwd,otherCwd}=await harness(t,async options=>{await call(options,proposal(options));await finish(options);return{};});
  const review=await learning.scheduleAfterRun(add());await done(review.id);const lesson=learning.listLessons()[0];await knowledge.upsert({...knowledge.get(lesson.knowledgeId),content:'User-edited procedure with a specific verification rule.'},{source:'user'});assert.match(learning.listLessons()[0].content,/User-edited procedure/);assert.equal(learning.listLessons()[0].userEdited,true);assert.equal(learning.getContext(otherCwd).skills.length,0);assert.equal(learning.getContext(cwd).skills.length,1);
  await knowledge.remove(lesson.knowledgeId);assert.equal(learning.getContext(cwd).skills.length,0);const again=await learning.learnNow('source-run',{force:true});assert.equal((await done(again.id)).status,'failed');assert.equal(knowledge.list().length,0);await learning.restoreLesson(lesson.id);assert.equal(knowledge.list().length,1);
});

test('evidence packs are bounded, drop hidden reasoning and screenshots, and redact obvious credential material',()=>{
  const rawSecret='sk-proj-FAKEPUBLICATIONTEST0123456789ABCDEF';const run=runFixture(path.resolve('fixture-workspace'),'large',{input:`Task apiKey=${rawSecret}\n${'x'.repeat(50000)}`,output:'y'.repeat(50000),events:[{data:{type:'reasoning',text:'HIDDEN_PRIVATE_REASONING'}},{data:{type:'item',item:{type:'dynamicToolCall',imageUrl:'data:image/png;base64,PRIVATE_PIXELS'}}},...Array.from({length:100},(_,index)=>({data:{type:'desktop',action:`action${index}`,message:'z'.repeat(3000)}}))]});
  const pack=buildLearningEvidence(run);assert.ok(pack.entries.reduce((sum,item)=>sum+item.text.length,0)<=LEARNING_LIMITS.evidenceChars);const wire=JSON.stringify(pack);assert.ok(!wire.includes(rawSecret));assert.ok(!wire.includes('HIDDEN_PRIVATE_REASONING'));assert.ok(!wire.includes('PRIVATE_PIXELS'));assert.equal(pack.truncated,true);
});

test('restart recovers confirmed knowledge writes from an interrupted commit and preserves corrupt snapshots through backup recovery',async t=>{
  const {learning,knowledge,add,done,directory,options}=await harness(t,async options=>{await call(options,proposal(options));await finish(options);return{};});
  const review=await learning.scheduleAfterRun(add());await done(review.id);await learning.close();const file=path.join(directory,'learning.json'),data=JSON.parse(await readFile(file,'utf8'));data.reviews[0].status='committing';data.reviews[0].pendingChanges=[data.lessons[0]];data.lessons=[];await writeFile(file,JSON.stringify(data));const recovered=await new LearningStore(options).init();assert.equal(recovered.listLessons().length,1);assert.equal(recovered.getReview(review.id).status,'interrupted');assert.equal(knowledge.list().length,1);await recovered.close();
  await writeFile(file,'{ broken snapshot');const backup=await new LearningStore(options).init();assert.equal(backup.recovered,true);assert.ok((await readdir(directory)).some(name=>name.startsWith('learning.json.corrupt-')));await backup.close();
});

test('explicit edits become restorable learning revisions and turning learning off cancels queued manual work',async t=>{
  const {learning,knowledge,add,done,calls}=await harness(t,async options=>{await call(options,proposal(options));await finish(options);return{};});
  const review=await learning.scheduleAfterRun(add());await done(review.id);let lesson=learning.listLessons()[0];const original=lesson.content;
  const edited=await knowledge.upsert({...knowledge.get(lesson.knowledgeId),content:'User procedure: inspect the fixture and verify the requested contents.'},{source:'user'});
  await learning.recordKnowledgeChange(edited);lesson=learning.listLessons()[0];assert.equal(lesson.userEdited,true);assert.equal(lesson.revision,2);assert.equal(lesson.history[0].content,original);
  await learning.restoreLesson(lesson.id,1);assert.equal(learning.listLessons()[0].content,original);assert.equal(knowledge.get(lesson.knowledgeId).content,original);
  await learning.updateSettings({mode:'manual'});learning.isForegroundBusy=()=>true;const queued=await learning.learnNow('source-run',{force:true});assert.equal(queued.status,'queued');await learning.updateSettings({mode:'off'});assert.equal(learning.getReview(queued.id).status,'cancelled');assert.equal(learning.status().queued,0);assert.equal(calls.length,1);
});

test('shutdown drains an admitted Restore that is waiting on its actual knowledge write',async t=>{
  const {learning,knowledge,add,done,directory}=await harness(t,async options=>{await call(options,proposal(options));await finish(options);return{};});
  const review=await learning.scheduleAfterRun(add());await done(review.id);const lesson=learning.listLessons()[0];await learning.removeLesson(lesson.id);
  const entered=deferred(),release=deferred(),upsert=knowledge.upsert.bind(knowledge);knowledge.upsert=async(...args)=>{entered.resolve();await release.promise;return upsert(...args);};
  const restoring=learning.restoreLesson(lesson.id);await entered.promise;let stopped=false;const closing=learning.close().then(()=>{stopped=true;});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stopped,false,'close retains the admitted edit until its real save finishes');release.resolve();await restoring;await closing;
  const disk=JSON.parse(await readFile(path.join(directory,'learning.json'),'utf8'));assert.equal(disk.lessons[0].status,'active');assert.equal(disk.lessons[0].knowledgeRevision,knowledge.get(lesson.knowledgeId).revision);assert.equal(learning.operations.size,0);
});

test('a rejected knowledge restore cannot publish an active lesson or advance its revision',async t=>{
  const {learning,knowledge,add,done,cwd}=await harness(t,async options=>{await call(options,proposal(options));await finish(options);return{};});
  const review=await learning.scheduleAfterRun(add());await done(review.id);const lesson=learning.listLessons()[0];await learning.removeLesson(lesson.id);const before=learning.listLessons()[0];
  knowledge.upsert=async()=>{throw new Error('Fixture disk unavailable');};await assert.rejects(learning.restoreLesson(lesson.id),/disk unavailable/);
  const after=learning.listLessons()[0];assert.equal(after.status,'deleted');assert.equal(after.revision,before.revision);assert.deepEqual(after.history,before.history);assert.equal(learning.getContext(cwd).skills.length,0);
});

test('review diagnostics retain bounded real tool rejections and conversation IDs without trusting generated save claims',async t=>{
  const {learning,knowledge,add,done,directory}=await harness(t,async(options,index)=>{
    options.onEvent({type:'thread',threadId:`review-thread-${index}`});options.onEvent({type:'turn',turnId:`review-turn-${index}`});options.onEvent({type:'reasoning',text:'PRIVATE_REVIEW_REASONING'});
    if(index===1)await assert.rejects(call(options,proposal(options,{evidence:[{id:'missing-source',quote:'Fabricated recorded verification.'}]})),/exactly match/);
    if(index===3)await call(options,proposal(options));
    if(index===1)await assert.rejects(call(options,{action:'finish',summaryOfReview:'Recorded two useful skills and improved the profile.'}),/No record was accepted/);else await call(options,{action:'finish',summaryOfReview:'Recorded two useful skills and improved the profile.'});return{threadId:`result-thread-${index}`,turnId:`result-turn-${index}`,usage:{totalTokens:10}};
  });
  const rejected=await learning.scheduleAfterRun(add());const failed=await done(rejected.id);assert.equal(failed.status,'failed');assert.equal(failed.acceptedProposalCount,0);assert.match(failed.summary,/No learning items were saved/);assert.equal(failed.toolReceipts[0].success,false);assert.match(failed.toolReceipts[0].error,/exactly match/);assert.equal(failed.threadId,'result-thread-1');assert.equal(failed.turnId,'result-turn-1');assert.equal(knowledge.list().length,0);
  const empty=await learning.scheduleAfterRun(add('no-proposal-run'));const noChanges=await done(empty.id);assert.equal(noChanges.status,'no_changes');assert.match(noChanges.summary,/No learning items were saved/);assert.ok(!noChanges.summary.includes('Recorded two'));assert.equal(noChanges.modelSummary,'Recorded two useful skills and improved the profile.');
  const accepted=await learning.scheduleAfterRun(add('accepted-run'));const saved=await done(accepted.id);assert.equal(saved.status,'completed');assert.equal(saved.acceptedProposalCount,1);assert.equal(saved.appliedIds.length,1);assert.match(saved.summary,/1 evidence-backed item was saved/);assert.equal(saved.toolReceipts[0].success,true);assert.ok(saved.toolReceipts[0].lessonId);
  assert.ok(!(await readFile(path.join(directory,'learning.json'),'utf8')).includes('PRIVATE_REVIEW_REASONING'));
});

test('the live omitted-summary sequence records fact and skill using their bounded titles instead of losing the whole review',async t=>{
  const {learning,knowledge,add,done}=await harness(t,async options=>{
    assert.match(options.prompt,/fix rejected records before finishing/i);
    const fact=proposal(options,{kind:'fact',key:'concise-output',title:'Use concise output in this folder',content:'The user requested concise output in this working folder.',evidence:[{id:'task',quote:'Please use concise output'}]});delete fact.summary;
    const skill=proposal(options);delete skill.summary;await call(options,fact);await call(options,skill);await finish(options);return{};
  });
  const review=await learning.scheduleAfterRun(add()),result=await done(review.id);assert.equal(result.status,'completed',result.error);assert.equal(result.appliedIds.length,2);assert.equal(result.acceptedProposalCount,2);
  for(const lesson of learning.listLessons())assert.equal(lesson.summary,lesson.title);assert.equal(knowledge.list().length,2);assert.ok(result.toolReceipts.slice(0,2).every(item=>item.success&&!item.argumentKeys.includes('summary')));
});

test('a premature finish after rejected records stays open so corrected records can commit in the same real review turn',async t=>{
  const {learning,knowledge,add,done}=await harness(t,async options=>{
    await assert.rejects(call(options,proposal(options,{summary:'x'.repeat(401)})),/Summary/);
    await assert.rejects(call(options,{action:'finish',summaryOfReview:'Recorded the procedure.'}),/leaves the review open/);
    const corrected=proposal(options);delete corrected.summary;await call(options,corrected);await finish(options);return{threadId:'repaired-review-thread'};
  });
  const review=await learning.scheduleAfterRun(add()),result=await done(review.id);assert.equal(result.status,'completed',result.error);assert.equal(result.threadId,'repaired-review-thread');assert.equal(result.appliedIds.length,1);assert.equal(knowledge.list().length,1);assert.deepEqual(result.toolReceipts.map(item=>item.success),[false,false,true,true]);assert.equal(result.toolReceipts[1].action,'finish');assert.match(result.summary,/1 evidence-backed item was saved/);
});
