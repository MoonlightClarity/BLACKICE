// Independent same-source long-evidence score for BLACKICE *ordinary Chat*, not a generic workflow.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const resultRoot=process.env.BLACKICE_BENCH_REPORT_DIR||path.join(path.dirname(sourceRoot),'BLACKICE-context-benchmark-results-20261123');
const model=process.argv.find(arg=>arg.startsWith('--model='))?.slice(8)||'gpt-6-luna';
const hash=async relative=>createHash('sha256').update(await readFile(path.join(sourceRoot,relative))).digest('hex');
const hashes={
 engine:await hash('lib/engine.mjs'),workspace:await hash('lib/workspace-tools.mjs'),
 context:await hash('lib/task-external-context.mjs'),fixture:await hash('scripts/benchmark-fixture-event-replay.mjs'),
 longEvidence:await hash('scripts/benchmark-fixture-long-evidence.mjs'),
 driver:await hash('scripts/benchmark-directory-live.mjs'),
 ordinaryChatWorkflow:await hash('scripts/benchmark-chat-workflow.mjs'),
};
const infra=/\b429\b|\b401\b|\b402\b|\b502\b|\b503\b|quota|rate.?limit|timeout|provider.*unavailable|context overflow|output limit|sign up for free|come back later|CODEX_RUNTIME|HOST_ONLY_TRANSPORT|CAPABILITY_SCOPE_UNAVAILABLE|CHAT_OUTCOME_AUTHORITY_UNAVAILABLE|CHAT_OUTCOME_EVIDENCE_INCOMPLETE/i;
const files=(await readdir(resultRoot)).filter(file=>/^event-replay-long-candidate-no-dir-(?:no-paging-|adaptive-)?ordinary-chat-[a-f0-9]+\.json$/.test(file));
const records=[];
for(const filename of files){
 const r=JSON.parse(await readFile(path.join(resultRoot,filename),'utf8'));
 if(r.model!==model||r.variant!=='candidate'||r.directoryMode!=='off'||r.workflowKind!=='ordinary-chat')continue;
 const mode=r.pagingMode==='off'?'off':r.pagingMode==='adaptive'?'adaptive':['on','eager'].includes(r.pagingMode)?'eager':null;
 if(!mode)continue;
 const sourceMatches=r.harnessEngineSha256===hashes.engine&&r.workspaceToolSha256===hashes.workspace&&
   r.contextImplementationSha256===hashes.context&&r.benchmarkFixtureSha256===hashes.fixture&&
   r.longEvidenceFixtureSha256===hashes.longEvidence&&r.benchmarkDriverSha256===hashes.driver&&
   r.benchmarkWorkflowSha256===hashes.ordinaryChatWorkflow;
 const reviewActive=r.graphIdentity?.recognizedAsOrdinaryChat===true&&Array.isArray(r.finalReviewCalls)&&r.finalReviewCalls.some(event=>event.continued===true);
 const error=String(r.infraError||r.runError||'');
 const grade=String(r.hiddenGrade?.output||'');
 const observedTests=Number(/# tests (\d+)/.exec(grade)?.[1]||0);
 const passed=Number(/# pass (\d+)/.exec(grade)?.[1]||0);
 const sourceLoadFailure=observedTests>0&&observedTests<21&&r.hiddenGrade?.exitCode!==0&&
   /SyntaxError:|ERR_MODULE_NOT_FOUND|Cannot find module/i.test(grade)&&/[\\/]challenge[\\/]src[\\/]/i.test(grade);
 const valid=sourceMatches&&reviewActive&&!r.infraError&&!infra.test(error)&&
   ['completed','failed'].includes(r.runStatus)&&(observedTests===21||sourceLoadFailure)&&
   Number.isInteger(r.hiddenGrade?.exitCode)&&Array.isArray(r.toolCalls)&&r.toolCalls.length>0;
 const originalOutput=r.contextPressure?.originalEligibleReadBytes||0;
 const archiveCount=r.contextPressure?.archivedToolResults||0;
 const pressureCrossed=originalOutput>96*1024;
 const codesPassed=observedTests===21?passed:sourceLoadFailure?0:passed;
 records.push({
  filename,mode,valid,invalidReason:valid?null:(!sourceMatches?'Different source revision':!reviewActive?'Ordinary Chat reviewer did not run':error||'Missing valid grading/tool evidence'),
  startedAt:r.startedAt,runStatus:r.runStatus,reviewActive,
  reviewCalls:r.finalReviewCalls?.length||0,
  reviewContinued:r.finalReviewCalls?.filter(x=>x.continued).length||0,
  codePassed:codesPassed,expectedChecks:21,observedTests,sourceLoadFailure,
  fullTaskSuccess:valid&&r.hiddenGrade.exitCode===0&&codesPassed===21&&r.runStatus==='completed',
  toolCalls:r.toolCalls.length,durationSeconds:Math.round((Date.parse(r.finishedAt)-Date.parse(r.startedAt))/100)/10,
  originalEligibleBytes:originalOutput,modelVisibleEligibleBytes:r.contextPressure?.modelVisibleEligibleReadBytes||0,
  shellOutputBytes:r.contextPressure?.shellOriginalBytes||0,
  archivedOutputs:archiveCount,shellArchivedOutputs:r.contextPressure?.shellArchivedOutputs||0,
  retrievalCalls:r.contextPressure?.retrievalCalls||0,pressureCrossed,
  inspectedShards:r.contextPressure?.traceShardsReferenced||[],
  reportIncompletion:typeof r.agentOutput==='string'&&/\b(?:not completed?|incomplete|remain(?:s)? unfinished|did not (?:complete|finish|update|run))\b/i.test(r.agentOutput),
  failures:[...grade.matchAll(/^not ok \d+ - ([^\r\n]+)/gm)].map(x=>x[1]),
 });
}
const arms=['off','eager','adaptive'];
const validByMode=Object.fromEntries(arms.map(mode=>[mode,records.filter(x=>x.valid&&x.mode===mode).sort((a,b)=>a.startedAt.localeCompare(b.startedAt))]));
const matchedCount=Math.min(...arms.map(mode=>validByMode[mode].length));
const triples=Array.from({length:matchedCount},(_,i)=>Object.fromEntries(arms.map(mode=>[mode,validByMode[mode][i]])));
const pressureTriples=triples.filter(row=>arms.every(mode=>row[mode].pressureCrossed)&&row.eager.archivedOutputs>0&&row.adaptive.archivedOutputs>0);
const mean=(arr,key)=>arr.length?Math.round(arr.reduce((n,row)=>n+(row[key]||0),0)/arr.length*10)/10:null;
const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
const gold=spawnSync(process.execPath,[path.join(sourceRoot,'scripts','benchmark-directory-live.mjs'),'--case=event-replay-long','--verify-gold','--directory=off','--paging=adaptive','--workflow=ordinary-chat'],{cwd:sourceRoot,encoding:'utf8',timeout:30000,env:childEnv});
const score={
 model,case:'event-replay-long',workflow:'ordinary-chat',directoryMode:'off',sourceHashes:hashes,
 referenceSolutionPass:gold.status===0,generatedAt:new Date().toISOString(),
 method:'Only exact-source, reviewer-confirmed ordinary Chat runs count. Invalid provider/reviewer/harness trials are excluded, and source-load syntax failures count as valid coding failures. Full task success requires 21/21 and a completed run. Paging-pressure comparison requires all three arms to exceed 96 KiB of original eligible tool text and adaptive/eager actually archive.',
 matchedTriples:triples,matchedCount,pressureMatchedCount:pressureTriples.length,
 validCounts:Object.fromEntries(arms.map(mode=>[mode,validByMode[mode].length])),
 summary:Object.fromEntries(arms.map(mode=>[mode,{
  fullPasses:validByMode[mode].slice(0,matchedCount).filter(x=>x.fullTaskSuccess).length,
  avgPassed:mean(validByMode[mode].slice(0,matchedCount),'codePassed'),
  avgSeconds:mean(validByMode[mode].slice(0,matchedCount),'durationSeconds'),
  avgCalls:mean(validByMode[mode].slice(0,matchedCount),'toolCalls'),
  pressureRuns:validByMode[mode].slice(0,matchedCount).filter(x=>x.pressureCrossed).length,
 }])),
 excluded:records.filter(x=>!x.valid).map(x=>({file:x.filename,reason:x.invalidReason})),
 warning:'Small stochastic samples are not a population-level performance estimate. Efficient out-of-core shell processing may avoid paging pressure; those runs remain valid coding outcomes but do not qualify as evidence of paging effectiveness.',
};
const output=path.join(resultRoot,'score-ordinary-chat-longhorizon-20261123.json');
await writeFile(output,JSON.stringify(score,null,2));
console.log(JSON.stringify({output,referenceSolutionPass:score.referenceSolutionPass,matchedCount,pressureMatchedCount:score.pressureMatchedCount,counts:score.validCounts,summary:score.summary,
 triples:triples.map((triple,i)=>({trial:i+1,arms:Object.fromEntries(arms.map(mode=>[mode,{
  tests:triple[mode].codePassed+'/21',reviewCalls:triple[mode].reviewCalls,
  calls:triple[mode].toolCalls,seconds:triple[mode].durationSeconds,
  archives:triple[mode].archivedOutputs,originalBytes:triple[mode].originalEligibleBytes,
  pressure:triple[mode].pressureCrossed,full:triple[mode].fullTaskSuccess,
 }]))})),invalid:score.excluded}));
if(!score.referenceSolutionPass)process.exitCode=1;
