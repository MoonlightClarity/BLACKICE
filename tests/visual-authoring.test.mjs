import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VisualArtifacts,visualTool} from '../lib/visual-artifacts.mjs';
import {VISUAL_DESIGN_EXAMPLES} from '../lib/visual-design-examples.mjs';
import {compileVisual} from '../public/visual-document.mjs';

test('visuals stay available even for old conversations with automatic disabled',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'visual-default-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new VisualArtifacts({dataDir:dir});assert.equal((await store.read({action:'list',conversationId:'a'})).automatic,true);
 await store.execute({action:'preferences',conversationId:'a',requestId:'old-client',automatic:false});
 const file=path.join(dir,'visual-artifacts','a.json'),journal=JSON.parse(await readFile(file));journal.automatic=false;await writeFile(file,JSON.stringify(journal));
 assert.equal((await store.read({action:'list',conversationId:'a'})).automatic,true);assert.equal(JSON.parse(await readFile(file)).automatic,false,'Reading does not rewrite old history');
});
test('describe offers varied authored arguments; preview returns image feedback without saving or write authority',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'visual-preview-'));t.after(()=>rm(dir,{recursive:true,force:true}));let rendered=0;
 const store=new VisualArtifacts({dataDir:dir,renderPreview:async compiled=>{rendered++;assert.equal(compiled.document.kind,'custom');return {imageUrl:'data:image/png;base64,aGVsbG8=',diagnostics:{issues:[]}};}});
 const guide=await store.execute({action:'describe'});assert.equal(guide.examples.length,3);
 for(const example of VISUAL_DESIGN_EXAMPLES)assert.equal(compileVisual(example.document).svg,example.document.svg);
 const tool=visualTool(store,{native:true,conversationId:'a',canWrite:false});const result=await tool.execute({action:'preview',document:VISUAL_DESIGN_EXAMPLES[0].document});
 assert.equal(result.contentItems[1].type,'inputImage');assert.equal(rendered,1);assert.deepEqual((await store.read({action:'list',conversationId:'a'})).artifacts,[]);
 await assert.rejects(()=>tool.execute({action:'preview',document:{...VISUAL_DESIGN_EXAMPLES[0].document,svg:'<svg><script>alert(1)</script></svg>'}}));assert.equal(rendered,1,'Invalid source never reaches Chromium');
 const bare=new VisualArtifacts({dataDir:dir});await assert.rejects(()=>bare.execute({action:'preview',document:VISUAL_DESIGN_EXAMPLES[0].document}),{code:'VISUAL_PREVIEW_UNAVAILABLE'});
});
