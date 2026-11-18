import test from 'node:test';
import assert from 'node:assert/strict';
import {contextSnapshot,normalizeContextOptions,nativeContextSnapshot} from '../lib/context.mjs';

test('current context snapshots honor explicit native capacity and unknown-capacity enforcement',()=>{
  const model={id:'native',contextWindowTokens:272000,runtimeDefaultContextWindowTokens:272000,maxContextWindowTokens:872000,effectiveContextWindowPercent:95,contextWindowSource:'runtime-reported'};
  const selected=nativeContextSnapshot({model,options:{preset:'extended'}});
  assert.equal(selected.preset,'extended');
  assert.equal(selected.inputBudgetTokens,872000*.95-8192-8192);
  const explicit=nativeContextSnapshot({model,options:{preset:'custom',windowTokens:96000}});
  assert.equal(explicit.nativeConfiguredWindowTokens,96000,'an intentional conversation override remains available');
  const snapshot=contextSnapshot({options:{enforceKnownCapacityOnly:true},messages:['x'.repeat(600000)]});
  assert.equal(snapshot.effectiveWindowTokens,null);
  assert.equal(snapshot.windowSource,'unresolved');
  assert.ok(snapshot.estimatedInputTokens<snapshot.inputBudgetTokens,'unknown long-context models have no invented 128K ceiling');
  assert.equal(snapshot.compactAtTokens,Infinity);
  assert.equal(normalizeContextOptions({preset:'custom',windowTokens:8000000}).windowTokens,8000000);
});
