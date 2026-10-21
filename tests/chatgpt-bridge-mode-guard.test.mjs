import test from 'node:test';
import assert from 'node:assert/strict';
import { chatGPTBridgeModeViolation } from '../lib/chatgpt-bridge-mode-guard.mjs';

const redirect = [
  'Please switch to Work Mode to continue.',
  'Switch over to Work Mode.',
  'To complete this task, use Work Mode.',
  '1. Open Work Mode and I will continue there.',
  '**Switch** to **Work Mode**.',
  'Please select "Work Mode".',
  'Use `Work Mode` for this task.',
  'You need to move this into ChatGPT’s Work Mode.',
  'You’ll have to use Work Mode.',
  'You will need Work Mode to finish this.',
  'Can you switch to Work Mode?',
  'Could you please open Work Mode?',
  'Would you like me to hand this off to Work Mode?',
  'Would you like a handoff to Work Mode?',
  'Do you want us to transfer this task into Work Mode?',
  'Want me to move this to Work Mode?',
  'Shall I hand this over to Work Mode?',
  'I can hand this off to Work Mode if you’d like.',
  'I’ll transfer this request to Work Mode.',
  'I would like to continue in Work Mode.',
  'I’d be happy to handle this in Work Mode.',
  'I can only do this in Work Mode.',
  'Let’s move the conversation to Work Mode.',
  'I recommend switching to Work Mode.',
  'We suggest that you use Work Mode.',
  'Why don’t you switch to Work Mode?',
  'Wouldn’t you rather use Work Mode?',
  'Do not switch to Work Mode, but would you like me to hand this off to Work Mode?',
  '> Please switch to Work Mode.\n\nMy answer: please switch to Work Mode.',
  '```text\nPlease switch to Work Mode.\n```\n\nPlease switch to Work Mode.',
];

for (const answer of redirect) test(`rejects direct mode redirect: ${answer.slice(0, 95)}`, () => {
  const violation = chatGPTBridgeModeViolation(answer);
  assert.equal(violation?.code, 'CHATGPT_BRIDGE_CHAT_MODE_REQUIRED');
  assert.match(violation.message, /remains pending/);
  assert.match(violation.message, /authorized connector/);
  assert.match(violation.message, /specific missing capability or blocker to the user in Chat Mode/);
  assert.match(violation.message, /leave this request pending/);
  assert.match(violation.message, /Complete the request only with the requested result/);
});

const allowed = [
  'The completed result is saved in the attached report.',
  'Do not switch to Work Mode. Continue in Chat Mode using the connector.',
  'Please do not switch to Work Mode.',
  'You do not need to switch to Work Mode.',
  'You should not move this to Work Mode.',
  'I cannot switch to Work Mode.',
  'I won’t hand this off to Work Mode.',
  'I would not recommend switching to Work Mode.',
  'Let’s not move this into Work Mode.',
  'There is no need for a handoff to Work Mode.',
  'Switching to Work Mode is not necessary.',
  'Using Work Mode is not required for this request.',
  'I can finish here; switching to Work Mode is unnecessary.',
  'If I said you need to switch to Work Mode, that would be incorrect.',
  'Avoid asking the user to switch to Work Mode.',
  'Do not say: switch to Work Mode.',
  'Work Mode and Chat Mode are different interfaces. This answer stays in Chat Mode.',
  'Work Mode can provide a different tool workflow; availability depends on the host.',
  'Moving to Work Mode changes the interface; it does not change the saved request.',
  'You can use Work Mode for an unrelated task, while this request remains in Chat Mode.',
  'Can you explain how Work Mode differs from Chat Mode?',
  'I can explain how to use Work Mode.',
  'I recommend comparing Work Mode with Chat Mode before documenting the differences.',
  'The guide says you should switch to "the test environment". It describes Work Mode separately.',
  'If you switch to Work Mode, the saved bridge history remains local.',
  'Switch from Work Mode to Chat Mode.',
  'Please switch away from Work Mode.',
  'I can move this out of Work Mode.',
  '> Please switch to Work Mode.\n\nThat quoted request is not needed here.',
  '"Please switch to Work Mode."\n\nThis is a quoted interface message.',
  '‘Would you like me to hand this off to Work Mode?’ is an example of the unwanted prompt.',
  'The interface displayed "Switch to Work Mode to continue." I am reporting that message.',
  "The text 'Would you like me to move this into Work Mode?' should be rejected.",
  'Example: Please switch to Work Mode.\n\nThis illustrates the message the guard checks.',
  '```text\nPlease switch to Work Mode.\nWould you like me to move this to Work Mode?\n```',
  '~~~~md\nPlease switch to Work Mode.\n```\nI can hand this off to Work Mode.\n~~~~\nStay in Chat Mode.',
  '    Please switch to Work Mode.\n\nThe preceding indented line is a code example.',
  '`Please switch to Work Mode.` is a literal test fixture.',
  'The authorized connector lacks a file-write operation. I cannot save the requested artifact with the tools available in this Chat Mode session.',
];

for (const answer of allowed) test(`permits explanation, quote or negation: ${answer.slice(0, 95)}`, () => {
  assert.equal(chatGPTBridgeModeViolation(answer), null);
});

test('a requested comparison can explain generic mode use, but cannot disguise a real handoff offer', () => {
  const context = { prompt: 'Compare Chat Mode versus Work Mode and explain when to use each.' };
  assert.equal(chatGPTBridgeModeViolation('Use Work Mode for tasks that need its tools. Use Chat Mode for the connector exchange.', context), null);
  assert.equal(chatGPTBridgeModeViolation('Use Work Mode when the desired tools are available there.', context), null);
  assert.ok(chatGPTBridgeModeViolation('Please switch to Work Mode so I can complete your task.', context));
  assert.ok(chatGPTBridgeModeViolation('Use Work Mode for this task.', context));
  assert.ok(chatGPTBridgeModeViolation('Would you like me to hand this off to Work Mode?', context));
  assert.ok(chatGPTBridgeModeViolation('Use Work Mode for this task.', { prompt: 'Complete the queued task.' }));
});

test('the bounded check reaches a redirect near the end of a maximum-sized bridge answer', () => {
  const ending = '\n\nWould you like me to hand this off to Work Mode?';
  const answer = ('Verified task notes. '.repeat(14000)).slice(0, 256000 - ending.length) + ending;
  assert.equal(answer.length, 256000);
  assert.ok(chatGPTBridgeModeViolation(answer));
  assert.equal(chatGPTBridgeModeViolation(null), null);
});
