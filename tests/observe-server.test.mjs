import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const until=async(check,label='Observe condition')=>{const end=Date.now()+7000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(`${label} did not settle`);};
const graph=()=>({id:'observe-fixture',name:'Observe server fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Fixture worker',model:'observe-fixture-model',prompt:'Wait while the fixture changes its own temporary files.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}});
class Desktop extends EventEmitter{status(){return{available:false,enabled:false};}async setEnabled(){return this.status();}}
async function fixture(t,{nestedData=false}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'relay-observe-server-')),cwd=path.join(directory,'workspace'),dataDir=nestedData?path.join(cwd,'relay-local-data'):path.join(directory,'data'),entered=deferred(),finish=deferred();await mkdir(cwd,{recursive:true});
  class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[{model:'observe-fixture-model'}],defaultModel:'observe-fixture-model'};}async start(){return this.status();}async close(){}async runAgent(options){entered.resolve();await Promise.race([finish.promise,new Promise((resolve,reject)=>{if(options.signal.aborted)return reject(Object.assign(Error('Fixture cancelled'),{name:'AbortError'}));options.signal.addEventListener('abort',()=>reject(Object.assign(Error('Fixture cancelled'),{name:'AbortError'})),{once:true});})]);return{output:'Observed isolated fixture.',threadId:'observe-fixture-thread'};}}
  const app=await createHarnessServer({port:0,dataDir,defaultCwd:cwd,runtime:new Runtime(),desktop:new Desktop()});await app.learning.updateSettings({mode:'manual'});app.liveEdits.pollMs=25;app.liveEdits.debounceMs=10;
  const url=await app.listen(),home=await fetch(url),cookie=home.headers.get('set-cookie').split(';',1)[0];await home.arrayBuffer();const streams=[];
  t.after(async()=>{for(const stream of streams)stream.close();finish.resolve();await app.close();assert.match(path.basename(directory),/^relay-observe-server-/);await rm(directory,{recursive:true,force:true});});
  const run=app.engine.startRun({workflow:graph(),input:'Watch only actual isolated fixture changes.'});await entered.promise;
  async function observe({authenticated=true}={}){
    const target=new URL(`/api/runs/${run.id}/observe`,url),events=[],chunks=[];let req,response,buffer='';
    const opened=new Promise((resolve,reject)=>{req=http.get(target,{headers:authenticated?{Cookie:cookie}:{}},res=>{response=res;res.setEncoding('utf8');res.on('data',chunk=>{chunks.push(chunk);buffer+=chunk;let index;while((index=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,index);buffer=buffer.slice(index+2);const data=frame.split('\n').filter(line=>line.startsWith('data: ')).map(line=>line.slice(6)).join('\n');if(data)events.push(JSON.parse(data));}});res.on('error',()=>{});resolve(res);});req.on('error',reject);});
    await opened;const stream={get status(){return response.statusCode;},events,chunks,wait:type=>until(()=>events.find(event=>event.type===type),type),close(){response?.destroy();req?.destroy();}};streams.push(stream);return stream;
  }
  return{app,url,cookie,cwd,dataDir,run,finish,observe};
}

test('Observe requires the local session, and a running task never collects an edit journal without a watcher',async t=>{
  const {app,cwd,run,observe}=await fixture(t);const denied=await observe({authenticated:false});assert.equal(denied.status,401);await writeFile(path.join(cwd,'unobserved.txt'),'Changed while no one was watching.\n');await new Promise(resolve=>setTimeout(resolve,60));assert.equal(app.liveEdits.runs.size,0);assert.equal(app.liveEdits.snapshot(run.id),null);assert.ok(!app.engine.getRun(run.id).events.some(event=>event.type==='run.edit'||event.data?.type==='run.edit'));
});

test('an authenticated Observe stream receives only actual filesystem changes and releases all journal memory on close',async t=>{
  const {app,cwd,run,observe}=await fixture(t);await writeFile(path.join(cwd,'proof.txt'),'Original fixture.\n');const stream=await observe();assert.equal(stream.status,200);const ready=await stream.wait('observe.ready');assert.equal(ready.data.sequence,0);const state=app.liveEdits.runs.get(run.id);assert.ok(state.active);assert.ok(state.baseline.size>0);
  await writeFile(path.join(cwd,'proof.txt'),'Actually changed fixture.\n');await app.liveEdits.flush(run.id);const edit=await stream.wait('run.edit');assert.equal(edit.data.source,'filesystem');assert.equal(edit.data.path,'proof.txt');assert.equal(edit.data.change,'modified');assert.notEqual(edit.data.beforeHash,edit.data.afterHash);assert.match(JSON.stringify(edit.data.diff),/Actually changed fixture/);assert.match(JSON.stringify(edit.data.diff),/Original fixture/);
  stream.close();await until(()=>app.liveEdits.runs.size===0,'last subscriber releases journal');assert.equal(state.active,false);assert.equal(state.baseline.size,0);assert.equal(state.events.length,0);assert.equal(state.bytes,0);await writeFile(path.join(cwd,'proof.txt'),'After Observe was closed.\n');await new Promise(resolve=>setTimeout(resolve,40));assert.equal(app.liveEdits.runs.size,0);
});

test('multiple observers share one watcher, and reopening establishes a fresh baseline without replaying old edit payloads',async t=>{
  const {app,cwd,run,observe}=await fixture(t);await writeFile(path.join(cwd,'sequence.txt'),'Before first view.\n');const first=await observe();await first.wait('observe.ready');const second=await observe();await second.wait('observe.ready');const initial=app.liveEdits.runs.get(run.id);assert.equal(app.liveEdits.runs.size,1);
  first.close();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(app.liveEdits.runs.get(run.id),initial);assert.equal(initial.active,true);await writeFile(path.join(cwd,'sequence.txt'),'Only old view should contain this payload.\n');await app.liveEdits.flush(run.id);await second.wait('run.edit');second.close();await until(()=>app.liveEdits.runs.size===0,'all observers closed');
  await writeFile(path.join(cwd,'sequence.txt'),'Fresh view baseline.\n');const fresh=await observe();const ready=await fresh.wait('observe.ready');assert.equal(ready.data.sequence,0);assert.notEqual(app.liveEdits.runs.get(run.id),initial);assert.deepEqual(app.liveEdits.snapshot(run.id).events,[]);assert.ok(!fresh.chunks.join('').includes('Only old view should contain this payload'));
  await writeFile(path.join(cwd,'sequence.txt'),'A new observed change.\n');await app.liveEdits.flush(run.id);const event=await fresh.wait('run.edit');assert.equal(event.data.sequence,1);assert.match(JSON.stringify(event.data.diff),/Fresh view baseline/);assert.ok(!JSON.stringify(event.data).includes('Only old view should contain this payload'));
});

test('an overflowing Observe viewer is detached without dropping a healthy viewer, and the final overflow releases the journal',async t=>{
  const {app,cwd,run,observe}=await fixture(t),responses=[];
  // Exercise the real HTTP response and watcher lifecycle with a deterministic
  // full send queue; kernel socket capacity otherwise varies across machines.
  app.server.prependListener('request',(request,response)=>{if(request.url===`/api/runs/${run.id}/observe`)responses.push(response);});
  await writeFile(path.join(cwd,'bounded.txt'),'Before observation.\n');
  const first=await observe();await first.wait('observe.ready');
  const second=await observe();await second.wait('observe.ready');
  assert.equal(responses.length,2);const journal=app.liveEdits.runs.get(run.id);
  Object.defineProperty(responses[0],'writableLength',{get:()=>8*1024*1024,configurable:true});
  await writeFile(path.join(cwd,'bounded.txt'),'The healthy viewer receives this change.\n');await app.liveEdits.flush(run.id);
  await second.wait('run.edit');assert.equal(responses[0].destroyed,true);assert.equal(responses[1].destroyed,false);assert.equal(journal.active,true);
  Object.defineProperty(responses[1],'writableLength',{get:()=>8*1024*1024,configurable:true});
  await writeFile(path.join(cwd,'bounded.txt'),'The final slow viewer is disconnected.\n');await app.liveEdits.flush(run.id);
  await until(()=>app.liveEdits.runs.size===0,'overflow releases final watcher');
  assert.equal(responses[1].destroyed,true);assert.equal(journal.active,false);assert.equal(journal.baseline.size,0);assert.equal(journal.events.length,0);assert.equal(journal.bytes,0);
});

test('Observe excludes Relay data nested inside the selected workspace',async t=>{
  const {app,cwd,dataDir,run,observe}=await fixture(t,{nestedData:true});await writeFile(path.join(dataDir,'private-history.txt'),'Private retained task content.\n');const stream=await observe();await stream.wait('observe.ready');await writeFile(path.join(dataDir,'private-history.txt'),'Private retained task content changed.\n');await writeFile(path.join(cwd,'public-result.txt'),'Actual workspace change.\n');await app.liveEdits.flush(run.id);await stream.wait('run.edit');const journal=app.liveEdits.snapshot(run.id);assert.ok(journal.events.some(event=>event.path==='public-result.txt'));assert.ok(journal.events.every(event=>!event.path.startsWith('relay-local-data/')));assert.ok([...app.liveEdits.runs.get(run.id).baseline.keys()].every(file=>!file.startsWith('relay-local-data/')));assert.ok(!stream.chunks.join('').includes('Private retained task content'));
});

test('a quick close and reopen waits for old cleanup and cannot delete the newly opened journal',async t=>{
  const {app,cwd,run,observe}=await fixture(t),entered=deferred(),release=deferred(),realpath=fs.realpath,start=app.liveEdits.start.bind(app.liveEdits),signals=[];let delayed=false;
  app.liveEdits.start=(id,options)=>{signals.push(options.signal);return start(id,options);};
  // Hold the actual first filesystem admission before the journal owns a state.
  // Closing here used to let that late start overwrite a replacement watcher.
  fs.realpath=async(...args)=>{const resolved=await realpath(...args);if(!delayed&&args[0]===path.resolve(cwd)){delayed=true;entered.resolve();await release.promise;}return resolved;};
  let fresh;try{const first=await observe();await entered.promise;first.close();await until(()=>signals[0]?.aborted,'old subscriber cancellation');fresh=await observe();await new Promise(resolve=>setTimeout(resolve,20));release.resolve();await fresh.wait('observe.ready');await new Promise(resolve=>setTimeout(resolve,25));const current=app.liveEdits.runs.get(run.id);assert.ok(current?.active,'a late closed startup must not overwrite or delete its replacement');
    await writeFile(path.join(cwd,'reopened.txt'),'The new watcher is still active.\n');await app.liveEdits.flush(run.id);const edit=await fresh.wait('run.edit');assert.equal(edit.data.path,'reopened.txt');
  }finally{release.resolve();fs.realpath=realpath;}
});

test('task settlement and server shutdown stop active Observe streams and discard their journals',async t=>{
  const first=await fixture(t),watch=await first.observe();await watch.wait('observe.ready');first.finish.resolve();const stopped=await watch.wait('observe.stopped');assert.match(stopped.data.reason,/finished/i);await until(()=>first.app.liveEdits.runs.size===0,'settled task releases observation');const completed=await first.observe();assert.match((await completed.wait('observe.stopped')).data.reason,/finished/i);assert.equal(first.app.liveEdits.runs.size,0);
  const second=await fixture(t),active=await second.observe();await active.wait('observe.ready');await second.app.close();assert.equal(second.app.liveEdits.runs.size,0);assert.equal(second.app.liveEdits.closed,true);assert.match((await active.wait('observe.stopped')).data.reason,/closing/i);
});
