import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

const held=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Runtime extends EventEmitter {
  status(){return{connected:false,authenticated:false,activeTurns:0,models:[]};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){assert.fail('Starting the local UI cannot start a model.');}
}
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-local-startup-'));
  const entered=held(),finish=held(),closeEntered=held(),remote=new EventEmitter();
  Object.assign(remote,{state:'disabled',closed:false,readyTransitions:0,
    async init(){return this;},attachConnector(value){this.connector=value;},
    status(){return{available:true,configuredEnabled:true,enabled:this.state==='ready',state:this.state,mode:'public',url:null};},
    async attach({origin}){this.origin=origin;this.state='starting';entered.resolve();try{await finish.promise;if(!this.closed){this.state='ready';this.readyTransitions++;}}catch(error){this.state='error';throw error;}return this.status();},
    async close(){this.closed=true;this.state='disabled';closeEntered.resolve();},
  });
  const app=await createHarnessServer({port:0,dataDir:path.join(directory,'data'),defaultCwd:path.join(directory,'workspace'),runtime:new Runtime(),remoteAccess:remote,autoAttachDesktop:false});
  t.after(async()=>{finish.resolve();await app.close();assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.match(path.basename(directory),/^blackice-local-startup-/);await rm(directory,{recursive:true,force:true});});
  const get=async(origin,route)=>{
    const home=await fetch(origin+'/'),cookie=home.headers.get('set-cookie').split(';')[0];await home.arrayBuffer();
    const response=await fetch(origin+route,{headers:{Cookie:cookie}});assert.equal(response.status,200);return response.json();
  };
  return{app,remote,entered,finish,closeEntered,get};
}

test('desktop local readiness does not await an unresolved remote connection and its state remains truthful',{timeout:10000},async t=>{
  const f=await fixture(t);
  const listening=f.app.listen({waitForRemote:false});
  await f.entered.promise;
  const origin=await listening;
  assert.equal((await f.get(origin,'/api/status')).version,JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version);
  const pending=await f.get(origin,'/api/remote-access');assert.equal(pending.state,'starting');assert.equal(pending.enabled,false);
  f.finish.resolve();
  assert.equal((await f.get(origin,'/api/remote-access')).state,'ready');
  assert.equal(f.remote.readyTransitions,1);
});

test('a remote setup failure is contained after local readiness and records only a fixed timing outcome',{timeout:10000},async t=>{
  const f=await fixture(t),origin=await f.app.listen({waitForRemote:false});
  await f.entered.promise;f.finish.reject(Error('PRIVATE_ROUTE_AND_TOKEN'));await tick();await f.app.diagnostics.flush();
  assert.equal((await f.get(origin,'/api/remote-access')).state,'error');
  assert.equal((await f.get(origin,'/api/status')).app,'relay-agent-harness');
  const events=f.app.diagnostics.events;
  assert.ok(events.some(event=>event.component==='server'&&event.event==='ready'));
  assert.ok(events.some(event=>event.event==='startup_phase'&&event.phase==='remote-route'&&event.outcome==='failed'));
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE_ROUTE_AND_TOKEN/);
});

test('closing drains background remote startup and prevents a late ready transition',{timeout:10000},async t=>{
  const f=await fixture(t);await f.app.listen({waitForRemote:false});await f.entered.promise;
  let closed=false;const closing=f.app.close().then(()=>{closed=true;});await f.closeEntered.promise;
  assert.equal(f.remote.closed,true);assert.equal(closed,false,'Shutdown must drain the admitted setup.');
  f.finish.resolve();await closing;
  assert.equal(f.remote.readyTransitions,0);assert.equal(f.app.server.listening,false);
});

test('programmatic callers can still await remote readiness with the existing default',async t=>{
  const f=await fixture(t);let opened=false;
  const listening=f.app.listen().then(value=>{opened=true;return value;});await f.entered.promise;await tick();
  assert.equal(opened,false);f.finish.resolve();const origin=await listening;
  assert.equal((await f.get(origin,'/api/remote-access')).enabled,true);
});

test('desktop wiring opts into local readiness for both the saved port and a port-conflict fallback',async()=>{
  const main=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8');
  assert.equal((main.match(/instance\.listen\(\{ waitForRemote: false \}\)/g)||[]).length,2);
});
