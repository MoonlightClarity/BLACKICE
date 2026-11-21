import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSkillsCatalog } from '../lib/skills-catalog.mjs';
import { createChatPlanningProviderInvoker } from '../lib/chat-planning-provider.mjs';
import { CHAT_PLANNING_MODULES } from '../lib/chat-planning-pass.mjs';

for (const module of [CHAT_PLANNING_MODULES[0], CHAT_PLANNING_MODULES[3]]) test('planning preparation honors owner edit and deletion with exact audit: ' + module.id, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-owner-planning-')), catalog = createSkillsCatalog({ dataDir });
  t.after(async () => { await catalog.close(); await rm(dataDir, { recursive: true, force: true }); });
  const id = module.skillId || module.id, bundled = await catalog.detail({ id });
  const text = '# Owner planning method\nOWNER_METHOD_BODY\n' + 'x'.repeat(31000) + '\nOWNER_METHOD_TAIL';
  const edited = await catalog.save({ id, value: { expectedRevision: bundled.revision, content: text } });
  const scope = { taskId: 't1', runId: 'r1', nodeId: 'n1' }, snapshot = { taskId: 't1', revision: 0, objective: 'PRIVATE_DIRECTORY_DATA', actions: [], receipts: [] };
  const instructionSnapshot = { content: '  OWNER_COMMON_CORE\n', revision: 12, hash: 'a'.repeat(64), source: 'user' };
  const identity = { documents: { soul: { content: '# Active SOUL\nOWNER_PREP_SOUL', revision: 7, hash: 'b'.repeat(64), truncated: false }, user: { content: 'PRIVATE_USER_FACTS' } } };
  const calls = [], audits = [];
  const make = () => createChatPlanningProviderInvoker({ ...scope, dataDir, model: 'fixture::remote', cwd: dataDir, instructionSnapshot, identity, assertAdmission() {},
    onInstructionAudit: value => audits.push(value), runtime: { async runAgent(options) {
      const wireInstructions = options.developerInstructions + '\nFIXTURE_ADAPTER'; calls.push({ options, wireInstructions });
      options.onInstructionAuditPrepared({ developerInstructions: wireInstructions, adapter: 'fixture', role: 'system', source: 'offline test', tools: [] });
      options.onPromptAccepted(options.prompt); return { output: JSON.stringify({ status: 'proposed', reason: 'Fixture proposal' }) };
    } } });
  const input = { ...scope, module, snapshot, decision: 'PRIVATE_CURRENT_REQUEST', intentContext: { reference: 'PRIVATE_INTENT_REFERENCE' } };
  await make()(input);
  const first = audits.at(-1), core = first.audit.sections.find(item => item.id === 'core'), method = first.audit.sections.find(item => item.id === 'skill-' + id);
  assert.equal(core.text, instructionSnapshot.content); assert.equal(core.revision, instructionSnapshot.revision);
  assert.equal(method.text, text); assert.equal(method.revision, edited.revision); assert.equal(method.source, 'Owner skill: ' + id);
  assert.equal(first.audit.delivery, 'accepted'); assert.equal(first.id, module.id);
  assert.equal(first.audit.sections.filter(item => item.layer === 'developer').map(item => item.text).join(''), calls[0].wireInstructions);
  assert.ok(calls[0].options.prompt.includes(text)); assert.ok(calls[0].options.prompt.length > 30000);
  assert.match(calls[0].options.prompt, /OWNER_PREP_SOUL/); assert.doesNotMatch(calls[0].options.prompt, /PRIVATE_USER_FACTS/);
  assert.doesNotMatch(JSON.stringify(first.audit), /PRIVATE_CURRENT_REQUEST|PRIVATE_DIRECTORY_DATA|PRIVATE_INTENT_REFERENCE|PRIVATE_USER_FACTS/);
  assert.deepEqual(calls[0].options.dynamicTools, []); assert.equal(calls[0].options.responseOnly, true);
  const original = structuredClone(first);
  const deleted = await catalog.delete({ id, value: { expectedRevision: edited.revision } });
  await make()(input);
  const absent = audits.at(-1).audit.sections.find(item => item.id === 'skill-' + id);
  assert.equal(absent.status, 'unavailable'); assert.equal(absent.text, ''); assert.equal(absent.revision, deleted.revision);
  assert.match(absent.reason, /owner deleted/); assert.doesNotMatch(calls.at(-1).options.prompt, /OWNER_METHOD_BODY|OWNER_METHOD_TAIL/);
  assert.ok(!calls.at(-1).options.prompt.includes(bundled.content));
  assert.deepEqual(first, original);
});
