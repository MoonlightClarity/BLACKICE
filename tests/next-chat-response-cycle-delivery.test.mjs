import test from 'node:test';
import assert from 'node:assert/strict';
import {messagesOfRun} from '../public/next/chat/model.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';

const event = (text, extra = {}, nodeId = 'agent') => ({nodeId, data: {type: 'message', text, ...extra}});
const run = events => ({id: 'diagnostic', status: 'completed', settled: true, output: 'CHAT_OK', events,
  responseCycle: {state: 'completed', responseId: 'checked-response'},
  workflow: {nodes: [{id: 'agent', type: 'agent'}]}, nodes: {agent: {status: 'completed', output: 'CHAT_OK'}}});

test('checked delivery repeating the streamed final appears once in live and worker-projected Chat', () => {
  const source = run([
    {nodeId: 'agent', data: {type: 'delta', itemId: 'native-answer', delta: 'CHAT_'}},
    {nodeId: 'agent', data: {type: 'delta', itemId: 'native-answer', delta: 'OK'}},
    event('CHAT_OK', {itemId: 'native-answer', phase: 'final_answer'}),
    event('CHAT_OK', {responseCycleFinal: true}),
  ]);
  assert.deepEqual(messagesOfRun(source).map(message => message.text), ['CHAT_OK']);
  const projected = projectFamily({runs: [source], rootId: source.id});
  assert.deepEqual(projected.runs[0].precomputedMessages.map(message => message.text), ['CHAT_OK']);
  assert.equal(source.events.length, 4, 'The checked delivery receipt remains in saved history.');
  assert.equal(messagesOfRun(source)[0].id, 'agent:native-answer', 'Keep the stable streamed message identity.');
});

test('revised, provisional or separately identified answers are not discarded as duplicate delivery', () => {
  for (const [first, second] of [
    [event('First answer', {itemId: 'one', phase: 'final_answer'}), event('CHAT_OK', {responseCycleFinal: true})],
    [event('CHAT_OK', {itemId: 'one', phase: 'final_answer', provisional: true}), event('CHAT_OK', {responseCycleFinal: true})],
    [event('CHAT_OK', {itemId: 'one', phase: 'final_answer'}), event('CHAT_OK', {itemId: 'two', phase: 'final_answer'})],
  ]) assert.equal(messagesOfRun(run([first, second])).length, 2);
});

test('a direction or another speaker preserves later checked delivery chronology', () => {
  const first = event('CHAT_OK', {itemId: 'one', phase: 'final_answer'}), checked = event('CHAT_OK', {responseCycleFinal: true});
  const direction = {nodeId: 'agent', data: {type: 'steer', text: 'Confirm that exact answer', accepted: true}};
  const directed = messagesOfRun(run([first, direction, checked]));
  assert.deepEqual(directed.map(message => message.role), ['assistant', 'user', 'assistant']);
  const anotherSpeaker = event('Another agent result', {itemId: 'other', phase: 'final_answer'}, 'worker');
  assert.equal(messagesOfRun(run([first, anotherSpeaker, checked])).length, 3);
});
