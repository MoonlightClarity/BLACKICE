// Historical schema-13 protocol regression; schema-14 behavior has separate canonical-contract and production-engine acceptance coverage.
import test from 'node:test';
import { fixtureDeferredUserAgency } from './fixture-user-agency.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from './fixture-legacy-planning-engine.mjs';
import { TaskStateStore } from './fixture-legacy-task-state.mjs';

const graph = {
  id: 'planning-return-fixture', name: 'Return to planning fixture', settings: { maxParallel: 1 },
  nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', model: 'fixture-model', prompt: 'Complete the requested comparison.' }, { id: 'output', type: 'output' }],
  edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }],
};
const leaf = (id = 'compare', extra = {}) => ({
  id, kind: 'action', parentId: null, status: 'active', title: `Compare ${id} against the supplied constraints`,
  operation: { kind: 'reasoning', target: `The ${id} alternatives and the supplied price and timing constraints.` },
  result: 'A selected feasible option and its checked total price.',
  note: 'Compare each supplied option against the timing and price constraints, then choose the least expensive feasible option.',
  doneWhen: 'The selected option and nearest feasible alternative have their actual prices and timing checks recorded.',
  ...extra,
});
const unpack = receipt => JSON.parse(receipt.contentItems.find(item => item.type === 'inputText').text);
async function task(options, args) {
  const receipt = await options.onToolCall({ name: 'relay_task', arguments: args });
  assert.equal(receipt.success, true, receipt.contentItems?.[0]?.text);
  return unpack(receipt);
}
async function prepare(options, steps = [leaf()]) {
  const state = await task(options, { action: 'read' });
  return task(options, { action: 'plan', expectedRevision: state.revision, plan: { layout: 'sequence' }, steps });
}
async function complete(options, state, id = 'compare', evidence = 'Option B costs $155 and its workshop times touch without overlapping; the nearest feasible alternative costs $165.') {
  return task(options, { action: 'step', expectedRevision: state.revision, stepId: id, status: 'done', evidence });
}
async function review(options, state, decision = 'respond', summary = 'The supplied goal and constraints are covered by the saved comparison; no consequential question remains before answering.', nextStepId) {
  return task(options, { action: 'review', expectedRevision: state.revision, review: { decision, summary, ...(nextStepId ? { nextStepId } : {}),
    ...(decision === 'blocked' && options.dynamicTools?.find(item => item.name === 'relay_task')?.inputSchema?.properties?.review?.properties?.userAgency
      ? { userAgency: fixtureDeferredUserAgency(summary) } : {}) } });
}
const answer = (options, text, id) => {
  options.onEvent({ type: 'delta', itemId: id, delta: text });
  options.onEvent({ type: 'message', itemId: id, phase: 'final_answer', text });
  options.onEvent({ type: 'item', stage: 'completed', item: { id, type: 'agentMessage', phase: 'final_answer', text } });
};
const answerEvents = run => run.events.filter(event => event.type === 'agent.event'
  && (['delta', 'message'].includes(event.data?.type) || event.data?.type === 'item' && event.data.item?.type === 'agentMessage'));

async function fixture(t, execute) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-return-'));
  const cwd = path.join(directory, 'work'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  let context;
  class Runtime extends EventEmitter {
    calls = []; passes = []; directions = [];
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ id: 'fixture-model', supportsTools: true }] }; }
    async steerAgent(threadId, text) { this.directions.push({ threadId, text }); return { accepted: true, threadId, turnId: 'review-turn' }; }
    async runAgent(options) {
      this.calls.push(options);
      const invocation = this.calls.length, threadId = options.threadId || `planning-return-thread-${invocation}`;
      let continuationPrompt = null;
      for (let pass = 1; pass <= 7; pass++) {
        if (options.signal?.aborted) throw Object.assign(new Error('Fixture stopped.'), { name: 'AbortError', code: 'ABORT_ERR' });
        const turnId = `return-${invocation}-${pass}`;
        this.passes.push({ invocation, pass, threadId, turnId, continuationPrompt });
        options.onEvent({ type: 'thread', threadId, turnId, model: 'fixture-model' });
        const outcome = await execute(options, { invocation, pass, continuationPrompt }, context);
        const usage = { totalTokens: pass * 20, inputTokens: pass * 12, outputTokens: pass * 8 };
        options.onEvent({ type: 'usage', usage });
        const result = { ...outcome, threadId, turnId, usage };
        const decision = await options.onBeforeFinal?.(result);
        if (!decision?.continue) return result;
        assert.equal(typeof decision.prompt, 'string'); assert.ok(decision.prompt.length);
        continuationPrompt = decision.prompt;
        await this.onContinuation?.({ options, result, decision, context });
      }
      assert.fail('The completion protocol exceeded the bounded fixture loop.');
    }
  }
  const runtime = new Runtime();
  const engine = await new HarnessEngine({ runtime, tasks, dataDir: directory, defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => ({ codexHistory: 'codex', executionGuardrails: true }) }; // A saved switch must not reinstall automatic post-work provider turns.
  context = { engine, runtime, tasks, cwd,
    start: (planningMode = 'on') => engine.startRun({ workflow: graph, input: 'Choose the least expensive feasible workshop pair from the supplied inputs.', planningMode }),
    active: () => engine.listRuns().find(run => run.status === 'running'),
    async settle(id) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { const run = engine.getRun(id); if (run.settled) return run; await new Promise(resolve => setTimeout(resolve, 5)); }
      assert.fail('The planning return fixture did not settle.');
    },
  };
  t.after(async () => { await engine.close(); await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return context;
}


for (const completedFirst of [false, true]) test('an optional ' + (completedFirst ? 'completed' : 'active') + ' leaf does not install an automatic review pass', async t => {
  const f = await fixture(t, async (options, { pass, continuationPrompt }, context) => {
    assert.equal(options.onBeforeFinal, undefined); assert.equal(pass, 1); assert.equal(continuationPrompt, null);
    let state = await prepare(options); if (completedFirst) state = await complete(options, state);
    answer(options, 'The supplied comparison supports B at $155.', 'direct-answer');
    assert.equal(context.active().nodes.agent.output, 'The supplied comparison supports B at $155.');
    return { output: 'The supplied comparison supports B at $155.' };
  });
  const run = await f.settle(f.start().id); assert.equal(run.status, 'completed', run.error);
  assert.equal(f.runtime.calls.length, 1); assert.equal(f.runtime.passes.length, 1);
  assert.equal(run.nodes.agent.threadId, 'planning-return-thread-1'); assert.equal(run.nodes.agent.usage.totalTokens, 20);
  assert.equal(run.nodes.agent.output, 'The supplied comparison supports B at $155.');
  assert.equal(run.taskState.steps[0].status, completedFirst ? 'done' : 'active');
  assert.equal(run.nodes.agent.planning.status, 'off'); assert.equal(run.nodes.agent.planning.review, undefined);
});

test('an explicit post-work review is saved without creating a ceremonial provider pass', async t => {
  const f = await fixture(t, async options => {
    assert.equal(options.onBeforeFinal, undefined);
    await review(options, await complete(options, await prepare(options)));
    return { output: 'Choose B for $155; A costs $165.' };
  });
  const run = await f.settle(f.start().id); assert.equal(run.status, 'completed', run.error);
  assert.equal(f.runtime.passes.length, 1); assert.equal(run.taskState.planningReviews.at(-1).decision, 'respond');
  assert.equal(run.nodes.agent.planning.reviewStatus, undefined); assert.match(run.nodes.agent.output, /Choose B/);
});

test('ordinary commentary and final output stream without a retired review buffer', async t => {
  const progress = 'I am checking the supplied workshop totals and the enrollment fee.';
  const f = await fixture(t, async (options, _pass, context) => {
    let state = await prepare(options);
    options.onEvent({ type: 'delta', itemId: 'progress', delta: progress });
    assert.match(JSON.stringify(answerEvents(context.active())), /checking the supplied workshop totals/);
    options.onEvent({ type: 'item', stage: 'completed', item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: progress } });
    state = await complete(options, state); await review(options, state);
    answer(options, 'The checked result is B at $155.', 'checked-final');
    return { output: 'The checked result is B at $155.' };
  });
  const run = await f.settle(f.start().id); assert.equal(run.status, 'completed', run.error);
  assert.equal(f.runtime.passes.length, 1); assert.equal(f.runtime.calls[0].onBeforeFinal, undefined);
  assert.ok(answerEvents(run).some(event => event.data.item?.phase === 'commentary' && event.data.item.text === progress));
  assert.equal(run.nodes.agent.output, 'The checked result is B at $155.');
});

test('new optional work stays unfinished until an explicit same-session follow-up completes it', async t => {
  let original;
  const f = await fixture(t, async (options, { invocation, pass }) => {
    assert.equal(pass, 1); assert.equal(options.onBeforeFinal, undefined);
    if (invocation === 1) {
      let state = await complete(options, await prepare(options)); original = structuredClone(state.steps[0]);
      state = await review(options, state);
      await task(options, { action: 'edit', expectedRevision: state.revision, operations: [{ type: 'add', step: leaf('discount_check') }] });
      return { output: 'The original comparison is checked; the added discount check is still unfinished.' };
    }
    assert.equal(options.threadId, 'planning-return-thread-1');
    let state = await task(options, { action: 'read' }); assert.deepEqual(state.steps[0], original);
    state = await complete(options, state, 'discount_check', 'The $30 discount applies to B only, and the total includes the one $10 fee.');
    await review(options, state, 'respond', 'The additional discount question is resolved; the original comparison is preserved.');
    return { output: 'The discount and one enrollment fee are included in the total.' };
  });
  const first = await f.settle(f.start().id); assert.equal(first.status, 'completed', first.error);
  assert.equal(f.runtime.passes.length, 1); assert.equal(first.taskState.steps[1].status, 'active');
  assert.equal(first.taskState.progress.complete, false); assert.match(first.nodes.agent.output, /still unfinished/);
  const next = await f.settle(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Complete the saved discount check.' }).id);
  assert.equal(next.status, 'completed', next.error); assert.equal(next.taskId, first.taskId);
  assert.equal(next.nodes.agent.threadId, first.nodes.agent.threadId); assert.equal(f.runtime.calls.length, 2); assert.equal(f.runtime.passes.length, 2);
  assert.deepEqual(next.taskState.steps[0], original); assert.equal(next.taskState.steps[1].status, 'done');
});

test('an accepted user direction is delivered to the active native session without a forced review turn', async t => {
  const f = await fixture(t, async (options, { pass }, context) => {
    assert.equal(pass, 1); assert.equal(options.onBeforeFinal, undefined);
    await review(options, await complete(options, await prepare(options)));
    const steered = await context.engine.steerRun(context.active().id, { nodeId: 'agent', message: 'Also check the bundle total if the enrollment fee is $20.' });
    assert.equal(steered.accepted, true);
    let state = await task(options, { action: 'read' });
    state = await task(options, { action: 'edit', expectedRevision: state.revision, operations: [{ type: 'add', step: leaf('updated_fee') }] });
    state = await complete(options, state, 'updated_fee', 'With the $20 fee B totals $165; A totals $175 and exceeds the supplied $170 ceiling.');
    await review(options, state, 'respond', 'The newly accepted fee request is included; B still wins and now costs $165.');
    return { output: 'With the $20 fee, choose B for $165.' };
  });
  const run = await f.settle(f.start().id); assert.equal(run.status, 'completed', run.error);
  assert.equal(f.runtime.passes.length, 1); assert.equal(f.runtime.directions.length, 1);
  assert.equal(f.runtime.directions[0].threadId, run.nodes.agent.threadId);
  assert.match(f.runtime.directions[0].text, /enrollment fee is \$20/); assert.match(run.output, /\$165/);
  assert.equal(run.taskState.steps.find(step => step.id === 'updated_fee').status, 'done');
});

test('a confirmed file mutation needs no review pass and duplicate callbacks cannot change its effect', async t => {
  const f = await fixture(t, async options => {
    const state = await prepare(options, [leaf('save', { operation: { kind: 'tool', tool: 'relay_workspace', action: 'write', target: 'result.txt' },
      result: 'The one fixture result is saved.', note: 'Write the supplied fixture text once to result.txt.', doneWhen: 'The workspace handler returns the written path and byte count.' })]);
    const call = { name: 'relay_workspace', arguments: { action: 'write', path: 'result.txt', text: 'B costs $155.' }, callId: 'one-save' };
    const [receipt, duplicate] = await Promise.all([options.onToolCall(call), options.onToolCall(structuredClone(call))]);
    assert.equal(receipt.success, true, receipt.contentItems[0].text); assert.deepEqual(duplicate, receipt);
    const conflict = await options.onToolCall({ ...call, arguments: { ...call.arguments, text: 'A changed write must not execute.' } });
    assert.equal(conflict.code, 'TOOL_CALL_ID_CONFLICT');
    await complete(options, state, 'save', 'The successful write receipt identifies result.txt and its saved byte count.');
    return { output: 'Saved the result once.' };
  });
  const run = await f.settle(f.start().id); assert.equal(run.status, 'completed', run.error);
  assert.equal(f.runtime.passes.length, 1); assert.equal(run.nodes.agent.usage.totalTokens, 20);
  assert.equal(run.taskState.steps[0].status, 'done'); assert.equal(run.nodes.agent.planning.review, undefined);
  assert.equal(await readFile(path.join(f.cwd, 'result.txt'), 'utf8'), 'B costs $155.');
});

test('an honest blocked reassessment returns a partial answer without inventing completion', async t => {
  const f = await fixture(t, async options => {
    let state = await prepare(options);
    state = await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'compare', status: 'blocked', blockedReason: 'The supplied fixture omits H2 price, so the cheapest feasible pair cannot be established.' });
    await review(options, state, 'blocked', 'The comparison is blocked on the missing H2 price; no independent ready work can resolve that supplied-input gap.');
    return { output: 'H2 price is missing, so the cheapest feasible pair remains unresolved.' };
  });
  const run = await f.settle(f.start().id); assert.equal(run.status, 'completed', run.error); assert.equal(f.runtime.passes.length, 1);
  assert.equal(run.taskState.steps[0].status, 'blocked'); assert.equal(run.taskState.progress.complete, false);
  assert.equal(run.taskState.planningReviews.at(-1).decision, 'blocked'); assert.equal(run.nodes.agent.planning.review, undefined);
});

test('unfinished optional work returns honestly once without an automatic no-progress loop', async t => {
  const f = await fixture(t, async (options, { pass }) => {
    assert.equal(pass, 1); await prepare(options);
    answer(options, 'The comparison remains unfinished; no completed result is claimed.', 'partial');
    return { output: 'The comparison remains unfinished; no completed result is claimed.' };
  });
  const run = await f.settle(f.start().id); assert.equal(run.status, 'completed', run.error);
  assert.equal(f.runtime.passes.length, 1); assert.equal(run.nodes.agent.usage.totalTokens, 20);
  assert.equal(run.taskState.steps[0].status, 'active'); assert.equal(run.taskState.progress.complete, false);
  assert.equal(run.nodes.agent.output, 'The comparison remains unfinished; no completed result is claimed.');
  assert.match(JSON.stringify(answerEvents(run)), /no completed result is claimed/);
});

test('Stop aborts the active provider, admits no further pass and preserves its confirmed file effect', async t => {
  let active = false, aborted = false;
  const progress = 'The local result was saved; the remaining comparison is unfinished.';
  const f = await fixture(t, async options => {
    await prepare(options);
    const written = await options.onToolCall({ name: 'relay_workspace', callId: 'before-stop', arguments: { action: 'write', path: 'before-stop.txt', text: 'Confirmed before Stop.' } });
    assert.equal(written.success, true);
    options.onEvent({ type: 'delta', itemId: 'partial', delta: progress }); options.onEvent({ type: 'usage', usage: { totalTokens: 20 } }); active = true;
    await new Promise((_resolve, reject) => {
      const stop = () => { aborted = true; reject(Object.assign(Error('The provider acknowledged Stop.'), { name: 'AbortError', code: 'ABORT_ERR' })); };
      if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, { once: true });
    });
    assert.fail('An aborted provider cannot produce a final answer.');
  });
  const accepted = f.start(), deadline = Date.now() + 5000;
  while (!active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(active, true); await f.engine.cancelRun(accepted.id);
  const run = await f.settle(accepted.id);
  assert.equal(run.status, 'cancelled'); assert.equal(aborted, true); assert.equal(run.settled, true);
  assert.equal(f.runtime.calls.length, 1); assert.equal(f.runtime.passes.length, 1);
  assert.equal(run.nodes.agent.usage.totalTokens, 20); assert.equal(run.nodes.agent.output, progress);
  assert.equal(await readFile(path.join(f.cwd, 'before-stop.txt'), 'utf8'), 'Confirmed before Stop.');
});

test('a direct provider failure retains partial output and session identity without automatic retry', async t => {
  const f = await fixture(t, async options => {
    options.onEvent({ type: 'delta', itemId: 'partial-failure', delta: 'The first supplied price is $145; the comparison is incomplete.' });
    throw Object.assign(Error('Synthetic direct transport failure.'), { code: 'FIXTURE_TRANSPORT_FAILURE' });
  });
  const run = await f.settle(f.start().id);
  assert.equal(run.status, 'failed'); assert.equal(run.nodes.agent.errorCode, 'FIXTURE_TRANSPORT_FAILURE');
  assert.equal(run.nodes.agent.threadId, 'planning-return-thread-1');
  assert.equal(run.nodes.agent.output, 'The first supplied price is $145; the comparison is incomplete.');
  assert.equal(f.runtime.calls.length, 1); assert.equal(f.runtime.passes.length, 1);
  assert.deepEqual(run.taskState.steps, []); assert.equal(run.nodes.agent.planning.status, 'off');
});

test('a continue reassessment can return to an earlier reasoning step and preserve its previous result', async t => {
  const transitions = [];
  const f = await fixture(t, async options => {
    let state = await task(options, { action: 'read' });
    state = await task(options, { action: 'plan', expectedRevision: state.revision, plan: { layout: 'parallel' }, steps: [
      leaf('compare'), leaf('fee_check', { status: 'pending', operation: { kind: 'reasoning', target: 'Whether the supplied enrollment fee is included once in the bundle total.' }, result: 'The applicable one-time enrollment fee and its treatment in the total.', note: 'Read the fee clause in the supplied fixture and compare it with the provisional bundle arithmetic.', doneWhen: 'The fee amount and whether it appears in the provisional total are explicitly recorded.' }),
    ] });
    state = await complete(options, state, 'compare', 'The provisional subtotal for B is $145 before resolving the separate enrollment-fee clause.');
    state = await review(options, state, 'continue', 'The workshop subtotal is known but the enrollment-fee treatment still needs its saved comparison before a final answer.', 'fee_check');
    transitions.push('continue');
    state = await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'fee_check', status: 'active' });
    state = await complete(options, state, 'fee_check', 'The fee clause adds $10 once per bundle; the earlier $145 figure excludes it.');
    state = await task(options, { action: 'edit', expectedRevision: state.revision, operations: [{ type: 'revisit', stepId: 'compare', reason: 'The completed fee check shows that the provisional workshop subtotal needs the one enrollment fee before answering.' }] });
    transitions.push('revisit');
    state = await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'compare', status: 'active' });
    state = await complete(options, state, 'compare', 'B costs $145 in workshops plus the single $10 enrollment fee, for $155; A’s comparable total is $165.');
    await review(options, state, 'respond', 'The earlier comparison was revisited using the completed fee check; the corrected all-in totals support B and no question remains.');
    transitions.push('respond');
    return { output: 'Choose B for the corrected all-in total of $155.' };
  });
  const run = await f.settle(f.start().id);
  assert.equal(run.status, 'completed', run.error); assert.equal(f.runtime.passes.length, 1);
  assert.deepEqual(transitions, ['continue', 'revisit', 'respond']);
  const compared = run.taskState.steps.find(step => step.id === 'compare');
  assert.equal(compared.attempt, 2); assert.match(compared.evidence, /\$155/);
  assert.equal(compared.pastAttempts.length, 1); assert.match(JSON.stringify(compared.pastAttempts[0]), /\$145 before resolving/);
  assert.equal(run.taskState.steps.find(step => step.id === 'fee_check').status, 'done');
});

test('Planning Off retains ordinary answer streaming and needs no reassessment', async t => {
  const f = await fixture(t, async (options, _pass, context) => {
    assert.equal(options.onBeforeFinal, undefined);
    options.onEvent({ type: 'delta', delta: 'An ordinary Off answer.' });
    assert.equal(context.active().nodes.agent.output, 'An ordinary Off answer.');
    return { output: 'An ordinary Off answer.' };
  });
  const run = await f.settle(f.start('off').id);
  assert.equal(run.status, 'completed', run.error); assert.equal(f.runtime.passes.length, 1);
  assert.deepEqual(run.taskState.steps, []); assert.equal(run.nodes.agent.planning.status, 'off');
});
