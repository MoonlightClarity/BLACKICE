import test from 'node:test';
import assert from 'node:assert/strict';
import { writeEventStream } from '../lib/event-stream.mjs';
const response = overrides => ({ destroyed: false, writableEnded: false, writableLength: 0, writes: [], write(text) { this.writes.push(text); return false; }, destroy() { this.destroyed = true; }, ...overrides });
test('accepted backpressure retains the connection until the actual byte buffer exceeds its bound', () => {
  const res = response();
  assert.equal(writeEventStream(res, 'data: é\n\n', {maxBufferBytes: 10}), true);
  assert.equal(res.destroyed, false); assert.equal(res.writes.length, 1);
  res.writableLength = 1;
  assert.equal(writeEventStream(res, 'data: é\n\n', {maxBufferBytes: 10}), false);
  assert.equal(res.destroyed, true); assert.equal(res.writes.length, 1);
});
test('closed and failed streams do not throw into the task or accumulate further events', () => {
  for (const key of ['destroyed','writableEnded']) { const res = response({[key]:true}); assert.equal(writeEventStream(res,'data: {}\n\n'), false); assert.equal(res.writes.length,0); }
  const res = response({write(){throw Error('disconnected');}});
  assert.equal(writeEventStream(res, 'data: {}\n\n'), false); assert.equal(res.destroyed, true);
});
