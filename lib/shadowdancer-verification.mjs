/** Host-owned requirement and executable-verification ledger for Shadowdancer.
 *
 * Test receipts are authoritative observations. Model-generated findings never
 * become "verified" merely because they were saved or cited by a model.
 */
import path from 'node:path';
import {assertSafeShadowdancerPath} from './shadowdancer-context.mjs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readdir,readFile,stat,mkdir,writeFile,rename} from 'node:fs/promises';
import {applyCoverageEvidence} from './shadowdancer-coverage.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
const now=()=>new Date().toISOString();
const scalar=x=>typeof x==='string'&&x.trim();
const stopWords=new Set('the a an to by with that this from into for and or of in on is are be if when then must should using use one every each all any after before without which may not do only does can at it as about have has while than either no under real actual implemented implement source file files src test tests behavior mode module code task original'.split(' '));
const tokens=s=>new Set(String(s||'').toLowerCase().match(/[a-z][a-z0-9]{2,}/g)?.filter(x=>!stopWords.has(x))||[]);
const intersect=(a,b)=>[...a].filter(x=>b.has(x)).length;
const fail=(code,message)=>Object.assign(new Error(message),{code});
export async function atomicJSON(file,value) {
  await assertSafeShadowdancerPath(file);
  await mkdir(path.dirname(file),{recursive:true});
  await assertSafeShadowdancerPath(path.dirname(file));
  const temp=file+'.tmp-'+process.pid+'-'+Date.now();
  try{await writeFile(temp,JSON.stringify(value,null,2)+'\n','utf8');await rename(temp,file);}
  finally{ /* Never delete a successful revision. */ }
}
export function extractRequirements(goal) {
  const text=String(goal||'');
  const stripped=text.split(/\r?\n/).filter(line=>!(/^\s*(?:REPOSITORY_ROOT:|VERIFIED NODE BINARY:|USE THIS VERIFIED NODE EXECUTABLE|PowerShell |Node and npm |Do not inspect |Do not modify |Only change source|Implement this repository-scale change)/i).test(line)).join('\n');
  const statements=stripped
    .replace(/\r\n/g,'\n')
    .split(/(?<=[.!?])\s+(?=[A-Z])|(?<=\.)\s+(?=[a-z_$][\w$]*\()|\n{2,}|(?<=;)\s+(?=[A-Za-z])/g)
    .map(s=>s.trim()).filter(s=>s.length>=12);
  // Environmental/procedural instructions are preserved separately, not
  // falsely treated as unverified code behavior.
  const procedural=/^(?:Run (?:the )?repository|Run (?:the )?tests|do not just report|Source files to inspect:|There is no Node|Use BLACKICE|Work within this repository only|Only change source|Do not inspect |VERIFIED NODE BINARY:)/i;
  const proceduralConstraints=statements.filter(s=>procedural.test(s));
  const behavioral=statements.filter(s=>!procedural.test(s));
  const selected=behavioral.length?behavioral:[text.trim()];
  const parts=selected.map((s,i)=>({
      id:'R'+String(i+1).padStart(3,'0'),
      statement:s,
      state:'unknown',evidence:[],coveredBy:[],owner:null,dependsOn:[],
      completionCriterion:'Requires observed evidence for this exact behavior',
    }));
  return {version:1,createdAt:now(),fullTask:text,originalSha256:sha(text),requirements:parts,
    proceduralConstraints,status:'unverified',verifiedCount:0,unknownCount:parts.length,
    policy:'A step summary and source change alone are never completion evidence.'};
}
export function classifyRequirements(ledger,{testReceipt=null,changedFiles=[]}={}) {
  // Legacy title similarity is useful for exploration, NEVER verification.
  const candidate=(ledger?.requirements||[]).map(entry=>{
    const tag=tokens(entry.statement);
    return {id:entry.id,passedTestSuggestions:(testReceipt?.passedCases||[])
      .filter(title=>intersect(tag,tokens(title))>=2),
      failedTestSuggestions:(testReceipt?.failedCases||[])
        .filter(title=>intersect(tag,tokens(title))>=2)};
  });
  const result=applyCoverageEvidence(ledger,testReceipt,{status:'absent',accepted:[],rejected:[]},{changedFiles});
  result.requirements=result.requirements.map(req=>({...req,
    suggestedTestMatches:candidate.find(x=>x.id===req.id)}));
  return result;
}
const GENERATED_NAMES=new Set(['.git','node_modules','.shadowdancer','.build','dist','coverage','.cache']);
const MAX_AUDIT_FILE_BYTES=64*1024*1024,MAX_AUDIT_BYTES=256*1024*1024;
const bounded=(value,name)=>{if(!Number.isSafeInteger(value)||value<1)throw fail('DIRECTORY_SNAPSHOT_LIMIT','Invalid '+name+' audit limit.');return value;};
async function auditFile(file,{maxBytes=MAX_AUDIT_FILE_BYTES}={}){
  await assertSafeShadowdancerPath(file);
  const before=await stat(file);
  if(!before.isFile())throw fail('DIRECTORY_SNAPSHOT_ENTRY','Repository audit requires regular files: '+file);
  if(before.size>maxBytes)throw fail('DIRECTORY_SNAPSHOT_LIMIT','A repository file exceeds the bounded audit byte limit: '+file);
  const bytes=await readFile(file);
  await assertSafeShadowdancerPath(file);
  const after=await stat(file);
  if(bytes.length>maxBytes)throw fail('DIRECTORY_SNAPSHOT_LIMIT','A repository file exceeds the bounded audit byte limit: '+file);
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||bytes.length!==after.size)
    throw fail('DIRECTORY_SNAPSHOT_CHANGED','A repository file changed while its evidence was being read: '+file);
  return bytes;
}
export async function discoverTests(root,maxFiles=1000,{maxDepth=32,maxEntries=10000}={}) {
  bounded(maxFiles,'test-file');bounded(maxDepth,'test-depth');bounded(maxEntries,'test-entry');
  await assertSafeShadowdancerPath(root);
  const base=path.join(root,'tests'),filenames=[];
  let entriesSeen=0;
  async function walk(dir,depth) {
    if(depth>maxDepth)throw fail('DIRECTORY_VERIFICATION_TEST_LIMIT','Test discovery exceeded the bounded directory depth; no partial suite may be reported.');
    await assertSafeShadowdancerPath(dir);
    let entries;
    try{entries=await readdir(dir,{withFileTypes:true});}
    catch(error){if(error.code==='ENOENT'&&dir===base)return;throw error;}
    for(const ent of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      if(++entriesSeen>maxEntries)throw fail('DIRECTORY_VERIFICATION_TEST_LIMIT','Test discovery exceeded the bounded inventory; no partial suite may be reported.');
      if(GENERATED_NAMES.has(ent.name))continue;
      const full=path.join(dir,ent.name);
      if(ent.isSymbolicLink())throw fail('DIRECTORY_VERIFICATION_TEST_PATH','Test discovery cannot follow symbolic links or junctions.');
      if(ent.isDirectory())await walk(full,depth+1);
      else if(ent.isFile()&&/\.(?:test|spec)\.(?:js|mjs|cjs)$/i.test(ent.name)){
        if(filenames.length>=maxFiles)throw fail('DIRECTORY_VERIFICATION_TEST_LIMIT','Test discovery exceeded '+maxFiles+' test files; no partial suite may be reported.');
        filenames.push(full);
      }else if(!ent.isFile())throw fail('DIRECTORY_VERIFICATION_TEST_PATH','Test discovery found a non-regular entry.');
    }
  }
  await walk(base,0);
  return filenames.sort();
}
export function nodeExecutableFromRequest(goal) {
  const line=String(goal||'').match(/^\s*(?:VERIFIED NODE BINARY:|USE THIS VERIFIED NODE EXECUTABLE FOR RUNNING TESTS:|NODE_EXECUTABLE:)\s*(.+?)\s*$/mi);
  return line?.[1]?.trim().replace(/^['"]|['"]$/g,'')||null;
}
export async function testSuiteSnapshot(root,{testPaths=null}={}){
  const tests=testPaths||await discoverTests(root);
  if(!Array.isArray(tests)||tests.length>1000||new Set(tests.map(file=>path.resolve(file))).size!==tests.length)
    throw fail('DIRECTORY_VERIFICATION_TEST_LIMIT','Test snapshot requires a bounded, duplicate-free file list.');
  const files=[];let byteCount=0;
  for(const file of [...tests].sort()){
    const relative=path.relative(root,file).replaceAll('\\','/');
    if(!relative.startsWith('tests/')||relative.includes('../')||! /\.(?:test|spec)\.(?:js|mjs|cjs)$/i.test(relative))
      throw fail('DIRECTORY_VERIFICATION_TEST_PATH','A test file is outside the selected repository tests folder or is not a supported test.');
    const bytes=await auditFile(file,{maxBytes:Math.min(MAX_AUDIT_FILE_BYTES,MAX_AUDIT_BYTES-byteCount)});
    byteCount+=bytes.length;
    files.push({path:relative,sha256:sha(bytes)});
  }
  let coverageMapSha256=null;
  try{coverageMapSha256=sha(await auditFile(path.join(root,'tests','requirement-coverage.json')));}
  catch(e){if(e.code!=='ENOENT')throw e;}
  return {testSourceFiles:files,testSuiteSha256:sha(JSON.stringify({files,coverageMapSha256})),
    coverageMapSha256};
}
export async function sourceSnapshot(root,{maxFiles=5000,maxDepth=32,maxEntries=20000,maxFileBytes=MAX_AUDIT_FILE_BYTES,maxBytes=MAX_AUDIT_BYTES}={}) {
  bounded(maxFiles,'source-file');bounded(maxDepth,'source-depth');bounded(maxEntries,'source-entry');
  bounded(maxFileBytes,'file-byte');bounded(maxBytes,'total-byte');
  await assertSafeShadowdancerPath(root);
  const files=[],excludedPaths=[];let entriesSeen=0,byteCount=0;
  async function walk(dir,relative='',depth=0){
    if(depth>maxDepth)throw fail('DIRECTORY_SNAPSHOT_LIMIT','Repository exceeded the bounded source directory depth.');
    await assertSafeShadowdancerPath(dir);
    const found=await readdir(dir,{withFileTypes:true});
    for(const entry of found.sort((a,b)=>a.name.localeCompare(b.name))){
      if(++entriesSeen>maxEntries)throw fail('DIRECTORY_SNAPSHOT_LIMIT','Repository exceeded the bounded source inventory.');
      const rel=relative?relative+'/'+entry.name:entry.name,full=path.join(dir,entry.name);
      if(GENERATED_NAMES.has(entry.name)&&(entry.isDirectory()||entry.isSymbolicLink()||entry.name==='.git')){excludedPaths.push(rel+(entry.isDirectory()?'/':''));continue;}
      if(entry.isSymbolicLink())throw fail('DIRECTORY_SNAPSHOT_PATH','Repository audit cannot follow symbolic links or junctions: '+rel);
      if(entry.isDirectory())await walk(full,rel,depth+1);
      else if(entry.isFile()){
        if(files.length>=maxFiles)throw fail('DIRECTORY_SNAPSHOT_LIMIT','Repository has too many files for a complete bounded audit.');
        const bytes=await auditFile(full,{maxBytes:Math.min(maxFileBytes,maxBytes-byteCount)});
        byteCount+=bytes.length;files.push({path:rel,sha256:sha(bytes)});
      }else throw fail('DIRECTORY_SNAPSHOT_ENTRY','Repository audit found a non-regular entry: '+rel);
    }
  }
  await walk(path.resolve(root));
  files.sort((a,b)=>a.path.localeCompare(b.path));
  return {files,sha256:sha(JSON.stringify(files)),coverage:{scope:'repository-regular-files',completeWithinScope:true,
    excludedDirectoryNames:[...GENERATED_NAMES],excludedPaths:excludedPaths.sort(),fileCount:files.length,totalBytes:byteCount}};
}
function parseTap(stdout) {
  const clean=String(stdout||'').replace(/\x1b\[[0-9;]*m/g,'');
  const integer=key=>{
    const a=[...clean.matchAll(new RegExp('(?:^|\\n)\\s*#\\s*'+key+'\\s+(\\d+)\\s*(?:\\r?\\n|$)','g'))];
    return a.length?Number(a.at(-1)[1]):null;
  };
  const byCase=key=>[...clean.matchAll(new RegExp('(?:^|\\n)\\s*'+key+'\\s+\\d+\\s+-\\s+([^\\r\\n]+)','g'))].map(x=>x[1].trim());
  return {tests:integer('tests'),passed:integer('pass'),failed:integer('fail'),
    passedCases:byCase('ok'),failedCases:byCase('not ok')};
}
/** Deterministic, code-executed test verification; model-provided claims excluded. */
export async function verifyRepository({
 repoRoot, task, receiptFile, executable, timeoutMs=50000, testPaths=null, signal, executeTestCommand,
}){
  const file=receiptFile;
  const snapshot=await sourceSnapshot(repoRoot);
  const sourceSha256=snapshot.sha256;
  // Prefer an explicit executable, otherwise reuse the runtime hosting
  // BLACKICE. Electron contains a Node runtime when launched with
  // ELECTRON_RUN_AS_NODE=1, so an absent node/npm PATH is not a blocker.
  const absolute=executable||nodeExecutableFromRequest(task)||process.execPath;
  const tests=testPaths||await discoverTests(repoRoot);
  const suite=await testSuiteSnapshot(repoRoot,{testPaths:tests});
  const startedAt=now(),started=Date.now();
  const base={version:1,file,repoRoot,at:startedAt,sourceSha256,sourceFiles:snapshot.files,sourceCoverage:snapshot.coverage,
    testFiles:tests.map(t=>path.relative(repoRoot,t).replaceAll('\\','/')),
    testSourceFiles:suite.testSourceFiles,testSuiteSha256:suite.testSuiteSha256,
    coverageMapSha256:suite.coverageMapSha256,
    executable:absolute||null};
  async function saveUnavailable(reason) {
    const data={...base,status:'unavailable',reason,tests:null,passed:null,failed:null,
      passedCases:[],failedCases:[],endedAt:now(),durationMs:Date.now()-started};
    await atomicJSON(file,data);return data;
  }
  if(!tests.length)return saveUnavailable('No test files under tests/ could be discovered.');
  if(!absolute||!path.isAbsolute(absolute))return saveUnavailable('No explicit absolute Node executable supplied.');
  try{const binary=await stat(absolute);if(!binary.isFile())return saveUnavailable('Node executable path does not identify a file.');}
  catch{return saveUnavailable('The specified Node executable does not exist.');}
  if(signal?.aborted)throw fail('ABORT_ERR','Verification cancelled.');
  // Production uses the same guarded dispatcher as ordinary Chat.
  if(executeTestCommand){
    const ran=await executeTestCommand({repoRoot,executable:absolute,tests,timeoutMs,signal,receiptFile});
    const stdout=String(ran.stdout||''),stderr=String(ran.stderr||''),tap=parseTap(stdout);
    let suiteChanged=false,sourceChanged=false;
    try{suiteChanged=(await testSuiteSnapshot(repoRoot,{testPaths:tests})).testSuiteSha256!==base.testSuiteSha256;
      sourceChanged=(await sourceSnapshot(repoRoot)).sha256!==sourceSha256;}catch{suiteChanged=true;}
    const success=!ran.timedOut&&!ran.truncated&&ran.exitCode===0&&tap.failed===0&&tap.tests!==null&&tap.passed===tap.tests;
    const record={...base,status:suiteChanged||sourceChanged?'stale':success?'passed':'failed',
      tests:tap.tests,passed:tap.passed,failed:tap.failed,suiteChanged,sourceChanged,
      passedCases:tap.passedCases,failedCases:tap.failedCases,exitCode:ran.exitCode,
      timeout:ran.timedOut===true,outputTruncated:ran.truncated===true,stdout,stderr,
      durationMs:Date.now()-started,endedAt:now()};
    await atomicJSON(file,record);return record;
  }
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',timeout=false,settled=false,outputTruncated=false;
    // node:test children inherit NODE_TEST_CONTEXT from our own test runner. Remove
    // that marker so a verification subprocess can legitimately launch its tests.
    const environment={...process.env};delete environment.NODE_TEST_CONTEXT;
    if(process.versions.electron&&path.resolve(absolute)===path.resolve(process.execPath)){
      environment.ELECTRON_RUN_AS_NODE='1';
    }
    const opts={cwd:repoRoot,windowsHide:true,env:environment,stdio:['ignore','pipe','pipe'],...(signal?{signal}:{})};
    let child;
    try{child=spawn(absolute,['--test','--test-reporter=tap',...tests],opts);}
    catch(error){reject(error);return;}
    const timer=setTimeout(()=>{timeout=true;child.kill('SIGTERM');},timeoutMs);
    const capture=(key,data)=>{
      const fragment=data.toString('utf8');
      if(key==='stdout'){
        stdout+=fragment;
      }else{
        stderr+=fragment;
      }
    };
    child.stdout?.on('data',b=>capture('stdout',b));
    child.stderr?.on('data',b=>capture('stderr',b));
    const finish=async(exitCode,error)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      const tap=parseTap(stdout);
      let suiteChanged=false,sourceChanged=false;
      try{const after=await testSuiteSnapshot(repoRoot,{testPaths:tests});
        suiteChanged=after.testSuiteSha256!==base.testSuiteSha256;
        sourceChanged=(await sourceSnapshot(repoRoot)).sha256!==sourceSha256;
      }catch{suiteChanged=true;}
      const success=!error&&!timeout&&!outputTruncated&&exitCode===0&&tap.failed===0&&tap.tests!==null&&tap.passed===tap.tests;
      const status=suiteChanged||sourceChanged?'stale':success?'passed':'failed';
      const record={...base,status,tests:tap.tests,passed:tap.passed,failed:tap.failed,
        suiteChanged,sourceChanged,
        passedCases:tap.passedCases,failedCases:tap.failedCases,exitCode,timeout,
        outputTruncated,stdout,stderr,
        ...(error?{error:String(error)}:{}),
        durationMs:Date.now()-started,endedAt:now()};
      try{await atomicJSON(file,record);resolve(record);}
      catch(err){reject(err);}
    };
    child.once('error',error=>{void finish(null,error);});
    child.once('close',code=>{void finish(code,null);});
  });
}
