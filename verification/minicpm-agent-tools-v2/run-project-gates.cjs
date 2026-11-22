'use strict';
// FG1 transport only. The repository runner owns full inventory, TAP and skip validation.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const {spawn, spawnSync, execFileSync} = require('node:child_process');
const {createHash, randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(__dirname, '..', '..');
const SELF = path.resolve(__filename);
const SUITE = path.join(ROOT, 'scripts/source-suite-receipt.mjs');
const SUITE_SHA256 = 'ec00978abe8e451b75d62a04ac1a1f2149937f91c58b1414e35213f0fc4484c7';
const NATIVE_LAUNCHER = path.join(ROOT, 'desktop/native-app-launcher.cs');
const NATIVE_LAUNCHER_SHA256 = 'ff60a3dd015fea79332519d0c3388d3b8f0755197e1bc501c380f8140f653c24';
const sha = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const exists = async file => {try {await fs.lstat(file); return true;} catch (error) {if(error.code === 'ENOENT')return false;throw error;}};
async function readJson(file) {
  const info = await fs.lstat(file);
  if(!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)throw Error('Invalid JSON evidence file: ' + file);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function maybeJson(file) {try{return await readJson(file);}catch(error){if(error.code === 'ENOENT')return null;throw error;}}
async function writeJson(file, value, exclusive = false) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if(exclusive)return fs.writeFile(file, text, {encoding:'utf8', flag:'wx'});
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, text, {encoding:'utf8', flag:'wx'});
  await fs.rename(temporary, file);
}
async function ref(file) {
  const info = await fs.lstat(file);
  if(!info.isFile() || info.isSymbolicLink())throw Error('Evidence must be an ordinary file: ' + file);
  const bytes = await fs.readFile(file);
  return {path:file, bytes:bytes.length, sha256:sha(bytes)};
}
async function documentationIndex() {
  const tracked = execFileSync('git', ['ls-files', '-z'], {cwd:ROOT, encoding:'utf8'}).split('\0').filter(Boolean);
  const names = new Set(tracked.filter(file => file.endsWith('.md')));
  for(const directory of ['', 'docs', 'docs/history']) {
    const absolute = path.join(ROOT, directory);
    if(!await exists(absolute))continue;
    for(const entry of await fs.readdir(absolute, {withFileTypes:true}))
      if(entry.isFile() && entry.name.endsWith('.md'))names.add(path.posix.join(directory, entry.name));
  }
  names.add('docs/document-status.json');
  const records = [];
  for(const file of [...names].sort())records.push({relative:file, ...await ref(path.join(ROOT, file))});
  return {sha256:sha(JSON.stringify(records)), records};
}
async function binding() {
  const [{releaseSourceIndex}, {appFingerprint}, {sourceSuiteIdentity}] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'scripts/release-request.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'scripts/release-check.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'scripts/source-suite-provenance.mjs')).href),
  ]);
  const source = await releaseSourceIndex(ROOT), documentation = await documentationIndex();
  const metadata = await readJson(path.join(ROOT, 'package.json'));
  return {...sourceSuiteIdentity(ROOT), version:metadata.version, node:process.version, nodeExecutable:process.execPath,
    sourceIndexSha256:source.sourceIndexSha256, sourceFiles:source.records,
    appFingerprint:await appFingerprint(ROOT), documentationSha256:documentation.sha256, documentationFiles:documentation.records,
    suiteRunner:await ref(SUITE), nativeLauncher:await ref(NATIVE_LAUNCHER), controller:await ref(SELF)};
}
const sameBinding = (a,b) => ['sourceCommit','version','node','nodeExecutable','sourceIndexSha256','appFingerprint','documentationSha256']
  .every(key => a?.[key] === b?.[key]) && a?.suiteRunner?.sha256 === b?.suiteRunner?.sha256 &&
  a?.nativeLauncher?.sha256 === b?.nativeLauncher?.sha256 && a?.controller?.sha256 === b?.controller?.sha256;
function summaryBinding(value) {
  if(!value)return null;
  const {sourceFiles,documentationFiles,...summary} = value;
  return {...summary, sourceFilesVerified:sourceFiles?.length, documentationFilesVerified:documentationFiles?.length};
}
function pidPresent(pid) {
  if(!Number.isSafeInteger(pid) || pid < 1)return null;
  try {process.kill(pid, 0);return true;} catch(error) {return error.code === 'ESRCH' ? false : null;}
}
async function lastHeartbeat(output) {
  const file = path.join(output, 'source-suite', 'heartbeat.ndjson');
  try {
    const handle = await fs.open(file, 'r');
    try {
      const info = await handle.stat(), length = Math.min(info.size, 16384), bytes = Buffer.alloc(length);
      await handle.read(bytes, 0, length, info.size - length);
      const lines = bytes.toString('utf8').trim().split(/\r?\n/);
      for(const line of lines.reverse())try{return JSON.parse(line);}catch{}
      return null;
    } finally {await handle.close();}
  } catch(error) {if(error.code === 'ENOENT')return null;throw error;}
}
async function observe(output) {
  const [intent,launch,status,result,heartbeat] = await Promise.all([
    maybeJson(path.join(output,'intent.json')), maybeJson(path.join(output,'launch.json')),
    maybeJson(path.join(output,'status.json')), maybeJson(path.join(output,'result.json')), lastHeartbeat(output),
  ]);
  const workerPid = status?.workerPid || launch?.workerPid, workerPidPresent = pidPresent(workerPid);
  return {output,intentId:intent?.id || null,root:intent?.root || ROOT,launch,status,heartbeat,workerPidPresent,
    settled:Boolean(result) && workerPidPresent === false,
    result:result && {passed:result.passed,finishedAt:result.finishedAt,error:result.error,
      sourceUnchanged:result.sourceUnchanged,tests:result.tests,optionalSkips:result.optionalSkips,
      sourceSuiteReceipt:result.sourceSuiteReceipt,steps:result.steps,binding:summaryBinding(result.bindingAfter),
      scope:result.scope,installed:false,published:false}};
}
function outputPath(value) {
  if(typeof value !== 'string' || !path.isAbsolute(value))throw Error('An absolute private evidence output directory is required.');
  const output = path.resolve(value), relative = path.relative(ROOT, output);
  if(!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
    throw Error('Keep evidence outside the candidate source tree.');
  return output;
}
async function launch(output) {
  if(process.platform !== 'win32')throw Error('FG1 requires the native Windows checkout.');
  if(await exists(output)) {
    const observed = await observe(output);
    if(!observed.intentId)throw Error('Output exists without a launch intent; inspect it instead of retrying.');
    return {...observed,recovered:true,launched:false};
  }
  const parent = path.dirname(output), canonical = await fs.realpath(parent);
  if(path.relative(parent,canonical))throw Error('Evidence parent must already exist at its canonical path.');
  const before = await binding();
  if(before.suiteRunner.sha256 !== SUITE_SHA256)throw Error('The reviewed repository source-suite runner changed.');
  if(before.nativeLauncher.sha256 !== NATIVE_LAUNCHER_SHA256)throw Error('The reviewed native launch boundary changed.');
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const npm = await readJson(path.join(path.dirname(process.execPath), 'node_modules/npm/package.json'));
  if(!await exists(npmCli))throw Error('The native Node installation has no npm CLI.');
  await fs.mkdir(output);
  const intent = {format:1,id:randomUUID(),createdAt:now(),root:ROOT,output,nodeExecutable:process.execPath,
    controller:before.controller,suiteRunner:before.suiteRunner,nativeLauncher:before.nativeLauncher,version:before.version,npmVersion:npm.version,npmCli,
    bindingBefore:path.join(output,'binding-before.json'),sourceSuiteOutput:path.join(output,'source-suite'),
    sourceSuiteReceipt:path.join(output,'source-suite','windows-'+before.version+'.json'),
    policy:'Existing full-inventory serial repository runner; no source or skip validation replacement; root freeze required.'};
  await writeJson(intent.bindingBefore,before,true);
  await writeJson(path.join(output,'intent.json'),intent,true);
  await writeJson(path.join(output,'status.json'),{state:'launching',intentId:intent.id,at:now()},true);
  const args=[SELF,'worker',output,intent.id];
  const psQuote=value=>"'"+String(value).replaceAll("'","''")+"'";
  const script=[
    "$ErrorActionPreference='Stop'",
    'Add-Type -Path '+psQuote(NATIVE_LAUNCHER),
    '$fg1NativeReceipt=[BlackiceApplicationLauncher]::Executable('+psQuote(process.execPath)+',[string[]]@('+args.map(psQuote).join(',')+'),'+psQuote(ROOT)+')',
    '$fg1NativeReceipt | ConvertTo-Json -Compress',
    'exit 0',
  ].join('\r\n');
  const powershell=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const nativeArgs=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
  const startedAt=now();
  // Existing CreateProcessW boundary passes inheritHandles:false. A detached Node
  // child is insufficient because non-stdio inherited handles can keep the direct job open.
  const actual=spawnSync(powershell,nativeArgs,{cwd:ROOT,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
  await fs.writeFile(path.join(output,'native-launch.stdout.log'),actual.stdout || '',{encoding:'utf8',flag:'wx'});
  await fs.writeFile(path.join(output,'native-launch.stderr.log'),actual.stderr || '',{encoding:'utf8',flag:'wx'});
  const nativeRun={startedAt,finishedAt:now(),executable:powershell,exitCode:actual.status,signal:actual.signal,
    error:actual.error?.message || null,nativeLauncher:before.nativeLauncher,inheritHandles:false};
  await writeJson(path.join(output,'native-launch.json'),nativeRun,true);
  try {
    if(actual.status !== 0 || actual.signal || actual.error)throw Error('Native launch did not return a complete successful receipt.');
    const receipt=JSON.parse(actual.stdout);
    if(receipt.launched !== true || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1 ||
        typeof receipt.activationProcessStartedAt !== 'string' || !Number.isFinite(Date.parse(receipt.activationProcessStartedAt)))
      throw Error('Native worker launch receipt has no complete process identity.');
    const launched={intentId:intent.id,at:now(),workerPid:receipt.pid,workerStartedAt:receipt.activationProcessStartedAt,
      nodeExecutable:process.execPath,args,nativeReceipt:receipt,nativeLauncher:before.nativeLauncher,inheritHandles:false};
    await writeJson(path.join(output,'launch.json'),launched,true);
    return {launched:true,recovered:false,output,...launched};
  } catch(error) {
    // CreateProcess may have succeeded even if serialization/receipt delivery failed.
    // Preserve the intent and worker-owned status; never retry this launch automatically.
    await writeJson(path.join(output,'launch-error.json'),{at:now(),intentId:intent.id,uncertain:true,error:String(error.message || error)},true);
    throw error;
  }
}
function ownWorkerLogs(output) {
  const out=fsSync.openSync(path.join(output,'worker.stdout.log'),'wx');
  let err;
  try {err=fsSync.openSync(path.join(output,'worker.stderr.log'),'wx');}
  catch(error){fsSync.closeSync(out);throw error;}
  for(const [stream,descriptor] of [[process.stdout,out],[process.stderr,err]]) {
    stream.write=(chunk,encoding,callback)=>{
      if(typeof encoding === 'function'){callback=encoding;encoding=undefined;}
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk),encoding || 'utf8');
      fsSync.writeSync(descriptor,bytes);
      if(typeof callback === 'function')process.nextTick(callback);
      return true;
    };
  }
  // These are worker-owned ordinary files, never inherited direct-job pipes.
  // Synchronous writes are complete before process exit; the OS closes the descriptors.
}

async function worker(output,token) {
  const intent=await readJson(path.join(output,'intent.json'));
  if(token !== intent.id || intent.output !== output || intent.root !== ROOT || intent.nodeExecutable !== process.execPath ||
      intent.controller.sha256 !== (await ref(SELF)).sha256)throw Error('Worker does not match its immutable launch intent.');
  ownWorkerLogs(output);
  await writeJson(path.join(output,'worker-start.json'),{intentId:intent.id,workerPid:process.pid,startedAt:now()},true);
  const before=await readJson(intent.bindingBefore), steps=[];
  const state={intentId:intent.id,workerPid:process.pid,state:'running',at:now(),step:'admission'};
  const update=async patch=>{Object.assign(state,patch,{at:now()});await writeJson(path.join(output,'status.json'),state);};
  const environment={...process.env},pathKey=Object.keys(environment).find(key=>key.toLowerCase()==='path') || 'PATH';
  environment[pathKey]=path.dirname(process.execPath)+path.delimiter+(environment[pathKey] || '');
  async function runStep(name,args) {
    const stdoutPath=path.join(output,name+'.stdout.log'),stderrPath=path.join(output,name+'.stderr.log');
    const out=await fs.open(stdoutPath,'wx'),err=await fs.open(stderrPath,'wx');
    const startedAt=now();
    let child,spawnError;
    try {
      child=spawn(process.execPath,args,{cwd:ROOT,env:environment,windowsHide:true,stdio:['ignore',out.fd,err.fd]});
      const completed=new Promise(resolve=>{
        child.once('error',error=>{spawnError=String(error.message || error);});
        child.once('close',(exitCode,signal)=>resolve({exitCode,signal,spawnError:spawnError || null}));
      });
      await update({step:name,child:{pid:child.pid || null,nodeExecutable:process.execPath,args,startedAt}});
      const actual=await completed;
      const result={name,startedAt,finishedAt:now(),pid:child.pid || null,nodeExecutable:process.execPath,args,
        ...actual,stdout:stdoutPath,stderr:stderrPath};
      steps.push(result);
      await update({step:name,child:null,lastStep:result});
      return result;
    } finally {await out.close();await err.close();}
  }
  let error=null,suiteReceipt=null,bindingAfter=null,passed=false;
  try {
    if(!sameBinding(before,await binding()))throw Error('Candidate or controller changed between launch and worker admission.');
    await fs.mkdir(intent.sourceSuiteOutput);
    const suite=await runStep('source-suite',[SUITE,intent.sourceSuiteOutput]);
    suiteReceipt=await maybeJson(intent.sourceSuiteReceipt);
    if(suite.exitCode !== 0 || suite.signal || suite.spawnError || suiteReceipt?.passed !== true)
      throw Error('Repository source suite failed or did not emit its passing receipt. Inspect its complete logs and actual receipt.');
    const docs=await runStep('docs',[intent.npmCli,'run','docs:check']);
    if(docs.exitCode !== 0 || docs.signal || docs.spawnError)throw Error('Documentation gate failed.');
    const fingerprint=await runStep('fingerprint',[path.join(ROOT,'scripts/release-check.mjs'),'--fingerprint']);
    if(fingerprint.exitCode !== 0 || fingerprint.signal || fingerprint.spawnError)throw Error('Fingerprint command failed.');
    const observed=JSON.parse(await fs.readFile(fingerprint.stdout,'utf8'));
    if(observed.version !== before.version || observed.appFingerprint !== before.appFingerprint)
      throw Error('Final fingerprint output differs from admitted candidate.');
    passed=true;
  } catch(cause) {error={message:String(cause.message || cause),code:cause.code || null};}
  try {bindingAfter=await binding();if(!sameBinding(before,bindingAfter)){passed=false;error ||= {message:'Source or documentation changed during project gates.',code:'FG1_SOURCE_DRIFT'};}}
  catch(cause){passed=false;error ||= {message:String(cause.message || cause),code:'FG1_FINAL_BINDING_FAILED'};}
  const result={format:1,scope:'Current candidate source suite, documentation and fingerprint only',intentId:intent.id,
    passed,finishedAt:now(),workerPid:process.pid,node:process.version,npmVersion:intent.npmVersion,error,
    sourceUnchanged:Boolean(bindingAfter)&&sameBinding(before,bindingAfter),bindingBefore:before,bindingAfter,steps,
    tests:suiteReceipt?.tests || null,optionalSkips:suiteReceipt?.optionalSkips || null,
    sourceSuiteReceipt:await exists(intent.sourceSuiteReceipt)?await ref(intent.sourceSuiteReceipt):null,
    installed:false,published:false};
  await writeJson(path.join(output,'result.json'),result,true);
  await update({state:passed?'passed':'failed',step:'complete',child:null,finishedAt:result.finishedAt,error});
  process.exitCode=passed?0:1;
}
async function main() {
  const [mode,value,token,...rest]=process.argv.slice(2);
  if(['help','--help','-h'].includes(mode) || !mode) {
    console.log('Usage: node run-project-gates.cjs launch|observe <absolute private evidence directory>');return;
  }
  if(!['launch','observe','worker'].includes(mode) || rest.length || (mode !== 'worker' && token !== undefined))
    throw Error('Use launch or observe with one absolute evidence output directory.');
  const output=outputPath(value);
  if(mode==='worker')await worker(output,token);
  else {
    const result=mode==='launch'?await launch(output):await observe(output);
    await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(result,null,2)+'\n',error=>error?reject(error):resolve()));
    if(mode==='launch')process.exit(0); // Receipt is saved and output flushed; no inherited launcher handles remain.
  }
}
main().catch(error=>{console.error(JSON.stringify({error:String(error.message || error),code:error.code || null,at:now()}));process.exitCode=1;});
