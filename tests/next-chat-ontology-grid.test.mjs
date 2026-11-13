import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizePlanningOntology,PLANNING_MODULE_STATES,PLANNING_ONTOLOGY_MODULES,planningOntologyInstructions} from '../public/planning-module-policy.mjs';
import {readConversationOntology,saveConversationOntology,transferNewOntology,updatedGridOntology,gridOntologyState} from '../public/next/chat/ontology-preferences.mjs';
import {createChatFrame} from '../public/next/chat/render.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';

const storage=()=>{const m=new Map();return{getItem:key=>m.get(key)??null,setItem:(key,value)=>m.set(key,value),removeItem:key=>m.delete(key),entries:()=>[...m.entries()]};};

test('small grid contains configurable module choices in a compact disclosure',t=>{
 const dom=planningDOM(t),frame=createChatFrame(dom.mount);
 assert.equal(frame.ontologyInline.id,'next-chat-ontology-inline');assert.equal(frame.ontologyModules.id,'next-chat-ontology-modules');
 assert.equal(frame.ontologyInline.hidden,false);assert.equal(frame.ontologyInline.tagName,'DETAILS');assert.equal(frame.ontologyInline.open,false);
 assert.equal(frame.ontologyInline.hasAttribute('open'),false);assert.ok(frame.ontologyInline.querySelector('summary'));
 assert.match(frame.ontologyInline.querySelector('summary').textContent,/On \/ Off/);assert.equal(frame.ontologyModules.closest('details'),frame.ontologyInline);
 assert.equal(frame.ontologyAuto,undefined);assert.equal(frame.ontologyToggle,undefined);
 assert.equal(frame.subagentsMode,undefined);assert.equal(dom.$('#next-chat-subagents-mode'),null);
 assert.doesNotMatch(frame.shell.innerHTML,/M\/O\/F|value="auto"|Configure modules|next-chat-ontology-panel/);
 assert.equal(PLANNING_ONTOLOGY_MODULES.length,9);assert.deepEqual(PLANNING_MODULE_STATES,['on','off']);
 const css=readFileSync(new URL('../public/next/chat.css',import.meta.url),'utf8');assert.match(css,/\.next-chat-ontology-grid\s*\{display:grid;grid-template-columns:repeat\(3/);assert.match(css,/\.next-chat-ontology-choice>input\{appearance:auto/);
});
test('every Chat module import is registered with the server',()=>{
 const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 for(const route of ["'chat/chat.mjs'","'chat/ontology-preferences.mjs'","'chat/reader-model.mjs'","'planning-module-policy.mjs'"])assert.ok(server.includes(route),'Missing '+route);
});
test('one Boolean module edit preserves every unrelated choice',()=>{
 const defaults=normalizePlanningOntology({version:2,modules:{verification:true}});assert.equal(defaults.modules.verification,true);assert.equal(defaults.modules.inference,false);
 const off=updatedGridOntology(defaults,'verification','off');assert.equal(off.modules.verification,false);assert.equal(gridOntologyState(off,'verification'),'off');
 for(const {id} of PLANNING_ONTOLOGY_MODULES)if(id!=='verification')assert.equal(off.modules[id],defaults.modules[id]);
 const on=updatedGridOntology(off,'verification','on');assert.deepEqual(on,defaults);assert.equal('autoSelect' in on,false);
 assert.doesNotMatch(planningOntologyInstructions(on),/AUTOMATIC SELECTION|MANDATORY:|OPTIONAL:|FORBIDDEN:/);
 for(const choice of ['auto','optional','mandatory','forbidden','enabled'])assert.throws(()=>updatedGridOntology(defaults,'verification',choice));
 assert.throws(()=>updatedGridOntology(defaults,'unknown','on'));
});
test('legacy choices preserve configurable prohibitions and reset retired subagent overrides',()=>{
 const historical={version:1,autoSelect:true,modules:{verification:'optional',inference:'auto',anti_overalignment:'mandatory',feasibility:'forbidden',subagents:'forbidden'}},before=JSON.stringify(historical);
 const normalized=normalizePlanningOntology(historical);assert.equal(normalized.version,2);assert.equal('autoSelect'in normalized,false);
 assert.equal(normalized.modules.verification,true);assert.equal(normalized.modules.inference,true);assert.equal(normalized.modules.anti_overalignment,true);assert.equal(normalized.modules.subagents,true);assert.equal(normalized.modules.feasibility,false);
 const changed=updatedGridOntology(normalized,'verification','off');assert.equal(changed.modules.verification,false);assert.equal(changed.modules.inference,true);assert.equal(changed.modules.subagents,true);assert.equal(JSON.stringify(historical),before);
});
test('conversation draft > saved run > defaults with no cross-chat leakage',()=>{
 const mem=storage(),defaults=normalizePlanningOntology({version:2,modules:{decomposition:false}}),saved=normalizePlanningOntology({version:2,modules:{decomposition:true}}),draft=normalizePlanningOntology({version:2,modules:{decomposition:false}});
 const first=readConversationOntology({conversationId:'one',storage:mem,defaults});assert.equal(first.planningOntology.modules.decomposition,false);assert.equal(first.source,'defaults');
 const runs=[{id:'a1',planningMode:'off',planningOntology:saved}],frozen=JSON.stringify(runs);
 const restored=readConversationOntology({conversationId:'one',storage:mem,defaults,runs});assert.equal(restored.planningMode,'ontology');assert.equal(restored.planningOntology.modules.decomposition,true);assert.equal(restored.source,'conversation-run');
 saveConversationOntology({conversationId:'one',storage:mem,planningMode:'ontology',planningOntology:draft});
 const edited=readConversationOntology({conversationId:'one',storage:mem,defaults,runs});assert.equal(edited.source,'conversation-draft');assert.equal(edited.planningOntology.modules.decomposition,false);assert.equal(JSON.stringify(runs),frozen);
 assert.equal(readConversationOntology({conversationId:'two',storage:mem,defaults:saved}).planningOntology.modules.decomposition,true);
 assert.equal(readConversationOntology({conversationId:'two',storage:mem,runs:[{id:'r2',planningMode:'off'}],defaults}).planningMode,'off');
 const followup=readConversationOntology({conversationId:'one',storage:mem,runs:[...runs,{id:'a2',planningMode:'off'}],defaults:saved});assert.equal(followup.planningMode,'ontology');assert.equal(followup.planningOntology.modules.decomposition,false);
});
test('draft choices transfer to the new saved chat without becoming global defaults',()=>{
 const mem=storage(),policy=normalizePlanningOntology({version:2,modules:{branching:true}});saveConversationOntology({conversationId:'new',storage:mem,planningOntology:policy});
 assert.equal(transferNewOntology({conversationId:'conversation_1',storage:mem}),true);assert.equal(readConversationOntology({conversationId:'conversation_1',storage:mem}).planningOntology.modules.branching,true);
 assert.equal(readConversationOntology({conversationId:'new',storage:mem}).planningOntology.modules.branching,false);assert.equal(transferNewOntology({conversationId:'conversation_1',storage:mem}),false);
});
test('worker projects saved per-run policy without exposing private traces',()=>{
 const policy=normalizePlanningOntology({version:2,modules:{inference:false,subagents:true}});
 const family=projectFamily({runs:[{id:'run_1',taskId:'conversation_1',planningMode:'off',planningOntology:policy,status:'completed',settled:true,createdAt:'2026-11-11T12:00:00Z',input:'Work',events:[],workflow:{nodes:[]},nodes:{},privateTrace:'never serialize'}]});
 assert.deepEqual(family.runs[0].planningOntology,policy);assert.equal(family.runs[0].planningMode,'off');assert.doesNotMatch(JSON.stringify(family),/never serialize/);
});
