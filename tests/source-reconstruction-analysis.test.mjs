import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sourceInspectionUnits,validateOutline,validateTree,validateInitial,validateChallenge,runSourceReconstructionAnalysis,hasSourceReconstructionProtocol,acceptsStagedSourceAnalysis,sourceAnalysisSchemas,hostLayoutOutline,outlineSummaryGroups} from '../lib/source-reconstruction-analysis.mjs';
import {strictProviderSchema,compatibleWireOutputSchema} from '../lib/provider-output-schema.mjs';

const entry={id:'file_'+'a'.repeat(32),name:'fixture.pdf',kind:'pdf',sha256:'a'.repeat(64),pageCount:2,coverage:'complete'};
const original=['EXPERIENCE\r\nGroup A\r\n\u2022 Reviewed 20 experts; \r\nidentified weak conclusions.\r\nRepository: https://example.test/a','EDUCATION\r\nDegree\r\nGPA 4.0'];
const grounding={inventory:[entry],records:[{id:'host-document:'+entry.id,success:true,result:{contentItems:[{text:JSON.stringify({attachment:entry,complete:true,pages:original.map((text,i)=>({page:i+1,text}))})}]}}]};
const source=sourceInspectionUnits(grounding);
const row=(id,parent,summary='Neutral source content',fn='Structural role')=>({id,parent,summary,function:fn});
const validOutline=[row(1,0,'Experience heading','Section'),row(2,1,'Group A','Role heading'),row(3,2,'The reviewer assessed 20 experts and identified weak conclusions','Responsibility'),row(4,2,'Repository link','Supporting reference'),row(5,0,'Education heading','Section'),row(6,5,'Degree','Qualification'),row(7,6,'4.0 GPA','Reported grade')];
const claim=(claim,basis,refs,reasoning='Compare actual source',assumptions='Source is not independently corroborated')=>({claim,basis,refs,reasoning,assumptions});
const initial=[claim('No repository is documented','not-established',[],'Initial claim to be challenged','An untested assumption')];
const challenge={review:[{id:1,challenge:'The source explicitly links a repository; the initial absence claim is contradicted.',counterRefs:[4],disposition:'revise',revised:claim('A repository link is provided; its contents and adoption are not independently checked.','source-assertion',[4])}],additional:[claim('The reviewer, not the reviewed experts, identified weak conclusions.','source-assertion',[3])]};
test('source units use exact spans and preserve PDF page and line identity, not generated quotes',()=>{
 assert.equal(source.units.length,7);
 for(const u of source.units)assert.equal(u.text,original[u.page-1].slice(u.start,u.end));
 assert.equal(source.units[2].text,'\u2022 Reviewed 20 experts; \r\nidentified weak conclusions.');
 assert.equal(source.units[2].firstLine,3);assert.equal(source.units[2].lastLine,4);
 assert.equal(source.sources[0].parts[0].sha256,createHash('sha256').update(original[0]).digest('hex'));
 assert.equal(sourceInspectionUnits({...grounding,inventory:[{...entry,coverage:'partial'}]}),null);
 const foreign=structuredClone(grounding);const body=JSON.parse(foreign.records[0].result.contentItems[0].text);body.attachment.sha256='b'.repeat(64);foreign.records[0].result.contentItems[0].text=JSON.stringify(body);
 assert.equal(sourceInspectionUnits(foreign),null);
});
test('actual unit relationships and identity are checked; missing or invented references cannot replace source coverage',()=>{
 const ids=source.units.map(u=>u.id);
 assert.deepEqual(validateTree(validateOutline({outline:validOutline},ids,source.units),source.units),validOutline);
 assert.throws(()=>validateOutline({outline:validOutline.slice(0,-1)},ids,source.units),/each assigned source unit/);
 const invented=structuredClone(validOutline);invented[2].id=999;assert.throws(()=>validateOutline({outline:invented},ids,source.units));
 const flat=validOutline.map(r=>({...r,parent:0}));assert.throws(()=>validateTree(flat,source.units),/subordinate bullet/);
 const crossing=structuredClone(validOutline);crossing[6].parent=2;assert.throws(()=>validateTree(crossing,source.units),/closed branch/);
 assert.throws(()=>validateInitial({claims:[claim('invented fact','source-assertion',[999])]},source.units));
 assert.throws(()=>validateInitial({claims:[claim('invented fact','source-assertion',[])]},source.units));
 assert.throws(()=>validateChallenge({...challenge,review:[]},initial,source.units));
});
test('real staged execution reconstructs before summary, only then sees the evaluator question; challenge has original source reversed',async()=>{
 const calls=[],updates=[];
 const actualTask='Analyze as employer: a unique evaluation lens.';
 const invoke=async phase=>{
  calls.push(phase);
  assert.equal(strictProviderSchema(phase.outputSchema),true);assert.ok(compatibleWireOutputSchema(phase.outputSchema));
  phase.onAccepted();
  let value;
  if(phase.kind==='reverse-outline'){assert.doesNotMatch(phase.prompt,/unique evaluation lens/);value={outline:validOutline};}
  else if(phase.kind==='neutral-summary'){assert.doesNotMatch(phase.prompt,/unique evaluation lens/);assert.match(phase.prompt,/Group A/);value={summary:[{text:'The document records experience reviewing experts, a repository, and education.',refs:[1,2,3,4,5,6,7]}],corrections:[row(3,2,'The reviewer, not the reviewed experts, identified weak conclusions','Responsibility')]};}
  else if(phase.kind==='initial-assessment'){assert.match(phase.prompt,/NEUTRAL SUMMARY/);assert.match(phase.prompt,/unique evaluation lens/);value={claims:initial};}
  else if(phase.kind==='challenge'){assert.match(phase.prompt,/ACTUAL SOURCE TEXT \(reverse order\)/);assert.ok(phase.prompt.indexOf('"id":7')<phase.prompt.indexOf('"id":1'));assert.match(phase.prompt,/No repository is documented/);value=challenge;}
  else if(phase.kind==='synthesis'){assert.match(phase.prompt,/FINAL ANALYSIS FOR USER/);value={answer:'The source provides a real repository link. The existence of adoption metrics is not established, so a reviewer should inspect shipped work rather than assume no project exists.',sourceRefs:[4,3]};}
  else assert.fail(phase.kind);
  return {output:JSON.stringify(value),threadId:'phase-'+phase.kind,usage:{totalTokens:100}};
 };
 const result=await runSourceReconstructionAnalysis({grounding,input:actualTask,invoke,onUpdate:r=>updates.push(r)});
 assert.deepEqual(calls.map(x=>x.kind),['reverse-outline','neutral-summary','initial-assessment','challenge','synthesis']);
 assert.equal(result.receipt.status,'stages-returned');assert.equal(result.receipt.semanticVerification,'not-established');
 assert.ok(result.receipt.phases.every(p=>p.delivery==='accepted-provider-request'&&p.status==='artifact-returned'));
 assert.doesNotMatch(result.output,/\n    - \*\*U3/);assert.match(result.receipt.outline[2].summary,/The reviewer, not the reviewed experts/);
 assert.ok(result.output.length<1200);
 assert.doesNotMatch(result.output,/## Neutral source summary/);
 assert.match(result.output,/real repository link/);
 assert.match(result.receipt.source.units[3].text,/Repository: https:\/\/example.test\/a/);
 assert.doesNotMatch(result.output,/No repository is documented/);
 assert.equal(updates[0].status,'running');
});
test('a shallow selected-points response is not promoted to a completed reverse outline or generic evaluation',async()=>{
 const calls=[];
 const result=await runSourceReconstructionAnalysis({grounding,input:'Analyze the document',invoke:async phase=>{calls.push(phase.kind);return {output:JSON.stringify({outline:[row(1,0,'A few highlights')]})}}});
 assert.equal(result.receipt.status,'partial');assert.deepEqual(calls,['reverse-outline','reverse-outline']);
 assert.match(result.output,/analysis did not finish/);
 assert.match(result.receipt.source.units[3].text,/Repository: https:\/\/example.test\/a/);assert.doesNotMatch(result.output,/## Initial assessment/);
});
test('protocol uses effective skill declaration and avoids mixed-action and explicit shorter tasks',()=>{
 assert.equal(hasSourceReconstructionProtocol({content:'---\nanalysis_protocol: source-reconstruction-v1\n---\n# Any title'}),true);
 assert.equal(hasSourceReconstructionProtocol({content:'# Example\nanalysis_protocol: source-reconstruction-v1'}),false);
 assert.equal(acceptsStagedSourceAnalysis('Analyze this resume and submit it.',{}),false);
 assert.equal(acceptsStagedSourceAnalysis('Analyze this report online.',{}),false);
 assert.equal(acceptsStagedSourceAnalysis('Analyze the document.',{explicitShort:true}),false);
 assert.equal(acceptsStagedSourceAnalysis('Review this code for bugs.',{}),true);
});


const layoutPages=['EXPERIENCE\r\nCompany A \u2014 Role\r\n2025 | Contract\r\n\u2022 Performed specific work.\r\nRepository: https://example.test/a','EDUCATION\r\nCollege A\r\nDegree | 2024\r\n3.92 GPA'];
const layoutGrounding=structuredClone(grounding);
const layoutRecord=JSON.parse(layoutGrounding.records[0].result.contentItems[0].text);
layoutRecord.pages=layoutPages.map((text,i)=>{
 let start=0;
 const layout=text.split('\r\n').map((line,j)=>{
 const weight=(i===0?j<3:j<2)?900:400;
 const span={start,end:start+line.length,line:j+1,fontWeight:weight,fontSize:10.6,uniform:true};
 start+=line.length+2;return span;
 });
 return {page:i+1,text,layout};
});
layoutGrounding.records[0].result.contentItems[0].text=JSON.stringify(layoutRecord);
test('matched source layout retains literal branches, including numeric grades under their actual institution',()=>{
 const src=sourceInspectionUnits(layoutGrounding);
 assert.ok(src.units.every(u=>u.style?.uniform));
 const outline=hostLayoutOutline(src);
 assert.ok(outline);
 assert.deepEqual(outline.map(r=>r.parent),[0,1,2,2,2,0,6,7,7]);
 assert.deepEqual(outlineSummaryGroups(outline,src).flatMap(g=>g.units.map(u=>u.id)),src.units.map(u=>u.id));
});
