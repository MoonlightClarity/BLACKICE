import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';
const origin='http://127.0.0.1:32123', sessionCookie='relay_session_32123='+'a'.repeat(64);
async function fixture(t, { online=false, enabled=true, mode='public', httpsPort=443 }={}) {
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-route-recovery-'));
 const transport=createRemoteTransportFixture({online,config:{}});
 const ownership={hostname:transport.hostname,httpsPort,target:'http://127.0.0.1:45123',mode};
 const config={schema:1,enabled,mode,publicApproved:mode==='public',httpsPort,gatewayPort:45123,ownership:enabled?ownership:null};
 const file=path.join(dataDir,'remote-access.json'); await fs.writeFile(file,JSON.stringify(config));
 const timers=new Set(), delays=[], gateways=[];
 const manager=await new RemoteAccessManager({dataDir,transport:transport.transport,
  setTimer(fn,delay){const timer={fn,delay,unref(){}};timers.add(timer);delays.push(delay);return timer},
  clearTimer(timer){timers.delete(timer)},
  gatewayFactory(){const g={port:45123,listening:false,accepting:false,async listen(){this.listening=true;this.accepting=true;return ownership.target},suspend(){this.accepting=false},async close(){this.listening=false;this.accepting=false}};gateways.push(g);return g}
 }).init();
 t.after(async()=>{await manager.close();await fs.rm(dataDir,{recursive:true,force:true})});
 const fire=async()=>{assert.equal(timers.size,1);const timer=[...timers][0];timers.delete(timer);timer.fn();await manager.tail.catch(()=>{})};
 return {manager,transport,file,config,timers,delays,gateways,fire,attach:()=>manager.attach({origin,sessionCookie})};
}
const mutations=f=>f.transport.calls.filter(args=>args.includes('--bg')||args.at(-1)==='off');

test('offline startup retains exact enabled route bytes and recovers same approved exposure without credentials changes',async t=>{
 const f=await fixture(t),before=await fs.readFile(f.file,'utf8');
 await f.attach();assert.equal(f.manager.status().configuredEnabled,true);assert.equal(f.manager.status().enabled,false);
 assert.equal(await fs.readFile(f.file,'utf8'),before);assert.deepEqual(mutations(f),[]);assert.equal(f.manager.status().recovery.pending,true);
 f.transport.setOnline(true);await f.fire();assert.equal(f.manager.status().enabled,true);
 assert.equal(f.manager.config.mode,'public');assert.equal(f.manager.config.httpsPort,443);assert.equal(f.manager.config.ownership.hostname,f.config.ownership.hostname);
 assert.deepEqual(mutations(f),[['funnel','--bg','--https=443','--set-path=/','http://127.0.0.1:45123']]);
 assert.equal(f.manager.status().recovery.pending,false);assert.equal(f.delays.at(-1),30000);
});
test('private and legacy port recovery never widens exposure',async t=>{
 const f=await fixture(t,{mode:'private',httpsPort:8443});await f.attach();f.transport.setOnline(true);await f.fire();
 assert.deepEqual(mutations(f),[['serve','--bg','--https=8443','http://127.0.0.1:45123']]);
 assert.equal(f.manager.config.publicApproved,false);
});
test('recovery caps its backoff without abandoning long offline intent and manual refresh can retry',async t=>{
 const f=await fixture(t);await f.attach();for(let i=0;i<9;i++)await f.fire();
 assert.deepEqual(f.delays,[1000,2000,5000,10000,30000,60000,60000,60000,60000,60000]);assert.equal(f.timers.size,1);
 assert.equal(f.manager.status().recovery.backoffStep,6);assert.equal(f.manager.status().recovery.retryScheduled,true);assert.equal(f.manager.config.enabled,true);assert.deepEqual(mutations(f),[]);
 f.transport.setOnline(true);await f.manager.refresh();assert.equal(f.manager.status().enabled,true);
});
test('fresh disabled configuration never retries or enables public access',async t=>{
 const f=await fixture(t,{enabled:false});await f.attach();assert.equal(f.timers.size,0);assert.deepEqual(f.transport.calls,[]);
 assert.equal(f.manager.config.enabled,false);
});
test('explicit disable clears retry and stale timer cannot reconnect',async t=>{
 const f=await fixture(t);await f.attach();const stale=[...f.timers][0];
 await f.manager.disable();assert.equal(f.timers.size,0);f.transport.setOnline(true);stale.fn();await f.manager.tail;
 assert.equal(f.manager.config.enabled,false);assert.equal(f.manager.status().enabled,false);assert.deepEqual(mutations(f),[]);
});
test('close clears retry and stale timer cannot reconnect',async t=>{
 const f=await fixture(t);await f.attach();const stale=[...f.timers][0];
 await f.manager.close();f.transport.setOnline(true);stale.fn();await f.manager.tail.catch(()=>{});
 assert.equal(f.timers.size,0);assert.deepEqual(mutations(f),[]);
});
test('ready transport outage suspends admission and health timer recovers unchanged route',async t=>{
 const f=await fixture(t,{online:true});await f.attach();assert.equal(f.manager.status().enabled,true);
 f.transport.setOnline(false);await f.fire();assert.equal(f.manager.status().enabled,false);assert.equal(f.manager.gateway.accepting,false);
 assert.equal(f.manager.config.enabled,true);f.transport.setOnline(true);await f.fire();assert.equal(f.manager.status().enabled,true);
 assert.equal(mutations(f).filter(a=>a.includes('--bg')).length,1);
});
test('changed route remains closed without automatic overwrite or retry',async t=>{
 const f=await fixture(t,{online:true});await f.attach();
 const changed=f.transport.config;changed.Web[f.transport.hostname+':443'].Handlers['/'].Proxy='http://127.0.0.1:49999';f.transport.setConfig(changed);
 const count=mutations(f).length;await f.fire();assert.equal(f.manager.status().enabled,false);assert.equal(f.timers.size,0);assert.equal(f.manager.error.code,'REMOTE_ROUTE_CHANGED');
 assert.equal(mutations(f).length,count);assert.deepEqual(f.transport.config,changed);
});
test('saved hostname cannot silently migrate on resume',async t=>{
 const f=await fixture(t,{online:true});const inspect=f.transport.transport.inspect.bind(f.transport.transport);
 f.transport.transport.inspect=async o=>{const v=await inspect(o);v.status.dnsName='different.tailtest.ts.net';return v};
 await f.attach();assert.equal(f.manager.error.code,'REMOTE_ROUTE_CHANGED');assert.equal(f.timers.size,0);assert.deepEqual(mutations(f),[]);
 assert.equal(f.manager.config.enabled,true);assert.deepEqual(f.manager.config.ownership,f.config.ownership);
});
test('readback verification failure is not retried as transport offline',async t=>{
 const f=await fixture(t,{online:true});f.transport.transport.enable=async()=>{throw Object.assign(Error('readback mismatch'),{code:'REMOTE_ROUTE_VERIFICATION'})};
 await f.attach();assert.equal(f.manager.error.code,'REMOTE_ROUTE_VERIFICATION');assert.equal(f.timers.size,0);assert.equal(f.manager.config.enabled,false);
});
test('preflight CLI command failure retains intent with bounded retry, malformed response does not retry',async t=>{
 const f=await fixture(t);const inspect=f.transport.transport.inspect.bind(f.transport.transport);
 f.transport.transport.inspect=async()=>{throw Object.assign(Error('daemon unavailable'),{code:'REMOTE_TAILSCALE_COMMAND'})};
 await f.attach();assert.equal(f.manager.config.enabled,true);assert.equal(f.timers.size,1);
 f.transport.transport.inspect=async()=>{throw Object.assign(Error('bad configuration'),{code:'REMOTE_TAILSCALE_RESPONSE'})};
 await f.fire();assert.equal(f.manager.config.enabled,true);assert.equal(f.timers.size,0);assert.equal(f.manager.error.code,'REMOTE_TAILSCALE_RESPONSE');
 f.transport.transport.inspect=inspect;
});
test('disable racing an in-flight recovery preflight prevents route enable',async t=>{
 const f=await fixture(t);await f.attach();f.transport.setOnline(true);
 let release,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r),inspect=f.transport.transport.inspect.bind(f.transport.transport);
 let once=true;f.transport.transport.inspect=async o=>{if(once){once=false;entered();await wait}return inspect(o)};
 const firing=f.fire();await started;const disabling=f.manager.disable();release();await firing;await disabling;
 assert.equal(f.manager.config.enabled,false);assert.equal(f.manager.status().enabled,false);assert.deepEqual(mutations(f),[]);assert.equal(f.timers.size,0);
});
test('disable racing in-flight route enable denies gateway then cleans only owned route',async t=>{
 const f=await fixture(t,{online:true});let release,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r),enable=f.transport.transport.enable.bind(f.transport.transport);
 f.transport.transport.enable=async o=>{entered();await wait;return enable(o)};
 const attaching=f.attach();await started;const disabling=f.manager.disable();assert.equal(f.manager.gateway.accepting,false);release();await attaching;await disabling;
 assert.equal(f.manager.config.enabled,false);assert.equal(f.manager.status().enabled,false);assert.equal(f.timers.size,0);
 assert.equal(f.transport.config.Web?.[f.transport.hostname+':443']?.Handlers?.['/'],undefined);
});


test('close racing recovery preflight preserves saved startup intent and never enables route',async t=>{
 const f=await fixture(t);await f.attach();const before=await fs.readFile(f.file,'utf8');f.transport.setOnline(true);
 let release,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r),inspect=f.transport.transport.inspect.bind(f.transport.transport);
 let once=true;f.transport.transport.inspect=async o=>{if(once){once=false;entered();await wait}return inspect(o)};
 const firing=f.fire();await started;const closing=f.manager.close();release();await firing;await closing;
 assert.equal(await fs.readFile(f.file,'utf8'),before);assert.deepEqual(mutations(f),[]);assert.equal(f.timers.size,0);
});
test('invalid management requests keep healthy monitoring and dedicated confirmation error',async t=>{
 const f=await fixture(t,{online:true});await f.attach();const generation=f.manager.intentGeneration, timer=f.manager.routeTimer;
 await assert.rejects(f.manager.enable({mode:'public'}),{code:'REMOTE_PUBLIC_CONFIRMATION'});
 assert.equal(f.manager.intentGeneration,generation);assert.equal(f.manager.routeTimer,timer);assert.equal(f.manager.status().enabled,true);
});
test('queued attachment superseded by immediate disable cannot enable first',async t=>{
 const f=await fixture(t,{online:true});const attaching=f.attach(),disabling=f.manager.disable();await attaching;await disabling;
 assert.equal(f.manager.config.enabled,false);assert.deepEqual(mutations(f),[]);assert.equal(f.timers.size,0);
});

