// Fresh 2.39.18 gate. No source tests run until prepare has an explicit matching candidate identity.
import { promises as fs, createReadStream, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appFingerprint } from '../scripts/release-check.mjs';
import { releaseSourceIndex } from '../scripts/release-request.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const targetVersion='2.39.18';
const output=path.join(root,'verification/release-source-suite-20261104-v23918-r2');
const temporaryDirectory=path.join(root,'.build','wst-v23918-r2');
const temporaryPreflightFile=path.join(output,'temporary-directory-preflight.json');
const publicReceiptFile=path.join(root,'verification/windows-2.39.18.json');
const stateFile=path.join(output,'state.json');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fileHash=async file=>{const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');};
const write=async(file,data)=>{const temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(data,null,2)+'\n');await fs.rename(temporary,file);};
const optionalNames=new Set([
'Relay-owned sign-in and local storage survive a full process restart without foregrounding',
'restored hidden browser tabs defer requests until used and never load closed or replaced pages',
'native cross-origin popups redirect, message their opener and follow or close without breaking Observe pins or task routing',
'actual hidden Chromium fill commits trusted form state across replacement empty Unicode and iframe cases',
'live background accessibility actions change only a dedicated non-activating fixture and leave foreground and cursor untouched',
'hidden isolated Chromium composer validates real layout and one-click send wiring',
'installed Himalaya sends exact MIME to disposable loopback SMTP and strips Bcc headers',
'real headless Firefox operates disposable pages and keeps its own sign-in across a clean restart',
'same-directory native replacement is also exercised on an explicitly supplied existing SMB share'
]);
const inventory=async()=>(await releaseSourceIndex(root)).records;
const testFiles=async()=>(await fs.readdir(path.join(root,'tests'))).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'tests/'+n);
const fingerprint=()=>appFingerprint(root);
const mode=process.argv[2];
const currentHead=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const samePath=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
async function directoryIdentity(directory){
  const stat=await fs.lstat(directory,{bigint:true});
  return {lexicalPath:path.resolve(directory),physicalPath:await fs.realpath(directory),
    directory:stat.isDirectory(),symbolicLink:stat.isSymbolicLink(),device:String(stat.dev),inode:String(stat.ino)};
}
async function directoryChain(directory){
  const chain=[];
  for(let current=path.resolve(directory);;current=path.dirname(current)){
    chain.push(await directoryIdentity(current));
    if(path.dirname(current)===current)return chain;
  }
}
function requirePhysicalChain(chain){
  if(chain.some(item=>!item.directory||item.symbolicLink||!samePath(item.lexicalPath,item.physicalPath)))throw Error('The suite temporary directory and its ancestors must be ordinary physical directories without redirects.');
}
function temporaryEnvironment(identity,environment=process.env){
  const env={...environment};
  for(const key of Object.keys(env))if(['temp','tmp'].includes(key.toLowerCase()))delete env[key];
  env.TEMP=identity.physicalPath;env.TMP=identity.physicalPath;
  return env;
}
async function prepareTemporaryDirectory(){
  // Capture the host condition rather than guessing which alias it supplied.
  let inherited;
  try{inherited={ancestors:await directoryChain(os.tmpdir())};}
  catch(error){inherited={error:{code:error.code||null,message:error.message}};}
  requirePhysicalChain(await directoryChain(root));
  const build=path.dirname(temporaryDirectory);
  try{await fs.mkdir(build);}catch(error){if(error.code!=='EEXIST')throw error;}
  requirePhysicalChain(await directoryChain(build));
  await refuseExisting(temporaryDirectory,'Suite temporary directory');
  await fs.mkdir(temporaryDirectory,{mode:0o700});
  const ancestors=await directoryChain(temporaryDirectory);requirePhysicalChain(ancestors);
  const identity=ancestors[0];
  const probe=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',
    "import os from 'node:os';import path from 'node:path';import{promises as fs}from'node:fs';const temporaryDirectory=os.tmpdir(),physicalPath=await fs.realpath(temporaryDirectory),fixture=await fs.mkdtemp(path.join(temporaryDirectory,'preflight-'));try{console.log(JSON.stringify({temporaryDirectory,physicalPath,fixture,physicalFixture:await fs.realpath(fixture)}));}finally{await fs.rmdir(fixture);}"],
    {cwd:root,env:temporaryEnvironment(identity),encoding:'utf8',windowsHide:true}));
  if(!samePath(probe.temporaryDirectory,identity.physicalPath)||!samePath(probe.physicalPath,identity.physicalPath)||!samePath(probe.fixture,probe.physicalFixture))throw Error('A fresh child process did not receive the physical suite temporary directory.');
  const preflight={format:1,recordedAt:new Date().toISOString(),
    inherited:{TEMP:process.env.TEMP||null,TMP:process.env.TMP||null,nodeTmpdir:os.tmpdir(),...inherited},
    suite:{...identity,ancestors},childEnvironment:{TEMP:identity.physicalPath,TMP:identity.physicalPath},probe,
    policy:'Only these test child processes use the fresh physical temporary directory. Production path guards and deliberate link/junction fixtures remain unchanged.'};
  await write(temporaryPreflightFile,preflight);
  console.log(JSON.stringify({temporaryDirectoryPreflight:{inherited:preflight.inherited,suite:identity,probe}}));
  return identity;
}
async function verifyTemporaryDirectory(state){
  const chain=await directoryChain(temporaryDirectory);requirePhysicalChain(chain);
  const actual=chain[0],expected=state.temporaryDirectory;
  if(!expected||!samePath(expected.lexicalPath,temporaryDirectory)||!samePath(expected.physicalPath,actual.physicalPath)||expected.device!==actual.device||expected.inode!==actual.inode)throw Error('The prepared suite temporary directory changed identity.');
  if(state.execution.temporaryDirectoryPreflightSha256!==await fileHash(temporaryPreflightFile))throw Error('Temporary-directory preflight evidence changed after preparation.');
}
function candidateInput(){
  const values={},args=process.argv.slice(3);
  for(let i=0;i<args.length;i+=2){
    if(!['--fingerprint','--source-commit'].includes(args[i])||!args[i+1]||Object.hasOwn(values,args[i]))throw Error('Use prepare --fingerprint <64 hex> --source-commit <40 hex>.');
    values[args[i]]=args[i+1];
  }
  return {version:targetVersion,appFingerprint:values['--fingerprint'],sourceCommit:values['--source-commit']};
}
async function checkIdentity(value){
  if(value.version!==targetVersion||!/^[a-f0-9]{64}$/.test(value.appFingerprint||'')||!/^[a-f0-9]{40}$/.test(value.sourceCommit||''))throw Error('A bound 2.39.18 fingerprint and source commit are required; placeholders cannot execute this gate.');
  if(process.platform!=='win32'||process.version!=='v24.22.2')throw Error('Use the pinned Windows Node v24.22.2 executable.');
  if(JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version!==targetVersion)throw Error('Source version is not the intended 2.39.18 candidate.');
  if(currentHead()!==value.sourceCommit)throw Error('Source HEAD differs from the frozen candidate commit.');
  if(execFileSync('git',['status','--porcelain=v1','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim())throw Error('Tracked source must match the frozen HEAD without staged or working-tree changes.');
}
async function readState(){
  const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
  await checkIdentity(state);
  if(state.runnerSha256!==await fileHash(fileURLToPath(import.meta.url)))throw Error('The suite runner changed after prepare.');
  await verifyTemporaryDirectory(state);
  return state;
}
async function refuseExisting(file,label){
  try{await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  throw Error(label+' already exists; inspect it instead of reusing or replacing it.');
}
if(mode==='prepare'){
  const binding=candidateInput();
  await checkIdentity(binding);
  const actualFingerprint=await fingerprint();
  if(actualFingerprint!==binding.appFingerprint)throw Error('Source fingerprint differs from the supplied candidate identity.');
  await refuseExisting(output,'Suite output');
  await refuseExisting(publicReceiptFile,'Public release receipt');
  await fs.mkdir(output);
  try{await fs.access(stateFile);throw Error('Suite state already exists; inspect it instead of replacing it.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const files=await testFiles(),sources=await inventory(),size=40,groups=[];
  const tracked=new Set(execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',maxBuffer:20*1024*1024}).split('\0').filter(Boolean));
  const runnerRelative=path.relative(root,fileURLToPath(import.meta.url)).split(path.sep).join('/');
  if(!files.length||sources.some(record=>!tracked.has(record.path))||!tracked.has(runnerRelative))throw Error('Every source input, test and this runner must be tracked in the frozen candidate commit.');
  const temporary=await prepareTemporaryDirectory();
  for(let i=0;i<files.length;i+=size)groups.push(files.slice(i,i+size));
  const state={format:1,product:'BLACKICE',scope:'source-publication',version:targetVersion,sourceCommit:binding.sourceCommit,
    platform:process.platform,node:process.version,startedAt:new Date().toISOString(),state:'prepared',testFiles:files.length,
    appFingerprint:actualFingerprint,sourceIndexSha256:sha(JSON.stringify(sources)),sourceFilesVerified:sources.length,
    testInventorySha256:sha(JSON.stringify(files)),runnerSha256:await fileHash(fileURLToPath(import.meta.url)),
    execution:{kind:'sequential-bounded-groups',concurrency:4,groupCount:groups.length,groupSize:size,optionalNativeFixtures:false,
      temporaryDirectoryPolicy:'fresh-suite-owned-physical-directory',temporaryDirectoryPreflightSha256:await fileHash(temporaryPreflightFile)},
    temporaryDirectory:temporary,
    groups,batches:[]};
  await write(path.join(output,'source-inventory.json'),sources);
  await write(stateFile,state);
  console.log(JSON.stringify({state:state.state,version:state.version,sourceCommit:state.sourceCommit,testFiles:files.length,groups:groups.length,appFingerprint:state.appFingerprint,sourceIndexSha256:state.sourceIndexSha256}));
}else if(mode==='batch'){
  const state=await readState(),index=Number(process.argv[3]);
  if(state.active)throw Error('A batch is already active; inspect its durable state.');
  if(['failed','passed'].includes(state.state))throw Error('This suite is already settled; do not append or replay batches.');
  if(!Number.isSafeInteger(index)||index<0||index>=state.groups.length)throw Error('Invalid group index.');
  if(state.batches.some(b=>b.index===index))throw Error('Group already has a durable result; inspect it rather than rerun.');
  if(index!==state.batches.length)throw Error('Run groups in order.');
  if(await fingerprint()!==state.appFingerprint||sha(JSON.stringify(await inventory()))!==state.sourceIndexSha256)throw Error('Frozen source changed before this group.');
  const files=state.groups[index],label=String(index+1).padStart(2,'0');
  const tapPath=path.join(output,'group-'+label+'.tap'),stderrPath=path.join(output,'group-'+label+'.stderr.log');
  const out=openSync(tapPath,'wx'),err=openSync(stderrPath,'wx');
  const args=['--test','--test-concurrency=4','--test-reporter=tap',...files];
  const env=temporaryEnvironment(state.temporaryDirectory),pathKey=Object.keys(env).find(k=>k.toLowerCase()==='path'),previousPath=env[pathKey]||'';
  for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
  // CI supplies Python and Git through its fresh runner PATH; never borrow a local user runtime.
  env.PATH=[path.dirname(process.execPath),path.join(root,'node_modules/.bin'),previousPath].join(path.delimiter);
  for(const k of['RELAY_LIVE_BROWSER_QA','RELAY_TRUSTED_FILL_QA','RELAY_LIVE_UIA_QA','BLACKICE_EMAIL_COMPOSE_QA','RELAY_LIVE_FIREFOX_QA','BLACKICE_EMAIL_NATIVE_CLI'])delete env[k];
  const startedAt=new Date().toISOString();
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore',out,err],windowsHide:true});
  closeSync(out);closeSync(err);
  state.state='running';state.active={index,pid:child.pid,startedAt,files};await write(stateFile,state);
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{}},112000);
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({exitCode:code,signal}));});
  clearTimeout(timer);
  const tap=await fs.readFile(tapPath,'utf8'),stderr=await fs.readFile(stderrPath,'utf8'),lines=tap.split(/\r?\n/);
  const counts={};for(const field of['tests','suites','pass','fail','cancelled','skipped','todo']){const re=new RegExp('^# '+field+' (\\d+)$','gm'),matches=[...tap.matchAll(re)];counts[field]=matches.length?Number(matches.at(-1)[1]):null;}
  const skips=[],failures=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i],skip=line.match(/^\s*(?:not )?ok \d+ - (.*?) # SKIP(?: (.*))?$/);
    if(skip)skips.push({name:skip[1],reason:skip[2]||null,optional:optionalNames.has(skip[1])});
    if(/^\s*not ok \d+ - /.test(line))failures.push({line:i+1,summary:line.trim(),context:lines.slice(i,Math.min(i+30,lines.length)).join('\n')});
  }
  const optionalSkipped=skips.filter(s=>s.optional).length,requiredSkipped=skips.length-optionalSkipped+(counts.todo||0);
  const tapComplete=Object.values(counts).every(n=>Number.isSafeInteger(n))&&counts.skipped===skips.length&&counts.tests===counts.pass+counts.fail+counts.cancelled+counts.skipped+counts.todo;
  const sourceUnchanged=sha(JSON.stringify(await inventory()))===state.sourceIndexSha256;
  const fingerprintUnchanged=await fingerprint()===state.appFingerprint;
  const batch={index,startedAt,finishedAt:new Date().toISOString(),files,args,...result,timedOut,counts,tapComplete,requiredSkipped,optionalSkipped,skips,failures,
    tapSha256:sha(tap),stderrSha256:sha(stderr),sourceUnchanged,fingerprintUnchanged};
  batch.passed=result.exitCode===0&&!timedOut&&tapComplete&&counts.fail===0&&counts.cancelled===0&&requiredSkipped===0&&sourceUnchanged&&fingerprintUnchanged;
  state.batches.push(batch);state.active=null;state.state=batch.passed?'running':'failed';await write(stateFile,state);
  await write(path.join(output,'group-'+label+'.json'),batch);
  console.log(JSON.stringify({index,...result,timedOut,counts,tapComplete,requiredSkipped,optionalSkipped,passed:batch.passed,failures:failures.map(f=>f.summary),sourceUnchanged,fingerprintUnchanged}));
  if(!batch.passed)process.exitCode=1;
}else if(mode==='finish'){
  const state=await readState();
  if(state.state==='passed')throw Error('This suite already has its final receipt; inspect it instead of rewriting.');
  if(state.batches.length!==state.groups.length||state.active)throw Error('All groups must settle before a full-suite result can be saved.');
  const all=state.batches.flatMap(b=>b.files),currentFiles=await testFiles();
  const coverage=all.length===state.testFiles&&new Set(all).size===all.length&&sha(JSON.stringify(all))===state.testInventorySha256&&sha(JSON.stringify(currentFiles))===state.testInventorySha256;
  const sourceUnchanged=sha(JSON.stringify(await inventory()))===state.sourceIndexSha256,fingerprintUnchanged=await fingerprint()===state.appFingerprint;
  const countsComplete=state.batches.every(b=>b.tapComplete&&!b.timedOut);
  const sum=key=>state.batches.reduce((v,b)=>v+(Number.isSafeInteger(b.counts[key])?b.counts[key]:0),0);
  const tests={total:sum('tests'),passed:sum('pass'),failed:sum('fail'),requiredSkipped:state.batches.reduce((n,b)=>n+b.requiredSkipped,0),
    optionalSkipped:state.batches.reduce((n,b)=>n+b.optionalSkipped,0),cancelled:sum('cancelled'),todo:sum('todo'),exitCode:state.batches.every(b=>b.exitCode===0)?0:1};
  let log='',stderr='';
  for(const b of state.batches){const label=String(b.index+1).padStart(2,'0');log+=await fs.readFile(path.join(output,'group-'+label+'.tap'),'utf8');stderr+=await fs.readFile(path.join(output,'group-'+label+'.stderr.log'),'utf8');}
  await fs.writeFile(path.join(output,'complete.tap'),log);await fs.writeFile(path.join(output,'complete.stderr.log'),stderr);
  const optionalSkips=state.batches.flatMap(batch=>batch.skips.filter(skip=>skip.optional).map(skip=>skip.name));
  const optionalSkipPolicyValid=optionalSkips.length===tests.optionalSkipped&&new Set(optionalSkips).size===optionalSkips.length&&optionalSkips.every(name=>optionalNames.has(name));
  const passed=coverage&&sourceUnchanged&&fingerprintUnchanged&&optionalSkipPolicyValid&&state.batches.every(b=>b.passed);
  const receipt={...state,checkedAt:new Date().toISOString(),state:passed?'passed':'failed',passed,fullSuite:coverage&&countsComplete,countsComplete,
    fingerprintUnchanged,sourceUnchanged,optionalSkipPolicyValid,tests,testLogSha256:sha(log),stderrSha256:sha(stderr),
    execution:{...state.execution,uniqueCoverageVerified:coverage}};
  delete receipt.groups;delete receipt.active;
  await write(path.join(output,'summary.json'),receipt);await write(stateFile,{...state,state:receipt.state,tests});
  if(passed){
    const fields=['format','product','scope','version','sourceCommit','platform','node','startedAt','checkedAt','state','passed','fullSuite','countsComplete',
      'appFingerprint','sourceIndexSha256','sourceFilesVerified','testFiles','testInventorySha256','runnerSha256',
      'fingerprintUnchanged','sourceUnchanged','optionalSkipPolicyValid','tests','testLogSha256','stderrSha256','execution'];
    const publicReceipt=Object.fromEntries(fields.map(key=>[key,receipt[key]]));
    publicReceipt.optionalSkips=optionalSkips;
    publicReceipt.validationScope='Complete synthetic Windows source suite. Live free-provider acceptance and installed candidate evidence are separate.';
    await refuseExisting(publicReceiptFile,'Public release receipt');
    await write(publicReceiptFile,publicReceipt);
  }
  console.log(JSON.stringify({state:receipt.state,passed,version:receipt.version,testFiles:receipt.testFiles,appFingerprint:receipt.appFingerprint,
    sourceIndexSha256:receipt.sourceIndexSha256,tests,testLogSha256:receipt.testLogSha256,fingerprintUnchanged,sourceUnchanged,coverage,countsComplete}));
  if(!passed)process.exitCode=1;
}else throw Error('Use prepare --fingerprint <64 hex> --source-commit <40 hex>, batch INDEX, or finish.');
