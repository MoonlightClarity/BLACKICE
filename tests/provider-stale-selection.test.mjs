import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { chatOptionChoices } from '../public/next/chat/options-model.mjs';

test('a fresh complete provider listing hides delisted saved IDs from new model choices but preserves historical selections', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-unlisted-model-'));
  let models = ['current-free-model'], catalogReads = 0, catalogFails = false;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || !request.url.startsWith('/v1/models')) {
      response.writeHead(404).end(); return;
    }
    catalogReads++;
    if (catalogFails) { response.writeHead(503, {'content-type':'application/json'}); response.end(JSON.stringify({error:{message:'catalog unavailable'}})); return; }
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify({data:models.map(id => ({id}))}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  const codex = {
    status: () => ({ connected:true, authenticated:true, defaultModel:'codex-test', models:[{id:'codex-test',model:'codex-test',displayName:'Codex test'}], activeTurns:0 }),
    async close() {}
  };
  const runtime = await new ProviderRuntime({ dataDir, codex, modelLimitResolver:{enrich:async (_config, entries)=>entries} }).init();
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await rm(dataDir,{recursive:true,force:true}); });
  await runtime.store.save({ id:'new_free_endpoint', type:'compatible', baseUrl, name:'New Free Endpoint', enabled:true, models:[
    {id:'current-free-model',contextWindowTokens:65536,maxOutputTokens:2048},
    {id:'poolside/laguna-s-2.1:free',contextWindowTokens:65536,maxOutputTokens:2048},
  ] });
  const route = id => 'new_free_endpoint::' + id;
  assert.equal(runtime.status().models.some(model=>model.id===route('poolside/laguna-s-2.1:free')),true,'before verification do not invent a delisting');
  const report = await runtime.discoverModels('new_free_endpoint',{refresh:true});
  assert.equal(report.catalogAvailable,true);
  assert.equal(report.selectedPresence.find(item=>item.id==='poolside/laguna-s-2.1:free').listed,false);
  const after = runtime.status();
  assert.equal(after.models.some(model=>model.id===route('current-free-model')),true);
  assert.equal(after.models.some(model=>model.id===route('poolside/laguna-s-2.1:free')),false,'new-chat choices must not show delisted models');
  assert.equal(after.providers.find(provider=>provider.id==='new_free_endpoint').models.length,2,'saved selections remain editable');
  const historical=chatOptionChoices(after,{model:route('poolside/laguna-s-2.1:free')});
  assert.equal(historical.models.find(model=>model.id===route('poolside/laguna-s-2.1:free')).disabled,true,'past chat retains exact ID but cannot reselect as available');
  assert.equal(chatOptionChoices(after,{model:'default'}).models.some(model=>model.id===route('poolside/laguna-s-2.1:free')),false);

  // Restart loses the memory cache, not the saved provider; startup warmup
  // must perform a new catalog read even with complete saved token limits.
  runtime.modelCatalogs.clear();
  const beforeWarmup = catalogReads;
  await runtime.warmModelLimits();
  assert.ok(catalogReads>beforeWarmup,'startup refreshes catalog even with complete limit metadata');
  assert.equal(runtime.status().models.some(model=>model.id===route('poolside/laguna-s-2.1:free')),false);

  // Failed live catalog is uncertainty, not proof that a provider removed an ID.
  const previous = runtime.modelCatalogs.get('new_free_endpoint');
  runtime.modelCatalogs.set('new_free_endpoint',{...previous,catalogAvailable:false});
  assert.equal(runtime.status().models.some(model=>model.id===route('poolside/laguna-s-2.1:free')),true);
  // When a successful complete listing advertises the model again, it reappears.
  runtime.modelCatalogs.set('new_free_endpoint',{...previous,catalogAvailable:true,models:[{id:'current-free-model'},{id:'poolside/laguna-s-2.1:free'}]});
  assert.equal(runtime.status().models.some(model=>model.id===route('poolside/laguna-s-2.1:free')),true);
});
