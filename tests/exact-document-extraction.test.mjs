import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {exactDocumentTextRequest,selectExactDocumentSource,extractOriginalDocumentText} from '../lib/exact-document-extraction.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const entry={id:'file_'+'a'.repeat(32),name:'Candidate_Resume.pdf',kind:'pdf',pageCount:2,sha256:'a'.repeat(64)};
const other={id:'file_'+'b'.repeat(32),name:'Other_Report.pdf',kind:'pdf',pageCount:1,sha256:'b'.repeat(64)};
const base={id:'root',taskId:'root',input:'Analyze the resume as employer.',attachmentIds:[entry.id]};
const follow={id:'follow',taskId:'root',parentRunId:'root',input:'send me the text of the resume',attachmentIds:[]};
const getRun=id=>id==='root'?base:null;
const metadata={get:async id=>id===entry.id?entry:other};

test('pure original-source extraction is distinct from analysis and external send',()=>{
  for(const input of ['send me the text of the resume','Extract the full text from the attached PDF.','Show me the original text of Candidate_Resume.pdf','Transcribe the document verbatim.','Give me the resume text.']){
    assert.ok(exactDocumentTextRequest(input),input);
  }
  for(const input of ['Analyze the resume as employer.','Give me a summary of the resume.','Send the resume to the employer.','Email me the text of the resume.','Give me the text of the resume and then analyze it.','Extract the key points from the resume.','Show me the text of C:\\other\\resume.pdf']){
    assert.equal(exactDocumentTextRequest(input),null,input);
  }
});
test('explicit follow-up retrieves only the matching original in its own conversation',async()=>{
  const request=exactDocumentTextRequest(follow.input);
  const selected=await selectExactDocumentSource({request,run:follow,getRun,store:metadata});
  assert.equal(selected.sourceRunId,'root');assert.equal(selected.entry.id,entry.id);
  const out=await selectExactDocumentSource({request,run:{...follow,taskId:'foreign'},getRun,store:metadata});
  assert.equal(out,null);
  const different=await selectExactDocumentSource({request,run:{...follow,attachmentIds:[other.id]},getRun,store:metadata});
  assert.match(different.unavailable,/No current attachment/);
  const second={...entry,id:'file_'+'c'.repeat(32),sha256:'c'.repeat(64)};
  const ambiguous=await selectExactDocumentSource({request,run:{...follow,attachmentIds:[entry.id,second.id]},getRun,store:{get:async id=>id===entry.id?entry:second}});
  assert.match(ambiguous.unavailable,/More than one/);
});
test('extraction stitches exact pages and cursor fragments; no model paraphrase is possible',async()=>{
  const source=['A real opening.\r\nSecond line.','Later evidence: the candidate audited 20 experts.'];
  const seen=[];
  const store={read:async(id,opts)=>{
    assert.equal(id,entry.id);seen.push([opts.startPage,opts.startChar]);
    if(opts.startPage===1&&opts.startChar===0)return {attachment:entry,totalPages:2,pages:[{page:1,startChar:0,text:source[0].slice(0,5),totalChars:source[0].length,nextChar:5,textAvailable:true}],nextPage:1,nextChar:5};
    return {attachment:entry,totalPages:2,pages:[{page:1,startChar:5,text:source[0].slice(5),totalChars:source[0].length,nextChar:null,textAvailable:true},{page:2,startChar:0,text:source[1],totalChars:source[1].length,nextChar:null,textAvailable:true}],nextPage:null,nextChar:null};
  }};
  const r=await extractOriginalDocumentText({selection:{entry,sourceRunId:'root'},store});
  assert.deepEqual(seen,[[1,0],[1,5]]);assert.equal(r.receipt.complete,true);assert.equal(r.receipt.modelUsed,false);
  assert.deepEqual(r.receipt.parts.map(p=>p.sha256),source.map(hash));
  assert.ok(source.every(p=>r.output.includes(p)));assert.match(r.output,/no summary or OCR/);
});
test('mismatched source or invalid cursor cannot claim extracted content',async()=>{
  const selection={entry,sourceRunId:'root'};
  await assert.rejects(extractOriginalDocumentText({selection,store:{read:async()=>({attachment:other,totalPages:2,pages:[]})}}),/did not match/);
  const r=await extractOriginalDocumentText({selection,store:{read:async()=>({attachment:entry,totalPages:2,pages:[{page:1,startChar:0,text:'',totalChars:0,nextChar:null,textAvailable:false},{page:2,startChar:0,text:'later',totalChars:5,nextChar:null,textAvailable:true}],nextPage:null,nextChar:null})}});
  assert.equal(r.receipt.complete,false);assert.deepEqual(r.receipt.emptyTextPages,[1]);assert.match(r.output,/partial/);assert.match(r.output,/later/);
});
