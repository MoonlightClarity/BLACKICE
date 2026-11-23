// Independent scoring of same-harness eager/adaptive/disabled context-paging trials.
// Reads existing raw evidence only. Model calls and task mutation occur in the live driver.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const resultRoot=process.env.BLACKICE_BENCH_REPORT_DIR||path.join(path.dirname(sourceRoot),'BLACKICE-context-benchmark-results-20261123');
const model=process.argv.find(a=>a.startsWith('--model='))?.slice(8)||'gpt-6-luna';
const sha=async name=>createHash('sha256').update(await readFile(path.join(sourceRoot,name))).digest('hex');
const sourceHashes={
 engine:await sha('lib/engine.mjs'),workspace:await sha('lib/workspace-tools.mjs'),
 context:await sha('lib/task-external-context.mjs'),fixture:await sha('scripts/benchmark-fixture-event-replay.mjs'),
};
const invalidInfrastructure=/\b429\b|\b401\b|\b402\b|\b502\b|\b503\b|quota|rate.?limit|timeout|provider.*unavailable|context overflow|output limit|sign up for free|come back later|CODEX_RUNTIME|CAPABILITY_SCOPE_UNAVAILABLE|HOST_ONLY_TRANSPORT/i;
const reports=[];
for(const filename of (await readdir(resultRoot)).filter(x=>/^event-replay-candidate-no-dir-(?:adaptive-|no-paging-)?[a-f0-9]+\.json$/.test(x))){
 const raw=JSON.parse(await readFile(path.join(resultRoot,filename),'utf8'));
 if(raw.model!==model||raw.variant!=='candidate'||raw.directoryMode!=='off')continue;
 const mode=raw.pagingMode==='adaptive'?'adaptive':raw.pagingMode==='off'?'off':raw.pagingMode==='on'||raw.pagingMode==='eager'?'eager':null;
 if(!mode)continue;
 const matched=raw.harnessEngineSha256===sourceHashes.engine
  &&raw.workspaceToolSha256===sourceHashes.workspace
  &&raw.contextImplementationSha256===sourceHashes.context
  &&raw.benchmarkFixtureSha256===sourceHashes.fixture;
 const grade=String(raw.hiddenGrade?.output||'');
 const tests=Number(/# tests (\d+)/.exec(grade)?.[1]||0);
 const passed=Number(/# pass (\d+)/.exec(grade)?.[1]||0);
 const reason=String(raw.infraError||raw.runError||'');
 // A model-authored source syntax error may prevent Node from loading the
 // entire suite, yielding only file-level failures. The independently passing
 // grader is not broken; this is a valid zero-pass coding outcome.
 const sourceLoadFailure=tests>0&&tests<21&&raw.hiddenGrade?.exitCode!==0
  &&/SyntaxError:|ERR_MODULE_NOT_FOUND|Cannot find module/i.test(grade)
  &&/[\\/]challenge[\\/]src[\\/]/i.test(grade);
 const valid=matched&&!raw.infraError&&!invalidInfrastructure.test(reason)
  &&['completed','failed'].includes(raw.runStatus)&&(tests===21||sourceLoadFailure)
  &&Number.isInteger(raw.hiddenGrade?.exitCode)&&Array.isArray(raw.toolCalls)&&raw.toolCalls.length>0;
 reports.push({
  filename,mode,valid,reason:valid?null:(!matched?'Different source revision':reason||'Missing complete grading/tool evidence'),
  runStatus:raw.runStatus,startedAt:raw.startedAt,
  passed,tests:21,observedTestCases:tests,sourceLoadFailure,completeTask:valid&&raw.runStatus==='completed'&&passed===21&&raw.hiddenGrade.exitCode===0,
  calls:raw.toolCalls?.length||0,retrievalCalls:raw.toolCalls?.filter(x=>x.name==='relay_context_page').length||0,
  seconds:Math.round((Date.parse(raw.finishedAt)-Date.parse(raw.startedAt))/100)/10,
  archivedArtifacts:raw.externalArtifactCount||0,
  missed:[...grade.matchAll(/^not ok \d+ - ([^\r\n]+)/gm)].map(x=>x[1]),
 });
}
const modes=['off','eager','adaptive'];
const eligible=Object.fromEntries(modes.map(mode=>[mode,reports.filter(x=>x.valid&&x.mode===mode).sort((a,b)=>a.startedAt.localeCompare(b.startedAt))]));
const pairCount=Math.min(...modes.map(mode=>eligible[mode].length));
const matchedTriples=Array.from({length:pairCount},(_,i)=>Object.fromEntries(modes.map(mode=>[mode,eligible[mode][i]])));
const mean=(rows,key)=>rows.length?Math.round(rows.reduce((sum,row)=>sum+row[key],0)/rows.length*10)/10:null;
const gradeGold=spawnSync(process.execPath,[path.join(sourceRoot,'scripts','benchmark-directory-live.mjs'),'--case=event-replay','--verify-gold','--directory=off','--paging=adaptive'],{
 cwd:sourceRoot,encoding:'utf8',timeout:30000,
});
const summary={
 generatedAt:new Date().toISOString(),model,case:'event-replay',directoryMode:'off',sourceHashes,
 referenceSolutionPass:gradeGold.status===0,
 method:'Compare all three modes on the exact same source and model. Exclude infrastructure-invalid and earlier-source runs. Only all 21 checks plus completed workflow is a full task pass. Small stochastic samples cannot establish a population-level advantage. No hidden-test leakage into model runs.',
 eligibleCounts:Object.fromEntries(modes.map(mode=>[mode,eligible[mode].length])),
 completeTriples:pairCount,matchedTriples,
 averages:Object.fromEntries(modes.map(mode=>[mode,{
  testsPassed:mean(eligible[mode].slice(0,pairCount),'passed'),
  toolCalls:mean(eligible[mode].slice(0,pairCount),'calls'),
  retrievalCalls:mean(eligible[mode].slice(0,pairCount),'retrievalCalls'),
  seconds:mean(eligible[mode].slice(0,pairCount),'seconds'),
  completeTasks:eligible[mode].slice(0,pairCount).filter(x=>x.completeTask).length,
 }])),
 invalid:reports.filter(x=>!x.valid).map(x=>({filename:x.filename,reason:x.reason})),
};
const output=path.join(resultRoot,'score-adaptive-context-20261123.json');
await writeFile(output,JSON.stringify(summary,null,2));
console.log(JSON.stringify({output,referenceSolutionPass:summary.referenceSolutionPass,completeTriples:pairCount,
 counts:summary.eligibleCounts,averages:summary.averages,triples:matchedTriples.map((triple,i)=>({trial:i+1,results:Object.fromEntries(modes.map(mode=>[mode,{
  passed:triple[mode].passed,calls:triple[mode].calls,seconds:triple[mode].seconds,
  retrieval:triple[mode].retrievalCalls,archive:triple[mode].archivedArtifacts,
 }]))})),excluded:summary.invalid}));
if(!summary.referenceSolutionPass)process.exitCode=1;
