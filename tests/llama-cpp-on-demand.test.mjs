import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_LLAMA_CPP_SETTINGS, validateLlamaCppSettings, buildLlamaCppLaunch } from '../lib/llama-cpp-launch-config.mjs';
import { LlamaCppSettingsStore } from '../lib/llama-cpp-settings.mjs';
import { LlamaCppServerSupervisor } from '../lib/llama-cpp-supervisor.mjs';
import { localModelHTTP } from '../lib/local-model-http.mjs';

const settings = extra => validateLlamaCppSettings({
  ...DEFAULT_LLAMA_CPP_SETTINGS,
  executablePath: 'C:\\Runtime\\llama-server.exe',
  modelsDirectory: 'C:\\Models',
  ...extra,
});

test('v1.0.0 launcher: editable defaults, global presets and per-model overrides', () => {
  const configured = settings({
    modelOverrides: {'small.gguf': {ctxSize:8192, gpuLayers:0}},
    modelPaths: {'private.gguf':'C:\\Other\\private.gguf'},
  });
  const launch = buildLlamaCppLaunch(configured,{presetPath:'C:\\Temp\\models.ini'});
  assert.deepEqual(launch.args.slice(0,4), ['--host','127.0.0.1','--port','8080']);
  assert.ok(launch.args.includes('--models-autoload'));
  assert.ok(launch.args.includes('--no-webui'));
  assert.match(launch.preset, /\[\*\]\nfit = on\nc = 0/);
  assert.match(launch.preset, /\[small\.gguf\]\nc = 8192\nn-gpu-layers = 0/);
  assert.match(launch.preset, /\[private\.gguf\]\nmodel = C:\\Other\\private\.gguf/);
  assert.match(launch.preset, /cache-ram = 0/);
  assert.doesNotMatch(launch.args.join(' ')+launch.preset, /--quantize|--cache-type-k/);
  assert.equal(launch.args.includes('--ctx-size'),false,'model settings belong in INI, not router CLI');
  assert.throws(() => settings({modelOverrides:{'bad]\n[evil':{ctxSize:4096}}}), /override ID/);
  assert.throws(() => settings({sleepIdleSeconds:120,shutdownIdleSeconds:60}), /Full shutdown/);
  assert.throws(() => settings({executablePath:'llama-server.exe'}), /absolute local path/);
  assert.throws(() => settings({flashAttention:'force'}), /Flash Attention/);
  assert.equal(DEFAULT_LLAMA_CPP_SETTINGS.shutdownIdleSeconds,0,'untested full shutdown remains off');
});

test('revisioned settings persist atomically without running a model', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-llama-settings-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const store=await new LlamaCppSettingsStore({dataDir:dir}).init();
  const result=await store.update({expectedRevision:0,settings:settings({sleepIdleSeconds:180})});
  assert.equal(result.revision,1);
  await assert.rejects(store.update({expectedRevision:0,settings:settings()}),/changed elsewhere/);
  const reloaded=await new LlamaCppSettingsStore({dataDir:dir}).init();
  assert.equal(reloaded.snapshot().settings.sleepIdleSeconds,180);
  assert.equal(reloaded.snapshot().recommended.sleepIdleSeconds,120);
});

function mockSupervisor({external=false,invalidCatalog=false,config={}}={}){
  let online=external,killCount=0,loaded=false;
  const launches=[],timers=[],presets=[];
  const request=async (_engine,route,{body}={})=>{
    if(!online)throw Object.assign(Error('offline'),{code:'LOCAL_ENGINE_OFFLINE',status:503});
    if(route==='/models')return invalidCatalog?{bad:true}:{data:[{id:'small.gguf',status:{value:loaded?'loaded':'unloaded'}}]};
    if(route==='/props')return {role:'router'};
    if(route==='/models/load'){loaded=true;return {success:true};}
    throw Error('Unexpected route '+route);
  };
  const spawnImpl=(cmd,args,options)=>{
    const child=new EventEmitter();
    child.pid=2345+launches.length;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    child.kill=()=>{killCount++;online=false;queueMicrotask(()=>child.emit('close',0));return true;};
    launches.push({cmd,args,options,child});online=true;return child;
  };
  const fsImpl={async stat(name){
    const file=name==='C:\\Runtime\\llama-server.exe'||name.endsWith('.gguf');
    const directory=name==='C:\\Models';
    if(!file&&!directory)throw Object.assign(Error('Not found'),{code:'ENOENT'});
    return {isFile:()=>file,isDirectory:()=>directory};
  }};
  const supervisor=new LlamaCppServerSupervisor({
    request,spawnImpl,fsImpl,
    makeTemp:async()=> 'C:\\Temp\\llama-candidate',
    writeText:async(name,content)=>presets.push({name,content}),removeDir:async()=>{},
    sleep:async()=>{},readinessTimeoutMs:2000,
    setTimer:(fn,ms)=>{const timer={fn,ms,cancelled:false,unref(){}};timers.push(timer);return timer;},
    clearTimer:timer=>{timer.cancelled=true;},
  });
  return {supervisor,launches,presets,timers,config:settings(config),
    get kills(){return killCount;}};
}

test('on-demand startup confirms router and runs with safe argv, not shell interpolation', async()=>{
  const f=mockSupervisor({config:{shutdownIdleSeconds:600}});
  const lease=await f.supervisor.acquire(f.config,1);
  assert.equal(lease.owned,true);
  assert.equal(f.launches.length,1);
  assert.equal(f.launches[0].cmd,'C:\\Runtime\\llama-server.exe');
  assert.equal(f.launches[0].options.shell,false);
  assert.equal(f.launches[0].options.windowsHide,true);
  assert.ok(f.launches[0].args.includes('--sleep-idle-seconds'));
  assert.equal(f.presets.length,1);
  assert.equal(f.supervisor.status(2).pendingRestart,true);
  assert.equal(f.supervisor.stopOwned(),false,'active work must not be stopped');
  lease.release();
  const timer=f.timers.find(item=>!item.cancelled);
  assert.equal(timer.ms,600000);
  timer.fn();
  assert.equal(f.kills,1);
  await Promise.resolve();
  assert.equal(f.supervisor.status(2).owned,false);
});

test('cold starts are singleflight; existing external servers are never terminated', async()=>{
  const f=mockSupervisor();
  const leases=await Promise.all([f.supervisor.acquire(f.config,1),f.supervisor.acquire(f.config,1)]);
  assert.equal(f.launches.length,1,'only one process may be spawned');
  assert.equal(f.supervisor.status(1).activeLeases,2);
  leases.forEach(lease=>lease.release());
  await f.supervisor.close();
  const external=mockSupervisor({external:true,config:{shutdownIdleSeconds:600}});
  const borrowed=await external.supervisor.acquire(external.config,1);
  assert.equal(borrowed.owned,false);
  borrowed.release();
  await external.supervisor.close();
  assert.equal(external.launches.length,0);
  assert.equal(external.kills,0);
});

test('invalid occupied endpoint and nonexistent executable never cause another spawn', async()=>{
  const occupied=mockSupervisor({external:true,invalidCatalog:true});
  await assert.rejects(occupied.supervisor.acquire(occupied.config,1),/unexpected model catalog/i);
  assert.equal(occupied.launches.length,0);
  const missing=mockSupervisor({config:{executablePath:'C:\\Missing\\llama-server.exe'}});
  await assert.rejects(missing.supervisor.acquire(missing.config,1),/No verified llama-server/);
  assert.equal(missing.launches.length,0);
});

test('idle timer invalidation protects the active request and late timeout callback', async()=>{
  const f=mockSupervisor({config:{shutdownIdleSeconds:600}});
  const first=await f.supervisor.acquire(f.config,1);first.release();
  const timer=f.timers.find(item=>!item.cancelled);
  assert.ok(timer);
  const second=await f.supervisor.acquire(f.config,1);
  assert.equal(timer.cancelled,true);
  timer.fn();
  assert.equal(f.kills,0);
  second.release();
  await f.supervisor.close();
});

test('HTTP activation is local-session only and verifies the exact registered provider/model', async()=>{
  const calls=[],manager={
    llamaConfig:()=>({revision:0,settings:{}}),llamaProcessStatus:()=>({owned:false}),llamaPreview:()=>null,
    activateLlama:async model=>{calls.push(model);return {engine:'llamacpp',model,loaded:true};},
    configureLlama:async value=>({revision:1,settings:value.settings}),
  };
  const runtime={listProviders:()=>[{id:'local_llamacpp',preset:'llamacpp',type:'compatible',
    baseUrl:'http://127.0.0.1:8080/v1',models:[{id:'small.gguf'}]}]};
  const call={manager,runtime,pathname:'/api/local-models/activate',method:'POST',
    value:{providerId:'local_llamacpp',model:'small.gguf'}};
  assert.equal((await localModelHTTP({...call,remote:true})).status,403);
  assert.equal((await localModelHTTP({...call,value:{...call.value,model:'other.gguf'}})).status,404);
  assert.equal(calls.length,0);
  assert.equal((await localModelHTTP(call)).status,200);
  assert.deepEqual(calls,['small.gguf']);
  assert.equal((await localModelHTTP({...call,pathname:'/api/local-models/config',method:'GET',remote:true})).status,403);
});

test('acquire waits for asynchronous tree termination before probing or granting a new lease', async () => {
  const f=mockSupervisor();
  const first=await f.supervisor.acquire(f.config,1);first.release();
  const terminate=f.supervisor.terminate;
  let completeStop,probes=0,admitted=false;
  const probe=f.supervisor.probe.bind(f.supervisor);
  f.supervisor.probe=()=>{probes++;return probe();};
  f.supervisor.terminate=child=>new Promise(resolve=>{completeStop=()=>{child.kill();resolve();};});
  assert.equal(f.supervisor.stopOwned(),true);
  assert.equal(f.supervisor.status().stopping,true);
  const second=f.supervisor.acquire(f.config,1).then(lease=>{admitted=true;return lease;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(admitted,false);assert.equal(probes,0);assert.equal(f.launches.length,1);
  completeStop();
  const lease=await second;
  assert.equal(f.launches.length,2);assert.equal(lease.owned,true);
  assert.equal(f.supervisor.status().stopping,false);
  lease.release();f.supervisor.terminate=terminate;await f.supervisor.close();
});

test('unconfirmed tree termination blocks admission even while its endpoint still responds',async()=>{
  const f=mockSupervisor();const lease=await f.supervisor.acquire(f.config,1);lease.release();
  const terminate=f.supervisor.terminate;
  f.supervisor.terminate=async()=>{};
  assert.equal(f.supervisor.stopOwned(),true);
  await new Promise(resolve=>setImmediate(resolve));
  let probes=0;const probe=f.supervisor.probe.bind(f.supervisor);
  f.supervisor.probe=()=>{probes++;return probe();};
  await assert.rejects(f.supervisor.acquire(f.config,1),{code:'LOCAL_LLAMA_STOP_PENDING'});
  assert.equal(probes,0);assert.equal(f.launches.length,1);
  f.launches[0].child.kill();await new Promise(resolve=>setImmediate(resolve));
  f.supervisor.terminate=terminate;
  const next=await f.supervisor.acquire(f.config,1);assert.equal(f.launches.length,2);
  next.release();await f.supervisor.close();
});

test('failed spawn without PID handles later error and never attempts to terminate an invalid PID',async()=>{
  const f=mockSupervisor();let errorsHandled=false,kills=0;
  f.supervisor.spawn=()=>{
    const child=new EventEmitter();child.kill=()=>{kills++;return true;};
    queueMicrotask(()=>{errorsHandled=child.listenerCount('error')>0;child.emit('error',Object.assign(Error('missing executable'),{code:'ENOENT'}));child.emit('close',-1);});
    return child;
  };
  f.supervisor.terminate=async()=>{kills++;};
  await assert.rejects(f.supervisor.acquire(f.config,1),{code:'LOCAL_LLAMA_SPAWN_FAILED'});
  assert.equal(errorsHandled,true);assert.equal(kills,0);assert.equal(f.supervisor.child,null);
  await f.supervisor.close();
});

test('saved model revision restarts an idle owned router before granting the new model lease',async()=>{
  const f=mockSupervisor();const first=await f.supervisor.acquire(f.config,1);first.release();
  const nextConfig={...f.config,modelPaths:{second:'C:\\Models\\second.gguf'}};
  const second=await f.supervisor.acquire(nextConfig,2);
  assert.equal(f.launches.length,2);assert.equal(f.kills,1);
  assert.equal(f.supervisor.status(2).pendingRestart,false);
  assert.match(f.presets[1].content,/\[second\]/);
  second.release();await f.supervisor.close();
});

test('saved model revision is deferred without killing an in-flight lease, then loads on retry',async()=>{
  const f=mockSupervisor();const first=await f.supervisor.acquire(f.config,1);
  const nextConfig={...f.config,modelPaths:{second:'C:\\Models\\second.gguf'}};
  await assert.rejects(f.supervisor.acquire(nextConfig,2),{code:'LOCAL_LLAMA_RESTART_BUSY',status:409});
  assert.equal(f.kills,0);assert.equal(f.launches.length,1);
  assert.equal(f.supervisor.status(2).activeLeases,1);assert.equal(f.supervisor.status(2).pendingRestart,true);
  first.release();const second=await f.supervisor.acquire(nextConfig,2);
  assert.equal(f.kills,1);assert.equal(f.launches.length,2);
  second.release();await f.supervisor.close();
});

test('changed model revision never restarts an external router',async()=>{
  const f=mockSupervisor({external:true});const lease=await f.supervisor.acquire(f.config,2);
  assert.equal(lease.owned,false);assert.equal(f.launches.length,0);assert.equal(f.kills,0);
  lease.release();await f.supervisor.close();
});

test('a newer revision coalesced with startup is deferred instead of receiving an old catalog lease',async()=>{
  const f=mockSupervisor();
  const first=f.supervisor.acquire(f.config,1);
  const newer=f.supervisor.acquire({...f.config,modelPaths:{second:'C:\\Models\\second.gguf'}},2);
  const pendingRejection=assert.rejects(newer,{code:'LOCAL_LLAMA_RESTART_BUSY'});
  const lease=await first;await pendingRejection;
  assert.equal(f.kills,0);assert.equal(f.launches.length,1);assert.equal(f.supervisor.status(2).activeLeases,1);
  lease.release();await f.supervisor.close();
});

test('invalid new executable is rejected before stopping the existing idle router',async()=>{
  const f=mockSupervisor();const lease=await f.supervisor.acquire(f.config,1);lease.release();
  await assert.rejects(f.supervisor.acquire({...f.config,executablePath:'C:\\missing.exe'},2),{code:'LOCAL_LLAMA_EXECUTABLE_MISSING'});
  assert.equal(f.kills,0);assert.equal(f.launches.length,1);assert.equal(f.supervisor.status().owned,true);
  await f.supervisor.close();
});
