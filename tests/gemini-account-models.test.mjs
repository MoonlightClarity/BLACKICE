import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { queryGeminiSession } from '../lib/gemini-account-models.mjs';

function discover(reply) {
  const script = `const lines=require('node:readline').createInterface({ input:process.stdin });
    lines.on('line', line => {
      const req=JSON.parse(line);
      if(req.method==='initialize' && req.params.protocolVersion===1) console.log(JSON.stringify({id:req.id,result:{protocolVersion:1}}));
      else if(req.method==='session/new' && req.params.cwd===process.cwd() && req.params.mcpServers.length===0)
        console.log(JSON.stringify({id:req.id,...${JSON.stringify(reply)}}));
      else process.exit(2);
    });`;
  return queryGeminiSession(spawn(process.execPath,['-e', script], {stdio:['pipe','pipe','ignore']}), process.cwd());
}
test('reads and deduplicates only the returned session choices', async () => {
  const row={modelId:'test-id',name:'Test Model'};
  assert.deepEqual(await discover({result:{models:{availableModels:[row,row]}}}), [{id:'test-id',name:'Test Model'}]);
});
test('reports authentication and empty catalog failures', async () => {
  await assert.rejects(discover({error:{code:-32000}}), /sign in with Google/);
  await assert.rejects(discover({result:{models:{availableModels:[]}}}), /no account model choices/);
});