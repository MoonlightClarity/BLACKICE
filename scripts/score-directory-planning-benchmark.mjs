// Independent whole-task scoreboard for Planning × Directory experimental arms.
// Never treats model transport or partial tests as full task success.
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
const options=Object.fromEntries(process.argv.slice(2).map(arg=>{
  const [name,...value]=arg.replace(/^--/,'').split('=');
  return[name,value.join('=')];
}));
const folder=path.resolve(options.root||path.join(path.dirname(process.cwd()),'BLACKICE-context-benchmark-results-20261123'));
const arms=['planning-directory','planning-only','directory-only','neither'];
const files=(await readdir(folder,{withFileTypes:true})).filter(f=>f.isFile()&&f.name.endsWith('.json'));
const trials=[];
for(const file of files){
  let row;
  try{row=JSON.parse(await readFile(path.join(folder,file.name),'utf8'));}catch{continue;}
  if(!arms.includes(row.arm)||!row.model||!row.testId||!row.variant)continue;
  if(options.model&&row.model!==options.model||options.case&&row.testId!==options.case)continue;
  trials.push({...row,report:file.name});
}
const groups=new Map();
for(const row of trials){
  const hash=[row.variant,row.testId,row.model,row.harnessEngineSha256,row.workspaceToolSha256,row.benchmarkFixtureSha256].join('|');
  if(!groups.has(hash))groups.set(hash,{source:{variant:row.variant,case:row.testId,model:row.model,
    engineSha256:row.harnessEngineSha256,workspaceSha256:row.workspaceToolSha256,fixtureSha256:row.benchmarkFixtureSha256},rows:[]});
  groups.get(hash).rows.push(row);
}
const summaries=[];
for(const group of groups.values()){
  const report={source:group.source,arms:{}};
  for(const arm of arms){
    const rows=group.rows.filter(row=>row.arm===arm).sort((a,b)=>String(a.startedAt).localeCompare(String(b.startedAt)));
    const valid=rows.filter(row=>row.trialValid===true&&[0,1].includes(row.hiddenGrade?.exitCode));
    report.arms[arm]={
      attempts:rows.length,valid:valid.length,invalid:rows.filter(row=>!valid.includes(row))
        .map(row=>({report:row.report,reason:row.infraError||row.runError||'unspecified-invalid-trial'})),
      fullSuccesses:valid.filter(row=>row.runStatus==='completed'&&row.codingCorrect===true&&row.hiddenGrade?.exitCode===0).length,
      codeOnlyPasses:valid.filter(row=>row.codingCorrect===true&&row.hiddenGrade?.exitCode===0).length,
      attemptsDetailed:valid.map(row=>({report:row.report,status:row.runStatus,hidden:row.hiddenGrade.exitCode,
        completed:row.workflowCompleted,fullSuccess:row.runStatus==='completed'&&row.codingCorrect===true&&row.hiddenGrade.exitCode===0,
        toolCalls:row.toolCalls?.length,planningStages:row.planningStages||[],
        receiptCount:row.directoryFinal?.receiptCount,focus:row.directoryFinal?.focus,
        directoryIncomplete:row.directoryIncomplete??null})),
    };
  }
  report.sameSourceFourArmComparisonReady=arms.every(arm=>report.arms[arm].valid>0);
  report.claim=report.sameSourceFourArmComparisonReady
    ? 'Descriptive comparison only. Matched source and task, but stochastic task success requires repeated independent samples.'
    : 'Incomplete arm coverage. Do not claim a benefit or loss for the combined system.';
  summaries.push(report);
}
console.log(JSON.stringify({version:1,analysis:'Planning+Directory factorial benchmark; whole-task success is complete agent workflow AND all hidden tests.',
  validCount:trials.filter(r=>r.trialValid===true).length,trialsTotal:trials.length,
  groups:summaries},null,2));
