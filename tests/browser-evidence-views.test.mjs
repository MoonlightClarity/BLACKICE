import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEvidenceStore} from '../lib/evidence-context.mjs';
import {reviewModularOutcome,createModularCompletionController} from '../lib/modular-completion.mjs';
const page=()=>({tabId:'tab-A',url:'https://employer.example/jobs',documentId:'tab-A:2',
 frames:[{frame:'top',text:'Full-time remote. Salary $90,000. No submission yet.',truncated:false,
 elements:Array.from({length:500},(_,i)=>({ref:'element-'+i,name:'Control '+i,value:'value '+i,href:'https://employer.example/job/'+i})),
 forms:[{action:'/apply',fields:['resume']}],semanticRecords:[{text:'Application incomplete'}]}],
 tabs:[{id:'other-tab',url:'https://other.example/'}],ownershipCandidates:[{id:'stopped',status:'stopped'}],
 hint:'Use observed references',error:null});
const row=(value=page())=>({id:'call-1',source:'host-dispatch-receipt',tool:'relay_browser',action:'read',success:true,result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]}});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'browser-evidence-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,store:createEvidenceStore({root})};}
test('browser review decomposes exact controls/catalogs without dropping text, forms, errors or original bytes',async t=>{
 const {store}=await fixture(t),original=row(),source=await store.save(original);
 const projected=await store.project(original,{sourceFile:source.file,sectionBrowserReceipts:true});
 const view=projected.value.result.contentItems[0],value=view.value;
 assert.equal(view.type,'projectedInputText');
 assert.equal(await fs.readFile(source.file,'utf8'),JSON.stringify(original));
 assert.equal(JSON.parse(await fs.readFile(view.originalText.file,'utf8')),original.result.contentItems[0].text);
 assert.deepEqual(value.frames[0].forms,page().frames[0].forms);
 assert.deepEqual(value.frames[0].semanticRecords,page().frames[0].semanticRecords);
 assert.equal(value.frames[0].text,page().frames[0].text);assert.equal(value.frames[0].truncated,false);assert.equal(value.error,null);
 for(const [descriptor,expected]of [[value.frames[0].elements,page().frames[0].elements],[value.tabs,page().tabs],[value.ownershipCandidates,page().ownershipCandidates]]){
   assert.deepEqual(JSON.parse(await fs.readFile(descriptor.file,'utf8')),expected);
   assert.match(descriptor.meaning,/NOT been inspected/);
   const first=await store.handle({action:'read',ref:descriptor.ref,limit:200},{tokenBudget:20000});
   const firstPage=JSON.parse(first.contentItems[0].text);assert.equal(firstPage.offset,0);
   if(firstPage.nextOffset!==null){const next=await store.handle({action:'read',ref:descriptor.ref,offset:firstPage.nextOffset,limit:200},{tokenBudget:20000});assert.equal(JSON.parse(next.contentItems[0].text).offset,firstPage.nextOffset);}
 }
 assert.ok(JSON.stringify(projected.value).length<JSON.stringify(original).length/3);
});
test('browser section views are opt-in; arbitrary JSON/tool text remains unchanged',async t=>{
 const {store}=await fixture(t),original=row();
 assert.deepEqual((await store.project(original)).value,original);
 const nonBrowser={...original,tool:'relay_files'};
 assert.deepEqual((await store.project(nonBrowser,{sectionBrowserReceipts:true})).value,nonBrowser);
 const malformed=row();malformed.result.contentItems[0].text='This is not JSON';
 assert.deepEqual((await store.project(malformed,{sectionBrowserReceipts:true})).value,malformed);
});
test('exact repeated sections share refs; changed control data gets distinct saved bytes',async t=>{
 const {store}=await fixture(t),a=row(),b={...row(),id:'call-2',action:'snapshot'},c=row();c.id='call-3';
 const parsed=JSON.parse(c.result.contentItems[0].text);parsed.frames[0].elements[0].value='changed';c.result.contentItems[0].text=JSON.stringify(parsed);
 const result=await store.project([a,b,c],{sectionBrowserReceipts:true});
 assert.equal(result.duplicateRefs.length,1);
 const first=result.value[0].result.contentItems[0].value.frames[0].elements;
 const changed=result.value[2].result.contentItems[0].value.frames[0].elements;
 assert.notEqual(first.ref,changed.ref);assert.notEqual(first.sha256,changed.sha256);
 assert.equal(result.value[1].id,'call-2');assert.equal(result.value[1].action,'snapshot');
});
test('reviewer can inspect exact section with normal evidence provenance, not a task effect',async t=>{
 const {root}=await fixture(t);
 const records=Array.from({length:8},(_,i)=>({...row(),id:'call-'+i}));
 records.push({id:'large-other',tool:'relay_files',result:'unrelated retained source '.repeat(16000)});
 const snapshot={request:{id:'user-request',text:'Check control value.'},policy:{version:2,modules:{anti_overalignment:true}},evidence:{auditRoot:root,records}};
 let toolCalls=0;
 const runtime={status:()=>({models:[{id:'fixture',contextWindowTokens:258400}]}),async runAgent(options){
   const packet=JSON.parse(options.prompt.split('\n\n').find(x=>x.startsWith('{"snapshot":')));
   const record=packet.snapshot.evidence.records[0];
   assert.equal(packet.snapshot.savedReview.mode,'indexed-exact-sources');assert.equal(record.result,undefined);
   let view=record.result?.contentItems?.[0];
   if(!view){const r=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:record.savedSource.ref}});view=JSON.parse(JSON.parse(r.contentItems[0].text).text).result.contentItems[0];}
   assert.equal(view.type,'projectedInputText');
   const response=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:view.value.frames[0].elements.ref,limit:500}});toolCalls++;
   assert.equal(response.success,true);assert.match(response.contentItems[0].text,/value 0/);
   return {output:JSON.stringify({decision:'respond',summary:'Observed value 0 in saved control.',remaining:[],nextAction:'',evidenceRefs:['evidence-0002'],metadataOnlyRefs:[],blockers:[]})};
 }};
 const controller=createModularCompletionController({policy:snapshot.policy,getSnapshot:()=>snapshot,review:args=>reviewModularOutcome({cwd:root,model:'fixture',runtime,...args})});
 assert.equal(await controller.beforeFinal({output:'Observed value 0.'}),null);assert.equal(toolCalls,1);
 const accepted=await controller.assertReady();
 assert.ok(accepted.assessment.evidenceInspection.reads.some(x=>x.field==='browser-section'&&x.evidenceIds.includes('call-1')));
 assert.deepEqual(accepted.assessment.evidenceRefs,['call-1']);
});
