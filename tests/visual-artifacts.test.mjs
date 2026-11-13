import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VisualArtifacts,visualTool,nativeVisualTools,handleVisualHttp} from '../lib/visual-artifacts.mjs';
import {compileVisual,visualSvgUrl,VISUAL_EXAMPLE} from '../public/visual-document.mjs';

async function fixture(t){const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-visual-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const options={dataDir,assertConversation:async id=>{assert.equal(id,'conversation');}};return {store:new VisualArtifacts(options),options};}
const create={action:'create',conversationId:'conversation',requestId:'create-1',document:VISUAL_EXAMPLE};
test('semantic output escapes content, preserves uncertainty and exports an exact text equivalent',()=>{
 const document=structuredClone(VISUAL_EXAMPLE);document.items[0].label='<script>猫 & evidence</script>';const result=compileVisual(document);
 assert.ok(visualSvgUrl(result.svg));assert.ok(result.svg.includes('&lt;script&gt;'));assert.match(result.text,/uncertain/);assert.match(result.text,/Missing:/);assert.deepEqual(result.document,document);
});
test('untrusted SVG profile rejects executable content, recursive resources and excessive geometry',()=>{
 const svg=body=>`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${body}</svg>`;
 for(const body of ['<script/>','<foreignObject/>','<rect onload="x"/>','<use href="#x"/>','<filter/>','<pattern/>','<image href="https://x"/>','<rect fill="url(#x)"/>','<rect style="fill:red"/>','<rect width="1e99"/>','<rect/>'.repeat(500)])assert.equal(visualSvgUrl(svg(body)),null,body.slice(0,70));
 assert.equal(visualSvgUrl(svg('<text>&bad;</text>')),null);assert.ok(visualSvgUrl(svg('<text x="2" y="20">A &amp; B</text>')));
});
test('invalid relationships and oversized compositions fail before saving',()=>{
 const doc=structuredClone(VISUAL_EXAMPLE);doc.links[0].from='missing';assert.throws(()=>compileVisual(doc),/endpoints/);doc.links=[];doc.items[0].x=Infinity;assert.throws(()=>compileVisual(doc),/finite/);
});
test('durable create/revise/restart, idempotency and exact historical export',async t=>{
 const {store,options}=await fixture(t);const first=await store.execute(create);assert.deepEqual(await store.execute(create),first);
 const document=structuredClone(VISUAL_EXAMPLE);document.items[0].label='User corrected observation';const revised=await store.execute({action:'revise',conversationId:'conversation',artifactId:first.id,expectedRevision:1,requestId:'edit-1',document});assert.equal(revised.revision,2);
 const restarted=new VisualArtifacts(options),old=await restarted.execute({action:'export',conversationId:'conversation',artifactId:first.id,revision:1}),latest=await restarted.read({conversationId:'conversation',artifactId:first.id});
 assert.equal(old.document.items[0].label,VISUAL_EXAMPLE.items[0].label);assert.equal(latest.document.items[0].label,'User corrected observation');assert.equal(latest.currentRevision,2);assert.deepEqual(await restarted.execute(create),first);
 await assert.rejects(()=>restarted.execute({...create,document}),{code:'VISUAL_REQUEST_CONFLICT'});
});
test('concurrent edits preserve one winner, stale writers cannot overwrite user content',async t=>{
 const {store}=await fixture(t);const first=await store.execute(create),args={action:'revise',conversationId:'conversation',artifactId:first.id,expectedRevision:1,document:VISUAL_EXAMPLE};const results=await Promise.allSettled([store.execute({...args,requestId:'a'}),store.execute({...args,requestId:'b'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'VISUAL_REVISION_CONFLICT');
});
test('cancellation and invalid custom source preserve the last good artifact',async t=>{
 const {store}=await fixture(t);const first=await store.execute(create),args={action:'revise',conversationId:'conversation',artifactId:first.id,expectedRevision:1,requestId:'bad',document:{version:1,kind:'custom',title:'Bad',summary:'Unsafe',svg:'<script/>'}};
 await assert.rejects(()=>store.execute(args));await assert.rejects(()=>store.execute({...create,requestId:'cancelled'},{signal:AbortSignal.abort()}));assert.equal((await store.read({conversationId:'conversation',artifactId:first.id})).revision,1);
});
test('native and direct adapters share artifacts, scope, read-only protection and no worker',async t=>{
 const {store}=await fixture(t);const native=await nativeVisualTools(store)({taskId:'conversation',runId:'run',canWrite:true});const result=await native.handle({name:'relay_visual',arguments:{...create,conversationId:undefined}}).catch(e=>e);assert.equal(result.code,'VISUAL_INVALID');
 const {conversationId,...args}=create;const created=JSON.parse((await native.handle({name:'relay_visual',arguments:args})).contentItems[0].text);
 const direct=visualTool(store);const read=JSON.parse((await direct.execute({action:'read',conversationId,artifactId:created.id},{client:{id:'client'}})).contentItems[0].text);assert.equal(read.actor,'agent:run');
 await assert.rejects(()=>direct.execute(create,{client:{id:'readonly',scopes:['read']}}),{code:'VISUAL_SCOPE'});
 const allowed=await direct.execute({...create,requestId:'direct-create'},{client:{id:'writer',scopes:['read','files:write']}});assert.equal(allowed.success,true);
 const readonly=await nativeVisualTools(store)({taskId:'conversation',runId:'read',canWrite:false});await assert.rejects(()=>readonly.handle({name:'relay_visual',arguments:args}),{code:'VISUAL_READ_ONLY'});await assert.rejects(()=>direct.execute({action:'list',conversationId}),{code:'VISUAL_SCOPE'});
});
test('HTTP edits reject unknown fields and return persisted preferences without model calls',async t=>{
 const {store}=await fixture(t),mutations=new Set(),responses=[];const context={res:{},pathname:'/api/conversations/conversation/visuals',store,mutations,json:(_res,status,data)=>responses.push({status,data})};
 await handleVisualHttp({...context,req:{method:'POST'},body:async()=>({action:'preferences',automatic:true,requestId:'prefs'})});assert.equal(responses[0].data.automatic,true);assert.equal(mutations.size,0);
 await handleVisualHttp({...context,req:{method:'GET',url:context.pathname}});assert.equal(responses[1].data.automatic,true);
 await assert.rejects(()=>handleVisualHttp({...context,req:{method:'POST'},body:async()=>({...create,other:true})}));
});

test('tampered exports and damaged journals fail closed without replacing saved files',async t=>{
 const {store,options}=await fixture(t);const first=await store.execute(create),file=path.join(options.dataDir,'visual-artifacts','conversation.json'),state=JSON.parse(await readFile(file,'utf8'));state.artifacts[0].revisions[0].svg='<script>bad</script>';await writeFile(file,JSON.stringify(state));await assert.rejects(()=>store.execute({action:'export',conversationId:'conversation',artifactId:first.id}),{code:'VISUAL_DAMAGED'});await writeFile(file,'{}');await assert.rejects(()=>store.execute({...create,requestId:'cannot-replace'}),{code:'VISUAL_DAMAGED'});assert.equal(await readFile(file,'utf8'),'{}');
});

test('Unicode, grids and custom static SVG round trip; clipping and forged preferences are rejected',async t=>{
 const document={version:1,kind:'composed',title:'比較',summary:'Inspect exact evidence.',width:900,height:500,grid:{columns:['Claim','Evidence'],rows:[['🧊'.repeat(22),'Unknown\nNeeds an observation']]}};assert.ok(visualSvgUrl(compileVisual(document).svg));
 const {store}=await fixture(t);const custom={version:1,kind:'custom',title:'Custom',summary:'One labeled circle.',svg:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="30"/><text x="20" y="20">Observation</text></svg>'};const saved=await store.execute({...create,document:custom});assert.deepEqual((await store.read({conversationId:'conversation',artifactId:saved.id})).document,custom);
 const clipped=structuredClone(VISUAL_EXAMPLE);clipped.items[0].label='Long label '.repeat(16);assert.throws(()=>compileVisual(clipped),/does not fit/);
 const native=await nativeVisualTools(store)({taskId:'conversation',runId:'run',canWrite:true});await assert.rejects(()=>native.handle({name:'relay_visual',arguments:{action:'preferences',requestId:'forged'}}),{code:'VISUAL_INVALID'});
});
