import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeAccountModels } from '../lib/claude-account-models.mjs';
test('signed-out sessions cannot supply account choices', async () => {
  let calls = 0;
  await assert.rejects(claudeAccountModels({file:'fixture', run:async () => { calls++; return '{"loggedIn":false}'; }}), /Sign in/);
  assert.equal(calls,1);
});
test('reads signed-in model choices from initialization alone', async () => {
  const run = async (_file,args,_cwd,input) => {
    if (args[0] === 'auth') return '{"loggedIn":true,"authMethod":"claude.ai"}';
    const req = JSON.parse(input);
    assert.deepEqual(req.request,{subtype:'initialize'});
    return JSON.stringify({type:'control_response',response:{request_id:req.request_id,subtype:'success',response:{models:[{value:'opus',displayName:'Opus'}]}}});
  };
  assert.deepEqual(await claudeAccountModels({file:'fixture',run}),[{id:'opus',name:'Opus'}]);
});
