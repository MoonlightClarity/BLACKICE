import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizePlanningOntology,PLANNING_MODULE_STATES,PLANNING_ONTOLOGY_MODULES,planningOntologyInstructions} from '../public/planning-module-policy.mjs';
import {readConversationOntology,saveConversationOntology,transferNewOntology,updatedGridOntology,gridOntologyState} from '../public/next/chat/ontology-preferences.mjs';
import {createChatFrame} from '../public/next/chat/render.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';

const storage=()=>{const m=new Map();return{getItem:key=>m.get(key)??null,setItem:(key,value)=>m.set(key,value),removeItem:key=>m.delete(key),entries:()=>[...m.entries()]};};

test('small grid exposes every module as an independent M/O/F/Auto checkbox choice',t=>{
 const dom=planningDOM(t),frame=createChatFrame(dom.mount);
 assert.equal(frame.ontologyInline?.id,'next-chat-ontology-inline');
 assert.equal(frame.ontologyModules?.id,'next-chat-ontology-modules');
 assert.equal(frame.ontologyInline.hidden,false);
 assert.equal(frame.ontologyInline.tagName,'DETAILS');
 assert.equal(frame.ontologyInline.open,false,'modules are collapsed on initial render');
 assert.equal(frame.ontologyInline.hasAttribute('open'),false);
 assert.ok(frame.ontologyInline.querySelector('summary'),'native summary gives a keyboard-accessible expand/collapse control');
 assert.match(frame.ontologyInline.querySelector('summary').textContent,/Modules/);
 assert.equal(frame.ontologyModules.closest('details'),frame.ontologyInline,'the entire checkbox grid stays inside the disclosure');
 assert.equal(frame.ontologyAuto,undefined,'no global model-selection checkbox');
 assert.equal(frame.ontologyToggle,undefined,'the oversized configuration panel is gone');
 assert.doesNotMatch(frame.shell.innerHTML,/Configure modules|Mandatory, Optional or Forbidden per module|next-chat-ontology-panel/);
 assert.equal(PLANNING_ONTOLOGY_MODULES.length,9);
 assert.deepEqual(PLANNING_MODULE_STATES,['mandatory','optional','forbidden','auto']);
 const css=readFileSync(new URL('../public/next/chat.css',import.meta.url),'utf8');
 assert.match(css,/\.next-chat-ontology-grid\s*\{display:grid;grid-template-columns:repeat\(3/);
 assert.match(css,/\.next-chat-ontology-choice>input\{appearance:auto/);
});

test('the Chat module and every new browser import are registered with the server static allowlist',()=>{
 const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 for(const route of ["'chat/chat.mjs'","'chat/ontology-preferences.mjs'","'chat/reader-model.mjs'","'planning-module-policy.mjs'"])
   assert.ok(server.includes(route),'Missing served module '+route);
});

test('one module selection affects only that cell, preserving unrelated user selections',()=>{
 const defaults=normalizePlanningOntology();
 assert.equal(defaults.modules.anti_overalignment,'mandatory');
 assert.equal(defaults.modules.inference,'auto');
 const candidate=updatedGridOntology(defaults,'verification','forbidden');
 assert.equal(candidate.modules.verification,'forbidden');
 assert.equal(candidate.modules.inference,'auto');
 assert.equal(candidate.modules.anti_overalignment,'mandatory');
 assert.equal(gridOntologyState(candidate,'verification'),'forbidden');
 const mandatory=updatedGridOntology(candidate,'subagents','mandatory');
 assert.equal(mandatory.modules.subagents,'mandatory');
 assert.equal(mandatory.modules.verification,'forbidden');
 const optional=updatedGridOntology(mandatory,'verification','optional');
 assert.equal(gridOntologyState(optional,'verification'),'optional');
 assert.equal(optional.autoSelect,false);
 const automatic=updatedGridOntology(optional,'verification','auto');
 assert.equal(gridOntologyState(automatic,'verification'),'auto');
 assert.match(planningOntologyInstructions(automatic),/AUTOMATIC SELECTION[\s\S]*Outcome verification/);
 assert.throws(()=>updatedGridOntology(defaults,'verification','enabled'),/Choose a known module/);
 assert.throws(()=>updatedGridOntology(defaults,'made_up','auto'),/Choose a known module/);
});

test('editing a legacy Auto-all policy freezes only its explicit user choices',()=>{
 const historical=normalizePlanningOntology({autoSelect:true,modules:{verification:'optional',anti_overalignment:'mandatory',inference:'optional'}});
 assert.equal(gridOntologyState(historical,'verification'),'auto');
 const changed=updatedGridOntology(historical,'verification','forbidden');
 assert.equal(changed.autoSelect,false);
 assert.equal(changed.modules.verification,'forbidden');
 assert.equal(changed.modules.inference,'auto','unrelated old automatic selection must remain automatic');
 assert.equal(changed.modules.anti_overalignment,'mandatory');
});

test('conversation draft > saved conversation run > application defaults, with no cross-chat leakage',()=>{
 const mem=storage();
 const defaults=normalizePlanningOntology({modules:{decomposition:'forbidden'}});
 const savedA=normalizePlanningOntology({modules:{decomposition:'mandatory'}});
 const draftA=normalizePlanningOntology({modules:{decomposition:'optional'}});
 const initial=readConversationOntology({conversationId:'one',storage:mem,defaults});
 assert.equal(initial.planningOntology.modules.decomposition,'forbidden');
 assert.equal(initial.source,'defaults');
 const runA=[{id:'a1',planningMode:'off',planningOntology:savedA}];
 const restored=readConversationOntology({conversationId:'one',storage:mem,defaults,runs:runA});
 assert.equal(restored.planningMode,'ontology');
 assert.equal(restored.planningOntology.modules.decomposition,'mandatory');
 assert.equal(restored.source,'conversation-run');
 saveConversationOntology({conversationId:'one',storage:mem,planningMode:'ontology',planningOntology:draftA});
 const edited=readConversationOntology({conversationId:'one',storage:mem,defaults,runs:runA});
 assert.equal(edited.source,'conversation-draft');
 assert.equal(edited.planningOntology.modules.decomposition,'optional');
 assert.equal(readConversationOntology({conversationId:'two',storage:mem,defaults}).planningOntology.modules.decomposition,'forbidden');
 assert.equal(readConversationOntology({conversationId:'two',storage:mem,runs:[{id:'r2',planningMode:'off'}],defaults}).planningMode,'off');
 assert.equal(readConversationOntology({conversationId:'two',storage:mem,runs:[{id:'r2',planningMode:'on',planningEnforcement:'forced'}],defaults}).planningMode,'ontology');
 const followup=readConversationOntology({conversationId:'one',storage:mem,
  runs:[{id:'a1',planningOntology:savedA},{id:'a2',planningMode:'off'}],defaults});
 assert.equal(followup.planningMode,'ontology','conversation override remains authoritative');
 assert.equal(followup.planningOntology.modules.decomposition,'optional');
});

test('draft selection transfers into its new saved chat and new chat returns to defaults',()=>{
 const mem=storage(),policy=normalizePlanningOntology({modules:{branching:'mandatory'}});
 saveConversationOntology({conversationId:'new',storage:mem,planningOntology:policy});
 assert.equal(transferNewOntology({conversationId:'conversation_1',storage:mem}),true);
 assert.equal(readConversationOntology({conversationId:'conversation_1',storage:mem}).planningOntology.modules.branching,'mandatory');
 assert.equal(readConversationOntology({conversationId:'new',storage:mem}).planningOntology.modules.branching,'auto');
 assert.equal(transferNewOntology({conversationId:'conversation_1',storage:mem}),false);
});

test('worker projects saved per-run ontology without exposing private traces',()=>{
 const policy=normalizePlanningOntology({modules:{inference:'forbidden',subagents:'mandatory'}});
 const family=projectFamily({runs:[{id:'run_1',taskId:'conversation_1',planningMode:'off',planningOntology:policy,
   status:'completed',settled:true,createdAt:'2026-11-11T12:00:00Z',input:'Work',events:[],
   workflow:{nodes:[]},nodes:{},privateTrace:'never serialize'}]});
 assert.deepEqual(family.runs[0].planningOntology,policy);
 assert.equal(family.runs[0].planningMode,'off');
 assert.doesNotMatch(JSON.stringify(family),/never serialize/);
});
