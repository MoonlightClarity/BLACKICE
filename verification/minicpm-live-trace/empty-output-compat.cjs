'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {inspectPe}=require('./pe.cjs');
const [action,root,model]=process.argv.slice(2);
if(!p.isAbsolute(root||''))throw Error('Absolute owned trace root required');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file));
const ready=read(p.join(root,'receipts/source-toolchain.json')),original=read(p.join(root,'receipts/import-boundary.json'));
const source=ready.source,build=p.join(root,'build'),bin=p.join(build,'bin'),work=p.join(root,'empty-output-compat');
const preserved=read(p.join(work,'preserved/manifest.json')),prior=read(p.join(work,'preserved/source-state.json'));
const libraries=['tools/server/libllama-server-impl.a','tools/server/libserver-context.a','common/libllama-common.a','common/libllama-common-base.a','tools/mtmd/libmtmd.a','src/libllama.a','vendor/hash/libvendor-hash.a','tools/ui/libllama-ui.a','vendor/cpp-httplib/libcpp-httplib.a'];
const tools=['empty-output-compat.cjs','apply-instrumentation.cjs','blackice-trace.cpp','blackice-trace.h','blackice-decode-error.h','blackice-empty-self-test.inc'];
function identity(file){const fd=fs.openSync(file,'r'),h=crypto.createHash('sha256'),chunk=Buffer.allocUnsafe(4*1024*1024);let bytes=0;try{while(true){const n=fs.readSync(fd,chunk,0,chunk.length,null);if(!n)break;bytes+=n;h.update(chunk.subarray(0,n));}}finally{fs.closeSync(fd);}return{path:file,bytes,sha256:h.digest('hex')};}
function atomic(file,value){const b=Buffer.isBuffer(value)?value:Buffer.from(value);fs.mkdirSync(p.dirname(file),{recursive:true});if(fs.existsSync(file)&&fs.readFileSync(file).equals(b))return;const tmp=file+'.stage-'+process.pid;const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);if(!fs.readFileSync(file).equals(b))throw Error('READBACK:'+file);}
function save(file,value){atomic(file,JSON.stringify(value,null,2)+'\n');}
function once(file,value){const b=Buffer.isBuffer(value)?value:Buffer.from(value);if(fs.existsSync(file)){if(!fs.readFileSync(file).equals(b))throw Error('IMMUTABLE_CONFLICT:'+file);}else atomic(file,b);return identity(file);}
function env(){const result={...process.env,PATH:bin+';'+p.dirname(ready.tools.gcc.path)+';'+process.env.PATH};delete result.BLACKICE_TRACE_CONFIG;return result;}
function run(label,command,args,cwd=root,timeout=100000){const r=cp.spawnSync(command,args,{cwd,env:env(),encoding:'utf8',timeout,maxBuffer:16*1024*1024,windowsHide:true});const receipt={at:new Date().toISOString(),label,command,args,cwd,pid:r.pid,exitCode:r.status,signal:r.signal,error:r.error?.message??null,stdout:r.stdout??'',stderr:r.stderr??'',modelStarted:false};const file=p.join(work,'commands',label+'-'+Date.now()+'.json');save(file,receipt);if(r.status!==0||r.error||r.signal){console.error(JSON.stringify({receipt:file,exitCode:r.status,stdout:receipt.stdout.slice(-4000),stderr:receipt.stderr.slice(-8000)}));throw Error('COMMAND_FAILED:'+label);}return{...receipt,receiptPath:file};}
function preservedBundles(){return preserved.bundles.map(x=>{if(identity(x.manifest.path).sha256!==x.manifest.sha256||identity(x.binary.path).sha256!==x.binary.sha256)throw Error('PRESERVED_BUNDLE_DRIFT');for(const f of read(x.manifest.path).files)if(identity(f.path).sha256!==f.sha256)throw Error('PRESERVED_FILE_DRIFT:'+f.path);return x;});}
function mathFiles(directory){return original.copied.map(x=>{const f=identity(p.join(directory,p.basename(x.path)));if(f.sha256!==x.sha256||f.bytes!==x.bytes)throw Error('MATH_DLL_DRIFT:'+f.path);return f;});}
function boundary(file){const pe=inspectPe(file);for(const d of pe.imports.filter(x=>/^ggml/i.test(x.dll)))for(const s of d.names)if(/^\?|^_Z|^#/.test(s)||['ggml_fopen','gguf_init_from_file_ptr','gguf_write_to_file_ptr'].includes(s))throw Error('UNSAFE_IMPORT:'+s);return pe.imports;}
function requireSource(){const state=read(p.join(work,'source-state.json'));for(const f of state.files)if(identity(p.join(source,f.path)).sha256!==f.sha256)throw Error('SOURCE_DRIFT:'+f.path);for(const f of state.sourceTools)if(identity(f.path).sha256!==f.sha256)throw Error('SOURCE_TOOL_DRIFT:'+f.path);return state;}
function apply(){
 preservedBundles();const trace=require('./apply-instrumentation.cjs'),previous=fs.existsSync(p.join(work,'source-state.json'))?read(p.join(work,'source-state.json')):prior;
 const pending=[];
 for(const old of prior.files){const relative=old.path,file=p.join(source,relative);let bytes;
  if(Object.hasOwn(trace.expected,relative)){const input=fs.readFileSync(p.join(root,'upstream-files',relative));if(hash(input)!==trace.expected[relative])throw Error('UPSTREAM_PIN:'+relative);bytes=Buffer.from(trace.patch(relative,input.toString('utf8')));}
  else if(['src/blackice-trace.cpp','src/blackice-trace.h'].includes(relative))bytes=fs.readFileSync(p.join(__dirname,p.basename(relative)));
  else{bytes=fs.readFileSync(p.join(work,'preserved/source',relative));if(hash(bytes)!==old.sha256)throw Error('PRESERVED_SOURCE_DRIFT:'+relative);}
  const actual=identity(file).sha256,expected=previous.files.find(x=>x.path===relative)?.sha256;
  if(actual!==expected&&actual!==hash(bytes))throw Error('UNOWNED_SOURCE:'+relative);
  pending.push({path:relative,file,bytes,beforeSha256:actual});
 }
 for(const name of ['blackice-decode-error.h','blackice-empty-self-test.inc']){const relative='src/'+name,file=p.join(source,relative),bytes=fs.readFileSync(p.join(__dirname,name));const actual=fs.existsSync(file)?identity(file).sha256:null,expected=previous.files.find(x=>x.path===relative)?.sha256??null;if(actual!==expected&&actual!==hash(bytes))throw Error('UNOWNED_SOURCE:'+relative);pending.push({path:relative,file,bytes,beforeSha256:actual});}
 for(const x of pending)atomic(x.file,x.bytes);
 const state={schema:'blackice.minicpm.empty-output-source-state.v1',at:new Date().toISOString(),variant:'instrumented',sourceCommit:ready.commit,compatibility:'Prior I/O and HTTP corrections plus explicit Qwen35 empty-output disposition and trace-abort error routing',sourceTools:tools.map(x=>identity(p.join(__dirname,x))),files:pending.map(x=>({path:x.path,bytes:x.bytes.length,sha256:hash(x.bytes),beforeSha256:x.beforeSha256})),modelStarted:false};
 save(p.join(work,'source-state.json'),state);console.log(JSON.stringify({applied:true,files:state.files.length,sourceState:identity(p.join(work,'source-state.json'))}));
}
function buildStep(){requireSource();run('regenerate',ready.tools.ninja.path,['-C',build,'-j','2','build.ninja']);const dry=run('pending',ready.tools.ninja.path,['-C',build,'-n','llama-server']);const targets=[...dry.stdout.matchAll(/Building CXX object ([^\r\n]+\.obj)/g)].map(m=>m[1]);const selected=targets.length>3?targets.slice(0,3):[];const done=run('build',ready.tools.ninja.path,['-C',build,'-j','2',...(selected.length?selected:['llama-server'])]);console.log(JSON.stringify({selected,remainingObjects:selected.length?Math.max(0,targets.length-selected.length):0,linked:selected.length===0,receipt:done.receiptPath,stdout:done.stdout.slice(-3500),stderr:done.stderr.slice(-2000)}));}
function nativeFixtures(){
 requireSource();const exe=p.join(bin,'llama-server.exe');boundary(exe);mathFiles(bin);
 const directory=p.join(work,'native-'+Date.now());
 const command=run('empty-output-native',exe,['--blackice-trace-empty-self-test',directory],bin,90000);
 const result=read(p.join(directory,'result.json'));
 if(result.complete!==true||result.modelStarted!==false||result.cases.length!==24||result.decodeRoutes.length!==6||result.cases.some(x=>x.passed!==true)||result.decodeRoutes.some(x=>x.passed!==true))throw Error('EMPTY_NATIVE_FIXTURE_FAILED');
 const empty=result.cases.filter(x=>x.expectedAccepted===true),rejected=result.cases.filter(x=>x.expectedAccepted===false),full=result.cases.find(x=>x.name==='full-anchor-coverage');
 if(empty.length!==3||rejected.length!==20||empty.some(x=>x.backendReadCalls!==0||x.measuredTensorEvents!==0||x.emptyTensorEvents!==1||['perToken','statistics','rawFloat32Sha256'].some(k=>Object.hasOwn(x.observation,k)))||rejected.some(x=>x.backendReadCalls!==0||x.measuredTensorEvents!==0||x.emptyTensorEvents!==0)||full.measuredTensorEvents!==93||full.emptyTensorEvents!==3||full.backendReadCalls!==93)throw Error('EMPTY_DISPOSITION_CONTRACT');
 const sourceText=fs.readFileSync(p.join(source,'tools/server/server-context.cpp'),'utf8');if(!sourceText.includes('blackice_trace::route_decode_failure(ret, n_batch, blackice_trace::healthy(), slots,')||sourceText.includes('// TODO: handle ret == 2 (abort) when we start aborting'))throw Error('ACTUAL_SERVER_ROUTE_NOT_INSTALLED');
 const originalFixtures=run('prior-native-fixtures',process.execPath,[p.join(__dirname,'verify-instrumentation.cjs'),root],root,90000);
 const receipt={schema:'blackice.minicpm.empty-output-native-gate.v1',at:new Date().toISOString(),complete:true,binary:identity(exe),newFixture:identity(p.join(directory,'result.json')),fixtureCommand:command.receiptPath,priorNativeFixtureCommand:originalFixtures.receiptPath,serverRouteSource:identity(p.join(source,'tools/server/server-context.cpp')),helper:identity(p.join(source,'src/blackice-decode-error.h')),tensorCases:24,routeCases:6,modelStarted:false};save(p.join(work,'native-fixtures.json'),receipt);console.log(JSON.stringify(receipt));
}
function httpFixtures(){
 requireSource();const dir=p.join(work,'http-fixture-'+Date.now());fs.mkdirSync(dir,{recursive:true});const exe=p.join(dir,'http-stream-probe.exe');
 const args=['-std=c++17','-O2','-DGGML_SHARED','-DBLACKICE_FIXTURE_TRACE=1',...['include','src','common','ggml/include','vendor','tools/server','tools/mtmd'].map(x=>'-I'+p.join(source,x)),p.join(__dirname,'http-stream-probe.cpp'),'-Wl,--start-group',...libraries.map(x=>p.join(build,x)),p.join(root,'imports/libggml.dll.a'),p.join(root,'imports/libggml-base.dll.a'),'-Wl,--end-group','-lbcrypt','-lws2_32','-static-libgcc','-static-libstdc++','-o',exe];
 const compiled=run('compile-http-fixture',ready.tools.gxx.path,args);boundary(exe);
 const output=p.join(dir,'results'),checked=run('real-http-fixture',process.execPath,[p.join(__dirname,'verify-http-stream.cjs'),exe,'instrumented',output,bin],root,60000);const result=read(p.join(output,'result.json'));
 if(result.complete!==true||result.modelStarted!==false||result.observations.length!==4)throw Error('HTTP_FIXTURE_FAILED');
 const receipt={schema:'blackice.minicpm.empty-output-http-gate.v1',at:new Date().toISOString(),complete:true,binary:identity(p.join(bin,'llama-server.exe')),fixtureBinary:identity(exe),fixtureSource:identity(p.join(__dirname,'http-stream-probe.cpp')),compileCommand:compiled.receiptPath,runCommand:checked.receiptPath,result:identity(p.join(output,'result.json')),modelStarted:false};save(p.join(work,'http-fixtures.json'),receipt);console.log(JSON.stringify(receipt));
}
function freeze(){
 const state=requireSource(),native=read(p.join(work,'native-fixtures.json')),http=read(p.join(work,'http-fixtures.json')),current=identity(p.join(bin,'llama-server.exe'));
 if(!native.complete||!http.complete||native.binary.sha256!==current.sha256||http.binary.sha256!==current.sha256)throw Error('CURRENT_FIXTURES_REQUIRED');
 const preservedIdentity=preservedBundles(),target=p.join(root,'io-stream-empty-compat-instrumented'),out=p.join(target,'bin');if(fs.existsSync(p.join(target,'manifest.json')))throw Error('FROZEN_TARGET_EXISTS');
 const files=[];for(const file of [...original.copied.map(x=>x.path),current.path])files.push(once(p.join(out,p.basename(file)),fs.readFileSync(file)));
 const exe=p.join(out,'llama-server.exe'),imports=boundary(exe);mathFiles(out);if(fs.existsSync(p.join(out,'blackice-trace.json')))throw Error('UNEXPECTED_SIDECAR');
 const version=run('version',exe,['--version'],out),help=run('help',exe,['--help'],out),devices=run('devices',exe,['--list-devices'],out);
 const probe=p.join(work,'dll-load-probe.exe');run('compile-dll-probe',ready.tools.gxx.path,['-std=c++17','-O2','-static-libgcc','-static-libstdc++',p.join(__dirname,'dll-load-probe.cpp'),'-o',probe]);
 const dllDir=p.join(work,'dll-observation');fs.mkdirSync(dllDir,{recursive:true});const observed=run('dll-observe',probe,[exe,dllDir],out,60000),events=observed.stdout.trim().split(/\r?\n/).map(JSON.parse),terminal=events.filter(x=>x.event==='exit');
 if(terminal.length!==1||terminal[0].code!==0||terminal[0].timedOut||events.some(x=>x.event==='module_path_unavailable'||x.event==='module_path_error'))throw Error('DLL_PROBE_INCOMPLETE');
 const loaded=events.filter(x=>x.event==='module').map(x=>x.path.startsWith('\\\\?\\')?x.path.slice(4):x.path).filter(x=>/^(ggml.*|libomp)\.dll$/i.test(p.basename(x))).map(file=>{const known=files.find(x=>p.basename(x.path).toLowerCase()===p.basename(file).toLowerCase());if(!known||fs.realpathSync.native(file).toLowerCase()!==fs.realpathSync.native(known.path).toLowerCase()||identity(file).sha256!==known.sha256)throw Error('LOADED_DLL_DRIFT:'+file);return identity(file);});
 for(const name of ['ggml.dll','ggml-base.dll','ggml-vulkan.dll','libomp.dll'])if(!loaded.some(x=>p.basename(x.path)===name))throw Error('MISSING_LOADED_DLL:'+name);if(!loaded.some(x=>/^ggml-cpu-.*\.dll$/i.test(p.basename(x.path))))throw Error('MISSING_LOADED_CPU_DLL');
 const receipt={schema:'blackice.minicpm.io-http-empty-compat-bundle.v1',at:new Date().toISOString(),variant:'instrumented',sourceState:state,binary:identity(exe),files,imports,nativeFixture:identity(p.join(work,'native-fixtures.json')),httpFixture:identity(p.join(work,'http-fixtures.json')),priorIoQualification:identity(p.join(root,'io-compat/qualification-gate.json')),preservedBundles:preservedIdentity,version:version.stdout+version.stderr,cliReceipts:[version.receiptPath,help.receiptPath,devices.receiptPath],dllProbeReceipt:observed.receiptPath,loadedMathLibraries:loaded,originalMathLibrariesUnchanged:true,modelStarted:false,modelParityVerified:false,liveCoverageVerified:false};
 save(p.join(target,'manifest.json'),receipt);console.log(JSON.stringify({frozen:true,binary:receipt.binary,manifest:identity(p.join(target,'manifest.json')),loadedMathLibraries:loaded.length,modelStarted:false}));
}
function gate(){
 const state=requireSource(),manifest=p.join(root,'io-stream-empty-compat-instrumented/manifest.json'),bundle=read(manifest);for(const f of bundle.files)if(identity(f.path).sha256!==f.sha256)throw Error('FROZEN_FILE_DRIFT');
 if(!p.isAbsolute(model||''))throw Error('Exact original model path required for identity-only gate');const originalModel=identity(model);if(originalModel.bytes!==647960224||originalModel.sha256!=='0c91d961f2eb27e8b32bbcdbae45bcdc06002e55022c6ee66ba3bf4ce347116a')throw Error('ORIGINAL_MODEL_DRIFT');
 const priorIo=read(p.join(root,'io-compat/source-state.json')),ioFiles=priorIo.files.filter(x=>['src/llama-mmap.cpp','src/llama-mmap.h','src/llama-model-loader.cpp','src/llama-adapter.cpp','src/llama.cpp','tools/server/server-common.cpp'].includes(x.path));
 if(ioFiles.length!==6)throw Error('IO_SOURCE_SET_INCOMPLETE');
 for(const f of ioFiles)if(identity(p.join(source,f.path)).sha256!==f.sha256)throw Error('IO_REPAIR_DRIFT:'+f.path);
 const receipt={schema:'blackice.minicpm.empty-output-qualification-gate.v1',at:new Date().toISOString(),complete:true,qualifiedForControlledModelParity:true,scorable:false,modelOperationsPerformed:false,modelParityVerified:false,liveCoverageVerified:false,bundle:identity(manifest),binary:bundle.binary,sourceState:identity(p.join(work,'source-state.json')),nativeFixtures:bundle.nativeFixture,httpFixtures:bundle.httpFixture,originalModel,originalMathLibraries:mathFiles(p.dirname(bundle.binary.path)),preservedBundles:preservedBundles(),ioRepairSourcesUnchanged:ioFiles.map(x=>({path:x.path,sha256:x.sha256})),sourceTools:state.sourceTools};
 save(p.join(work,'qualification-gate.json'),receipt);console.log(JSON.stringify({complete:true,gate:identity(p.join(work,'qualification-gate.json')),binary:bundle.binary,modelStarted:false}));
}
if(action==='apply')apply();else if(action==='build-step')buildStep();else if(action==='native-fixtures')nativeFixtures();else if(action==='http-fixtures')httpFixtures();else if(action==='freeze')freeze();else if(action==='gate')gate();else throw Error('Unknown bounded action');
