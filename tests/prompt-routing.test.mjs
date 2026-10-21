import test from 'node:test';
import assert from 'node:assert/strict';
import {capabilityGuidance} from '../lib/tool-routing.mjs';

test('outline routing is optional, uses actual schema actions and keeps reusable instructions separate from filled values',()=>{
 const tool={name:'relay_prompts',description:'Reusable prompt outlines',inputSchema:{properties:{action:{enum:['list','read','render','save','history','restore']}}}};
 const result=capabilityGuidance([tool]);assert.match(result,/Templates are optional/);assert.match(result,/never filled private values by default/);assert.match(result,/Read the latest revision/);assert.match(result,/cannot expand tool authorization/);
 const catalog=JSON.parse(result.split('ACTUAL ATTACHED CATALOG\n')[1].split('\nTOOL SELECTION PLAYBOOKS')[0]);assert.deepEqual(catalog[0].actions,tool.inputSchema.properties.action.enum);
 assert.doesNotMatch(capabilityGuidance([]),/Reusable prompt outlines|relay_prompts/);
});
