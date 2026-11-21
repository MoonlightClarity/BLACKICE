#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const C=require('./parity-contract.cjs');
const I=require('./parity-io.cjs');
const {collectNative}=require('./native-observation.cjs');
const SOURCE_FILES=Object.freeze(["runtime-parity.cjs","parity-contract.cjs","parity-io.cjs","native-observation.cjs","empty-tensor-observation.cjs","text-position-correspondence.cjs"]);
const HELP=[
'BLACKICE MiniCPM runtime parity (unscored; no throughput claim)',
'',
'run --exe ABS --exe-sha256 HEX --model ABS --model-sha256 HEX --out NEW_ABS',
'    --port INTEGER --label NAME --variant original|rebuilt-baseline|rebuilt-io-compat-baseline|instrumented-off|instrumented-on',
'    --config ABS_PROFILE_JSON --admission ABS_RECENT_HOST_CHECK_JSON [--trace-directory ABS --trace-config ABS]',
'',
'compare --left ABS_RESULT_JSON --right ABS_RESULT_JSON --out NEW_ABS',
'        --mode original-rebuilt|baseline-instrumented|activation-toggle',
'',
'run starts exactly one standalone owned server, captures cold/cached native and tool-cycle probes,',
'and settles that child before returning. Never use an existing output directory.',
'The host admission file must use blackice.minicpm.parity-admission.v1, have a recent at timestamp,',
'actual statusResponse/configResponse/processSnapshot objects, and explicit appIdle/modelIdle checks.',
'Only the coordinating host may schedule run after its fresh app and native-process checks.',
'--help, compare, and the unit tests start no model.',
'Original/rebuilt runs forbid trace options. Instrumented runs require explicit shared --trace-directory and --trace-config.',
'Native traces use unique process filenames. Immutable per-run config snapshots publish to the same shared path; activation-on requires exact previous off bytes.',
'All failures preserve the output and return a nonzero exit code.'
].join('\n');
function parseArgs(argv){
 if(argv.length===0||argv[0]==='--help'||argv[0]==='help')return {command:'help'};
 const command=argv.shift(),options={};C.insist(['run','compare'].includes(command),'Use run, compare, or --help.');
 for(let i=0;i<argv.length;i+=2){C.insist(/^--[a-z][a-z0-9-]*$/.test(argv[i])&&typeof argv[i+1]==='string'&&!argv[i+1].startsWith('--'),'Options require explicit values.');const key=argv[i].slice(2);C.insist(!Object.hasOwn(options,key),'Duplicate option: '+key);options[key]=argv[i+1];}
 const required=command==='run'?['exe','exe-sha256','model','model-sha256','out','port','label','variant','config','admission']:['left','right','out','mode'];
 const allowed=required.concat(command==='run'?['trace-directory','trace-config']:[]);
 for(const key of Object.keys(options))C.insist(allowed.includes(key),'Unknown option: '+key);
 for(const key of required)C.insist(options[key],'Missing --'+key);
 for(const key of command==='run'?['exe','model','out','config','admission']:['left','right','out'])C.insist(path.isAbsolute(options[key]),'--'+key+' must be absolute.');
 if(command==='run'){
  C.insist(/^[a-f0-9]{64}$/.test(options['exe-sha256'])&&/^[a-f0-9]{64}$/.test(options['model-sha256']),'Full lowercase expected SHA-256 values are required.');
  C.insist(/^[a-z0-9_-]{1,80}$/.test(options.label),'Invalid label.');
  C.insist(['original','rebuilt-baseline','rebuilt-io-compat-baseline','instrumented-off','instrumented-on'].includes(options.variant),'Unknown runtime variant.');
  options.port=Number(options.port);C.insist(Number.isInteger(options.port)&&options.port>=1024&&options.port<=65535,'Invalid port.');
  const traced=options.variant.startsWith('instrumented-');
  C.insist(traced===Boolean(options['trace-directory'])&&traced===Boolean(options['trace-config']),'Both explicit trace directory and trace config are required only for instrumented variants.');
  if(traced){C.insist(path.isAbsolute(options['trace-directory'])&&path.isAbsolute(options['trace-config']),'Trace directory and config must be absolute.');C.insist(path.resolve(options['trace-config'])!==path.resolve(options.out,'blackice-trace.json'),'Shared config cannot overwrite the immutable run snapshot.');}
 }
 return {command,options};
}
function newDirectory(dir){C.insist(!fs.existsSync(dir),'Output already exists; failed evidence must not be overwritten.','PARITY_OUTPUT_EXISTS');fs.mkdirSync(path.dirname(dir),{recursive:true});fs.mkdirSync(dir);}
function readJSON(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function validateAdmission(value,maxAge=30000){
 C.insist(value?.schema==='blackice.minicpm.parity-admission.v1','Missing host admission schema.');
 const age=Date.now()-Date.parse(value.at);C.insist(Number.isFinite(age)&&age>=0&&age<=maxAge,'Host app/process admission is stale.','PARITY_ADMISSION_STALE');
 C.insist(value.checks?.appIdle===true&&value.checks?.modelIdle===true,'Host did not observe an idle app and model.');
 C.insist(value.statusResponse&&value.configResponse&&Array.isArray(value.processSnapshot),'Raw host checks must accompany admission.');
 return value;
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run(options){
 const profile=C.validateProfile(readJSON(options.config)),admission=validateAdmission(readJSON(options.admission));
 C.insist(process.platform==='win32','This native runner requires Windows.','PARITY_PLATFORM');
 newDirectory(options.out);const requestsDirectory=path.join(options.out,'http');fs.mkdirSync(requestsDirectory);
 const started=Date.now(),absoluteEnd=started+profile.limits.totalMs,workEnd=absoluteEnd-profile.limits.cleanupMs-profile.limits.postHashMs;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(C.fail('Work deadline expired; reserved cleanup begins.','PARITY_TIMEOUT')),Math.max(1,workEnd-Date.now()));
 const stop=()=>controller.abort(C.fail('Runner stop requested; settling owned child.','PARITY_CANCELLED'));process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const result={schema:C.RUN_SCHEMA,at:I.clock(),label:options.label,variant:options.variant,complete:false,scorable:false,throughputClaim:false,
  profile,expected:{executableSha256:options['exe-sha256'],modelSha256:options['model-sha256']},identity:{},requests:[],probes:{},phases:[],failures:[],parityFindings:{checks:{},passed:null},instructionAdherence:{observations:[],passed:null}};
 let child=null,logs=null,spawnError=null,phase='prepare';
 const mark=name=>{phase=name;result.phases.push({name,at:I.clock()});};
 const request=I.requestRecorder({directory:requestsDirectory,port:options.port,profile,signal:controller.signal,deadline:workEnd,requests:result.requests});
 const inference=async(name,route,body,kind)=>{
  const response=await request(name,route,body);C.insist(response.response.status===200,'Inference returned HTTP '+response.response.status,'PARITY_HTTP');
  const parsed=kind==='completion'?C.validateCompletion(response.json()):C.collectChat(response.bytes);
  const probe={kind,request:response.request,response:response.response,result:parsed};result.probes[name]=probe;I.saveJSON(path.join(options.out,name+'.json'),probe);return parsed;
 };
 try{
  result.admission=I.saveJSON(path.join(options.out,'admission.json'),admission);
  result.config=I.save(path.join(options.out,'profile-input.json'),fs.readFileSync(options.config));
  result.source=Object.fromEntries(SOURCE_FILES.map(name=>[name,C.sha(fs.readFileSync(path.join(__dirname,name)))]));
  await I.portFree(options.port);
  mark('identity-before');
  result.identity.bundleBefore=await I.bundleIdentity(options.exe,workEnd);
  result.identity.executable={before:result.identity.bundleBefore.find(x=>x.path===options.exe)};
  C.insist(result.identity.executable.before?.sha256===options['exe-sha256'],'Executable does not match its pinned hash.','PARITY_IDENTITY_CHANGED');
  result.identity.model={before:await I.hashFile(options.model,workEnd)};
  C.insist(result.identity.model.before.sha256===options['model-sha256'],'Model does not match its pinned hash.','PARITY_IDENTITY_CHANGED');
  mark('native-admission');
  result.nativeProcessesBefore=await I.scanServers();
  C.insist(Array.isArray(result.nativeProcessesBefore)&&result.nativeProcessesBefore.length===0,'Another llama server/CLI process exists; no model was started.','PARITY_INFERENCE_BUSY');
  validateAdmission(admission);
  let tracePath=null;
  if(options.variant.startsWith('instrumented-')){
   result.traceConfig={schema:'blackice.minicpm.trace-config.v1',enabled:true,activationCaptureEnabled:options.variant==='instrumented-on',
    outputDirectory:options['trace-directory'],...profile.trace};
   fs.mkdirSync(options['trace-directory'],{recursive:true});
   const snapshotPath=path.join(options.out,'blackice-trace.json');result.traceConfigEvidence=I.saveJSON(snapshotPath,result.traceConfig);
   result.traceConfigBytesUTF8=fs.readFileSync(snapshotPath,'utf8');tracePath=options['trace-config'];result.traceConfigPath=tracePath;result.traceConfigPublication={};
   I.publishTraceConfig({livePath:tracePath,bytes:Buffer.from(result.traceConfigBytesUTF8),expectedPreviousBytes:options.variant==='instrumented-on'?Buffer.from(JSON.stringify({...result.traceConfig,activationCaptureEnabled:false},null,2)+'\n'):null,preimagePath:path.join(options.out,'trace-config-preimage.json'),record:result.traceConfigPublication});
  }
  C.insist(typeof process.env.LOCALAPPDATA==='string'&&path.isAbsolute(process.env.LOCALAPPDATA),'Installed app source location is unavailable.','PARITY_ENV_SOURCE_MISSING');
  const restartOriginSourcePath=path.join(process.env.LOCALAPPDATA,'Programs','BLACKICE','resources','app',I.RESTART_ORIGIN_SOURCE.relativePath);
  result.environmentPolicySource=await I.hashFile(restartOriginSourcePath,workEnd);
  C.insist(result.environmentPolicySource.sha256===I.RESTART_ORIGIN_SOURCE.sha256,'Installed restart-origin source changed; child environment policy requires review.','PARITY_ENV_SOURCE_CHANGED');
  const environment=I.childEnvironment(tracePath);result.childEnvironmentSha256=environment.fingerprint;result.clearedChildEnvironmentNames=environment.removed;
  result.childEnvironmentEvidence={schema:'blackice.minicpm.child-environment.v1',policy:I.RESTART_ORIGIN_SOURCE,source:result.environmentPolicySource,
   fingerprintScope:environment.fingerprintScope,baseSha256:environment.fingerprint,actualSha256:environment.actualFingerprint,
   baseVariableHashes:environment.baseVariableHashes,actualVariableHashes:environment.actualVariableHashes,removed:environment.removedProvenance};
  result.slotDirectory=path.join(options.out,'slot-state');fs.mkdirSync(result.slotDirectory);
  result.argv=C.buildArgv(profile,{model:options.model,port:options.port,slotDirectory:result.slotDirectory});
  result.command={executable:options.exe,args:result.argv,cwd:path.dirname(options.exe),shell:false};
  I.saveJSON(path.join(options.out,'launch.json'),{...result.command,expected:result.expected,traceConfigEvidence:result.traceConfigEvidence??null,traceConfigPath:result.traceConfigPath??null,traceConfigPublication:result.traceConfigPublication??null,childEnvironmentSha256:result.childEnvironmentSha256,childEnvironmentEvidence:result.childEnvironmentEvidence});
  mark('spawn-owned-child');
  child=spawn(options.exe,result.argv,{cwd:path.dirname(options.exe),env:environment.env,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
  child.once('error',error=>{spawnError=error;controller.abort(error);});
  C.insist(child.stdout&&child.stderr,'Owned child has no capture pipes.');
  logs={stdout:I.captureLog(child.stdout,path.join(options.out,'server.stdout.bin'),profile.limits.logBytes,error=>controller.abort(error)),
   stderr:I.captureLog(child.stderr,path.join(options.out,'server.stderr.bin'),profile.limits.logBytes,error=>controller.abort(error))};
  result.child={pid:child.pid??null,parentPid:process.pid,spawnedAt:I.clock()};
  I.saveJSON(path.join(options.out,'child-open.json'),result.child);
  mark('health');
  const healthEnd=Math.min(workEnd,Date.now()+profile.limits.startupMs);let ready=false,lastHealthError=null;
  while(Date.now()<healthEnd&&!controller.signal.aborted){
   if(spawnError)throw spawnError;
   C.insist(child.exitCode===null&&child.signalCode===null,'Owned server exited during startup.','PARITY_CHILD_EXIT');
   try{const health=await request('health','/health',undefined,{timeoutMs:1500});if(health.response.status===200&&health.json().status==='ok'){ready=true;break;}lastHealthError={status:health.response.status};}
   catch(error){lastHealthError=I.safeError(error);}
   await pause(250);
  }
  C.insist(ready,'Owned server did not become healthy: '+JSON.stringify(lastHealthError),'PARITY_STARTUP_TIMEOUT');
  result.child.observed=await I.inspectChild(child.pid,options.port);
  C.insist(result.child.observed.parentPid===process.pid&&path.resolve(result.child.observed.executablePath).toLowerCase()===path.resolve(options.exe).toLowerCase(),'Observed server ownership differs.','PARITY_OWNERSHIP');
  C.insist(result.child.observed.listeners.length>0&&result.child.observed.listeners.every(x=>x.pid===child.pid&&x.address==='127.0.0.1'),'Port belongs to another process or unexpected interface.','PARITY_OWNERSHIP');
  const relevant=result.child.observed.modules.filter(x=>/^ggml.*\.dll$/i.test(x.name));
  C.insist(relevant.some(x=>x.name.toLowerCase()==='ggml-vulkan.dll'),'The actual Vulkan backend DLL was not observed.','PARITY_BACKEND_UNKNOWN');
  result.loadedBackendModules=[];
  for(const module of relevant){const expected=result.identity.bundleBefore.find(x=>path.resolve(x.path).toLowerCase()===path.resolve(module.path).toLowerCase());C.insist(expected,'A GGML DLL loaded from outside the pinned bundle.','PARITY_BACKEND_CHANGED');result.loadedBackendModules.push({...module,sha256:expected.sha256});}
  mark('effective-runtime');
  const props=await request('props','/props'),slots=await request('slots','/slots');
  C.insist(props.response.status===200&&slots.response.status===200,'Runtime properties are unavailable.');
  result.props=props.json();result.slots=slots.json();
  result.runtime=C.assessRuntime({profile,props:result.props,slots:result.slots,model:options.model,startupLog:logs.stdout.snapshot()+'\n'+logs.stderr.snapshot()});
  I.saveJSON(path.join(options.out,'runtime-observation.json'),result.runtime);
  C.insist(result.runtime.complete,'Observed runtime differs or fields are unknown: '+JSON.stringify(result.runtime.issues),'PARITY_RUNTIME_UNKNOWN');
  mark('native-completion-cold-cached');
  const cb=C.completionBody(profile),cold=await inference('completion-cold','/completion',cb,'completion'),cached=await inference('completion-cached','/completion',cb,'completion');
  C.insist(cold.cachedPromptTokens===0&&cached.cachedPromptTokens>0,'Native cold/cached reuse was not observed.','PARITY_CACHE_UNKNOWN');
  result.parityFindings.checks.nativeColdCachedTokens=C.same(cold.tokens,cached.tokens);result.parityFindings.checks.nativeColdCachedContent=cold.content===cached.content;
  const erased=await request('erase-slot','/slots/0?action=erase',{});C.insist(erased.response.status===200,'Slot cache erasure failed.','PARITY_CACHE_RESET');
  result.cacheReset={request:erased.request,response:erased.response,body:erased.json()};
  mark('chat-tool-cold-cached');
  for(const temperature of ['cold','cached']){
   const first=await inference('chat-'+temperature+'-call','/v1/chat/completions',C.toolBody(profile),'chat');
   C.insist(temperature==='cold'?first.cachedPromptTokens===0:first.cachedPromptTokens>0,'Chat '+temperature+' cache state was not observed.','PARITY_CACHE_UNKNOWN');
   const tool=C.executeTool(profile,first);result.probes['chat-'+temperature+'-call'].toolExecution={result:tool.result,idMapping:tool.idMapping};
   const answer=await inference('chat-'+temperature+'-answer','/v1/chat/completions',tool.body,'chat');const adherence=C.validateAnswer(answer);result.probes['chat-'+temperature+'-answer'].instructionAdherence=adherence;result.instructionAdherence.observations.push({probe:'chat-'+temperature+'-answer',...adherence});
   C.insist(answer.cachedPromptTokens>0,'Tool continuation reused no observed prompt cache.','PARITY_CACHE_UNKNOWN');
  }
  const coldTool=result.probes['chat-cold-call'],cachedTool=result.probes['chat-cached-call'];
  const coldNext=result.probes['chat-cold-answer'],cachedNext=result.probes['chat-cached-answer'];
  result.parityFindings.checks.chatContinuationPayload=coldNext.request.bodySha256===cachedNext.request.bodySha256;
  const coldProjection=C.chatProjection(coldTool.result),cachedProjection=C.chatProjection(cachedTool.result);result.parityFindings.checks.chatCallOutput=C.same(coldProjection.value,cachedProjection.value);result.parityFindings.toolIdMappings={cold:coldProjection.mappings,cached:cachedProjection.mappings};
  result.parityFindings.checks.chatFinalOutput=C.same(coldNext.result.message,cachedNext.result.message);
  result.parityFindings.passed=Object.values(result.parityFindings.checks).every(x=>x===true);result.instructionAdherence.passed=result.instructionAdherence.observations.every(x=>x.exactExpectedAnswer===true);
  if(options.variant.startsWith('instrumented-')){
   mark('native-terminal-reconciliation');const end=Math.min(workEnd,Date.now()+4000);
   do{result.native=collectNative({directory:options['trace-directory'],pid:child.pid,probes:result.probes,activationCaptureEnabled:result.traceConfig.activationCaptureEnabled,configPath:tracePath,configBytes:fs.readFileSync(tracePath),propsRuntime:result.props.blackice_runtime});if(result.native.complete)break;await pause(200);}while(Date.now()<end&&!controller.signal.aborted);
   C.insist(result.native?.complete,'Native task/HTTP trace spans are incomplete.','PARITY_NATIVE_INCOMPLETE');
  }else result.native={complete:false,available:false,reason:'The original/rebuilt uninstrumented runtime does not expose live task/token trace receipts. Native /completion tokens are preserved separately.'};
  result.probesComplete=true;
 }catch(error){result.failures.push({phase,...I.safeError(error)});}
 finally{
  clearTimeout(timer);controller.abort();mark('cleanup-owned-child');
  result.cleanup=await I.settleChild(child,profile.limits.cleanupMs);
  if(!result.cleanup.settled)result.failures.push({phase:'cleanup',code:'PARITY_CHILD_UNSETTLED',message:'Owned child did not settle within its cleanup budget.'});
  if(logs){for(const key of ['stdout','stderr'])try{result[key]=logs[key].close();if(result[key].error)result.failures.push({phase:'logs',...result[key].error});}catch(error){result.failures.push({phase:'logs',...I.safeError(error)});}}
  mark('identity-after');
  try{
   if(result.identity.executable?.before){result.identity.bundleAfter=await I.bundleIdentity(options.exe,absoluteEnd-1000);result.identity.executable.after=result.identity.bundleAfter.find(x=>x.path===options.exe);C.insist(C.same(result.identity.bundleBefore,result.identity.bundleAfter),'Executable/DLL bundle changed during probe.','PARITY_IDENTITY_CHANGED');}
   if(result.identity.model?.before){result.identity.model.after=await I.hashFile(options.model,absoluteEnd-1000);C.insist(C.same(result.identity.model.before,result.identity.model.after),'Model changed during probe.','PARITY_IDENTITY_CHANGED');}
  }catch(error){result.failures.push({phase:'identity-after',...I.safeError(error)});}
  result.finishedAt=I.clock();result.collectionComplete=result.probesComplete===true&&result.cleanup.settled&&result.failures.length===0;result.complete=result.collectionComplete;result.completeMeaning='Capture and owned-process cleanup only; not task success, reasoning score, or parity acceptance.';
  result.note='Correctness qualification only. Disabled thinking and tiny constrained probes are not a reasoning benchmark. Timings remain raw evidence and are not throughput conclusions.';
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
 }
 const receipt=I.saveJSON(path.join(options.out,'result.json'),result);
 return {complete:result.complete,collectionComplete:result.collectionComplete,result:receipt,childSettled:result.cleanup.settled,parityFindings:result.parityFindings,instructionAdherence:result.instructionAdherence,failures:result.failures};
}
async function main(argv=process.argv.slice(2)){
 const {command,options}=parseArgs(argv);
 if(command==='help'){console.log(HELP);return;}
 let result;
 if(command==='run')result=await run(options);
 else{newDirectory(options.out);const left=readJSON(options.left),right=readJSON(options.right),comparison=C.compareRuns(left,right,options.mode);comparison.inputs={left:{path:options.left,sha256:C.sha(fs.readFileSync(options.left))},right:{path:options.right,sha256:C.sha(fs.readFileSync(options.right))}};result={complete:comparison.passed,result:I.saveJSON(path.join(options.out,'comparison.json'),comparison),differences:comparison.differences};}
 console.log(JSON.stringify(result));if(!result.complete||result.parityFindings?.passed===false)process.exitCode=1;
}
if(require.main===module)main().catch(error=>{console.error(JSON.stringify(I.safeError(error)));process.exitCode=1;});
module.exports={SOURCE_FILES,HELP,parseArgs,validateAdmission,run,main};
