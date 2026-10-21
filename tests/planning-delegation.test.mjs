import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentToolHandler } from '../lib/subagents.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitFor = async check => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('The independent worker scheduler did not reach the expected state.');
};
const result = value => JSON.parse(value.contentItems[0].text);
const delegate = (handler, tasks) => handler({ name: 'relay_delegate', arguments: { tasks } });
const task = (id, dependsOn) => ({ id, prompt: `Perform ${id} only.`, ...(dependsOn ? { dependsOn } : {}) });
const assigned = options => options.prompt.match(/YOUR ASSIGNED TASK:\nPerform ([a-z]+) only\./)?.[1];

test('a newly ready dependent starts while an unrelated root remains running, including out-of-order declarations', async t => {
  const hold = deferred(), started = [], prompts = new Map(); let pending;
  t.after(async () => { hold.resolve(); await pending; });
  const handler = createSubagentToolHandler({ maxParallel: 2, runtime: { async runAgent(options) {
    const id = assigned(options); started.push(id); prompts.set(id, options.prompt);
    if (id === 'unrelated') await hold.promise;
    return { output: `Actual ${id} result.` };
  } } });
  pending = delegate(handler, [task('dependent', ['source']), task('unrelated'), task('source')]);
  await waitFor(() => started.includes('dependent'));
  assert.deepEqual(started, ['unrelated', 'source', 'dependent']);
  assert.match(prompts.get('dependent'), /Actual source result/);
  assert.doesNotMatch(prompts.get('dependent'), /Actual unrelated result/);
  hold.resolve(); const receipt = result(await pending);
  assert.equal(receipt.allCompleted, true); assert.equal(receipt.completed, 3);
});

test('overlapping calls share capacity but an independent second call does not wait for the first response', async t => {
  const hold = deferred(); let running = 0, peak = 0, firstFinished = false, pending;
  t.after(async () => { hold.resolve(); await pending; });
  const handler = createSubagentToolHandler({ maxParallel: 2, runtime: { async runAgent(options) {
    running++; peak = Math.max(peak, running);
    try { if (assigned(options) === 'held') await hold.promise; else await new Promise(resolve => setTimeout(resolve, 10)); return { output: 'An actual checked result.' }; }
    finally { running--; }
  } } });
  pending = delegate(handler, [task('held')]).then(value => { firstFinished = true; return value; });
  await waitFor(() => running === 1);
  const second = result(await delegate(handler, [task('left'), task('right')]));
  assert.equal(second.allCompleted, true); assert.equal(firstFinished, false); assert.equal(peak, 2);
  hold.resolve(); assert.equal(result(await pending).allCompleted, true);
});

test('a failed prerequisite blocks only its dependents and leaves unrelated work useful', async () => {
  const started = [];
  const handler = createSubagentToolHandler({ maxParallel: 2, runtime: { async runAgent(options) {
    const id = assigned(options); started.push(id);
    if (id === 'broken') throw Error('The source file could not be read.');
    return { output: 'Checked the independent input.' };
  } } });
  const returned = await delegate(handler, [task('blocked', ['broken']), task('broken'), task('independent')]), receipt = result(returned);
  assert.equal(returned.success, true); assert.equal(receipt.allCompleted, false); assert.equal(receipt.completed, 1);
  assert.deepEqual(new Set(started), new Set(['broken', 'independent']));
  assert.equal(receipt.results.find(item => item.id === 'blocked').status, 'blocked');
  assert.equal(receipt.results.find(item => item.id === 'broken').status, 'failed');
  assert.equal(receipt.results.find(item => item.id === 'independent').status, 'completed');
});

test('invalid dependency graphs consume no admission budget and accepted prior results may be prerequisites', async () => {
  const started = [];
  const handler = createSubagentToolHandler({ runtime: { async runAgent(options) { started.push(assigned(options)); return { output: 'Actual prior result.' }; } } });
  for (const tasks of [[task('a', ['b']), task('b', ['a'])], [task('a', ['missing'])], [task('a', ['a'])], [task('a', ['b', 'b']), task('b')]]) {
    const returned = await delegate(handler, tasks); assert.equal(returned.success, false); assert.equal(result(returned).remainingThisTurn, 12);
  }
  assert.deepEqual(started, []);
  assert.equal(result(await delegate(handler, [task('a')])).allCompleted, true);
  assert.equal(result(await delegate(handler, [task('b', ['a'])])).allCompleted, true);
  assert.deepEqual(started, ['a', 'b']);
  const duplicate = await delegate(handler, [task('a')]); assert.equal(duplicate.success, false); assert.equal(result(duplicate).remainingThisTurn, 10);
});

test('dependent dispatch waits for the durable completion hook while independent work still proceeds', async t => {
  const durable = deferred(), atHook = deferred(), started = []; let pending;
  t.after(async () => { durable.resolve(); await pending; });
  const handler = createSubagentToolHandler({ maxParallel: 3,
    onTaskFinish: async ({ task }) => { if (task.id === 'source') { atHook.resolve(); await durable.promise; } },
    runtime: { async runAgent(options) { const id = assigned(options); started.push(id); return { output: `${id} checked.` }; } }
  });
  pending = delegate(handler, [task('source'), task('dependent', ['source']), task('independent')]);
  await atHook.promise; await waitFor(() => started.includes('independent'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!started.includes('dependent'), 'an uncommitted finish cannot start dependent work');
  durable.resolve(); assert.equal(result(await pending).allCompleted, true); assert.ok(started.includes('dependent'));
});

test('queued cancellation does not invoke tools or start work after its prerequisite settles', async t => {
  const hold = deferred(), controller = new AbortController(), started = []; let pending;
  t.after(async () => { controller.abort(); hold.resolve(); await pending; });
  const handler = createSubagentToolHandler({ signal: controller.signal, maxParallel: 1, runtime: { async runAgent(options) {
    started.push(assigned(options)); await hold.promise; return { output: 'A late result after cancellation.' };
  } } });
  pending = delegate(handler, [task('source'), task('dependent', ['source'])]); await waitFor(() => started.length === 1);
  controller.abort(); hold.resolve(); const receipt = result(await pending);
  assert.deepEqual(started, ['source']); assert.equal(receipt.completed, 0);
  assert.equal(receipt.results[0].status, 'cancelled'); assert.equal(receipt.results[1].status, 'not-started');
});
