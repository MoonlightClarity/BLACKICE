import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {compileVisual,VISUAL_COMPOSITION_EXAMPLE,VISUAL_EXAMPLE,visualSvgUrl} from '../public/visual-document.mjs';
import {layoutVisual} from '../public/visual-layout.mjs';
import {applyVisualEdits,visualPatch} from '../public/visual-edits.mjs';
import {VisualArtifacts,nativeVisualTools} from '../lib/visual-artifacts.mjs';

test('coordinate-free composition stays editable, deterministic and independent of relationship meaning',()=>{
 const a=compileVisual(VISUAL_COMPOSITION_EXAMPLE),b=compileVisual(VISUAL_COMPOSITION_EXAMPLE);assert.equal(a.svg,b.svg);assert.ok(visualSvgUrl(a.svg));assert.ok(a.document.links.every(l=>l.id));assert.ok(a.document.notes.every(n=>n.id));assert.equal(a.document.items[0].x,undefined);
 const altered=structuredClone(a.document);altered.links.reverse();assert.deepEqual(layoutVisual(altered).rendered.items,layoutVisual(a.document).rendered.items);
 const pinned=structuredClone(a.document);pinned.items[0].x=20;pinned.items[0].y=40;const rendered=layoutVisual(pinned).rendered;assert.equal(rendered.items[0].x,20);assert.notDeepEqual([rendered.items[1].x,rendered.items[1].y],[20,40]);
 assert.equal(compileVisual(VISUAL_EXAMPLE).document.version,1);
});

test('mixed custom regions retain their text alternative and cannot introduce active content',()=>{
 const document=structuredClone(VISUAL_COMPOSITION_EXAMPLE);document.regions=[{id:'special',label:'Custom comparison',summary:'A spatial mark whose meaning is described here, not inferred by the renderer.',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="20"/></svg>'}];const result=compileVisual(document);assert.ok(visualSvgUrl(result.svg));assert.match(result.text,/Custom region special/);assert.match(result.svg,/<circle/);
 document.regions[0].svg='<svg xmlns="http://www.w3.org/2000/svg"><script>bad</script></svg>';assert.throws(()=>compileVisual(document),/static SVG/);
 document.regions[0].svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 -1 20"><path d="M0 0"/></svg>';assert.throws(()=>compileVisual(document),/positive viewBox/);
});

test('user adds an explanation, agent reads the change and targets the next test without losing the correction',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'visual-reasoning-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=new VisualArtifacts({dataDir:directory});const created=await store.execute({action:'create',conversationId:'scenario',requestId:'create',document:VISUAL_COMPOSITION_EXAMPLE},{actor:'agent:initial'});
 const base={conversationId:'scenario',artifactId:created.id};await store.execute({...base,action:'patch',expectedRevision:1,requestId:'human',operations:[{op:'update',collection:'items',id:'observed',value:{label:'Three reports repeat one alert'}},{op:'add',collection:'items',id:'monitor',value:{label:'Monitoring duplication',status:'Hypothesis'}},{op:'add',collection:'links',id:'monitor-report',value:{from:'monitor',to:'observed',label:'could explain reports',uncertain:true}}]});
 const changes=await store.execute({...base,action:'changes',sinceRevision:1});assert.equal(changes.revisions[0].actor,'user');assert.ok(changes.revisions[0].changes.some(c=>c.id==='monitor'&&c.after.label==='Monitoring duplication'));
 const provider=await nativeVisualTools(store)({taskId:'scenario',runId:'next',canWrite:true});assert.match(provider.instructions,/"lastActor":"user"/);
 const patch={...base,action:'patch',expectedRevision:2,requestId:'agent',operations:[{op:'set_document',value:{summary:'Report count is not independent corroboration; compare versions at equal load and verify alert provenance.'}},{op:'add',collection:'notes',id:'test',value:{text:'Next: compare versions under equal load; inspect alert source IDs.'}}]};const result=await store.execute(patch,{actor:'agent:next'});assert.deepEqual(await store.execute(patch,{actor:'agent:next'}),result);
 const current=await store.read(base);assert.equal(current.document.items[0].label,'Three reports repeat one alert');assert.ok(current.document.items.some(i=>i.id==='monitor'));assert.equal(current.revision,3);assert.equal((await store.read({...base,revision:1})).document.items[0].label,VISUAL_COMPOSITION_EXAMPLE.items[0].label);
 await assert.rejects(()=>store.execute({...patch,requestId:'stale'}),{code:'VISUAL_REVISION_CONFLICT'});
 const page=await store.execute({...base,action:'changes',sinceRevision:0,limit:1});assert.equal(page.hasMore,true);assert.equal(page.throughRevision,1);
});

test('patches are atomic and reject dangling relationships, identity changes and prototype fields',()=>{
 const original=compileVisual(VISUAL_COMPOSITION_EXAMPLE).document;
 assert.throws(()=>applyVisualEdits(original,[{op:'update',collection:'items',id:'observed',value:{id:'other'}}]));
 assert.throws(()=>applyVisualEdits(original,[{op:'update',collection:'items',id:'observed',value:JSON.parse('{"__proto__":{"polluted":true}}')}]));
 assert.throws(()=>compileVisual(applyVisualEdits(original,[{op:'remove',collection:'items',id:'observed'}])),/endpoints/);assert.equal(original.items.length,3);
 const after=structuredClone(original);after.items[0].label='Corrected';const operations=visualPatch(original,after);assert.equal(operations.length,1);assert.deepEqual(applyVisualEdits(original,operations),after);
});
