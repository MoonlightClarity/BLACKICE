import test from 'node:test';
import assert from 'node:assert/strict';
import {reasoningChoices,reasoningSupport} from '../public/reasoning-model.mjs';
import {createMissionWorkflow,modelFailure} from '../public/mission-model.mjs';
import {validateWorkflow} from '../lib/engine.mjs';
import {providerModelIssues,renderProviderModelRows} from '../public/connections-ui.mjs';
const status={defaultModel:'deep',models:[{id:'deep',supportedReasoningEfforts:[{reasoningEffort:'max'},{reasoningEffort:'ultra'}]},{id:'fast',displayName:'Fast',supportedReasoningEfforts:['low','medium']}]};
test('advertised max and ultra are preserved; changing to a narrower model keeps the explicit selection actionable',()=>{
  assert.deepEqual(reasoningChoices(status).map(item=>item.value),['default','max','ultra']);
  assert.equal(reasoningSupport(status,'deep','ultra').available,true);
  const unsupported=reasoningChoices(status,'fast','ultra').find(item=>item.value==='ultra');
  assert.equal(unsupported.available,false);assert.match(unsupported.error,/Fast.*Ultra/);
  assert.equal(reasoningSupport(status,'fast','default').available,true);
});
test('unknown API catalogs allow exact levels without claiming provider support',()=>{
  assert.equal(reasoningSupport({},'gateway::custom','ultra').available,true);
  assert.equal(reasoningSupport({},'gateway::custom','ultra').verified,false);
  assert.equal(reasoningSupport({},'gateway::custom','invented').available,false);
});
test('new chat inherits app reasoning while explicit model default, max and ultra survive workflow validation',()=>{
  const graph=effort=>validateWorkflow(createMissionWorkflow({id:'reasoning-fixture',task:'Reason carefully.',model:'deep',...(effort?{effort}:{})}));
  assert.equal(graph().nodes[1].effort,undefined);assert.equal(graph('default').nodes[1].effort,'default');
  for(const effort of ['max','ultra'])assert.equal(graph(effort).nodes[1].effort,effort);
});
test('request failures stay with their run; model warnings remain isolated and shared failures apply to siblings',()=>{
  const restricted={message:'Restricted model',scope:'model'},request={message:'This input is too long',scope:'request'};
  const provider={id:'gateway',models:[{id:'good'},{id:'restricted'},{id:'long'}],modelChecks:{restricted:{lastFailure:restricted},long:{lastFailure:request},removed:{lastFailure:restricted}}};
  const modelStatus={defaultModel:'gateway::good',providers:[provider]};
  assert.equal(modelFailure(modelStatus),null);assert.equal(modelFailure(modelStatus,'gateway::restricted'),restricted);assert.equal(modelFailure(modelStatus,'gateway::long'),null);
  assert.deepEqual(providerModelIssues(provider).map(([id])=>id),['restricted']);
  provider.lastFailure={message:'Account key expired',scope:'connection'};
  assert.equal(modelFailure(modelStatus),provider.lastFailure);
  const rows=renderProviderModelRows([{id:'restricted',lastFailure:{message:'<untrusted model error>',scope:'model'}}]);
  assert.match(rows,/&lt;untrusted model error&gt;/);assert.ok(!rows.includes('<untrusted'));
});
