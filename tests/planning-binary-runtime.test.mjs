import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {normalizePlanningOntology,planningOntologyInstructions,PLANNING_MODULE_STATES,PLANNING_ONTOLOGY_MODULES} from '../public/planning-module-policy.mjs';
import {DIRECTORY_MODES,SUBAGENT_MODES,executionModesFrom,subagentsEnabledFor,usesDirectory} from '../lib/conversation-execution-modes.mjs';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
import {createModularEvidenceJournal,createModularCompletionController} from '../lib/modular-completion.mjs';
import {planningOntologyDirectTool} from '../lib/planning-ontology-direct-tool.mjs';

async function temporary(fn){const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-binary-'));try{return await fn(cwd);}finally{await rm(cwd,{recursive:true,force:true});}}
const policy=()=>normalizePlanningOntology();

test('canonical module schema is Boolean On/Off with no Auto or Optional choices',()=>{
 const p=policy();assert.equal(p.version,2);assert.deepEqual(PLANNING_MODULE_STATES,['on','off']);
 assert.equal(Object.keys(p.modules).length,PLANNING_ONTOLOGY_MODULES.length);assert.ok(Object.entries(p.modules).every(([id,value])=>value===(id==='subagents'||id==='time_management')));
 assert.equal('autoSelect' in p,false);
 for(const state of ['auto','optional','mandatory','forbidden','on','off'])assert.throws(()=>normalizePlanningOntology({version:2,modules:{inference:state}}),{code:'PLANNING_ONTOLOGY_INVALID'});
 assert.throws(()=>normalizePlanningOntology({version:2,autoSelect:false,modules:{}}),{code:'PLANNING_ONTOLOGY_INVALID'});
});


test('retained legacy ontology helper advertises Boolean metadata',async()=>{
 let p=policy();const tool=planningOntologyDirectTool({runtimeSettings:{get:()=>({planningOntology:p}),update:async x=>(p=x.planningOntology,{planningOntology:p})}});
 const schema=tool.definition.inputSchema.properties.ontology.properties;
 assert.deepEqual(schema.version.enum,[2]);assert.equal(schema.autoSelect,undefined);
 assert.ok(Object.values(schema.modules.properties).every(x=>x.type==='boolean'));
 const metadata=JSON.parse((await tool.execute({action:'get'})).contentItems[0].text);
 assert.deepEqual(metadata.states,['on','off']);
});





test('full settled receipts reach review without excerpt truncation',async()=>temporary(async cwd=>{
 const journal=createModularEvidenceJournal({directory:path.join(cwd,'receipts')});const result={success:true,contentItems:[{type:'inputText',text:'x'.repeat(12000)+'EXACT_TAIL'}]};
 const wrapped=journal.wrap(async()=>result);await Promise.all(Array.from({length:24},(_,i)=>wrapped({name:'relay_workspace',callId:'read-'+i,arguments:{action:'read',path:'file-'+i}},{})));
 const snapshot=await journal.snapshot();assert.equal(snapshot.total,24);assert.equal(snapshot.omitted,0);
 assert.ok(snapshot.records.every(x=>x.result.contentItems[0].text.endsWith('EXACT_TAIL')));
 assert.equal((await readdir(path.join(cwd,'receipts'))).length,24);
}));

test('audit persistence failure never reports a completed operation as a failed tool or replays it',async()=>temporary(async cwd=>{
 const directory=path.join(cwd,'blocked-audit');await writeFile(directory,'not a directory');
 const journal=createModularEvidenceJournal({directory});let effects=0;
 const wrapped=journal.wrap(async()=>{effects++;return {success:true,contentItems:[{type:'inputText',text:'actual effect completed'}]};});
 assert.equal((await wrapped({name:'relay_workspace',callId:'unique-effect',arguments:{action:'write',path:'output'}},{})).success,true);
 await assert.rejects(journal.snapshot(),{code:'MODULAR_EVIDENCE_UNAVAILABLE'});
 await rm(directory);await mkdir(directory);assert.equal((await journal.snapshot()).total,1);assert.equal(effects,1);
}));

test('identical read-back receipts with new call IDs do not fake progress',async()=>{
 const reviewPolicy=normalizePlanningOntology({version:2,modules:{verification:true}});let i=0;const state={request:{id:'user-request',text:'Finish'},policy:reviewPolicy,evidence:{records:[]}};
 const c=createModularCompletionController({policy:reviewPolicy,getSnapshot:()=>state,review:async()=>({decision:'continue',summary:'No new outcome',remaining:['actual task'],nextAction:'Perform actual work',evidenceRefs:['user-request'],blockers:[]})});
 for(let attempt=0;attempt<2;attempt++){state.evidence.records.push({id:'read-'+(++i),tool:'relay_workspace',action:'read',target:'same-file',success:true,excerpt:'same bytes'});assert.equal((await c.beforeFinal({output:'Not done'})).continue,true);}
 state.evidence.records.push({id:'read-'+(++i),tool:'relay_workspace',action:'read',target:'same-file',success:true,excerpt:'same bytes'});
 await assert.rejects(c.beforeFinal({output:'Not done'}),{code:'MODULAR_OUTCOME_STALLED'});
});

test('retired Directory rejects construction before model calls or disk mutation',async()=>temporary(async cwd=>{const file=path.join(cwd,'preserved.json');await writeFile(file,'original');let calls=0;assert.throws(()=>new ShadowdancerDirectory({cwd,runtime:{runAgent:async()=>{calls++;}}}),{code:'DIRECTORY_RETIRED'});assert.equal(calls,0);assert.deepEqual(await readdir(cwd),['preserved.json']);assert.equal(await readFile(file,'utf8'),'original');}));
