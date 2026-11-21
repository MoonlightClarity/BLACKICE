import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { BROWSER_TOOL } from '../lib/browser.mjs';
import { capabilityGuidance } from '../lib/tool-routing.mjs';
import { composeAgentDeveloperInstructions } from '../lib/developer-instruction-budget.mjs';
import { createInstructionAudit, withPreparedAdapterInstructions } from '../lib/instruction-audit.mjs';
import { createHash } from 'node:crypto';

class NoNativeProcess extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async close() {}
  async runAgent() { throw Error('Skill delivery fixtures cannot start native processes or models.'); }
}

for (const type of ['openai', 'anthropic', 'compatible']) test(type + ': browser tool guidance reaches the actual provider tool definition, not the prompt on initial and continued turns', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackice-skill-delivery-'));
  const requests = [], audits = [];
  const capture = detail => audits.push(withPreparedAdapterInstructions(createInstructionAudit(), detail));
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
  const instructions = composeAgentDeveloperInstructions({ core: 'BLACKICE fixture identity\n', capabilities: capabilityGuidance([{name:'relay_skills'},{name:'relay_browser'}],{planningMode:'off'}), worker: '\nAssigned scope: read-only synthetic task.' }).instructions;
  const first = await runtime.runAgent({ cwd: directory, model: 'skill::fixture-model', prompt: 'No external operations.', developerInstructions: instructions, dynamicTools:[BROWSER_TOOL], onInstructionAuditPrepared:capture });
  await runtime.runAgent({ cwd: directory, model: 'skill::fixture-model', threadId: first.threadId, prompt: 'Continue this synthetic task.', developerInstructions: instructions, dynamicTools:[BROWSER_TOOL], onInstructionAuditPrepared:capture });
  const wireInstructions = body => type === 'openai' ? body.instructions : type === 'anthropic' ? body.system : body.messages.find(item => item.role === 'system')?.content;
  assert.equal(requests.length, 2);
  assert.equal(audits.length,requests.length);
  for (const [index,body] of requests.entries()) {
    const delivered = wireInstructions(body);
    assert.equal(delivered, instructions);
    assert.doesNotMatch(delivered,/BUNDLED TASK SKILLS|builtin:|relevant job boards/);
    const wireTool=body.tools[0].function||body.tools[0];
    assert.equal(wireTool.description,BROWSER_TOOL.description);
    assert.doesNotMatch(JSON.stringify(body.tools),/relevant job boards|educated inference|First decompose|Check Sent for the specific recipient/);
    assert.match(wireTool.description,/expectedUrl and expectedDocumentId/);
    const captured=audits[index].sections.find(item=>item.layer==='tool-definition');
    assert.equal(captured.role,'tool-definition');
    assert.ok(captured.text.includes(wireTool.description));
    assert.ok(captured.text.includes(BROWSER_TOOL.inputSchema.properties.expectedDocumentId.description));
    assert.equal(captured.wireSha256,createHash('sha256').update(JSON.stringify(body.tools[0])).digest('hex'));
    assert.equal(audits[index].tools.sha256,createHash('sha256').update(JSON.stringify(body.tools)).digest('hex'));
    assert.equal(audits[index].totals.toolDefinitionCharacters,captured.characters);
  }
});
