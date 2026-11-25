import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDocumentSource,documentSourceRefs,documentSourcePerspective,documentPerspectiveWarning} from '../lib/document-source-grounding.mjs';
import {createChatExecutionReview} from '../lib/chat-execution-review.mjs';
import {assessRecordedOutcome,modularOutcomeReferenceIndex} from '../lib/modular-completion.mjs';
import {ordinaryOutcomePrompt} from '../lib/chat-outcome-review.mjs';
import {documentAnalysisContract} from '../lib/document-analysis-policy.mjs';

const input='Analyze the following resume as employer.';
const entry={id:'file_'+'1'.repeat(32),name:'Candidate.pdf',kind:'pdf',sha256:'a'.repeat(64),pageCount:2};
const page=(page,text)=>({page,startChar:0,text,totalChars:text.length,nextChar:null,textAvailable:Boolean(text.trim())});
const actual={attachment:entry,format:'pdf',totalPages:2,pages:[page(1,'Designed the data pipeline with Python and reduced processing time by 30 percent.'),page(2,'Quality assurance experience and a degree in mathematics.')],nextPage:null,nextChar:null};
const contract=documentAnalysisContract({task:input,attachments:[entry]});
const prepare=(body=actual)=>prepareDocumentSource({store:{read:async()=>body},entries:[entry],contract,input});
const bad="The resume as an employer's profile for Candidate contains the core employer details.\n- **Purpose**: Employer profile";
const good='As a hiring reviewer, I would value the Python pipeline work and investigate the reported 30 percent processing improvement.';
const response=(refs,basis='observed-results')=>({decision:'respond',summary:good,remaining:[],nextAction:'',blockers:[],evidenceRefs:refs,supportBasis:basis});
test('preload actual immutable source text, distinguish reviewer and subject, preserve complete/partial coverage',async()=>{
 const g=await prepare();assert.equal(g.perspective,'employer-reviewer');assert.equal(g.inventory[0].coverage,'complete');assert.match(g.prompt,/Python and reduced processing time by 30 percent/);assert.match(g.prompt,/subject remains the candidate/);assert.equal(g.records.length,1);assert.equal(g.records[0].source,'host-attachment-content');assert.equal(documentSourceRefs(g.records,g.inventory).length,1);
 const incomplete=await prepare({...actual,pages:[actual.pages[0]],nextPage:2,nextChar:0});assert.equal(incomplete.inventory[0].coverage,'partial');
 const empty=await prepare({...actual,pages:[page(1,''),page(2,'')]});assert.equal(empty.records.length,0);assert.equal(empty.inventory[0].coverage,'not-preloaded');
 const foreign=await prepare({...actual,attachment:{...entry,sha256:'b'.repeat(64)}});assert.equal(foreign.records.length,0);
 assert.equal(documentSourcePerspective('Analyze this resume.',contract),null);assert.equal(documentPerspectiveWarning(g.perspective,bad),true);assert.equal(documentPerspectiveWarning(g.perspective,good),false);
});
test('prepared source is not credited before exact prompt acceptance; unread document triggers one recovery and cannot complete',async()=>{
 const g=await prepare();let assessments=0;
 const review=createChatExecutionReview({input,documentGrounding:g,assessOutcome:async()=>{assessments++;return response(['user-request','candidate']);}});
 const continuation=review.beforeFinal({output:bad});assert.equal(continuation.continue,true);assert.match(continuation.prompt,/filename, page count or failed call/);assert.match(continuation.prompt,new RegExp(entry.id));assert.equal(assessments,0);
 assert.throws(()=>review.beforeFinal({output:bad}),{code:'CHAT_DOCUMENT_SOURCE_UNREAD'});assert.equal(assessments,0);
});
test('accepted source is real review evidence, role-inversion draft gets explicit correction',async()=>{
 const g=await prepare();let seen;
 const review=createChatExecutionReview({input,documentGrounding:g,assessOutcome:async request=>{seen=request;return response(request.documentSource.sourceRefs);}});
 review.acceptDocumentSource();review.acceptDocumentSource();
 assert.equal(review.evidenceSnapshot().evidence.records.length,1);
 assert.equal(review.evidenceSnapshot().documentSource.sourceRefs.length,1);
 const correction=review.beforeFinal({output:bad});assert.match(correction.prompt,/hiring-side reviewer/);
 assert.equal(review.beforeFinal({output:good}).continue,true);
 assert.equal(await review.beforeFinal({output:good}),null);assert.ok(seen.documentSource.sourceRefs.length);assert.match(seen.evidence.records[0].result.contentItems[0].text,/Python/);
});
test('only actual content from the exact attachment counts, not failed calls, inventory, or foreign content',async()=>{
 const g=await prepare();const body=JSON.stringify(actual);
 const row={id:'read',source:'admitted-tool-delivery',namespace:'',tool:'relay_files',action:'read',success:true,result:{contentItems:[{type:'inputText',text:body}]}};
 assert.deepEqual(documentSourceRefs([row],g.inventory),['read']);
 for(const badRow of [{...row,success:false},{...row,action:'list'},{...row,result:{contentItems:[{type:'inputText',text:JSON.stringify({attachment:entry})}]}},{...row,result:{contentItems:[{type:'inputText',text:JSON.stringify({...actual,attachment:{...entry,id:'foreign'}})}]}}])
 assert.deepEqual(documentSourceRefs([badRow],g.inventory),[]);
});
test('reviewer cannot accept request/candidate-only or incidental metadata when source analysis is requested',async()=>{
 const g=await prepare();const snapshot={request:input,directions:[],policy:{},scope:{kind:'ordinary-chat',documentSource:{kind:'attached-document-analysis',inventory:g.inventory,perspective:g.perspective,sourceRefs:g.records.map(r=>r.id)},pendingEffects:[]},evidence:{records:[...g.records,{id:'incidental',callId:'incidental',source:'admitted-tool-delivery',tool:'relay_files',action:'list',success:true,result:{contentItems:[{type:'inputText',text:'[]'}]}}]}};
 const refs=modularOutcomeReferenceIndex(snapshot);
 let attempts=0,repairs=[];
 const assessed=await assessRecordedOutcome({snapshot,candidate:{output:good},review:async({repair})=>{
   attempts++;if(repair)repairs.push(repair);
   if(attempts===1)return response(['user-request','candidate'],'request-and-candidate-only');
   if(attempts===2)return response([refs[1].citationRef]);
   return response([refs[0].citationRef]);
 }});
 assert.equal(attempts,3);assert.equal(assessed.record.decision,'respond');assert.equal(assessed.record.evidenceRefs[0],g.records[0].id);assert.ok(repairs.every(r=>r.missingDocumentCitation));
 const denied=await assessRecordedOutcome({snapshot,candidate:{output:bad},review:async()=>response(['user-request','candidate'],'request-and-candidate-only')});
 assert.equal(denied.unavailable,true);
 const prompt=ordinaryOutcomePrompt(snapshot,{output:bad},null,{strictRequiredOutput:true});assert.match(prompt,/DOCUMENT SOURCE CHECK/);assert.match(prompt,/HOST WARNING/);assert.match(prompt,/Python/);
});
