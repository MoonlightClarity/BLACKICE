import test from 'node:test';
import assert from 'node:assert/strict';
import {capabilityGuidance} from '../lib/tool-routing.mjs';

test('outline routing lists only attached tools and preserves their supported schema actions',()=>{
 const actions=['list','read','render','save','history','restore'];
 const tool={name:'relay_prompts',description:'Reusable prompt outlines',inputSchema:{properties:{action:{enum:[...actions]}}}};
 const before=structuredClone(tool),result=capabilityGuidance([tool]);
 const catalog=result.split('\nATTACHED TOOLS\n')[1].split('\nADAPTER NOTES\n')[0].split(', ');
 assert.deepEqual(catalog,['relay_prompts']);assert.deepEqual(tool,before,'Routing leaves the attached tool schema unchanged.');
 assert.deepEqual(tool.inputSchema.properties.action.enum,actions);
 assert.match(result,/Read the selected template and revision/);assert.match(result,/Render supplies editable task text/);
 assert.match(result,/templates do not impose new task requirements/);assert.doesNotMatch(result,/ACTUAL ATTACHED CATALOG|inputSchema/);
 assert.doesNotMatch(capabilityGuidance([]),/Reusable prompt outlines|relay_prompts/);
});
