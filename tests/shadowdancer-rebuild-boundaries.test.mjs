import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {planShadowdancerRebuild,executeShadowdancerRebuild} from '../lib/shadowdancer-rebuild.mjs';
import {previewShadowdancerRebuild,startShadowdancerRebuild} from '../lib/shadowdancer-rebuild-actions.mjs';
const put=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));};
async function fixture(t){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'sd-rebuild-boundaries-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const scope={cwd,conversationId:'chat',sourceRunId:'original'},root=path.join(cwd,'.shadowdancer/chat'),source=path.join(root,'runs/original');
 const file='conversation/context/summary.json',summary={currentRun:'original',request:'Find code',userSummary:'Corrected'};
 await put(path.join(root,file),summary);
 await put(path.join(source,'integration/final.json'),{answer:'Old'});
 await put(path.join(source,'request.json'),{request:'Find code'});
 await put(path.join(source,'sources/page-0001/source.json'),{page:1,content:'CODE'});
 await put(path.join(source,'sources/page-0001/result.json'),{summary:'CODE',items:[]});
 const edit={id:'edit-00001',status:'committed',affectedRuns:['original'],file,afterHash:createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')};
 await put(path.join(root,'conversation/context/audit.json'),[edit]);
 await put(path.join(root,'conversation/context/invalidation.json'),{staleRuns:{original:{state:'stale',editId:edit.id}}});
 return {scope,cwd,root,source,edit};
}
test('rebuild rejects absolute, ADS, empty and foreign audit paths before file reads',async t=>{
 const f=await fixture(t);
 for(const file of ['/x','C:/x','conversation/context/summary.json:ads','conversation//context/summary.json','../x','runs/other/sources/page-0001/source.json','runs/original/sources/page-0001/nested/source.json']){
  await put(path.join(f.root,'conversation/context/audit.json'),[{...f.edit,file}]);
  await assert.rejects(planShadowdancerRebuild(f.scope),{code:'DIRECTORY_REBUILD_EDIT_SCOPE'},file);
 }
});
test('rebuild read paths reject parent junctions for source, audit, modules and pages',async t=>{
 for(const relative of ['runs/original/integration','conversation/context','runs/original/modules','runs/original/sources']){
  const f=await fixture(t),target=path.join(f.root,relative),outside=path.join(f.cwd,'outside');
  await mkdir(target,{recursive:true});await rename(target,outside);await symlink(outside,target,'junction');
  await assert.rejects(planShadowdancerRebuild(f.scope),{code:'SHADOWDANCER_PATH'},relative);
 }
});
test('rebuild actions validate conversation scope before automatic source reads',async t=>{
 const f=await fixture(t);
 await assert.rejects(previewShadowdancerRebuild({...f.scope,sourceRunId:undefined,conversationId:'../chat'}),{code:'DIRECTORY_REBUILD_SCOPE'});
 const context=path.join(f.root,'conversation/context'),outside=path.join(f.cwd,'outside');
 await rename(context,outside);await symlink(outside,context,'junction');
 await assert.rejects(previewShadowdancerRebuild({...f.scope,sourceRunId:undefined}),{code:'SHADOWDANCER_PATH'});
});
test('start rebuild awaits actual continuation receipt and propagates rejection',async t=>{
 const f=await fixture(t),previous={id:'original',taskId:'chat',cwd:f.cwd,status:'completed',settled:true,workflow:{nodes:[{id:'agent',type:'agent'}]},nodes:{agent:{}}};
 let calls=0;
 const engine={runs:new Map([['original',previous]]),continueRun:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return {id:'new-run',status:'running'};}};
 const result=await startShadowdancerRebuild({...f.scope,engine});
 assert.equal(calls,1);assert.equal(result.runId,'new-run');assert.equal(result.status,'running');
 engine.continueRun=async()=>{throw Object.assign(Error('Dispatch blocked'),{code:'BLOCKED'});};
 await assert.rejects(startShadowdancerRebuild({...f.scope,engine}),{code:'BLOCKED'});
});
test('rebuild refuses output parent junction before opening or writing engine directory',async t=>{
 const f=await fixture(t),outside=path.join(f.cwd,'outside'),turnRoot=path.join(f.root,'runs/new-run');
 await mkdir(outside);await symlink(outside,turnRoot,'junction');
 let opened=false;
 const engine={...f.scope,runId:'new-run',turnRoot,context:path.join(f.root,'conversation/context'),modules:path.join(turnRoot,'modules'),open:async()=>{opened=true;}};
 await assert.rejects(executeShadowdancerRebuild(engine,{sourceRunId:'original'}),{code:'SHADOWDANCER_PATH'});
 assert.equal(opened,false);
 assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(outside)),[]);
});
test('rebuild checks write parent again after engine setup',async t=>{
 const f=await fixture(t),outside=path.join(f.cwd,'outside'),turnRoot=path.join(f.root,'runs/new-run');
 await mkdir(outside);
 const engine={...f.scope,runId:'new-run',turnRoot,context:path.join(f.root,'conversation/context'),modules:path.join(turnRoot,'modules'),open:async()=>{await symlink(outside,turnRoot,'junction');}};
 await assert.rejects(executeShadowdancerRebuild(engine,{sourceRunId:'original'}),{code:'SHADOWDANCER_PATH'});
 assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(outside)),[]);
});
