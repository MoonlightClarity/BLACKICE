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

test('optional runtime tuning preserves native defaults and writes global or per-model INI options',()=>{
  const native=buildLlamaCppLaunch(settings());
  assert.doesNotMatch(native.preset,/^(threads|threads-batch|batch-size|ubatch-size|cache-type-[kv]|mmproj(?:-offload)?) =/m);
  for(const key of ['threads','threadsBatch','batchSize','ubatchSize','cacheTypeK','cacheTypeV'])
    assert.equal(Object.hasOwn(native.effective,key),false,key+' stays unspecified');
  const configured=settings({threads:6,threadsBatch:12,batchSize:512,ubatchSize:128,cacheTypeK:'q8_0',cacheTypeV:'q8_0',
    modelOverrides:{small:{threads:4,threadsBatch:6,batchSize:256,ubatchSize:64,cacheTypeK:'f16',cacheTypeV:'f16'}}});
  const launch=buildLlamaCppLaunch(configured);
  const [global,small]=launch.preset.split('[small]\n');
  assert.match(global,/threads = 6\nthreads-batch = 12\nbatch-size = 512\nubatch-size = 128\ncache-type-k = q8_0\ncache-type-v = q8_0\n$/);
  assert.equal(small,'threads = 4\nthreads-batch = 6\nbatch-size = 256\nubatch-size = 64\ncache-type-k = f16\ncache-type-v = f16\n');
  assert.doesNotMatch(launch.args.join(' '),/threads|batch-size|cache-type/);
  assert.deepEqual(settings(JSON.parse(JSON.stringify(configured))),configured);
  for(const [key,value] of [['threads',0],['threadsBatch',-1],['threads',1.5],['threads',1025],
    ['batchSize',0],['ubatchSize',262145],['cacheTypeK','int8'],['cacheTypeV','q8_0\nmodel = x'],['cacheTypeV',null]]){
    assert.throws(()=>settings({[key]:value}),{code:'LOCAL_LLAMA_SETTINGS_INVALID'});
    assert.throws(()=>settings({modelOverrides:{small:{[key]:value}}}),{code:'LOCAL_LLAMA_SETTINGS_INVALID'});
  }
});

test('vision projector binds only to its model with explicit GPU or CPU placement',()=>{
  const mmprojPath='C:\\Model projectors\\matching-mmproj-F16.gguf';
  const configured=settings({modelOverrides:{vision:{mmprojPath,mmprojOffload:false,ctxSize:65536},other:{ctxSize:8192}}});
  const launch=buildLlamaCppLaunch(configured);
  assert.doesNotMatch(launch.preset.split('[other]')[0],/mmproj/);
  assert.match(launch.preset,/\[other\]\nc = 8192\n\[vision\]\nc = 65536\nmmproj = C:\\Model projectors\\matching-mmproj-F16\.gguf\nmmproj-offload = off\n$/);
  assert.doesNotMatch(launch.args.join(' '),/mmproj/);
  const gpu=buildLlamaCppLaunch(settings({modelOverrides:{vision:{mmprojPath,mmprojOffload:true}}}));
  assert.match(gpu.preset,/mmproj-offload = on\n$/);
  const automatic=buildLlamaCppLaunch(settings({modelOverrides:{vision:{mmprojPath}}}));
  assert.match(automatic.preset,/mmproj = /);assert.doesNotMatch(automatic.preset,/mmproj-offload/);
  assert.deepEqual(settings(JSON.parse(JSON.stringify(configured))),configured);
  for(const invalid of ['relative.gguf','','C:\\Models\\wrong.bin','C:\\Models\\evil#comment.gguf','C:\\Models\\evil;comment.gguf','C:\\Models\\bad\nmodel.gguf'])
    assert.throws(()=>settings({modelOverrides:{vision:{mmprojPath:invalid}}}),{code:'LOCAL_LLAMA_SETTINGS_INVALID'});
  for(const invalid of ['off',0,null])
    assert.throws(()=>settings({modelOverrides:{vision:{mmprojOffload:invalid}}}),{code:'LOCAL_LLAMA_SETTINGS_INVALID'});
  assert.throws(()=>settings({mmprojPath}),{code:'LOCAL_LLAMA_SETTINGS_INVALID'});
  assert.throws(()=>settings({mmprojOffload:false}),{code:'LOCAL_LLAMA_SETTINGS_INVALID'});
});

test('YaRN writes only exact per-model preset flags and rejects conflicting or invalid contexts',()=>{
 const yarn={originalContext:32768,targetContext:131072};
 const launch=buildLlamaCppLaunch(settings({ctxSize:16384,modelOverrides:{long:{yarn,gpuLayers:7},unchanged:{ctxSize:4096}}}));
 const global=launch.preset.split('[long]')[0],extended=launch.preset.split('[long]\n')[1].split('[unchanged]')[0];
 assert.match(global,/c = 16384/);assert.doesNotMatch(global,/rope|yarn/);
 assert.equal(extended,'n-gpu-layers = 7\nc = 131072\nrope-scaling = yarn\nyarn-orig-ctx = 32768\nrope-scale = 4\n');
 assert.match(launch.preset,/\[unchanged\]\nc = 4096\n$/);assert.doesNotMatch(launch.args.join(' '),/rope|yarn/);
 for(const invalid of [{...yarn,targetContext:0},{...yarn,targetContext:300000},{...yarn,targetContext:32768},{...yarn,originalContext:0},{...yarn,originalContext:'32768'},{...yarn,flags:'injected'}])
   assert.throws(()=>settings({modelOverrides:{long:{yarn:invalid}}}),{code:'LOCAL_LLAMA_SETTINGS_INVALID'});
 assert.throws(()=>settings({modelOverrides:{long:{ctxSize:8192,yarn}}}),/conflicting context/);
 assert.throws(()=>settings({yarn}),{code:'LOCAL_LLAMA_SETTINGS_INVALID'});
});

test('revisioned settings persist atomically without running a model', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-llama-settings-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const store=await new LlamaCppSettingsStore({dataDir:dir}).init();
  const configured=settings({sleepIdleSeconds:180,threads:6,cacheTypeK:'q8_0',
    modelOverrides:{vision:{mmprojPath:'C:\\Projectors\\vision.gguf',mmprojOffload:false,cacheTypeV:'q8_0'}}});
  const result=await store.update({expectedRevision:0,settings:configured});
  assert.equal(result.revision,1);
  await assert.rejects(store.update({expectedRevision:0,settings:settings()}),/changed elsewhere/);
  const reloaded=await new LlamaCppSettingsStore({dataDir:dir}).init();
  assert.deepEqual(reloaded.snapshot().settings,configured);
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
    const file=name==='C:\\Runtime\\llama-server.exe'||(name.endsWith('.gguf')&&!name.endsWith('missing.gguf'));
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

test('a missing saved model cannot block cold start or idle switch to another model', async()=>{
  const f=mockSupervisor({config:{modelPaths:{stale:'C:\\Models\\missing.gguf','small.gguf':'C:\\Models\\small.gguf'},modelOverrides:{stale:{ctxSize:8192}}}});
  const first=await f.supervisor.acquire(f.config,1);
  first.release();
  const second=await f.supervisor.acquire(f.config,2);
  second.release();
  assert.equal(f.launches.length,2);
  assert.equal(f.kills,1);
  for(const {content} of f.presets){
    assert.doesNotMatch(content,/stale|missing.gguf/);
    assert.match(content,/small.gguf/);
  }
  assert.ok(f.config.modelPaths.stale,'saved mapping remains available for a disconnected drive');
  assert.equal(f.config.modelOverrides.stale.ctxSize,8192);
});


test('owned cold-start readiness tolerates precise loading 503 without tearing down its child',async()=>{
 const f=mockSupervisor(),probe=f.supervisor.probe.bind(f.supervisor);let loading=2;
 f.supervisor.probe=async()=>{if(f.launches.length&&loading-->0)throw Object.assign(Error('Loading model'),{code:'LOCAL_LLAMA_LOADING',status:503});return probe();};
 const lease=await f.supervisor.acquire(f.config,1);
 assert.equal(lease.owned,true);assert.equal(f.launches.length,1);assert.equal(f.kills,0);
 lease.release();await f.supervisor.close();
});
test('existing loading endpoint is borrowed after readiness and never duplicated',async()=>{
 const f=mockSupervisor({external:true}),probe=f.supervisor.probe.bind(f.supervisor);let loading=2;
 f.supervisor.probe=async()=>{if(loading-->0)throw Object.assign(Error('Loading model'),{code:'LOCAL_LLAMA_LOADING',status:503});return probe();};
 const lease=await f.supervisor.acquire(f.config,1);assert.equal(lease.owned,false);assert.equal(f.launches.length,0);assert.equal(f.kills,0);
 lease.release();await f.supervisor.close();
});
test('unrelated 503 remains terminal and never starts a second process',async()=>{
 const f=mockSupervisor({external:true});f.supervisor.probe=async()=>{throw Object.assign(Error('Service unavailable'),{code:'LOCAL_ENGINE_REQUEST_FAILED',status:503});};
 await assert.rejects(f.supervisor.acquire(f.config,1),{code:'LOCAL_ENGINE_REQUEST_FAILED'});
 assert.equal(f.launches.length,0);assert.equal(f.kills,0);await f.supervisor.close();
});
