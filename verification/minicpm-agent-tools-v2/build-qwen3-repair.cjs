'use strict';
// QX1: pinned, model-free native build and test receipt. No app/profile activation.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const SELF = __filename;
const APP_ROOT = path.resolve(__dirname, '..', '..');
const LAUNCHER = path.join(APP_ROOT, 'desktop', 'native-app-launcher.cs');
const LAUNCHER_SHA = 'ff60a3dd015fea79332519d0c3388d3b8f0755197e1bc501c380f8140f653c24';
const STOCK_PARSER_SHA = '52b188b89b232bc2609c8117b532328079c3729dc656ff2bbc3fff7e6f63242a';
const OWNED = ['common/parsers/qwen3-coder.cpp', 'tests/test-chat.cpp'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
function requireTrue(value, message) { if (!value) throw Error(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function ref(file) { const bytes = fs.readFileSync(file); return {path:file,bytes:bytes.length,sha256:hash(bytes)}; }
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
  requireTrue(path.isAbsolute(root || ''), 'Absolute QX1 root required');
  const value = readJson(path.join(root, 'preparation.json'));
  requireTrue(value.root === root && path.dirname(value.source) === root, 'PREPARATION_ROOT');
  requireTrue(value.archive.sha256 === 'ae8556670b17c25931cd39eb7c95617650eaf6091bbcff206750583ddde1acb4', 'ARCHIVE_PIN');
  requireTrue(value.historicalManifest.sha256 === '4992e085576402191976f22441541170c27c3cf4ed8079eccc72c1ac2eaa2593', 'HISTORICAL_MANIFEST_PIN');
  return value;
}
function sourceSnapshot(prep) {
  const stock = readJson(prep.sourceStock.path), base = new Map(stock.entries.map(x => [x.path, x]));
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
  verify(prep.sourceStock); verify(prep.historicalManifest); verify(prep.importConfig);
  Object.values(prep.tools).forEach(verify);
  prep.imports.forEach(x=>verify(x.destination));
  prep.dlls.forEach(x=>verify(x.destination));
  const boundary = readJson(path.join(path.dirname(path.dirname(prep.historicalManifest.path)), 'receipts', 'import-boundary.json'));
  for (const entry of boundary.boundary) {
    const lib = prep.imports.find(x=>path.basename(x.destination.path) === path.basename(entry.library));
    requireTrue(lib && lib.destination.sha256 === entry.librarySha256, 'IMPORT_LIBRARY_PIN:' + entry.name);
  }
  requireTrue(ref(LAUNCHER).sha256 === LAUNCHER_SHA, 'NATIVE_LAUNCHER_CHANGED');
  const source = sourceSnapshot(prep);
  return {at:now(),controller:ref(SELF),nativeLauncher:ref(LAUNCHER),node:ref(process.execPath),
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
  const parser = before.owned[0];
  requireTrue(phase.startsWith('red-') ? parser.sha256 === STOCK_PARSER_SHA : parser.sha256 !== STOCK_PARSER_SHA, 'PARSER_PHASE_BINDING');
  requireTrue(before.source.changed.some(x=>x.path === OWNED[1]), 'REGRESSION_NOT_PRESENT');
  if (phase.startsWith('green-')) {
    const phases = path.join(root,'phases');
    const red = fs.readdirSync(phases).filter(x=>/^red-[0-9]{2}$/.test(x)).map(x=>path.join(phases,x,'result.json')).filter(fs.existsSync).map(readJson);
    requireTrue(red.some(x=>x.passed && x.expectedFailure && x.before.owned[1].sha256 === before.owned[1].sha256), 'NO_MATCHING_RED_GATE');
  }
  fs.mkdirSync(output,{recursive:true});
  const intent = {schema:'blackice.minicpm.qx1.intent.v1',id:crypto.randomUUID(),at:now(),root,phase,output,before,modelStarted:false};
  save(path.join(output,'intent.json'),intent,true);
  save(path.join(output,'status.json'),{state:'launching',intentId:intent.id,at:now()},true);
  const args = [SELF,'worker',root,phase,intent.id];
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -Path ' + psQuote(LAUNCHER),
    '$qx1Receipt=[BlackiceApplicationLauncher]::Executable(' + psQuote(process.execPath) + ',[string[]]@(' + args.map(psQuote).join(',') + '),' + psQuote(root) + ')',
    '$qx1Receipt | ConvertTo-Json -Compress',
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
    requireTrue(before.controller.sha256 === intent.before.controller.sha256 && before.source.contentSha256 === intent.before.source.contentSha256,'SOURCE_CHANGED_BEFORE_WORKER');
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
    const test=await run('test-chat',path.join(bin,'test-chat.exe'),['--template','qwen3-coder'],prep.source,180000);
    const testText=fs.readFileSync(test.stdout,'utf8')+'\n'+fs.readFileSync(test.stderr,'utf8');
    if (phase.startsWith('red-')) {
      requireTrue(test.exitCode !== 0 && !test.timedOut && !test.error && testText.includes('QX1 root-object-union regression BEGIN') && testText.includes('QX1 valid XML rejected:'),'EXPECTED_REGRESSION_FAILURE_NOT_OBSERVED');
      expectedFailure=true;
    } else {
      requireSuccess(test);
      requireTrue(testText.includes('QX1 root-object-union regression PASS') && testText.includes('QX1 limited-scope regression PASS') && testText.includes('[chat] All template tests passed!'),'GREEN_RECEIPT_INCOMPLETE');
      requireSuccess(await run('build-server',prep.tools.ninja.path,['-C',build,'-j','2','llama-server'],root,2700000));
      requireSuccess(await run('server-version',path.join(bin,'llama-server.exe'),['--version'],bin,30000));
    }
    after=binding(root);
    requireTrue(after.source.contentSha256 === before.source.contentSha256 && after.controller.sha256 === before.controller.sha256,'SOURCE_CHANGED_DURING_PHASE');
    success=true;
  } catch(failure) {error={message:failure.message,stack:failure.stack};console.error(failure.stack);}
  finally {
    clearInterval(timer);
    const result={schema:'blackice.minicpm.qx1.phase-result.v1',at:now(),root,phase,intentId,passed:success,expectedFailure,error,before,after,
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
  else throw Error('Usage: build-qwen3-repair.cjs launch|observe <absolute-root> <red-NN|green-NN>');
  process.stdout.write(JSON.stringify(result)+'\n',()=>process.exit(0));
})().catch(error=>{process.stderr.write((error.stack||String(error))+'\n',()=>process.exit(1));});
