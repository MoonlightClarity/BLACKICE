import test from 'node:test';
import assert from 'node:assert/strict';
import { observeExternalActions } from '../public/observe-model.mjs';
import { renderObserveExternalActions } from '../public/observe-ui.mjs';

const destination = 'mailto:Hiring.Team%2Bresume@example.test';
const fixture = (extra = {}) => ({ taskState: { externalActions: [{ id: 'email-application', destination, status: 'prepared', attempts: 0, ...extra }] } });

for (const status of ['prepared', 'uncertain']) test(`Observe retains a canonical email recipient as display-only ${status} destination`, () => {
  const saved = fixture({ status, attempts: status === 'uncertain' ? 1 : 0 }), before = structuredClone(saved), model = observeExternalActions(saved), receipt = model.receipts[0], html = renderObserveExternalActions(model);
  assert.equal(receipt.destination, destination); assert.equal(receipt.destinationRecipient, 'Hiring.Team+resume@example.test');
  assert.equal(receipt.url, null); assert.equal(model.confirmed, 0); assert.equal(receipt.needsInspection, status === 'uncertain');
  assert.match(html, /Email recipient/); assert.match(html, /Hiring\.Team\+resume@example\.test/);
  assert.doesNotMatch(html, /href="mailto:|Open confirmed result|window\.open|onclick=|compose|check the website itself/);
  assert.deepEqual(saved, before, 'Displaying an address must not change saved external-action state.');
});

test('email destination does not become result evidence and a real HTTP result remains separately linked', () => {
  const unlinked = observeExternalActions(fixture({ status: 'confirmed', url: destination, evidence: 'A send result was reported.' }));
  assert.equal(unlinked.receipts[0].destinationRecipient, 'Hiring.Team+resume@example.test'); assert.equal(unlinked.receipts[0].url, null); assert.equal(unlinked.needsInspection, 1);
  const html = renderObserveExternalActions(unlinked); assert.doesNotMatch(html, /href=|Open confirmed result/); assert.match(html, /no usable result link/);
  const result = 'https://mail.example.test/sent/message-1', linked = observeExternalActions(fixture({ status: 'confirmed', url: result }));
  assert.equal(linked.receipts[0].url, result); assert.equal(linked.needsInspection, 0);
  assert.match(renderObserveExternalActions(linked), /href="https:\/\/mail\.example\.test\/sent\/message-1"/);
  assert.doesNotMatch(renderObserveExternalActions(linked), /href="mailto:/);
});

test('decoded mailbox punctuation is escaped as text and never becomes an HTML action', () => {
  const model = observeExternalActions(fixture({ destination: "mailto:O'Neil%26team@example.test" })), html = renderObserveExternalActions(model);
  assert.equal(model.receipts[0].destinationRecipient, "O'Neil&team@example.test");
  assert.match(html, /O&#39;Neil&amp;team@example\.test/); assert.doesNotMatch(html, /href=|<script|<img|onclick=/);
});

test('noncanonical mailboxes, headers, multiple recipients and arbitrary schemes are not admitted as destinations', () => {
  for (const value of [
    'mailto:team@example.test?subject=Injected', 'mailto:team@example.test#fragment', 'mailto:team@example.test,other@example.test',
    'mailto:team@example.test;other@example.test', 'mailto:Name <team@example.test>', 'mailto:team%0D%0ABcc%3Aother@example.test',
    'mailto:team\r\n@example.test', 'mailto:team@@example.test', 'mailto:.team@example.test', 'mailto:team..name@example.test',
    'mailto:team.@example.test', 'mailto:team@-example.test', 'mailto:team@example-.test', 'mailto:team@example..test',
    'mailto:team@EXAMPLE.test', 'mailto:%74eam@example.test', 'MAILTO:team@example.test', 'mailto:' + 'a'.repeat(65) + '@example.test',
    'mailto:team@' + 'a'.repeat(64) + '.test', 'javascript:alert(1)', 'data:text/html,<img src=x>',
  ]) {
    const model = observeExternalActions(fixture({ destination: value, status: 'confirmed', url: value })), receipt = model.receipts[0], html = renderObserveExternalActions(model);
    assert.equal(receipt.destination, null, value); assert.equal(receipt.destinationRecipient, undefined, value); assert.equal(receipt.url, null, value);
    assert.doesNotMatch(html, /href=|Email recipient|<img|<script|onclick=/, value);
  }
});

test('HTTP destinations keep their existing link and result behavior without email metadata', () => {
  const destination = 'https://example.test/apply', result = 'https://example.test/receipt/1';
  const model = observeExternalActions(fixture({ destination, status: 'confirmed', url: result })), receipt = model.receipts[0], html = renderObserveExternalActions(model);
  assert.equal(receipt.destination, destination); assert.equal(receipt.url, result); assert.equal(receipt.destinationRecipient, undefined);
  assert.match(html, /href="https:\/\/example\.test\/apply"/); assert.match(html, /href="https:\/\/example\.test\/receipt\/1"/);
  assert.match(html, /Open the result or destination to check the website itself/); assert.doesNotMatch(html, /Email recipient/);
});
