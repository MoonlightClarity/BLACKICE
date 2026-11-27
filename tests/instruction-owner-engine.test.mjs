import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import {writeFile} from 'node:fs/promises';
import { DEFAULT_COMMON_INSTRUCTIONS } from '../lib/instruction-store.mjs';

test('saved common Instructions are pinned across nodes and explicit empty applies to a resumed execution', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blackice-owner-core-')), cwd = path.join(dir, 'workspace'); await mkdir(cwd);
  let entered, release; const admitted = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  class Runtime extends EventEmitter {
    calls = []; store = { get: () => ({ baseUrl: 'https://fixture.invalid/v1' }) };
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture::remote', models: [{ id: 'fixture::remote', supportsTools: true }] }; }
    async runAgent(options) {
      this.calls.push(options);
      options.onInstructionAuditPrepared?.({ developerInstructions: options.developerInstructions, adapter: 'fixture', role: 'system', source: 'offline fixture', tools: options.dynamicTools });
      options.onPromptAccepted?.(options.prompt);
      if (this.calls.length === 1) { entered(); await gate; }
      return { output: 'Fixture complete.', threadId: 'fixture-' + this.calls.length };
    }
  }
  const runtime = new Runtime(), engine = await new HarnessEngine({ runtime, dataDir: path.join(dir, 'data'), defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => ({ subagentsEnabled: false, executionGuardrails: false }) };
  t.after(async () => { release(); await engine.close(); await rm(dir, { recursive: true, force: true }); });
  const initial = await engine.instructionSettings.read();
  const owner = await engine.instructionSettings.update({ content: '  OWNER_ADMITTED_CORE\n  ', expectedRevision: initial.revision, expectedHash: initial.hash });
  const workflow = { name: 'Sequential owner Instructions', nodes: [{ id: 'input', type: 'input' },
    { id: 'a', type: 'agent', model: 'fixture::remote', prompt: 'First step.' },
    { id: 'b', type: 'agent', model: 'fixture::remote', prompt: 'Second step.' }, { id: 'output', type: 'output' }],
  edges: [{ source: 'input', target: 'a' }, { source: 'a', target: 'b' }, { source: 'b', target: 'output' }], settings: { planningMode: 'off' } };
  const first = engine.startRun({ workflow, input: { task: 'PRIVATE_TASK_TEXT', directoryMode: 'off' } });
  await admitted;
  const before = engine.getRun(first.id).nodes.a.instructionAudit;
  const empty = await engine.instructionSettings.update({ content: '', expectedRevision: owner.revision, expectedHash: owner.hash });
  release(); await engine.executions.get(first.id);
  const completed = engine.getRun(first.id); assert.equal(completed.status, 'completed', completed.error);
  assert.equal(runtime.calls.length, 2);
  for (const [index, id] of ['a', 'b'].entries()) {
    const audit = completed.nodes[id].instructionAudit, core = audit.sections.find(item => item.id === 'core');
    assert.equal(core.text, owner.content); assert.equal(core.revision, owner.revision); assert.equal(core.sourceHash, owner.hash);
    assert.equal(core.status, 'accepted'); assert.equal(core.source, 'Runtime / System instructions');
    assert.equal(audit.sections.filter(item => item.layer === 'developer').map(item => item.text).join(''), runtime.calls[index].developerInstructions);
    assert.ok(runtime.calls[index].developerInstructions.startsWith(owner.content));
    assert.ok(!runtime.calls[index].developerInstructions.includes(DEFAULT_COMMON_INSTRUCTIONS));
    assert.doesNotMatch(runtime.calls[index].developerInstructions, /EXECUTION COMPLETION/);
    assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_TASK_TEXT/);
  }
  assert.deepEqual(completed.nodes.a.instructionAudit, before);
  const resumed = engine.continueRun(first.id, { nodeId: 'b', message: 'Continue this saved fixture.' });
  await engine.executions.get(resumed.id);
  const next = engine.getRun(resumed.id); assert.equal(next.status, 'completed', next.error);
  const core = next.nodes.b.instructionAudit.sections.find(item => item.id === 'core');
  assert.equal(core.text, ''); assert.equal(core.characters, 0); assert.equal(core.revision, empty.revision); assert.equal(core.sourceHash, empty.hash);
  assert.doesNotMatch(runtime.calls.at(-1).developerInstructions, /OWNER_ADMITTED_CORE|EXECUTION COMPLETION|BLACKICE AGENT HARNESS/);
  assert.equal((await engine.instructionSettings.read()).content, '');
  assert.deepEqual(engine.getRun(first.id).nodes.a.instructionAudit, before);

  const correctionCore = await engine.instructionSettings.update({ content: 'OWNER_CORRECTION_CORE\n', expectedRevision: empty.revision, expectedHash: empty.hash });
  const correctionWorkflow = { id: 'mission_chat_owner_correction', name: 'Owner response-only fixture', description: 'A focused task started from Mission.',
    nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', model: 'fixture::remote', prompt: 'Answer the current request.' }, { id: 'output', type: 'output' }],
    edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { planningMode: 'off' } };
  const correctionStart = engine.startRun({ workflow: correctionWorkflow, input: { task: 'Describe the current fixture.', directoryMode: 'off' } });
  await engine.executions.get(correctionStart.id);
  const stopped = engine.continueRun(correctionStart.id, { nodeId: 'agent', message: 'Please stop.' });
  await engine.executions.get(stopped.id);
  const stoppedRun = engine.getRun(stopped.id); assert.equal(stoppedRun.status, 'completed', stoppedRun.error);
  assert.equal(stoppedRun.chatCorrectionScope, 'stop');
  assert.deepEqual(runtime.calls.at(-1).dynamicTools ?? [], []);
  assert.equal(runtime.calls.at(-1).hostOnlyTools, true);
  let responseAudit = stoppedRun.nodes.agent.instructionAudit;
  assert.equal(responseAudit.sections.find(item => item.id === 'core').text, correctionCore.content);
  assert.equal(responseAudit.sections.find(item => item.id === 'core').revision, correctionCore.revision);
  assert.ok(responseAudit.sections.some(item => item.id === 'response-only-contract'));
  assert.equal(responseAudit.sections.filter(item => item.layer === 'developer').map(item => item.text).join(''), runtime.calls.at(-1).developerInstructions);
  const inspected=await engine.executionLayerDefinitions();
  await engine.executionLayers.save({action:'replace',id:'capabilities',
    text:'OWNER_CURRENT_ROUTING_INSTRUCTIONS',expectedRevision:engine.executionLayers.revision},inspected);
  // A leftover file from older versions never replaces the canonical model instructions.
  await writeFile(path.join(engine.dataDir,'developer-layer.md'),'OBSOLETE_GLOBAL_OVERRIDE');
  const custom=engine.startRun({workflow:correctionWorkflow,input:{task:'Check current runtime layer.',directoryMode:'off'}});
  await engine.executions.get(custom.id);
  assert.equal(engine.getRun(custom.id).status,'completed');
  assert.match(runtime.calls.at(-1).developerInstructions,/OWNER_CURRENT_ROUTING_INSTRUCTIONS/);
  assert.doesNotMatch(runtime.calls.at(-1).developerInstructions,/OBSOLETE_GLOBAL_OVERRIDE/);
  assert.match(runtime.calls.at(-1).developerInstructions,/OWNER_CORRECTION_CORE/);
  await engine.executionLayers.save({action:'reset',id:'capabilities',expectedRevision:engine.executionLayers.revision},
    await engine.executionLayerDefinitions());
  const emptyAgain = await engine.instructionSettings.update({ content: '', expectedRevision: correctionCore.revision, expectedHash: correctionCore.hash });
  const continuedStop = engine.continueRun(stopped.id, { nodeId: 'agent', message: 'Continue' });
  await engine.executions.get(continuedStop.id);
  const continuedRun = engine.getRun(continuedStop.id); assert.equal(continuedRun.status, 'completed', continuedRun.error);
  assert.equal(continuedRun.chatCorrectionScope, 'stop');
  responseAudit = continuedRun.nodes.agent.instructionAudit;
  assert.equal(responseAudit.sections.find(item => item.id === 'core').text, '');
  assert.equal(responseAudit.sections.find(item => item.id === 'core').revision, emptyAgain.revision);
  assert.deepEqual(runtime.calls.at(-1).dynamicTools ?? [], []);
  assert.equal(runtime.calls.at(-1).hostOnlyTools, true);
  assert.doesNotMatch(runtime.calls.at(-1).developerInstructions, /OWNER_CORRECTION_CORE|EXECUTION COMPLETION|BLACKICE AGENT HARNESS/);
});
