// Score matched native ChatGPT/Codex trials without merging invalid harness attempts.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const candidateRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const resultsRoot=process.env.BLACKICE_BENCH_REPORT_DIR||path.join(path.dirname(candidateRoot),'BLACKICE-context-benchmark-results-20261123');
const model=process.argv.find(x=>x.startsWith('--model='))?.slice(8)||'gpt-6-luna';
const expectedFingerprint=createHash('sha256').update(await readFile(path.join(candidateRoot,'lib','task-external-context.mjs'))).digest('hex');
const providerFailure=/\b429\b|\b401\b|\b502\b|\b503\b|quota|rate.?limit|provider.?timeout|network|does not exist|output limit|context overflow|sign up for free|come back later|wait before trying again|CODEX_CAPABILITY_SCOPE|HOST_ONLY_TRANSPORT|CODEX_RUNTIME/i;
const reports=[];
for(const file of (await readdir(resultsRoot)).filter(name=>/^(async-cache|stream-scheduler)-(candidate|control)-[a-f0-9]+\.json$/.test(name))){
 const raw=JSON.parse(await readFile(path.join(resultsRoot,file),'utf8'));
 if(raw.model!==model)continue;
 const phase=raw.contextPolicy||'pre-fix';
 const testOutput=String(raw.hiddenGrade?.output||'');
 const cases=Number(/# tests (\d+)/.exec(testOutput)?.[1]||0);
 const passed=Number(/# pass (\d+)/.exec(testOutput)?.[1]||0);
 const error=String(raw.infraError||raw.runError||'');
 const baseline=raw.variant==='control'&&phase==='unmodified-2.40.75';
 const candidate=raw.variant==='candidate'&&phase==='structured-head-tail-v2'&&raw.contextImplementationSha256===expectedFingerprint;
 const valid=(baseline||candidate)&&!raw.infraError&&
  ['completed','failed'].includes(raw.runStatus)&&Array.isArray(raw.toolCalls)&&raw.toolCalls.length>0&&
  !providerFailure.test(error)&&cases>0&&Number.isInteger(raw.hiddenGrade?.exitCode);
 const codingCorrect=valid&&passed===cases&&raw.hiddenGrade.exitCode===0;
 const completed=valid&&raw.runStatus==='completed';
 reports.push({
  file,case:raw.testId,variant:raw.variant,phase,valid,
  invalidReason:valid?null:(!baseline&&!candidate?'Different experiment version; excluded from post-fix comparison':error||'Missing valid grading or tool evidence'),
  implementationFingerprint:raw.contextImplementationSha256||null,
  startedAt:raw.startedAt,
  toolCalls:raw.toolCalls?.length||0,seconds:Math.round((Date.parse(raw.finishedAt||raw.startedAt)-Date.parse(raw.startedAt))/100)/10,
  contextArtifacts:raw.externalArtifactCount??0,
  passedTests:passed,totalTests:cases,codingCorrect,workflowCompleted:completed,
  completeTask:completed&&codingCorrect,runStatus:raw.runStatus,
 });
}
const cases=['async-cache','stream-scheduler'];
const gold={};
for(const caseId of cases){
 const process=spawnSync(processExec(),[path.join(candidateRoot,'scripts','benchmark-directory-live.mjs'),'--case='+caseId,'--verify-gold'],{cwd:candidateRoot,encoding:'utf8',timeout:30000});
 gold[caseId]={pass:process.status===0,exitCode:process.status};
}
function processExec(){return process.execPath;}
const paired=[];
for(const caseId of cases){
 const rows={};
 for(const variant of ['control','candidate'])rows[variant]=reports.filter(r=>r.valid&&r.case===caseId&&r.variant===variant).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
 const count=Math.min(rows.control.length,rows.candidate.length);
 paired.push({case:caseId,gold:gold[caseId].pass,pairs:Array.from({length:count},(_,index)=>({control:rows.control[index],candidate:rows.candidate[index]})),
  unmatched:{control:rows.control.length-count,candidate:rows.candidate.length-count}});
}
const allPairs=paired.flatMap(group=>group.gold?group.pairs:[]);
const summary={
  method:'Every valid complete trial for the exact selected candidate SHA is retained; pair variants by chronological ordinal per task. Provider and benchmark-driver failures are excluded, never scored. Code correctness is separate from Directory/workflow completion.',
  model,candidateFingerprint:expectedFingerprint,referenceSolutions:gold,
  matchedPairs:allPairs.length,unmatched:paired.map(row=>({case:row.case,...row.unmatched})),
  fullTaskSuccess:{control:allPairs.filter(x=>x.control.completeTask).length,candidate:allPairs.filter(x=>x.candidate.completeTask).length},
  codingSuccess:{control:allPairs.filter(x=>x.control.codingCorrect).length,candidate:allPairs.filter(x=>x.candidate.codingCorrect).length},
  workflowCompleted:{control:allPairs.filter(x=>x.control.workflowCompleted).length,candidate:allPairs.filter(x=>x.candidate.workflowCompleted).length},
  paired,
  excluded:reports.filter(r=>!r.valid).map(r=>({file:r.file,phase:r.phase,reason:r.invalidReason?.slice(0,200)})),
  generatedAt:new Date().toISOString(),
};
const output=path.join(resultsRoot,'score-directory-context-native-v2.json');
await writeFile(output,JSON.stringify(summary,null,2));
console.log(JSON.stringify({output,model,candidateFingerprint:expectedFingerprint.slice(0,12),matchedPairs:summary.matchedPairs,code:summary.codingSuccess,workflow:summary.workflowCompleted,full:summary.fullTaskSuccess,unmatched:summary.unmatched,details:summary.paired.map(p=>({case:p.case,pairs:p.pairs.map(x=>({control:x.control.passedTests+'/'+x.control.totalTests,candidate:x.candidate.passedTests+'/'+x.candidate.totalTests,controlStatus:x.control.runStatus,candidateStatus:x.candidate.runStatus}))})),excluded:summary.excluded.map(r=>({file:r.file,reason:r.reason?.slice(0,80)}))}));
if(!Object.values(gold).every(v=>v.pass))process.exitCode=1;
