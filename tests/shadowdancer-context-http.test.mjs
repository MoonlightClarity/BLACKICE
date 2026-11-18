import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {handleShadowdancerContextHttp} from '../lib/shadowdancer-context-http.mjs';
import {readShadowdancerFile,editShadowdancerContext,listShadowdancerContext,contextAuditHistory} from '../lib/shadowdancer-context.mjs';
import {createShadowdancerContextToolHandler} from '../lib/shadowdancer-context-tool.mjs';

async function fixture(t){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-context-boundary-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const root=path.join(cwd,'.blackice','directory','chat'),file='conversation/context/summary.json';
 await mkdir(path.dirname(path.join(root,file)),{recursive:true});
 await writeFile(path.join(root,file),JSON.stringify({currentRun:'run',userSummary:'Original'}));
 await mkdir(path.join(root,'runs','run','integration'),{recursive:true});
 await writeFile(path.join(root,'runs','run','integration','final.json'),JSON.stringify({answer:'Historical'}));
 const run={id:'run',taskId:'chat',cwd,settled:true,status:'completed'};
 const state={value:'active'},engine={runs:new Map([['run',run]])},mutations=new Set();
 const conversations={status:()=>({}),get:async id=>{if(!['chat','run'].includes(id))throw Object.assign(Error('Not found'),{status:404});return run;},
 list:()=>[{rootId:'chat',id:'run',latestRunId:'run',title:'Title',state:state.value}]};
 const ctx={cwd,conversationId:'chat',file};
 async function request(suffix='',method='GET',value){
  const req={url:'/api/shadowdancer/context'+suffix,method},res={};
  await handleShadowdancerContextHttp({req,res,pathname:req.url.split('?')[0],host:'localhost',conversations,engine,body:async()=>value,json:(_,status,data)=>Object.assign(res,{status,data}),fileMutations:mutations});
  return res;
 }
 return {cwd,root,file,ctx,run,state,engine,conversations,request,mutations};
}

test('corrupt audit/invalidation fails closed without overwriting evidence',async t=>{
 const f=await fixture(t),prior=await readShadowdancerFile(f.ctx);
 const audit=path.join(f.root,'conversation/context/audit.json');
 await writeFile(audit,'broken');
 await assert.rejects(contextAuditHistory(f.ctx),{code:'SHADOWDANCER_INVALID_FILE'});
 await assert.rejects(editShadowdancerContext({...f.ctx,expectedHash:prior.hash,changes:{userSummary:'No'},reason:'Test'}),{code:'SHADOWDANCER_INVALID_FILE'});
 assert.deepEqual(JSON.parse(await readFile(path.join(f.root,f.file),'utf8')),prior.value);
 await writeFile(audit,'[]');
 await writeFile(path.join(f.root,'conversation/context/invalidation.json'),'broken');
 await assert.rejects(editShadowdancerContext({...f.ctx,expectedHash:prior.hash,changes:{userSummary:'No'},reason:'Test'}),{code:'SHADOWDANCER_INVALID_FILE'});
 assert.deepEqual(JSON.parse(await readFile(path.join(f.root,f.file),'utf8')),prior.value);
});
test('paths reject traversal, drive syntax and alternate data streams',async t=>{
 const f=await fixture(t);
 for(const file of ['../x','C:/x','conversation/context/summary.json:secret','/x','a\\b','a//b'])
  await assert.rejects(readShadowdancerFile({...f.ctx,file}),{code:'SHADOWDANCER_PATH'});
});
test('junction parents cannot expose unrelated context files',async t=>{
 const f=await fixture(t),outside=path.join(f.cwd,'outside');
 await mkdir(outside);await writeFile(path.join(outside,'secret.json'),'{"secret":true}');
 await symlink(outside,path.join(f.root,'escape'),'junction');
 await assert.rejects(readShadowdancerFile({...f.ctx,file:'escape/secret.json'}),{code:'SHADOWDANCER_PATH'});
 const alias=path.join(f.cwd,'alias');await symlink(path.join(f.cwd,'.blackice','directory'),alias,'junction');
 await assert.rejects(listShadowdancerContext({cwd:alias,conversationId:'chat'}),{code:'SHADOWDANCER_PATH'});
});
test('existing revision paths cannot be overwritten',async t=>{
 const f=await fixture(t),prior=await readShadowdancerFile(f.ctx);
 await mkdir(path.join(f.root,'conversation/context/revisions/edit-00001'),{recursive:true});
 await assert.rejects(editShadowdancerContext({...f.ctx,expectedHash:prior.hash,changes:{userSummary:'No'},reason:'Test'}),{code:'SHADOWDANCER_AUDIT'});
 assert.equal((await readShadowdancerFile(f.ctx)).hash,prior.hash);
});
test('tool excludes deleted titles, permits archived context edits, and blocks active own-run mutation',async t=>{
 const f=await fixture(t);
 const handler=createShadowdancerContextToolHandler({conversations:f.conversations,cwd:f.cwd,runId:'run',taskId:'chat',getActiveRuns:()=>[...f.engine.runs.values()]});
 const call=async args=>handler({name:'relay_context',arguments:args});
 f.state.value='deleted';
 const search=await call({action:'search_titles'});assert.equal(JSON.parse(search.contentItems[0].text).conversations.length,0);
 assert.equal((await call({action:'current'})).success,false);
 f.state.value='archived';const prior=await readShadowdancerFile(f.ctx);
 const edit={action:'edit',file:f.file,expectedHash:prior.hash,changes:{userSummary:'No'},reason:'Test'};
 assert.equal((await call(edit)).success,true);assert.equal(f.state.value,'archived');
 f.state.value='active';f.run.status='running';f.run.settled=false;
 assert.equal((await call(edit)).code,'SHADOWDANCER_RUN_ACTIVE');
});
