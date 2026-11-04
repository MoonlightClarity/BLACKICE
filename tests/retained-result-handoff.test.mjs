import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import { compactRunEvent, compactRunHistory, retainedToolResult, RUN_EVENT_LIMITS } from '../lib/run-event-retention.mjs';
import { executionProjection, recordedExecutionOutputs } from '../lib/response-cycle.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const event = (text, id = 'call', success = true) => ({ type: 'agent.event', runId: 'fixture-run', nodeId: 'agent', at: '2026-11-04T00:00:00Z',
  data: { type: 'item', stage: 'completed', item: { type: 'dynamicToolCall', id, tool: 'relay_workspace', arguments: JSON.stringify({ action: 'read', path: 'answer.json' }),
    status: 'completed', success, contentItems: [{ type: 'inputText', text }] } } });
const runWith = events => ({ id: 'fixture-run', input: 'Verify the actual local artifact.', workflow: { nodes: [{ id: 'agent', type: 'agent', name: 'Fixture worker' }] },
  nodes: { agent: { status: 'completed', output: 'Candidate answer remains unverified.' } }, events });
function project(run) {
  const result = executionProjection(run, 'fixture-cycle', recordedExecutionOutputs(run));
  const bodies = result.records.map(source => JSON.parse(source.text)), header = bodies.find(body => body.projection).projection;
  const calls = bodies.flatMap(body => body.calls || []), texts = new Map(bodies.flatMap(body => body.texts || []).map(item => [item.id, item]));
  return { result, bodies, header, calls, texts,
    metadata: record => ({ ...(record.metadataRef === undefined ? {} : header.receiptMetadataTable[record.metadataRef]), ...record }),
    observed: call => call.observations.map(observation => ({ observation, text: texts.get(observation.textRef) })) };
}

test('real workspace receipts survive engine retention, recompaction and final-review projection with exact content and provenance', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'retained-result-handoff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new HarnessEngine({ runtime: {}, dataDir: directory, defaultCwd: directory }); engine.schedulePersist = () => {};
  const run = runWith([]), live = [];
  engine.on('event', value => live.push(value));
  const handler = createWorkspaceToolHandler({ cwd: directory });
  const answer = JSON.stringify({ answer: 'Observed synthetic paragraph. '.repeat(30) + 'The final sentence must remain visible.', status: 'draft' }, null, 2);
  const expected = new Map();
  for (const [id, args] of [['write', { action: 'write', path: 'answer.json', text: answer }], ['read', { action: 'read', path: 'answer.json' }], ['missing', { action: 'read', path: 'absent.json' }]]) {
    const receipt = await handler({ name: 'relay_workspace', arguments: args });
    const text = receipt.contentItems.filter(part => typeof part.text === 'string').map(part => part.text).join('\n');
    expected.set(id, { text, success: receipt.success });
    engine.notify('agent.event', run, 'agent', { type: 'item', stage: 'completed', item: { type: 'dynamicToolCall', id, tool: 'relay_workspace', arguments: JSON.stringify(args),
      status: 'completed', success: receipt.success, contentItems: receipt.contentItems } });
  }
  assert.ok(expected.get('read').text.length > 300);
  assert.ok(expected.get('read').text.length < 4096);
  assert.equal(run.events.find(item => item.data.item.id === 'read').data.item.target, 'answer.json');
  const before = structuredClone(run.events);
  compactRunHistory(run); compactRunHistory(run);
  assert.deepEqual(run.events, before, 'Repeated compaction must not erase captured content or identity.');
  assert.equal(live.find(item => item.data.item.id === 'read').data.item.contentItems[0].text, expected.get('read').text, 'Live subscribers retain the original response.');
  const output = project(run);
  assert.equal(output.result.limited, false); assert.equal(output.header.truncated, false);
  assert.equal(output.calls.length, 3);
  for (const call of output.calls) {
    const captured = expected.get(call.callId), record = output.metadata(call.records[0]);
    assert.equal(record.success, captured.success);
    assert.equal(record.retainedResult.sha256, sha(captured.text));
    assert.equal(record.retainedResult.truncated, false);
    assert.equal(call.observationCount, 1);
    const observation = output.observed(call)[0];
    assert.equal(observation.text.truncated, false);
    assert.equal(observation.text.ranges.map(range => range.text).join(''), captured.text);
    assert.equal(output.header.pathTable[observation.observation.pathRef], '/retainedResult/ranges/0/text');
    const retainedEvent = run.events.find(item => item.data.item.id === call.callId);
    assert.equal(call.records[0].sha256, sha(JSON.stringify(retainedEvent)), 'The source record hash binds the actual retained event, not another call.');
  }
  const read = output.observed(output.calls.find(call => call.callId === 'read'))[0];
  const returned = JSON.parse(read.text.ranges[0].text);
  assert.equal(returned.sha256, sha(answer));
  assert.equal(returned.content.split('\n').map(line => line.replace(/^\d+: /, '')).join('\n'), answer, 'The real workspace readback numbers its lines.');
  assert.match(output.bodies[0].note, /not automatic proof of every requested outcome/);
});

test('large retained results keep bounded exact UTF-16 ranges, byte budgets and explicit missing content', () => {
  const raw = 'BEGIN ' + '\u0001😀'.repeat(10000) + 'OMITTED-SYNTHETIC-MARKER' + '界\\"'.repeat(18000) + ' FINAL OBSERVATION';
  const original = event(raw), compact = compactRunEvent(original), saved = compact.data.item.retainedResult;
  assert.equal(original.data.item.contentItems[0].text, raw);
  assert.equal(saved.length, raw.length); assert.equal(saved.sha256, sha(raw)); assert.equal(saved.truncated, true);
  assert.ok(saved.retainedChars <= 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(saved), 'utf8') <= RUN_EVENT_LIMITS.maxAuxiliaryEventBytes / 2);
  assert.ok(Buffer.byteLength(JSON.stringify(compact), 'utf8') < RUN_EVENT_LIMITS.maxAuxiliaryEventBytes);
  assert.equal(saved.omittedChars, raw.length - saved.retainedChars);
  assert.equal(saved.ranges.length, 3);
  for (const range of saved.ranges) {
    assert.equal(range.text, raw.slice(range.start, range.end));
    assert.equal(range.text.length, range.end - range.start);
    assert.doesNotMatch(range.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
  }
  assert.equal(saved.ranges[0].start, 0); assert.equal(saved.ranges.at(-1).end, raw.length);
  const output = project(runWith([compact]));
  assert.equal(output.header.truncated, true);
  assert.equal(output.metadata(output.calls[0].records[0]).retainedResult.omittedChars, saved.omittedChars);
  for (const { observation, text } of output.observed(output.calls[0])) {
    const retained = saved.ranges.find(range => range.start === observation.sourceRange.start);
    assert.equal(text.length, retained.text.length);
    for (const range of text.ranges) assert.equal(range.text, retained.text.slice(range.start, range.end));
  }
  assert.ok(!output.result.records.some(source => source.text.includes('OMITTED-SYNTHETIC-MARKER')), 'Missing content must not be reconstructed from its hash.');
  assert.deepEqual(compactRunEvent(compact), compact);
});

test('legacy prefixes reach review with their actual source path and honest known or unknown omissions', () => {
  for (const omittedChars of [700, undefined]) {
    const old = event('unused');
    old.data.item = { type: 'dynamicToolCall', id: 'legacy', tool: 'relay_workspace', action: 'read', status: 'completed', success: true,
      resultExcerpt: '{"truncatedPrefix":"' + 'x'.repeat(280), fullResultSha256: sha('unavailable complete original'), ...(omittedChars === undefined ? {} : { omittedChars }) };
    const direct = project(runWith([old])), call = direct.calls[0], metadata = direct.metadata(call.records[0]).retainedResult;
    assert.equal(metadata.truncated, true); assert.equal(metadata.omittedChars, omittedChars ?? null);
    assert.equal(metadata.length, omittedChars === undefined ? null : old.data.item.resultExcerpt.length + omittedChars);
    const observed = direct.observed(call)[0];
    assert.equal(direct.header.pathTable[observed.observation.pathRef], '/resultExcerpt', 'The hashed original record has a legacy prefix, not a synthesized ranges field.');
    assert.equal(observed.text.ranges.map(range => range.text).join(''), old.data.item.resultExcerpt);
    assert.deepEqual(observed.observation.sourceRange, { start: 0, end: old.data.item.resultExcerpt.length });
    const compact = compactRunEvent(old);
    assert.deepEqual(compactRunEvent(compact), compact);
    assert.equal(retainedToolResult(compact.data.item).truncated, true);
  }
});

test('changed complete text or invalid retained ranges cannot become verified complete observations', () => {
  const compact = compactRunEvent(event('{"observed":"true"}'));
  compact.data.item.retainedResult.ranges[0].text = '{"observed":"fake"}';
  assert.equal(retainedToolResult(compact.data.item), null);
  assert.equal(project(runWith([compact])).calls[0].observationCount, 0);
  const oversized = compactRunEvent(event('complete'));
  oversized.data.item.retainedResult.ranges.push({ start: 100, end: 101, text: 'x' });
  assert.equal(retainedToolResult(oversized.data.item), null);
});

test('recompaction never promotes an invalid retained record into a complete legacy prefix', () => {
  const prefix = '{"visible":"prefix only"}'.padEnd(300, ' '), raw = prefix + ' original omitted suffix';
  const compact = compactRunEvent(event(raw));
  compact.data.item.retainedResult.ranges[0].end++;
  const first = compactRunEvent(compact), second = compactRunEvent(first);
  assert.deepEqual(second, first);
  assert.equal(second.data.item.fullResultSha256, sha(raw));
  assert.equal(second.data.item.omittedChars, raw.length - 300);
  assert.equal(second.data.item.retainedResult.unavailable, 'invalid_record');
  assert.equal(retainedToolResult(second.data.item), null);
  const output = project(runWith([second]));
  assert.equal(output.calls[0].observationCount, 0);
  assert.equal(output.metadata(output.calls[0].records[0]).retainedResult.unavailable, 'invalid_record');
  assert.equal(output.header.truncated, true);
  const legacy = { resultExcerpt: '{"visible":"changed"}', fullResultSha256: sha('{"visible":"original"}'), omittedChars: 0 };
  assert.equal(retainedToolResult(legacy), null, 'A complete legacy prefix must agree with its supplied digest.');
});

test('retained tool text remains under the existing run-history bound and keeps newest observations', () => {
  const compact = compactRunEvent(event('界'.repeat(30000))), eventBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8');
  const count = Math.ceil(RUN_EVENT_LIMITS.perRunBytes / eventBytes) + 10;
  const run = runWith(Array.from({ length: count }, (_, index) => ({ ...compact, data: { ...compact.data, item: { ...compact.data.item, id: 'bounded-' + index } } })));
  compactRunHistory(run);
  assert.ok(run.eventRetention.bytes <= RUN_EVENT_LIMITS.perRunBytes);
  assert.ok(run.eventRetention.omittedEvents > 0);
  assert.ok(run.events.length <= RUN_EVENT_LIMITS.maxEvents);
  assert.equal(run.events.at(-1).data.item.id, 'bounded-' + (count - 1));
  assert.deepEqual(run.events.at(-1).data.item.retainedResult, compact.data.item.retainedResult);
});
