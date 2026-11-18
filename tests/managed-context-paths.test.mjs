import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {managedContextPaths,RELEASE_SKILL_FILE} from '../lib/managed-context-paths.mjs';
import {createWorkspaceToolHandler} from '../lib/workspace-tools.mjs';
import {FilePatchStore} from '../lib/file-patches.mjs';
const parse=r=>JSON.parse(r.contentItems[0].text);
test('managed stores include active snapshots, approval queue, backups and identity history without blanket filename protection',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-managed-paths-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=path.join(root,'data'),cwd=path.join(root,'project');await mkdir(dataDir);await mkdir(cwd);
 const protectedPaths=managedContextPaths({dataDir});const patchStore=new FilePatchStore({dataDir:path.join(root,'patches')});t.after(()=>patchStore.close());
 const h=createWorkspaceToolHandler({cwd,patchStore,protectedPaths});let count=0;
 for(const file of ['user-todos.json','user-todos.json.lock','user-todos.json.12345678-1234-1234-1234-123456789abc.tmp','user-workflows.json','user-workflows.json.lock','user-workflows.json.12345678-1234-1234-1234-123456789abc.tmp','knowledge.json','knowledge.json.bak','knowledge.json.12345678-1234-1234-1234-123456789abc.tmp','knowledge.json.12345678-1234-1234-1234-123456789abc.bak.tmp','knowledge-approvals.json.12345678-1234-1234-1234-123456789abc.tmp','learning.json.12345678-1234-1234-1234-123456789abc.tmp','knowledge-approvals.json','knowledge-folders.json','learning.json','learning.json.bak','identity/USER.md','identity/history/user-1.json']) {
  const target=path.join(dataDir,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'owner text');
  for(const args of [{action:'write',path:target,text:'changed'},{action:'patch',path:target,oldText:'owner',newText:'model'}]) {
   const result=await h({name:'relay_workspace',arguments:args},{onOperationDispatch:()=>count++});assert.equal(result.success,false);assert.equal(parse(result).code,'WORKSPACE_PROTECTED_PATH');assert.equal(parse(result).actionDispatched,false);
  }
  const receipt=await patchStore.patch({cwd,path:target,oldText:'owner',newText:'human'});
  const undo=await h({name:'relay_workspace',arguments:{action:'undo_patch',patchId:receipt.id}});assert.equal(parse(undo).code,'WORKSPACE_PROTECTED_PATH');assert.equal(await readFile(target,'utf8'),'human text');
 }
 assert.equal(count,0);
 assert.equal((await h({name:'relay_workspace',arguments:{action:'write',path:path.join(dataDir,'knowledge.json.notes'),text:'unmanaged neighboring artifact'}})).success,true);
 assert.equal((await h({name:'relay_workspace',arguments:{action:'write',path:path.join(cwd,'knowledge.json'),text:'ordinary project artifact'}})).success,true);
});
test('custom store locations override defaults and do not protect the whole workspace',()=>{
 const root=path.resolve('fixture'),identity={directory:path.join(root,'custom-identity')},knowledge={file:path.join(root,'custom-k.json'),approvalsFile:path.join(root,'queue.json'),organizationFile:path.join(root,'folders.json'),lockDirectory:path.join(root,'lock')},learning={file:path.join(root,'learn.json')};
 const paths=managedContextPaths({dataDir:root,identity,knowledge,learning});
 for(const file of [identity.directory,knowledge.file,knowledge.approvalsFile,knowledge.organizationFile,knowledge.lockDirectory,learning.file,learning.file+'.bak'])assert.ok(paths.includes(file));
 assert.ok(!paths.includes(root));assert.ok(!paths.includes(path.join(root,'knowledge.json')));
});


test('production engine passes managed store guards into the actual model file handler',async t=>{
 const {HarnessEngine}=await import('../lib/engine.mjs');const {EventEmitter}=await import('node:events');
 const root=await mkdtemp(path.join(tmpdir(),'blackice-managed-engine-')),cwd=path.join(root,'work'),dataDir=path.join(root,'data');await mkdir(cwd);await mkdir(dataDir);const target=path.join(dataDir,'knowledge.json');await writeFile(target,'owner bytes');
 let observed;
 class Runtime extends EventEmitter {
  store={get:()=>({baseUrl:'https://api.example/v1'})};
  status(){return {connected:true,authenticated:true,defaultModel:'fixture::remote',models:[{id:'fixture::remote',supportsTools:true}]};}
  async runAgent(options){observed=await options.onToolCall({name:'relay_workspace',arguments:{action:'write',path:target,text:'unapproved'}});return {output:'Managed write was blocked.',threadId:'managed-fixture'};}
 }
 const engine=await new HarnessEngine({runtime:new Runtime(),dataDir,defaultCwd:cwd}).init();engine.runtimeSettings={get:()=>({subagentsEnabled:false,executionGuardrails:false})};
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 const workflow={name:'Managed guard',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture::remote',prompt:'Try the fixture file write.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off'}};
 const run=engine.startRun({workflow,input:{task:'Fixture write',directoryMode:'off'}});await engine.executions.get(run.id);assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);assert.equal(observed.success,false);assert.equal(parse(observed).code,'WORKSPACE_PROTECTED_PATH');assert.equal(await readFile(target,'utf8'),'owner bytes');
});

test('installed release skill file is protected before write, patch or undo dispatch without blanket source-directory blocking',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-release-skill-guard-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const bytes=await readFile(RELEASE_SKILL_FILE,'utf8');let dispatched=0;
 const patchStore={get:async()=>({path:RELEASE_SKILL_FILE}),undo:async()=>{throw Error('Undo dispatched');}};
 const h=createWorkspaceToolHandler({cwd:root,patchStore,protectedPaths:managedContextPaths({dataDir:root})});
 for(const args of [{action:'write',path:RELEASE_SKILL_FILE,text:'poison'},{action:'patch',path:RELEASE_SKILL_FILE,oldText:'Release',newText:'poison'},{action:'undo_patch',patchId:'release-fixture'}]){
  const result=await h({name:'relay_workspace',arguments:args},{onOperationDispatch:()=>dispatched++});assert.equal(result.success,false);assert.equal(parse(result).code,'WORKSPACE_PROTECTED_PATH');
 }
 assert.equal(dispatched,0);assert.equal(await readFile(RELEASE_SKILL_FILE,'utf8'),bytes);
 assert.equal((await h({name:'relay_workspace',arguments:{action:'write',path:'release-skills.mjs',text:'ordinary unrelated project file'}})).success,true);
});
