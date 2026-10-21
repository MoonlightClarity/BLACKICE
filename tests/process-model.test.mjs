import test from 'node:test';
import assert from 'node:assert/strict';
import {projectPlan,projectMetadata,emptyProject,newProjectStep,isSequentialPlan,sequenceSteps,moveStep,removeProjectStep,orderedProjectSteps,methodDefinition,applyMethodPreview,projectDraftIssue,methodDraftIssue,planningPrompt} from '../public/process-model.mjs';

const task=(id,dependsOn=[])=>({id,title:`Make ${id}`,instructions:`Produce ${id}.`,acceptanceCriteria:[`${id} exists.`],dependsOn,stepType:'create',inputs:['Supplied context'],result:`The saved ${id}.`,model:'native-route',verifierModel:'review-route',maxRepairs:0});
const project=()=>({name:'A project',objective:'A concrete outcome.',cwd:'C:/work',context:'Saved source paths',method:{id:'research-brief',revision:2,name:'Research',taskType:'research',origin:'builtin'},priority:'high',owner:'Editor',dueDate:'2026-11-30',notes:'Preserve this constraint.',tags:['research'],milestones:[{id:'result',title:'Result reviewed',taskIds:['b'],dueDate:'',done:false}],model:'native-default',verifierModel:'native-review',maxRepairs:3,tasks:[task('a'),task('b',['a'])]});

test('a project plan copies method provenance, context, tracking and explicit task routes without execution receipts',()=>{
  const original=project();original.tasks[0].status='completed';original.tasks[0].attempts=[{implementation:{runId:'actual'}}];
  const draft=projectPlan(original);assert.deepEqual(draft.tasks,[task('a'),task('b',['a'])]);assert.deepEqual(draft.method,original.method);assert.equal(draft.context,original.context);assert.deepEqual(draft.milestones,original.milestones);
  draft.tasks[0].inputs.push('New context');draft.milestones[0].taskIds.push('a');draft.method.name='Edited label';assert.equal(original.tasks[0].inputs.length,1);assert.deepEqual(original.milestones[0].taskIds,['b']);assert.equal(original.method.name,'Research');
});

test('tracking updates contain only editable metadata and cannot rewrite task plans or claim execution completion',()=>{
  const original=project();original.status='running';original.tasks[0].attempts=[{implementation:{status:'completed'}}];
  const metadata=projectMetadata(original);assert.deepEqual(Object.keys(metadata).sort(),['name','priority','owner','dueDate','notes','tags','milestones'].sort());assert.equal(metadata.owner,'Editor');assert.equal(metadata.milestones[0].done,false);assert.ok(!Object.hasOwn(metadata,'tasks'));assert.ok(!Object.hasOwn(metadata,'status'));
});

test('new steps follow the prior reviewed step and stable move operations keep explicit task configuration',()=>{
  const tasks=[task('a'),task('b',['a']),task('c',['b'])];assert.equal(isSequentialPlan(tasks),true);
  const moved=moveStep(tasks,'c',-1,{sequence:true});assert.deepEqual(moved.map(step=>[step.id,step.dependsOn]),[['a',[]],['c',['a']],['b',['c']]]);assert.equal(moved[1].model,'native-route');assert.equal(moved[1].maxRepairs,0);assert.deepEqual(tasks.map(step=>step.id),['a','b','c']);
  const added=newProjectStep(moved);assert.deepEqual(added.dependsOn,['b']);
});

test('reordering a custom dependency graph does not rewrite prerequisites unless sequencing is explicitly requested',()=>{
  const tasks=[task('a'),task('b'),task('c',['a','b'])];assert.equal(isSequentialPlan(tasks),false);
  const moved=moveStep(tasks,'c',-1);assert.deepEqual(moved.map(step=>[step.id,step.dependsOn]),[['a',[]],['c',['a','b']],['b',[]]]);
  assert.deepEqual(sequenceSteps(moved).map(step=>step.dependsOn),[[],['a'],['c']]);assert.deepEqual(removeProjectStep(tasks,'b').map(step=>[step.id,step.dependsOn]),[['a',[]],['c',['a']]]);
});

test('ordered presentation respects forward prerequisites without editing the saved legacy graph',()=>{
  const tasks=[task('last',['middle']),task('middle',['first']),task('first')],original=structuredClone(tasks);
  assert.deepEqual(orderedProjectSteps(tasks).map(step=>step.id),['first','middle','last']);assert.deepEqual(tasks,original);
  assert.deepEqual(orderedProjectSteps([task('a',['b']),task('b',['a'])]).map(step=>step.id),['a','b'],'malformed stored cycles terminate without inventing a different plan');
});

test('a method preview preserves tracking and authored context while adopting exact server step IDs and provenance',()=>{
  const before=project(),preview={...project(),context:'Inputs from the selected method',method:{id:'custom-method',revision:4,name:'Adapted method',taskType:'custom-task',origin:'custom'}};
  const result=applyMethodPreview(before,preview);assert.deepEqual(result.method,preview.method);assert.equal(result.context,'Saved source paths\n\nInputs from the selected method');assert.equal(result.owner,'Editor');assert.deepEqual(result.milestones,before.milestones);assert.equal(result.tasks[1].stepType,'create');assert.equal(result.tasks[1].result,'The saved b.');assert.equal(before.context,'Saved source paths');
});

test('replacing method steps cannot silently convert linked milestones into manual completion',()=>{
  const before=project(),snapshot=structuredClone(before),preview={...project(),tasks:[task('different')]};
  assert.throws(()=>applyMethodPreview(before,preview),/milestone.*Remove those milestone links/s);assert.deepEqual(before,snapshot);
  assert.throws(()=>applyMethodPreview({...before,context:'x'.repeat(8000)},{...before,context:'Additional data'}),/combined project context is too long/);assert.deepEqual(before,snapshot);
});

test('project validation catches cycles and missing acceptance checks before saving the draft',()=>{
  const valid=project();assert.equal(projectDraftIssue(valid),null);valid.tasks[0].dependsOn=['b'];assert.match(projectDraftIssue(valid),/form a loop/);valid.tasks[0].dependsOn=[];valid.tasks[1].acceptanceCriteria=[];assert.match(projectDraftIssue(valid),/step 2/);
  const empty=emptyProject('C:/work','Find an answer.');assert.equal(empty.objective,'Find an answer.');assert.deepEqual(empty.tasks[0].dependsOn,[]);assert.match(projectDraftIssue(empty),/name/);
});

test('editing a method definition preserves free descriptive inputs and creates no project execution fields',()=>{
  const method={id:'builtin',origin:'builtin',revision:3,name:'Compare',description:'Choose with evidence.',taskType:'decision',inputs:[{id:'options',label:'Options',description:'What can be chosen',required:true}],steps:[{id:'compare',title:'Compare options',type:'analyze',instructions:'Compare the supplied options.',inputs:['Options','Reviewed scope'],result:'A comparison table.',checks:['Every option is compared.']}]};
  const draft=methodDefinition(method);assert.equal(methodDraftIssue(draft),null);assert.deepEqual(draft.steps[0].inputs,['Options','Reviewed scope']);assert.ok(!Object.hasOwn(draft,'id'));assert.ok(!Object.hasOwn(draft,'origin'));draft.steps[0].checks=[];assert.match(methodDraftIssue(draft),/observable check/);assert.equal(method.steps[0].checks.length,1);
});

test('planning prompts ask for saved inspectable drafts and leave project execution to a separate explicit decision',()=>{
  const draft=project(),prompt=planningPrompt({goal:draft.objective,draft,projectId:'existing-project'});
  assert.match(prompt,/Prepare drafts only/);assert.match(prompt,/Do not start a project, execute its tasks/);assert.match(prompt,/relay_project/);assert.match(prompt,/observable acceptance checks/);assert.match(prompt,/Existing project: existing-project/);assert.match(prompt,/native-route/);assert.match(prompt,/Saving a draft starts no work/);assert.equal(draft.tasks[0].title,'Make a');
});

test('reapplying changed method inputs replaces only the owned generated context and retains authored context',()=>{
  const source={...project(),context:'Keep costs low.',methodContext:'',milestones:[]},firstPreview={...project(),context:'METHOD INPUTS\nOption A and B',methodContext:'METHOD INPUTS\nOption A and B',milestones:[]};
  const first=applyMethodPreview(source,firstPreview),saved=projectPlan(first),second=applyMethodPreview(saved,{...firstPreview,context:'METHOD INPUTS\nOption C and D',methodContext:'METHOD INPUTS\nOption C and D'});
  assert.equal(second.context,'Keep costs low.\n\nMETHOD INPUTS\nOption C and D');assert.equal(second.methodContext,'METHOD INPUTS\nOption C and D');assert.doesNotMatch(second.context,/Option A and B/);
  const third=applyMethodPreview(second,{...firstPreview,context:'',methodContext:''});assert.equal(third.context,'Keep costs low.');assert.equal(third.methodContext,'');assert.equal(source.context,'Keep costs low.');
});
