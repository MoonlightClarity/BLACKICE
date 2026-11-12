import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
import {editShadowdancerContext,readShadowdancerFile} from '../lib/shadowdancer-context.mjs';
import {planShadowdancerRebuild,parseRebuildRequest} from '../lib/shadowdancer-rebuild.mjs';

async function fixture(t){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'sd-targeted-rebuild-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 return {cwd,conversationId:'audit-conversation',sourceRunId:'original-run'};
}
function scripted(items){
 const replies=[...items],calls=[];
 return {calls,async runAgent(options){
  const part=options.prompt.split('CURRENT_DIRECTORY:\n')[1].split('\nREPOSITORY MODE:')[0];
  const view=JSON.parse(part);
  calls.push({label:view.label,module:view.module,payload:view.payload,view,options});
  if(!replies.length)throw Error('Unexpected model call '+view.label);
  const answer=replies.shift();
  const value=typeof answer==='function'?answer(view):answer;
  return {output:typeof value==='string'?value:JSON.stringify(value),threadId:'provider-'+calls.length};
 }};
}
const integration=(answer,refs)=>({answer,used_refs:refs});
const tree=()=>({atomic:false,steps:[
 {objective:'Prepare the A result',done_when:'Produce A'},
 {objective:'Use the A result to prepare B',done_when:'Produce B',depends_on:['1']}
]});
async function initialModules(f){
 const runtime=scripted([tree(),{atomic:true},{atomic:true},
  {status:'complete',nextAction:'',finding:'A original'},{status:'complete',nextAction:'',finding:'B original'},
  integration('A and B computed',['module:1.1','module:1.2'])]);
 const runner=new ShadowdancerDirectory({...f,runId:f.sourceRunId,model:'remote::test',runtime});
 const completed=await runner.run('/directory Prepare A then compute B using A.');
 assert.equal(runtime.calls.length,6);
 return completed;
}
async function change(f,file,changes){
 const prior=await readShadowdancerFile({cwd:f.cwd,conversationId:f.conversationId,file});
 return editShadowdancerContext({...f,file,expectedHash:prior.hash,changes,
  reason:'Audited user correction',actor:'test-user'});
}
const saved=(f,runId,relative)=>path.join(f.cwd,'.shadowdancer',f.conversationId,'runs',runId,...relative.split('/'));
const get=async f=>JSON.parse(await readFile(f,'utf8'));
test('rebuild command grammar requires explicit saved source and optional revision',()=>{
 assert.deepEqual(parseRebuildRequest('REBUILD_FROM: original-run'),{sourceRunId:'original-run'});
 assert.deepEqual(parseRebuildRequest('REBUILD_FROM: original-run\nEDIT_REVISION: edit-00001'),{
  sourceRunId:'original-run',expectedEditId:'edit-00001'
 });
 assert.equal(parseRebuildRequest('REBUILD_FROM: ../other'),null);
});
test('editing one module result reuses it and reruns only declared dependent work',async t=>{
 const f=await fixture(t);await initialModules(f);
 const oldFinal=await readFile(saved(f,f.sourceRunId,'integration/final.json'),'utf8');
 const receipt=await change(f,'runs/original-run/modules/1/1.1/result.json',{finding:'A corrected by user'});
 assert.equal(receipt.editId,'edit-00001');
 const plan=await planShadowdancerRebuild(f);
 assert.deepEqual(plan.reusedModules,['1.1']);
 assert.deepEqual(plan.rerunModules,['1.2']);
 const runtime=scripted([
  view=>{
   assert.equal(view.label,'work');
   assert.equal(view.payload.objective,'Use the A result to prepare B');
   assert.ok(view.payload.imports.some(x=>x.ref==='module:1.1'&&x.finding==='A corrected by user'));
   return {status:'complete',nextAction:'',finding:'B recomputed from corrected A'};
  },
  view=>{
   assert.equal(view.label,'integration');
   assert.deepEqual(view.payload.required_refs,['module:1.1','module:1.2']);
   return integration('Corrected A and recomputed B',['module:1.1','module:1.2']);
  }
 ]);
 const fresh=new ShadowdancerDirectory({...f,runId:'rebuilt-run',model:'remote::test',runtime});
 const done=await fresh.run('/directory REBUILD_FROM: original-run\nEDIT_REVISION: edit-00001');
 assert.equal(runtime.calls.length,2,'Only the dependent work and final synthesis run');
 assert.equal(done.stats.reusedModules,1);
 assert.equal(done.stats.rerunModules,1);
 assert.match(done.answer,/Reran 1 module\(s\), reused 1 module\(s\)/);
 assert.equal(await readFile(saved(f,'original-run','integration/final.json'),'utf8'),oldFinal,
   'Original final must remain untouched');
 const reused=await get(saved(f,'rebuilt-run','modules/1/1.1/result.json'));
 const regenerated=await get(saved(f,'rebuilt-run','modules/1/1.2/result.json'));
 assert.equal(reused.finding,'A corrected by user');
 assert.equal(reused.status,'user_edited_pending_verification');
 assert.equal(regenerated.finding,'B recomputed from corrected A');
 const final=await get(saved(f,'rebuilt-run','integration/final.json'));
 assert.equal(final.rebuild.sourceRunId,'original-run');
 assert.deepEqual(final.rebuild.editIds,['edit-00001']);
 const state=await get(path.join(f.cwd,'.shadowdancer',f.conversationId,'conversation','context','invalidation.json'));
 assert.equal(state.staleRuns['original-run'].state,'rebuilt');
 assert.equal(state.staleRuns['original-run'].rebuiltBy,'rebuilt-run');
 const history=await get(path.join(f.cwd,'.shadowdancer',f.conversationId,'conversation','context','rebuilds.json'));
 assert.equal(history.length,1);
});
test('changed source page is re-extracted and unchanged source page result is reused',async t=>{
 const f=await fixture(t);
 const source='The marker is ALPHA17.'.padEnd(1150,' ')+'The marker is BETA29.'.padEnd(1080,' ');
 const original=scripted([
  {summary:'A',items:[{value:'ALPHA17',quote:'ALPHA17'}]},
  {summary:'B',items:[{value:'BETA29',quote:'BETA29'}]},
  integration('ALPHA17 and BETA29',['page:1','page:2'])
 ]);
 const older=new ShadowdancerDirectory({...f,runId:f.sourceRunId,model:'remote::test',runtime:original});
 older.sourceChunks=async text=>[text.slice(0,1150),text.slice(1150)];
 await older.run('/directory List all markers.\nSOURCE:\n'+source);
 const sourceFile='runs/original-run/sources/page-0002/source.json';
 const prior=await readShadowdancerFile({...f,file:sourceFile});
 const edit=await change(f,sourceFile,{content:prior.value.content+' The marker is GAMMA42.'});
 const plan=await planShadowdancerRebuild(f);
 assert.deepEqual(plan.reextractPages,[2]);
 assert.deepEqual(plan.reusedPages,[1]);
 const runtime=scripted([
  view=>{
   assert.equal(view.label,'page-extract');
   assert.equal(view.payload.source.page,2);
   assert.match(view.payload.source.content,/GAMMA42/);
   return {summary:'B and C',items:[{value:'BETA29',quote:'BETA29'},{value:'GAMMA42',quote:'GAMMA42'}]};
  },
  view=>integration('ALPHA17 BETA29 GAMMA42',['page:1','page:2'])
 ]);
 const rebuilt=new ShadowdancerDirectory({...f,runId:'next-run',model:'remote::test',runtime});
 const output=await rebuilt.run('/directory REBUILD_FROM: original-run\nEDIT_REVISION: '+edit.editId);
 assert.equal(runtime.calls.length,2);
 assert.equal(output.stats.reextractedPages,1);
 assert.equal(output.stats.reusedPages,1);
 const reused=await get(saved(f,'next-run','sources/page-0001/result.json'));
 const generated=await get(saved(f,'next-run','sources/page-0002/result.json'));
 assert.ok(reused.anchoredItems.includes('ALPHA17'));
 assert.ok(generated.anchoredItems.includes('GAMMA42'));
 assert.match(output.answer,/GAMMA42/);
});
test('a conversation-summary edit invalidates every work package',async t=>{
 const f=await fixture(t);await initialModules(f);
 const edit=await change(f,'conversation/context/summary.json',
  {userSummary:'User corrected the meaning of the A and B computation.'});
 const plan=await planShadowdancerRebuild(f);
 assert.equal(plan.globalChange,true);
 assert.deepEqual(plan.rerunModules,['1.1','1.2']);
 assert.deepEqual(plan.reusedModules,[]);
 await assert.rejects(()=>planShadowdancerRebuild({...f,expectedEditId:'edit-99999'}),{
  code:'DIRECTORY_REBUILD_CONFLICT'
 });
 const runtime=scripted([
  view=>{
   assert.equal(view.label,'work');
   assert.match(JSON.stringify(view.payload.contextImport),/User corrected/);
   return {status:'complete',nextAction:'',finding:'A revised'};
  },
  view=>{
   assert.equal(view.label,'work');
   assert.equal(view.payload.imports?.[0]?.finding,'A revised');
   return {status:'complete',nextAction:'',finding:'B revised'};
  },
  integration('A revised and B revised',['module:1.1','module:1.2'])
 ]);
 const runner=new ShadowdancerDirectory({...f,runId:'summary-run',model:'remote::test',runtime});
 const result=await runner.run('/directory REBUILD_FROM: original-run\nEDIT_REVISION: '+edit.editId);
 assert.equal(runtime.calls.length,3);
 assert.equal(result.stats.rerunModules,2);
 assert.match(result.answer,/A revised/);
});
test('multiple audited edits preserve an upstream override but recompute its dependent even when separately edited',async t=>{
 const f=await fixture(t);await initialModules(f);
 const first=await change(f,'runs/original-run/modules/1/1.1/result.json',{finding:'A first edit'});
 const second=await change(f,'runs/original-run/modules/1/1.2/result.json',{finding:'B second edit'});
 assert.equal(first.editId,'edit-00001');assert.equal(second.editId,'edit-00002');
 const plan=await planShadowdancerRebuild(f);
 assert.deepEqual(plan.editIds,['edit-00001','edit-00002']);
 assert.deepEqual(plan.reusedModules,['1.1']);
 assert.deepEqual(plan.rerunModules,['1.2']);
 const runtime=scripted([
  view=>{
   assert.equal(view.label,'work');
   assert.ok(view.payload.imports.some(x=>x.finding==='A first edit'));
   return {status:'complete',nextAction:'',finding:'B recomputed after both edits'};
  },
  integration('Current A and recomputed B',['module:1.1','module:1.2'])
 ]);
 const runner=new ShadowdancerDirectory({...f,runId:'second-rebuild',runtime,model:'remote::test'});
 const completed=await runner.run('/directory REBUILD_FROM: original-run\nEDIT_REVISION: edit-00002');
 assert.equal(runtime.calls.length,2);
 assert.equal(completed.stats.rerunModules,1);
 assert.equal((await get(saved(f,'second-rebuild','modules/1/1.2/result.json'))).finding,
   'B recomputed after both edits');
});
test('old run without a pending Context revision cannot be silently rebuilt',async t=>{
 const f=await fixture(t);await initialModules(f);
 await assert.rejects(()=>planShadowdancerRebuild(f),{code:'DIRECTORY_REBUILD_NOT_STALE'});
});
