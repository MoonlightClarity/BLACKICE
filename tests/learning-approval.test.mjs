import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {KnowledgeStore} from '../lib/knowledge.mjs';
import {LearningStore} from '../lib/learning.mjs';
const wait=async check=>{for(let i=0;i<300;i++){const value=check();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('review timeout');};
test('real review stages all changes; rejection never activates, approval reconciles and preserves scope through restore',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'learning-approval-')),cwd=path.join(dataDir,'work');
 const knowledge=await new KnowledgeStore({dataDir}).init();
 const run={id:'task-a',cwd,status:'completed',settled:true,input:'Use short paragraphs for this task.',nodes:{},events:[],workflow:{nodes:[]}};
 const runtime={status:()=>({defaultModel:'test'}),runAgent:async options=>{
   for(const [kind,key] of [['fact','paragraphs'],['skill','method']])await options.onToolCall({name:'relay_learn',arguments:{action:'record',kind,key,title:key,content:'Use short paragraphs.',whenToUse:'Only this task.',evidence:[{id:'task',quote:run.input}]}});
   await options.onToolCall({name:'relay_learn',arguments:{action:'finish',summaryOfReview:'Two candidates.'}});return {};
 }};
 const learning=await new LearningStore({dataDir,runtime,knowledge,getRun:()=>run,delayMs:0}).init();
 t.after(async()=>{await learning.close();await rm(dataDir,{recursive:true,force:true});});
 const review=await learning.learnNow(run.id);await wait(()=>learning.getReview(review.id).status==='pending_approval');
 assert.equal(knowledge.list().length,0);assert.equal(learning.listLessons().length,0);assert.equal(knowledge.listApprovals().length,2);
 const [first,second]=knowledge.listApprovals();await learning.recordApprovalDecision(await knowledge.decideApproval(first.id,{decision:'reject'}));assert.equal(learning.listLessons().length,0);
 await learning.recordApprovalDecision(await knowledge.decideApproval(second.id,{decision:'approve'}));assert.equal(learning.listLessons().length,1);assert.equal(learning.getReview(review.id).status,'completed');
 const lesson=learning.listLessons()[0];assert.equal(learning.getContext(cwd,{runIds:['task-b']}).skills.length,0);
 await learning.removeLesson(lesson.id);await learning.restoreLesson(lesson.id);
 assert.equal(learning.listLessons()[0].knowledgeProvenance.source,'agent');assert.equal(learning.getContext(cwd,{runIds:['task-b']}).skills.length,0);
});

test('restart reconciles approved and rejected proposals without inventing applied changes',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'learning-approval-')),cwd=path.join(dataDir,'work');
 const knowledge=await new KnowledgeStore({dataDir}).init();
 const run={id:'task-a',cwd,status:'completed',settled:true,input:'Use short paragraphs for this task.',nodes:{},events:[],workflow:{nodes:[]}};
 const runtime={status:()=>({defaultModel:'test'}),runAgent:async options=>{
   for(const [kind,key] of [['fact','paragraphs'],['skill','method']])await options.onToolCall({name:'relay_learn',arguments:{action:'record',kind,key,title:key,content:'Use short paragraphs.',whenToUse:'Only this task.',evidence:[{id:'task',quote:run.input}]}});
   await options.onToolCall({name:'relay_learn',arguments:{action:'finish',summaryOfReview:'Two candidates.'}});return {};
 }};
 const learning=await new LearningStore({dataDir,runtime,knowledge,getRun:()=>run,delayMs:0}).init();
 t.after(async()=>{await learning.close();await rm(dataDir,{recursive:true,force:true});});
 const review=await learning.learnNow(run.id);await wait(()=>learning.getReview(review.id).status==='pending_approval');
 assert.equal(knowledge.list().length,0);assert.equal(learning.listLessons().length,0);assert.equal(knowledge.listApprovals().length,2);
 const [first,second]=knowledge.listApprovals();
 await knowledge.decideApproval(first.id,{decision:'reject'});
 await knowledge.decideApproval(second.id,{decision:'approve'});
 assert.equal(learning.listLessons().length,0,'simulate interruption before learning reconciliation');
 await learning.close();
 const restarted=await new LearningStore({dataDir,runtime,knowledge,getRun:()=>run,delayMs:0}).init();
 try { assert.equal(restarted.listLessons().length,1);assert.equal(restarted.getReview(review.id).status,'completed');assert.equal(restarted.listLessons()[0].knowledgeId,second.value.id); }
 finally { await restarted.close(); }
});
