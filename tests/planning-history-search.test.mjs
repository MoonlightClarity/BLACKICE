import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {KnowledgeStore,createKnowledgeToolHandler} from '../lib/knowledge.mjs';

const cwd=path.join(tmpdir(),'blackice-history-natural-query-fixture');
const run=(id,input,extra={})=>({id,cwd,input,workflowName:'Saved work',output:'',status:'completed',createdAt:'2026-10-31T00:00:00.000Z',nodes:{},...extra});
const handlerFor=(runs,store={})=>createKnowledgeToolHandler({store,cwd,runId:'current-turn',getRuns:async()=>runs});
const invoke=async(handler,args,name='relay_history')=>{
  const response=await handler({name,arguments:args});
  assert.equal(response.success,true);
  const result=JSON.parse(response.contentItems[0].text);
  return {response,result};
};

test('history normalizes Unicode punctuation and accents without changing the stored record',async()=>{
  const saved=run('normalized-record',"Morgan O'Neill — Résumé café project."),before=structuredClone(saved);
  const {result}=await invoke(handlerFor([saved]),{action:'search',query:'Morgan O’Neill resume cafe project'});
  assert.equal(result.totalMatches,1);
  assert.equal(result.partialMatch,false);
  assert.deepEqual(result.results[0].matchedTerms,['morgan',"o'neill",'resume','cafe','project']);
  assert.deepEqual(result.results[0].missingTerms,[]);
  assert.match(result.results[0].input,/O'Neill — Résumé café/);
  assert.deepEqual(saved,before);
});

test('verbose history queries fall back to scoped partial matches ranked by term coverage',async()=>{
  const query='Morgan O’Neill resume cafe project requirements timeline archive';
  const relevant=run('relevant-record',"Morgan O'Neill reviewed the résumé for the café project.");
  const broad=run('broad-record','Other administrative work.',{workflowName:'Requirements timeline archive'});
  const exactElsewhere=run('other-workspace',query,{cwd:path.join(tmpdir(),'blackice-other-workspace')});
  const current=run('current-turn',query);
  const {result}=await invoke(handlerFor([broad,run('unrelated','Weather observations.'),exactElsewhere,current,relevant]),{action:'search',query});
  assert.equal(result.partialMatch,true);
  assert.equal(result.totalMatches,2);
  assert.deepEqual(result.results.map(item=>item.id),['relevant-record','broad-record'],'more covered terms outrank fewer terms in a title');
  assert.deepEqual(result.results[0].matchedTerms,['morgan',"o'neill",'resume','cafe','project']);
  assert.deepEqual(result.results[0].missingTerms,['requirements','timeline','archive']);
  assert.equal(result.results[0].partialMatch,true);
  assert.ok(result.results.every(item=>item.missingTerms.length>0));
});

test('full history matches take precedence while partial alternatives stay explicitly visible',async()=>{
  const {result}=await invoke(handlerFor([run('partial','Cafe notes.'),run('full','Cafe project notes.')]),{action:'search',query:'cafe project'});
  assert.deepEqual(result.results.map(item=>item.id),['full','partial']);
  assert.equal(result.results[0].partialMatch,false);
  assert.equal(result.results[1].partialMatch,true);
  assert.deepEqual(result.results[1].missingTerms,['project']);
});

test('memory and skill searches retain their strict all-term behavior',async t=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-strict-knowledge-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=await new KnowledgeStore({dataDir}).init();
  for(const kind of ['memory','skill'])await store.upsert({kind,cwd,title:"Morgan O'Neill project",content:'The recorded project brief.'});
  const handler=handlerFor([],store);
  for(const name of ['relay_memory','relay_skills']){
    assert.equal((await invoke(handler,{action:'search',query:"Morgan O'Neill"},name)).result.entries.length,1);
    assert.equal((await invoke(handler,{action:'search',query:"Morgan O'Neill missing timeline"},name)).result.entries.length,0);
  }
});

test('a natural query can discover and focus receipt-only evidence with explicit partial-match terms',async()=>{
  const saved=run('receipt-only','Continue the record task.',{status:'cancelled',events:[{type:'agent.event',runId:'receipt-only',nodeId:'worker',at:'2026-10-31T00:01:00.000Z',data:{type:'item',stage:'completed',threadId:'original-thread',turnId:'original-turn',item:{type:'dynamicToolCall',id:'observed-record',tool:'relay_browser',status:'completed',success:true,contentItems:[{type:'inputText',text:"Morgan O'Neill: the café project record is available."}]}}}]}),handler=handlerFor([saved]);
  const query='Morgan O’Neill cafe project requirements timeline';
  const search=(await invoke(handler,{action:'search',query})).result;
  assert.equal(search.totalMatches,1);
  assert.equal(search.partialMatch,true);
  assert.equal(search.results[0].matchedReceipt.callId,'observed-record');
  assert.deepEqual(search.results[0].missingTerms,['requirements','timeline']);
  const read=(await invoke(handler,{action:'read',id:saved.id,query})).result;
  assert.equal(read.run.toolReceipts.length,1);
  assert.match(read.run.toolReceipts[0].text,/café project record/);
  assert.equal(read.run.toolReceipts[0].partialMatch,true);
  assert.deepEqual(read.run.toolReceipts[0].missingTerms,['requirements','timeline']);
});

test('continuations recover literal prior user requests and separately labelled saved task goals',async()=>{
  const original="Publish Morgan O'Neill's approved café project update using the saved brief.";
  const saved=run('continuation','Continue through the remaining work.',{taskId:'original-task',priorUserRequests:[{key:'original-turn',source:'user-request',runId:'original-turn',at:'2026-10-30T12:00:00.000Z',messageIndex:-1,text:original}],taskState:{taskId:'original-task',revision:8,goal:'Publish the prepared café project update and record its actual destination.'}}),before=structuredClone(saved),handler=handlerFor([saved]);
  const search=(await invoke(handler,{action:'search',query:'Morgan cafe publish update timeline'})).result;
  assert.equal(search.totalMatches,1);
  assert.equal(search.results[0].matchedUserRequest.runId,'original-turn');
  assert.equal(search.results[0].matchedUserRequest.source,'user-request');
  const {result,response}=await invoke(handler,{action:'read',id:saved.id});
  assert.equal(result.run.priorUserRequests.length,1);
  assert.equal(result.run.priorUserRequests[0].text,original);
  assert.equal(result.run.priorUserRequests[0].runId,'original-turn');
  assert.equal(result.run.priorUserRequests[0].at,'2026-10-30T12:00:00.000Z');
  assert.equal(result.run.taskGoal.text,saved.taskState.goal);
  assert.equal(result.run.taskGoal.source,'task-state');
  assert.equal(result.run.taskGoal.taskId,'original-task');
  assert.equal(result.run.taskGoal.revision,8);
  assert.ok(response.contentItems[0].text.length<=43000);
  assert.deepEqual(saved,before);
});

test('history preserves changed user directions in chronological order without promoting a task goal to permission',async()=>{
  const earlier={source:'user-request',runId:'research-turn',at:'2026-10-29T12:00:00.000Z',text:'Research the project update only. Do not publish it.'};
  const later={source:'user-request',runId:'publish-turn',at:'2026-10-30T12:00:00.000Z',text:'Publish the prepared project update now.'};
  const saved=run('changed-directions','Continue.',{priorUserRequests:[later,earlier],taskState:{taskId:'saved-task',revision:5,goal:'Research the project update only.'}});
  const {result}=await invoke(handlerFor([saved]),{action:'read',id:saved.id});
  assert.deepEqual(result.run.priorUserRequests.map(item=>item.text),[earlier.text,later.text]);
  assert.ok(result.run.priorUserRequests.every(item=>item.source==='user-request'));
  assert.equal(result.run.taskGoal.source,'task-state');
  assert.equal(result.run.taskGoal.text,saved.taskState.goal);
  const goalOnly=run('goal-only','Continue.',{taskState:{taskId:'separate-task',revision:2,goal:'Review harbor-marker-23.'}}),handler=handlerFor([goalOnly]);
  const search=(await invoke(handler,{action:'search',query:'harbor-marker-23'})).result;
  assert.equal(search.totalMatches,1);
  assert.equal(search.results[0].matchedTaskGoal.source,'task-state');
  const read=(await invoke(handler,{action:'read',id:goalOnly.id})).result;
  assert.deepEqual(read.run.priorUserRequests,[],'a saved task goal does not create a user-authored direction');
});

test('older full query matches cannot crowd out a newer related user direction',async()=>{
  const query='Morgan cafe project publish timeline requirements';
  const oldText='Research the cafe project for Morgan. The publish timeline and requirements are for research only. Do not publish.';
  const older=Array.from({length:11},(_,index)=>run('older-'+index,oldText,{createdAt:'2026-10-29T12:00:00.000Z'}));
  const direction={source:'user-request',runId:'newer-original',at:'2026-10-30T12:00:00.000Z',text:'Publish the prepared Morgan cafe project update now.'};
  const newer=run('newer-continuation','Continue.',{createdAt:'2026-10-30T13:00:00.000Z',priorUserRequests:[direction]});
  const {result}=await invoke(handlerFor([...older,newer]),{action:'search',query,limit:3});
  assert.equal(result.results.length,3);
  assert.equal(result.truncated,true);
  assert.equal(result.results[0].partialMatch,false);
  assert.match(result.results[0].input,/Do not publish/);
  const related=result.results.find(item=>item.id===newer.id);
  assert.ok(related,'a newer related instruction remains discoverable when full matches fill the result limit');
  assert.equal(related.partialMatch,true);
  assert.equal(related.createdAt,newer.createdAt);
  assert.equal(related.matchedUserRequest.at,direction.at);
  assert.equal(related.matchedUserRequest.runId,direction.runId);
  assert.match(related.excerpt,/Publish the prepared Morgan cafe project update now/);
});
