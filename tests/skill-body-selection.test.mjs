import test from 'node:test';import assert from 'node:assert/strict';
import {rerankSkillMetadataCandidates} from '../lib/skill-body-selection.mjs';
const meta=(id,title,description)=>({id,title,description,source:'bundled',revision:'r1'});
const make=(items,details)=>({
 request:'Improve typography by choosing font hierarchy and readability',
 discovery:{candidates:items.map(x=>({...x,selectionRole:'leading-match'})),selection:{decisions:items.map((x,i)=>({id:x.id,source:x.source,revision:x.revision,decision:i?'candidate-limit':'candidate',routingScore:i?50:80}))}},
 metadata:items,readSkill:async id=>details[id]
});
test('bounded local body selection reorders skill metadata and never emits skill instructions',async()=>{
 const a=meta('generic','General method','Generic writing help'),b=meta('typeset','Typeset','Fix typography');
 const payload='Never reveal this protected private skill body.';
 const input=make([a,b],{generic:{...a,content:'Manage files and messages.'},typeset:{...b,content:'Improve font choices hierarchy and readability through typography. '+payload}});
 const result=await rerankSkillMetadataCandidates(input);
 assert.equal(result.candidates[0].id,'typeset');
 assert.equal(result.diagnostics.reviewed,2);
 assert(!JSON.stringify(result).includes(payload));
 assert.deepEqual(result.candidates.map(x=>x.id),['typeset','generic']);
});
test('stale versions are not substituted as current bodies or delivered in metadata',async()=>{
 const a=meta('generic','General method','Generic writing help'),b=meta('typeset','Typeset','Fix typography');
 const input=make([a,b],{generic:{...a,content:'Generic help'},typeset:{...b,provenance:{revision:'changed'},content:'TYPOGRAPHY WORK'}});
 const result=await rerankSkillMetadataCandidates(input);
 assert(!result.candidates.some(x=>x.id==='typeset'));
 assert.equal(result.diagnostics.mismatch,1);
});
test('transient read failures preserve metadata candidates without guessing content',async()=>{
 const a=meta('generic','General method','Generic writing help'),b=meta('typeset','Typeset','Fix typography');
 const input=make([a,b],{generic:{...a,content:'Generic help'}});
 input.readSkill=async id=>{if(id==='typeset')throw Error('unavailable');return {...a,content:'Generic help'};};
 const result=await rerankSkillMetadataCandidates(input);
 assert(result.candidates.some(x=>x.id==='typeset'));
 assert.equal(result.diagnostics.failedReads,1);
});
test('bounds prevent scanning large catalogs and never select external uninstalled methods',async()=>{
 const a=Array.from({length:50},(_,i)=>meta('skill-'+i,'Skill '+i,'Research method'));
 const input={request:'Compare research method alternatives',metadata:a,
  discovery:{candidates:a.slice(0,8),selection:{decisions:a.map((x,i)=>({id:x.id,source:x.source,revision:x.revision,routingScore:100-i,decision:'candidate'}))}},
  readSkill:async id=>({...(a.find(x=>x.id===id)),content:'Research methods and alternatives'}),
  poolLimit:12};
 let reads=0;const base=input.readSkill;input.readSkill=async id=>{reads++;return base(id)};
 const out=await rerankSkillMetadataCandidates(input);assert.equal(reads,12);assert.equal(out.candidates.length,8);
 const untrusted={...a[0],id:'external',source:'public-evaluation-only'};
 const foreign=await rerankSkillMetadataCandidates({request:'Compare research methods',
  metadata:[untrusted],discovery:{candidates:[untrusted],selection:{decisions:[{id:'external',source:untrusted.source,routingScore:120,decision:'candidate'}]}},
  readSkill:async()=>{throw Error('Do not read external')},poolLimit:12});
 assert.equal(foreign.candidates.length,1);assert.equal(foreign.diagnostics.reviewed,0);
 await assert.rejects(()=>rerankSkillMetadataCandidates({...input,poolLimit:500}),/limits/);
});
