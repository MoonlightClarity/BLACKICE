'use strict';
const b=require('./native-build-common.cjs');
const {fs,p,read,hash,identity,save,once,run}=b;
function freshDirectory(root,name){const directory=p.join(root,'fixtures',name+'-'+Date.now());fs.mkdirSync(directory,{recursive:true});return directory;}
function gateReceipt(root,name,value){
 const current=b.requireBuild(root);
 if(value.completedBuild?.sha256!==current.completedBuildIdentity.sha256||value.binary?.sha256!==current.completedBuild.outputs[0].sha256)throw Error('BUILD_CHANGED_DURING_FIXTURE');
 const file=p.join(root,'gates',name+'.json');save(file,value);return identity(file);
}
function base(current,name){return{schema:'blackice.minicpm.fresh-'+name+'-gate.v1',at:new Date().toISOString(),complete:true,
 binary:identity(p.join(current.bin,'llama-server.exe')),sourceContentSha256:current.sourceState.contentSha256,completedBuild:current.completedBuildIdentity,modelStarted:false};}
function native(root){
 const current=b.requireBuild(root),exe=p.join(current.bin,'llama-server.exe');b.boundary(exe);b.mathFiles(current.original,current.bin);
 const binding=run(root,'build-binding-fixtures',process.execPath,['--test',p.join(__dirname,'build-completion.test.cjs')]);
 const directory=p.join(root,'fixtures','empty-native-'+Date.now());
 const command=run(root,'empty-native',exe,['--blackice-trace-empty-self-test',directory],current.bin,{timeout:90000});
 const result=read(p.join(directory,'result.json'));
 if(result.complete!==true||result.modelStarted!==false||result.cases.length!==31||result.decodeRoutes.length!==6||result.cases.some(x=>x.passed!==true)||result.decodeRoutes.some(x=>x.passed!==true))throw Error('EMPTY_NATIVE_FIXTURE_FAILED');
 const empty=result.cases.filter(x=>x.expectedAccepted===true),rejected=result.cases.filter(x=>x.expectedAccepted===false),full=result.cases.find(x=>x.name==='full-anchor-coverage');
 if(empty.length!==3||rejected.length!==27||empty.some(x=>x.backendReadCalls!==0||x.measuredTensorEvents!==0||x.emptyTensorEvents!==1)||rejected.some(x=>x.backendReadCalls!==0||x.measuredTensorEvents!==0||x.emptyTensorEvents!==0)||full.measuredTensorEvents!==93||full.emptyTensorEvents!==3||full.backendReadCalls!==93)throw Error('EMPTY_DISPOSITION_COUNTS');
 const positions=result.positionCorrespondence,allocatorSource=identity(p.join(current.source,'src/llama-batch.cpp'));
 if(positions?.complete!==true||positions.modelStarted!==false||positions.sourceSha256!==allocatorSource.sha256||
  positions.allocatorCases?.length!==4||positions.rejectionCases?.length!==18||positions.signedBoundaryCases?.length!==2||
  [...positions.allocatorCases,...positions.rejectionCases,...positions.signedBoundaryCases].some(x=>x.passed!==true)||
  positions.allocatorCases.some(x=>x.actualAllocatorAndSplit!==true||x.modelStarted!==false||![1,4].includes(x.nPositionSections)||x.firstPosition<=0||
   x.microbatches.length!==(x.outputLast?1:3)||x.sourceRows.length!==x.nTokens||x.microbatches.reduce((n,m)=>n+m.nTokens,0)!==x.nTokens)||
  result.callbackRowSource?.actualAllocatorAndSplit!==true||result.callbackRowSource.firstPosition!==17||result.callbackRowSource.nTokens!==11)throw Error('ACTUAL_POSITION_CORRESPONDENCE_REQUIRED');
 const original=run(root,'prior-native-fixtures',process.execPath,[p.join(__dirname,'verify-instrumentation.cjs'),root],root,{timeout:90000});
 const ctx=fs.readFileSync(p.join(current.source,'tools/server/server-context.cpp'),'utf8'),trace=fs.readFileSync(p.join(current.source,'src/blackice-trace.cpp'),'utf8');
 for(const token of ['trace_runtime_properties.read()','trace_runtime_properties.initialize(','trace_runtime_properties.enter_sleep(','trace_runtime_properties.leave_sleep(','ctx_server.trace_runtime_startup()','blackice_trace::route_decode_failure(ret, n_batch, blackice_trace::healthy(), slots,'])if(!ctx.includes(token))throw Error('PRODUCTION_HOOK_MISSING:'+token);
 if(!trace.includes('require_current_runtime_capture(!active->failed, state->published)'))throw Error('PRODUCTION_ADMISSION_GUARD_MISSING');
 if(!trace.includes('text_position_row_matches(source, row, micro.position_sections)')||!trace.includes('micro.position_sections = batch.n_pos;'))throw Error('PRODUCTION_POSITION_GUARD_MISSING');
 const value={...base(current,'native'),tensorCases:31,decodeRouteCases:6,positionAllocatorCases:4,positionRejectionCases:18,signedPositionBoundaryCases:2,
  allocatorSource,positionHelper:identity(p.join(current.source,'src/blackice-text-position.h')),result:identity(p.join(directory,'result.json')),
  command:command.receiptPath,priorNativeCommand:original.receiptPath,buildBindingCommand:binding.receiptPath,productionContextSource:identity(p.join(current.source,'tools/server/server-context.cpp')),
  productionTraceSource:identity(p.join(current.source,'src/blackice-trace.cpp'))};
 console.log(JSON.stringify({complete:true,receipt:gateReceipt(root,'native',value),tensorCases:31,decodeRouteCases:6,positionAllocatorCases:4,positionRejectionCases:18}));
}
function lifecycle(root){
 const current=b.requireBuild(root),directory=freshDirectory(root,'lifecycle'),exe=p.join(directory,'runtime-lifecycle-probe.exe');
 const compiled=b.compileProbe(current,'runtime-lifecycle',p.join(__dirname,'runtime-lifecycle-probe.cpp'),exe);
 const traceDirectory=p.join(directory,'trace'),config=p.join(directory,'blackice-trace.json');
 save(config,{schema:'blackice.minicpm.trace-config.v1',enabled:true,activationCaptureEnabled:false,outputDirectory:traceDirectory,
  tensorSelection:['attn_norm','attn_post_norm','ffn_out','l_out'],maxBytes:65536,logitVectorSteps:0});
 const observed=run(root,'runtime-lifecycle',exe,[],current.bin,{timeout:30000,traceConfig:config}),result=JSON.parse(observed.stdout);
 if(result.complete!==true||result.modelStarted!==false||result.actualServerQueue!==true||result.commonJsonBoundaryExercised!==true||result.cases.length!==10||result.cases.some(x=>x.passed!==true))throw Error('LIFECYCLE_FIXTURE_FAILED');
 const queueCases=result.cases.filter(x=>x.name.startsWith('actual-queue-'));
 if(result.ggmlTimerInitialized!==true||queueCases.length!==2||queueCases.some(x=>x.idleSleepMilliseconds!==1000||
  !Number.isSafeInteger(x.ggmlTimeBeforeQueueMilliseconds)||!Number.isSafeInteger(x.ggmlTimeAtSleepMilliseconds)||
  x.ggmlTimeAtSleepMilliseconds-x.ggmlTimeBeforeQueueMilliseconds<1000))throw Error('SUPPORTED_QUEUE_IDLE_INTERVAL_REQUIRED');
 const growth=result.cases.find(x=>x.name==='initial-sleep-wake-and-copy-isolation');
 if(growth?.forcedOrderedObjectGrowth!==true||growth?.publishedReceiptExact!==true||growth?.historicalReceiptExact!==true||!(growth.capacityAfterInsertion>growth.capacityBeforeInsertion))throw Error('OWNED_RECEIPT_GROWTH_PROOF_REQUIRED');
 const failed=result.cases.find(x=>x.name==='actual-queue-failed-publication');
 if(failed?.propsRejected!==true||failed?.requestAdmissionRejected!==true||failed?.decodeCalls!==0)throw Error('FAILED_WAKE_NOT_CLOSED');
 const names=fs.readdirSync(traceDirectory),markers=names.filter(x=>x.endsWith('.invalid.json'));
 if(markers.length!==1)throw Error('LIFECYCLE_INVALID_MARKER_CARDINALITY');
 const markerFile=p.join(traceDirectory,markers[0]),marker=read(markerFile);
 if(marker.pid!==observed.pid||marker.complete!==false||marker.droppedEvents!==1||!marker.reason.startsWith('Runtime properties lifecycle publication failed: injected queue publication failure'))throw Error('ACTUAL_INVALIDATION_NOT_PROVEN');
 const processFile=p.join(traceDirectory,marker.pid+'-'+marker.processId+'.process.jsonl');
 const events=fs.readFileSync(processFile,'utf8').trim().split(/\r?\n/).map(JSON.parse);
 const start=events.find(x=>x.event==='process_start'),configBytes=fs.readFileSync(config);
 if(!start||start.pid!==marker.pid||start.processId!==marker.processId||start.data.configSha256!==hash(configBytes)||start.data.configBytesUtf8!==configBytes.toString())throw Error('FIXTURE_CONFIG_BINDING');
 const resultFile=p.join(directory,'result.json');save(resultFile,result);
 const value={...base(current,'lifecycle'),cases:10,fixtureSource:identity(p.join(__dirname,'runtime-lifecycle-probe.cpp')),
  fixtureBinary:identity(exe),compileCommand:compiled.receiptPath,runCommand:observed.receiptPath,result:identity(resultFile),
  config:identity(config),expectedCaptureInvalidation:{marker:identity(markerFile),data:marker,processLog:identity(processFile)},
  helper:identity(p.join(current.source,'src/blackice-runtime-snapshot.h')),queueSource:identity(p.join(current.source,'tools/server/server-queue.cpp'))};
 console.log(JSON.stringify({complete:true,receipt:gateReceipt(root,'lifecycle',value),cases:10,actualQueue:true,failedWakeRejected:true}));
}
function io(root,model){
 const current=b.requireBuild(root),directory=freshDirectory(root,'io'),before=b.modelIdentity(model),mathBefore=b.mathFiles(current.original,current.bin);
 const exe=p.join(directory,'io-compat-probe.exe'),parser=p.join(directory,'io-request-probe.exe');
 const compile=b.compileProbe(current,'io',p.join(__dirname,'io-compat-probe.cpp'),exe);
 const parserCompile=b.compileProbe(current,'io-request',p.join(__dirname,'io-request-probe.cpp'),parser);
 const parserRun=run(root,'io-request',parser,[],current.bin,{timeout:30000}),parserResult=JSON.parse(parserRun.stdout);
 if(parserResult.complete!==true||parserResult.modelStarted!==false||parserResult.nonemptyListExplicitlyRejected!==true||parserResult.emptyListAllowed!==true)throw Error('LORA_REQUEST_REJECTION_FAILED');
 const command=run(root,'io-probe',exe,[model,'647960224',directory],current.bin,{timeout:30000}),result=JSON.parse(command.stdout);
 if(result.complete!==true||result.modelStarted!==false||result.gguf?.allTensorBoundsValid!==true||result.gguf.tensorCount!==321||result.gguf.tensorCount!==result.gguf.extents.length||result.explicitRejections?.length!==4)throw Error('IO_PROBE_INCOMPLETE');
 if(!command.stderr.includes('BLACKICE_IO_UNSUPPORTED_FILE_POINTER')||!command.stderr.includes('BLACKICE_IO_UNSUPPORTED_LORA'))throw Error('IO_REJECTION_DIAGNOSTIC_MISSING');
 const after=b.modelIdentity(model);b.mathFiles(current.original,current.bin);
 const resultFile=p.join(directory,'result.json');save(resultFile,{io:result,requestParser:parserResult});
 const value={...base(current,'io'),modelBefore:before,modelAfter:after,mathBefore,probeBinary:identity(exe),parserBinary:identity(parser),
  compileCommand:compile.receiptPath,runCommand:command.receiptPath,parserCompileCommand:parserCompile.receiptPath,parserRunCommand:parserRun.receiptPath,result:identity(resultFile)};
 console.log(JSON.stringify({complete:true,receipt:gateReceipt(root,'io',value),tensorExtents:result.gguf.tensorCount}));
}
function http(root){
 const current=b.requireBuild(root),directory=freshDirectory(root,'http'),exe=p.join(directory,'http-stream-probe.exe');
 const compiled=b.compileProbe(current,'http',p.join(__dirname,'http-stream-probe.cpp'),exe,['-DBLACKICE_FIXTURE_TRACE=1']);
 const output=p.join(directory,'results'),command=run(root,'http-stream',process.execPath,[p.join(__dirname,'verify-http-stream.cjs'),exe,'instrumented',output,current.bin],root,{timeout:60000});
 const result=read(p.join(output,'result.json'));
 if(result.complete!==true||result.modelStarted!==false||result.observations.length!==4)throw Error('ACTUAL_HTTP_FIXTURE_FAILED');
 const value={...base(current,'http'),fixtureSource:identity(p.join(__dirname,'http-stream-probe.cpp')),fixtureBinary:identity(exe),
  compileCommand:compiled.receiptPath,runCommand:command.receiptPath,result:identity(p.join(output,'result.json')),cases:4};
 console.log(JSON.stringify({complete:true,receipt:gateReceipt(root,'http',value),cases:4}));
}
function freeze(root){
 const current=b.requireBuild(root),equivalence=read(p.join(root,'source-equivalence.json')),binary=identity(p.join(current.bin,'llama-server.exe'));
 if(equivalence.complete!==true||equivalence.contentSha256!==current.sourceState.contentSha256||equivalence.sourceState.sha256!==identity(p.join(root,'source-state.json')).sha256)throw Error('FRESH_SOURCE_EQUIVALENCE_REQUIRED');
 const fixtures={};for(const name of ['native','lifecycle','io','http']){
  const file=p.join(root,'gates',name+'.json'),value=read(file);
  if(value.complete!==true||value.binary.sha256!==binary.sha256||value.sourceContentSha256!==current.sourceState.contentSha256||value.completedBuild?.sha256!==current.completedBuildIdentity.sha256)throw Error('CURRENT_GATE_REQUIRED:'+name);
  fixtures[name]=identity(file);
 }
 const target=p.join(root,'bundle'),out=p.join(target,'bin');
 if(fs.existsSync(p.join(target,'manifest.json')))throw Error('FROZEN_BUNDLE_EXISTS');
 const files=[];for(const file of [...current.original.copied.map(x=>x.path),binary.path])files.push(once(p.join(out,p.basename(file)),fs.readFileSync(file)));
 const exe=p.join(out,'llama-server.exe');if(fs.existsSync(p.join(out,'blackice-trace.json')))throw Error('UNEXPECTED_FROZEN_SIDECAR');
 const imports=b.boundary(exe);b.mathFiles(current.original,out);
 const version=run(root,'version',exe,['--version'],out),help=run(root,'help',exe,['--help'],out),devices=run(root,'devices',exe,['--list-devices'],out);
 const directory=freshDirectory(root,'dll'),probe=p.join(directory,'dll-load-probe.exe');
 const compiled=run(root,'compile-dll-probe',current.ready.tools.gxx.path,['-std=c++17','-O2','-static-libgcc','-static-libstdc++',p.join(__dirname,'dll-load-probe.cpp'),'-o',probe]);
 const observed=run(root,'dll-observe',probe,[exe,directory],out,{timeout:60000});
 const events=observed.stdout.trim().split(/\r?\n/).map(JSON.parse),terminal=events.filter(x=>x.event==='exit');
 if(terminal.length!==1||terminal[0].code!==0||terminal[0].timedOut||events.some(x=>x.event==='module_path_unavailable'||x.event==='module_path_error'))throw Error('LOADED_DLL_PROBE_INCOMPLETE');
 const loaded=events.filter(x=>x.event==='module').map(x=>x.path.startsWith('\\\\?\\')?x.path.slice(4):x.path).filter(file=>/^(ggml.*|libomp)\.dll$/i.test(p.basename(file))).map(file=>{
  const expected=files.find(x=>p.basename(x.path).toLowerCase()===p.basename(file).toLowerCase()),found=identity(file);
  if(!expected||fs.realpathSync.native(file).toLowerCase()!==fs.realpathSync.native(expected.path).toLowerCase()||found.sha256!==expected.sha256)throw Error('LOADED_DLL_DRIFT:'+file);return found;
 });
 for(const name of ['ggml.dll','ggml-base.dll','ggml-vulkan.dll','libomp.dll'])if(!loaded.some(x=>p.basename(x.path).toLowerCase()===name))throw Error('REQUIRED_LOADED_DLL:'+name);
 if(!loaded.some(x=>/^ggml-cpu-.*\.dll$/i.test(p.basename(x.path))))throw Error('MISSING_LOADED_CPU_DLL');
 if(b.requireBuild(root).completedBuildIdentity.sha256!==current.completedBuildIdentity.sha256)throw Error('BUILD_CHANGED_DURING_FREEZE');
 const value={schema:'blackice.minicpm.fresh-lifecycle-bundle.v1',at:new Date().toISOString(),variant:'instrumented',
  binary:identity(exe),files,imports,sourceState:current.sourceState,sourceEquivalence:identity(p.join(root,'source-equivalence.json')),completedBuild:current.completedBuildIdentity,
  inputs:current.inputs,toolchain:current.ready,fixtures,version:version.stdout+version.stderr,
  cliReceipts:[version.receiptPath,help.receiptPath,devices.receiptPath],dllProbeCompileReceipt:compiled.receiptPath,dllProbeReceipt:observed.receiptPath,
  loadedMathLibraries:loaded,originalMathLibrariesUnchanged:true,historicalReceiptsRequired:false,modelStarted:false,modelParityVerified:false,liveCoverageVerified:false};
 save(p.join(target,'manifest.json'),value);console.log(JSON.stringify({frozen:true,binary:value.binary,manifest:identity(p.join(target,'manifest.json')),loadedMathLibraryEvents:loaded.length}));
}
function gate(root,model){
 const current=b.requireBuild(root),manifestFile=p.join(root,'bundle/manifest.json'),bundle=read(manifestFile);
 for(const file of bundle.files)if(identity(file.path).sha256!==file.sha256)throw Error('FROZEN_FILE_DRIFT:'+file.path);
 if(bundle.sourceState.contentSha256!==current.sourceState.contentSha256)throw Error('FROZEN_SOURCE_MISMATCH');
 if(bundle.completedBuild?.sha256!==current.completedBuildIdentity.sha256)throw Error('FROZEN_COMPLETED_BUILD_MISMATCH');
 const originalModel=b.modelIdentity(model),math=b.mathFiles(current.original,p.dirname(bundle.binary.path));
 for(const receipt of Object.values(bundle.fixtures))if(identity(receipt.path).sha256!==receipt.sha256)throw Error('FROZEN_GATE_RECEIPT_DRIFT');
 const value={schema:'blackice.minicpm.fresh-lifecycle-qualification.v1',at:new Date().toISOString(),complete:true,
  qualifiedForControlledModelParity:true,scorable:false,modelOperationsPerformed:false,modelParityVerified:false,liveCoverageVerified:false,
  bundle:identity(manifestFile),binary:bundle.binary,sourceState:identity(p.join(root,'source-state.json')),sourceEquivalence:bundle.sourceEquivalence,completedBuild:current.completedBuildIdentity,
  fixtures:bundle.fixtures,originalModel,originalMathLibraries:math,sourceTools:current.sourceState.sourceTools,historicalReceiptsRequired:false};
 save(p.join(root,'qualification-gate.json'),value);console.log(JSON.stringify({complete:true,gate:identity(p.join(root,'qualification-gate.json')),binary:bundle.binary,modelStarted:false}));
}
function execute(action,root,arg){
 const actions={'native-fixtures':native,'lifecycle-fixtures':lifecycle,'io-fixtures':io,'http-fixtures':http,freeze,gate};
 if(!actions[action])throw Error('Unknown fresh-build action: '+action);return actions[action](root,arg);
}
module.exports={execute};
