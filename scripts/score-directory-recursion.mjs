// Score a same-model, same-task recursive-Directory vs predecessor comparison.
// A real model must invoke decompose for a trial to count as recursion-exposed.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const candidateRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const baselineRoot=process.env.BLACKICE_BENCH_CONTROL_ROOT||
 path.join(path.dirname(candidateRoot),'BLACKICE-ordinary-chat-benchmark-20261123');
const resultsRoot=process.env.BLACKICE_BENCH_REPORT_DIR||
 path.join(path.dirname(candidateRoot),'BLACKICE-context-benchmark-results-20261123');
const model=process.argv.find(x=>x.startsWith('--model='))?.slice(8)||'gpt-6-luna';
const hash=async(root,relative)=>createHash('sha256').update(await readFile(path.join(root,relative))).digest('hex');
const files={
 directory:'lib/task-action-directory.mjs',
 engine:'lib/engine.mjs',
 workspace:'lib/workspace-tools.mjs',
 context:'lib/task-external-context.mjs',
};
const sources=Object.fromEntries(await Promise.all(['candidate','control'].map(async variant=>{
 const root=variant==='candidate'?candidateRoot:baselineRoot;
 const digests=Object.fromEntries(await Promise.all(Object.entries(files).map(async([name,file])=>[name,await hash(root,file)])));
 return [variant,{root,digests}];
})));
const expected={
 driver:await hash(candidateRoot,'scripts/benchmark-directory-live.mjs'),
 workflow:await hash(candidateRoot,'scripts/benchmark-chat-workflow.mjs'),
 codeFixture:await hash(candidateRoot,'scripts/benchmark-fixture-event-replay.mjs'),
 longEvidenceFixture:await hash(candidateRoot,'scripts/benchmark-fixture-long-evidence.mjs'),
};
const infrastructure=/\b429\b|\b401\b|\b402\b|\b502\b|\b503\b|quota|rate.?limit|timeout|provider.*unavailable|context overflow|output limit|sign up for free|come back later|CODEX_RUNTIME|HOST_ONLY_TRANSPORT|CAPABILITY_SCOPE_UNAVAILABLE|CHAT_OUTCOME_AUTHORITY_UNAVAILABLE|CHAT_OUTCOME_EVIDENCE_INCOMPLETE/i;
const filenames=(await readdir(resultsRoot)).filter(name=>
 /^event-replay-long-(?:candidate|control)-adaptive-ordinary-chat-[a-f0-9]+\.json$/.test(name));
const rows=[];
for(const filename of filenames){
 const r=JSON.parse(await readFile(path.join(resultsRoot,filename),'utf8'));
 if(r.model!==model||r.directoryMode!=='on'||r.workflowKind!=='ordinary-chat'||
  r.testId!=='event-replay-long'||r.pagingMode!=='adaptive'||!['candidate','control'].includes(r.variant))continue;
 const source=sources[r.variant],matches=r.sourceRoot===source.root&&
  r.directoryImplementationSha256===source.digests.directory&&
  r.harnessEngineSha256===source.digests.engine&&
  r.workspaceToolSha256===source.digests.workspace&&
  r.benchmarkDriverSha256===expected.driver&&
  r.benchmarkWorkflowSha256===expected.workflow&&
  r.benchmarkFixtureSha256===expected.codeFixture&&
  r.longEvidenceFixtureSha256===expected.longEvidence;
 const modelReviewer=r.graphIdentity?.recognizedAsOrdinaryChat===true&&Array.isArray(r.finalReviewCalls)&&r.finalReviewCalls.length>0;
 const grade=String(r.hiddenGrade?.output||''),cases=Number(/# tests (\d+)/.exec(grade)?.[1]||0),
  passes=Number(/# pass (\d+)/.exec(grade)?.[1]||0);
 const sourceLoadFailure=cases>0&&cases<21&&r.hiddenGrade?.exitCode!==0&&
  /SyntaxError:|ERR_MODULE_NOT_FOUND|Cannot find module/i.test(grade)&&/[\\/]challenge[\\/]src[\\/]/i.test(grade);
 const error=String(r.infraError||r.runError||'');
 const valid=matches&&modelReviewer&&!r.infraError&&!infrastructure.test(error)
  &&['completed','failed'].includes(r.runStatus)&&r.toolCalls?.length>0&&
  (cases===21||sourceLoadFailure)&&Number.isInteger(r.hiddenGrade?.exitCode);
 const passed=cases===21?passes:sourceLoadFailure?0:passes;
 const recursion=r.recursivePlanning||{};
 rows.push({
  filename,variant:r.variant,valid,
  invalidReason:valid?null:(!matches?'Nonmatching benchmark, fixture or exact source revision':!modelReviewer?'Ordinary-Chat outcome reviewer was not observed':error||'Invalid evidence or grading'),
  startedAt:r.startedAt,runStatus:r.runStatus,runError:r.runError||null,
  codeChecksPassed:passed,expectedChecks:21,observedTestCases:cases,
  workflowCompleted:valid&&r.runStatus==='completed',
  fullTaskSuccess:valid&&r.runStatus==='completed'&&passed===21&&r.hiddenGrade.exitCode===0,
  toolCalls:r.toolCalls.length,
  planCalls:r.toolCalls.filter(call=>call.name==='relay_directory_action'&&call.action==='plan').length,
  decomposeAttempts:recursion.attempted||0,decomposeAccepted:recursion.accepted||0,
  recursiveDepth:recursion.deepestAction||0,
  nestedParents:recursion.parents||0,
  completedParents:recursion.completedParents||[],
  parentWorkOutstanding:recursion.activeParents||[],
  timesReviewerContinued:r.finalReviewCalls.filter(x=>x.continued).length,
  durationSeconds:Math.round((Date.parse(r.finishedAt)-Date.parse(r.startedAt))/100)/10,
  originalToolOutputBytes:r.contextPressure?.originalEligibleReadBytes||0,
  modelVisibleToolOutputBytes:r.contextPressure?.modelVisibleEligibleReadBytes||0,
  archivedToolResults:r.contextPressure?.archivedToolResults||0,
  retrievedContextPages:r.contextPressure?.retrievalCalls||0,
  evidenceShards:r.contextPressure?.traceShardsReferenced||[],
  sourceLoadFailure,
  missedChecks:[...grade.matchAll(/^not ok \d+ - ([^\r\n]+)/gm)].map(x=>x[1]),
 });
}
const eligible=Object.fromEntries(['control','candidate'].map(variant=>[variant,rows.filter(row=>row.valid&&row.variant===variant).sort((a,b)=>a.startedAt.localeCompare(b.startedAt))]));
const count=Math.min(eligible.control.length,eligible.candidate.length);
const pairs=Array.from({length:count},(_,i)=>({control:eligible.control[i],candidate:eligible.candidate[i]}));
const mean=(arr,key)=>arr.length?Math.round(arr.reduce((sum,row)=>sum+(row[key]||0),0)/arr.length*10)/10:null;
const gold=spawnSync(process.execPath,[path.join(candidateRoot,'scripts','benchmark-directory-live.mjs'),
 '--case=event-replay-long','--verify-gold','--directory=on','--paging=adaptive','--workflow=ordinary-chat'],
 {cwd:candidateRoot,encoding:'utf8',timeout:30000,env:{...process.env,NODE_TEST_CONTEXT:''}});
const summary={
 generatedAt:new Date().toISOString(),model,case:'event-replay-long',directoryMode:'on',workflow:'ordinary-chat',
 sources,expected,referenceSolutionPass:gold.status===0,
 methodology:'Identical coding fixture, workflow, native model and paging policy. Candidate adds recursive Directory; control is its immediate predecessor. All provider/benchmark-invalid runs excluded. Success requires all 21 checks and a completed workflow. Recursion exposure means at least one accepted decompose tool call. Stochastic samples cannot establish a general effect.',
 matchedPairs:count,pairs,recursionExposedPairs:pairs.filter(pair=>pair.candidate.decomposeAccepted>0).length,
 outcomes:Object.fromEntries(['control','candidate'].map(variant=>[variant,{
  completeTasks:eligible[variant].slice(0,count).filter(row=>row.fullTaskSuccess).length,
  meanChecksPassed:mean(eligible[variant].slice(0,count),'codeChecksPassed'),
  meanCalls:mean(eligible[variant].slice(0,count),'toolCalls'),
  meanSeconds:mean(eligible[variant].slice(0,count),'durationSeconds'),
  meanRecursiveDepth:mean(eligible[variant].slice(0,count),'recursiveDepth'),
 }])),
 invalid:rows.filter(row=>!row.valid).map(row=>({filename:row.filename,reason:row.invalidReason})),
};
const output=path.join(resultsRoot,'score-directory-recursion-20261123.json');
await writeFile(output,JSON.stringify(summary,null,2));
console.log(JSON.stringify({output,goldPassed:summary.referenceSolutionPass,matchedPairs:count,recursionExposedPairs:summary.recursionExposedPairs,
 outcomes:summary.outcomes,pairs:pairs.map((pair,i)=>({pair:i+1,control:{checks:pair.control.codeChecksPassed,calls:pair.control.toolCalls,seconds:pair.control.durationSeconds,full:pair.control.fullTaskSuccess},candidate:{checks:pair.candidate.codeChecksPassed,calls:pair.candidate.toolCalls,seconds:pair.candidate.durationSeconds,depth:pair.candidate.recursiveDepth,decompositions:pair.candidate.decomposeAccepted,full:pair.candidate.fullTaskSuccess}})),invalid:summary.invalid}));
if(!summary.referenceSolutionPass)process.exitCode=1;
