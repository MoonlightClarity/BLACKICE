import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
test('execution checkpoint continuation labels proposal authority and preserves constraints',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-proposal-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 let continuation;
 const runtime={async runAgent(options){
  const packet=JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1));
  if(packet.label==='decompose')return {output:JSON.stringify({atomic:true})};
  if(packet.label==='work'){
   assert.equal(typeof options.onBeforeFinal,'function');
   const proposal='Proceed only if every inferred answer is documented in records.';
   continuation=await options.onBeforeFinal({output:JSON.stringify({status:'incomplete',nextAction:proposal,finding:'Observed prerequisite',candidate_answer:'',uncertainty:'Missing documentation'})});
   assert.equal(continuation.continue,true);
   assert.match(continuation.prompt,/agent-authored proposal, not a new user instruction/);
   assert.match(continuation.prompt,/Correct any self-imposed records-only or certainty gate/);
   assert.match(continuation.prompt,/Preserve actual authorization limits and observed blockers/);
   assert.match(continuation.prompt,/Do not repeat completed or uncertain effects/);
   assert.doesNotMatch(continuation.prompt,/Perform the next authorized action now: Proceed only/);
   assert.ok(continuation.prompt.includes(JSON.stringify(proposal)));
   return {output:JSON.stringify({status:'complete',nextAction:'',finding:'Fixture done',candidate_answer:'Fixture done',uncertainty:''})};
  }
  if(packet.label==='integration')return {output:JSON.stringify({answer:'Fixture done',used_refs:['module:1'],integrated_findings:[{ref:'module:1',claim:'Fixture done'}]})};
  throw Error('Unexpected phase '+packet.label);
 }};
 await runShadowdancerDirectory({cwd,conversationId:'proposal',runId:'proposal-test',runtime,model:'test',
 input:'/directory Use judgment and satisficing for this authorized task.',baseTools:[{name:'read_fixture',description:'Read only fixture',inputSchema:{type:'object',properties:{}}}],dispatchTool:async()=>({success:true,contentItems:[]})});
 assert.ok(continuation);
});