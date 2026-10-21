import test from 'node:test';
import assert from 'node:assert/strict';
import {projectViewModel,projectPortfolio,projectGroupOutline,projectTaskOutline,isPreparedReview,reviewOriginalSource,projectTracking} from '../public/project-view-model.mjs';

const task=(id,extra={})=>({id,title:`Task ${id}`,status:'pending',dependsOn:[],attempts:[],...extra});
const project=(id,tasks,extra={})=>({id,status:'draft',tasks,...extra});

test('project readiness follows reviewed prerequisites even when task declarations are out of order',()=>{
  const value=project('p',[task('deliver',{dependsOn:['review']}),task('review',{status:'verifying'}),task('independent'),task('done',{status:'completed'}),task('blocked',{status:'blocked',error:'Missing output.'})]),before=structuredClone(value),model=projectViewModel(value);
  assert.deepEqual(model.counts,{working:1,blocked:1,ready:1,waiting:1,reviewed:1});
  assert.equal(model.readyTask.id,'independent');assert.equal(model.bucket,'attention');assert.equal(model.next.taskId,'blocked');assert.equal(model.next.description,'Missing output.');
  assert.deepEqual(value,before,'deriving an overview never edits or starts the saved plan');
  value.tasks[1].status='completed';const reviewed=projectViewModel(value);assert.equal(reviewed.counts.ready,2);assert.equal(reviewed.counts.waiting,0);
});

test('implementation completion remains working until the separate review completes',()=>{
  const value=project('p',[task('check',{status:'verifying',attempts:[{implementation:{status:'completed'}}]}),task('after',{dependsOn:['check']})],{status:'running'}),model=projectViewModel(value);
  assert.equal(model.percent,0);assert.equal(model.counts.reviewed,0);assert.equal(model.counts.waiting,1);assert.equal(model.next.title,'Review in progress');assert.equal(model.next.taskId,'check');
});

test('paused project with active work explains that phase may finish without promising a new admission',()=>{
  const model=projectViewModel(project('p',[task('active',{status:'running'}),task('next')],{status:'paused'}));
  assert.equal(model.bucket,'working');assert.equal(model.next.title,'Finishing the current phase');assert.match(model.next.description,/Resume explicitly/);
});

test('draft, paused and reviewed projects expose inspectable next actions without starting work',()=>{
  const draft=projectViewModel(project('draft',[task('later',{dependsOn:['first']}),task('first')]));assert.equal(draft.next.taskId,'first');assert.match(draft.next.description,/Saving a plan starts no work/);
  const paused=projectViewModel(project('paused',[task('first')],{status:'paused'}));assert.equal(paused.next.title,'Ready to resume');
  const reviewed=projectViewModel(project('done',[task('first',{status:'completed'})],{status:'completed'}));assert.equal(reviewed.bucket,'reviewed');assert.equal(reviewed.percent,100);assert.match(reviewed.next.title,/agent-reviewed/);
});

test('unresolved or missing prerequisites never become ready and point to exact dependency titles',()=>{
  const model=projectViewModel(project('p',[task('deliver',{dependsOn:['review','missing']}),task('review',{status:'blocked'})]));
  assert.equal(model.counts.ready,0);assert.equal(model.counts.waiting,1);assert.equal(model.next.taskId,'review');
  const missing=projectViewModel(project('p',[task('deliver',{dependsOn:['missing']})]));assert.equal(missing.next.kind,'waiting');assert.match(missing.next.description,/missing/);
});

test('global execution pause is visible while preserved active phase and reviewed evidence remain accurate',()=>{
  const blockedReason='Execution was paused from Settings.';
  const paused=projectViewModel(project('p',[task('first')]),{blockedReason});assert.equal(paused.next.title,'Project execution is paused');assert.equal(paused.next.description,blockedReason);assert.equal(paused.next.taskId,'first');
  const active=projectViewModel(project('p',[task('first',{status:'verifying'})],{status:'running'}),{blockedReason});assert.equal(active.next.title,'Review in progress');
  const complete=projectViewModel(project('p',[task('first',{status:'completed'})],{status:'completed'}),{blockedReason});assert.equal(complete.next.kind,'reviewed');
  const failed=projectViewModel(project('p',[task('first',{status:'blocked',error:'The output file is missing.'})],{status:'needs_attention'}),{blockedReason});assert.equal(failed.next.description,'The output file is missing.');assert.equal(failed.executionHold,blockedReason);
});

test('portfolio counts projects once, orders attention first, and preserves stored order within a status',()=>{
  const values=[project('reviewed',[task('done',{status:'completed'})],{status:'completed'}),project('ready-a',[task('first')]),project('working',[task('active',{status:'running'})],{status:'running'}),project('attention',[task('blocked',{status:'blocked'})],{status:'needs_attention'}),project('ready-b',[task('first')],{status:'paused'})],before=structuredClone(values),portfolio=projectPortfolio(values);
  assert.deepEqual(portfolio.counts,{all:5,attention:1,working:1,ready:2,reviewed:1});assert.deepEqual(portfolio.items.map(item=>item.project.id),['attention','working','ready-a','ready-b','reviewed']);
  assert.deepEqual(projectPortfolio(values,{filter:'ready'}).items.map(item=>item.project.id),['ready-a','ready-b']);assert.equal(projectPortfolio(values,{filter:'unknown'}).items.length,0);assert.deepEqual(values,before);
});

test('an empty plan cannot produce a misleading percentage or an invented task action',()=>{
  const model=projectViewModel(project('p',[]));assert.equal(model.percent,0);assert.equal(model.total,0);assert.equal(model.next.taskId,null);assert.equal(model.next.label,null);
});

test('a prepared original-result review is ready to resume and never presented as already working or reviewed',()=>{
  const prepared=task('inspect',{status:'verifying',attempts:[{mode:'review_only',verification:{status:'prepared'}}]}),value=project('p',[prepared,task('after',{dependsOn:['inspect']})],{status:'paused'}),before=structuredClone(value),model=projectViewModel(value);
  assert.equal(isPreparedReview(prepared),true);assert.equal(model.bucket,'ready');assert.equal(model.counts.working,0);assert.equal(model.counts.ready,1);assert.equal(model.counts.waiting,1);assert.equal(model.counts.reviewed,0);assert.equal(model.preparedReview.id,'inspect');assert.equal(model.next.title,'Review prepared');assert.equal(model.next.taskId,'inspect');assert.match(model.next.description,/Resume to review/);assert.match(model.next.description,/delivery will not repeat/);assert.deepEqual(value,before);
  const portfolio=projectPortfolio([value]);assert.equal(portfolio.counts.ready,1);assert.equal(portfolio.counts.working,0);
  const held=projectViewModel(value,{blockedReason:'Execution paused from Settings.'});assert.equal(held.next.title,'Project execution is paused');assert.equal(held.next.description,'Execution paused from Settings.');assert.equal(held.next.taskId,'inspect');
  prepared.attempts[0].verification.status='running';const running=projectViewModel(value);assert.equal(isPreparedReview(prepared),false);assert.equal(running.counts.working,1);assert.equal(running.preparedReview,null);
});

test('original-result review eligibility skips only explicitly unadmitted intents and never an actual failed newer execution',()=>{
  const original={number:1,implementation:{status:'completed',runId:'original-run',requestId:'original-request'}},value=task('inspect',{status:'blocked',attempts:[original,{number:2,implementation:{status:'interrupted',runId:null,notAdmitted:true}}]}),before=structuredClone(value);
  assert.equal(reviewOriginalSource(value),original);assert.deepEqual(value,before);
  value.attempts[1].implementation.notAdmitted=false;assert.equal(reviewOriginalSource(value),null);
  value.attempts[1].implementation={status:'failed',runId:'later-run',requestId:'later-request'};assert.equal(reviewOriginalSource(value),null);
  value.attempts[1]={number:2,mode:'review_only',sourceAttempt:1,implementation:structuredClone(original.implementation)};assert.equal(reviewOriginalSource(value),original);
  value.attempts[1].implementation.runId='different-result';assert.equal(reviewOriginalSource(value),null);
  value.status='completed';assert.equal(reviewOriginalSource(value),null);
});

test('linked milestones require reviewed tasks while manual checkpoints cannot raise task progress',()=>{
  const value=project('p',[task('a',{status:'completed'}),task('b',{status:'verifying'}),task('blocked',{status:'blocked'})],{dueDate:'2026-10-01',milestones:[{id:'linked',title:'Reviewed delivery',taskIds:['a','b'],dueDate:'2026-10-01',done:false},{id:'manual',title:'A separate decision',taskIds:[],dueDate:'',done:true},{id:'held',title:'Blocked evidence',taskIds:['blocked'],dueDate:'',done:false}]}),snapshot=structuredClone(value),tracking=projectTracking(value,{today:'2026-10-18'}),model=projectViewModel(value);
  assert.deepEqual(tracking.milestones.map(item=>[item.id,item.completed,item.total,item.percent,item.status,item.completion]),[['linked',1,2,50,'active','agent-reviewed'],['manual',0,0,100,'completed','manual'],['held',0,1,0,'blocked','agent-reviewed']]);assert.equal(tracking.milestones[0].done,false);assert.equal(tracking.milestones[0].overdue,true);assert.equal(tracking.overdue,true);assert.equal(model.reviewed,1);assert.equal(model.percent,33);assert.deepEqual(value,snapshot);
  value.tasks[1].status='completed';assert.equal(projectTracking(value,{today:'2026-10-18'}).milestones[0].done,true);assert.equal(projectTracking(value,{today:'2026-10-18'}).milestones[0].overdue,false);
});

test('execution evidence counts unique actual runs when a review reuses an earlier implementation',()=>{
  const value=project('p',[task('a',{status:'verifying',attempts:[{implementation:{runId:'implementation-1',status:'completed'},verification:{runId:'review-1',status:'completed'}},{mode:'review_only',implementation:{runId:'implementation-1',status:'completed'},verification:{runId:'review-2',status:'running'}},{implementation:{status:'prepared',notAdmitted:true}}]})]);
  assert.deepEqual(projectTracking(value).evidence,{implementationRuns:1,reviewRuns:2});assert.equal(projectViewModel(value).percent,0);assert.equal(projectTracking({...value,status:'completed',dueDate:'2020-01-01'}).overdue,false);
});

test('named groups organize active plans by name while archived plans require an explicit view',()=>{
  const values=[project('blocked',[task('a',{status:'blocked'})],{name:'Zeta',groupId:'research',groupName:'Research'}),project('done',[task('a',{status:'completed'})],{name:'Alpha',groupId:'research',status:'completed'}),project('archived',[task('a')],{name:'Archived plan',groupId:'research',archived:true}),project('ungrouped',[task('a')],{name:'Independent'})],groups=[{id:'research',name:'Research'},{id:'delivery',name:'Delivery'}],before=structuredClone(values);
  const outline=projectGroupOutline(values,{groups});assert.deepEqual(outline.groups.map(group=>group.name),['Delivery','Research','Ungrouped']);assert.deepEqual(outline.groups.find(group=>group.id==='research').items.map(item=>item.project.id),['done','blocked']);assert.equal(outline.activeCount,3);assert.equal(outline.archivedCount,1);assert.equal(outline.counts.all,3);assert.deepEqual(projectPortfolio(values).items.map(item=>item.project.id),['blocked','ungrouped','done']);
  const archive=projectGroupOutline(values,{groups,history:'archived'});assert.deepEqual(archive.groups.map(group=>[group.name,group.items.map(item=>item.project.id)]),[['Research',['archived']]]);assert.deepEqual(values,before);
});

test('group organization does not lose plans when a group catalog is temporarily unavailable',()=>{
  const values=[project('a',[],{name:'Saved work',groupId:'known-later',groupName:'Product'}),project('b',[],{name:'Other work'})],outline=projectGroupOutline(values);
  assert.deepEqual(outline.groups.map(group=>[group.id,group.name,group.items.length]),[['known-later','Product',1],[null,'Ungrouped',1]]);assert.equal(outline.items.length,2);
});

test('the outline orders prerequisite tasks but keeps workers under their actual attempt and task',()=>{
  const original={number:1,implementation:{status:'completed',runId:'build'},verification:{status:'completed',runId:'review'}},reused={number:2,mode:'review_only',sourceAttempt:1,implementation:{status:'completed',runId:'build'},verification:{status:'prepared'}};
  const value=project('p',[task('delivery',{dependsOn:['evidence']}),task('independent'),task('evidence',{status:'verifying',attempts:[original,reused]})]),before=structuredClone(value),outline=projectTaskOutline(value);
  assert.deepEqual(outline.map(row=>row.task.id),['independent','evidence','delivery']);assert.deepEqual(outline.at(-1).dependencies,[{id:'evidence',title:'Task evidence',known:true}]);assert.deepEqual(outline[1].attempts.map(row=>row.workers.map(worker=>[worker.kind,worker.runId,worker.reused])),[[['implementation','build',false],['verification','review',false]],[['implementation','build',true],['verification',null,false]]]);assert.equal(outline[1].task,value.tasks[2]);assert.deepEqual(value,before);
});
