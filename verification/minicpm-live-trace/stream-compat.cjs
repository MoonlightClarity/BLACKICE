'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {inspectPe}=require('./pe.cjs');
const [action,root,variant,model]=process.argv.slice(2);
if(!p.isAbsolute(root||''))throw Error('Absolute owned trace root required');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=f=>JSON.parse(fs.readFileSync(f));
const ready=read(p.join(root,'receipts','source-toolchain.json')),original=read(p.join(root,'receipts','import-boundary.json'));
const source=ready.source,build=p.join(root,'build'),bin=p.join(build,'bin'),work=p.join(root,'stream-compat');
const oldBinary={baseline:'383ce0d62688e3b040f70b7cc53b8a23b69fa31711f95b52e99e27a9b43c8996',instrumented:'9e26454e91bfa8b40d22969c338a5bdaeeb9801566b2b9ab4c5fa38d58f95692'};
const oldManifest={baseline:'66d99c685eed11b47c227283b8b6a1ce0e059bf792b94ad27ab8c8da382cc85b',instrumented:'10847fda1c4b0c15ee6cf77af47e846bd851544e3b2add86f537400c7b3c0424'};
const libraries=['tools/server/libllama-server-impl.a','tools/server/libserver-context.a','common/libllama-common.a','common/libllama-common-base.a','tools/mtmd/libmtmd.a','src/libllama.a','vendor/hash/libvendor-hash.a','tools/ui/libllama-ui.a','vendor/cpp-httplib/libcpp-httplib.a'];
function identity(file){const b=fs.readFileSync(file);return{path:file,bytes:b.length,sha256:hash(b)};}
function atomic(file,value){const b=Buffer.isBuffer(value)?value:Buffer.from(value);fs.mkdirSync(p.dirname(file),{recursive:true});if(fs.existsSync(file)&&fs.readFileSync(file).equals(b))return;const tmp=file+'.stage-'+process.pid;const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);if(!fs.readFileSync(file).equals(b))throw Error('READBACK:'+file);}
function save(file,value){atomic(file,JSON.stringify(value,null,2)+'\n');}
function once(file,b){if(fs.existsSync(file)){if(!fs.readFileSync(file).equals(Buffer.from(b)))throw Error('IMMUTABLE_CONFLICT:'+file);}else atomic(file,b);return identity(file);}
function cleanEnv(){const env={...process.env,PATH:bin+';'+p.dirname(ready.tools.gcc.path)+';'+process.env.PATH};delete env.BLACKICE_TRACE_CONFIG;return env;}
function run(label,command,args,cwd=root,timeout=100000){const result=cp.spawnSync(command,args,{cwd,env:cleanEnv(),encoding:'utf8',timeout,maxBuffer:16*1024*1024,windowsHide:true});const receipt={at:new Date().toISOString(),label,command,args,cwd,pid:result.pid,exitCode:result.status,signal:result.signal,error:result.error?.message??null,stdout:result.stdout??'',stderr:result.stderr??'',modelStarted:false};const file=p.join(work,'commands',label+'-'+Date.now()+'.json');save(file,receipt);if(result.status!==0||result.error||result.signal){console.error(JSON.stringify({receipt:file,exitCode:result.status,stdout:receipt.stdout.slice(-3000),stderr:receipt.stderr.slice(-7000)}));throw Error('COMMAND_FAILED:'+label);}return{...receipt,receiptPath:file};}
function mathFiles(directory){return original.copied.map(x=>{const f=identity(p.join(directory,p.basename(x.path)));if(f.sha256!==x.sha256||f.bytes!==x.bytes)throw Error('MATH_DLL_DRIFT:'+f.path);return f;});}
function binaryBoundary(file){const pe=inspectPe(file);for(const d of pe.imports.filter(x=>/^ggml/i.test(x.dll)))for(const s of d.names)if(/^\?|^_Z|^#/.test(s)||['ggml_fopen','gguf_init_from_file_ptr','gguf_write_to_file_ptr'].includes(s))throw Error('UNSAFE_IMPORT:'+s);return pe.imports;}
function preserve(){
 const dir=p.join(work,'preserved-io'),manifest=p.join(dir,'manifest.json');
 if(fs.existsSync(manifest)){console.log(JSON.stringify({preserved:true,manifest:identity(manifest)}));return;}
 const frozen=[];for(const v of ['baseline','instrumented']){const file=p.join(root,'io-compat-'+v,'manifest.json'),m=read(file);if(identity(file).sha256!==oldManifest[v]||identity(m.binary.path).sha256!==oldBinary[v])throw Error('FROZEN_IO_DRIFT:'+v);for(const f of m.files)if(identity(f.path).sha256!==f.sha256)throw Error('FROZEN_FILE_DRIFT:'+f.path);frozen.push({variant:v,manifest:identity(file),binary:identity(m.binary.path)});}
 if(identity(p.join(bin,'llama-server.exe')).sha256!==oldBinary.instrumented)throw Error('LEGACY_BUILD_REQUIRED');
 const io=read(p.join(root,'io-compat','source-state.json')),files=[];
 for(const f of io.files){const from=p.join(source,f.path);if(identity(from).sha256!==f.sha256)throw Error('SOURCE_DRIFT:'+f.path);files.push(once(p.join(dir,'source',f.path),fs.readFileSync(from)));}
 for(const name of ['blackice-trace.cpp','blackice-trace.h','apply-instrumentation.cjs','io-compat.cjs','verify-instrumentation.cjs','README.md'])files.push(once(p.join(dir,'source-tools',name),fs.readFileSync(p.join(__dirname,name))));
 once(p.join(dir,'source-state.json'),JSON.stringify(io,null,2)+'\n');
 save(manifest,{schema:'blackice.minicpm.http-preserved-history.v1',at:new Date().toISOString(),frozen,files,libraries:libraries.map(x=>identity(p.join(build,x))),modelStarted:false});
 console.log(JSON.stringify({preserved:true,manifest:identity(manifest),files:files.length}));
}
function compileFixture(){
 if(!['legacy','baseline','instrumented'].includes(variant))throw Error('Fixture variant required');
 if(variant==='legacy'){if(identity(p.join(bin,'llama-server.exe')).sha256!==oldBinary.instrumented)throw Error('LEGACY_SERVER_BINARY_REQUIRED');}
 else requireSource();
 const dir=p.join(work,'fixture-build-'+variant);if(fs.existsSync(p.join(dir,'manifest.json')))throw Error('FIXTURE_BUILD_ALREADY_FROZEN');fs.mkdirSync(dir,{recursive:true});
 const exe=p.join(dir,'http-stream-probe.exe'),src=p.join(__dirname,'http-stream-probe.cpp');
 const libs=libraries.map(x=>p.join(build,x));
 const args=['-std=c++17','-O2','-DGGML_SHARED','-DBLACKICE_FIXTURE_TRACE='+(variant==='baseline'?'0':'1'),...['include','src','common','ggml/include','vendor','tools/server','tools/mtmd'].map(x=>'-I'+p.join(source,x)),src,'-Wl,--start-group',...libs,p.join(root,'imports','libggml.dll.a'),p.join(root,'imports','libggml-base.dll.a'),'-Wl,--end-group','-lbcrypt','-lws2_32','-static-libgcc','-static-libstdc++','-o',exe];
 const compiled=run('compile-http-fixture-'+variant,ready.tools.gxx.path,args);binaryBoundary(exe);mathFiles(bin);
 const receipt={schema:'blackice.minicpm.http-fixture-build.v1',at:new Date().toISOString(),variant,source:identity(src),compiler:identity(ready.tools.gxx.path),binary:identity(exe),serverBinary:identity(p.join(bin,'llama-server.exe')),libraries:libs.map(identity),compileReceipt:compiled.receiptPath,modelStarted:false};
 save(p.join(dir,'manifest.json'),receipt);console.log(JSON.stringify({compiled:true,variant,binary:receipt.binary,manifest:p.join(dir,'manifest.json')}));
}
function fixtures(){
 const fixture=read(p.join(work,'fixture-build-'+variant,'manifest.json'));
 if(identity(fixture.binary.path).sha256!==fixture.binary.sha256)throw Error('FIXTURE_BINARY_DRIFT');
 const directory=p.join(work,'http-'+variant+'-'+Date.now());
 const result=run('real-http-'+variant,process.execPath,[p.join(__dirname,'verify-http-stream.cjs'),fixture.binary.path,variant,directory,bin],root,60000);
 const receipt=read(p.join(directory,'result.json'));if(!receipt.complete||receipt.modelStarted!==false||receipt.observations.length!==4)throw Error('HTTP_FIXTURE_FAILED');
 const output={schema:'blackice.minicpm.http-fixture-gate.v1',at:new Date().toISOString(),variant,complete:true,fixture:identity(p.join(work,'fixture-build-'+variant,'manifest.json')),result:identity(p.join(directory,'result.json')),runner:identity(p.join(__dirname,'verify-http-stream.cjs')),command:result.receiptPath,modelStarted:false};
 save(p.join(work,'http-'+variant+'.json'),output);console.log(JSON.stringify(output));
}
function requireVariant(){if(!['baseline','instrumented'].includes(variant))throw Error('Build variant required');}
function state(){return read(p.join(work,'source-state.json'));}
function requireSource(){requireVariant();const s=state();if(s.variant!==variant)throw Error('SOURCE_VARIANT');for(const f of s.files)if(identity(p.join(source,f.path)).sha256!==f.sha256)throw Error('SOURCE_DRIFT:'+f.path);return s;}
function baselineHttp(text){const from='            return has_next;\n        };\n        const auto on_complete =';if(text.split(from).length!==2)throw Error('BASELINE_HTTP_ANCHOR');return text.replace(from,'            // true means this provider invocation succeeded, including normal EOF.\n            // httplib separately checks writes performed by the void sink.done().\n            return true;\n        };\n        const auto on_complete =');}
function apply(){
 requireVariant();const reproduced=read(p.join(work,'http-legacy.json'));
 if(!reproduced.complete||!read(reproduced.result.path).oldDefectReproduced)throw Error('REPRODUCTION_REQUIRED');
 const trace=require('./apply-instrumentation.cjs'),old=read(p.join(work,'preserved-io','source-state.json'));
 const prior=fs.existsSync(p.join(work,'source-state.json'))?state():old,pending=[];
 for(const oldFile of old.files){
  const relative=oldFile.path,file=p.join(source,relative);let bytes;
  if(Object.hasOwn(trace.expected,relative)){
   const input=fs.readFileSync(p.join(root,'upstream-files',relative));if(hash(input)!==trace.expected[relative])throw Error('UPSTREAM_PIN:'+relative);
   bytes=variant==='instrumented'?Buffer.from(trace.patch(relative,input.toString('utf8'))):relative==='tools/server/server-http.cpp'?Buffer.from(baselineHttp(input.toString('utf8'))):input;
  }else if(['src/blackice-trace.cpp','src/blackice-trace.h'].includes(relative))bytes=fs.readFileSync(p.join(__dirname,p.basename(relative)));
  else{bytes=fs.readFileSync(p.join(work,'preserved-io','source',relative));if(hash(bytes)!==oldFile.sha256)throw Error('PRESERVED_SOURCE_DRIFT:'+relative);}
  const current=identity(file).sha256,expected=prior.files.find(f=>f.path===relative)?.sha256;
  if(current!==expected&&current!==hash(bytes))throw Error('UNOWNED_SOURCE:'+relative);
  pending.push({path:relative,file,bytes,beforeSha256:current});
 }
 for(const x of pending)atomic(x.file,x.bytes);
 const receipt={schema:'blackice.minicpm.http-source-state.v1',at:new Date().toISOString(),variant,sourceCommit:ready.commit,compatibility:'I/O ownership plus successful HTTP provider-return repair',
  sourceTools:['stream-compat.cjs','apply-instrumentation.cjs','blackice-trace.cpp','blackice-trace.h'].map(x=>identity(p.join(__dirname,x))),
  files:pending.map(x=>({path:x.path,bytes:x.bytes.length,sha256:hash(x.bytes),beforeSha256:x.beforeSha256})),modelStarted:false};
 save(p.join(work,'source-state.json'),receipt);save(p.join(work,'source-'+variant+'.json'),receipt);
 console.log(JSON.stringify({applied:true,variant,files:receipt.files.length,sourceState:identity(p.join(work,'source-state.json'))}));
}
function buildStep(){
 requireSource();run('regenerate-'+variant,ready.tools.ninja.path,['-C',build,'-j','2','build.ninja']);
 const dry=run('pending-'+variant,ready.tools.ninja.path,['-C',build,'-n','llama-server']);
 const targets=[...dry.stdout.matchAll(/Building CXX object ([^\r\n]+\.obj)/g)].map(m=>m[1]);
 // UI provisioning remains dirty in dry runs while its real command restats
 // unchanged generated files. Settle the small tail together to avoid selecting
 // only those already-current dependents forever. Compiler concurrency stays2.
 const selected=targets.length>3?targets.slice(0,3):[];
 const done=run('build-'+variant,ready.tools.ninja.path,['-C',build,'-j','2',...(selected.length?selected:['llama-server'])]);
 console.log(JSON.stringify({variant,selected,remainingObjects:selected.length?Math.max(0,targets.length-selected.length):0,linked:selected.length===0,receipt:done.receiptPath,stdout:done.stdout.slice(-3000),stderr:done.stderr.slice(-1000)}));
}
function freeze(){
 const current=requireSource(),http=read(p.join(work,'http-'+variant+'.json')),fixture=read(http.fixture.path);
 if(!http.complete||fixture.serverBinary.sha256!==identity(p.join(bin,'llama-server.exe')).sha256)throw Error('CURRENT_HTTP_FIXTURE_REQUIRED');
 const target=p.join(root,'io-stream-compat-'+variant),out=p.join(target,'bin');if(fs.existsSync(p.join(target,'manifest.json')))throw Error('FROZEN_TARGET_EXISTS');
 const files=[];for(const file of [...original.copied.map(x=>x.path),p.join(bin,'llama-server.exe')])files.push(once(p.join(out,p.basename(file)),fs.readFileSync(file)));
 const exe=p.join(out,'llama-server.exe'),imports=binaryBoundary(exe);mathFiles(out);
 if(fs.existsSync(p.join(out,'blackice-trace.json')))throw Error('UNEXPECTED_CANDIDATE_SIDECAR');
 const version=run('version-'+variant,exe,['--version'],out),help=run('help-'+variant,exe,['--help'],out),devices=run('devices-'+variant,exe,['--list-devices'],out);
 const dllExe=p.join(work,'dll-load-probe-'+variant+'.exe');run('compile-dll-probe-'+variant,ready.tools.gxx.path,['-std=c++17','-O2','-static-libgcc','-static-libstdc++',p.join(__dirname,'dll-load-probe.cpp'),'-o',dllExe]);
 const dir=p.join(work,'dll-'+variant);fs.mkdirSync(dir,{recursive:true});const observed=run('dll-observe-'+variant,dllExe,[exe,dir],out,60000);const events=observed.stdout.trim().split(/\r?\n/).map(JSON.parse),terminal=events.filter(x=>x.event==='exit');
 if(terminal.length!==1||terminal[0].code!==0||terminal[0].timedOut)throw Error('DLL_PROBE_INCOMPLETE');
 if(events.some(x=>x.event==='module_path_unavailable'||x.event==='module_path_error'))throw Error('UNKNOWN_LOADED_MODULE_PATH');
 const loaded=events.filter(x=>x.event==='module').map(x=>x.path.startsWith('\\\\?\\')?x.path.slice(4):x.path).filter(x=>/^(ggml.*|libomp)\.dll$/i.test(p.basename(x))).map(file=>{
  const known=files.find(x=>p.basename(x.path).toLowerCase()===p.basename(file).toLowerCase());if(!known||fs.realpathSync.native(file).toLowerCase()!==fs.realpathSync.native(known.path).toLowerCase()||identity(file).sha256!==known.sha256)throw Error('LOADED_DLL_DRIFT:'+file);return identity(file);
 });
 for(const name of ['ggml.dll','ggml-base.dll','ggml-vulkan.dll','libomp.dll'])if(!loaded.some(x=>p.basename(x.path)===name))throw Error('MISSING_LOADED_DLL:'+name);
 if(!loaded.some(x=>/^ggml-cpu-.*\.dll$/i.test(p.basename(x.path))))throw Error('MISSING_LOADED_CPU_DLL');
 const receipt={schema:'blackice.minicpm.io-http-compat-bundle.v1',at:new Date().toISOString(),variant,sourceState:current,binary:identity(exe),files,imports,
  compatibilityScope:'Core-owned file I/O plus HTTP content-provider return correction; unchanged ggml math DLLs and model bytes',
  httpFixture:identity(p.join(work,'http-'+variant+'.json')),priorIoQualification:identity(p.join(root,'io-compat','qualification-gate.json')),
  version:version.stdout+version.stderr,cliReceipts:[version.receiptPath,help.receiptPath,devices.receiptPath],dllProbeReceipt:observed.receiptPath,loadedMathLibraries:loaded,
  originalMathLibrariesUnchanged:true,modelStarted:false,modelParityVerified:false,liveCoverageVerified:false};
 save(p.join(target,'manifest.json'),receipt);console.log(JSON.stringify({frozen:true,variant,binary:receipt.binary,manifest:identity(p.join(target,'manifest.json')),loadedMathLibraries:loaded.length,modelStarted:false}));
}
function nativeFixtures(){
 if(variant!=='instrumented')throw Error('INSTRUMENTED_ONLY');const frozen=p.join(root,'io-stream-compat-instrumented'),manifest=read(p.join(frozen,'manifest.json')),fixtureRoot=p.join(work,'native-fixtures-'+Date.now());
 for(const f of manifest.files)once(p.join(fixtureRoot,'build','bin',p.basename(f.path)),fs.readFileSync(f.path));fs.mkdirSync(p.join(fixtureRoot,'receipts'),{recursive:true});
 const observed=run('native-fixtures',process.execPath,[p.join(__dirname,'verify-instrumentation.cjs'),fixtureRoot],root,90000),receipt=read(p.join(fixtureRoot,'receipts','instrumentation-fixtures.json'));
 if(!receipt.complete||receipt.binary.sha256!==manifest.binary.sha256)throw Error('NATIVE_FIXTURES_MISMATCH');
 save(p.join(work,'native-fixtures.json'),{...receipt,runnerReceipt:observed.receiptPath});console.log(JSON.stringify({complete:true,nativeSelfTests:receipt.nativeSelfTests,cliCases:receipt.cliCases,receipt:identity(p.join(work,'native-fixtures.json'))}));
}
function gate(){
 if(!p.isAbsolute(model||''))throw Error('Explicit original model path required');const modelId=identity(model);
 if(modelId.bytes!==647960224||modelId.sha256!=='0c91d961f2eb27e8b32bbcdbae45bcdc06002e55022c6ee66ba3bf4ce347116a')throw Error('MODEL_DRIFT');
 const frozen=[];for(const v of ['baseline','instrumented']){const f=p.join(root,'io-stream-compat-'+v,'manifest.json'),m=read(f);if(identity(m.binary.path).sha256!==m.binary.sha256)throw Error('BINARY_DRIFT');mathFiles(p.dirname(m.binary.path));frozen.push({manifest:identity(f),binary:m.binary,variant:v});if(identity(p.join(root,'io-compat-'+v,'manifest.json')).sha256!==oldManifest[v]||identity(p.join(root,'io-compat-'+v,'bin','llama-server.exe')).sha256!==oldBinary[v])throw Error('OLD_FROZEN_DRIFT');}
 const native=read(p.join(work,'native-fixtures.json'));if(!native.complete||native.binary.sha256!==frozen.find(x=>x.variant==='instrumented').binary.sha256)throw Error('NATIVE_GATE_REQUIRED');
 const io=read(p.join(work,'preserved-io','source-state.json')),sourceState=state();
 const ioPaths=['src/llama-mmap.h','src/llama-mmap.cpp','src/llama-model-loader.cpp','src/llama.cpp','src/llama-adapter.cpp','tools/server/server-common.cpp'];
 for(const relative of ioPaths)if(sourceState.files.find(x=>x.path===relative)?.sha256!==io.files.find(x=>x.path===relative)?.sha256)throw Error('IO_SOURCE_CHANGED:'+relative);
 const receipt={schema:'blackice.minicpm.http-compat-qualification.v1',at:new Date().toISOString(),complete:true,qualifiedForControlledModelParity:true,scorable:false,
  frozen,modelIdentity:modelId,originalModelUnchanged:true,oldBundlesPreserved:true,mathLibrariesUnchanged:true,ioSourceUnchanged:ioPaths,
  reproduction:identity(p.join(work,'http-legacy.json')),httpFixtures:['baseline','instrumented'].map(v=>identity(p.join(work,'http-'+v+'.json'))),nativeFixtures:identity(p.join(work,'native-fixtures.json')),
  sources:['http-stream-probe.cpp','verify-http-stream.cjs','stream-compat.cjs','apply-instrumentation.cjs','blackice-trace.cpp','blackice-trace.h'].map(x=>identity(p.join(__dirname,x))),
  modelOperationsPerformed:false,modelParityVerified:false,liveCoverageVerified:false};
 const file=p.join(work,'qualification-gate.json');once(file,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({complete:true,gate:identity(file),frozen,modelStarted:false}));
}
function main(){fs.mkdirSync(work,{recursive:true});if(action==='preserve')return preserve();if(!fs.existsSync(p.join(work,'preserved-io','manifest.json')))throw Error('PRESERVE_FIRST');
 const actions={'compile-fixture':compileFixture,'http-fixtures':fixtures,apply,'build-step':buildStep,freeze,'native-fixtures':nativeFixtures,gate};if(!actions[action])throw Error('Unknown action: '+action);return actions[action]();}
try{main();}catch(error){console.error(error.stack);process.exitCode=1;}
