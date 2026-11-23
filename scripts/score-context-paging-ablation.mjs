// Score exact same-harness paging-on/off native-model coding trials.
// No model calls; results are reconstructed from immutable saved reports.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const reportRoot=process.env.BLACKICE_BENCH_REPORT_DIR||path.join(path.dirname(sourceRoot),'BLACKICE-context-benchmark-results-20261123');
const model=process.argv.find(x=>x.startsWith('--model='))?.slice(8)||'gpt-6-luna';
const digest=async relative=>createHash('sha256').update(await readFile(path.join(sourceRoot,relative))).digest('hex');
const srcHash={
 engine:await digest('lib/engine.mjs'),
 workspace:await digest('lib/workspace-tools.mjs'),
 context:await digest('lib/task-external-context.mjs'),
 fixture:await digest('scripts/benchmark-fixture-event-replay.mjs'),
 driver:await digest('scripts/benchmark-directory-live.mjs'),
};
const files=(await readdir(reportRoot)).filter(name=>
 /^event-replay-candidate-no-dir-(?:no-paging-)?[a-f0-9]+\.json$/.test(name));
const infra=/\b429\b|\b401\b|\b502\b|\b503\b|quota|rate.?limit|timeout|provider.*unavailable|context overflow|output limit|sign up for free|come back later|CODEX_RUNTIME|CAPABILITY_SCOPE_UNAVAILABLE|HOST_ONLY_TRANSPORT/i;
const rows=[];
for(const name of files){
 const r=JSON.parse(await readFile(path.join(reportRoot,name),'utf8'));
 if(r.model!==model||r.variant!=='candidate'||r.directoryMode!=='off'||!['on','off'].includes(r.pagingMode))continue;
 const eligibleSource=r.harnessEngineSha256===srcHash.engine &&
  r.workspaceToolSha256===srcHash.workspace &&
  r.contextImplementationSha256===srcHash.context &&
  r.benchmarkFixtureSha256===srcHash.fixture;
 const output=String(r.hiddenGrade?.output||'');
 const tests=Number(/# tests (\d+)/.exec(output)?.[1]||0);
 const passed=Number(/# pass (\d+)/.exec(output)?.[1]||0);
 const error=String(r.infraError||r.runError||'');
 const valid=eligibleSource&&['completed','failed'].includes(r.runStatus)&&
   !r.infraError&&!infra.test(error)&&tests===21&&Array.isArray(r.toolCalls)&&r.toolCalls.length>0;
 rows.push({name,paging:r.pagingMode,sourceMatched:eligibleSource,valid,
  invalidReason:valid?null:(!eligibleSource?'Different implementation source':error||'Incomplete valid tool or grading evidence'),
  runStatus:r.runStatus,startedAt:r.startedAt,passed,total:tests,toolCalls:r.toolCalls?.length||0,
  retrievalCalls:(r.toolCalls||[]).filter(x=>x.name==='relay_context_page').length,
  seconds:Math.round((Date.parse(r.finishedAt)-Date.parse(r.startedAt))/100)/10,
  archives:r.externalArtifactCount||0,completeTask:r.runStatus==='completed'&&passed===21,
  failedChecks:[...output.matchAll(/^not ok \d+ - ([^\r\n]+)/gm)].map(x=>x[1]),
 });
}
const off=rows.filter(x=>x.valid&&x.paging==='off').sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
const on=rows.filter(x=>x.valid&&x.paging==='on').sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
const count=Math.min(off.length,on.length);
const pairs=Array.from({length:count},(_,i)=>({pair:i+1,off:off[i],on:on[i]}));
const mean=(arr,key)=>arr.length?Math.round(arr.reduce((sum,row)=>sum+row[key],0)/arr.length*10)/10:null;
const gold=spawnSync(process.execPath,[path.join(sourceRoot,'scripts','benchmark-directory-live.mjs'),'--case=event-replay','--verify-gold','--directory=off'],{
 cwd:sourceRoot,encoding:'utf8',timeout:30000,
});
const result={
 model,case:'event-replay',directoryMode:'off',sourceHashes:srcHash,referenceSolutionPass:gold.status===0,
 method:'Exact same Engine, fixture, model and tool settings; paging is the only intentional runtime toggle. Pair chronological eligible trials. Score full task success only when all 21 acceptance tests pass and workflow completes. Earlier source revisions and infrastructure-invalid attempts are excluded.',
 matchedPairs:pairs,
 summary:{
  matchedPairCount:count,unmatchedOff:off.length-count,unmatchedOn:on.length-count,
  fullSuccess:{off:off.slice(0,count).filter(x=>x.completeTask).length,on:on.slice(0,count).filter(x=>x.completeTask).length},
  meanTestsPassed:{off:mean(off.slice(0,count),'passed'),on:mean(on.slice(0,count),'passed')},
  meanCalls:{off:mean(off.slice(0,count),'toolCalls'),on:mean(on.slice(0,count),'toolCalls')},
  meanSeconds:{off:mean(off.slice(0,count),'seconds'),on:mean(on.slice(0,count),'seconds')},
 },
 excluded:rows.filter(x=>!x.valid).map(x=>({name:x.name,reason:x.invalidReason})),
 generatedAt:new Date().toISOString(),
};
const output=path.join(reportRoot,'score-context-paging-ablation-20261123.json');
await writeFile(output,JSON.stringify(result,null,2));
console.log(JSON.stringify({file:output,referenceSolutionPass:result.referenceSolutionPass,summary:result.summary,
 pairs:pairs.map(row=>({pair:row.pair,off:{tests:row.off.passed+'/21',calls:row.off.toolCalls,seconds:row.off.seconds,full:row.off.completeTask},
 on:{tests:row.on.passed+'/21',calls:row.on.toolCalls,seconds:row.on.seconds,full:row.on.completeTask,retrievalCalls:row.on.retrievalCalls}})),
 excluded:result.excluded}));
if(!result.referenceSolutionPass)process.exitCode=1;
