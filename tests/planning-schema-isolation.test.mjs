import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {planningModuleOutputSchema,planningFormatDiagnostic,planningModulePrompt} from '../lib/planning-browser-runtime.mjs';
import {responseCycleResponseSchema,responseCycleTemplate} from '../public/response-cycle-model.mjs';
import {viabilityRequirementSchema,taskAccuracySchema} from '../public/task-viability-model.mjs';
import * as controls from '../lib/control-tools.mjs';
const kinds=['viability','inference','plan','think','respond'];
const full={sources:[{id:'source:fact-alpha',kind:'user_request'},{id:'response:prior-alpha',kind:'response'}],challenges:[{edgeId:'challenge-alpha'}],workflowNodeIds:['workflow-agent-alpha'],cycleContext:{effectReceipts:[{id:'receipt-alpha'}]}};
const empty={sources:[],challenges:[],workflowNodeIds:[],cycleContext:{effectReceipts:[]}};
const attempt=(kind,refs=full)=>({node:{kind},template:responseCycleTemplate(kind),...structuredClone(refs)});
const scalar=(node,path,visit)=>{
  if(!node||typeof node!=='object')return;
  if(node.type==='string')visit(node,path);
  for(const [key,value]of Object.entries(node.properties||{}))scalar(value,path+'.'+key,visit);
  if(node.items)scalar(node.items,path+'[]',visit);
  for(const [index,value]of (node.anyOf||[]).entries())scalar(value,path+'.anyOf'+index,visit);
};
const arrays=(node,path,visit)=>{
  if(!node||typeof node!=='object')return;
  if(node.type==='array')visit(node,path);
  for(const [key,value]of Object.entries(node.properties||{}))arrays(value,path+'.'+key,visit);
  if(node.items)arrays(node.items,path+'[]',visit);
  for(const [index,value]of (node.anyOf||[]).entries())arrays(value,path+'.anyOf'+index,visit);
};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('captured identifiers constrain only their exact reference positions across all five stages',()=>{
  const refs={sourceIds:full.sources.map(source=>source.id),checkedSourceIds:[full.sources[0].id],dependentNodeIds:full.workflowNodeIds,receiptIds:['receipt-alpha']};
  const markers=new Set([...Object.values(refs).flat(),'challenge-alpha']);
  for(const kind of kinds){
    const schema=planningModuleOutputSchema(attempt(kind));
    scalar(schema,kind,(value,path)=>{
      if(!value.enum?.some(item=>markers.has(item)))return;
      const name=path.split('.').at(-1);
      if(name==='sourceId')assert.deepEqual(value.enum,refs.sourceIds,path);
      else if(name==='edgeId')assert.deepEqual(value.enum,['challenge-alpha'],path);
      else if(name.endsWith('[]')&&Object.hasOwn(refs,name.slice(0,-2)))assert.deepEqual(value.enum,refs[name.slice(0,-2)],path);
      else assert.fail('Captured identifiers leaked into '+path);
    });
    for(const [id,value]of Object.entries(schema.properties.values.properties))assert.equal(value.enum,undefined,kind+'.values.'+id);
    assert.equal(schema.properties.openQuestions.items.enum,undefined,kind+'.openQuestions');
    assert.equal(schema.properties.challengeResponses.items.properties.note.enum,undefined,kind+'.challengeResponses.note');
    assert.deepEqual(schema.properties.grounding.items.properties.sourceId.enum,refs.sourceIds,kind+'.grounding.sourceId');
    arrays(schema,kind,(value,path)=>{const name=path.split('.').at(-1);if(Object.hasOwn(refs,name)){assert.deepEqual(value.items.enum,refs[name],path);assert.equal(value.maxItems,undefined,path);}});
    if(kind==='plan'){
      for(const name of ['id','label','description'])assert.equal(schema.properties.steps.items.properties[name].enum,undefined,'steps.'+name);
      for(const name of ['dependsOn','criterionIds'])assert.equal(schema.properties.steps.items.properties[name].items.enum,undefined,'steps.'+name);
      assert.equal(schema.properties.acceptanceCriteria.items.properties.id.enum,undefined,'acceptanceCriteria.id');
    }
  }
});

test('A then B then empty calls cannot mutate previous results, public schemas, or exported control contracts',()=>{
  const base=Object.fromEntries(kinds.map(kind=>[kind,responseCycleResponseSchema(kind)]));
  const controlNames=['CONTROL_TOOL','PRE_ACCURACY_CONTROL_TOOL','PRE_PROFILE_CONTROL_TOOL'];
  const snapshots={base:digest(base),controls:Object.fromEntries(controlNames.map(name=>[name,digest(controls[name])]))};
  const first=Object.fromEntries(kinds.map(kind=>[kind,planningModuleOutputSchema(attempt(kind))])),firstHash=digest(first);
  const next={sources:[{id:'source:beta',kind:'source'}],challenges:[{edgeId:'challenge-beta'}],workflowNodeIds:['workflow-agent-beta'],cycleContext:{effectReceipts:[{id:'receipt-beta'}]}};
  for(const kind of kinds)planningModuleOutputSchema(attempt(kind,next));
  for(const kind of kinds)planningModuleOutputSchema(attempt(kind,empty));
  assert.equal(digest(first),firstHash,'earlier returned schemas');
  assert.equal(digest(base),snapshots.base,'previously returned public schemas');
  assert.equal(digest(Object.fromEntries(kinds.map(kind=>[kind,responseCycleResponseSchema(kind)]))),snapshots.base,'fresh public schemas');
  for(const name of controlNames)assert.equal(digest(controls[name]),snapshots.controls[name],name);
});

test('empty workflow and receipt sets do not zero source lists, prose lists, or Plan dependencies',()=>{
  const refs={...full,workflowNodeIds:[],challenges:[],cycleContext:{effectReceipts:[]}};
  const viable=planningModuleOutputSchema(attempt('viability',refs)).properties.requirements.items.properties;
  assert.equal(viable.dependentNodeIds.maxItems,0);
  assert.equal(viable.sourceIds.maxItems,undefined);assert.deepEqual(viable.sourceIds.items.enum,full.sources.map(source=>source.id));
  assert.equal(viable.checkedSourceIds.maxItems,undefined);assert.deepEqual(viable.checkedSourceIds.items.enum,[full.sources[0].id]);
  const think=planningModuleOutputSchema(attempt('think',refs));
  assert.equal(think.properties.criterionResults.items.properties.receiptIds.maxItems,0);
  assert.equal(think.properties.criterionResults.items.properties.sourceIds.maxItems,undefined);
  assert.equal(think.properties.openQuestions.maxItems,undefined);
  const plan=planningModuleOutputSchema(attempt('plan',empty));
  assert.equal(plan.properties.steps.items.properties.sourceIds.maxItems,0);
  assert.equal(plan.properties.steps.items.properties.dependsOn.maxItems,undefined);
  assert.equal(plan.properties.steps.items.properties.criterionIds.maxItems,undefined);
  assert.equal(plan.properties.openQuestions.maxItems,undefined);
});


test('public schema factories return fresh per-occurrence trees before any runtime restriction',()=>{
  const one=responseCycleResponseSchema('plan'),before=digest(responseCycleResponseSchema('plan'));
  one.properties.values.properties.approach.enum=['source:caller-edit'];
  assert.equal(one.properties.values.properties.scope.enum,undefined);
  one.properties.steps.items.properties.sourceIds.maxItems=0;
  assert.equal(one.properties.steps.items.properties.dependsOn.maxItems,undefined);
  assert.equal(digest(responseCycleResponseSchema('plan')),before);
  const viable=viabilityRequirementSchema(),props=viable.items.properties;
  props.dependentNodeIds.maxItems=0;assert.equal(props.sourceIds.maxItems,undefined);assert.equal(props.checkedSourceIds.maxItems,undefined);
  assert.equal(viabilityRequirementSchema().items.properties.dependentNodeIds.maxItems,undefined);
  const accuracy=taskAccuracySchema();accuracy.anyOf[0].properties.tolerance.enum=['synthetic'];assert.equal(accuracy.anyOf[0].properties.stopWhen.enum,undefined);
});

const planBody=()=>({
  values:Object.fromEntries(responseCycleTemplate('plan').fields.map(field=>[field.id,'Compare the supplied duration ranges and state the supported saving.'])),
  grounding:responseCycleTemplate('plan').fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:full.sources[0].id})),
  openQuestions:[],challengeResponses:[],
  checks:['outcome_covered','dependencies_valid','verification_defined','unknowns_visible'].map(id=>({id,assessment:'supported',sourceIds:[full.sources[0].id],note:'The supplied ranges support a direct comparison.'})),
  subproblems:[],childResults:[],
  acceptanceCriteria:[{id:'range-comparison',label:'Compare the ranges',description:'Identify the faster option and the range of plausible savings.',verification:'response',accuracy:null}],
  steps:[{id:'compare',label:'Compare the supplied ranges',description:'Use both supplied ranges to explain which option is faster and by how much.',dependsOn:[],criterionIds:['range-comparison'],sourceIds:[full.sources[0].id]}]
});

test('provider completion contracts require nonempty Plan and child criteria without changing public contracts or optional lists',()=>{
  const publicBefore=Object.fromEntries(kinds.map(kind=>[kind,responseCycleResponseSchema(kind)])),before=digest(publicBefore);
  for(const refs of [full,empty])for(const kind of kinds){
    const properties=planningModuleOutputSchema(attempt(kind,refs)).properties;
    if(kind==='plan'){
      assert.equal(properties.acceptanceCriteria.minItems,1);
      assert.equal(properties.steps.minItems,1);
      assert.equal(properties.steps.items.properties.criterionIds.minItems,1);
      assert.equal(properties.steps.items.properties.dependsOn.minItems,undefined);
    }
    if(kind!=='viability'){
      assert.equal(properties.subproblems.items.properties.acceptanceCriteria.minItems,1,kind);
      assert.equal(properties.subproblems.minItems,undefined,kind);
      assert.equal(properties.childResults.minItems,undefined,kind);
    }
    assert.equal(properties.openQuestions.minItems,undefined,kind);
    assert.equal(properties.challengeResponses.minItems,undefined,kind);
  }
  assert.equal(digest(Object.fromEntries(kinds.map(kind=>[kind,responseCycleResponseSchema(kind)]))),before);
  assert.equal(publicBefore.plan.properties.acceptanceCriteria.minItems,undefined);
  assert.equal(publicBefore.plan.properties.steps.minItems,undefined);
  assert.equal(publicBefore.plan.properties.steps.items.properties.criterionIds.minItems,undefined);
});

test('repair diagnostics identify empty Plan, step coverage and child contracts by exact path',()=>{
  const current=attempt('plan'),diagnose=body=>planningFormatDiagnostic(current,JSON.stringify(body),Object.assign(Error('Invalid plan contract.'),{code:'RESPONSE_CYCLE_INVALID'})).issues;
  assert.deepEqual(diagnose(planBody()),[]);
  const emptyPlan={...planBody(),acceptanceCriteria:[],steps:[]};
  assert.deepEqual(diagnose(emptyPlan),[
    {path:'response.acceptanceCriteria',message:'This array needs at least 1 item.'},
    {path:'response.steps',message:'This array needs at least 1 item.'}
  ]);
  const uncovered=planBody();uncovered.steps[0].criterionIds=[];
  assert.deepEqual(diagnose(uncovered),[{path:'response.steps[0].criterionIds',message:'This array needs at least 1 item.'}]);
  const child=planBody();child.subproblems=[{key:'check-overlap',title:'Check range overlap',objective:'Determine whether the ranges overlap.',reason:'An overlap could change the recommendation.',required:true,executionTarget:'analysis',sourceIds:[full.sources[0].id],acceptanceCriteria:[]}];
  assert.deepEqual(diagnose(child),[{path:'response.subproblems[0].acceptanceCriteria',message:'This array needs at least 1 item.'}]);
  child.subproblems[0].acceptanceCriteria=structuredClone(child.acceptanceCriteria);
  assert.deepEqual(diagnose(child),[]);
});

test('new minimum diagnostics retain the captured-reference empty-array diagnostic',()=>{
  const current=attempt('plan',{...full,challenges:[]}),body=planBody();body.challengeResponses=[{edgeId:'not-captured',disposition:'addressed',note:'This challenge was not supplied.'}];
  body.acceptanceCriteria=[];body.steps=[];
  const issues=planningFormatDiagnostic(current,JSON.stringify(body),Error('Invalid plan contract.')).issues;
  assert.ok(issues.some(issue=>issue.path==='response.challengeResponses'&&issue.message==='This array must be empty: no corresponding captured references exist.'));
  assert.ok(issues.some(issue=>issue.path==='response.acceptanceCriteria'&&issue.message==='This array needs at least 1 item.'));
  assert.ok(issues.some(issue=>issue.path==='response.steps'&&issue.message==='This array needs at least 1 item.'));
});

test('the first Plan prompt requires concrete completion criteria for an analytical answer',()=>{
  const current=attempt('plan');delete current.cycleContext;
  const prompt=planningModulePrompt(current);
  assert.match(prompt,/at least one concrete, measurable acceptance criterion and at least one proposed step/);
  assert.match(prompt,/even when the requested outcome is an analytical answer/);
  assert.match(prompt,/Every step must name at least one current criterion in criterionIds/);
  assert.match(prompt,/do not invent external work or extra verification/);
  assert.match(prompt,/criterion and step descriptions, requirement and criterion-result rationales/);
  assert.equal(prompt.includes('The previous analytical response failed'),false);
});
