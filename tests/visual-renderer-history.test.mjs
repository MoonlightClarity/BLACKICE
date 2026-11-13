import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VisualArtifacts} from '../lib/visual-artifacts.mjs';
import {compileVisual as original,VISUAL_EXAMPLE} from '../public/visual-document-renderer-original.mjs';
import {compileVisual as composition,VISUAL_COMPOSITION_EXAMPLE} from '../public/visual-document-renderer-composition.mjs';
import {compileVisual as geometry} from '../public/visual-document-renderer-geometry.mjs';
import {compileVisual as current} from '../public/visual-document.mjs';
import {compileVisual as clamped} from '../public/visual-document-renderer-clamped.mjs';

test('current writer matches the registered geometry renderer',()=>{
 for(const document of [VISUAL_EXAMPLE,VISUAL_COMPOSITION_EXAMPLE])assert.deepEqual(current(document),geometry(document),'Register a new immutable renderer before changing persisted output.');
});

for(const [name,render,document] of [['original',original,VISUAL_EXAMPLE],['composition',composition,VISUAL_COMPOSITION_EXAMPLE],['geometry',geometry,VISUAL_COMPOSITION_EXAMPLE],['clamped',clamped,VISUAL_EXAMPLE]]){
 test('reads and revises unversioned '+name+' renderer output exactly',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'visual-renderer-history-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new VisualArtifacts({dataDir:dir});
  const created=await store.execute({action:'create',conversationId:'history',requestId:'new',document});
  const file=path.join(dir,'visual-artifacts','history.json'),state=JSON.parse(await readFile(file,'utf8'));
  const saved=state.artifacts[0].revisions[0],historic=render(document);
  Object.assign(saved,historic);delete saved.renderer;await writeFile(file,JSON.stringify(state));
  const before=await store.read({conversationId:'history',artifactId:created.id});
  assert.equal(before.svg,historic.svg);assert.equal(before.text,historic.text);
  const changed=await store.execute({action:'revise',conversationId:'history',artifactId:created.id,expectedRevision:1,requestId:'revise',document:{...document,summary:'A revised summary.'}});
  assert.equal(changed.revision,2);
  assert.equal((await store.read({conversationId:'history',artifactId:created.id,revision:1})).svg,historic.svg);
  assert.equal((await store.read({conversationId:'history',artifactId:created.id})).renderer,'geometry-1');
 });
}
test('unknown renderer and tampered SVG remain detectable',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'visual-renderer-invalid-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new VisualArtifacts({dataDir:dir}),created=await store.execute({action:'create',conversationId:'history',requestId:'new',document:VISUAL_EXAMPLE});
 const file=path.join(dir,'visual-artifacts','history.json'),state=JSON.parse(await readFile(file,'utf8'));
 state.artifacts[0].revisions[0].renderer='unknown';await writeFile(file,JSON.stringify(state));
 await assert.rejects(()=>store.read({conversationId:'history',artifactId:created.id}),{code:'VISUAL_DAMAGED'});
 delete state.artifacts[0].revisions[0].renderer;state.artifacts[0].revisions[0].svg+='tampered';await writeFile(file,JSON.stringify(state));
 await assert.rejects(()=>store.read({conversationId:'history',artifactId:created.id}),{code:'VISUAL_DAMAGED'});
});
