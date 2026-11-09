// Fresh 2.39.31 gate. No source tests run until prepare has an explicit matching candidate identity.
import { promises as fs, createReadStream, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appFingerprint } from '../scripts/release-check.mjs';
import { releaseSourceIndex } from '../scripts/release-request.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const targetVersion='2.39.31';
const output=path.join(root,'verification/release-source-suite-20261109-v23931');
const publicReceiptFile=path.join(root,'verification/windows-2.39.31.json');
const stateFile=path.join(output,'state.json');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fileHash=async file=>{const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');};
const write=async(file,data)=>{const temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(data,null,2)+'\n');await fs.rename(temporary,file);};
const optionalNames=new Set([
  'Relay-owned sign-in and local storage survive a full process restart without foregrounding',
  'restored hidden browser tabs defer requests until used and never load closed or replaced pages',
  'native popups preserve OAuth routing and remain independent when their opener closes',
  'live contained input updates application state and delivers editing keys without OS focus',
  'offscreen contained input updates application state and delivers editing keys without OS focus',
  'actual hidden Chromium fill commits trusted form state across replacement empty Unicode and iframe cases',
  'live background accessibility actions change only a dedicated non-activating fixture and leave foreground and cursor untouched',
  'hidden isolated Chromium composer validates real layout and one-click send wiring',
  'installed Himalaya sends exact MIME to disposable loopback SMTP and strips Bcc headers',
  'real headless Firefox operates disposable pages and keeps its own sign-in across a clean restart',
  'same-directory native replacement is also exercised on an explicitly supplied existing SMB share',
]);
const inventory=async()=>(await releaseSourceIndex(root)).records;
const testFiles=async()=>(await fs.readdir(path.join(root,'tests'))).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'tests/'+n);
const fingerprint=()=>appFingerprint(root);
const mode=process.argv[2];
const currentHead=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
function candidateInput(){
  const values={},args=process.argv.slice(3);
  for(let i=0;i<args.length;i+=2){
    if(!['--fingerprint','--source-commit'].includes(args[i])||!args[i+1]||Object.hasOwn(values,args[i]))throw Error('Use prepare --fingerprint <64 hex> --source-commit <40 hex>.');
    values[args[i]]=args[i+1];
  }
  return {version:targetVersion,appFingerprint:values['--fingerprint'],sourceCommit:values['--source-commit']};
}
async function checkIdentity(value){
  if(value.version!==targetVersion||!/^[a-f0-9]{64}$/.test(value.appFingerprint||'')||!/^[a-f0-9]{40}$/.test(value.sourceCommit||''))throw Error('A bound 2.39.31 fingerprint and source commit are required; placeholders cannot execute this gate.');
  if(process.platform!=='win32'||process.version!=='v24.22.2')throw Error('Use the pinned Windows Node v24.22.2 executable.');
  if(JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version!==targetVersion)throw Error('Source version is not the intended 2.39.31 candidate.');
  if(currentHead()!==value.sourceCommit)throw Error('Source HEAD differs from the frozen candidate commit.');
}
async function readState(){
  const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
  await checkIdentity(state);
  if(state.runnerSha256!==await fileHash(fileURLToPath(import.meta.url)))throw Error('The suite runner changed after prepare.');
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
  // The native planning-workflow acceptance file runs real multi-outcome
  // fixture scenarios. Keep it in its own bounded group rather than making
  // unrelated test files share its ~100-second execution budget.
  const slow='tests/planning-workflow-acceptance.test.mjs';
  if(!files.includes(slow))throw Error('The known long-running acceptance test is absent from the test inventory.');
  let current=[];
  for(const file of files){
    if(file===slow){if(current.length){groups.push(current);current=[];}groups.push([file]);continue;}
    current.push(file);if(current.length===size){groups.push(current);current=[];}
  }
  if(current.length)groups.push(current);
  const state={format:1,product:'BLACKICE',scope:'source-publication',version:targetVersion,sourceCommit:binding.sourceCommit,
    platform:process.platform,node:process.version,startedAt:new Date().toISOString(),state:'prepared',testFiles:files.length,
    appFingerprint:actualFingerprint,sourceIndexSha256:sha(JSON.stringify(sources)),sourceFilesVerified:sources.length,
    testInventorySha256:sha(JSON.stringify(files)),runnerSha256:await fileHash(fileURLToPath(import.meta.url)),
    execution:{kind:'sequential-bounded-groups',concurrency:4,groupCount:groups.length,groupSize:size,optionalNativeFixtures:false},
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
  const env={...process.env},pathKey=Object.keys(env).find(k=>k.toLowerCase()==='path'),previousPath=env[pathKey]||'';
  for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
  env.PATH=[path.dirname(process.execPath),path.join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python'),path.join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd'),path.join(root,'node_modules/.bin'),previousPath].join(';');
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
  const passed=coverage&&sourceUnchanged&&fingerprintUnchanged&&state.batches.every(b=>b.passed);
  const receipt={...state,checkedAt:new Date().toISOString(),state:passed?'passed':'failed',passed,fullSuite:coverage&&countsComplete,countsComplete,
    fingerprintUnchanged,sourceUnchanged,tests,testLogSha256:sha(log),stderrSha256:sha(stderr),
    execution:{...state.execution,uniqueCoverageVerified:coverage}};
  delete receipt.groups;delete receipt.active;
  await write(path.join(output,'summary.json'),receipt);await write(stateFile,{...state,state:receipt.state,tests});
  if(passed){
    const fields=['format','product','scope','version','platform','node','startedAt','checkedAt','state','passed','fullSuite','countsComplete',
      'appFingerprint','sourceIndexSha256','sourceFilesVerified','testFiles','testInventorySha256','runnerSha256',
      'fingerprintUnchanged','sourceUnchanged','tests','testLogSha256','stderrSha256','execution'];
    const publicReceipt=Object.fromEntries(fields.map(key=>[key,receipt[key]]));
    publicReceipt.optionalSkips=state.batches.flatMap(batch=>batch.skips.filter(skip=>skip.optional).map(skip=>skip.name));
    publicReceipt.validationScope='Complete synthetic Windows source suite. Live free-provider acceptance and installed candidate evidence are separate.';
    await refuseExisting(publicReceiptFile,'Public release receipt');
    await write(publicReceiptFile,publicReceipt);
  }
  console.log(JSON.stringify({state:receipt.state,passed,version:receipt.version,testFiles:receipt.testFiles,appFingerprint:receipt.appFingerprint,
    sourceIndexSha256:receipt.sourceIndexSha256,tests,testLogSha256:receipt.testLogSha256,fingerprintUnchanged,sourceUnchanged,coverage,countsComplete}));
  if(!passed)process.exitCode=1;
}else throw Error('Use prepare --fingerprint <64 hex> --source-commit <40 hex>, batch INDEX, or finish.');
