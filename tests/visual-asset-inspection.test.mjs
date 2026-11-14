import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {VisualArtifacts,nativeVisualTools,visualTool} from '../lib/visual-artifacts.mjs';
import {assetInspectionHtml,ASSET_INSPECTION} from '../desktop/visual-inspection.mjs';
import {SVG_GENERAL_EXAMPLES} from '../lib/visual-craft-examples.mjs';
import {VISUAL_PREVIEW_FEEDBACK} from '../lib/visual-preview-feedback.mjs';

test('the native feedback recipe displays both flattened PNGs without repeating preview or printing bytes',async()=>{
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const run=new AsyncFunction('tools','args','image',VISUAL_PREVIEW_FEEDBACK.nativeStringExample);
 const urls=['data:image/png;base64,bWFpbg==','data:image/png;base64,c2hlZXQ='];
 let calls=0;const displayed=[];
 await run({relay_visual:async()=>{calls++;return JSON.stringify({width:512})+'\n'+urls.join('\n');}},{action:'preview'},url=>displayed.push(url));
 assert.equal(calls,1);assert.deepEqual(displayed,urls);
 await run({relay_visual:async()=>'{"error":"preview unavailable"}'},{action:'preview'},()=>assert.fail('No image was returned'));
});

test('asset inspection embeds only validated images and preserves original colors and transparency',()=>{
 const svg=SVG_GENERAL_EXAMPLES[0].document.svg,html=assetInspectionHtml(svg);
 const sources=[...html.matchAll(/src="([^"]+)"/g)].map(m=>m[1]);assert.equal(sources.length,12);assert.equal(new Set(sources).size,1);
 assert.equal(decodeURIComponent(sources[0].split(',').slice(1).join(',')),svg);
 assert.equal((html.match(/class="gray"/g)||[]).length,3);
 assert.deepEqual(ASSET_INSPECTION.fitBoxes,[256,64,32]);
 assert.equal(ASSET_INSPECTION.reviewChecklist.length,6);
 for(const {color} of ASSET_INSPECTION.backgrounds)assert.ok(html.includes(color));
 for(const bad of ['<svg><script>alert(1)</script></svg>','<svg><image href="https://example.com/a"/></svg>','<svg><rect fill="url(#a)"/></svg>'])assert.throws(()=>assetInspectionHtml(bad));
});

test('native and direct asset previews return a second image without saving or base64 in the text payload',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'asset-preview-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 let calls=0;const doc=SVG_GENERAL_EXAMPLES[0].document;
 const store=new VisualArtifacts({dataDir,renderPreview:async(compiled,options)=>{calls++;assert.equal(compiled.svg,doc.svg);assert.equal(options.inspection,'asset');return {imageUrl:'data:image/png;base64,bWFpbg==',inspectionImageUrl:'data:image/png;base64,c2hlZXQ=',inspection:ASSET_INSPECTION,qualityAssessment:{status:'not-assessed'}};}});
 const native=await nativeVisualTools(store)({taskId:'a',runId:'r',canWrite:false});
 const direct=visualTool(store);
 for(const result of [await native.handle({name:'relay_visual',arguments:{action:'preview',inspection:'asset',document:doc}}),await direct.execute({action:'preview',inspection:'asset',document:doc,requestId:'preview'},{client:{id:'owner',scopes:['read']}})]){
  assert.deepEqual(result.contentItems.map(c=>c.type),['inputText','inputImage','inputImage']);assert.doesNotMatch(result.contentItems[0].text,/base64,(?:bWFpbg|c2hlZXQ)/);assert.ok(JSON.parse(result.contentItems[0].text).imageFeedback.nativeStringExample);assert.equal(JSON.parse(result.contentItems[0].text).qualityAssessment.status,'not-assessed');
 }
 assert.equal(calls,2);assert.deepEqual((await store.read({action:'list',conversationId:'a'})).artifacts,[]);
 await assert.rejects(()=>native.handle({name:'relay_visual',arguments:{action:'preview',inspection:'arbitrary',document:doc}}));
 await assert.rejects(()=>store.execute({action:'preview',inspection:'arbitrary',document:doc}));assert.equal(calls,2);
 const guide=await store.execute({action:'describe'});assert.ok(guide.designGuide.foundation.artDirection.decomposition);assert.ok(guide.designGuide.foundation.artDirection.palette);
 for(const focus of ['general','illustration','data','ux','analysis']){
  const result=await direct.execute({action:'describe',focus,requestId:'guide-'+focus},{client:{id:'owner',scopes:['read']}});
  const checklist=JSON.parse(result.contentItems[0].text).designGuide.checklist;
  assert.equal(checklist.beforeDrawing.length,4);assert.equal(checklist.whileDrawing.length,2);assert.equal(checklist.beforeDelivery.length,2);
  for(const entry of [...checklist.beforeDrawing,...checklist.whileDrawing,...checklist.beforeDelivery])assert.ok(entry.id&&entry.evidence&&entry.repair&&(entry.check||entry.decision));
  assert.deepEqual(Object.keys(checklist.applicableChecks),focus==='general'?['illustration','data','ux','analysis']:[focus]);
 }
});
