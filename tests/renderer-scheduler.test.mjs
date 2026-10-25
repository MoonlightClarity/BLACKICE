import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderThrottle } from '../public/renderer-scheduler.mjs';

test('streaming receipt bursts reduce to a single latest-state paint per interval', () => {
  let clock = 0, serial = 0;
  const timers = new Map(), paints = [];
  const throttle = createRenderThrottle({
    intervalMs: 110, now: () => clock,
    schedule: (callback, duration) => { const id = ++serial; timers.set(id, { callback, due: clock + duration }); return id; },
    unschedule: id => timers.delete(id),
  });
  throttle.request(() => paints.push('first'));
  assert.deepEqual(paints, ['first']);
  clock = 20;
  for (let n = 0; n < 1000; n++) throttle.request(() => paints.push('latest:' + n));
  assert.equal(timers.size, 1, 'One timer handles thousands of streaming receipts.');
  assert.deepEqual(paints, ['first']);
  clock = 110;
  const [id, task] = [...timers][0]; timers.delete(id); task.callback();
  assert.deepEqual(paints, ['first', 'latest:999']);
  assert.equal(timers.size, 0);
  throttle.cancel();
});

test('cancel drops deferred paints without blocking direct UI updates', () => {
  let clock = 0, scheduled;
  const paints = [];
  const throttle = createRenderThrottle({
    intervalMs: 100, now: () => clock,
    schedule: callback => { scheduled = callback; return 1; },
    unschedule: () => {},
  });
  throttle.request(() => paints.push('immediate'));
  clock = 5;
  throttle.request(() => paints.push('late'));
  throttle.cancel();
  scheduled();
  assert.deepEqual(paints, ['immediate']);
  clock = 110;
  throttle.request(() => paints.push('next'));
  assert.deepEqual(paints, ['immediate', 'next']);
});
