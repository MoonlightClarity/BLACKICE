import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';
import {TaskExternalContextStore} from '../lib/task-external-context.mjs';
import {validateDoneChecks,projectDoneChecks} from '../lib/directory-done-checklist.mjs';
import {CHAT_PLANNING_MODULES,createChatPlanningPass} from '../lib/chat-planning-pass.mjs';
import {chatPlanningArtifactSchema} from '../lib/chat-planning-provider.mjs';

const actions=count=>Array.from({length:count},(_,i)=>({
  id:'step_'+i,objective:'Perform source check '+i,dependsOn:i?['step_'+(i-1)]:[],
}));
const evidence=count=>Array.from({length:count},(_,i)=>({
  id:'receipt-'+(i+1),taskId:'large-task',runId:'run1',nodeId:'agent',
  actionId:null,tool:'relay_workspace',state:'returned',success:true,
  observationOnly:true,at:'2026-11-23T11:00:00Z',
}));
const reference=answer=>JSON.parse(answer.contentItems[0].text);

test('Planning can propose and Directory can record a dependency chain longer than historical action and planning caps',async()=>{
  const directory=new TaskActionDirectory({taskId:'large-task',objective:'Complete all requested actions.'});
  const planned=actions(70);
  let invocations=0;
  const pass=createChatPlanningPass({mode:'on',taskId:'large-task',runId:'run1',nodeId:'agent',
    signal:new AbortController().signal,
    read:()=>directory.read(),assertAdmission:()=>{},emit:()=>{},
    invoke:({module,snapshot})=>{
      invocations++;
      if(module.id===CHAT_PLANNING_MODULES[0].id){
        assert.equal(snapshot.actions.length,0);
        return{transport:'completed',output:{status:'proposed',focus:'step_0',reason:'The user requested an ordered dependency chain.',sourceRefs:[],actions:planned}};
      }
      assert.equal(snapshot.actions.length,70,'Planning must not truncate the 33rd and later actions.');
      return{transport:'completed',output:{status:'proposed',focus:'step_0',reason:'The first dependency is ready.',sourceRefs:[]}};
    },
    commit:async ({expectedRevision,proposal})=>{
      const before=directory.read();
      assert.equal(before.revision,expectedRevision);
      if(proposal.actions)return directory.edit({action:'plan',revision:expectedRevision,actions:proposal.actions},{authority:'planning'});
      return directory.edit({action:'planningChoice',revision:expectedRevision,moduleId:proposal.moduleId,
        focus:proposal.focus,reason:proposal.reason,sourceRefs:proposal.sourceRefs},{authority:'planning'});
    },
  });
  const first=await pass.run(CHAT_PLANNING_MODULES[0].id);
  assert.equal(first.status,'completed',JSON.stringify(first));
  assert.equal(directory.read().actions.length,70);
  assert.equal(directory.read().ready.length,1);
  assert.equal(directory.read().ready[0],'step_0');
  assert.equal((await pass.run(CHAT_PLANNING_MODULES[1].id)).status,'completed');
  assert.equal(invocations,2);
  const snapshot=directory.read();
  const schema=chatPlanningArtifactSchema(CHAT_PLANNING_MODULES[1],snapshot);
  const proposal=schema.properties.artifact.anyOf[0];
  assert(proposal.properties.focus.enum.includes('step_0'));
  assert(!Object.hasOwn(proposal.properties.sourceRefs,'maxLength'));
});

test('Planning schema retains pending choice 65 and all 40 returned receipt references',()=>{
  const snapshots={taskId:'large-task',revision:1,actions:actions(70).map(a=>({...a,state:'pending'})),
    receipts:evidence(40)};
  const module=CHAT_PLANNING_MODULES[1];
  const schema=chatPlanningArtifactSchema(module,snapshots);
  const proposed=schema.properties.artifact.anyOf[0].properties;
  assert.equal(proposed.focus.enum.length,70);
  assert(proposed.focus.enum.includes('step_65'));
  assert.equal(proposed.sourceRefs.items.enum.length,40);
  assert.equal(proposed.sourceRefs.maxItems,40);
});

test('completion checklists support deep requirements and roll up without recursive stack overflow',()=>{
  const checks=Array.from({length:60},(_,i)=>({
    id:'check_'+i,check:'Condition '+i+' is satisfied',
    ...(i?{parentId:'check_'+(i-1)}:{})
  }));
  assert.equal(validateDoneChecks(checks).length,60);
  const completed=checks.map(item=>({id:item.id,yes:true,receipt:'receipt-1'}));
  const summary=projectDoneChecks(checks,completed);
  assert.equal(summary.length,60);
  assert(summary.every(row=>row.yes===true));
});

test('archive search exceeds the old 8 MiB scan ceiling and read returns more than old 8192 bytes',async t=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'directory-large-scan-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=new TaskExternalContextStore({dataDir,taskId:'large-task'});
  const marker='ROOT_CAUSE_CODE: HIGH_OFFSET_FOUND';
  const original='x'.repeat(9*1024*1024+19)+marker;
  const delivered=await store.archiveResult({name:'relay_workspace',arguments:{action:'read',path:'fixture.log'}},
    {success:true,contentItems:[{type:'inputText',text:original}]});
  const ref=reference(delivered).reference;
  const hits=await store.search({reference:ref,needle:marker});
  assert.equal(hits.matches.length,1);
  assert(hits.matches[0].offset>8*1024*1024);
  const page=await store.read({reference:ref,offset:0,maxBytes:32768});
  assert.equal(Buffer.byteLength(page.text),32768);
  const exact=await store.read({reference:ref,offset:hits.matches[0].offset,maxBytes:512});
  assert.equal(exact.text,marker);
});
