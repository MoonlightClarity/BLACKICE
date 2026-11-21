#!/usr/bin/env node
'use strict';
// Standalone lifecycle qualification only. A coordinator must explicitly admit this run.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const C=require('./parity-contract.cjs'),I=require('./parity-io.cjs'),O=require('./lifecycle-observation.cjs');
const {validateAdmission}=require('./runtime-parity.cjs');
const SOURCE_FILES=Object.freeze(["runtime-lifecycle.cjs","lifecycle-observation.cjs","parity-contract.cjs","parity-io.cjs","runtime-parity.cjs","../minicpm-infrastructure/controller/context-publication-observation.cjs","text-position-correspondence.cjs","native-observation.cjs","empty-tensor-observation.cjs"]);
const HELP=[
'BLACKICE MiniCPM one-cycle sleep/wake qualification (unscored)',
'run --exe ABS --exe-sha256 HEX --bundle-manifest ABS --bundle-sha256 HEX',
'    --model ABS --model-sha256 HEX --out NEW_ABS --port INTEGER',
'    --config ABS_PROFILE_JSON --admission ABS_RECENT_HOST_CHECK_JSON',
'Starts one owned standalone server with --sleep-idle-seconds 5.',
'Requires the exact fresh-lifecycle manifest, original model, fixed full-context profile,',
'fresh app/native idle admission, metadata-only tracing, and immutable new output.',
'Captures awake/sleeping/new-awake states and one n_predict:8 native completion.',
'No model starts for --help or source tests. Failures retain evidence and exit nonzero.'
].join('\n');
const WINPATH=p=>typeof p==='string'&&/^[A-Za-z]:[\\/]/.test(p)&&path.win32.isAbsolute(p);
const samePath=(a,b)=>path.win32.normalize(a).toLowerCase()===path.win32.normalize(b).toLowerCase();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exactTime=s=>new Date(s).toISOString();
function parseArgs(argv){
 argv=argv.slice();if(argv.length===0||['help','--help'].includes(argv[0]))return {command:'help'};
 C.insist(argv.shift()==='run','Use run or --help.','LIFECYCLE_ARGS');
 const options={},keys=['exe','exe-sha256','bundle-manifest','bundle-sha256','model','model-sha256','out','port','config','admission'];
 for(let i=0;i<argv.length;i+=2){C.insist(/^--[a-z][a-z0-9-]*$/.test(argv[i])&&typeof argv[i+1]==='string'&&!argv[i+1].startsWith('--'),'Each option requires an explicit value.','LIFECYCLE_ARGS');const key=argv[i].slice(2);C.insist(keys.includes(key)&&!Object.hasOwn(options,key),'Unknown or duplicate option: '+key,'LIFECYCLE_ARGS');options[key]=argv[i+1];}
 C.insist(keys.every(k=>Object.hasOwn(options,k)),'Every documented option is required.','LIFECYCLE_ARGS');
 for(const k of ['exe','bundle-manifest','model','out','config','admission'])C.insist(WINPATH(options[k]),'Absolute Windows path required: '+k,'LIFECYCLE_ARGS');
 for(const k of ['exe-sha256','bundle-sha256','model-sha256'])C.insist(/^[a-f0-9]{64}$/.test(options[k]),'Exact lowercase SHA-256 required: '+k,'LIFECYCLE_ARGS');
 C.insist(options['model-sha256']===O.ORIGINAL_SHA,'This runner only admits the original model.','LIFECYCLE_ARGS');
 C.insist(/^[1-9]\d*$/.test(options.port),'Port must be an integer.','LIFECYCLE_ARGS');options.port=Number(options.port);C.insist(Number.isInteger(options.port)&&options.port>=1024&&options.port<=65535,'Port is outside the allowed range.','LIFECYCLE_ARGS');
 return {command:'run',options};
}
function identity(st){return {dev:String(st.dev),ino:String(st.ino),birthtimeNs:String(st.birthtimeNs)};}
function sameStat(a,b){return a.size===b.size&&C.same(identity(a),identity(b));}
function stableRead(file,limit,io=fs){
 const fd=io.openSync(file,'r');let before,after,b;
 try{before=io.fstatSync(fd,{bigint:true});C.insist(before.isFile()&&before.size>0n&&before.size<=BigInt(limit),'Artifact is empty, nonregular, or above its bound.','LIFECYCLE_FILE_LIMIT');b=Buffer.alloc(Number(before.size));let offset=0;while(offset<b.length){const n=io.readSync(fd,b,offset,b.length-offset,offset);C.insist(n>0,'Artifact ended before its frozen high-water mark.','LIFECYCLE_FILE_PARTIAL');offset+=n;}after=io.fstatSync(fd,{bigint:true});}finally{io.closeSync(fd);}
 const actual=io.statSync(file,{bigint:true});C.insist(sameStat(before,after)&&sameStat(after,actual),'Artifact identity/size changed during capture.','LIFECYCLE_FILE_RACE');
 return {bytes:b,before:{bytes:Number(before.size),identity:identity(before)},after:{bytes:Number(after.size),identity:identity(after)}};
}
function assertTracePath(file,traceDirectory,pid){
 C.insist(WINPATH(file)&&samePath(path.dirname(file),traceDirectory)&&path.basename(file).startsWith(pid+'-'),'Native trace source is outside the owned directory/process.','LIFECYCLE_TRACE_PATH');
 C.insist(samePath(fs.realpathSync(file),path.resolve(file)),'Native trace source is redirected.','LIFECYCLE_TRACE_PATH');
}
async function capturePublication({request,label,out,traceDirectory,pid,modelSha256,binarySha256,io=fs}){
 const directory=path.join(out,label);io.mkdirSync(directory);
 const before=await request(label+'-props-before','/props');
 C.insist(before.response.status===200,'Awake publication query failed.','LIFECYCLE_PUBLICATION');
 const props=before.json(),native=props.blackice_runtime;
 C.insist(props.is_sleeping===false&&props.blackice_runtime_state==='awake'&&native?.complete===true&&native.droppedEvents===0&&native.pid===pid,'Current awake publication is unavailable.','LIFECYCLE_PUBLICATION');
 assertTracePath(native.traceFile,traceDirectory,pid);
 const startedAt=I.clock(),a=stableRead(native.traceFile,268435456,io);
 const prefix=I.save(path.join(directory,'context-prefix.jsonl'),a.bytes),again=stableRead(native.traceFile,268435456,io);
 C.insist(a.bytes.equals(again.bytes)&&C.same(a.before,again.before)&&C.same(a.after,again.after),'Current context changed during independent reread.','LIFECYCLE_FILE_RACE');
 C.insist(a.bytes.at(-1)===10,'Current context prefix has a partial final line.','LIFECYCLE_FILE_PARTIAL');
 const finishedAt=I.clock(),startupPath=native.traceFile.replace(/\.jsonl$/,'.startup.json');assertTracePath(startupPath,traceDirectory,pid);
 const startup=stableRead(startupPath,8388608,io),startupArtifact=I.save(path.join(directory,'startup.native.json'),startup.bytes),startupAgain=stableRead(startupPath,8388608,io);
 C.insist(startup.bytes.equals(startupAgain.bytes)&&C.same(startup.before,startupAgain.before),'Startup artifact changed.','LIFECYCLE_FILE_RACE');
 const after=await request(label+'-props-after','/props');
 const propsResponse={startedAt:before.request.at,at:before.request.finishedAt,status:before.response.status,json:props,request:before.request};
 const propsAfterResponse={startedAt:after.request.at,at:after.request.finishedAt,status:after.response.status,json:after.json(),request:after.request};
 const input={now:I.clock(),maxEvidenceAgeMs:120000,processIdentity:null,propsResponse,startupReceipt:{...JSON.parse(startup.bytes),observedAt:I.clock(),modelSha256,binarySha256},
  currentPublication:{schema:'blackice.minicpm.context-publication-input.v1',contextPrefix:prefix,startupArtifact,contextSource:{path:native.traceFile,highWaterMark:a.bytes.length,startedAt,finishedAt,before:a.before,after:again.after,rereadSha256:C.sha(again.bytes)},propsAfterResponse}};
 I.saveJSON(path.join(directory,'capture.json'),input);
 return {input,raw:{contextPrefixBytes:fs.readFileSync(prefix.path),startupArtifactBytes:fs.readFileSync(startupArtifact.path)}};
}
function snapshotTrace(directory,destination,maxBytes,io=fs){
 io.mkdirSync(destination);const startedAt=I.clock(),names=io.readdirSync(directory).sort();
 C.insist(names.length>0&&names.length<=1000,'Trace inventory is missing or exceeds its bound.','LIFECYCLE_TRACE_LIMIT');
 let total=0;const artifacts=[],references=[];
 for(const name of names){
  C.insist(name===path.basename(name),'Invalid trace filename.','LIFECYCLE_TRACE_PATH');const source=path.join(directory,name),st=io.lstatSync(source);C.insist(st.isFile()&&!st.isSymbolicLink(),'Trace inventory includes a nonregular file.','LIFECYCLE_TRACE_PATH');
  const a=stableRead(source,maxBytes-total,io);total+=a.bytes.length;C.insist(total<=maxBytes,'Trace byte budget exceeded.','LIFECYCLE_TRACE_LIMIT');
  const copy=I.save(path.join(destination,name),a.bytes),b=stableRead(source,maxBytes,io);
  C.insist(a.bytes.equals(b.bytes)&&C.same(a.before,b.before),'Trace changed during independent reread.','LIFECYCLE_FILE_RACE');
  const preserved=io.readFileSync(copy.path);C.insist(preserved.equals(a.bytes),'Preserved trace copy differs.','LIFECYCLE_FILE_RACE');
  artifacts.push({path:source,bytes:preserved,rereadBytes:b.bytes});
  references.push({sourcePath:source,copy,before:a.before,after:b.after,rereadSha256:C.sha(b.bytes)});
 }
 C.insist(C.same(names,io.readdirSync(directory).sort()),'Trace inventory changed during capture.','LIFECYCLE_FILE_RACE');
 const receipt={schema:'blackice.minicpm.lifecycle-trace-snapshot.v1',startedAt,finishedAt:I.clock(),complete:true,files:names.length,bytes:total,references};
 return {artifacts,receipt,reference:I.saveJSON(path.join(destination,'snapshot.json'),receipt)};
}
function waitCondition(deadline,signal){C.insist(!signal.aborted,'Lifecycle work was aborted.','LIFECYCLE_TIMEOUT');C.insist(Date.now()<deadline,'Lifecycle deadline expired.','LIFECYCLE_TIMEOUT');}
function checkLoaded(observed,bundle,exe,port){
 C.insist(observed.pid>0&&samePath(observed.executablePath,exe)&&Array.isArray(observed.listeners)&&observed.listeners.length>0&&observed.listeners.every(x=>x.pid===observed.pid&&x.port===port&&x.address==='127.0.0.1'),'Child OS/listener identity differs.','LIFECYCLE_PROCESS');
 const modules=observed.modules.filter(x=>/^(?:llama|ggml.*|libomp)\.dll$/i.test(x.name));
 C.insist(modules.length>0&&modules.some(x=>/ggml-vulkan\.dll$/i.test(x.name))&&modules.every(x=>bundle.some(b=>samePath(b.path,x.path))),'Loaded math libraries differ from the frozen bundle.','LIFECYCLE_BUNDLE');
 return modules;
}
function attachLogs(handles,streams,out,bound,onFailure,capture=I.captureLog){
 // Publish each handle before opening the next capture, so partial setup remains closeable.
 for(const name of ['stdout','stderr'])handles[name]=capture(streams[name],path.join(out,'server.'+name+'.bin'),bound,onFailure);
}
function finishLogs(handles,result,out){
 for(const name of ['stdout','stderr']){
  if(!handles?.[name])continue;
  try{result[name]=handles[name].close();if(result[name].error)result.failures.push({phase:name,...result[name].error});}
  catch(error){const problem=I.safeError(error);result[name]={path:path.join(out,'server.'+name+'.bin'),bytes:null,sha256:null,error:problem};result.failures.push({phase:name,...problem});}
 }
}
function checkChildTermination(result){
 const prior=result.childBeforeCleanup,cleanup=result.cleanup;if(!prior?.pid)return;
 const exited=prior.exitCode!==null||prior.signalCode!==null;
 const badBefore=exited&&(prior.exitCode!==0||prior.signalCode!==null);
 const badUnrequested=!cleanup.requested&&((cleanup.exitCode!==null&&cleanup.exitCode!==undefined&&cleanup.exitCode!==0)||cleanup.signalCode!=null);
 // On native Windows the owned termination path can return code 1; native exception codes remain failures.
 const badRequested=Boolean(cleanup.requested)&&((cleanup.exitCode!==null&&cleanup.exitCode!==undefined&&![0,1].includes(cleanup.exitCode))||(cleanup.signalCode!=null&&!['SIGTERM','SIGKILL'].includes(cleanup.signalCode)));
 if(badBefore||badUnrequested||badRequested||cleanup.killError)result.failures.push({phase:'cleanup',code:'LIFECYCLE_CHILD_EXIT',message:'Unexpected native exit/signal or failed owned termination; exact states retained.',before:prior,cleanup});
}
async function run(options){
 C.insist(process.platform==='win32','Native Windows is required.','LIFECYCLE_PLATFORM');
 const profile=C.validateProfile(JSON.parse(fs.readFileSync(options.config,'utf8'))),admission=validateAdmission(JSON.parse(fs.readFileSync(options.admission,'utf8')));
 C.insist(!fs.existsSync(options.out),'Output exists; preserved evidence cannot be overwritten.','LIFECYCLE_OUTPUT_EXISTS');
 fs.mkdirSync(path.dirname(options.out),{recursive:true});fs.mkdirSync(options.out);
 const start=Date.now(),absoluteEnd=start+profile.limits.totalMs,workEnd=absoluteEnd-profile.limits.cleanupMs-profile.limits.postHashMs,controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(C.fail('Work deadline reached; reserved cleanup begins.','LIFECYCLE_TIMEOUT')),Math.max(1,workEnd-Date.now()));
 const stop=()=>controller.abort(C.fail('Stop requested; settle only the owned child.','LIFECYCLE_CANCELLED'));process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const result={schema:'blackice.minicpm.runtime-lifecycle-run.v1',at:I.clock(),complete:false,collectionComplete:false,scorable:false,throughputClaim:false,profile,sleepIdleSeconds:5,limits:{totalMs:profile.limits.totalMs,cleanupReserveMs:profile.limits.cleanupMs,postHashReserveMs:profile.limits.postHashMs},identity:{},requests:[],phases:[],failures:[]};
 let child=null,logs=null,phase='prepare',spawnError=null,traceDirectory=null,manifest=null,configBytes=null,before=null,after=null,completion=null;
 const mark=name=>{phase=name;result.phases.push({name,at:I.clock()});},http=path.join(options.out,'http');fs.mkdirSync(http);
 const request=I.requestRecorder({directory:http,port:options.port,profile,signal:controller.signal,deadline:workEnd,requests:result.requests});
 try{
  result.admission=I.saveJSON(path.join(options.out,'admission.json'),admission);
  result.profileInput=I.save(path.join(options.out,'profile-input.json'),fs.readFileSync(options.config));
  result.source=Object.fromEntries(SOURCE_FILES.map(f=>[f,C.sha(fs.readFileSync(path.join(__dirname,f)))]));
  const manifestBytes=fs.readFileSync(options['bundle-manifest']);C.insist(C.sha(manifestBytes)===options['bundle-sha256'],'Frozen manifest hash differs.','LIFECYCLE_MANIFEST');manifest=JSON.parse(manifestBytes);
  result.manifest=I.save(path.join(options.out,'bundle-manifest.json'),manifestBytes);result.frozen=O.validateManifest(manifest,{manifestPath:options['bundle-manifest'],executable:options.exe,executableSha256:options['exe-sha256']});
  result.versionReceipts=[];for(const file of manifest.cliReceipts){C.insist(WINPATH(file),'CLI receipt path is not absolute.','LIFECYCLE_MANIFEST');const raw=fs.readFileSync(file),receipt=JSON.parse(raw);if(Array.isArray(receipt.args)&&receipt.args.length===1&&receipt.args[0]==='--version'){C.insist(receipt.exitCode===0&&receipt.signal===null&&receipt.modelStarted===false&&samePath(receipt.command,options.exe)&&receipt.stdout+receipt.stderr===manifest.version,'Frozen version receipt differs.','LIFECYCLE_BUILD');result.versionReceipts.push({sourcePath:file,copy:I.save(path.join(options.out,'version-'+result.versionReceipts.length+'.json'),raw)});}}
  C.insist(result.versionReceipts.length===1,'Exactly one actual --version receipt is required.','LIFECYCLE_BUILD');
  mark('identity-before');result.identity.bundleBefore=await I.bundleIdentity(options.exe,workEnd);O.compareBundle(result.identity.bundleBefore,manifest);
  result.identity.modelBefore=await I.hashFile(options.model,workEnd);C.insist(result.identity.modelBefore.sha256===O.ORIGINAL_SHA&&options['model-sha256']===O.ORIGINAL_SHA,'Original GGUF hash differs.','LIFECYCLE_MODEL');
  await I.portFree(options.port);result.nativeProcessesBefore=await I.scanServers();C.insist(Array.isArray(result.nativeProcessesBefore)&&result.nativeProcessesBefore.length===0,'Another llama server/CLI exists; no model was started.','LIFECYCLE_INFERENCE_BUSY');validateAdmission(admission);
  traceDirectory=path.join(options.out,'native-trace');fs.mkdirSync(traceDirectory);
  result.traceConfig={schema:'blackice.minicpm.trace-config.v1',enabled:true,activationCaptureEnabled:false,outputDirectory:traceDirectory,tensorSelection:profile.trace.tensorSelection,maxBytes:profile.trace.maxBytes,logitVectorSteps:0};
  result.traceConfigEvidence=I.saveJSON(path.join(options.out,'blackice-trace.json'),result.traceConfig);configBytes=fs.readFileSync(result.traceConfigEvidence.path);
  C.insist(typeof process.env.LOCALAPPDATA==='string'&&WINPATH(process.env.LOCALAPPDATA),'Installed source location unavailable.','LIFECYCLE_ENV_SOURCE');
  result.environmentPolicySource=await I.hashFile(path.join(process.env.LOCALAPPDATA,'Programs','BLACKICE','resources','app',I.RESTART_ORIGIN_SOURCE.relativePath),workEnd);
  C.insist(result.environmentPolicySource.sha256===I.RESTART_ORIGIN_SOURCE.sha256,'Restart-origin source changed.','LIFECYCLE_ENV_SOURCE');
  const env=I.childEnvironment(result.traceConfigEvidence.path);result.childEnvironmentEvidence={schema:'blackice.minicpm.child-environment.v1',policy:I.RESTART_ORIGIN_SOURCE,source:result.environmentPolicySource,fingerprintScope:env.fingerprintScope,baseSha256:env.fingerprint,actualSha256:env.actualFingerprint,baseVariableHashes:env.baseVariableHashes,actualVariableHashes:env.actualVariableHashes,removed:env.removedProvenance};
  result.slotDirectory=path.join(options.out,'slot-state');fs.mkdirSync(result.slotDirectory);
  result.argv=[...C.buildArgv(profile,{model:options.model,port:options.port,slotDirectory:result.slotDirectory}),'--sleep-idle-seconds','5'];
  result.command={executable:options.exe,args:result.argv,cwd:path.dirname(options.exe),shell:false};result.launch=I.saveJSON(path.join(options.out,'launch.json'),{...result.command,traceConfigEvidence:result.traceConfigEvidence,childEnvironmentEvidence:result.childEnvironmentEvidence});
  waitCondition(workEnd,controller.signal);mark('spawn-owned-child');child=spawn(options.exe,result.argv,{cwd:path.dirname(options.exe),env:env.env,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
  child.once('error',error=>{spawnError=error;controller.abort(error);});C.insist(child.stdout&&child.stderr,'Owned child capture pipes are unavailable.','LIFECYCLE_PROCESS');
  logs={};attachLogs(logs,child,options.out,profile.limits.logBytes,e=>controller.abort(e));
  result.child={pid:child.pid??null,parentPid:process.pid,spawnedAt:I.clock()};result.childOpen=I.saveJSON(path.join(options.out,'child-open.json'),result.child);
  mark('initial-health');const readyEnd=Math.min(workEnd,Date.now()+profile.limits.startupMs);
  while(true){waitCondition(readyEnd,controller.signal);if(spawnError)throw spawnError;C.insist(child.exitCode===null&&child.signalCode===null,'Owned server exited before readiness.','LIFECYCLE_PROCESS');try{const r=await request('health','/health',undefined,{timeoutMs:2000});if(r.response.status===200)break;C.insist(r.response.status===503,'Unexpected readiness status.','LIFECYCLE_HTTP');}catch(e){if(e.code&&e.code!=='ECONNREFUSED')throw e;if(!['TypeError','TimeoutError','AbortError'].includes(e.name)&&e.code!=='ECONNREFUSED')throw e;}await pause(150);}
  mark('first-current-publication');before=await capturePublication({request,label:'before',out:options.out,traceDirectory,pid:child.pid,modelSha256:O.ORIGINAL_SHA,binarySha256:options['exe-sha256']});
  mark('independent-child-identity');result.child.observed=await I.inspectChild(child.pid,options.port);C.insist(result.child.observed.pid===child.pid,'Observed child PID differs.','LIFECYCLE_PROCESS');result.loadedBackendModules=checkLoaded(result.child.observed,result.identity.bundleBefore,options.exe,options.port);
  const processIdentity={pid:child.pid,startedAt:exactTime(result.child.observed.createdAt),executablePath:result.child.observed.executablePath};before.input.processIdentity=processIdentity;
  result.before=I.saveJSON(path.join(options.out,'before-input.json'),before.input);
  mark('observe-sleep');const sleepEnd=Math.min(workEnd,Date.now()+15000);let asleep;
  while(true){waitCondition(sleepEnd,controller.signal);const r=await request('sleep-props','/props',undefined,{timeoutMs:3000});C.insist(r.response.status===200,'Sleep observation HTTP failure.','LIFECYCLE_HTTP');const value=r.json();if(value.is_sleeping===true){asleep={startedAt:r.request.at,at:r.request.finishedAt,status:r.response.status,json:value,request:r.request};break;}C.insist(value.is_sleeping===false&&value.blackice_runtime_state==='awake'&&C.same(value.blackice_runtime,before.input.propsResponse.json.blackice_runtime),'Publication changed unexpectedly before sleep.','LIFECYCLE_CONTEXT');await pause(250);}
  result.sleep=I.saveJSON(path.join(options.out,'sleep.json'),asleep);
  C.insist(asleep.json.blackice_runtime===null&&asleep.json.blackice_runtime_state==='sleeping'&&C.same(asleep.json.blackice_previous_runtime,before.input.propsResponse.json.blackice_runtime),'Sleeping snapshot retained a current/foreign publication.','LIFECYCLE_SLEEP');
  mark('one-waking-completion');const r=await request('wake-completion','/completion',{...C.completionBody(profile),n_predict:8},{timeoutMs:30000});C.insist(r.response.status===200,'Waking inference returned HTTP '+r.response.status,'LIFECYCLE_HTTP');result.completion={request:r.request,response:r.response,returned:C.validateCompletion(r.json())};result.completionReference=I.saveJSON(path.join(options.out,'completion.json'),result.completion);
  completion={request:r.request,response:r.response,requestBytes:fs.readFileSync(r.request.body.path),responseBytes:r.bytes};
  mark('new-current-publication');after=await capturePublication({request,label:'after',out:options.out,traceDirectory,pid:child.pid,modelSha256:O.ORIGINAL_SHA,binarySha256:options['exe-sha256']});after.input.processIdentity=processIdentity;result.after=I.saveJSON(path.join(options.out,'after-input.json'),after.input);
  mark('settled-task-trace');const trace=snapshotTrace(traceDirectory,path.join(options.out,'trace-observed'),profile.trace.maxBytes);
  result.traceSnapshot=trace.reference;
  const observationInput={profile,now:I.clock(),processIdentity,modelIdentity:{path:options.model,sha256:O.ORIGINAL_SHA},expectedBuild:result.frozen.build,config:{path:result.traceConfigEvidence.path,sha256:C.sha(configBytes),bytes:configBytes},before,sleep:asleep,after,completion,trace};
  result.observation=O.observeLifecycle(observationInput);result.observationReference=I.saveJSON(path.join(options.out,'lifecycle-observation.json'),result.observation);
  C.insist(result.observation.complete,'Native lifecycle evidence is incomplete: '+JSON.stringify(result.observation.failures),'LIFECYCLE_OBSERVATION');
  result.probeComplete=true;
 }catch(error){result.failures.push({phase,...I.safeError(error)});}
 finally{
  clearTimeout(timer);controller.abort();mark('cleanup');result.childBeforeCleanup=child?.pid?{at:I.clock(),pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode}:null;result.cleanup=await I.settleChild(child,Math.max(1,Math.min(profile.limits.cleanupMs,absoluteEnd-profile.limits.postHashMs-Date.now())));
  if(!result.cleanup.settled)result.failures.push({phase:'cleanup',code:'LIFECYCLE_CHILD_UNSETTLED',message:'Owned child did not settle.'});
  checkChildTermination(result);finishLogs(logs,result,options.out);
  if(traceDirectory&&fs.existsSync(traceDirectory)&&fs.readdirSync(traceDirectory).length)try{const final=snapshotTrace(traceDirectory,path.join(options.out,'trace-final'),profile.trace.maxBytes);result.finalTrace=final.reference;result.finalVolume={files:final.receipt.files,bytes:final.receipt.bytes};const invalid=final.receipt.references.filter(x=>x.sourcePath.endsWith('.invalid.json'));if(invalid.length)result.failures.push({phase:'final-trace',code:'LIFECYCLE_NATIVE_INVALID',message:'Native invalid marker retained.',artifacts:invalid.map(x=>x.copy)});}catch(e){result.failures.push({phase:'final-trace',...I.safeError(e)});}
  try{mark('identity-after');if(result.identity.modelBefore){result.identity.modelAfter=await I.hashFile(options.model,absoluteEnd);C.insist(result.identity.modelAfter.sha256===result.identity.modelBefore.sha256&&result.identity.modelAfter.bytes===result.identity.modelBefore.bytes,'Model changed during run.','LIFECYCLE_IDENTITY');}if(result.identity.bundleBefore){result.identity.bundleAfter=await I.bundleIdentity(options.exe,absoluteEnd);O.compareBundle(result.identity.bundleAfter,manifest);C.insist(C.same(result.identity.bundleBefore,result.identity.bundleAfter),'Bundle identity or timestamp changed during run.','LIFECYCLE_IDENTITY');}if(configBytes)C.insist(fs.readFileSync(result.traceConfigEvidence.path).equals(configBytes),'Trace config changed during process lifetime.','LIFECYCLE_CONFIG');if(result.source){result.sourceAfter=Object.fromEntries(Object.keys(result.source).map(f=>[f,C.sha(fs.readFileSync(path.join(__dirname,f)))]));C.insist(C.same(result.source,result.sourceAfter),'Runner/helper sources changed during qualification.','LIFECYCLE_SOURCE_CHANGED');}}catch(e){result.failures.push({phase:'identity-after',...I.safeError(e)});}
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
 }
 if(Date.now()>absoluteEnd)result.failures.push({phase:'deadline',code:'LIFECYCLE_TIMEOUT',message:'Inclusive total deadline was exceeded.'});
 result.finishedAt=I.clock();result.collectionComplete=result.probeComplete===true&&result.cleanup?.settled===true&&result.failures.length===0;result.complete=result.collectionComplete;
 result.completeMeaning='One exact observed sleep/wake cycle with a settled task, independent active-context proof, unchanged files, and owned-child cleanup. No benchmark score, speed claim, or continuous-liveness assertion.';
 const reference=I.saveJSON(path.join(options.out,'result.json'),result);
 console.log(JSON.stringify({reference,complete:result.complete,child:result.child?{pid:result.child.pid}:null,cleanup:result.cleanup,observation:result.observation,failures:result.failures,finalVolume:result.finalVolume}));
 return result;
}
if(require.main===module){Promise.resolve().then(async()=>{const args=parseArgs(process.argv.slice(2));if(args.command==='help'){console.log(HELP);return;}const result=await run(args.options);if(!result.complete)process.exitCode=1;}).catch(e=>{console.error(JSON.stringify(I.safeError(e)));process.exitCode=1;});}
module.exports={SOURCE_FILES,HELP,parseArgs,identity,sameStat,stableRead,assertTracePath,capturePublication,snapshotTrace,checkLoaded,attachLogs,finishLogs,checkChildTermination,run};
