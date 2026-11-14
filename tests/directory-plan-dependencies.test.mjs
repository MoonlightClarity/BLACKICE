import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveDirectoryDependencies as resolve} from '../lib/directory-plan-dependencies.mjs';
import {runPreparedDirectoryAgent} from '../lib/shadowdancer-engine.mjs';

test('named siblings preserve dependencies alongside numeric IDs and explicit independence', () => {
  assert.deepEqual(resolve('1.1', [{id:'brief'}, {id:'asset',depends_on:['brief','1','1.1.1']}, {depends_on:[]}, {}]),
    [[],['1.1.1'],[],['1.1.3']]);
});

test('unknown, ambiguous, self, forward and malformed dependencies reject the split', () => {
  for (const steps of [
    [{id:'brief'}, {depends_on:['missing']}],
    [{id:'same'}, {id:'same'}],
    [{depends_on:['1']}],
    [{depends_on:['2']}, {}],
    [{id:'2'}, {}],
    [{}, {depends_on:'1'}],
    [{}, {depends_on:['1.1.1']}],
  ]) assert.equal(resolve('1',steps),null);
});

for (const invalid of [false,true]) test(invalid ? 'invalid Directory dependency retains the root task without partial child work' : 'Directory imports the exact named prerequisite into a fresh asset worker', async () => {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-named-dependency-'));
  const worked=[];
  try {
    const runtime={runAgent:async options=>{
      const marker='CURRENT_DIRECTORY:\n';
      const input=JSON.parse(options.prompt.slice(options.prompt.indexOf(marker)+marker.length));
      if(input.label==='decompose') return {output:JSON.stringify(input.payload.depth===1 ?
        {atomic:false,steps:[{id:'shared_brief',objective:'Define the brief',done_when:'Brief recorded'},
          {id:'asset',objective:'Create the asset',done_when:'Asset recorded',depends_on:[invalid?'missing':'shared_brief']}]} : {atomic:true})};
      if(input.label==='work') {
        worked.push(input.payload.objective);
        if(input.payload.objective==='Create the asset') {
          assert.equal(input.payload.imports.length,1);
          assert.equal(input.payload.imports[0].candidate_answer,'brief-token-741');
          assert.equal(input.payload.imports[0].ref,'module:1.1');
        }
        return {output:JSON.stringify({status:'complete',nextAction:'',finding:'Recorded',candidate_answer:'brief-token-741',uncertainty:''})};
      }
      return {output:JSON.stringify({answer:'Done',used_refs:input.payload.required_refs})};
    }};
    await runPreparedDirectoryAgent({runtime,input:'/directory Prepare a brief and create an asset.',conversationId:'named',runId:'named-run',model:'fixture',
      planningOntology:{version:2,modules:{decomposition:true}},options:{cwd,model:'fixture'}});
    assert.deepEqual(worked,invalid?['Prepare a brief and create an asset.']:['Define the brief','Create the asset']);
  } finally { await rm(cwd,{recursive:true,force:true}); }
});
