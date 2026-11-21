'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const finalSource=require('./final-source.cjs'),pin=require('./build-inputs.json');
const completion=require('./build-completion.cjs'),ui=require('./ui-source-patch.cjs');
const {inspectPe}=require('./pe.cjs');
const sourceNames=['fresh-build.cjs','fresh-build-gates.cjs','native-build-common.cjs','final-source.cjs','io-source-patch.cjs',
 'ui-source-patch.cjs','build-completion.cjs','build-completion.test.cjs',
 'build-inputs.json','prepare-build.cjs','build.cjs','pe.cjs','apply-instrumentation.cjs',...finalSource.copiedFiles,
 'runtime-lifecycle-probe.cpp','verify-instrumentation.cjs','io-compat-probe.cpp','io-request-probe.cpp',
 'http-stream-probe.cpp','verify-http-stream.cjs','dll-load-probe.cpp'];
const libraries=['tools/server/libllama-server-impl.a','tools/server/libserver-context.a','common/libllama-common.a',
 'common/libllama-common-base.a','tools/mtmd/libmtmd.a','src/libllama.a','vendor/hash/libvendor-hash.a',
 'tools/ui/libllama-ui.a','vendor/cpp-httplib/libcpp-httplib.a'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function identity(file){
 const fd=fs.openSync(file,'r'),h=crypto.createHash('sha256'),chunk=Buffer.allocUnsafe(4*1024*1024);let bytes=0;
 try{for(;;){const n=fs.readSync(fd,chunk,0,chunk.length,null);if(!n)break;h.update(chunk.subarray(0,n));bytes+=n;}}finally{fs.closeSync(fd);}
 return{path:file,bytes,sha256:h.digest('hex')};
}
function atomic(file,bytes){
 if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);fs.mkdirSync(p.dirname(file),{recursive:true});
 if(fs.existsSync(file)&&fs.readFileSync(file).equals(bytes))return;
 const tmp=file+'.stage-'+process.pid,fd=fs.openSync(tmp,'wx');
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);if(!fs.readFileSync(file).equals(bytes))throw Error('READBACK:'+file);
}
function save(file,value){atomic(file,JSON.stringify(value,null,2)+'\n');return identity(file);}
function once(file,bytes){if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);if(fs.existsSync(file)&&!fs.readFileSync(file).equals(bytes))throw Error('IMMUTABLE_CONFLICT:'+file);atomic(file,bytes);return identity(file);}
function environment(root,traceConfig){
 const result={...process.env,PATH:p.join(root,'build/bin')+';'+p.join(root,'tools/w64devkit/bin')+';'+process.env.PATH};
 delete result.BLACKICE_TRACE_CONFIG;if(traceConfig)result.BLACKICE_TRACE_CONFIG=traceConfig;return result;
}
function run(root,label,command,args,cwd=root,options={}){
 const start=Date.now();const r=cp.spawnSync(command,args,{cwd,env:environment(root,options.traceConfig),encoding:'utf8',
  timeout:options.timeout??100000,maxBuffer:24*1024*1024,windowsHide:true});
 const receipt={schema:'blackice.minicpm.fresh-build-command.v1',at:new Date(start).toISOString(),label,command,args,cwd,
  traceConfig:options.traceConfig??null,pid:r.pid,exitCode:r.status,signal:r.signal,error:r.error?.message??null,
  durationMs:Date.now()-start,stdout:r.stdout??'',stderr:r.stderr??'',modelStarted:false};
 const file=p.join(root,'commands',label+'-'+start+'.json');save(file,receipt);
 if(r.status!==0||r.error||r.signal){console.error(JSON.stringify({receipt:file,exitCode:r.status,stdout:receipt.stdout.slice(-5000),stderr:receipt.stderr.slice(-7000)}));throw Error('COMMAND_FAILED:'+label);}
 return{...receipt,receiptPath:file};
}
function state(root){
 const inputs=read(p.join(root,'fresh-inputs.json'));
 if(inputs.sourceCommit!==pin.source.commit||inputs.buildInputs.sha256!==identity(p.join(__dirname,'build-inputs.json')).sha256)throw Error('BUILD_INPUT_DRIFT');
 if(identity(inputs.originalDllManifest.path).sha256!==inputs.originalDllManifest.sha256)throw Error('ORIGINAL_DLL_MANIFEST_DRIFT');
 const ready=read(p.join(root,'receipts/source-toolchain.json')),original=read(p.join(root,'receipts/import-boundary.json'));
 return{root,inputs,ready,original,source:ready.source,build:p.join(root,'build'),bin:p.join(root,'build/bin')};
}
function sourceTools(){return sourceNames.map(name=>identity(p.join(__dirname,name)));}
function requireSource(root){
 const current=state(root),sourceState=read(p.join(root,'source-state.json'));
 if(sourceState.contentSha256!==hash(JSON.stringify(sourceState.content)))throw Error('SOURCE_MANIFEST_DIGEST');
 finalSource.verify(sourceState.content,current.source);
 for(const file of sourceState.sourceTools)if(identity(file.path).sha256!==file.sha256)throw Error('SOURCE_TOOL_DRIFT:'+file.path);
 return{...current,sourceState};
}
function disabledUi(current){
 const cache=fs.readFileSync(p.join(current.build,'CMakeCache.txt'),'utf8');
 for(const name of ['LLAMA_BUILD_UI','LLAMA_USE_PREBUILT_UI'])if(!new RegExp('^'+name+':(?:BOOL|UNINITIALIZED)=OFF\\r?$','m').test(cache))throw Error('DISABLED_UI_CONFIGURATION_REQUIRED:'+name);
 const sourceDistIndexExists=fs.existsSync(p.join(current.source,'tools/ui/dist/index.html')),
  binaryDistIndexExists=fs.existsSync(p.join(current.build,'tools/ui/dist/index.html'));
 if(sourceDistIndexExists||binaryDistIndexExists)throw Error('UNEXPECTED_DISABLED_UI_ASSET_INPUT');
 const dependencies=Object.entries(ui.dependencyPins).map(([relative,sha256])=>{
  const file=identity(p.join(current.source,relative));if(file.sha256!==sha256)throw Error('UI_GENERATOR_INPUT_DRIFT:'+relative);return file;
 });
 const outputs=Object.entries(ui.emptyOutputs).map(([relative,expected])=>{
  const file=identity(p.join(current.build,relative));if(file.sha256!==expected.sha256||file.bytes!==expected.bytes)throw Error('DISABLED_UI_OUTPUT_CHANGED:'+relative);return file;
 });
 return{complete:true,sourceDistIndexExists,binaryDistIndexExists,dependencies,outputs};
}
function buildInputs(current){
 const toolBinaries=Object.entries(current.ready.tools).sort(([a],[b])=>a.localeCompare(b)).map(([name,expected])=>{
  const file=identity(expected.path);if(file.sha256!==expected.sha256)throw Error('TOOLCHAIN_BINARY_DRIFT:'+name);return file;
 });
 const importLibraries=current.original.boundary.map(expected=>{
  const file=identity(expected.library);if(file.sha256!==expected.librarySha256)throw Error('IMPORT_LIBRARY_DRIFT:'+expected.name);return file;
 });
 return{freshInputs:identity(p.join(current.root,'fresh-inputs.json')),sourceState:identity(p.join(current.root,'source-state.json')),sourceContentSha256:current.sourceState.contentSha256,
  sourceTools:sourceTools(),toolchainReceipt:identity(p.join(current.root,'receipts/source-toolchain.json')),
  importBoundary:identity(p.join(current.root,'receipts/import-boundary.json')),toolBinaries,importLibraries,
  mathLibraries:mathFiles(current.original,current.bin),
  generatedBuildFiles:['CMakeCache.txt','build.ninja','CMakeFiles/rules.ninja','common/build-info.cpp'].map(x=>identity(p.join(current.build,x))),
  disabledUi:disabledUi(current)};
}
function buildOutputs(current){return[p.join(current.bin,'llama-server.exe'),...libraries.map(x=>p.join(current.build,x))].map(identity);}
function commandProof(root,file){
 if(p.dirname(file)!==p.join(root,'commands'))throw Error('OWNED_BUILD_COMMAND_RECEIPT_REQUIRED');
 return{artifact:identity(file),data:read(file)};
}
function preserveForRelink(current){
 const file=p.join(current.bin,'llama-server.exe');
 if(!fs.existsSync(file))return null;
 const old=identity(file),saved=once(p.join(current.root,'build-history',old.sha256+'.llama-server.exe'),fs.readFileSync(file));
 fs.unlinkSync(file);return saved;
}
function completeBuild(root,before,link,noPending){
 const current=requireSource(root),after=buildInputs(current),outputs=buildOutputs(current);
 const value=completion.createCompletedBuild({at:new Date().toISOString(),before,after,outputs,
  link:commandProof(root,link.receiptPath),noPending:commandProof(root,noPending.receiptPath)});
 const file=p.join(root,'build-complete.json');if(fs.existsSync(file))once(p.join(root,'build-history',identity(file).sha256+'.json'),fs.readFileSync(file));
 save(file,value);return identity(file);
}
function requireBuild(root){
 const current=requireSource(root),file=p.join(root,'build-complete.json');
 if(!fs.existsSync(file))throw Error('COMPLETED_BUILD_REQUIRED');
 const completedBuild=read(file),observed={inputs:buildInputs(current),outputs:buildOutputs(current),
  link:commandProof(root,completedBuild.link?.artifact?.path||''),noPending:commandProof(root,completedBuild.noPending?.artifact?.path||'')};
 completion.assertCompletedBuild(completedBuild,observed);
 return{...current,completedBuild,completedBuildIdentity:identity(file)};
}
function mathFiles(original,directory){return original.copied.map(expected=>{
 const file=identity(p.join(directory,p.basename(expected.path)));
 if(file.sha256!==expected.sha256||file.bytes!==expected.bytes)throw Error('MATH_DLL_DRIFT:'+file.path);return file;
});}
function boundary(file){
 const pe=inspectPe(file);
 for(const dll of pe.imports.filter(x=>/^ggml/i.test(x.dll)))for(const symbol of dll.names){
  if(/^\?|^_Z|^#/.test(symbol)||['ggml_fopen','gguf_init_from_file_ptr','gguf_write_to_file_ptr'].includes(symbol))throw Error('UNSAFE_IMPORT:'+symbol);
 }
 return pe.imports;
}
function modelIdentity(file){
 if(!p.isAbsolute(file||''))throw Error('EXPLICIT_ORIGINAL_GGUF_PATH_REQUIRED');
 const found=identity(file);
 if(found.bytes!==647960224||found.sha256!=='0c91d961f2eb27e8b32bbcdbae45bcdc06002e55022c6ee66ba3bf4ce347116a')throw Error('ORIGINAL_MODEL_DRIFT');
 return found;
}
function compileProbe(current,name,file,output,extraFlags=[]){
 const args=['-std=c++17','-O2','-DGGML_SHARED',...extraFlags,...['include','src','common','ggml/include','vendor','tools/server','tools/mtmd'].map(x=>'-I'+p.join(current.source,x)),
  file,'-Wl,--start-group',...libraries.map(x=>p.join(current.build,x)),p.join(current.root,'imports/libggml.dll.a'),
  p.join(current.root,'imports/libggml-base.dll.a'),'-Wl,--end-group','-lbcrypt','-lws2_32','-static-libgcc','-static-libstdc++','-o',output];
 const result=run(current.root,'compile-'+name,current.ready.tools.gxx.path,args);boundary(output);return result;
}
module.exports={fs,p,hash,read,identity,atomic,save,once,run,state,sourceTools,requireSource,requireBuild,
 buildInputs,preserveForRelink,completeBuild,mathFiles,boundary,modelIdentity,compileProbe,libraries};
