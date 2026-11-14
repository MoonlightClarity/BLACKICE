import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VisualArtifacts,nativeVisualTools,visualTool} from '../lib/visual-artifacts.mjs';
import {compileVisual} from '../public/visual-document.mjs';
import {SVG_GENERAL_EXAMPLES,SVG_DATA_EXAMPLE_VALUES,svgDataExamplePoint} from '../lib/visual-craft-examples.mjs';

test('native and direct describe retrieve focused craft without persisting or loading unrelated chapters',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'visual-craft-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const store=new VisualArtifacts({dataDir});const native=await nativeVisualTools(store)({taskId:'craft',runId:'r',canWrite:false});
 const direct=visualTool(store);const read=result=>JSON.parse(result.contentItems[0].text);
 for(const focus of ['general','illustration','data','ux','analysis']){
  const a=read(await native.handle({name:'relay_visual',arguments:JSON.stringify({action:'describe',focus})}));
  const b=read(await direct.execute({action:'describe',focus,requestId:'read-'+focus},{client:{id:'owner',scopes:['read']}}));
  assert.deepEqual(a,b);
  assert.ok(a.designGuide.foundation.paths);assert.ok(a.examples.length);
  if(['illustration','data','ux'].includes(focus)){assert.ok(a.designGuide.craft);assert.equal(a.examples.length,1);}
  for(const example of a.examples)assert.equal(compileVisual(example.document).svg,example.document.svg);
 }
 const defaultResult=await store.execute({action:'describe'});assert.equal(defaultResult.designGuide.craft,undefined);
 assert.deepEqual(defaultResult.examples,SVG_GENERAL_EXAMPLES);
 await assert.rejects(()=>native.handle({name:'relay_visual',arguments:{action:'describe',focus:'unknown'}}));
 await assert.rejects(()=>store.execute({action:'describe',focus:'toString'}));
 assert.deepEqual((await store.read({action:'list',conversationId:'craft'})).artifacts,[]);
});

test('data construction maps source values and breaks the missing interval',()=>{
 assert.deepEqual(svgDataExamplePoint({day:1,minutes:20}),{x:56,y:52});
 assert.deepEqual(svgDataExamplePoint({day:5,minutes:0}),{x:328,y:196});
 assert.deepEqual(svgDataExamplePoint({day:3,minutes:null}),{x:192,y:null});
 const svg=SVG_GENERAL_EXAMPLES[1].document.svg;
 const observed=SVG_DATA_EXAMPLE_VALUES.filter(p=>p.minutes!==null).map(svgDataExamplePoint);
 assert.equal((svg.match(/<circle /g)||[]).length,observed.length);
 for(const p of observed)assert.ok(svg.includes(`cx="${p.x}" cy="${p.y}"`));
 const trajectory=svg.match(/<path d="([^"]+)" fill="none" stroke="#9fb8c6"/)[1];
 assert.equal((trajectory.match(/M /g)||[]).length,2);
 assert.ok(!trajectory.includes('192'),'No measured mark or connecting vertex at the missing day');
});

test('cross-domain custom SVGs retain exact source through persistence, revisions and export',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'visual-craft-save-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const store=new VisualArtifacts({dataDir});
 for(const [i,{document}] of SVG_GENERAL_EXAMPLES.entries()){
  const saved=await store.execute({action:'create',conversationId:'craft',requestId:'create-'+i,document});
  const read=await store.execute({action:'read',conversationId:'craft',artifactId:saved.id});
  assert.equal(read.svg,document.svg);assert.equal(read.document.summary,document.summary);
  const changed={...document,summary:document.summary+' Revised description.'};
  await store.execute({action:'revise',conversationId:'craft',artifactId:saved.id,expectedRevision:1,requestId:'revise-'+i,document:changed});
  const original=await store.execute({action:'export',conversationId:'craft',artifactId:saved.id,revision:1});
  assert.equal(original.svg,document.svg);assert.equal(original.document.summary,document.summary);
 }
 const reloaded=new VisualArtifacts({dataDir});assert.equal((await reloaded.read({action:'list',conversationId:'craft'})).artifacts.length,3);
});
