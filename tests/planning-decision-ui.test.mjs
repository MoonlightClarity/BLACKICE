import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDOM } from './fixture-planning-dom.mjs';
import { createPlanningWorkspace } from '../public/next/workspaces/planning.mjs';
import { normalizeTaskPlan } from '../lib/task-plan.mjs';

const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const initialCriteria=[
  {id:'no_travel',label:'No required travel',kind:'hard_gate',source:'user',priority:5,basis:'Only an explicit travel requirement disqualifies; omitted travel text does not.'},
  {id:'skills',label:'Employer tool requirements',kind:'employer_wishlist',source:'employer',priority:3,basis:'The listing says required but this is a potentially negotiable ideal.'},
];
test('Planning UI displays, edits and saves classified criteria with current revision',async t=>{
  const dom=planningDOM(t),calls=[],notify=[];
  const prototype=Object.getPrototypeOf(dom.mount);
  Object.defineProperty(prototype,'type',{get(){return this.getAttribute('type')||this.tagName.toLowerCase();},set(value){this.setAttribute('type',value);},configurable:true});
  prototype.replaceChildren=function(...nodes){for(const child of [...this.children])child.remove();this.rawText='';this.append(...nodes);};
  prototype.click=function(){if(!this.disabled)void this.dispatch('click',{},true);};
  const matches=prototype.matches;prototype.matches=function(selector){return matches.call(this,selector.replace(/\[([^=\]]+)=([^\]"']+)\]/g,'[$1="$2"]'));};
  const plan=normalizeTaskPlan({plan:{layout:'sequence',detail:'balanced',decisionCriteria:initialCriteria},steps:[
    {id:'review',title:'Evaluate practical job fit',kind:'action',parentId:null,status:'pending',dependsOn:[],
      doneWhen:'Each candidate is classified using hard gates, trainable gaps and preferences.'}
  ]});
  let stored={...plan,taskId:'saved-task',goal:'Find useful and plausible job opportunities',revision:3,
    cwd:'C:\\fixture',createdAt:'2026-10-27T10:00:00Z',updatedAt:'2026-10-27T10:00:00Z',artifacts:[]};
  const api=async(route,method='GET',payload)=>{
    calls.push({route,method,payload});
    if(route.startsWith('/api/planning?'))return{plans:[{taskId:stored.taskId,revision:stored.revision,goal:stored.goal,bucket:'active',editable:true,status:'completed'}],nextOffset:null};
    if(route==='/api/tasks/saved-task'&&method==='GET')return structuredClone(stored);
    if(route==='/api/tasks/saved-task/plan/edit'&&method==='POST'){
      assert.equal(payload.expectedRevision,stored.revision);
      assert.deepEqual(payload.operations.map(item=>item.type),['metadata']);
      const patch=payload.operations[0].patch;
      const plan={...stored.plan};
      if(Object.hasOwn(patch,'decisionCriteria'))plan.decisionCriteria=structuredClone(patch.decisionCriteria);
      if(Object.hasOwn(patch,'metacognition')){
        if(patch.metacognition)plan.metacognition=structuredClone(patch.metacognition);
        else delete plan.metacognition;
      }
      stored={...stored,revision:stored.revision+1,plan};
      return structuredClone(stored);
    }
    throw Error('Unexpected '+method+' '+route);
  };
  const component=createPlanningWorkspace({
    mount:dom.mount,api,events:{subscribe:()=>()=>{}},notify:(...args)=>notify.push(args),
    getStatus:()=>({cwd:'C:\\fixture'})
  });
  t.after(()=>component.destroy());
  dom.$('#next-planning-type').value='conversation';
  component.enter();await settle();
  const panel=dom.$('#next-planning-decision-criteria');
  assert.ok(panel,'Planning exposes saved decision classifications');
  assert.match(panel.textContent,/Decision criteria · 2 classified/);
  assert.equal(dom.mount.querySelectorAll('.next-plan-criterion-row').length,2);
  const rows=dom.mount.querySelectorAll('.next-plan-criterion-row');
  assert.equal(rows[0].querySelector('[name=kind]').value,'hard_gate');
  assert.equal(rows[1].querySelector('[name=kind]').value,'employer_wishlist');
  rows[1].querySelector('[name=kind]').value='trainable_skill';
  rows[1].querySelector('[name=basis]').value='The job only asks for introductory SQL and dashboard usage.';
  const save=[...panel.querySelectorAll('button')].find(item=>item.textContent==='Save criteria');
  assert.ok(save);
  await save.dispatch('click',{},true);await settle();
  assert.equal(stored.revision,4);
  assert.equal(stored.plan.decisionCriteria[0].kind,'hard_gate');
  assert.equal(stored.plan.decisionCriteria[1].kind,'trainable_skill');
  assert.equal(stored.plan.decisionCriteria[1].basis,'The job only asks for introductory SQL and dashboard usage.');
  assert.equal(calls.filter(item=>item.method==='POST').length,1);
  assert.equal(notify.some(item=>item[0]==='Decision criteria saved.'),true);
  assert.equal(dom.$('#next-planning-decision-criteria').textContent.includes('2 classified'),true);
  const frame=dom.$('#next-planning-metacognition');
  assert.ok(frame,'Every working plan can save a proportional judgment frame');
  assert.match(frame.textContent,/Practical judgment/);
  const input=name=>frame.querySelector('[data-judgment-field="'+name+'"]');
  input('outcome').value='Ship a reliable and usable result.';
  input('keyUncertainty').value='Whether a live dependency requires a specific implementation.';
  input('nextProbe').value='Test a minimal alternate implementation.';
  input('goodEnough').value='Real goal achieved with one transfer case tested.';
  input('reassessWhen').value='After two controlled attempts contradict the cause.';
  const submit=[...frame.querySelectorAll('button')].find(item=>item.textContent==='Save judgment frame');
  assert.ok(submit);
  await submit.dispatch('click',{},true);await settle();
  assert.equal(stored.revision,5);
  assert.equal(stored.plan.metacognition.outcome,'Ship a reliable and usable result.');
  assert.equal(stored.plan.metacognition.nextProbe,'Test a minimal alternate implementation.');
  assert.equal(calls.filter(item=>item.method==='POST').length,2);
  assert.equal(notify.some(item=>item[0]==='Judgment frame saved.'),true);
  const latestFrame=dom.$('#next-planning-metacognition');
  assert.match(latestFrame.textContent,/5 notes/);
  const latest=latestFrame.querySelector('[data-judgment-field="goodEnough"]');
  assert.equal(latest.value,'Real goal achieved with one transfer case tested.');
  const oldCriterion=dom.$('#next-planning-decision-criteria').querySelector('[name=kind]');
  assert.equal(oldCriterion.value,'hard_gate','saving the frame does not rewrite existing criteria');
});
