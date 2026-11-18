import test from 'node:test';
import assert from 'node:assert/strict';

import {createModularCompletionController} from '../lib/modular-completion.mjs';
const policy={version:2,modules:{inference:true,feasibility:true,decomposition:true,branching:true,replanning:true,metacognition:true,anti_overalignment:true,verification:true,subagents:true}};

test('a reporting contradiction requests response-only repair, not repeated effects',async()=>{
 const snapshot={request:{id:'user-request',text:'Create file'},evidence:{records:[{id:'readback',success:true,excerpt:'exact bytes'}]}};
 const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,review:async()=>({decision:'revise_response',summary:'The report contradicts the recorded read-back.',remaining:[],nextAction:'Correct the report only.',evidenceRefs:['readback'],blockers:[]})});
 const result=await c.beforeFinal({output:'No file was created.'});
 assert.equal(result.continue,true);assert.equal(result.responseOnly,true);assert.match(result.prompt,/DO NOT REPEAT COMPLETED EFFECTS/);
});
