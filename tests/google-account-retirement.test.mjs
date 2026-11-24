import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';

test('Google account retirement preserves attribution and blocks native execution', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(),'google-retired-'));
  t.after(() => rm(dataDir,{recursive:true,force:true}));
  const model = 'google-account::gemini-3.8-flash-low';
  const threadId = 'google_account_gemini-3.8-flash-low_00000000-0000-4000-8000-000000000000';
  await writeFile(path.join(dataDir,'providers.json'),JSON.stringify({version:1,defaultModel:model,providers:[]}));
  await writeFile(path.join(dataDir,'google-account-enabled.json'),'true');
  const runtime = await new ProviderRuntime({dataDir,codex:{status:()=>({models:[]})}}).init();
  assert.equal(runtime.store.defaultModel,'codex');
  assert.equal(runtime.status().models.some(row=>row.id.startsWith('google-account::')),false);
  assert.equal(runtime.resolveModel(model).available,false);
  assert.equal(await runtime.savedThreadModel(threadId),model);
  await assert.rejects(runtime.runAgent({threadId}),{code:'SUBSCRIPTION_PROVIDER_RETIRED'});
});
