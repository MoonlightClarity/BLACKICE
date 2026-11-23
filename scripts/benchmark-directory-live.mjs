// Isolated, opt-in free-provider benchmark. Never touches an installed BLACKICE run.
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

const candidateRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const baselineRoot=process.env.BLACKICE_BENCH_CONTROL_ROOT||path.join(path.dirname(candidateRoot),'BLACKICE-context-control-20261123');
const providerDir=process.env.BLACKICE_BENCH_PROVIDER_DIR||path.join(process.env.APPDATA||path.join(homedir(),'AppData','Roaming'),'Relay','data');
const variant=process.argv.find(x=>x.startsWith('--variant='))?.slice(10)||'candidate';
const model=process.argv.find(x=>x.startsWith('--model='))?.slice(8)||'kilo_free::cohere/north-mini-code:free';
const testId=process.argv.find(x=>x.startsWith('--case='))?.slice(7)||'async-cache';
const reportRoot=process.env.BLACKICE_BENCH_REPORT_DIR||path.join(path.dirname(candidateRoot),'BLACKICE-context-benchmark-results-20261123');
const sourceRoot=variant==='control'?baselineRoot:candidateRoot;
if(!['control','candidate'].includes(variant)||!['async-cache','stream-scheduler'].includes(testId))throw Error('Unsupported variant/case');
const nativeModel=/^gpt-[a-z0-9.-]{2,80}$/.test(model);
if(!nativeModel&&(!model.startsWith('kilo_free::')||!model.endsWith(':free')))throw Error('Use a native ChatGPT-subscription model or a configured free Kilo model; paid API providers are not permitted.');
const moduleImport=async file=>import(pathToFileURL(path.join(sourceRoot,'lib',file)).href);
const [{HarnessEngine},{ProviderRuntime},{ProviderStore},{CodexRuntime}]=await Promise.all([
 moduleImport('engine.mjs'),moduleImport('providers.mjs'),moduleImport('provider-store.mjs'),moduleImport('codex.mjs')]);
const results={variant,testId,model,sourceRoot,startedAt:new Date().toISOString(),toolCalls:[],trialValid:null,
  contextPolicy:variant==='candidate'?'structured-head-tail-v2':'unmodified-2.40.75',
  contextImplementationSha256:variant==='candidate'?
    createHash('sha256').update(await readFile(path.join(sourceRoot,'lib','task-external-context.mjs'))).digest('hex'):null};
const root=await mkdtemp(path.join(tmpdir(),'blackice-context-live-'+variant+'-'));
const taskRoot=path.join(root,'challenge');await mkdir(taskRoot,{recursive:true});await mkdir(path.join(taskRoot,'src'));await mkdir(path.join(taskRoot,'test'));
const write=async (name,value)=>{const dest=path.join(taskRoot,name);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,value,'utf8');};
async function makeCacheTask(){
 await write('src/cache.mjs',[
 'export class AsyncCache {',
 '  constructor({limit=3,ttl=50,clock=()=>Date.now()}={}) {',
 '    this.limit=limit;this.ttl=ttl;this.clock=clock;this.entries=new Map();',
 '  }',
 '  async get(key,load){',
 '    if(this.entries.has(key))return this.entries.get(key).value;',
 '    const value=await load();',
 '    this.entries.set(key,{value,expiry:this.clock()+this.ttl});',
 '    if(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value);',
 '    return value;',
 '  }',
 '  invalidate(key){this.entries.delete(key);}',
 '  clear(){this.entries.clear();}',
 '  snapshot(){return [...this.entries.keys()];}',
 '}',
 ].join('\n')+'\n');
 await write('src/service.mjs',[
 "import {AsyncCache} from './cache.mjs';",
 'export function makeProfileService({loadProfile,clock=()=>Date.now(),limit=3,ttl=50}){',
 ' const cache=new AsyncCache({limit,ttl,clock});',
 ' return {',
 '   getProfile: id=>cache.get(id,()=>loadProfile(id)),',
 '   invalidate: id=>cache.invalidate(id),',
 '   clear:()=>cache.clear(),',
 '   diagnostics:()=>cache.snapshot(),',
 ' };',
 '}',
 ].join('\n')+'\n');
 await write('test/cache.test.mjs',[
 "import test from 'node:test';import assert from 'node:assert/strict';",
 "import {AsyncCache} from '../src/cache.mjs';",
 "import {makeProfileService} from '../src/service.mjs';",
 "test('cached result avoids a second loader call',async()=>{let count=0;const c=new AsyncCache();assert.equal(await c.get('a',()=>++count),1);assert.equal(await c.get('a',()=>++count),1);assert.equal(count,1);});",
 "test('stale entries reload when ttl expires',async()=>{let t=0,count=0;const c=new AsyncCache({ttl:10,clock:()=>t});assert.equal(await c.get('a',()=>++count),1);t=11;assert.equal(await c.get('a',()=>++count),2);});",
 "test('concurrent gets share one in-flight load',async()=>{let count=0,done;const c=new AsyncCache();const p=c.get('a',()=>{count++;return new Promise(r=>done=r);});const q=c.get('a',()=>{count++;return 9;});await new Promise(r=>setImmediate(r));assert.equal(count,1);done(7);assert.deepEqual(await Promise.all([p,q]),[7,7]);});",
 "test('service invalidates independently',async()=>{let count=0;const s=makeProfileService({loadProfile:async id=>id+'-'+(++count)});assert.equal(await s.getProfile('x'),'x-1');s.invalidate('x');assert.equal(await s.getProfile('x'),'x-2');});",
 ].join('\n')+'\n');
 await write('README.md',[
 '# Repair a production-like asynchronous caching layer',
 'Implement a correct bounded async cache while preserving the public API of src/cache.mjs and src/service.mjs.',
 'Required: TTL expiration checked on access, true LRU eviction (reads refresh recency),',
 'concurrent same-key loader deduplication, rejection not cached, independent-key parallelism,',
 'invalidate/clear while load is in flight must not resurrect stale entry, correct caching of falsy values.',
 'Run node --test and fix failures. The incident log is supporting evidence, not a specification.',
 'Do not modify tests. Return the exact file changes and test results.',
 ].join('\n')+'\n');
}
async function makeSchedulerTask(){
 await write('src/scheduler.mjs',[
 'export async function runGraph(nodes,{maxParallel=2}={}){',
 ' const byId=new Map(nodes.map(n=>[n.id,n]));',
 ' const done=new Map();const running=new Set();const order=[];',
 ' while(done.size<nodes.length){',
 '  const ready=nodes.filter(n=>!done.has(n.id)&&!running.has(n.id)&&',
 '     (n.dependsOn||[]).some(d=>done.has(d)));',
 '  if(!ready.length)break;',
 '  await Promise.all(ready.slice(0,maxParallel).map(async node=>{',
 '    running.add(node.id);const inputs=(node.dependsOn||[]).map(d=>done.get(d));',
 '    const value=await node.run(inputs);done.set(node.id,value);order.push(node.id);running.delete(node.id);',
 '  }));',
 ' }',
 ' return {order,values:Object.fromEntries(done)};',
 '}',
 ].join('\n')+'\n');
 await write('test/scheduler.test.mjs',[
 "import test from 'node:test';import assert from 'node:assert/strict';",
 "import {runGraph} from '../src/scheduler.mjs';",
 "test('independent roots execute',async()=>{const r=await runGraph([{id:'a',run:async()=>3},{id:'b',run:async()=>4}]);assert.deepEqual(r.values,{a:3,b:4});});",
 "test('prerequisites must finish before descendants',async()=>{const r=await runGraph([{id:'a',run:async()=>2},{id:'b',dependsOn:['a'],run:async([v])=>v*5}]);assert.deepEqual(r.values,{a:2,b:10});});",
 ].join('\n')+'\n');
 await write('README.md',[
 '# Repair the asynchronous dependency graph runner',
 'Fix src/scheduler.mjs while preserving export runGraph(nodes,{maxParallel}).',
 'Requirements: validate unique IDs and dependency existence; report cycles and prevent hangs;',
 'root nodes run, multiple dependencies all succeed before a node starts;',
 'respect maxParallel across in-flight asynchronous operations;',
 'independent ready work continues while slower nodes are pending;',
 'on failure do not schedule dependents or hide original error;',
 'final values and order report actual completed nodes. Run node --test.',
 ].join('\n')+'\n');
}
if(testId==='async-cache')await makeCacheTask();else await makeSchedulerTask();
const incident=['2026-11-22T12:00:00Z INCIDENT TRACE '+testId];
for(let i=0;i<240;i++)incident.push('2026-11-22T12:00:'+String(i%60).padStart(2,'0')+'Z trace request='+i+' key='+(['alpha','beta','gamma'][i%3])+' pending='+((i*7)%13)+' note=scheduled-repeat-observation');
incident.push(testId==='async-cache'?'2026-11-22T12:59:59Z defect: a fulfilled promise was replaced by a stale value after invalidation; duplicate loader race confirmed.':'2026-11-22T12:59:59Z defect: root dependency checks skip every root and an all-of dependency was implemented as any-of.');
await writeFile(path.join(taskRoot,'incident.log'),incident.join('\n')+'\n');
const acceptanceCache=[
 "import test from 'node:test';import assert from 'node:assert/strict';",
 "import {AsyncCache} from '../src/cache.mjs';",
 "test('falsy values are cached',async()=>{let n=0;const c=new AsyncCache();assert.equal(await c.get('false',()=>{n++;return false}),false);assert.equal(await c.get('false',()=>{n++;return true}),false);assert.equal(n,1);});",
 "test('rejected loader can retry',async()=>{let n=0;const c=new AsyncCache();await assert.rejects(c.get('x',()=>{n++;throw Error('fail');}));assert.equal(await c.get('x',()=>{n++;return 3}),3);assert.equal(n,2);});",
 "test('read refreshes LRU recency',async()=>{const c=new AsyncCache({limit:2});await c.get('a',()=>1);await c.get('b',()=>2);await c.get('a',()=>9);await c.get('c',()=>3);assert.deepEqual(c.snapshot(),['a','c']);});",
 "test('invalidate during pending load prevents stale resurrection',async()=>{let finish;const c=new AsyncCache();const p=c.get('x',()=>new Promise(r=>finish=r));await new Promise(r=>setImmediate(r));c.invalidate('x');finish('old');await p;assert.equal(await c.get('x',()=> 'fresh'),'fresh');});",
 "test('clear during pending load prevents stale resurrection',async()=>{let finish;const c=new AsyncCache();const p=c.get('x',()=>new Promise(r=>finish=r));await new Promise(r=>setImmediate(r));c.clear();finish('old');await p;assert.equal(await c.get('x',()=> 'fresh'),'fresh');});",
];
const acceptanceScheduler=[
 "import test from 'node:test';import assert from 'node:assert/strict';",
 "import {runGraph} from '../src/scheduler.mjs';",
 "test('duplicate IDs reject',async()=>{await assert.rejects(runGraph([{id:'a',run:async()=>1},{id:'a',run:async()=>2}]));});",
 "test('unknown dependencies reject',async()=>{await assert.rejects(runGraph([{id:'a',dependsOn:['missing'],run:async()=>1}]));});",
 "test('cycles reject',async()=>{await assert.rejects(runGraph([{id:'a',dependsOn:['b'],run:async()=>1},{id:'b',dependsOn:['a'],run:async()=>1}]));});",
 "test('all prerequisites are satisfied before a node runs',async()=>{let release;const slow=new Promise(r=>release=r);const task=runGraph([{id:'a',run:async()=>1},{id:'b',run:async()=>{await slow;return 2;}},{id:'c',dependsOn:['a','b'],run:async(x)=>x.join(',')}]);await new Promise(r=>setTimeout(r,20));release();assert.equal((await task).values.c,'1,2');});",
 "test('maxParallel=1 prevents overlap',async()=>{let active=0,peak=0;await runGraph(Array.from({length:6},(_,i)=>({id:'n'+i,run:async()=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;return i;}})),{maxParallel:1});assert.equal(peak,1);});",
];
const grader=(testId==='async-cache'?acceptanceCache:acceptanceScheduler).join('\n')+'\n';
if (process.argv.includes('--verify-gold')) {
  if (testId === 'async-cache') {
    await write('src/cache.mjs', [
      'export class AsyncCache {',
      'constructor({limit=3,ttl=50,clock=()=>Date.now()}={}){this.limit=limit;this.ttl=ttl;this.clock=clock;this.entries=new Map();}',
      'async get(key,load){',
      'const existing=this.entries.get(key);',
      'if(existing&&(existing.pending||this.clock()<existing.expiry)){this.entries.delete(key);this.entries.set(key,existing);return existing.pending||existing.value;}',
      'if(existing)this.entries.delete(key);',
      'const entry={pending:null,value:undefined,expiry:Infinity};',
      'const pending=Promise.resolve().then(()=>load()).then(value=>{',
      ' if(this.entries.get(key)===entry){entry.pending=null;entry.value=value;entry.expiry=this.clock()+this.ttl;}return value;',
      '},error=>{if(this.entries.get(key)===entry)this.entries.delete(key);throw error;});',
      'entry.pending=pending;this.entries.set(key,entry);',
      'while(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value);',
      'return pending;',
      '}',
      'invalidate(key){this.entries.delete(key);}',
      'clear(){this.entries.clear();}',
      'snapshot(){return [...this.entries.keys()];}',
      '}',
    ].join('\n')+'\n');
  } else {
    await write('src/scheduler.mjs', [
      'export async function runGraph(nodes,{maxParallel=2}={}){',
      "if(!Array.isArray(nodes)||!Number.isInteger(maxParallel)||maxParallel<1)throw Error('invalid input');",
      'const byId=new Map(nodes.map(n=>[n.id,n]));',
      "if(byId.size!==nodes.length||nodes.some(n=>typeof n.id!=='string'||typeof n.run!=='function'||(n.dependsOn||[]).some(d=>!byId.has(d))))throw Error('invalid graph');",
      'const done=new Map(),active=new Map(),order=[];',
      'while(done.size<nodes.length){',
      'for(const node of nodes){',
      ' if(active.size>=maxParallel)break;',
      ' if(done.has(node.id)||active.has(node.id)||!(node.dependsOn||[]).every(d=>done.has(d)))continue;',
      ' const inputs=(node.dependsOn||[]).map(d=>done.get(d));',
      ' const p=Promise.resolve().then(()=>node.run(inputs)).then(value=>({id:node.id,value,ok:true}),error=>({id:node.id,error,ok:false}));',
      ' active.set(node.id,p);',
      '}',
      "if(!active.size)throw Error('cycle or deadlock');",
      'const next=await Promise.race(active.values());active.delete(next.id);',
      'if(!next.ok)throw next.error;',
      'done.set(next.id,next.value);order.push(next.id);',
      '}',
      'return {order,values:Object.fromEntries(done)};',
      '}',
    ].join('\n')+'\n');
  }
  await writeFile(path.join(taskRoot,'test','hidden-acceptance.test.mjs'),grader);
  const check=spawnSync(process.execPath,['--test'],{cwd:taskRoot,encoding:'utf8',timeout:30000});
  const summary={case:testId,goldExitCode:check.status,goldOutput:(check.stdout||'').slice(-1000),goldError:(check.stderr||'').slice(-1000)};
  console.log(JSON.stringify(summary));
  await rm(root,{recursive:true,force:true});
  process.exit(check.status===0?0:1);
}

let engine,runtime;
try{
  if(nativeModel){
    runtime=new CodexRuntime({cwd:taskRoot,isolatedHistory:true,requestTimeoutMs:30000,runTimeoutMs:600000});
    const native=await runtime.start();
    if(!native.authenticated||!native.models?.some(m=>(m.id||m.model)===model))throw Error('Selected native subscription model is not confirmed in authenticated Codex catalog.');
  }else{
    const installed=new ProviderStore({dataDir:providerDir});
    await installed.init(); // reads provider configuration, no writes
    if(!installed.get('kilo_free')?.enabled||!installed.get('kilo_free')?.models?.some(m=>'kilo_free::'+m.id===model))throw Error('Specified free model not configured.');
    const codex=new EventEmitter();
    codex.status=()=>({connected:false,authenticated:false,models:[]});
    codex.runAgent=async()=>{throw Error('Native Codex cannot be used for an API-model trial');};
    runtime=new ProviderRuntime({codex,dataDir:path.join(root,'provider'),modelLimitResolver:{enrich:async (_config,m)=>m},runTimeoutMs:360000,maxSteps:90,requestTimeoutMs:60000});
    runtime.store=installed; // read-only provider settings; provider sessions stored in isolated root
  }
  const actual=runtime.runAgent.bind(runtime);
  runtime.runAgent=options=>actual({...options,onToolCall:async(call,ctx)=>{
    const entry={name:call.name,action:(typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments)?.action,at:Date.now()};
    results.toolCalls.push(entry);
    try{const value=await options.onToolCall(call,ctx);entry.success=value?.success;entry.code=value?.code||null;
      const first=value?.contentItems?.find(item=>item?.type==='inputText'&&typeof item.text==='string')?.text;
      entry.resultPreview=typeof first==='string'?first.slice(0,180):null;
      return value;
    }catch(error){entry.threw=String(error.code||error.message||error).slice(0,180);throw error;}
  }});
  engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:taskRoot}).init();
  const graph={name:'Benchmark coding',nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Coding agent',model,prompt:'You are the coding agent. Fix the described software bugs. Inspect files and tests with your tools. Use only this isolated workspace. Verify the changes by running the test suite. Use current tool schemas.'},{id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off',context:{outputReserveTokens:16384,headroomTokens:2048}}};
  const task='In this isolated coding project ('+taskRoot+'), read README.md, incident.log and source files, fix the implementation until node --test passes. Preserve the public API, test files and user instructions. Be careful with false or stale outputs. Run tests to confirm. You may use the given workspace tools. This is a real coding benchmark; do not merely describe a fix.';
  const started=engine.startRun({workflow:graph,input:{task,directoryActions:'on',directoryDiagnostics:'off'}});
  results.runId=started.id;
  await engine.executions.get(started.id);
  const run=engine.getRun(started.id); results.runStatus=run.status;results.runError=run.error||null;results.agentOutput=String(run.nodes?.a?.output||'').slice(0,1500);
  const directorySnapshot=(await engine.actionDirectories.get(started.id,task)).read();
  results.directoryRecords=directorySnapshot.actions.map(a=>({id:a.id,state:a.state,objective:a.objective,notes:a.notes?.length||0,observation:a.observation?.claim||null}));
  results.directoryFinal={focus:directorySnapshot.focus,revision:directorySnapshot.revision,receiptCount:directorySnapshot.receipts.length,ready:directorySnapshot.ready};
  const state=engine.runs.get(started.id)?.nodes?.a||{};
  results.nodeDiagnostics={directoryOutcome:state.directoryOutcome||null,runtimePhase:state.runtimePhase||null,toolNames:state.toolNames||[],usage:state.usage||state.tokenUsage||null};
  results.completedAt=new Date().toISOString();
  await writeFile(path.join(taskRoot,'test','hidden-acceptance.test.mjs'),grader);
  const hidden=spawnSync(process.execPath,['--test'],{cwd:taskRoot,encoding:'utf8',timeout:30000});
  results.hiddenGrade={exitCode:hidden.status,output:(hidden.stdout||'').slice(-5000),errors:(hidden.stderr||'').slice(-1500)};
  results.trialValid=(run.status==='completed'||run.status==='failed')&&results.toolCalls.length>0&&!/(429|401|502|503|quota|rate limit|PROVIDER_TIMEOUT|network|unsupported model|model.*does not exist|context overflow|output limit|timeout|sign up for free|come back later|wait before trying again|free to continue|no credit card required|CODEX_CAPABILITY_SCOPE|CODEX_RUNTIME|HOST_ONLY_TRANSPORT)/i.test(String(run.error||''));
  results.codingCorrect=hidden.status===0;
  results.workflowCompleted=run.status==='completed';
  results.codingSuccess=results.workflowCompleted&&results.codingCorrect;
  results.externalArtifactCount=variant==='candidate'?((await import('node:fs/promises')).readdir(path.join(root,'engine','task-external-context',started.id)).then(a=>a.length/2).catch(()=>0)):Promise.resolve(0);
  results.externalArtifactCount=await results.externalArtifactCount;
}catch(error){results.trialValid=false;results.infraError=String(error?.stack||error).slice(0,3000);}
finally{
  await engine?.close().catch(()=>{});
  await runtime?.close?.().catch(()=>{});
  await mkdir(reportRoot,{recursive:true});
  const solutionDir=path.join(reportRoot,'solutions',testId+'-'+variant+'-'+randomUUID().slice(0,8));
  await mkdir(solutionDir,{recursive:true});
  await cp(path.join(taskRoot,'src'),path.join(solutionDir,'src'),{recursive:true}).catch(()=>{});
  results.solutionDir=solutionDir;
  results.finishedAt=new Date().toISOString();
  const reportPath=path.join(reportRoot,testId+'-'+variant+'-'+randomUUID().slice(0,8)+'.json');
  await writeFile(reportPath,JSON.stringify(results,null,2));
  console.log(JSON.stringify({reportPath,variant,testId,model,contextPolicy:results.contextPolicy,runStatus:results.runStatus,trialValid:results.trialValid,codingCorrect:results.codingCorrect,workflowCompleted:results.workflowCompleted,codingSuccess:results.codingSuccess,toolCalls:results.toolCalls.length,externalArtifactCount:results.externalArtifactCount,infraError:results.infraError,runError:results.runError}));
  await rm(root,{recursive:true,force:true}).catch(()=>{});
}
