'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {inspectPe}=require('./pe.cjs');
const trace=require('./apply-instrumentation.cjs');
const [action,root,variant,model]=process.argv.slice(2);
if(!p.isAbsolute(root||''))throw Error('Absolute owned live-trace root required');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const ready=JSON.parse(fs.readFileSync(p.join(root,'receipts','source-toolchain.json')));
const original=JSON.parse(fs.readFileSync(p.join(root,'receipts','import-boundary.json')));
const source=ready.source,build=p.join(root,'build'),bin=p.join(build,'bin'),work=p.join(root,'io-compat');
const modelHash='0c91d961f2eb27e8b32bbcdbae45bcdc06002e55022c6ee66ba3bf4ce347116a';
const oldBaseline='dbe74057c20e1dd8fc0588a647bd28f4d7c7bb86d11562e6597dcc580fe024d5';
const oldInstrumented='947d381a2c5378fc36bbbd446622957187125b473e90a86d993ce138605acca7';
const expected={
 'src/llama-mmap.h':'0fff03ce62bc51b1649833f6017fbd84dc0aac7fce3b38484439153fc13ba8f5',
 'src/llama-mmap.cpp':'216548a6d625ed4bc6ac2197cfa155ff9dc102851f3d43d20f7bc7e4a1362f80',
 'src/llama-model-loader.cpp':'5cce872907839dfaf90db8deafd162fae0a339d6a322add04f55f77de65b6e73',
 'src/llama.cpp':'b848662663738a41888acbf803a7c6aac641ead31070b44d9ee6d7cc9c73b597',
 'src/llama-adapter.cpp':'1b8c87dabcdfdb1f8f663ac8802e943c581e984259a0154506c068902d544498',
 'tools/server/server-common.cpp':'350dfb104d7c1ad1ffe388c35342d93e3f90b4d5c906458952e719e13f59c346',
};
function identity(file){const bytes=fs.readFileSync(file);return{path:file,bytes:bytes.length,sha256:hash(bytes)};}
function atomic(file,bytes){if(typeof bytes==='string')bytes=Buffer.from(bytes);fs.mkdirSync(p.dirname(file),{recursive:true});if(fs.existsSync(file)&&fs.readFileSync(file).equals(bytes))return;const tmp=file+'.stage-'+process.pid;const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);if(!fs.readFileSync(file).equals(bytes))throw Error('READBACK:'+file);}
function save(file,value){atomic(file,JSON.stringify(value,null,2)+'\n');}
function once(file,bytes){if(fs.existsSync(file)){if(!fs.readFileSync(file).equals(Buffer.from(bytes)))throw Error('IMMUTABLE_CONFLICT:'+file);}else atomic(file,bytes);}
function copy(file,to){once(to,fs.readFileSync(file));return identity(to);}
function replace(text,before,after,count=1){if(text.split(before).length-1!==count)throw Error('PATCH_ANCHOR:'+before.slice(0,100));return text.split(before).join(after);}
function span(text,begin,end,replacement){const a=text.indexOf(begin),b=text.indexOf(end,a+begin.length);if(a<0||b<0||text.indexOf(begin,a+begin.length)>=0)throw Error('PATCH_SPAN:'+begin);return text.slice(0,a)+replacement+text.slice(b);}
function patch(file,input){let s=input;
 if(file==='tools/server/server-common.cpp')s=replace(s,'std::map<int, float> parse_lora_request(const json & data) {\n',
  'std::map<int, float> parse_lora_request(const json & data) {\n    if (!data.empty()) {\n        throw std::runtime_error("BLACKICE_IO_UNSUPPORTED_LORA: nonempty adapter requests are unavailable in this private qualification build");\n    }\n');
 if(file==='src/llama-mmap.h')s=replace(s,'struct llama_file;','// Private BLACKICE build: FILE objects opened here belong to the core CRT.\nFILE * llama_file_fopen(const char * fname, const char * mode);\n\nstruct llama_file;');
 if(file==='src/llama-mmap.cpp'){
  const helper=`// Private BLACKICE I/O compatibility: never return a FILE owned by the ggml DLL CRT.
FILE * llama_file_fopen(const char * fname, const char * mode) {
    if (!fname || !mode) { errno = EINVAL; return nullptr; }
#if defined(_WIN32)
    auto convert = [](const char * input, std::wstring & output) {
        const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, nullptr, 0);
        if (count <= 0) { errno = EINVAL; return false; }
        output.resize(static_cast<size_t>(count));
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, output.data(), count) != count) {
            errno = EINVAL; return false;
        }
        return true;
    };
    std::wstring wide_name, wide_mode;
    if (!convert(fname, wide_name) || !convert(mode, wide_mode)) { return nullptr; }
    return _wfopen(wide_name.c_str(), wide_mode.c_str());
#else
    return std::fopen(fname, mode);
#endif
}

`;
  s=replace(s,'// llama_file\n',helper+'// llama_file\n');
  s=replace(s,'ggml_fopen(fname.c_str(), mode)','llama_file_fopen(fname.c_str(), mode)',2);
  s=replace(s,'llama_file::llama_file(FILE * file) : pimpl(std::make_unique<impl>(file)) {}',
   'llama_file::llama_file(FILE * /*file*/) {\n    throw std::runtime_error("BLACKICE_IO_UNSUPPORTED_FILE_POINTER: use a filename in this private build");\n}');
 }
 if(file==='src/llama-model-loader.cpp'){
  s=replace(s,'ggml_fopen(fname_split, "rb")','llama_file_fopen(fname_split, "rb")');
  s=span(s,'    } else if (file != nullptr) {\n','    } else {\n        get_key(llm_kv(LLM_KV_GENERAL_ARCHITECTURE), arch_name, false);',
   '    } else if (file != nullptr) {\n        throw std::runtime_error("BLACKICE_IO_UNSUPPORTED_FILE_POINTER: use filename-based model loading");\n');
 }
 if(file==='src/llama.cpp')s=span(s,'struct llama_model * llama_model_load_from_file_ptr(FILE * file, struct llama_model_params params) {\n','\nvoid llama_model_save_to_file(',
  'struct llama_model * llama_model_load_from_file_ptr(FILE * /*file*/, struct llama_model_params /*params*/) {\n    LLAMA_LOG_ERROR("BLACKICE_IO_UNSUPPORTED_FILE_POINTER: opaque FILE* model input is unavailable in this private build; use a filename\\n");\n    return nullptr;\n}\n');
 if(file==='src/llama-adapter.cpp'){
  s=replace(s,'static void llama_adapter_lora_init_impl(llama_model & model, FILE * file, llama_adapter_lora & adapter) {',
   '#if 0 // BLACKICE private I/O build: this unqualified cross-CRT adapter implementation is excluded.\nstatic void llama_adapter_lora_init_impl(llama_model & model, FILE * file, llama_adapter_lora & adapter) {');
  s=replace(s,'int32_t llama_adapter_meta_val_str(',`#endif

llama_adapter_lora * llama_adapter_lora_init(llama_model * /*model*/, const char * /*path_lora*/) {
    LLAMA_LOG_ERROR("BLACKICE_IO_UNSUPPORTED_LORA: adapter loading is unavailable in this private qualification build\\n");
    return nullptr;
}

llama_adapter_lora * llama_adapter_lora_init_from_file_ptr(llama_model * /*model*/, FILE * /*file*/) {
    LLAMA_LOG_ERROR("BLACKICE_IO_UNSUPPORTED_LORA: opaque FILE* adapter input is unavailable in this private qualification build\\n");
    return nullptr;
}

int32_t llama_adapter_meta_val_str(`);
 }
 return s;
}
function cleanEnv(){const env={...process.env,PATH:bin+';'+p.dirname(ready.tools.gcc.path)+';'+process.env.PATH};delete env.BLACKICE_TRACE_CONFIG;return env;}
function run(label,command,args,cwd=root,timeout=100000){const at=new Date().toISOString();const result=cp.spawnSync(command,args,{cwd,env:cleanEnv(),encoding:'utf8',timeout,maxBuffer:16*1024*1024,windowsHide:true});const receipt={at,label,command,args,cwd,pid:result.pid,exitCode:result.status,signal:result.signal,error:result.error?.message??null,stdout:result.stdout??'',stderr:result.stderr??'',modelStarted:false};const file=p.join(work,'commands',label+'-'+Date.now()+'.json');save(file,receipt);if(result.status!==0||result.error||result.signal){console.error(JSON.stringify({receipt:file,...receipt,stdout:receipt.stdout.slice(-5000),stderr:receipt.stderr.slice(-7000)}));throw Error('COMMAND_FAILED:'+label);}return{...receipt,receiptPath:file};}
function mathFiles(directory){return original.copied.map(x=>{const file=p.join(directory,p.basename(x.path)),found=identity(file);if(found.sha256!==x.sha256||found.bytes!==x.bytes)throw Error('MATH_DLL_DRIFT:'+file);return found;});}
function modelIdentity(){if(!p.isAbsolute(model||''))throw Error('Explicit absolute model path required as the final probe argument');const found=identity(model);if(found.bytes!==647960224||found.sha256!==modelHash)throw Error('MODEL_IDENTITY_DRIFT');return found;}
function binaryBoundary(file){const pe=inspectPe(file);for(const dll of pe.imports.filter(d=>/^ggml/i.test(d.dll))){for(const symbol of dll.names)if(/^\?|^_Z|^#/.test(symbol)||['ggml_fopen','gguf_init_from_file_ptr','gguf_write_to_file_ptr'].includes(symbol))throw Error('UNSAFE_GGML_IMPORT:'+symbol);}return pe.imports;}
function requireVariant(){if(!['baseline','instrumented'].includes(variant))throw Error('Variant must be baseline or instrumented');}
function state(){return JSON.parse(fs.readFileSync(p.join(work,'source-state.json')));}
function requireSource(){requireVariant();const current=state();if(current.variant!==variant)throw Error('SOURCE_VARIANT_MISMATCH');for(const x of current.files)if(identity(p.join(source,x.path)).sha256!==x.sha256)throw Error('SOURCE_DRIFT:'+x.path);return current;}
function main(){
 fs.mkdirSync(work,{recursive:true});
 if(action==='preserve'){
  const archive=p.join(work,'preserved-original');if(fs.existsSync(p.join(archive,'manifest.json'))){console.log(JSON.stringify({preserved:true,manifest:p.join(archive,'manifest.json')}));return;}
  if(identity(p.join(root,'baseline','bin','llama-server.exe')).sha256!==oldBaseline||identity(p.join(bin,'llama-server.exe')).sha256!==oldInstrumented)throw Error('FROZEN_BINARY_MISMATCH');
  const files=[];for(const file of [...original.copied.map(x=>x.path),p.join(bin,'llama-server.exe')])files.push(copy(file,p.join(archive,'instrumented','bin',p.basename(file))));
  for(const name of fs.readdirSync(p.join(root,'receipts')))if(name.endsWith('.json'))files.push(copy(p.join(root,'receipts',name),p.join(archive,'receipts',name)));
  for(const name of fs.readdirSync(__dirname))if(/\.(cjs|cpp|h|json|md)$/.test(name))files.push(copy(p.join(__dirname,name),p.join(archive,'source-tools',name)));
  save(p.join(archive,'manifest.json'),{schema:'blackice.minicpm.io-preserved-history.v1',at:new Date().toISOString(),originalBaseline:{...identity(p.join(root,'baseline','bin','llama-server.exe')),untouched:true},files});
  console.log(JSON.stringify({preserved:true,files:files.length,manifest:p.join(archive,'manifest.json')}));return;
 }
 if(!fs.existsSync(p.join(work,'preserved-original','manifest.json')))throw Error('PRESERVE_HISTORY_FIRST');
 if(action==='apply'){
  requireVariant();if(hash(fs.readFileSync(p.join(__dirname,'apply-instrumentation.cjs')))!=='b5eb5a1af57cd46f6fb9747b2b3ec2f9171dfc925da92ff79c88f381abc272b0')throw Error('INSTRUMENTATION_PATCH_DRIFT');
  const pending=[];
  for(const [relative,digest]of Object.entries(expected)){
   const file=p.join(source,relative),saved=p.join(work,'upstream',relative),input=fs.existsSync(saved)?fs.readFileSync(saved):fs.readFileSync(file);
   if(hash(input)!==digest)throw Error('UPSTREAM_IO_PIN:'+relative);
   const output=Buffer.from(patch(relative,input.toString())),current=hash(fs.readFileSync(file));
   if(current!==digest&&current!==hash(output))throw Error('UNOWNED_IO_SOURCE:'+relative);
   pending.push({relative,file,saved,input,output});
  }
  for(const [relative,digest]of Object.entries(trace.expected)){
   const file=p.join(source,relative),saved=p.join(root,'upstream-files',relative),input=fs.readFileSync(saved);
   if(hash(input)!==digest)throw Error('UPSTREAM_TRACE_PIN:'+relative);
   const instrumented=Buffer.from(trace.patch(relative,input.toString())),current=hash(fs.readFileSync(file));
   if(current!==digest&&current!==hash(instrumented))throw Error('UNOWNED_TRACE_SOURCE:'+relative);
   pending.push({relative,file,output:variant==='instrumented'?instrumented:input});
  }
  for(const name of ['blackice-trace.cpp','blackice-trace.h']){const relative='src/'+name,file=p.join(source,relative),output=fs.readFileSync(p.join(__dirname,name));if(hash(fs.readFileSync(file))!==hash(output))throw Error('TRACE_IMPLEMENTATION_DRIFT');pending.push({relative,file,output});}
  for(const x of pending){if(x.saved)once(x.saved,x.input);atomic(x.file,x.output);}
  const receipt={schema:'blackice.minicpm.io-source-state.v1',at:new Date().toISOString(),variant,sourceCommit:ready.commit,ioPatchScript:identity(__filename),tracePatchScript:identity(p.join(__dirname,'apply-instrumentation.cjs')),files:pending.map(x=>({path:x.relative,bytes:x.output.length,sha256:hash(x.output)})),opaqueFileInputs:'explicitly-rejected',lora:'explicitly-rejected',modelStarted:false};
  save(p.join(work,'source-state.json'),receipt);save(p.join(work,'source-'+variant+'.json'),receipt);console.log(JSON.stringify({variant,files:receipt.files}));return;
 }
 if(action==='build-step'){
  requireSource();run('regenerate-'+variant,ready.tools.ninja.path,['-C',build,'-j','2','build.ninja']);
  const dry=run('pending-'+variant,ready.tools.ninja.path,['-C',build,'-n','llama-server']);
  const targets=[...dry.stdout.matchAll(/Building CXX object ([^\r\n]+\.obj)/g)].map(m=>m[1]);
  // UI provisioning can remain dirty in a dry run while its real command preserves unchanged files.
  // Finish the small tail in one invocation so these generated dependencies and linking settle together.
  const selected=targets.length>3?targets.slice(0,3):[];const done=run('build-'+variant,ready.tools.ninja.path,['-C',build,'-j','2',...(selected.length?selected:['llama-server'])]);
  console.log(JSON.stringify({variant,selected,remainingObjects:selected.length?Math.max(0,targets.length-selected.length):0,linked:selected.length===0,receipt:done.receiptPath,stdout:done.stdout.slice(-3500),stderr:done.stderr.slice(-1500)}));return;
 }
 if(action==='probe'){
  const current=requireSource();const before=modelIdentity(),mathBefore=mathFiles(bin);binaryBoundary(p.join(bin,'llama-server.exe'));
  const dir=p.join(work,'probe-'+variant+'-'+Date.now());fs.mkdirSync(dir,{recursive:true});
  const exe=p.join(dir,'io-compat-probe.exe'),probeSource=p.join(__dirname,'io-compat-probe.cpp');
  const args=['-std=c++17','-O2','-DGGML_SHARED','-I'+p.join(source,'include'),'-I'+p.join(source,'src'),'-I'+p.join(source,'ggml','include'),'-I'+p.join(source,'vendor'),probeSource,p.join(build,'src','libllama.a'),p.join(root,'imports','libggml.dll.a'),p.join(root,'imports','libggml-base.dll.a'),'-lbcrypt','-lws2_32','-static-libgcc','-static-libstdc++','-o',exe];
  const compile=run('probe-compile-'+variant,ready.tools.gxx.path,args);binaryBoundary(exe);
  const parserSource=p.join(__dirname,'io-request-probe.cpp'),parserExe=p.join(dir,'io-request-probe.exe');
  const parserLibraries=['tools/server/libllama-server-impl.a','tools/server/libserver-context.a','common/libllama-common.a','common/libllama-common-base.a','tools/mtmd/libmtmd.a','src/libllama.a','vendor/hash/libvendor-hash.a','tools/ui/libllama-ui.a','vendor/cpp-httplib/libcpp-httplib.a'].map(x=>p.join(build,x));
  const parserArgs=['-std=c++17','-O2','-DGGML_SHARED',...['include','src','common','ggml/include','vendor','tools/server','tools/mtmd'].map(x=>'-I'+p.join(source,x)),parserSource,'-Wl,--start-group',...parserLibraries,p.join(root,'imports','libggml.dll.a'),p.join(root,'imports','libggml-base.dll.a'),'-Wl,--end-group','-lbcrypt','-lws2_32','-static-libgcc','-static-libstdc++','-o',parserExe];
  const parserCompile=run('request-probe-compile-'+variant,ready.tools.gxx.path,parserArgs);
  const parserRun=run('request-probe-run-'+variant,parserExe,[],bin,30000),parserData=JSON.parse(parserRun.stdout);
  if(!parserData.complete||!parserData.nonemptyListExplicitlyRejected||!parserData.emptyListAllowed||parserData.modelStarted!==false)throw Error('LORA_REQUEST_PROBE_FAILED');
  const observed=run('probe-run-'+variant,exe,[model,'647960224',dir],bin,30000),data=JSON.parse(observed.stdout);
  if(data.complete!==true||data.modelStarted!==false||data.gguf?.allTensorBoundsValid!==true||data.gguf.tensorCount!==data.gguf.extents.length||data.explicitRejections?.length!==4)throw Error('IO_PROBE_INCOMPLETE');
  if(!observed.stderr.includes('BLACKICE_IO_UNSUPPORTED_FILE_POINTER')||!observed.stderr.includes('BLACKICE_IO_UNSUPPORTED_LORA'))throw Error('REJECTION_DIAGNOSTICS_MISSING');
  const after=modelIdentity();mathFiles(bin);
  const receipt={schema:'blackice.minicpm.io-probe-gate.v1',at:new Date().toISOString(),variant,complete:true,sourceState:current,binary:identity(p.join(bin,'llama-server.exe')),probeSource:identity(probeSource),probeBinary:identity(exe),compileReceipt:compile.receiptPath,runReceipt:observed.receiptPath,requestProbe:{source:identity(parserSource),binary:identity(parserExe),libraries:parserLibraries.map(identity),compileReceipt:parserCompile.receiptPath,runReceipt:parserRun.receiptPath,data:parserData},modelBefore:before,modelAfter:after,mathBefore,data,modelStarted:false,parityVerified:false};
  save(p.join(work,'probe-'+variant+'.json'),receipt);console.log(JSON.stringify({variant,complete:true,tensors:data.gguf.tensorCount,modelBytes:data.modelFile.osBytes,probeReceipt:p.join(work,'probe-'+variant+'.json'),binary:receipt.binary}));return;
 }
 if(action==='freeze'){
  const current=requireSource(),probe=JSON.parse(fs.readFileSync(p.join(work,'probe-'+variant+'.json')));
  if(!probe.complete||probe.binary.sha256!==identity(p.join(bin,'llama-server.exe')).sha256)throw Error('FRESH_IO_PROBE_REQUIRED');
  const target=p.join(root,'io-compat-'+variant),out=p.join(target,'bin');if(fs.existsSync(p.join(target,'manifest.json')))throw Error('FROZEN_VARIANT_EXISTS');
  const files=[];for(const file of [...original.copied.map(x=>x.path),p.join(bin,'llama-server.exe')])files.push(copy(file,p.join(out,p.basename(file))));
  const exe=p.join(out,'llama-server.exe'),imports=binaryBoundary(exe);mathFiles(out);
  const version=run('version-'+variant,exe,['--version'],out),help=run('help-'+variant,exe,['--help'],out),devices=run('devices-'+variant,exe,['--list-devices'],out);
  const dllExe=p.join(work,'dll-load-probe-'+variant+'.exe');run('dll-probe-compile-'+variant,ready.tools.gxx.path,['-std=c++17','-O2','-static-libgcc','-static-libstdc++',p.join(__dirname,'dll-load-probe.cpp'),'-o',dllExe]);
  const dllDir=p.join(work,'dll-'+variant);fs.mkdirSync(dllDir,{recursive:true});const dll=run('dll-observe-'+variant,dllExe,[exe,dllDir],out,60000);const events=dll.stdout.trim().split(/\r?\n/).map(JSON.parse);
  const terminal=events.filter(x=>x.event==='exit');if(terminal.length!==1||terminal[0].code!==0||terminal[0].timedOut)throw Error('DLL_PROBE_NOT_SETTLED');
  const loaded=events.filter(x=>x.event==='module').map(x=>x.path.startsWith('\\\\?\\')?x.path.slice(4):x.path).filter(x=>/^(ggml.*|libomp)\.dll$/i.test(p.basename(x))).map(file=>{const known=files.find(x=>p.basename(x.path).toLowerCase()===p.basename(file).toLowerCase());if(!known||fs.realpathSync.native(file).toLowerCase()!==fs.realpathSync.native(known.path).toLowerCase()||identity(file).sha256!==known.sha256)throw Error('LOADED_DLL_MISMATCH:'+file);return identity(file);});
  for(const name of ['ggml.dll','ggml-base.dll','ggml-vulkan.dll','libomp.dll'])if(!loaded.some(x=>p.basename(x.path)===name))throw Error('MISSING_LOADED_DLL:'+name);
  if(!loaded.some(x=>/^ggml-cpu-.*\.dll$/i.test(p.basename(x.path))))throw Error('MISSING_LOADED_CPU_DLL');
  if(events.some(x=>x.event==='module_path_unavailable'||x.event==='module_path_error'))throw Error('UNKNOWN_LOADED_MODULE_PATH');
  const receipt={schema:'blackice.minicpm.io-compat-bundle.v1',at:new Date().toISOString(),variant,sourceState:current,binary:identity(exe),files,imports,ioProbe:identity(p.join(work,'probe-'+variant+'.json')),version:version.stdout+version.stderr,cliReceipts:[version.receiptPath,help.receiptPath,devices.receiptPath],dllProbeReceipt:dll.receiptPath,loadedMathLibraries:loaded,originalMathLibrariesUnchanged:true,modelStarted:false,modelParityVerified:false,liveCoverageVerified:false};
  save(p.join(target,'manifest.json'),receipt);console.log(JSON.stringify({variant,binary:receipt.binary,manifest:p.join(target,'manifest.json'),loadedMathLibraries:loaded.length,modelStarted:false}));return;
 }
 if(action==='fixtures'){
  if(variant!=='instrumented')throw Error('INSTRUMENTED_ONLY');const frozen=p.join(root,'io-compat-instrumented'),manifest=JSON.parse(fs.readFileSync(p.join(frozen,'manifest.json'))),fixtureRoot=p.join(work,'instrumentation-fixtures-'+Date.now());
  for(const file of manifest.files)copy(file.path,p.join(fixtureRoot,'build','bin',p.basename(file.path)));fs.mkdirSync(p.join(fixtureRoot,'receipts'),{recursive:true});
  const observed=run('instrumentation-fixtures',process.execPath,[p.join(__dirname,'verify-instrumentation.cjs'),fixtureRoot],root,90000);
  const receipt=JSON.parse(fs.readFileSync(p.join(fixtureRoot,'receipts','instrumentation-fixtures.json')));if(!receipt.complete||receipt.binary.sha256!==manifest.binary.sha256)throw Error('FIXTURE_GATE_MISMATCH');
  save(p.join(work,'instrumentation-fixtures.json'),{...receipt,runnerReceipt:observed.receiptPath});console.log(JSON.stringify({complete:true,nativeSelfTests:receipt.nativeSelfTests,cliCases:receipt.cliCases,receipt:p.join(work,'instrumentation-fixtures.json')}));return;
 }
 throw Error('Unknown action: '+action);
}
try{main();}catch(error){console.error(error.stack);process.exitCode=1;}
