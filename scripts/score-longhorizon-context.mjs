// Same-source native-model long-evidence benchmark reconciliation.
// Keeps task quality separate from actual paging-pressure exposure.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const resultsDir=process.env.BLACKICE_BENCH_REPORT_DIR||path.join(path.dirname(sourceRoot),'BLACKICE-context-benchmark-results-20261123');
const model=process.argv.find(arg=>arg.startsWith('--model='))?.slice(8)||'gpt-6-luna';
const hash=async file=>createHash('sha256').update(await readFile(path.join(sourceRoot,file))).digest('hex');
const sourceHashes={
 engine:await hash('lib/engine.mjs'),
 workspace:await hash('lib/workspace-tools.mjs'),
 context:await hash('lib/task-external-context.mjs'),
 codeFixture:await hash('scripts/benchmark-fixture-event-replay.mjs'),
 evidenceFixture:await hash('scripts/benchmark-fixture-long-evidence.mjs'),
};
const errorIsInfrastructure=/\b429\b|\b401\b|\b402\b|\b502\b|\b503\b|quota|rate.?limit|timeout|provider.*unavailable|context overflow|output limit|sign up for free|come back later|CODEX_RUNTIME|HOST_ONLY_TRANSPORT|CAPABILITY_SCOPE_UNAVAILABLE/i;
const files=(await readdir(resultsDir)).filter(name=>/^event-replay-long-candidate-no-dir-(?:no-paging-|adaptive-)?[a-f0-9]+\.json$/.test(name));
const results=[];
for(const file of files){
 const raw=JSON.parse(await readFile(path.join(resultsDir,file),'utf8'));
 if(raw.model!==model||raw.testId!=='event-replay-long'||raw.variant!=='candidate'||raw.directoryMode!=='off')continue;
 const mode=raw.pagingMode==='off'?'off':raw.pagingMode==='adaptive'?'adaptive':['eager','on'].includes(raw.pagingMode)?'eager':null;
 if(!mode)continue;
 const sourceMatched=raw.harnessEngineSha256===sourceHashes.engine&&raw.workspaceToolSha256===sourceHashes.workspace
  &&raw.contextImplementationSha256===sourceHashes.context&&raw.benchmarkFixtureSha256===sourceHashes.codeFixture
  &&raw.longEvidenceFixtureSha256===sourceHashes.evidenceFixture;
 const output=String(raw.hiddenGrade?.output||'');
 const observedTests=Number(/# tests (\d+)/.exec(output)?.[1]||0);
 const passed=Number(/# pass (\d+)/.exec(output)?.[1]||0);
 const sourceLoadFailure=observedTests>0&&observedTests<21&&raw.hiddenGrade?.exitCode!==0
  &&/SyntaxError:|ERR_MODULE_NOT_FOUND|Cannot find module/i.test(output)&&/[\\/]challenge[\\/]src[\\/]/i.test(output);
 const error=String(raw.infraError||raw.runError||'');
 const valid=sourceMatched&&!raw.infraError&&!errorIsInfrastructure.test(error)
  &&['completed','failed'].includes(raw.runStatus)&&raw.toolCalls?.length>0
  &&(observedTests===21||sourceLoadFailure)&&Number.isInteger(raw.hiddenGrade?.exitCode);
 const originalBytes=raw.contextPressure?.originalEligibleReadBytes||0;
 const crossedOriginalThreshold=originalBytes>96*1024;
 const archived=raw.contextPressure?.archivedToolResults||0;
 const exposedPaging=(mode==='adaptive'||mode==='eager')&&crossedOriginalThreshold&&archived>0;
 const fullSuccess=valid&&raw.hiddenGrade.exitCode===0&&passed===21&&raw.runStatus==='completed';
 results.push({
  file,mode,valid,
  invalidReason:valid?null:(!sourceMatched?'Nonmatching source/fixture revision':error||'Missing tool results or acceptable grader evidence'),
  startedAt:raw.startedAt,runStatus:raw.runStatus,runError:raw.runError||null,codePassed:passed,totalChecks:21,
  observedCases:observedTests,sourceLoadFailure,completeTask:fullSuccess,
  toolCalls:raw.toolCalls.length,
  seconds:Math.round((Date.parse(raw.finishedAt)-Date.parse(raw.startedAt))/100)/10,
  originalReadOnlyBytes:originalBytes,modelFacingReadOnlyBytes:raw.contextPressure?.modelVisibleEligibleReadBytes||0,
  allToolVisibleBytes:raw.contextPressure?.allModelFacingToolBytes||0,
  archivedToolResults:archived,archivedOriginalBytes:raw.contextPressure?.archivedOriginalBytes||0,
  retrievalCalls:raw.contextPressure?.retrievalCalls||0,
  evidenceShardReferences:raw.contextPressure?.traceShardsReferenced||[],
  directEvidenceShardReads:raw.contextPressure?.traceShardReadCalls||0,
  crossedOriginalThreshold,exposedPaging,
  corpusBytes:raw.evidenceManifest?.bytes||0,
  failures:[...output.matchAll(/^not ok \d+ - ([^\r\n]+)/gm)].map(x=>x[1]),
 });
}
const arms=['off','eager','adaptive'];
const eligible=Object.fromEntries(arms.map(mode=>[mode,results.filter(x=>x.valid&&x.mode===mode).sort((a,b)=>a.startedAt.localeCompare(b.startedAt))]));
const pairCount=Math.min(...arms.map(mode=>eligible[mode].length));
const pairs=Array.from({length:pairCount},(_,i)=>Object.fromEntries(arms.map(mode=>[mode,eligible[mode][i]])));
const pressurePairs=pairs.filter(row=>arms.every(mode=>row[mode].crossedOriginalThreshold)&&
 row.eager.archivedToolResults>0&&row.adaptive.archivedToolResults>0);
const mean=(rows,key)=>rows.length?Math.round(rows.reduce((sum,row)=>sum+(row[key]||0),0)/rows.length*10)/10:null;
const gold=spawnSync(process.execPath,[path.join(sourceRoot,'scripts','benchmark-directory-live.mjs'),'--case=event-replay-long','--verify-gold','--directory=off','--paging=adaptive'],{cwd:sourceRoot,encoding:'utf8',timeout:30000});
const report={
 generatedAt:new Date().toISOString(),model,
 purpose:'Model-driven multi-shard coding task, with actual observed host result volume; a scripted stress or tool-injection-only run is not counted as model reasoning.',
 case:'event-replay-long',directoryMode:'off',referenceSolutionPass:gold.status===0,
 sourceHashes,matchedTriples:pairs,pressureQualifiedTriples:pressurePairs.length,
 validCounts:Object.fromEntries(arms.map(mode=>[mode,eligible[mode].length])),
 summary:Object.fromEntries(arms.map(mode=>[mode,{
  fullTaskPass:eligible[mode].slice(0,pairCount).filter(x=>x.completeTask).length,
  meanChecksPassed:mean(eligible[mode].slice(0,pairCount),'codePassed'),
  meanTimeSeconds:mean(eligible[mode].slice(0,pairCount),'seconds'),
  meanCalls:mean(eligible[mode].slice(0,pairCount),'toolCalls'),
  meanOriginalEvidenceBytes:mean(eligible[mode].slice(0,pairCount),'originalReadOnlyBytes'),
  meanVisibleEvidenceBytes:mean(eligible[mode].slice(0,pairCount),'modelFacingReadOnlyBytes'),
  meanArchives:mean(eligible[mode].slice(0,pairCount),'archivedToolResults'),
  pressureCrossings:eligible[mode].slice(0,pairCount).filter(x=>x.crossedOriginalThreshold).length,
 }])),
 invalid:results.filter(x=>!x.valid).map(x=>({file:x.file,mode:x.mode,reason:x.invalidReason})),
 interpretation:'Only triples where all settings really encountered more than 96 KiB of original eligible tool output, and adaptive visibly archived, qualify as context-pressure comparisons. All other trials still count for coding correctness, but cannot establish a paging effect at the intended threshold. No single stochastic result establishes superiority.',
};
const target=path.join(resultsDir,'score-longhorizon-context-20261123.json');
await writeFile(target,JSON.stringify(report,null,2));
console.log(JSON.stringify({target,referenceSolutionPass:report.referenceSolutionPass,matchedTriples:pairs.length,pressureQualifiedTriples:pressurePairs.length,
 counts:report.validCounts,summary:report.summary,rows:pairs.map((pair,i)=>({pair:i+1,results:Object.fromEntries(arms.map(mode=>[mode,{
 passed:pair[mode].codePassed,pressure:pair[mode].crossedOriginalThreshold,originalBytes:pair[mode].originalReadOnlyBytes,visibleBytes:pair[mode].modelFacingReadOnlyBytes,
 archived:pair[mode].archivedToolResults,retrievals:pair[mode].retrievalCalls,shards:pair[mode].evidenceShardReferences.length,calls:pair[mode].toolCalls,
 }]))})),invalid:report.invalid}));
if(!report.referenceSolutionPass)process.exitCode=1;
