import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {discoverTaskSkills,projectTaskSkillDiscovery,SKILL_SHORTLIST_LIMIT} from '../lib/task-skill-discovery.mjs';
import {SkillFieldIndex} from '../lib/skill-field-retrieval.mjs';
import {defaultSkillLibrary,legacySkillMetadata} from '../lib/skill-library.mjs';
import {createRetrievalToolHandler,RETRIEVAL_TOOLS} from '../lib/retrieval-tools.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';

const queries=[
  [
    "audit-selection",
    "A benchmark excludes all runs that crashed. Check the selection bias."
  ],
  [
    "analyze-quantization-error",
    "Quantization changed model outputs. Trace weight rounding and clipping error."
  ],
  [
    "budget-context-and-kv-cache",
    "Calculate transformer context KV cache memory from layers and KV heads."
  ],
  [
    "recover-idempotent-effects",
    "An API request timed out after committing. Could retrying create a duplicate effect?"
  ],
  [
    "model-concurrent-interleavings",
    "Two workers read the same revision and overwrite each other. Analyze concurrent interleavings."
  ],
  [
    "reconcile-version-lineage",
    "A release has a larger version but is missing patches. Reconcile source ancestry and build provenance."
  ],
  [
    "bound-queueing-and-backpressure",
    "Measure service capacity and queue growth when arrivals exceed throughput."
  ],
  [
    "test-sensitivity",
    "Which assumption changes the decision? Find the sensitivity threshold."
  ],
  [
    "draw-causal-model",
    "Separate common causes from mediators in a causal graph."
  ],
  [
    "value-information",
    "Should we buy one more measurement before committing resources? Estimate value of information."
  ],
  [
    "pricing-response",
    "A price cut reduces per-sale contribution. Calculate required sales volume."
  ],
  [
    "cash-timing",
    "Profitable invoices are collected after supplier bills fall due. Forecast cash timing."
  ],
  [
    "metric-gaming",
    "A support target increases ticket closures but customers reopen issues. Diagnose metric gaming."
  ],
  [
    "rules-in-use",
    "Map written policy against actual informal enforcement and exceptions."
  ],
  [
    "intelligence-requirements",
    "Turn a research topic into intelligence collection priorities for a decision."
  ],
  [
    "analyze-feedback-stability",
    "Test whether a control feedback loop becomes unstable with gain and delay."
  ],
  [
    "verify-simulation-convergence",
    "A tiny solver residual still changes after mesh refinement. Assess simulation convergence."
  ],
  [
    "legal-rule-application",
    "Apply a legal rule's elements to facts in the controlling jurisdiction and date."
  ],
  [
    "concept-teaching",
    "Help a learner distinguish a concept from a near miss and transfer it to a new example."
  ],
  [
    "information-findability",
    "Organize labels so users can find information with realistic queries."
  ]
];
const padding=(length,start=0)=>Array.from({length},(_,i)=>({id:'scale-padding-'+(start+i),
 title:'Marine coral cultivation '+(start+i),description:'Ocean habitat salinity routine',source:'bundled',revision:1}));
const active=entry=>({...entry,activationDeclared:Array.isArray(entry.activation)});
const decode=result=>JSON.parse(result.contentItems.find(x=>x.type==='inputText').text);

test('all representative reasoning tasks reach provider metadata at125,128,1000 and10000 skills',async t=>{
 const base=[...legacySkillMetadata(),...await defaultSkillLibrary.list()].map(active);
 for(const size of [125,128,1000,10000]){
  const records=[...base.map(row=>({...row})),...padding(size-base.length)];
  for(const row of records)Object.defineProperty(row,'content',{get(){assert.fail('Discovery must not read instruction bodies.');}});
  const index=new SkillFieldIndex();
  try{
   for(const [slug,query]of queries){
    const result=discoverTaskSkills(query,records,{fieldIndex:index});
    const projected=projectTaskSkillDiscovery(result),wanted=projected.find(x=>x.id==='library-fp-'+slug);
    assert(wanted,size+' skills: '+slug);
    assert(wanted.description.length>0,'Provider needs a purpose, not only a title.');
    assert(projected.length<=SKILL_SHORTLIST_LIMIT);
    assert(JSON.stringify(projected).length<=6000);
    assert(projected.every(row=>!Object.hasOwn(row,'content')));
    assert.equal(result.selection.firstStage.kind,'field-aware-sparse');
   }
  }finally{index.close();}
 }
});

test('tag-only and alias-only methods remain reachable beyond the old shortlist boundary',()=>{
 for(const size of [125,128,1000,10000]){
  const records=[...padding(size-1),{id:'library-treasury-control',title:'Specialized control',description:'Operational procedure',
   tags:['liquidity','settlement'],aliases:['treasury reconciliation'],source:'bundled',revision:1}];
  for(const query of ['Resolve liquidity settlement discrepancies','Perform treasury balance reconciliation']){
   const projected=projectTaskSkillDiscovery(discoverTaskSkills(query,records));
   assert(projected.some(x=>x.id==='library-treasury-control'),size+' '+query);
  }
 }
});

test('every indexed metadata field invalidates the same-revision cache',()=>{
 for(const field of ['title','description','summary','appliesWhen','scope','tags','aliases']){
  const index=new SkillFieldIndex(),array=field==='tags'||field==='aliases';
  const before={id:'current',title:'Specialized method',source:'bundled',revision:1,[field]:array?['liquidity settlement']:'Liquidity settlement'};
  try{
   assert(index.refresh([before]));
   assert.equal(index.search('liquidity settlement').candidates[0]?.id,'current',field);
   const after={...before,[field]:array?['botanical orchard']:'Botanical orchard'};
   assert(index.refresh([after]),field+' must invalidate without a new body revision');
   assert.equal(index.search('liquidity settlement').candidates.length,0,field+' must remove stale terms');
   assert.equal(index.search('botanical orchard').candidates[0]?.id,'current',field);
   assert.equal(index.refresh([after]),false,'unchanged metadata should reuse index');
  }finally{index.close();}
 }
});

test('routine requests and public evaluation rows do not become skill context',async()=>{
 const records=[...legacySkillMetadata(),...await defaultSkillLibrary.list()].map(active);
 for(const query of ['Hello','2 + 2','Copy the exact text of the document']){
  assert.deepEqual(projectTaskSkillDiscovery(discoverTaskSkills(query,records)),[],query);
 }
 const external=[{id:'external',title:'Reconcile cash ledger',description:'Reconcile bank ledger cash',
  source:'public-evaluation-only',revision:1}];
 assert.deepEqual(projectTaskSkillDiscovery(discoverTaskSkills('Reconcile cash ledger',external)),[]);
});

test('model retrieval can page beyond11000 and read the exact returned ID',async()=>{
 const entries=Array.from({length:12050},(_,i)=>({id:'page-'+i,title:'Method '+i,description:'Task procedure',source:'bundled',revision:1}));
 const catalog={
  async list({offset=0,limit=12}={}){const page=entries.slice(offset,offset+limit),nextOffset=offset+page.length<entries.length?offset+page.length:null;return {entries:page,totalMatches:entries.length,nextOffset,truncated:nextOffset!==null};},
  async detail({id}){const row=entries.find(x=>x.id===id);assert(row);return {...row,content:'Exact body for '+id};},
 };
 const handler=createRetrievalToolHandler({cwd:path.resolve('.'),skillsCatalog:catalog});
 const first=decode(await handler({name:'relay_skills',arguments:{action:'search',offset:11990,limit:50}}));
 assert.equal(first.entries[0].id,'page-11990');assert.equal(first.nextOffset,12040);
 const next=decode(await handler({name:'relay_skills',arguments:{action:'search',offset:first.nextOffset,limit:50}}));
 assert.equal(next.entries.length,10);assert.equal(next.nextOffset,null);
 const read=decode(await handler({name:'relay_skills',arguments:{action:'read',id:next.entries.at(-1).id}}));
 assert.equal(read.entry.content,'Exact body for page-12049');
 const schema=RETRIEVAL_TOOLS.find(x=>x.name==='relay_skills').inputSchema;
 assert(schema.properties.offset.maximum>=12049);
 await assert.rejects(handler({name:'relay_skills',arguments:{action:'search',offset:Number.MAX_SAFE_INTEGER+1}}),/offset/);
});

test('actual provider admission carries the full shortlist in Chat Mode with planning off', {timeout:120000},async t=>{
 const baseCount=(await defaultSkillLibrary.list()).length+legacySkillMetadata().length;
 for(const size of [125,128,1000,10000])await t.test(String(size)+' skills',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-scale-provider-'));
  const dataDir=path.join(dir,'engine'),ownerDir=path.join(dataDir,'skill-edits');
  await mkdir(ownerDir,{recursive:true});
  const entries={};
  for(let i=0;i<size-baseCount;i++)entries['user-scale-'+i]={revision:2,content:'# Marine coral cultivation '+i+'\n\nOcean habitat salinity routine.\n\nBODY_SCALE_SENTINEL_'+i};
  await writeFile(path.join(ownerDir,'skills.json'),JSON.stringify({version:1,entries}));
  let engine,catalog,wantedId,query,body,readRequested=false,captures=0;
  class Runtime extends EventEmitter{
   status(){return {connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',model:'fixture',available:true}]};}
   async runAgent(options){
    const match=/ON-DEMAND SKILL DISCOVERY[^\n]*\n(\[[^\n]*\])\n/.exec(options.prompt);
    assert(match,'Provider must actually receive the metadata block.');
    const projected=JSON.parse(match[1]),wanted=projected.find(row=>row.id===wantedId);
    assert(wanted,size+' '+query);assert(wanted.description?.length>0);
    assert(projected.length<=SKILL_SHORTLIST_LIMIT);
    assert(options.dynamicTools.some(tool=>tool.name==='relay_skills'));
    assert(!options.prompt.includes('BODY_SCALE_SENTINEL'));
    if(body)assert(!options.prompt.includes(body),'Instruction bodies remain on demand.');
    await options.onPromptAccepted?.(options.prompt);
    const active=[...engine.runs.values()].at(-1);
    assert.deepEqual(active.skillLoadReceipts||[],[],'Metadata delivery is not a skill read.');
    if(readRequested){
     const call={name:'relay_skills',arguments:{action:'read',id:wantedId},callId:'read-scale-method'};
     const result=await options.onToolCall(call);
     assert.equal(decode(result).entry.content,body);
     assert.deepEqual(active.skillLoadReceipts||[],[],'Returning a callback alone is not provider delivery.');
     await options.onToolResultDelivered({call,result});
    }
    captures++;
    return {output:'Offline retrieval fixture. No real external action was performed.'};
   }
  }
  try{
   catalog=createSkillsCatalog({dataDir});
   assert.equal((await catalog.taskMetadata()).length,size);
   engine=await new HarnessEngine({runtime:new Runtime(),dataDir,defaultCwd:dir}).init();
   for(let i=0;i<queries.length;i++){
    const [slug,text]=queries[i];wantedId='library-fp-'+slug;query=text;
    readRequested=size===10000&&i===0;
    body=readRequested?await readFile(new URL('../lib/skill-library/fp-audit-selection.md',import.meta.url),'utf8'):null;
    const workflow=createMissionWorkflow({id:'mission_chat_scale_'+size+'_'+i,task:query,model:'fixture',cwd:dir,planningMode:'off'});
    const started=engine.startRun({workflow,input:{task:query,planningMode:'off',directoryMode:'off',directoryActions:'off',chatPlanning:'off',pastChats:'off'}});
    await engine.executions.get(started.id);
    const run=engine.getRun(started.id);
    assert.equal(run.status,'completed',run.error);
    assert.equal(run.chatPlanning,'off');assert.equal(run.directoryActions,'off');
    assert.equal(run.nodes.agent.skillSelection.automaticDelivery,false);
    assert(run.nodes.agent.skillSelection.candidates.some(row=>row.id===wantedId&&row.description));
    assert.equal((run.skillLoadReceipts||[]).filter(row=>row.type==='skill_loaded'&&row.skillId===wantedId).length,readRequested?1:0);
   }
   assert.equal(captures,queries.length);
  }finally{await engine?.close();await catalog?.close();await rm(dir,{recursive:true,force:true,maxRetries:12,retryDelay:100});}
 });
});

test('field retrieval has no arbitrary100000-record ceiling',()=>{
 const index=new SkillFieldIndex(),records=Array.from({length:100001},(_,i)=>({
  id:'large-'+i,title:'Coral maintenance',description:'Marine habitat',source:'bundled',revision:1
 }));
 records.at(-1).aliases=['pulsar calibration'];
 try{
  index.refresh(records);
  assert.equal(index.stats().documents,100001);
  assert.equal(index.search('pulsar calibration').candidates[0]?.id,'large-100000');
 }finally{index.close();}
});

test('first-stage lookup preserves the lexical reranker inflection matches',()=>{
 const index=new SkillFieldIndex();
 try{
  for(const [singular,plural]of [['invoice','invoices'],['property','properties'],['policy','policies']]){
   const rows=[{id:'current',title:singular+' method',description:'Specialized procedure',source:'bundled',revision:1}];
   index.refresh(rows);
   assert.equal(index.search(plural).candidates[0]?.id,'current',plural);
   assert(projectTaskSkillDiscovery(discoverTaskSkills(plural,rows,{fieldIndex:index})).some(x=>x.id==='current'));
  }
 }finally{index.close();}
});
