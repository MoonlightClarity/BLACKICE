// Reconcile infrastructure failures before scoring model task outcomes.
import {readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const resultsDir=process.env.BLACKICE_BENCH_REPORT_DIR||path.join(path.dirname(root),'BLACKICE-context-benchmark-results-20261123');
const model='kilo_free::nvidia/nemotron-3.5-lightning:free';
const cases=['async-cache','stream-scheduler'];
const infrastructureFailure=/rate limit|429\b|401\b|402\b|502\b|503\b|quota|provider.timeout|network|does not exist|unsupported model|context overflow|output limit|sign up for free|come back later|wait before trying again|free to continue|no credit card required|connection failed|socket hang up|DIRECTORY_CAPACITY|DIRECTORY_CORRUPT|CONTEXT_ARCHIVE_CORRUPT|CONTEXT_ARCHIVE_UNAVAILABLE|TASK_CONTRACT_INCOMPLETE/i;
const files=(await readdir(resultsDir)).filter(x=>/^(async-cache|stream-scheduler)-(candidate|control)-[a-z0-9]+\.json$/.test(x));
const reports=[];
for(const file of files){
 const raw=JSON.parse(await readFile(path.join(resultsDir,file),'utf8'));
 const error=String(raw.infraError||raw.runError||'');
 const valid=Boolean(['completed','failed'].includes(raw.runStatus)&&
  Array.isArray(raw.toolCalls)&&raw.toolCalls.length>=2&&!raw.infraError&&!infrastructureFailure.test(error)&&
  Number.isInteger(raw.hiddenGrade?.exitCode));
 const output=String(raw.hiddenGrade?.output||'');
 const tests=Number(/# tests (\d+)/.exec(output)?.[1]||0);
 const passed=Number(/# pass (\d+)/.exec(output)?.[1]||0);
 reports.push({
  file,variant:raw.variant,case:raw.testId,model:raw.model,valid,
  invalidReason:valid?null:error||'Insufficient execution or missing grading evidence',
  rawValidityClaim:raw.trialValid,
  taskPassed:valid&&raw.runStatus==='completed'&&raw.hiddenGrade.exitCode===0,
  tests,passed,toolCalls:raw.toolCalls?.length||0,
  seconds:Math.round((Date.parse(raw.finishedAt||raw.startedAt)-Date.parse(raw.startedAt))/100)/10,
  contextArtifacts:raw.externalArtifactCount||0,startedAt:raw.startedAt,
 });
}
const gold={};
for(const task of cases){
 const proc=spawnSync(process.execPath,[path.join(root,'scripts','benchmark-directory-live.mjs'),'--case='+task,'--verify-gold'],{
  cwd:root,encoding:'utf8',timeout:30000,
 });
 const records=String(proc.stdout||'').trim().split(/\r?\n/);
 let result;
 try{result=JSON.parse(records.at(-1)||'{}');}catch{}
 gold[task]={pass:proc.status===0&&result?.goldExitCode===0,exitCode:proc.status};
}
const paired=[];
for(const task of cases){
 const selected={};
 for(const variant of ['control','candidate']){
  selected[variant]=reports.filter(r=>r.valid&&r.case===task&&r.variant===variant&&r.model===model)
   .sort((a,b)=>a.startedAt.localeCompare(b.startedAt))[0]||null;
 }
 paired.push({task,goldPass:gold[task].pass,pairValid:Boolean(gold[task].pass&&selected.control&&selected.candidate),
  control:selected.control,candidate:selected.candidate});
}
let stress;
try{stress=JSON.parse(await readFile(path.join(resultsDir,'offline-longhorizon-stress.json'),'utf8'));}
catch{}
const score={
 generatedAt:new Date().toISOString(),
 methodology:'First eligible completed/failed model trial per variant and task after excluding pre-tool, provider, quota, and grader errors. Task success requires an agent-completed run and every acceptance test passing. Invalid trials are never counted as failures or wins.',
 model, sourceRevisions:{control:'3fc873c8394fb8381456c305cd91068ce9b98eac',candidate:'b49913517b409338cfe93ce0d450a710c34949d3'},
 gold,paired,
 eligiblePairs:paired.filter(x=>x.pairValid).length,
 wins:{control:paired.filter(x=>x.pairValid&&x.control.taskPassed).length,candidate:paired.filter(x=>x.pairValid&&x.candidate.taskPassed).length},
 invalidTrials:reports.filter(x=>!x.valid),
 stress:stress?.results?.map(r=>({variant:r.variant,pass:r.pass,readCount:r.readCount,toolCalls:r.callSequence,modelFacingBytes:r.readTextBytes,receiptCount:r.receipts,archiveFiles:r.archiveFiles||0})),
};
const save=path.join(resultsDir,'score-directory-context-20261123.json');
await writeFile(save,JSON.stringify(score,null,2));
console.log(JSON.stringify({save,validPairs:score.eligiblePairs,gold,winCounts:score.wins,
 paired:paired.map(x=>({task:x.task,pairValid:x.pairValid,control:x.control&&{tests:x.control.passed+'/'+x.control.tests,calls:x.control.toolCalls,seconds:x.control.seconds,taskPassed:x.control.taskPassed},candidate:x.candidate&&{tests:x.candidate.passed+'/'+x.candidate.tests,calls:x.candidate.toolCalls,seconds:x.candidate.seconds,taskPassed:x.candidate.taskPassed}})),
 excluded:score.invalidTrials.map(x=>({file:x.file,reason:x.invalidReason?.slice(0,180)})),stress:score.stress}));
if(!Object.values(gold).every(x=>x.pass)||score.stress?.some(x=>!x.pass))process.exitCode=1;
