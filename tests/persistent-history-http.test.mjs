import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const nextIO=()=>new Promise(resolve=>setImmediate(resolve));
const context={preset:'model',autoCompact:false,effectiveWindowTokens:258400,compactionCount:1};
class Runtime extends EventEmitter {
  constructor(){super();this.entered=deferred();this.release=deferred();this.calls=[];this.generationCalls=0;}
  status(){return {connected:true,authenticated:true,defaultModel:'fixture-native'};}
  async start(){return this.status();}
  async close(){}
  async runAgent(options){this.generationCalls++;options.onEvent({type:'thread',threadId:options.threadId||'persistent-http-'+this.generationCalls});return {output:'ASSISTANT_'+this.generationCalls,threadId:options.threadId||'persistent-http-'+this.generationCalls};}
  async compactThread(threadId,options){this.calls.push({threadId,...options});this.entered.resolve();await this.release.promise;options.onEvent({type:'context',context});return {compacted:true,method:'codex-native',threadId,context};}
  async compactHistory(){assert.fail('Current sessions must not use retired history migration.');}
}
class NoDesktop extends EventEmitter {status(){return {available:false,enabled:false};}async setEnabled(){return this.status();}}
const workflow={id:'persistent-http-fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Agent',model:'fixture-native',prompt:'Follow the request.',context:{preset:'model',autoCompact:false}},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}};
const visibleHistory=run=>({input:run.input,output:run.output,agentOutput:run.nodes.agent.output});
test('HTTP compact retains current thread and archived lineage and awaits native completion plus archive persistence',{timeout:15000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-persistent-http-')),cwd=path.join(directory,'workspace'),dataDir=path.join(directory,'data');await mkdir(cwd);
  const runtime=new Runtime(),archiveEntered=deferred(),archiveRelease=deferred();let app,operation;
  t.after(async()=>{runtime.release.resolve();archiveRelease.resolve();app?.engine.cancelCompactions();await operation?.catch(()=>{});await app?.close();assert.match(path.basename(directory),/^blackice-persistent-http-/);await rm(directory,{recursive:true,force:true});});
  app=await createHarnessServer({runtime,desktop:new NoDesktop(),port:0,dataDir,defaultCwd:cwd,autoAttachDesktop:false,remoteAccess:false});
  const url=await app.listen(),home=await fetch(url),cookie=home.headers.get('set-cookie').split(';',1)[0];await home.arrayBuffer();
  const api=async(route,body)=>{const response=await fetch(new URL(route,url),{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const settle=async run=>{await app.engine.executions.get(run.id);const value=app.engine.getRun(run.id);assert.equal(value.status,'completed',value.error);await app.conversations.capture(value);return value;};
  const first=await settle(app.engine.startRun({workflow,input:'USER_ancestor'}));
  const latest=await settle(app.engine.continueRun(first.id,{nodeId:'agent',message:'USER_latest'}));
  const unrelated=await settle(app.engine.startRun({workflow,input:'USER_unrelated'}));
  app.engine.runs.delete(first.id);await app.engine.persist();
  assert.deepEqual((await app.conversations.family(latest.id)).runs.map(run=>run.id),[first.id,latest.id]);
  const ancestorFile=path.join(app.conversations.directory,first.id+'.json'),ancestorBytes=await readFile(ancestorFile),unrelatedFile=path.join(app.conversations.directory,unrelated.id+'.json'),unrelatedBytes=await readFile(unrelatedFile);
  const before=await app.conversations.readFile(latest.id),originalHistory=visibleHistory(before),savedThread=latest.nodes.agent.threadId;
  const capture=app.conversations.capture.bind(app.conversations);
  app.conversations.capture=async value=>{if(value.id===latest.id&&value.nodes.agent.lastCompaction?.compacted){archiveEntered.resolve();await archiveRelease.promise;}return capture(value);};
  let settled=false;operation=api('/api/runs/'+latest.id+'/compact',{nodeId:'agent'}).finally(()=>settled=true);
  const premature=operation.then(response=>assert.fail('HTTP compact returned before durable archive checkpoint: '+JSON.stringify(response)));
  await Promise.race([runtime.entered.promise,premature]);await nextIO();assert.equal(settled,false);
  assert.equal(runtime.calls.length,1);assert.equal(runtime.calls[0].threadId,savedThread);assert.equal(runtime.calls[0].context.autoCompact,false);
  runtime.release.resolve();await Promise.race([archiveEntered.promise,premature]);await nextIO();assert.equal(settled,false,'Native completion must wait for archive save');
  const pending=await app.conversations.readFile(latest.id);assert.deepEqual(visibleHistory(pending),originalHistory);assert.equal(pending.nodes.agent.lastCompaction,undefined);
  archiveRelease.resolve();const response=await operation;assert.equal(response.status,200);assert.equal(response.data.compacted,true);assert.equal(response.data.threadId,savedThread);
  const archived=await app.conversations.readFile(latest.id);assert.deepEqual(visibleHistory(archived),originalHistory);assert.equal(archived.nodes.agent.threadId,savedThread);assert.equal(archived.nodes.agent.lastCompaction.compacted,true);assert.deepEqual(archived.nodes.agent.contextStatus,context);
  for(const event of before.events)assert.ok(archived.events.some(value=>JSON.stringify(value)===JSON.stringify(event)),'Existing messages/events must remain');
  assert.deepEqual(await readFile(ancestorFile),ancestorBytes);assert.deepEqual(await readFile(unrelatedFile),unrelatedBytes);
  assert.equal(runtime.generationCalls,3,'Compaction starts no generation or replay');
  const persistConversation=app.engine.persistConversation;
  app.engine.persistConversation=async()=>{throw Error('Fixture archive write failed');};
  const failed=await api('/api/runs/'+latest.id+'/compact',{nodeId:'agent'});
  assert.notEqual(failed.status,200);assert.match(failed.data.error,/Fixture archive write failed/);
  assert.equal(app.engine.controllers.has('compact-'+latest.id),false);assert.equal(app.engine.executions.has('compact-'+latest.id),false);
  assert.equal(app.engine.getRun(latest.id).nodes.agent.lastCompaction.compacted,true,'A completed native effect is retained even if its archive save fails');
  app.engine.persistConversation=persistConversation;
  const cancellationEntered=deferred();
  runtime.compactThread=async(_threadId,options)=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(Object.assign(Error('Fixture native compression stopped'),{name:'AbortError',code:'ABORT_ERR'})),{once:true});cancellationEntered.resolve();});
  operation=api('/api/runs/'+latest.id+'/compact',{nodeId:'agent'});
  await cancellationEntered.promise;assert.equal(app.engine.cancelCompactions(),1);
  const cancelled=await operation;assert.notEqual(cancelled.status,200);assert.match(cancelled.data.error,/stopped/);
  assert.equal(app.engine.controllers.has('compact-'+latest.id),false);assert.equal(app.engine.executions.has('compact-'+latest.id),false);
  assert.deepEqual(visibleHistory(await app.conversations.readFile(latest.id)),originalHistory);
  assert.equal(runtime.generationCalls,3);

});
