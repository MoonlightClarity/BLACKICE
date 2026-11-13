import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {normalizePlanningOntology,planningOntologyInstructions,PLANNING_MODULE_STATES,PLANNING_ONTOLOGY_MODULES} from '../public/planning-module-policy.mjs';
import {gridOntologyState,updatedGridOntology} from '../public/next/chat/ontology-preferences.mjs';
import {readConversationExecutionModes,saveConversationExecutionModes} from '../public/next/chat/execution-preferences.mjs';
import {DIRECTORY_MODES,SUBAGENT_MODES,executionModesFrom,subagentsEnabledFor,usesDirectory} from '../lib/conversation-execution-modes.mjs';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
import {createModularEvidenceJournal,createModularCompletionController} from '../lib/modular-completion.mjs';
import {planningOntologyDirectTool} from '../lib/planning-ontology-direct-tool.mjs';

async function temporary(fn){const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-binary-'));try{return await fn(cwd);}finally{await rm(cwd,{recursive:true,force:true});}}
const policy=()=>normalizePlanningOntology();

test('canonical module schema is Boolean On/Off with no Auto or Optional choices',()=>{
 const p=policy();assert.equal(p.version,2);assert.deepEqual(PLANNING_MODULE_STATES,['on','off']);
 assert.equal(Object.keys(p.modules).length,PLANNING_ONTOLOGY_MODULES.length);assert.ok(Object.values(p.modules).every(x=>x===true));
 assert.equal('autoSelect' in p,false);
 for(const state of ['auto','optional','mandatory','forbidden','on','off'])assert.throws(()=>normalizePlanningOntology({version:2,modules:{inference:state}}),{code:'PLANNING_ONTOLOGY_INVALID'});
 assert.throws(()=>normalizePlanningOntology({version:2,autoSelect:false,modules:{}}),{code:'PLANNING_ONTOLOGY_INVALID'});
});

test('legacy choices migrate without mutating history or disabling allowed modules',()=>{
 const previous={version:1,autoSelect:true,modules:{inference:'mandatory',feasibility:'optional',decomposition:'auto',subagents:'forbidden'}};
 const frozen=JSON.stringify(previous),next=normalizePlanningOntology(previous);
 assert.deepEqual([next.modules.inference,next.modules.feasibility,next.modules.decomposition,next.modules.subagents],[true,true,true,true]);
 assert.equal(JSON.stringify(previous),frozen);
 const off=updatedGridOntology(next,'inference','off');assert.equal(off.modules.inference,false);assert.equal(off.modules.feasibility,true);
 assert.equal(gridOntologyState(off,'inference'),'off');assert.equal(gridOntologyState(off,'feasibility'),'on');
 for(const value of ['optional','auto'])assert.throws(()=>updatedGridOntology(next,'inference',value));
});

test('direct ontology API advertises Boolean modules and On/Off metadata',async()=>{
 let p=policy();const tool=planningOntologyDirectTool({runtimeSettings:{get:()=>({planningOntology:p}),update:async x=>(p=x.planningOntology,{planningOntology:p})}});
 const schema=tool.definition.inputSchema.properties.ontology.properties;
 assert.deepEqual(schema.version.enum,[2]);assert.equal(schema.autoSelect,undefined);
 assert.ok(Object.values(schema.modules.properties).every(x=>x.type==='boolean'));
 const metadata=JSON.parse((await tool.execute({action:'get'})).contentItems[0].text);
 assert.deepEqual(metadata.states,['on','off']);
});

test('Chat Directory drafts are explicit On/Off and legacy Auto migrates for the next request',()=>{
 assert.deepEqual(DIRECTORY_MODES,['on','off']);
 assert.deepEqual(SUBAGENT_MODES,['default']);
 const historical={directoryMode:'on',subagentsMode:'off'},frozen=JSON.stringify(historical);
 for(const subagentsMode of ['default','on','off']){
   assert.equal(executionModesFrom({subagentsMode},historical).subagentsMode,'default');
   assert.equal(subagentsEnabledFor(true,subagentsMode),true);
   assert.equal(subagentsEnabledFor(false,subagentsMode),false,'retired modes never bypass runtime capability');
 }
 assert.equal(JSON.stringify(historical),frozen);
 const map=new Map(),storage={getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)};
 assert.equal(readConversationExecutionModes({storage}).directoryMode,'on');
 saveConversationExecutionModes({conversationId:'chat',directoryMode:'off',storage});
 assert.equal(readConversationExecutionModes({conversationId:'chat',storage}).directoryMode,'off');
 assert.equal(readConversationExecutionModes({conversationId:'other',runs:[{executionModes:{directoryMode:'auto'}}],storage}).directoryMode,'on');
 assert.throws(()=>saveConversationExecutionModes({directoryMode:'auto',storage}));
 assert.equal(executionModesFrom({directoryMode:'on'}).directoryMode,'on');
 assert.equal(executionModesFrom({task:'/directory Inspect'}).directoryMode,'on');
 assert.equal(usesDirectory('historical ordinary request','auto'),false,'historical Auto meaning stays interpretable');
});

test('default Directory has no task-wide call quota or arbitrary per-call character cutoff',async()=>temporary(async cwd=>{
 const calls=[];const runner=new ShadowdancerDirectory({cwd,conversationId:'unlimited',runId:'unlimited',model:'fixture',planningOntology:policy(),
  runtime:{runAgent:async options=>{calls.push(options);const phase=JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1));return{output:JSON.stringify(phase.label==='work'?{status:'complete',nextAction:'',finding:'Complete fixture evidence.',candidate_answer:'Complete fixture answer.',uncertainty:''}:{atomic:true})};}},getAuthoritativeContext:()=>('AUTH '.repeat(15000)+'AUTH_TAIL')});
 await runner.open();runner.stats.calls=1000000;runner.stats.planningCalls=1000000;
 await runner.infer('work','modules/large',{text:'DATA '.repeat(20000)+'DATA_TAIL'});
 assert.equal(calls.length,1);assert.match(calls[0].prompt,/AUTH_TAIL/);assert.match(calls[0].prompt,/DATA_TAIL/);
 assert.equal(runner.limits.maxCalls,Infinity);assert.equal(runner.limits.maxPlanningCalls,Infinity);assert.equal(runner.limits.maxContextPages,undefined,'source partitions have no separate page-count quota');
 await runner.plan('1','Perform this bounded work package');assert.equal(calls.length,2,'prior token/call usage must not disable enabled decomposition');
 assert.equal(runner.work.length,1);
}));

test('parallel audit transactions retain every turn without shared-temp collisions',async()=>temporary(async cwd=>{
 const make=id=>new ShadowdancerDirectory({cwd,conversationId:'audit',runId:id,model:'fixture',runtime:{runAgent:async()=>{throw Error('No model should run');}}});
 const a=make('left'),b=make('right');await Promise.all([a.open(),b.open()]);
 await Promise.all(Array.from({length:64},(_,i)=>(i%2?a:b).label('parallel-receipt',{text:'receipt '+i,metadata:{i}})));
 const index=JSON.parse(await readFile(path.join(cwd,'.blackice/directory/audit/conversation/context/turns.json'),'utf8'));
 assert.equal(index.length,64);assert.equal(new Set(index.map(x=>x.id)).size,64);assert.equal(new Set(index.map(x=>x.metadata.i)).size,64);
 const summary=await a.summary();assert.equal(summary.totalTurns,64);
}));

test('context extraction cannot restart operational tools inside every summary page',async()=>temporary(async cwd=>{
 let seen;const runner=new ShadowdancerDirectory({cwd,conversationId:'passive',runId:'passive',model:'gpt-6-luna',runtime:{runAgent:async x=>(seen=x,{output:'{"summary":"source","refs":[]}'})},
  baseTools:[{name:'relay_workspace',inputSchema:{properties:{action:{enum:['read','write']}}}}],dispatchTool:async()=>{throw Error('Extraction must not dispatch task work');}});
 await runner.open();await runner.infer('context-page','context/page',{source:{content:'source'}});
 assert.equal(seen.responseOnly,true);assert.equal(seen.onToolCall,undefined);assert.equal(seen.dynamicTools,undefined);
}));

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
 let i=0;const state={request:{id:'user-request',text:'Finish'},policy:policy(),evidence:{records:[]}};
 const c=createModularCompletionController({policy:policy(),getSnapshot:()=>state,review:async()=>({decision:'continue',summary:'No new outcome',remaining:['actual task'],nextAction:'Perform actual work',evidenceRefs:['user-request'],blockers:[]})});
 for(let attempt=0;attempt<2;attempt++){state.evidence.records.push({id:'read-'+(++i),tool:'relay_workspace',action:'read',target:'same-file',success:true,excerpt:'same bytes'});assert.equal((await c.beforeFinal({output:'Not done'})).continue,true);}
 state.evidence.records.push({id:'read-'+(++i),tool:'relay_workspace',action:'read',target:'same-file',success:true,excerpt:'same bytes'});
 await assert.rejects(c.beforeFinal({output:'Not done'}),{code:'MODULAR_OUTCOME_STALLED'});
});
