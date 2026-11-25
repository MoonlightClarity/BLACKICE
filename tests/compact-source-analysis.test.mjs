import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceInspectionUnits,hostLayoutOutline,compactSourceAnalysisEligible,runCompactSourceAnalysis} from '../lib/source-reconstruction-analysis.mjs';
import {resolveSourceAnalysisIntent} from '../lib/source-analysis-intent.mjs';

const entry={id:'file_'+'b'.repeat(32),name:'candidate-resume.pdf',kind:'pdf',sha256:'b'.repeat(64),pageCount:2,coverage:'complete'};
const pages=[
'EXPERIENCE\r\nResearch Group — Analyst\r\n2025 | Remote | Contract\r\n• Evaluated expert work and found unsupported reasoning.\r\nRepository: https://example.test/project',
'EDUCATION\r\nState University\r\nB.A.S., Administration | 2023\r\nGPA 3.92'
];
const grounding={
 inventory:[entry],
 records:[{id:'host-document:'+entry.id,success:true,result:{contentItems:[{text:JSON.stringify({attachment:entry,complete:true,pages:pages.map((p,i)=>({page:i+1,text:p,layout:(()=>{let offset=0;return p.split('\r\n').map((line,j)=>{const start=offset;offset+=line.length+2;return {line:j+1,start,end:start+line.length,fontWeight:(i===0?j<=1:j<=1)?900:400,fontSize:10.6,uniform:true};})})()}))})}]}}]
};
const initialInput='Analyze the following resume as employer';
const intent=resolveSourceAnalysisIntent({input:initialInput,documentType:'resume'});
test('a small complete source is eligible, and detailed working or larger sources are not',()=>{
 const src=sourceInspectionUnits(grounding);
 assert.ok(src.withinBudget);
 assert.ok(hostLayoutOutline(src));
 assert.equal(compactSourceAnalysisEligible(src,intent),true);
 assert.equal(compactSourceAnalysisEligible(src,resolveSourceAnalysisIntent({input:'Analyze the resume. Show the complete reverse outline',documentType:'resume'})),false);
 assert.equal(compactSourceAnalysisEligible({...src,units:[{...src.units[0],text:'A'.repeat(8001)}]},intent),false);
 assert.equal(compactSourceAnalysisEligible({...src,sources:[...src.sources,{...src.sources[0],index:2}]},intent),false);
 const partial=structuredClone(grounding);partial.inventory[0].coverage='partial';
 assert.equal(sourceInspectionUnits(partial),null);
});
test('compact source analysis preserves real source layout and returns one direct model answer, not schema theater',async()=>{
 const calls=[],changes=[];
 const result=await runCompactSourceAnalysis({grounding,input:initialInput,intent,invoke:async phase=>{
  calls.push(phase);phase.onAccepted();
  assert.equal(phase.kind,'direct-source-analysis');
  assert.equal(phase.outputSchema,undefined);
  assert.match(phase.prompt,/Source subject: candidate described in the résumé/);
  assert.match(phase.prompt,/Repository: https:\/\/example.test\/project/);
  assert.match(phase.prompt,/B.A.S., Administration/);
  const actualPage=JSON.parse(grounding.records[0].result.contentItems[0].text).pages[0].text;
  assert.ok(phase.prompt.includes(actualPage),'the model must receive exact original page text, including line breaks');
  assert.doesNotMatch(phase.prompt,/NEUTRAL SUMMARY \(model interpretation\)/);
  return {output:'The source describes evaluating expert work; an interview should examine actual review quality. The linked repository is source evidence of a project, not independent proof of its quality.',threadId:'provider_direct_mock',usage:{totalTokens:58}};
 },onUpdate:r=>changes.push(r.status)});
 assert.equal(calls.length,1);
 assert.equal(result.receipt.status,'response-returned');
 assert.equal(result.receipt.executionStyle,'compact-complete-source');
 assert.equal(result.receipt.outline.length,sourceInspectionUnits(grounding).units.length);
 assert.equal(result.receipt.outlineOrigin,'observed-source-layout');
 assert.equal(result.receipt.semanticVerification,'not-established');
 assert.equal(result.receipt.claimReview.semanticVerification,'not-established');
 assert.equal(result.receipt.phases.filter(p=>p.kind==='direct-source-analysis').length,1);
 assert.equal(result.receipt.phases.at(-1).delivery,'accepted-provider-request');
 assert.ok(result.output.length<1000);
 assert.doesNotMatch(result.output,/## Reverse outline|Source: page/);
 assert.equal(changes.at(-1),'response-returned');
});
test('a short follow-up inherits the actual source and original reviewer role without rerunning model summaries',async()=>{
 const first=await runCompactSourceAnalysis({grounding,input:initialInput,intent,invoke:async()=>({output:'Initial analysis of evidence.'})});
 const nextInput='analyze it';
 const nextIntent=resolveSourceAnalysisIntent({input:nextInput,documentType:'resume',previous:intent});
 const kinds=[];
 const next=await runCompactSourceAnalysis({grounding,input:nextInput,intent:nextIntent,previous:{...first.receipt,sourceRunId:'first-run'},invoke:async phase=>{
  kinds.push(phase.kind);assert.match(phase.prompt,/Original user request: "Analyze the following resume as employer"/);
  assert.match(phase.prompt,/PRIOR ANSWER \(fallible, not original source\)/);
  assert.match(phase.prompt,/Initial analysis of evidence/);
  assert.match(phase.prompt,/CONTINUE THE UNFINISHED ANALYTICAL OBJECTIVE/);
  return {output:'The work suggests evidence evaluation; project impact remains unverified.'};
 }});
 assert.equal(next.receipt.reusedSourceRunId,'first-run');
 assert.equal(next.receipt.intent.perspective.label,'hiring-side reviewer');
 assert.deepEqual(kinds,['direct-source-analysis']);
});
test('an empty direct answer is retried once, not recorded as analysis',async()=>{
 let count=0;
 const r=await runCompactSourceAnalysis({grounding,input:initialInput,intent,invoke:async()=>({output:++count===1?'  ':'An analysis of source work and its uncertain outcome.'})});
 assert.equal(count,2);assert.equal(r.receipt.status,'response-returned');
 assert.deepEqual(r.receipt.phases.filter(p=>p.kind==='direct-source-analysis').map(p=>p.status),['failed','artifact-returned']);
 const z=await runCompactSourceAnalysis({grounding,input:initialInput,intent,invoke:async()=>({output:' '})});
 assert.equal(z.receipt.status,'partial');assert.equal(z.receipt.semanticVerification,'not-established');
 assert.doesNotMatch(z.output,/Analysis complete/i);
});
