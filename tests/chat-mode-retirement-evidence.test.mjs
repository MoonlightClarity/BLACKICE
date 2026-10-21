import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredChatModeRetirement } from '../scripts/chat-mode-retirement-ui-journey.mjs';

const receipt = () => ({ fixtureOnly: true, route: 'chatgpt::chat-mode', catalogAbsent: true, setupActionsAbsent: true, endpointReceipts: Array.from({ length: 4 }, () => ({ status: 410, code: 'CHAT_MODE_RETIRED' })), savedSelection: 'chatgpt::chat-mode', selectionAfterReload: 'chatgpt::chat-mode', draftPreserved: true, retiredVisible: true, historicalRoute: 'chatgpt::chat-mode', routeAfterNextReplyChange: 'chatgpt::chat-mode', nextReplyModel: 'fixture-model', connectionPresent: true, mobile: { width: 320, fits: true, reverseActions: 0 }, turnsBefore: 6, turnsAfter: 6, historyRecordsAdded: 1, externalRequestCount: 0 });
test('retirement evidence requires preserved history and a working connection without reverse browser actions', () => {
  assert.equal(measuredChatModeRetirement(receipt()), true);
  for (const [key, value] of Object.entries({ catalogAbsent: false, setupActionsAbsent: false, draftPreserved: false, connectionPresent: false, turnsAfter: 7, externalRequestCount: 1, selectionAfterReload: 'fixture-model' })) assert.equal(measuredChatModeRetirement({ ...receipt(), [key]: value }), false, key);
  assert.equal(measuredChatModeRetirement({ ...receipt(), endpointReceipts: [{ status: 410, code: 'CHAT_MODE_RETIRED' }] }), false);
  assert.equal(measuredChatModeRetirement({ ...receipt(), mobile: { width: 320, fits: true, reverseActions: 1 } }), false);
});
