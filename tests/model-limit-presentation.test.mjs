import test from 'node:test';
import assert from 'node:assert/strict';
import {modelLimitDetails,modelLimitReferences,modelLimitLookupSummary} from '../public/provider-catalog.mjs';
import {providerModelsForSave,mergeDiscoveredProviderModels,createProviderModelSelection,codexModelSourceLabel} from '../public/connection-models.mjs';
import {renderContextStatus} from '../public/context-ui.mjs';

const date='2026-10-30T12:00:00Z';
const evidence={label:'Official model catalog',modelId:'underlying-model',url:'https://models.example/catalog/underlying-model',endpointSpecific:false};
const reference={id:'alias',displayName:'Alias',contextWindowTokens:200000,contextWindowSource:'model-reference',contextWindowObservedAt:date,contextWindowEvidence:evidence,
  maxOutputTokens:32000,maxOutputTokensSource:'model-reference',maxOutputObservedAt:date,maxOutputEvidence:evidence,
  modelLimitLookup:{status:'resolved',checkedAt:date,sources:[{id:'official',label:'Official model catalog',status:'found',url:evidence.url}]}};

test('retrieved capacities retain their source, date and endpoint caveat; runtime default and maximum stay distinct',()=>{
  const before=structuredClone(reference),details=Object.fromEntries(modelLimitDetails(reference));
  assert.match(details['Context window'],/200,000 tokens · Model reference · Official model catalog · Endpoint unconfirmed · Observed 2026-10-30 12:00:00 UTC/);
  assert.match(details['Max output'],/32,000 tokens · Model reference/);assert.deepEqual(reference,before);
  const native=Object.fromEntries(modelLimitDetails({contextWindowTokens:196000,contextWindowSource:'runtime-reported',contextWindowObservedAt:date,
    contextWindowEvidence:{label:'Codex runtime metadata',modelId:'native',path:'C:\\runtime\\models.json',endpointSpecific:true},runtimeDefaultContextWindowTokens:196000,maxContextWindowTokens:1000000}));
  assert.match(native['Context window'],/^196,000 tokens · Runtime reported/);
  assert.equal(native['Runtime default context'],'196,000 tokens');assert.equal(native['Maximum supported context'],'1,000,000 tokens');
  assert.doesNotMatch(native['Context window'],/1,000,000|User configured|Endpoint unconfirmed/);
});

test('missing limits distinguish no lookup, unsuccessful lookup and unavailable sources',()=>{
  assert.match(modelLimitDetails({})[0][1],/lookup not run/);
  assert.match(modelLimitDetails({modelLimitLookup:{status:'unresolved',checkedAt:date}})[0][1],/not found after lookup/);
  const failed={modelLimitLookup:{status:'unavailable',checkedAt:date,reason:'Catalog timed out.',sources:[{id:'runtime',label:'Runtime metadata',status:'unavailable'}]}};
  assert.match(modelLimitDetails(failed)[0][1],/lookup unavailable/);
  assert.match(modelLimitLookupSummary(failed),/Catalog timed out.*Checked 2026-10-30 12:00:00 UTC.*Runtime metadata: unavailable/);
  assert.equal(modelLimitLookupSummary(reference),'');assert.doesNotThrow(()=>modelLimitDetails(null));
  assert.doesNotMatch(modelLimitDetails({contextWindowTokens:100,contextWindowSource:'runtime-reported',contextWindowObservedAt:'invalid'})[0][1],/Observed|Invalid/);
});

test('evidence links are deduplicated and restricted to HTTP URLs without embedded credentials',()=>{
  assert.deepEqual(modelLimitReferences(reference),[{label:'Official model catalog · underlying-model',url:evidence.url}]);
  for(const url of ['javascript:alert(1)','data:text/html,bad','file:///etc/passwd','https://secret:token@models.example/catalog']){
    assert.deepEqual(modelLimitReferences({...reference,contextWindowEvidence:{...evidence,url},maxOutputEvidence:{...evidence,url}}),[]);
  }
  assert.deepEqual(modelLimitReferences({...reference,contextWindowSource:'user-configured',maxOutputTokens:null}),[]);
  assert.deepEqual(modelLimitReferences({contextWindowTokens:100,contextWindowSource:'runtime-reported',contextWindowEvidence:{label:'Local runtime metadata',path:'C:\\runtime\\models.json'}}),[{label:'Local runtime metadata',path:'C:\\runtime\\models.json'}]);
  assert.doesNotThrow(()=>modelLimitReferences({modelLimitLookup:{status:'unresolved',sources:{bad:true}}}));
  const missing={modelLimitLookup:{status:'unresolved',sources:[{id:'official',label:'Official catalog',status:'not-found',url:evidence.url}]}};
  assert.equal(modelLimitReferences(missing)[0].label,'Official catalog · not found');
});

test('saving unchanged retrieved models preserves evidence and lookup state; a manual context edit overrides only that field',()=>{
  const saved=providerModelsForSave('alias','alias = 200000',[reference],[reference]);
  assert.deepEqual(saved,[reference]);assert.notEqual(saved[0].contextWindowEvidence,reference.contextWindowEvidence);assert.notEqual(saved[0].modelLimitLookup,reference.modelLimitLookup);
  const edited=providerModelsForSave('alias','alias = 180000',[reference],[reference])[0];
  assert.equal(edited.contextWindowTokens,180000);assert.equal(edited.contextWindowSource,'user-configured');
  assert.equal(edited.contextWindowEvidence,undefined);assert.equal(edited.contextWindowObservedAt,undefined);
  assert.deepEqual(edited.maxOutputEvidence,evidence);assert.equal(edited.maxOutputTokensSource,'model-reference');
  const native={...reference,contextWindowSource:'runtime-reported',contextWindowEvidence:{...evidence,endpointSpecific:true},maxContextWindowTokens:1000000,runtimeDefaultContextWindowTokens:200000};
  assert.deepEqual(providerModelsForSave('alias','',[native]),[native]);
});

test('a refreshed sourced capacity beats an untouched old capacity line, while explicit manual overrides survive metadata refresh',()=>{
  const latest={...reference,contextWindowTokens:400000,contextWindowSource:'runtime-reported',contextWindowEvidence:{...evidence,label:'Runtime',endpointSpecific:true},contextWindowObservedAt:'2026-10-30T13:00:00Z'};
  assert.deepEqual(providerModelsForSave('alias','alias = 200000',[latest],[reference]),[latest]);
  const manual={...reference,contextWindowTokens:123456,contextWindowSource:'user-configured'};delete manual.contextWindowEvidence;delete manual.contextWindowObservedAt;
  const merged=mergeDiscoveredProviderModels([manual],[latest])[0];
  assert.equal(merged.contextWindowTokens,123456);assert.equal(merged.contextWindowSource,'user-configured');assert.equal(merged.contextWindowEvidence,undefined);
  const changed=mergeDiscoveredProviderModels([reference],[{id:'alias',contextWindowTokens:80000,contextWindowSource:'provider-reported'}])[0];
  assert.equal(changed.contextWindowEvidence,undefined);assert.equal(changed.contextWindowObservedAt,undefined);
});

test('metadata refresh updates selected models outside the current page without selecting extra IDs or dropping known limits',()=>{
  const selection=createProviderModelSelection([reference]);selection.setPage([{id:'different-page-model'}]);
  selection.mergeMetadata([{...reference,contextWindowTokens:300000},{id:'not-selected',contextWindowTokens:1000}]);
  assert.deepEqual(selection.selected().map(model=>model.id),['alias']);assert.equal(selection.selected()[0].contextWindowTokens,300000);
  assert.deepEqual(selection.page().map(model=>model.id),['different-page-model']);
  const lookup={status:'unavailable',checkedAt:date,sources:[]};selection.mergeMetadata([{id:'alias',contextWindowTokens:null,contextWindowSource:'unknown',modelLimitLookup:lookup}]);
  assert.equal(selection.selected()[0].contextWindowTokens,300000);assert.deepEqual(selection.selected()[0].contextWindowEvidence,evidence);assert.deepEqual(selection.selected()[0].modelLimitLookup,lookup);
});

test('context usage renders retrieved runtime and unconfirmed reference capacities separately from working budgets',()=>{
  const shared={inputBudgetTokens:128000,effectiveWindowTokens:150000,estimatedInputTokens:1000};
  const runtime=renderContextStatus({...shared,windowSource:'runtime-reported',modelWindowTokens:200000});
  assert.match(runtime,/Runtime context window<\/dt><dd>200,000/);assert.match(runtime,/Runtime-reported capacity/);
  const referenced=renderContextStatus({...shared,windowSource:'model-reference',modelWindowTokens:null,configuredModelWindowTokens:400000});
  assert.match(referenced,/Model reference window<\/dt><dd>400,000/);assert.match(referenced,/Model reference · endpoint unconfirmed/);assert.match(referenced,/Usable input budget<\/dt><dd>128,000/);
  assert.doesNotMatch(referenced,/User-configured window|Provider-reported capacity/);
  const unknown=renderContextStatus({...shared,windowSource:'working-budget',modelWindowTokens:null});assert.match(unknown,/Unknown · no retrieved limit/);assert.doesNotMatch(unknown,/Model reported<\/dt><dd>150,000/);
  assert.match(codexModelSourceLabel({source:'runtime-candidate'}),/Runtime metadata candidate · not advertised/);
});
