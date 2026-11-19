import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createSkillLibrary } from '../lib/skill-library.mjs';
import { createSkillsCatalog } from '../lib/skills-catalog.mjs';
import { createRetrievalToolHandler } from '../lib/retrieval-tools.mjs';

const skill = (id, extra={}) => ({id:'library-'+id, title:'Reusable method '+id, description:'Synthetic generic work', tags:['fixture'], source:{kind:'first-party',revision:'2026-11'},bodyFile:id+'.md',...extra});
async function fixture(t, entries) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-skill-library-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
 const dataDir=path.join(root,'data');
 await fs.writeFile(path.join(root,'index.json'),JSON.stringify({version:1,entries}));
 const library=createSkillLibrary({root});
 return {root,dataDir,library,catalog:createSkillsCatalog({library,dataDir})};
}
const decode = output => JSON.parse(output.contentItems[0].text);
test('1200 packaged skills are discoverable in bounded pages without reading any body',async t=>{
 const entries=Array.from({length:1200},(_,i)=>skill('entry-'+String(i).padStart(4,'0')));
 entries[98]=skill('document-review',{title:'Document Review',description:'Read a report and verify claims before drafting',tags:['analysis','source','audit','claims']});
 entries[97]=skill('report-reader',{description:'Document review technique',tags:['analysis']});
 const {root,catalog}=await fixture(t,entries);
 // No body exists except the selected one; discovery must not touch missing bodies.
 const body='# Document review\n\nUse source timestamps. Novelbodyterm stays out of metadata.';
 await fs.writeFile(path.join(root,'document-review.md'),body);
 const invoke=createRetrievalToolHandler({cwd:root,skillsCatalog:catalog});
 const call=async args=>decode(await invoke({name:'relay_skills',arguments:args}));
 const first=await call({action:'search'});assert.equal(first.totalMatches,1203);
 assert.equal(first.entries.length,12);assert.equal(first.nextOffset,12);
 const second=await call({action:'search',offset:first.nextOffset,limit:50});
 assert.equal(second.entries.length,50);assert.equal(second.nextOffset,62);
 const seen=new Set([...first.entries,...second.entries].map(row=>row.id));assert.equal(seen.size,62);
 const last=await call({action:'search',offset:1195,limit:50});
 assert.equal(last.entries.length,8);assert.equal(last.nextOffset,null);assert.equal(last.truncated,false);
 const ranked=await call({action:'search',query:'document review'});
 assert.equal(ranked.entries[0].id,'library-document-review');
 assert.ok(ranked.entries.some(row=>row.id==='library-report-reader'));
 const natural=await call({action:'search',query:'Can you audit the document claims, please? Unfamiliar'});
 assert.equal(natural.entries[0].id,'library-document-review');
 assert.ok(!natural.entries.some(row=>row.id==='library-report-reader'));
 assert.equal((await call({action:'search',query:'how can you please'})).totalMatches,0);
 assert.ok(ranked.entries.every(row=>!('content'in row)&&!('bodyFile'in row)));
 assert.equal((await call({action:'search',query:'novelbodyterm'})).totalMatches,0);
 assert.equal((await call({action:'read',id:'library-document-review'})).entry.content,body);
 await assert.rejects(()=>call({action:'read',id:'library-entry-0000'}),/body is unavailable/);
 await assert.rejects(()=>call({action:'read',id:'library-document-review',offset:0}),/offset/);
 await assert.rejects(()=>call({action:'save',id:'library-document-review'}),/action/);
});
test('owner overlay can rename, revise, remove and restore a bundled library skill',async t=>{
 const {catalog}=await fixture(t,[skill('metadata-only',{title:'Release title'})]);
 const opts={id:'library-metadata-only'};
 const saved=await catalog.save({...opts,value:{expectedRevision:1,content:'# User title\n\nCustom body search'}});
 assert.equal(saved.title,'User title');assert.equal(saved.revision,2);assert.equal(saved.source,'user');
 assert.equal(saved.provenance.kind,'first-party');assert.equal((await catalog.list({query:'custom body'})).entries[0].id,opts.id);
 assert.equal((await catalog.detail(opts)).content,saved.content);
 await assert.rejects(()=>catalog.save({...opts,value:{expectedRevision:1,content:'stale'}}),{status:409});
 await catalog.delete({...opts,value:{expectedRevision:2}});
 await assert.rejects(()=>catalog.detail(opts),{status:404});
 assert.equal((await catalog.list({source:'deleted'})).entries[0].id,opts.id);
 assert.equal((await catalog.restore({...opts,value:{expectedRevision:3}})).content,saved.content);
});
test('pack rejects duplicate identities and external body references before discovery',async t=>{
 const {library}=await fixture(t,[skill('remote',{bodyFile:'../elsewhere.md'})]);
 await assert.rejects(()=>library.list(),/Invalid or duplicate/);
 const dupe=await fixture(t,[skill('same'),skill('same',{bodyFile:'other.md'})]);
 await assert.rejects(()=>dupe.library.list(),/Invalid or duplicate/);
});
