import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleActivationReceipt} from '../lib/module-activation-receipt.mjs';
import {normalizePlanningOntology,planningOntologyInstructions} from '../public/planning-module-policy.mjs';
const policy=normalizePlanningOntology({version:2,modules:{anti_overalignment:true,time_management:true}});
test('Planning Off retains configured choices but never labels them injected',()=>{
 const r=moduleActivationReceipt({configuredPolicy:policy,effectivePolicy:null,instructions:'Off',tools:[{name:'relay_delegate'}]});
 for(const id of ['time_management','anti_overalignment']) {
  const m=r.modules.find(x=>x.id===id);assert.equal(m.configured,true);assert.equal(m.effective,false);assert.equal(m.instructionIncluded,false);
 }
 assert.equal(r.modules.find(x=>x.id==='subagents').toolAttached,true);
 assert.equal(r.adherence,'unverified');assert.equal(r.state,'prepared');
});
test('effective policy and exact composed instructions establish inclusion',()=>{
 const instructions=planningOntologyInstructions(policy);
 const r=moduleActivationReceipt({configuredPolicy:policy,effectivePolicy:policy,instructions});
 assert.equal(r.modules.find(x=>x.id==='anti_overalignment').instructionIncluded,true);
 assert.equal(r.modules.find(x=>x.id==='verification').instructionIncluded,false);
 assert.equal(r.developerInstructionsSha256.length,64);
 const missing=moduleActivationReceipt({effectivePolicy:policy,instructions:'not included'});
 assert.equal(missing.modules.find(x=>x.id==='anti_overalignment').instructionIncluded,false);
 assert.notEqual(missing.developerInstructionsSha256,r.developerInstructionsSha256);
});
