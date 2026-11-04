import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { planningSkillInstructions, PLANNING_SKILL_CONTENT, PLANNING_SKILL_SHA256 } from '../lib/planning-skill.mjs';
import { composeAgentDeveloperInstructions } from '../lib/developer-instruction-budget.mjs';

class NoNativeProcess extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async close() {}
  async runAgent() { throw Error('Skill delivery fixtures cannot start native processes or models.'); }
}

for (const type of ['openai', 'anthropic', 'compatible']) test(type + ': complete versioned skill reaches the actual provider request unchanged on initial and continued turns', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackice-skill-delivery-'));
  const requests = [];
  const response = type === 'openai'
    ? { id: 'skill-delivery-response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic result; no operation performed.' }] }] }
    : type === 'anthropic'
      ? { id: 'skill-delivery-message', role: 'assistant', type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Synthetic result; no operation performed.' }] }
      : { choices: [{ message: { role: 'assistant', content: 'Synthetic result; no operation performed.' }, finish_reason: 'stop' }] };
  const runtime = await new ProviderRuntime({
    codex: new NoNativeProcess(), dataDir: directory,
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { headers: { 'content-type': 'application/json' } });
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
    }
  }).init();
  t.after(async () => {
    await runtime.close();
    const resolved = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(temporaryRoot));
    assert.match(path.basename(resolved), /^blackice-skill-delivery-/);
    await rm(resolved, { recursive: true, force: true });
  });
  await runtime.saveProvider({ id: 'skill', type, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic-skill-fixture-key', models: ['fixture-model'] });
  const instructions = composeAgentDeveloperInstructions({ core: 'BLACKICE fixture identity\n', planning: planningSkillInstructions('on'), worker: '\nAssigned scope: read-only synthetic task.' }).instructions;
  const first = await runtime.runAgent({ cwd: directory, model: 'skill::fixture-model', prompt: 'No external operations.', developerInstructions: instructions });
  await runtime.runAgent({ cwd: directory, model: 'skill::fixture-model', threadId: first.threadId, prompt: 'Continue this synthetic task.', developerInstructions: instructions });
  const wireInstructions = body => type === 'openai' ? body.instructions : type === 'anthropic' ? body.system : body.messages.find(item => item.role === 'system')?.content;
  assert.equal(requests.length, 2);
  for (const body of requests) {
    const delivered = wireInstructions(body);
    assert.equal(delivered, instructions);
    assert.equal(delivered.split(PLANNING_SKILL_CONTENT).length, 2);
    assert.ok(delivered.includes('END REQUIRED BLACKICE PLANNING SKILL v4 sha256=' + PLANNING_SKILL_SHA256));
  }
});
