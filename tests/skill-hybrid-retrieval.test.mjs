import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {discoverTaskSkills} from '../lib/task-skill-discovery.mjs';
import {SkillHybridIndex,semanticSkillScore} from '../lib/skill-hybrid-retrieval.mjs';

const positive = [
 ['website interaction recovery','library-browser-navigation'],
 ['automated site clicks become stale after refresh','library-browser-navigation'],
 ['navigate around a web form when the inputs stop responding','library-browser-navigation'],
 ['inspect what failed in the app after changing monitors','library-software-debugging'],
 ['assess a code patch for correctness risks before shipping','library-code-review'],
 ['match people across two rosters with slightly different names','library-data-reconciliation'],
 ['compare two policy drafts and extract the changed obligations','library-document-comparison'],
 ['check keyboard focus order on a registration screen','library-accessibility-spot-check'],
 ['look for new fully remote employment positions and apply','library-job-search'],
 ['show a line graph of changing enrollment figures','library-chart-storytelling'],
 ['sketch the service architecture and show data movement','library-concept-diagram'],
 ['recognize premature completion and keep working','library-anti-completion-bias'],
];
const negative = [
 'soil salinity limits for heirloom tomatoes',
 'repaint a rusted bicycle frame with enamel',
 'Ask the band to review yesterday while I schedule a dentist and photograph fabric swatches beside the patch.',
 'Could you please do it?',
 'pdfish wordfile tabkey',
];

test('semantic + FTS5 retrieval ranks independently worded task intents without unrelated false positives',async t=>{
 const catalog=createSkillsCatalog(); t.after(()=>catalog.close());
 let exactTop1=0, rejected=0;
 for(const [query,want] of positive){
  const result=await catalog.list({query,limit:5});
  if(result.entries[0]?.id===want)exactTop1++;
  assert.equal(result.entries[0]?.id,want,'missed paraphrase: '+query);
  assert.ok(result.entries.every(row=>!Object.hasOwn(row,'content')&&!Object.hasOwn(row,'aliases')));
 }
 for(const query of negative){
  const result=await catalog.list({query,limit:5});
  if(result.totalMatches===0)rejected++;
  assert.equal(result.totalMatches,0,'false positive: '+query);
 }
 assert.equal(exactTop1,positive.length);
 assert.equal(rejected,negative.length);
});

test('index is rebuildable, revision-sensitive, bounded to metadata and safe for multiple searches',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'blackice-hybrid-skill-'));
 const catalog=createSkillsCatalog({dataDir:dir});
 t.after(async()=>{await catalog.close();await rm(dir,{recursive:true,force:true});});
 const added=await catalog.create({value:{content:'# Site Incident Recovery\n\nRestore stale website controls and resume interrupted form interactions.\n\n## Procedure\nSECRET_BODY_NOT_METADATA'}});
 const query='website interaction recovery';
 // A user-created, more specific method may rank ahead of the bundled
 // general method. Both must remain discoverable.
 assert.equal((await catalog.list({query})).entries[0]?.id,added.id);
 assert.ok((await catalog.list({query,limit:30})).entries.some(row=>row.id===added.id));
 // Existing owner-authored skill text remains searchable, but the indexed
 // metadata never includes that later-body sentinel.
 assert.ok((await catalog.list({query:'SECRET_BODY_NOT_METADATA'})).entries.some(row=>row.id===added.id));
 const revised=await catalog.save({id:added.id,value:{expectedRevision:added.revision,content:'# Water the Plants\n\nCheck soil moisture and irrigate the tomatoes.'}});
 assert.equal(revised.revision,3);
 assert.ok(!(await catalog.list({query,limit:40})).entries.some(row=>row.id===added.id));
 await catalog.delete({id:added.id,value:{expectedRevision:3}});
 assert.ok(!(await catalog.list({query,limit:40})).entries.some(row=>row.id===added.id));
 await catalog.restore({id:added.id,value:{expectedRevision:4}});
 assert.ok(!(await catalog.list({query,limit:40})).entries.some(row=>row.id===added.id));
});

test('owner-created methods are eligible from paraphrases but still require real task intent',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'blackice-hybrid-automatic-'));
 const catalog=createSkillsCatalog({dataDir:dir});
 t.after(async()=>{await catalog.close();await rm(dir,{recursive:true,force:true});});
 const added=await catalog.create({value:{content:'# Web Input Repair\n\nRestore stale browser form controls and navigate interrupted website interactions.'}});
 const metadata=await catalog.taskMetadata();
 const request='Recover website interactions after stale input controls stop responding.';
 assert.ok(discoverTaskSkills(request,metadata).automatic.some(entry=>entry.id===added.id));
 for(const query of ['Explain website interaction recovery methods.','Review website interaction recovery skills.'])
  assert.ok(!discoverTaskSkills(query,metadata).automatic.some(entry=>entry.id===added.id));
});

test('semantic search never treats one vague word as authorization or relevance',()=>{
 const row={id:'user-demo',title:'Review code',tags:['review','coding'],description:'Review a software patch'};
 assert.equal(semanticSkillScore(row,'review'),-1);
 assert.equal(semanticSkillScore(row,'patch'),-1);
 const index=new SkillHybridIndex();
 index.refresh([row]);
 const candidates=index.score('review');
 assert.ok(candidates instanceof Map);
 index.close();
});
