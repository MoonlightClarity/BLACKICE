import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProviderRuntime } from '../lib/providers.mjs';
import { createInstructionAudit, withPreparedAdapterInstructions } from '../lib/instruction-audit.mjs';

class Native extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'native', models: [{ model: 'native' }] }; }
  async close() {}
  async runAgent() { throw Error('This fixture cannot start native inference.'); }
}
const before = { inputBudgetTokens: 20000, outputReserveTokens: 2000, headroomTokens: 100, effectiveWindowTokens: 32000 };
const spec = { name: 'fixture_read', description: 'Read the synthetic fixture.', inputSchema: { type: 'object', properties: {} } };

async function fixture(t, content, { fail = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'instruction-summary-')), requests = [];
  const runtime = await new ProviderRuntime({
    codex: new Native(), dataDir: directory, modelLimitResolver: { enrich: async (_config, models) => models },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify(fail ? { error: { message: 'Synthetic summary rejected' } } : {
        id: 'synthetic-summary', choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic continuity checkpoint.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }), { status: fail ? 400 : 200, headers: { 'Content-Type': 'application/json' } });
    },
  }).init();
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.saveProvider({ id: 'fixture', type: 'compatible', baseUrl: 'https://synthetic-api.example/v1',
    models: [{ id: 'exact-model', contextWindowTokens: 65536, maxOutputTokens: 8192 }] }, { preserveDefault: true });
  let audit = createInstructionAudit({ developerInstructions: content, tools: [spec],
    sections: [{ id: 'core', title: 'Saved instructions', source: 'Config: Instructions', role: 'developer', text: content, revision: 7, sourceHash: 'saved-core-hash', captureEmpty: true }] });
  const original = structuredClone(audit);
  let mainAcceptances = 0;
  const state = { config: runtime.store.get('fixture'), instructions: content,
    record: { id: 'synthetic-thread', providerId: 'fixture', model: 'exact-model', messages: [], totalUsage: {} },
    controller: new AbortController(), usage: {}, tools: [{ ...spec, wireName: spec.name }],
    onPromptAccepted: () => { mainAcceptances++; },
    onInstructionAuditPrepared: detail => { audit = withPreparedAdapterInstructions(audit, detail); },
  };
  return { runtime, state, original, requests, get audit() { return audit; }, get mainAcceptances() { return mainAcceptances; } };
}

for (const content of ['  OWNER_CORE\n\n', '']) {
  test('context summary preserves the admitted ' + (content ? 'custom' : 'empty') + ' core and captures its own request separately', async t => {
    const f = await fixture(t, content);
    await f.runtime.summarizeContextText(f.state, 'PRIVATE_TRANSCRIPT_MARKER', before, { summaryTokens: 256 });
    assert.deepEqual(f.audit.sections, f.original.sections);
    assert.deepEqual(f.audit.tools, f.original.tools);
    assert.deepEqual(f.audit.developer, f.original.developer);
    assert.equal(f.audit.delivery, 'prepared');
    assert.equal(f.mainAcceptances, 0);
    assert.equal(f.audit.preparations.length, 1);
    const child = f.audit.preparations[0];
    assert.equal(child.kind, 'context-summary');
    assert.equal(child.audit.delivery, 'accepted');
    assert.equal(child.audit.tools.count, 0);
    assert.equal(child.audit.sections.filter(item => item.layer === 'developer').map(item => item.text).join(''), f.requests[0].messages[0].content);
    assert.equal(child.audit.sections.find(item => item.id === 'summary-method').text, f.requests[0].messages[1].content.split('\n\n')[0]);
    assert.doesNotMatch(JSON.stringify(f.audit), /PRIVATE_TRANSCRIPT_MARKER/);
    assert.equal(f.state.instructions, content);
    assert.equal(f.state.tools.length, 1);
    f.state.record.messages = [{ role: 'user', content: 'Continue the synthetic task.' }];
    await f.runtime.modelResponse(f.state, f.state.config);
    const core = f.audit.sections.find(item => item.id === 'core');
    assert.equal(core.text, content); assert.equal(core.revision, 7); assert.equal(core.sourceHash, 'saved-core-hash');
    assert.equal(f.audit.tools.count, 1); assert.equal(f.audit.preparations.length, 1);
  });
}

test('a failed internal summary retains the main audit and an unaccepted separate capture', async t => {
  const f = await fixture(t, 'SAVED_CORE', { fail: true });
  await assert.rejects(f.runtime.summarizeContextText(f.state, 'PRIVATE_FAILED_TRANSCRIPT', before, { summaryTokens: 256 }));
  assert.deepEqual(f.audit.sections, f.original.sections);
  assert.deepEqual(f.audit.tools, f.original.tools);
  assert.equal(f.audit.preparations.length, 1);
  assert.equal(f.audit.preparations[0].audit.delivery, 'prepared');
  assert.equal(f.audit.delivery, 'prepared'); assert.equal(f.mainAcceptances, 0);
  assert.doesNotMatch(JSON.stringify(f.audit), /PRIVATE_FAILED_TRANSCRIPT/);
});
