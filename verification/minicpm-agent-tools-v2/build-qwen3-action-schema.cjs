'use strict';
// QX3: pinned action-schema grammar and retained QX2 native I/O qualification.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const SELF = __filename;
const APP_ROOT = path.resolve(__dirname, '..', '..');
const LAUNCHER = path.join(APP_ROOT, 'desktop', 'native-app-launcher.cs');
const LAUNCHER_SHA = 'ff60a3dd015fea79332519d0c3388d3b8f0755197e1bc501c380f8140f653c24';
const PROBE = path.join(__dirname, 'test-qwen3-io-compat.cpp');
const IO_FILES = ['src/llama-mmap.h','src/llama-mmap.cpp','src/llama-model-loader.cpp','src/llama-adapter.cpp'];
const OWNED = ['common/parsers/qwen3-coder.cpp', 'tests/test-chat.cpp', 'tools/server/server-context.cpp'];
const FIXTURE = path.join(__dirname, 'test-qwen3-action-schemas.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
function requireTrue(value, message) { if (!value) throw Error(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function ref(file) {
  const fd=fs.openSync(file,'r'),before=fs.fstatSync(fd),digest=crypto.createHash('sha256'),buffer=Buffer.alloc(Math.min(8*1024*1024,Math.max(1,before.size)));
  try {let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,n));
    const after=fs.fstatSync(fd);requireTrue(after.size===before.size&&after.mtimeMs===before.mtimeMs,'FILE_CHANGED_WHILE_HASHING:'+file);
    return {path:file,bytes:before.size,sha256:digest.digest('hex')};
  } finally {fs.closeSync(fd);}
}
function save(file, value, exclusive = false) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const text = JSON.stringify(value, null, 2) + '\n';
  if (exclusive) { const fd = fs.openSync(file, 'wx'); try {fs.writeFileSync(fd, text);fs.fsyncSync(fd);} finally {fs.closeSync(fd);} }
  else {
    const tmp = file + '.stage-' + process.pid;
    const fd = fs.openSync(tmp, 'wx');
    try {fs.writeFileSync(fd, text);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(tmp, file);
  }
  requireTrue(fs.readFileSync(file, 'utf8') === text, 'WRITE_READBACK:' + file);
}
function verify(expected) {
  const actual = ref(expected.path);
  requireTrue(actual.sha256 === expected.sha256 && actual.bytes === expected.bytes, 'INPUT_CHANGED:' + expected.path);
  return actual;
}
function preparation(root) {
  requireTrue(path.isAbsolute(root || ''), 'Absolute QX3 root required');
  const value = readJson(path.join(root, 'preparation.json'));
  requireTrue(value.schema === 'blackice.minicpm.qx3.prepared.v1' && value.root === root && path.dirname(value.source) === root, 'PREPARATION_ROOT');
  requireTrue(value.archive.sha256 === 'ae8556670b17c25931cd39eb7c95617650eaf6091bbcff206750583ddde1acb4', 'ARCHIVE_PIN');
  requireTrue(value.priorManifest.sha256 === 'd8c06c84cbdf16d7f130c3455220daa93949c33c8f2598c42a3a63ab6c973408', 'QX2_MANIFEST_PIN');
  return value;
}
function sourceSnapshot(prep) {
  const stock = readJson(prep.sourceBaseline.path), base = new Map(stock.entries.map(x => [x.path, x]));
  const entries = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file = path.join(dir,entry.name);
      requireTrue(!entry.isSymbolicLink(), 'SOURCE_LINK:' + file);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const item = ref(file);
        entries.push({path:path.relative(prep.source,file).replaceAll('\\','/'),bytes:item.bytes,sha256:item.sha256});
      } else throw Error('SOURCE_SPECIAL:' + file);
    }
  }
  walk(prep.source);
  const changed = entries.filter(x => !base.has(x.path) || base.get(x.path).sha256 !== x.sha256);
  const names = new Set(entries.map(x=>x.path));
  const missing = stock.entries.filter(x=>!names.has(x.path));
  requireTrue(missing.length === 0 && changed.every(x=>OWNED.includes(x.path)), 'UNOWNED_SOURCE_CHANGE');
  return {entries,contentSha256:hash(Buffer.from(JSON.stringify(entries))),changed};
}
function binding(root) {
  const prep = preparation(root);
  verify(prep.sourceBaseline);verify(prep.priorManifest);verify(prep.priorAcceptance);verify(prep.priorGreen);verify(prep.importConfig);verify(prep.composition);
  Object.values(prep.tools).forEach(verify);
  prep.imports.forEach(x=>verify(x.destination));prep.dlls.forEach(x=>verify(x.destination));prep.ioFiles.forEach(verify);
  const composition=readJson(prep.composition.path);
  composition.patches.forEach(verify);
  composition.originals.forEach(x=>{verify(x.original);verify({...x.original,path:path.join(composition.source,x.relativePath)});});
  requireTrue(ref(LAUNCHER).sha256 === LAUNCHER_SHA, 'NATIVE_LAUNCHER_CHANGED');
  const probe=verify(prep.probe),model=verify(prep.model),fixture=ref(FIXTURE),fixtureValue=readJson(FIXTURE);
  requireTrue(probe.path===PROBE && probe.sha256==='2ff9dfebb31938cc60fc3d3bef01212ea6da4d193b9e5ade2b0cadc9101344eb','IO_PROBE_PIN');
  requireTrue(fixtureValue.schema==='blackice.minicpm.qx3.action-schemas.v1'&&fixtureValue.cases.length>0,'FIXTURE_FORMAT');
  const source=sourceSnapshot(prep);
  return {at:now(),probe,model,fixture,composition:ref(prep.composition.path),controller:ref(SELF),nativeLauncher:ref(LAUNCHER),node:ref(process.execPath),
    preparation:ref(path.join(root,'preparation.json')),source,owned:OWNED.map(x=>ref(path.join(prep.source,x)))};
}
function phaseDirectory(root, phase) {
  requireTrue(/^(red|green)-[0-9]{2}$/.test(phase || ''), 'Expected red-NN or green-NN phase');
  return path.join(root, 'phases', phase);
}
function psQuote(value) { return "'" + String(value).replaceAll("'", "''") + "'"; }
function powershell() { return path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'); }
function launch(root, phase) {
  const output = phaseDirectory(root,phase), before = binding(root);
  requireTrue(!fs.existsSync(output), 'PHASE_EXISTS_USE_OBSERVE:' + output);
  const prep=preparation(root),baseline=readJson(prep.sourceBaseline.path);
  const originalParser=baseline.entries.find(x=>x.path===OWNED[0]);
  requireTrue(phase.startsWith('red-')?before.owned[0].sha256===originalParser.sha256:before.owned[0].sha256!==originalParser.sha256,'PARSER_PHASE_BINDING');
  requireTrue(before.source.changed.some(x=>x.path===OWNED[1]),'QX3_REGRESSION_NOT_PRESENT');
  if(phase.startsWith('green-')){
    const phases=path.join(root,'phases');
    const red=fs.readdirSync(phases).filter(x=>/^red-[0-9]{2}$/.test(x)).map(x=>path.join(phases,x,'result.json')).filter(fs.existsSync).map(readJson);
    requireTrue(red.some(x=>x.passed&&x.expectedFailure&&x.before.fixture.sha256===before.fixture.sha256&&x.before.owned[1].sha256===before.owned[1].sha256),'NO_MATCHING_RED_GATE');
  }
  fs.mkdirSync(output,{recursive:true});
  const intent = {schema:'blackice.minicpm.qx3.intent.v1',id:crypto.randomUUID(),at:now(),root,phase,output,before,modelStarted:false};
  save(path.join(output,'intent.json'),intent,true);
  save(path.join(output,'status.json'),{state:'launching',intentId:intent.id,at:now()},true);
  const args = [SELF,'worker',root,phase,intent.id];
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -Path ' + psQuote(LAUNCHER),
    '$qx2Receipt=[BlackiceApplicationLauncher]::Executable(' + psQuote(process.execPath) + ',[string[]]@(' + args.map(psQuote).join(',') + '),' + psQuote(root) + ')',
    '$qx2Receipt | ConvertTo-Json -Compress',
    'exit 0'
  ].join('\r\n');
  const actual = cp.spawnSync(powershell(),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {cwd:root,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
  fs.writeFileSync(path.join(output,'native-launch.stdout.log'),actual.stdout || '',{flag:'wx'});
  fs.writeFileSync(path.join(output,'native-launch.stderr.log'),actual.stderr || '',{flag:'wx'});
  save(path.join(output,'native-launch.json'),{at:now(),exitCode:actual.status,signal:actual.signal,error:actual.error?.message || null,inheritHandles:false},true);
  try {
    requireTrue(actual.status === 0 && !actual.signal && !actual.error, 'NATIVE_LAUNCH_FAILED');
    const receipt = JSON.parse(actual.stdout);
    requireTrue(receipt.launched === true && Number.isSafeInteger(receipt.pid) && Number.isFinite(Date.parse(receipt.activationProcessStartedAt)), 'NATIVE_RECEIPT_INCOMPLETE');
    const result = {launched:true,at:now(),root,phase,output,intentId:intent.id,workerPid:receipt.pid,workerStartedAt:receipt.activationProcessStartedAt,
      nativeReceipt:receipt,nativeLauncher:before.nativeLauncher,inheritHandles:false};
    save(path.join(output,'launch.json'),result,true);
    return result;
  } catch(error) {
    save(path.join(output,'launch-error.json'),{at:now(),uncertain:true,error:error.message,intentId:intent.id},true);
    throw error; // Never relaunch automatically after an uncertain CreateProcess result.
  }
}
function ownLogs(output) {
  for (const [stream,name] of [[process.stdout,'worker.stdout.log'],[process.stderr,'worker.stderr.log']]) {
    const fd = fs.openSync(path.join(output,name),'wx');
    stream.write = (chunk,encoding,callback) => {
      if (typeof encoding === 'function') {callback=encoding;encoding=undefined;}
      fs.writeSync(fd,Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk),encoding || 'utf8'));
      if(callback)callback();
      return true;
    };
  }
}
async function worker(root, phase, intentId) {
  const output = phaseDirectory(root,phase), intent = readJson(path.join(output,'intent.json'));
  requireTrue(intent.id === intentId && intent.root === root && intent.phase === phase, 'WORKER_INTENT');
  ownLogs(output);
  const state = {state:'running',at:now(),workerPid:process.pid,phase,intentId,active:null,commands:[]};
  save(path.join(output,'worker-start.json'),{at:now(),pid:process.pid,intentId},true);
  const update = () => {state.at=now();save(path.join(output,'status.json'),state);};
  const timer = setInterval(update,10000);
  let before, after, expectedFailure=false, error=null, success=false;
  const prep = preparation(root), build = path.join(root,'build'), bin = path.join(build,'bin');
  const env = {...process.env,PATH:path.dirname(prep.tools.gcc.path)+';'+process.env.PATH};
  async function run(label, executable, args, cwd, timeoutMs) {
    const started = Date.now(), index = state.commands.length+1, stem=String(index).padStart(2,'0')+'-'+label;
    const stdout=path.join(output,stem+'.stdout.log'),stderr=path.join(output,stem+'.stderr.log');
    const outfd=fs.openSync(stdout,'wx'),errfd=fs.openSync(stderr,'wx');
    const item={label,executable,args,cwd,startedAt:now(),stdout,stderr,pid:null,exitCode:null,signal:null,timedOut:false,error:null};
    const child=cp.spawn(executable,args,{cwd,env,windowsHide:true,stdio:['ignore',outfd,errfd]});
    item.pid=child.pid || null;state.active=item;update();
    let expired;
    const completed = await new Promise(resolve=>{
      const timeout=setTimeout(()=>{
        item.timedOut=true;
        expired=cp.spawnSync('C:\\Windows\\System32\\taskkill.exe',['/PID',String(child.pid),'/T','/F'],{encoding:'utf8',timeout:20000,windowsHide:true});
        item.termination={exitCode:expired.status,stdout:expired.stdout,stderr:expired.stderr,error:expired.error?.message||null};
      },timeoutMs);
      child.once('error',failure=>{item.error=failure.message;});
      child.once('close',(code,signal)=>{clearTimeout(timeout);resolve({code,signal});});
    });
    fs.closeSync(outfd);fs.closeSync(errfd);
    item.exitCode=completed.code;item.signal=completed.signal;item.finishedAt=now();item.durationMs=Date.now()-started;
    item.stdoutRef=ref(stdout);item.stderrRef=ref(stderr);
    state.commands.push(item);state.active=null;update();
    save(path.join(output,stem+'.json'),item,true);
    return item;
  }
  const requireSuccess = item => requireTrue(item.exitCode === 0 && !item.signal && !item.timedOut && !item.error,'COMMAND_FAILED:'+item.label);
  try {
    before=binding(root);
    requireTrue(before.controller.sha256 === intent.before.controller.sha256 && before.probe.sha256 === intent.before.probe.sha256 && before.fixture.sha256 === intent.before.fixture.sha256 && before.source.contentSha256 === intent.before.source.contentSha256,'SOURCE_CHANGED_BEFORE_WORKER');
    const slash=s=>s.replaceAll('\\','/');
    if (!fs.existsSync(path.join(build,'CMakeCache.txt'))) {
      const args=['-S',prep.source,'-B',build,'-G','Ninja',
        '-DCMAKE_MAKE_PROGRAM='+prep.tools.ninja.path,'-DCMAKE_C_COMPILER='+prep.tools.gcc.path,'-DCMAKE_CXX_COMPILER='+prep.tools.gxx.path,
        '-DCMAKE_RC_COMPILER='+path.join(path.dirname(prep.tools.gcc.path),'windres.exe'),
        '-DLLAMA_USE_SYSTEM_GGML=ON','-Dggml_DIR='+path.join(root,'imports'),'-DBUILD_SHARED_LIBS=OFF',
        '-DLLAMA_BUILD_COMMON=ON','-DLLAMA_BUILD_TOOLS=ON','-DLLAMA_BUILD_SERVER=ON','-DLLAMA_BUILD_APP=OFF','-DLLAMA_BUILD_TESTS=ON',
        '-DLLAMA_BUILD_EXAMPLES=OFF','-DLLAMA_BUILD_UI=OFF','-DLLAMA_USE_PREBUILT_UI=OFF','-DLLAMA_OPENSSL=OFF','-DLLAMA_CONNECT=OFF',
        '-DLLAMA_BUILD_NUMBER=12359','-DLLAMA_BUILD_COMMIT=b1b770d90','-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_CXX_FLAGS_RELEASE=-O2 -DNDEBUG','-DCMAKE_C_FLAGS_RELEASE=-O2 -DNDEBUG','-DCMAKE_EXE_LINKER_FLAGS=-static-libgcc -static-libstdc++'];
      requireSuccess(await run('configure',prep.tools.cmake.path,args.map(slash),root,120000));
    } else {
      const cache=fs.readFileSync(path.join(build,'CMakeCache.txt'),'utf8');
      requireTrue(cache.includes('CMAKE_HOME_DIRECTORY:INTERNAL='+slash(prep.source)) && cache.includes('LLAMA_BUILD_TESTS:BOOL=ON') && cache.includes('BUILD_SHARED_LIBS:BOOL=OFF'),'CACHE_BINDING');
    }
    requireSuccess(await run('build-test',prep.tools.ninja.path,['-C',build,'-j','2','test-chat'],root,2700000));
    const chat=await run('test-chat',path.join(bin,'test-chat.exe'),['--template','qwen3-coder','--action-schema-fixture',FIXTURE],prep.source,240000);
    const chatText=fs.readFileSync(chat.stdout,'utf8')+'\n'+fs.readFileSync(chat.stderr,'utf8');
    const marker=/QX3 action-schema regression (PASS|FAIL) \((\d+) valid, (\d+) invalid, (\d+) exact parses\)/.exec(chatText);
    const fixture=readJson(FIXTURE),valid=fixture.cases.filter(x=>x.valid).length,invalid=fixture.cases.length-valid;
    const qwenCases=(chatText.match(/\[models\/templates\/Qwen3-Coder\.jinja\]/g)||[]).length;
    requireTrue(marker&&Number(marker[2])===valid&&Number(marker[3])===invalid&&Number(marker[4])<=valid&&(phase.startsWith('red-')||Number(marker[4])===valid),'QX3_VALID_CASES_OR_COUNTS_FAILED');
    requireTrue(qwenCases===29&&chatText.includes('QX1 root-object-union regression PASS (6 valid calls, 16 required-field rejections)')
      &&chatText.includes('QX1 limited-scope regression PASS (3 unchanged unsupported shapes)'),'PRIOR_QWEN_GATE_INCOMPLETE');
    requireTrue(chatText.includes('ok 1 - QX3 original rendered tool prompt unchanged')
      &&chatText.includes('ok 2 - QX3 original full tool schemas unchanged'),'ORIGINAL_CONTRACT_CHANGED');
    const count=key=>{const found=[...chatText.matchAll(new RegExp('^# '+key+' (\\d+)\\r?$','gm'))];return found.length===1?Number(found[0][1]):null;};
    const counts={tests:count('tests'),pass:count('pass'),fail:count('fail')};
    requireTrue(counts.tests===fixture.cases.length+2&&counts.pass+counts.fail===counts.tests,'QX3_TAP_COUNTS');
    save(path.join(output,'grammar-result.json'),{fixture:before.fixture,qwenCases,valid,invalid,exactParses:Number(marker[4]),counts,marker:marker[1],stdout:chat.stdoutRef,stderr:chat.stderrRef},true);
    if(phase.startsWith('red-')){
      requireTrue(chat.exitCode===1&&!chat.signal&&!chat.timedOut&&!chat.error&&marker[1]==='FAIL'&&counts.fail>0
        &&chatText.includes('expected grammar acceptance false, observed true'),'EXPECTED_ACTION_SCHEMA_FAILURE_NOT_OBSERVED');
      expectedFailure=true;
    }else{
      requireSuccess(chat);
      requireTrue(marker[1]==='PASS'&&counts.fail===0&&chatText.includes('[chat] All template tests passed!'),'QX3_GREEN_INCOMPLETE');
      const probeExe=path.join(bin,'test-qwen3-io-compat-'+phase+'.exe'),fixtureDir=path.join(output,'io-fixtures');fs.mkdirSync(fixtureDir);
      const args=['-std=c++17','-O2','-DGGML_SHARED','-DQX2_IO_REPAIRED',
        ...['include','src','common','ggml/include','vendor'].map(x=>'-I'+path.join(prep.source,x)),
        PROBE,'-Wl,--start-group',path.join(build,'src','libllama.a'),
        ...[path.join(build,'vendor','hash','libvendor-hash.a')].filter(fs.existsSync),
        path.join(root,'imports','libggml.dll.a'),path.join(root,'imports','libggml-base.dll.a'),
        '-Wl,--end-group','-lbcrypt','-lws2_32','-static-libgcc','-static-libstdc++','-o',probeExe];
      requireSuccess(await run('compile-io-probe',prep.tools.gxx.path,args,root,180000));
      const io=await run('io-probe',probeExe,[before.model.path,String(before.model.bytes),fixtureDir],bin,60000);requireSuccess(io);
      const lines=fs.readFileSync(io.stdout,'utf8').trim().split(/\r?\n/),actual=JSON.parse(lines[lines.length-1]);
      requireTrue(actual.complete===true&&actual.modelStarted===false&&actual.gguf.allTensorBoundsValid===true
        &&actual.coreOwnedWriteVerified===true&&actual.coreBorrowedFileOwnershipVerified===true
        &&actual.filenameAdapterValidation.ordinaryMetadataValidationReached===true,'QX2_IO_RECEIPT_INCOMPLETE');
      save(path.join(output,'io-result.json'),actual,true);
      requireSuccess(await run('build-server',prep.tools.ninja.path,['-C',build,'-j','2','llama-server'],root,2700000));
      requireSuccess(await run('server-version',path.join(bin,'llama-server.exe'),['--version'],bin,30000));
    }
    after=binding(root);
    requireTrue(after.source.contentSha256 === before.source.contentSha256 && after.controller.sha256 === before.controller.sha256 && after.probe.sha256 === before.probe.sha256 && after.fixture.sha256 === before.fixture.sha256 && after.model.sha256 === before.model.sha256,'SOURCE_CHANGED_DURING_PHASE');
    success=true;
  } catch(failure) {error={message:failure.message,stack:failure.stack};console.error(failure.stack);}
  finally {
    clearInterval(timer);
    const result={schema:'blackice.minicpm.qx3.phase-result.v1',at:now(),root,phase,intentId,passed:success,expectedFailure,error,before,after,
      commands:state.commands,modelStarted:false};
    save(path.join(output,'result.json'),result,true);
    state.state=success?'completed':'failed';state.result=path.join(output,'result.json');state.error=error;state.active=null;update();
    process.exitCode=success?0:1;
  }
}
function observe(root,phase) {
  const output=phaseDirectory(root,phase);
  const state=readJson(path.join(output,'status.json')),launchFile=path.join(output,'launch.json'),resultFile=path.join(output,'result.json');
  const launched=fs.existsSync(launchFile)?readJson(launchFile):null;
  let live=null;
  if(launched){
    const script="$ErrorActionPreference='Stop';$p=Get-Process -Id "+launched.workerPid+" -ErrorAction SilentlyContinue;if($p){@{pid=$p.Id;startedAt=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}else{'null'}";
    const actual=cp.spawnSync(powershell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:15000,windowsHide:true});
    requireTrue(actual.status===0&&!actual.error,'PROCESS_OBSERVATION_FAILED');live=JSON.parse(actual.stdout);
    if(live)requireTrue(Math.abs(Date.parse(live.startedAt)-Date.parse(launched.workerStartedAt))<2,'WORKER_PID_REUSED');
  }
  const result=fs.existsSync(resultFile)?readJson(resultFile):null;
  const active=state.active?{...state.active,stdoutTail:tail(state.active.stdout),stderrTail:tail(state.active.stderr)}:null;
  return {root,phase,output,state:state.state,workerPid:launched?.workerPid||null,workerLive:!!live,settled:!!result&&!live,
    active,commandCount:state.commands?.length||0,result:result?{passed:result.passed,expectedFailure:result.expectedFailure,error:result.error,ref:ref(resultFile)}:null};
}
function tail(file) {
  if(!file||!fs.existsSync(file))return '';
  const fd=fs.openSync(file,'r');
  try {const size=fs.fstatSync(fd).size,buf=Buffer.alloc(Math.min(size,4000));fs.readSync(fd,buf,0,buf.length,Math.max(0,size-buf.length));return buf.toString('utf8');}
  finally {fs.closeSync(fd);}
}
(async()=>{
  const [action,root,phase,intentId]=process.argv.slice(2);
  let result;
  if(action==='launch')result=launch(root,phase);
  else if(action==='observe')result=observe(root,phase);
  else if(action==='worker'){await worker(root,phase,intentId);return;}
  else throw Error('Usage: build-qwen3-action-schema.cjs launch|observe <absolute-root> <red-NN|green-NN>');
  process.stdout.write(JSON.stringify(result)+'\n',()=>process.exit(0));
})().catch(error=>{process.stderr.write((error.stack||String(error))+'\n',()=>process.exit(1));});
