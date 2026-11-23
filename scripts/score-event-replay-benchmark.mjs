// Repeatable score of hard event-replay coding trials, excluding infrastructure failures.
import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const branch=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder=process.env.BLACKICE_BENCH_REPORT_DIR||path.join(path.dirname(branch),'BLACKICE-context-benchmark-results-20261123');
const model=process.argv.find(x=>x.startsWith('--model='))?.slice(8)||'gpt-6-luna';
const hash=async file=>createHash('sha256').update(await readFile(path.join(branch,file))).digest('hex');
const expected={engine:await hash('lib/engine.mjs'),workspace:await hash('lib/workspace-tools.mjs'),context:await hash('lib/task-external-context.mjs'),fixture:await hash('scripts/benchmark-fixture-event-replay.mjs')};
const files=(await readdir(folder)).filter(name=>/^event-replay-(candidate|control)-[a-f0-9]+\.json$/.test(name));
const reports=[];
const infra=/\b429\b|\b401\b|\b502\b|\b503\b|quota|rate.?limit|timeout|provider.*unavailable|context overflow|output limit|sign up for free|come back later|CODEX_RUNTIME|CAPABILITY_SCOPE_UNAVAILABLE|HOST_ONLY_TRANSPORT/i;
for(const file of files){
 const report=JSON.parse(await readFile(path.join(folder,file),'utf8'));
 if(report.model!==model)continue;
 const stdout=String(report.hiddenGrade?.output||'');
 const tests=Number(/# tests (\d+)/.exec(stdout)?.[1]||0);
 const passed=Number(/# pass (\d+)/.exec(stdout)?.[1]||0);
 const error=String(report.infraError||report.runError||'');
 const valid=['completed','failed'].includes(report.runStatus)&&Array.isArray(report.toolCalls)&&report.toolCalls.length>0
  &&tests===21&&!report.infraError&&!infra.test(error)&&Number.isInteger(report.hiddenGrade?.exitCode);
 const sourceCurrent=report.variant==='candidate' && report.contextPolicy==='source-continuation-v3'
  &&report.contextImplementationSha256===expected.context&&report.harnessEngineSha256===expected.engine
  &&report.workspaceToolSha256===expected.workspace&&report.benchmarkFixtureSha256===expected.fixture;
 reports.push({
  file,model,variant:report.variant,contextPolicy:report.contextPolicy||'unknown',sourceCurrent,valid,
  invalidReason:valid?null:(error||'No source-reliable code grade'),
  startedAt:report.startedAt,runStatus:report.runStatus,runError:report.runError||null,
  toolCalls:report.toolCalls.length,archiveFiles:report.externalArtifactCount??0,
  seconds:Math.round((Date.parse(report.finishedAt)-Date.parse(report.startedAt))/100)/10,
  tests,passed,failed:tests-passed,codeCorrect:valid&&passed===21&&report.hiddenGrade.exitCode===0,
  workflowComplete:valid&&report.runStatus==='completed',
  fullSuccess:valid&&passed===21&&report.hiddenGrade.exitCode===0&&report.runStatus==='completed',
  failedChecks:[...[...stdout.matchAll(/^not ok \d+ - ([^\r\n]+)/gm)].map(x=>x[1])],
  actions:(report.directoryRecords||[]).map(row=>({id:row.id,state:row.state})),
  toolErrors:(report.toolCalls||[]).filter(row=>row.success===false||row.threw).map(row=>({name:row.name,action:row.action,code:row.code||row.threw||null})),
 });
}
const current=reports.filter(row=>row.valid&&row.sourceCurrent).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
const control=reports.filter(row=>row.valid&&row.variant==='control').sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
const pairCount=Math.min(current.length,control.length);
const pairings=Array.from({length:pairCount},(_,i)=>({candidate:current[i],control:control[i]}));
const gold=spawnSync(process.execPath,[path.join(branch,'scripts','benchmark-directory-live.mjs'),'--case=event-replay','--verify-gold'],{cwd:branch,encoding:'utf8',timeout:30000});
const summary={model,referenceSolutionPass:gold.status===0,expectedSha256:expected,sourceComparisons:reports,
 currentCandidateCount:current.length,controlCount:control.length,pairCount,
 pairs:pairings.map(pair=>({
  candidate:{file:pair.candidate.file,passed:pair.candidate.passed,full:pair.candidate.fullSuccess,workflow:pair.candidate.workflowComplete,calls:pair.candidate.toolCalls,seconds:pair.candidate.seconds},
  control:{file:pair.control.file,passed:pair.control.passed,full:pair.control.fullSuccess,workflow:pair.control.workflowComplete,calls:pair.control.toolCalls,seconds:pair.control.seconds},
 })),
 claims:{'currentCandidateFullySolved':current.filter(x=>x.fullSuccess).length,'controlFullySolved':control.filter(x=>x.fullSuccess).length,
  conclusion:'Small stochastic samples do not demonstrate a general advantage; fully correct means all 21 tests and a completed agent workflow.'},
 at:new Date().toISOString(),
};
const dest=path.join(folder,'score-event-replay-benchmark-20261123.json');
await writeFile(dest,JSON.stringify(summary,null,2));
console.log(JSON.stringify({file:dest,referenceSolutionPass:summary.referenceSolutionPass,pairCount,currentCandidateCount:current.length,controlCount:control.length,
 recentCandidate:current.at(-1)&&{file:current.at(-1).file,passed:current.at(-1).passed,workflow:current.at(-1).workflowComplete,full:current.at(-1).fullSuccess},
 recentControl:control.at(-1)&&{file:control.at(-1).file,passed:control.at(-1).passed,workflow:control.at(-1).workflowComplete,full:control.at(-1).fullSuccess},
 pairs:summary.pairs,invalid:reports.filter(x=>!x.valid).length}));
if(!summary.referenceSolutionPass)process.exitCode=1;
