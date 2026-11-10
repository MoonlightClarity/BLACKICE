import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeHostOperation, normalizeHostOperationResult, browserReceiptBindingKey } from '../lib/operation-descriptors.mjs';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import { BrowserWorkspace, createBrowserToolHandler } from '../lib/browser.mjs';
import { observePageReceiptRecords, inspectObservedFormControl } from '../desktop/browser-operation-observation.mjs';
import { BrowserSubmissionObservations, urlencodedFormPayloadDigest } from '../desktop/browser-submission-observation.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const call = (name, args, extra = {}) => ({ name, arguments: JSON.stringify(args), ...extra });
const browserCall = (action = 'click', extra = {}) => call('relay_browser', { action, tabId: 'relay:one', ref: 'e1', ...extra });
const result = (body, success = true) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(body) }] });
const form = (extra = {}) => ({ current: true, tabId: 'relay:one', documentId: 'one:1', url: 'https://portal.test/tenant-a/form',
  control: { ref: 'e1', kind: 'form-submit', form: { id: 'form-1', documentId: 'one:1', action: 'https://portal.test/tenant-a/enroll', method: 'POST', enctype: 'application/x-www-form-urlencoded', target: '_self',
    payloadDigest: hash('payload'), attachmentDigests: [hash('attachment')], identityDigests: [{ name: 'participantId', digest: hash('p1') }, { name: 'workshopId', digest: hash('w1') }] } }, ...extra });
const binding = (extra = {}) => ({ version: 1, format: 'dom', resourceKey: 'origin:https://portal.test', record: '#receipt',
  status: 'data-status', confirmedValues: ['confirmed'], absentValues: ['validation-rejected'], outcomeId: 'data-outcome',
  destination: 'data-form-action', history: false, identity: [{ field: 'data-participant', formField: 'participantId' }, { field: 'data-workshop', formField: 'workshopId' }], ...extra });
const receiptRecord = (extra = {}) => ({ status: 'confirmed', outcomeId: 'p1:w1', destination: '/tenant-a/enroll',
  identityValues: [{ name: 'participantId', field: 'data-participant', value: 'p1' }, { name: 'workshopId', field: 'data-workshop', value: 'w1' }], ...extra });
async function confirmation({ records = [receiptRecord()], receiptBinding = binding(), commitments, observation = {}, descriptor } = {}) {
  const operation = browserCall();
  descriptor ||= await describeHostOperation(operation, { browserObservation: form() });
  commitments ||= [{ operationId: 'op1', workItemId: 'enroll', deliveryState: 'interrupted', effectState: 'unknown', resources: descriptor.resources, commit: descriptor.commit }];
  const observed = { current: true, tabId: 'relay:one', documentId: 'one:2', url: 'https://portal.test/tenant-a/confirmation',
    receipts: [{ bindingKey: browserReceiptBindingKey(receiptBinding), records }], ...observation };
  return normalizeHostOperationResult(result({ documentId: observed.documentId, url: observed.url, text: 'Destination receipt' }),
    { call: operation, descriptor, browserObservation: observed, criteria: [{ id: 'receipt', kind: 'external-confirmation', receiptBinding }], commitments });
}
const confirmations = value => value.evidence.filter(item => item.kind === 'external-confirmation');


test('a previously observed rejection remains bound to its original absent effect after a corrected payload', async () => {
  const original = await describeHostOperation(browserCall(), { browserObservation: form() });
  const rejected = receiptRecord({ status: 'validation-rejected' });
  const first = await confirmation({ descriptor: original, records: [rejected] });
  assert.equal(first.effectState, 'absent');
  const correctedForm = form(); correctedForm.control.form.payloadDigest = hash('corrected actual payload');
  const corrected = await describeHostOperation(browserCall(), { browserObservation: correctedForm });
  const commitments = [
    { operationId: 'old-rejected', deliveryState: 'returned', effectState: 'absent', commit: original.commit, evidence: first.evidence },
    { operationId: 'new-unknown', deliveryState: 'interrupted', effectState: 'unknown', commit: corrected.commit, evidence: [] },
  ];
  for (const documentId of ['one:2', 'reloaded:9']) {
    const observedAgain = await confirmation({ descriptor: corrected, records: [rejected], commitments, observation: { documentId } });
    assert.equal(observedAgain.effectState, 'unconfirmed', 'An old destination record cannot clear a different admitted effect.');
    assert.ok(confirmations(observedAgain).every(item => item.confirmation.effectKey !== corrected.commit.effectKey));
  }
  const actualSuccess = await confirmation({ descriptor: corrected, records: [receiptRecord()], commitments });
  assert.equal(actualSuccess.effectState, 'confirmed');
  assert.equal(confirmations(actualSuccess)[0].confirmation.effectKey, corrected.commit.effectKey);
});


function observedStructuredReceipt({ code = 'LOCATION_SELECTION_REQUIRED', message = 'Select a location.', attributes = {}, receiptBinding = binding() } = {}) {
  const previous = globalThis.document;
  const fields = { 'data-status': 'validation-rejected', 'data-outcome': 'p1:w1', 'data-form-action': '/tenant-a/enroll',
    'data-participant': 'p1', 'data-workshop': 'w1', 'data-validation-code': code, ...attributes };
  try {
    globalThis.document = { querySelectorAll: () => [{ attributes: Object.entries(fields).map(([name, value]) => ({ name, value })),
      innerText: message, getAttribute: name => fields[name] ?? null }] };
    return observePageReceiptRecords([receiptBinding])[0].records[0];
  } finally { globalThis.document = previous; }
}

test('two distinct observed rejection facts reconcile their own effects without changing legacy extracted digests', async () => {
  const original = await describeHostOperation(browserCall(), { browserObservation: form() });
  const firstRecord = observedStructuredReceipt(), first = await confirmation({ descriptor: original, records: [firstRecord] });
  const firstProof = confirmations(first)[0];
  assert.equal(first.effectState, 'absent');
  const correctedForm = form(); correctedForm.control.form.payloadDigest = hash('selected actual location');
  const corrected = await describeHostOperation(browserCall(), { browserObservation: correctedForm });
  const commitments = [
    { operationId: 'location-rejected', deliveryState: 'returned', effectState: 'absent', commit: original.commit, evidence: first.evidence },
    { operationId: 'contact-rejected', deliveryState: 'returned', effectState: 'unknown', commit: corrected.commit, evidence: [] },
  ];
  const secondRecord = observedStructuredReceipt({ code: 'CONTACT_PREFERENCE_REQUIRED', message: 'Select Email confirmations only.' });
  const second = await confirmation({ descriptor: corrected, records: [secondRecord], commitments });
  const secondProof = confirmations(second)[0];
  assert.equal(second.effectState, 'absent');
  assert.match(firstProof.validation.recordSourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(secondProof.confirmation.effectKey, corrected.commit.effectKey);
  assert.equal(firstProof.digest, secondProof.digest, 'Binding-selected status, destination and identity bytes are identical.');
  assert.notEqual(firstProof.validation.recordSourceDigest, secondProof.validation.recordSourceDigest);
  const { recordSource, ...legacyRecord } = firstRecord;
  assert.equal(confirmations(await confirmation({ descriptor: original, records: [legacyRecord] }))[0].digest, firstProof.digest);
  commitments[1].effectState = 'absent'; commitments[1].evidence = second.evidence;
  const thirdForm = form(); thirdForm.control.form.payloadDigest = hash('selected actual contact preference');
  const third = await describeHostOperation(browserCall(), { browserObservation: thirdForm });
  commitments.push({ operationId: 'new-pending', deliveryState: 'interrupted', effectState: 'unknown', commit: third.commit, evidence: [] });
  for (const [record, expected] of [[firstRecord, original], [secondRecord, corrected]]) {
    const repeated = await confirmation({ descriptor: third, records: [record], commitments, observation: { documentId: 'reloaded:9' } });
    assert.equal(repeated.effectState, 'unconfirmed');
    assert.equal(confirmations(repeated)[0].confirmation.effectKey, expected.commit.effectKey);
  }
});

test('same or unavailable source facts never lend an old rejection to a corrected effect', async () => {
  for (const variant of ['same', 'old-missing', 'new-missing', 'both-missing', 'new-malformed', 'new-oversized', 'old-invalid-digest']) {
    const original = await describeHostOperation(browserCall(), { browserObservation: form() });
    const firstRecord = observedStructuredReceipt();
    const secondRecord = variant === 'same' ? structuredClone(firstRecord)
      : observedStructuredReceipt({ code: 'CONTACT_PREFERENCE_REQUIRED', message: 'Select Email confirmations only.' });
    if (['old-missing', 'both-missing'].includes(variant)) delete firstRecord.recordSource;
    if (['new-missing', 'both-missing'].includes(variant)) delete secondRecord.recordSource;
    if (variant === 'new-malformed') secondRecord.recordSource = '{invalid';
    if (variant === 'new-oversized') secondRecord.recordSource = 'x'.repeat(16385);
    const first = await confirmation({ descriptor: original, records: [firstRecord] });
    if (variant === 'old-invalid-digest') confirmations(first)[0].validation.recordSourceDigest = 'not-a-host-sha';
    const changedForm = form(); changedForm.control.form.payloadDigest = hash('different submitted payload');
    const changed = await describeHostOperation(browserCall(), { browserObservation: changedForm });
    const commitments = [
      { operationId: 'old', deliveryState: 'returned', effectState: 'absent', commit: original.commit, evidence: first.evidence },
      { operationId: 'new', deliveryState: 'dispatched', effectState: 'unknown', commit: changed.commit, evidence: [] },
    ];
    const observed = await confirmation({ descriptor: changed, records: [secondRecord], commitments,
      observation: { documentId: 'later:99', capturedAt: '2099-01-01T00:00:00.000Z' } });
    assert.equal(observed.effectState, 'unconfirmed', variant);
    assert.ok(confirmations(observed).every(item => item.confirmation.effectKey === original.commit.effectKey), variant);
  }
});

test('source fingerprints preserve binding refinement, identity ordering and meaning guards for the same fact', async () => {
  for (const change of ['refinement', 'identity-order', 'polarity', 'prior']) {
    const partial = binding({ confirmedValues: [], prior: { field: 'data-prior', values: ['false'] } });
    const record = observedStructuredReceipt({ receiptBinding: partial, attributes: { 'data-prior': 'false' } });
    const original = await describeHostOperation(browserCall(), { browserObservation: form() });
    const first = await confirmation({ descriptor: original, records: [record], receiptBinding: partial });
    const changedForm = form(); changedForm.control.form.payloadDigest = hash('corrected payload');
    const changed = await describeHostOperation(browserCall(), { browserObservation: changedForm });
    const revised = { ...partial, confirmedValues: ['confirmed'] }, currentRecord = structuredClone(record);
    if (change === 'identity-order') { revised.identity = [...revised.identity].reverse(); currentRecord.identityValues.reverse(); }
    if (change === 'polarity') { revised.confirmedValues = ['validation-rejected']; revised.absentValues = []; }
    if (change === 'prior') { delete revised.prior; delete currentRecord.prior; }
    const commitments = [
      { operationId: 'old', deliveryState: 'returned', effectState: 'absent', commit: original.commit, evidence: first.evidence },
      { operationId: 'new', deliveryState: 'interrupted', effectState: 'unknown', commit: changed.commit, evidence: [] },
    ], saved = structuredClone(commitments);
    const observed = await confirmation({ descriptor: changed, records: [currentRecord], commitments, receiptBinding: revised });
    assert.equal(observed.effectState, 'unconfirmed', change);
    if (change === 'refinement') assert.equal(confirmations(observed)[0].confirmation.effectKey, original.commit.effectKey);
    else assert.equal(confirmations(observed).length, 0, change);
    assert.deepEqual(commitments, saved);
  }
});

test('DOM source facts ignore selector, cosmetic attributes and whitespace but retain unbound receipt facts', () => {
  const original = observedStructuredReceipt();
  assert.equal(typeof original.recordSource, 'string');
  const cosmetic = observedStructuredReceipt({ message: ' Select  a\nlocation. ', attributes: { id: 'other', class: 'new-theme', style: 'color:red' },
    receiptBinding: binding({ record: '.different-selector', identity: [...binding().identity].reverse() }) });
  assert.equal(cosmetic.recordSource, original.recordSource);
  assert.notEqual(observedStructuredReceipt({ code: 'CONTACT_PREFERENCE_REQUIRED' }).recordSource, original.recordSource);
  assert.notEqual(observedStructuredReceipt({ message: 'A distinct issuer rejection.' }).recordSource, original.recordSource);
  for (const attributes of [{ 'data-large': 'x'.repeat(8193) },
    Object.fromEntries(Array.from({ length: 3 }, (_, i) => ['data-large-' + i, 'x'.repeat(7000)])),
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['data-field-' + i, 'value']))]) {
    const oversized = observedStructuredReceipt({ attributes });
    assert.equal(oversized.recordSource, undefined, 'Oversized facts are omitted whole, never truncated.');
    assert.equal(oversized.status, original.status, 'Ordinary receipt extraction is unchanged.');
  }
});

test('JSON source facts use bounded canonical complete records without changing extracted fields', () => {
  const previous = globalThis.document;
  const jsonBinding = binding({ format: 'json', record: '/receipt', status: '/status', outcomeId: '/outcome', destination: '/action',
    identity: [{ field: '/participant', formField: 'participantId' }, { field: '/workshop', formField: 'workshopId' }] });
  const base = { status: 'validation-rejected', outcome: 'p1:w1', action: '/tenant-a/enroll', participant: 'p1', workshop: 'w1',
    details: { code: 'LOCATION_SELECTION_REQUIRED', alternatives: ['one', 'two'] } };
  const read = value => { globalThis.document = { body: { innerText: JSON.stringify({ receipt: value }) } }; return observePageReceiptRecords([jsonBinding])[0].records[0]; };
  try {
    const original = read(base), reordered = read({ details: { alternatives: ['one', 'two'], code: 'LOCATION_SELECTION_REQUIRED' },
      workshop: 'w1', participant: 'p1', action: '/tenant-a/enroll', outcome: 'p1:w1', status: 'validation-rejected' });
    assert.equal(typeof original.recordSource, 'string'); assert.equal(original.recordSource, reordered.recordSource);
    assert.notEqual(read({ ...base, details: { ...base.details, alternatives: ['two', 'one'] } }).recordSource, original.recordSource);
    assert.notEqual(read({ ...base, details: { ...base.details, code: 'CONTACT_PREFERENCE_REQUIRED' } }).recordSource, original.recordSource);
    let deep = 'leaf'; for (let i = 0; i < 14; i++) deep = { child: deep };
    for (const details of ['x'.repeat(8193), deep, Array.from({ length: 257 }, () => 'value'), ['x'.repeat(7000), 'y'.repeat(7000), 'z'.repeat(7000)]]) {
      const oversized = read({ ...base, details }); assert.equal(oversized.recordSource, undefined); assert.equal(oversized.status, original.status);
    }
  } finally { globalThis.document = previous; }
});

async function refinedRejectionFixture() {
  const operation = browserCall(), original = await describeHostOperation(operation, { browserObservation: form() });
  const unbound = { id: 'receipt', kind: 'external-confirmation', resourceKey: 'origin:https://portal.test' };
  const first = await normalizeHostOperationResult(result({ documentId: 'one:2', url: form().url, text: 'Actual rejection' }),
    { call: operation, descriptor: original, criteria: [unbound] });
  assert.equal(first.effectState, 'unconfirmed'); assert.equal(confirmations(first).length, 0);
  const partial = binding({ confirmedValues: [] }), rejected = receiptRecord({ status: 'validation-rejected' });
  const reconciled = await confirmation({ descriptor: original, receiptBinding: partial, records: [rejected] });
  assert.equal(reconciled.effectState, 'absent');
  const correctedForm = form(); correctedForm.control.form.payloadDigest = hash('corrected actual payload');
  const corrected = await describeHostOperation(operation, { browserObservation: correctedForm }), refined = binding();
  const commitments = [
    { operationId: 'original-unbound', deliveryState: 'returned', effectState: 'absent', commit: original.commit, evidence: reconciled.evidence, criteria: [unbound] },
    { operationId: 'corrected-pending', deliveryState: 'interrupted', effectState: 'unknown', commit: corrected.commit, evidence: [], criteria: [{ ...unbound, receiptBinding: refined }] },
  ];
  return { original, partial, rejected, correctedForm, corrected, refined, commitments };
}

test('binding refinement preserves an original rejection after an unbound commit and partial reconciliation', async () => {
  const f = await refinedRejectionFixture(), retained = structuredClone(f.commitments);
  const stale = await confirmation({ descriptor: f.corrected, receiptBinding: f.refined, records: [f.rejected], commitments: f.commitments });
  assert.equal(stale.effectState, 'unconfirmed', 'A stale rejection must not clear the newer corrected effect.');
  assert.equal(confirmations(stale).length, 1);
  assert.equal(confirmations(stale)[0].confirmation.effectKey, f.original.commit.effectKey);
  assert.equal(confirmations(stale)[0].confirmation.status, 'absent');
  const actual = await confirmation({ descriptor: f.corrected, receiptBinding: f.refined, records: [receiptRecord()], commitments: f.commitments });
  assert.equal(actual.effectState, 'confirmed');
  assert.equal(confirmations(actual)[0].confirmation.effectKey, f.corrected.commit.effectKey);
  assert.deepEqual(f.commitments, retained, 'Refinement neither rewrites retained proof bytes nor changes the saved effect identity.');
});

test('binding order mapping and meaning changes cannot reassign a retained issuer rejection', async () => {
  for (const change of ['identity-order', 'extractor-field', 'outcome-field-name', 'polarity', 'prior']) {
    const f = await refinedRejectionFixture(), retained = structuredClone(f.commitments), revised = structuredClone(f.refined), record = structuredClone(f.rejected);
    if (change === 'identity-order') { revised.identity.reverse(); record.identityValues.reverse(); }
    if (change === 'extractor-field') { revised.identity[0].field = 'data-candidate'; record.identityValues[0].field = 'data-candidate'; }
    if (change === 'outcome-field-name') {
      revised.identity[0].formField = 'candidateId'; record.identityValues[0].name = 'candidateId';
      f.commitments[1].commit.identityDigests.push({ name: 'candidateId', digest: hash('p1') });
    }
    if (change === 'polarity') { revised.confirmedValues = ['validation-rejected']; revised.absentValues = []; }
    if (change === 'prior') revised.prior = { field: 'data-prior', values: ['prior'] };
    if (change === 'prior') {
      record.prior = 'prior';
      const priorProof = await confirmation({ descriptor: f.original, receiptBinding: { ...f.partial, prior: revised.prior }, records: [record] });
      f.commitments[0].evidence = priorProof.evidence;
      delete revised.prior;
    }
    const before = structuredClone(f.commitments);
    const observed = await confirmation({ descriptor: f.corrected, receiptBinding: revised, records: [record], commitments: f.commitments });
    assert.equal(observed.effectState, 'unconfirmed', change);
    assert.equal(confirmations(observed).length, 0, change + ' must abstain rather than invent a new alias or meaning.');
    assert.deepEqual(f.commitments, before);
    assert.deepEqual(retained[0].commit, f.commitments[0].commit);
  }
});

test('binding refinement still accepts a distinct observed subject with an issuer-local receipt identity', async () => {
  const f = await refinedRejectionFixture();
  f.correctedForm.control.form.identityDigests[0].digest = hash('p2');
  const corrected = await describeHostOperation(browserCall(), { browserObservation: f.correctedForm });
  f.commitments[1].commit = corrected.commit;
  const record = receiptRecord({ status: 'validation-rejected', identityValues: [
    { name: 'participantId', field: 'data-participant', value: 'p2' },
    { name: 'workshopId', field: 'data-workshop', value: 'w1' },
  ] });
  const actual = await confirmation({ descriptor: corrected, receiptBinding: f.refined, records: [record], commitments: f.commitments });
  assert.equal(actual.effectState, 'absent');
  assert.equal(confirmations(actual)[0].confirmation.effectKey, corrected.commit.effectKey);
});

test('reserved or cancelled-before-dispatch descriptors cannot acquire a destination confirmation', async () => {
  const descriptor = await describeHostOperation(browserCall(), { browserObservation: form() });
  for (const deliveryState of [undefined, 'reserved', 'cancelled', 'abandoned']) {
    const value = await confirmation({ descriptor, commitments: [{ operationId: 'never-dispatched', deliveryState, effectState: 'unknown', commit: descriptor.commit }] });
    assert.equal(confirmations(value).length, 0);
    assert.equal(value.effectState, 'unconfirmed');
  }
});

test('outcome identity stays distinct across exact destinations and stable across payload edits', async () => {
  const first = confirmations(await confirmation())[0];
  const other = form(); other.control.form.action = 'https://portal.test/tenant-b/enroll';
  const otherDescriptor = await describeHostOperation(browserCall(), { browserObservation: other });
  const second = confirmations(await confirmation({ descriptor: otherDescriptor, records: [receiptRecord({ destination: '/tenant-b/enroll' })] }))[0];
  assert.equal(first.resourceKey, second.resourceKey, 'The broad observation criterion may cover both destinations.');
  assert.notEqual(first.confirmation.outcomeId, second.confirmation.outcomeId, 'Raw issuer IDs are qualified by exact destination.');
  const edited = form(); edited.control.form.payloadDigest = hash('different cover letter');
  const editedDescriptor = await describeHostOperation(browserCall(), { browserObservation: edited });
  const editedProof = confirmations(await confirmation({ descriptor: editedDescriptor }))[0];
  assert.notEqual(first.confirmation.effectKey, editedProof.confirmation.effectKey);
  assert.equal(first.confirmation.outcomeId, editedProof.confirmation.outcomeId, 'One applicant/entity stays one outcome after payload edits.');
  assert.equal(first.validation.rawOutcomeId, 'p1:w1');
  assert.equal(first.validation.destinationKey, 'destination:https://portal.test/tenant-a/enroll');
});

test('caller flags and namespaced shadows never turn opaque tools into observations', async () => {
  for (const operation of [call('custom', { action: 'read', readOnly: true }), call('relay_workspace', { action: 'read', readOnly: true }, { namespace: 'custom' }), call('relay_browser', { action: 'invented', readOnly: true })]) {
    assert.equal((await describeHostOperation(operation)).effect, 'opaque');
  }
  assert.equal((await describeHostOperation(call('relay_workspace', { action: 'run', command: 'echo hello', readOnly: true }), { cwd: path.resolve('.') })).effect, 'opaque');
});

test('workspace ancestors scope disjoint files without becoming shared write locks', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'descriptor-scope-')); t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const first = await describeHostOperation(call('relay_workspace', { action: 'write', path: 'a.txt', text: 'a' }), { cwd });
  const second = await describeHostOperation(call('relay_workspace', { action: 'write', path: 'b.txt', text: 'b' }), { cwd });
  const concrete = value => value.resources.filter(item => !item.scopeOnly).map(item => item.key);
  assert.equal(first.effect, 'interact'); assert.equal(first.resources.find(item => item.key.startsWith('workspace:')).scopeOnly, true);
  assert.deepEqual(concrete(first).filter(key => concrete(second).includes(key)), []);
  const target = first.resources.find(item => !item.scopeOnly); assert.ok(target.scopeKeys.some(key => key.startsWith('workspace:')));
  const outside = await describeHostOperation(call('relay_workspace', { action: 'write', path: path.resolve(cwd, '..', 'other-tenant.txt'), text: 'a' }), { cwd });
  assert.ok(outside.resources.every(item => !item.key.startsWith('workspace:' + cwd.replaceAll('\\', '/').toLowerCase())));
});

test('undo descriptor uses the durable patch target and ignores a caller path', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'descriptor-undo-')); t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const target = path.join(cwd, 'actual.txt'), handler = createWorkspaceToolHandler({ cwd, patchStore: { get: async id => ({ id, path: target }) } });
  const operation = call('relay_workspace', { action: 'undo_patch', patchId: 'saved', path: 'invented.txt' });
  const unknown = await describeHostOperation(operation, { cwd });
  assert.equal(unknown.effect, 'opaque'); assert.equal(unknown.resources.some(item => item.key.includes('invented.txt')), false);
  const trusted = await handler.describeOperation(operation);
  assert.equal(trusted.effect, 'interact'); assert.ok(trusted.resources.some(item => item.key.endsWith('/actual.txt') && !item.scopeOnly));
  assert.equal(trusted.resources.some(item => item.key.endsWith('/invented.txt')), false);
});

test('navigation destination and its tab mutation never inherit old tenant scope', async () => {
  const descriptor = await describeHostOperation(browserCall('navigate', { url: 'https://portal.test/tenant-b/form' }), { browserObservation: form() });
  const destination = descriptor.resources.find(item => item.key === 'destination:https://portal.test/tenant-b/form');
  const tab = descriptor.resources.find(item => item.key === 'tab:relay:one');
  const document = descriptor.resources.find(item => item.key === 'document:one:1');
  assert.equal(descriptor.effect, 'observe', 'An explicit GET can inspect history after an uncertain commit.');
  assert.equal(destination.access, 'read');
  assert.equal(tab.access, 'write', 'Navigation still serializes mutations of the same tab.');
  assert.equal(document.access, 'write');
  for (const target of [destination, tab, document]) {
    assert.equal(target.scopeKeys.includes('url:https://portal.test/tenant-a/'), false);
    assert.equal(target.scopeKeys.includes('url:https://portal.test/tenant-b/'), true);
  }
  assert.ok(descriptor.resources.some(item => item.key === 'url:https://portal.test/tenant-a/form' && item.access === 'read'));
});

test('explicit GET navigation stays observational without trusting click labels or resubmitting history', async () => {
  const opened = await describeHostOperation(call('relay_browser', { action: 'open', url: 'https://portal.test/history' }));
  assert.equal(opened.effect, 'observe');
  assert.ok(opened.resources.some(item => item.key === 'destination:https://portal.test/history' && item.access === 'read'));
  const navigated = await describeHostOperation(browserCall('navigate', { url: 'https://portal.test/history' }));
  assert.equal(navigated.effect, 'observe');
  assert.ok(navigated.resources.some(item => item.key === 'tab:relay:one' && item.access === 'write'));
  for (const action of ['back', 'forward', 'reload'])
    assert.equal((await describeHostOperation(browserCall(action), { browserObservation: form() })).effect, 'interact');
  const observedLink = form({ control: { ref: 'e1', kind: 'link', href: 'https://portal.test/history' } });
  assert.equal((await describeHostOperation(browserCall(), { browserObservation: observedLink })).effect, 'interact');
  assert.notEqual((await describeHostOperation(browserCall('navigate', { url: 'javascript:submit()' }))).effect, 'observe');
});

test('deep URL observation preserves its concrete URL instead of selecting a scopeOnly parent', async () => {
  const url = 'https://portal.test/tenant-a/catalog?topic=engineering';
  const operation = call('relay_browser', { action: 'open', url });
  const descriptor = await describeHostOperation(operation);
  assert.ok(descriptor.resources.some(resource => resource.key === 'url:https://portal.test/' && resource.scopeOnly));
  const normalized = await normalizeHostOperationResult(result({ url, documentId: 'catalog:1', text: 'Actual catalog' }), { call: operation, descriptor });
  assert.equal(normalized.evidence[0].resourceKey, 'url:' + url);
  assert.ok(descriptor.resources.find(resource => resource.key === normalized.evidence[0].resourceKey).scopeKeys.includes('origin:https://portal.test'));
});

test('native tab inventory keeps browser identity when a current tab or control is supplied', async () => {
  for (const operation of [call('relay_browser', { action: 'tabs' }), browserCall('tabs')]) {
    const descriptor = await describeHostOperation(operation, { browserObservation: form() });
    assert.equal(descriptor.effect, 'observe');
    assert.deepEqual(descriptor.resources, [{ key: 'browser:relay', access: 'read' }]);
    const normalized = await normalizeHostOperationResult(result({ tabs: [{ tabId: 'relay:one', url: form().url }] }), { call: operation, descriptor });
    assert.equal(normalized.evidence[0].resourceKey, 'browser:relay');
    assert.equal(normalized.evidence.some(row => row.resourceKey.startsWith('document:') || row.resourceKey.startsWith('origin:')), false);
  }
});

test('commit effect identity survives reload while document/form binding stays fresh', async () => {
  const old = form(), refreshed = structuredClone(old); refreshed.documentId = 'one:9'; refreshed.control.form.documentId = 'one:9'; refreshed.control.form.id = 'new-renderer-form';
  const first = await describeHostOperation(browserCall(), { browserObservation: old });
  const second = await describeHostOperation(browserCall(), { browserObservation: refreshed });
  assert.equal(first.effect, 'commit'); assert.equal(first.commit.effectKey, second.commit.effectKey);
  assert.notEqual(first.operationKey, second.operationKey); assert.notEqual(first.commit.formKey, second.commit.formKey);
  refreshed.control.form.payloadDigest = hash('changed letter');
  assert.notEqual(first.commit.effectKey, (await describeHostOperation(browserCall(), { browserObservation: refreshed })).commit.effectKey);
});

test('ref-free browser input keeps conservative effects without an observed control', async () => {
  for (const control of [undefined, null]) {
    const observed = form({ control });
    for (const [action, extra, expected] of [
      ['click', { x: 120, y: 80 }, 'opaque'],
      ['press', { key: 'Enter' }, 'opaque'],
      ['press', { key: 'a' }, 'opaque'],
      ['press', { key: 'Tab' }, 'interact'],
      ['press', { key: 'ArrowDown' }, 'interact'],
    ]) {
      const operation = browserCall(action, { ref: undefined, expectedDocumentId: observed.documentId, expectedUrl: observed.url, ...extra });
      const descriptor = await describeHostOperation(operation, { browserObservation: observed });
      assert.equal(descriptor.effect, expected, action + ' ' + (extra.key || 'coordinates'));
      assert.equal(descriptor.commit, undefined);
      assert.ok(descriptor.resources.some(item => item.key === 'tab:relay:one' && item.access === 'write'));
      assert.ok(descriptor.resources.some(item => item.key === 'document:one:1' && item.access === 'write'));
    }
  }
});

test('browser special control classification requires a current valid matching reference', async () => {
  for (const kind of ['field', 'link', 'form-navigation']) {
    const control = { ref: 'e1', kind, href: 'https://portal.test/history',
      form: { ...form().control.form, method: 'GET', navigationUrl: 'https://portal.test/history' } };
    for (const [ref, observed] of [
      ['e1', form({ current: false, control })],
      ['e1', form({ control: { ...control, ref: 'e2' } })],
      [undefined, form({ control: { ...control, ref: undefined } })],
      ['', form({ control: { ...control, ref: '' } })],
      ['bad\u0000ref', form({ control: { ...control, ref: 'bad\u0000ref' } })],
    ]) {
      const descriptor = await describeHostOperation(browserCall('click', { ref }), { browserObservation: observed });
      assert.equal(descriptor.effect, 'opaque', kind + ' cannot gain authority from an absent, invalid, stale, or unmatched ref');
      assert.equal(descriptor.commit, undefined);
    }
  }
});

test('valid host-observed field link and form classifications remain unchanged', async () => {
  for (const [control, expected] of [
    [{ ref: 'e1', kind: 'field' }, 'interact'],
    [{ ref: 'e1', kind: 'link', href: 'https://portal.test/history' }, 'interact'],
    [{ ref: 'e1', kind: 'form-navigation', form: { ...form().control.form, method: 'GET', navigationUrl: 'https://portal.test/history' } }, 'interact'],
    [form().control, 'commit'],
  ]) {
    for (const action of ['click', 'press']) {
      const descriptor = await describeHostOperation(browserCall(action, action === 'press' ? { key: 'Enter' } : {}), { browserObservation: form({ control }) });
      assert.equal(descriptor.effect, control.kind === 'field' && action === 'press' ? 'opaque' : expected, control.kind + ' ' + action);
      if (expected === 'commit') {
        assert.equal(descriptor.commit.destinationKey, 'destination:https://portal.test/tenant-a/enroll');
        assert.equal(descriptor.commit.payloadDigest, form().control.form.payloadDigest);
      } else assert.equal(descriptor.commit, undefined);
    }
  }
});

test('model-provided form metadata and stale controls cannot declare a commit', async () => {
  assert.equal((await describeHostOperation(browserCall('click', { form: form().control.form, kind: 'form-submit' }))).effect, 'opaque');
  for (const observed of [form({ current: false }), form({ documentId: 'different' }), form({ control: { ...form().control, ref: 'e2' } })])
    assert.equal((await describeHostOperation(browserCall(), { browserObservation: observed })).effect, 'opaque');
});

test('native no-dispatch metadata is absent but arbitrary tool JSON cannot clear uncertainty', async () => {
  const opaque = call('external_tool', { action: 'commit' });
  assert.equal((await normalizeHostOperationResult(result({ inputDispatched: false }, false), { call: opaque })).effectState, 'unknown');
  assert.equal((await normalizeHostOperationResult(result({ actionDispatched: false }, false), { call: browserCall() })).effectState, 'absent');
  assert.equal((await normalizeHostOperationResult(result({ actionDispatched: false }, false), { call: { ...browserCall(), namespace: 'external' } })).effectState, 'unknown');
});

test('successful click and acceptance-like page prose never manufacture an external outcome', async () => {
  const actual = await normalizeHostOperationResult(result({ clicked: true, text: 'Thank you, your application was received.', confirmation: { outcomeId: 'invented' } }), { call: browserCall() });
  assert.equal(actual.effectState, 'confirmed'); assert.equal(confirmations(actual).length, 0); assert.equal(actual.progressKey, undefined);
});

test('actual bounded workspace read reports only whole delivered lines of one source version', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'descriptor-read-')); t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, 'source.txt'), Array.from({ length: 93 }, (_, i) => 'record ' + (i + 1)).join('\n'));
  const handler = createWorkspaceToolHandler({ cwd }), operation = call('relay_workspace', { action: 'read', path: 'source.txt', lineCount: 37 });
  const descriptor = await handler.describeOperation(operation), returned = await handler(operation);
  const normalized = await handler.normalizeOperationResult(returned, { call: operation, descriptor });
  const coverage = normalized.evidence.find(item => item.kind === 'source-coverage');
  assert.deepEqual(coverage.coverage, { unit: 'lines', start: 0, end: 37, total: 93 });
  const body = JSON.parse(returned.contentItems[0].text);
  assert.equal(body.truncated, true); assert.equal(body.nextStartLine, 38);
  const shortened = { ...body, content: body.content.split('\n').slice(0, 12).join('\n') };
  assert.equal((await handler.normalizeOperationResult(result(shortened), { call: operation, descriptor })).evidence.some(item => item.kind === 'source-coverage'), false);
  const preview = { ...body, preview: body.content }; delete preview.content;
  assert.equal((await handler.normalizeOperationResult(result(preview), { call: operation, descriptor })).evidence.some(item => item.kind === 'source-coverage'), false);
});

test('unchanged validation across documents has one progress identity; actual payload change differs', async () => {
  const a = await describeHostOperation(browserCall(), { browserObservation: form() });
  const refreshed = form({ documentId: 'one:7' }); refreshed.control.form.documentId = 'one:7';
  const b = await describeHostOperation(browserCall(), { browserObservation: refreshed });
  const body = documentId => ({ documentId, at: documentId, frames: [{ documentId, validation: [{ name: 'email', message: 'Enter a valid email.' }] }] });
  const x = await normalizeHostOperationResult(result(body('one:1')), { call: browserCall(), descriptor: a });
  const y = await normalizeHostOperationResult(result(body('one:7')), { call: browserCall(), descriptor: b });
  assert.ok(x.progressKey); assert.equal(x.progressKey, y.progressKey);
  refreshed.control.form.payloadDigest = hash('corrected actual field');
  const c = await describeHostOperation(browserCall(), { browserObservation: refreshed });
  assert.notEqual(x.progressKey, (await normalizeHostOperationResult(result(body('one:8')), { call: browserCall(), descriptor: c })).progressKey);
});

test('destination-issued identity resolves one admitted commit using exact endpoint and field digests', async () => {
  const actual = await confirmation();
  assert.equal(actual.effectState, 'confirmed'); assert.equal(confirmations(actual).length, 1);
  assert.equal(confirmations(actual)[0].validation.rawOutcomeId, 'p1:w1');
  assert.match(confirmations(actual)[0].confirmation.outcomeId, /^destination-outcome:[a-f0-9]{64}$/);
  assert.ok(confirmations(actual)[0].confirmation.effectKey);
});

test('same-origin wrong tenant, wrong query, invalid URL, missing linkage and wrong identity remain unconfirmed', async () => {
  for (const record of [
    receiptRecord({ destination: '/tenant-b/enroll' }), receiptRecord({ destination: '/tenant-a/enroll?other=1' }),
    receiptRecord({ destination: 'https://user:secret@portal.test/tenant-a/enroll' }),
    receiptRecord({ destination: 'javascript:submit()' }), receiptRecord({ destination: undefined }),
    receiptRecord({ identityValues: [{ name: 'participantId', field: 'data-participant', value: 'another-person' }, { name: 'workshopId', field: 'data-workshop', value: 'w1' }] }),
  ]) assert.equal(confirmations(await confirmation({ records: [record] })).length, 0);
  assert.equal(confirmations(await confirmation({ observation: { url: 'https://other.test/tenant-a/confirmation' } })).length, 0);
});

test('observed document URL is the only fallback destination, never binding resourceKey', async () => {
  const b = binding(); delete b.destination;
  assert.equal(confirmations(await confirmation({ receiptBinding: b })).length, 0);
  assert.equal(confirmations(await confirmation({ receiptBinding: b, observation: { url: 'https://portal.test/tenant-a/enroll' } })).length, 1);
});

test('unlinked history stays prior and does not clear a missing effect', async () => {
  const actual = await confirmation({ receiptBinding: binding({ history: true }), commitments: [] });
  const proof = confirmations(actual)[0];
  assert.equal(proof.confirmation.prior, true); assert.equal(proof.confirmation.effectKey, undefined); assert.equal(actual.effectState, 'unconfirmed');
  assert.equal(confirmations(await confirmation({ commitments: [] })).length, 0);
});

test('duplicates are one proof, conflicting statuses and ambiguous effect identities are no proof', async () => {
  assert.equal(confirmations(await confirmation({ records: [receiptRecord(), receiptRecord()] })).length, 1);
  assert.equal(confirmations(await confirmation({ records: [receiptRecord(), receiptRecord({ status: 'validation-rejected' })] })).length, 0);
  const descriptor = await describeHostOperation(browserCall(), { browserObservation: form() });
  const commits = ['one', 'two'].map((id, index) => ({ operationId: id, deliveryState: 'dispatched', commit: { ...descriptor.commit, effectKey: hash(index) } }));
  assert.equal(confirmations(await confirmation({ commitments: commits })).length, 0);
});

test('a matched explicit rejection is absent; zero records and unrelated history are not absence', async () => {
  const actual = await confirmation({ records: [receiptRecord({ status: 'validation-rejected' })] });
  assert.equal(actual.effectState, 'absent');
  assert.equal((await confirmation({ records: [] })).effectState, 'unconfirmed');
  assert.equal(confirmations(await confirmation({ records: [receiptRecord({ status: 'validation-rejected' })], receiptBinding: binding({ history: true }), commitments: [] })).length, 0);
});

test('prior destination record and oversized or ambiguous batches never become new outcomes', async () => {
  const b = binding({ prior: { field: 'data-prior', values: ['true'] } });
  assert.equal(confirmations(await confirmation({ receiptBinding: b, records: [receiptRecord({ prior: 'true' })] }))[0].confirmation.prior, true);
  assert.equal(confirmations(await confirmation({ records: Array.from({ length: 101 }, () => receiptRecord()) })).length, 0);
  assert.equal(confirmations(await confirmation({ records: [receiptRecord({ ambiguous: true })] })).length, 0);
});

test('production DOM and JSON extraction retains actual fields and rejects missing/invalid pointers', () => {
  const old = globalThis.document;
  try {
    const attrs = { 'data-status': 'confirmed', 'data-outcome': 'p1:w1', 'data-form-action': '/tenant-a/enroll', 'data-participant': 'p1', 'data-workshop': 'w1' };
    globalThis.document = { querySelectorAll: selector => selector === '#receipt' ? [{ getAttribute: name => attrs[name] ?? null }] : [], body: { innerText: JSON.stringify({ receipt: { status: 'confirmed', outcome: 'p1:w1', action: '/tenant-a/enroll', participant: 'p1', workshop: 'w1' } }) } };
    const observed = observePageReceiptRecords([binding()]);
    assert.equal(observed[0].records[0].status, 'confirmed'); assert.equal(observed[0].records[0].identityValues[0].value, 'p1');
    const json = binding({ format: 'json', record: '/receipt', status: '/status', outcomeId: '/outcome', destination: '/action', identity: [{ field: '/participant', formField: 'participantId' }] });
    assert.equal(observePageReceiptRecords([json])[0].records[0].destination, '/tenant-a/enroll');
    assert.equal(observePageReceiptRecords([{ ...json, status: '/missing' }])[0].records[0].ambiguous, true);
    assert.deepEqual(observePageReceiptRecords([{ ...json, record: '/bad~2pointer' }])[0].records, []);
  } finally { globalThis.document = old; }
});

test('plain observed text retains its own digest and cancellation cannot emit a descriptor', async () => {
  const operation = call('custom', {});
  const a = await normalizeHostOperationResult({ success: true, contentItems: [{ type: 'inputText', text: 'first' }] }, { call: operation });
  const b = await normalizeHostOperationResult({ success: true, contentItems: [{ type: 'inputText', text: 'second' }] }, { call: operation });
  assert.notEqual(a.evidence[0].digest, b.evidence[0].digest);
  await assert.rejects(describeHostOperation(operation, { signal: AbortSignal.abort(new Error('Stopped')) }), /Stopped/);
});

test('real browser handler revalidates the queued form descriptor before dispatch', async t => {
  let observed = form(), dispatched = 0;
  const driver = { status: () => ({ available: true, contained: true, containedAvailable: true, activeTab: 'relay:one',
    tabs: [{ browser: 'relay', tabId: 'relay:one', url: observed.url, documentId: observed.documentId, purpose: 'task' }] }),
    observeOperation: async () => structuredClone(observed), perform: async () => { dispatched++; return { tabId: 'relay:one', documentId: observed.documentId, url: observed.url, clicked: true }; } };
  const browser = new BrowserWorkspace({ driver }), handler = createBrowserToolHandler({ browser });
  const operation = browserCall(), descriptor = await handler.describeOperation(operation);
  observed.control.form.payloadDigest = hash('changed while queued');
  const returned = await handler(operation, { operationDescriptor: descriptor });
  assert.equal(dispatched, 0); assert.equal(returned.success, false); assert.equal(returned.code, 'OPERATION_DESCRIPTOR_CHANGED');
  assert.equal((await handler.normalizeOperationResult(returned, { call: operation, descriptor })).effectState, 'absent');
});

test('GET search form is a navigation interaction and transport changes invalidate dispatch identity', async () => {
  const post = form(), get = structuredClone(post);
  get.control.kind = 'form-navigation'; get.control.form.method = 'GET'; get.control.form.navigationUrl = 'https://portal.test/search?q=observed';
  const committed = await describeHostOperation(browserCall(), { browserObservation: post });
  const navigation = await describeHostOperation(browserCall(), { browserObservation: get });
  assert.equal(committed.effect, 'commit'); assert.equal(navigation.effect, 'interact'); assert.equal(navigation.commit, undefined);
  assert.ok(navigation.resources.some(item => item.key === 'destination:https://portal.test/search?q=observed'));
  for (const [key, value] of [['method', 'GET'], ['enctype', 'multipart/form-data'], ['target', '_blank']]) {
    const changed = structuredClone(post); changed.control.form[key] = value;
    assert.notEqual(committed.operationKey, (await describeHostOperation(browserCall(), { browserObservation: changed })).operationKey);
  }
});

test('a proven-absent previous payload cannot make the corrected admitted effect ambiguous', async () => {
  const descriptor = await describeHostOperation(browserCall(), { browserObservation: form() });
  const commitments = [
    { operationId: 'rejected-before', deliveryState: 'returned', effectState: 'absent', commit: { ...descriptor.commit, effectKey: hash('old rejected payload') } },
    { operationId: 'corrected', deliveryState: 'interrupted', effectState: 'unknown', commit: descriptor.commit },
  ];
  assert.equal(confirmations(await confirmation({ descriptor, commitments })).length, 1);
});

test('renderer form inspection reads native controls without firing FormData or page input events', async () => {
  const oldLocation = globalThis.location, oldFormData = globalThis.FormData; let formDataCalls = 0;
  globalThis.location = { href: 'https://portal.test/search' };
  globalThis.FormData = class { constructor() { formDataCalls++; throw new Error('Inspection dispatched formdata'); } };
  try {
    const field = { tagName: 'INPUT', type: 'search', name: 'q', value: 'actual search', matches: () => false, getAttribute: () => null };
    const element = { tagName: 'BUTTON', type: 'submit', name: 'go', value: 'search', isConnected: true, hasAttribute: () => false };
    const nativeForm = { isConnected: true, action: 'https://portal.test/search', method: 'get', enctype: 'application/x-www-form-urlencoded', target: '_self', elements: [field, element] };
    element.form = nativeForm;
    const state = { credentialFields: new WeakSet() }, operation = { ref: 'e1', action: 'click' };
    const get = await inspectObservedFormControl(element, state, operation);
    assert.equal(formDataCalls, 0); assert.equal(get.kind, 'form-navigation'); assert.equal(get.form.method, 'GET');
    assert.equal(new URL(get.form.navigationUrl).searchParams.get('q'), 'actual search');
    nativeForm.method = 'post';
    const post = await inspectObservedFormControl(element, state, operation);
    assert.equal(post.kind, 'form-submit'); assert.equal(post.form.payloadSource, 'observed-native-controls');
    assert.equal(post.form.identityDigests.find(value => value.name === 'q').digest, hash('actual search'));
    assert.notEqual(get.form.payloadDigest, post.form.payloadDigest);
  } finally { globalThis.location = oldLocation; globalThis.FormData = oldFormData; }
});

test('host dispatch callback persistence failure is proven absent and does not write the file', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'descriptor-dispatch-')); t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const handler = createWorkspaceToolHandler({ cwd }), operation = call('relay_workspace', { action: 'write', path: 'new.txt', text: 'must not write' });
  const descriptor = await handler.describeOperation(operation);
  const returned = await handler(operation, { operationDescriptor: descriptor, onOperationDispatch: async () => { throw Object.assign(new Error('Journal unavailable'), { code: 'EIO' }); } });
  assert.equal(returned.success, false); await assert.rejects(fs.stat(path.join(cwd, 'new.txt')), { code: 'ENOENT' });
  assert.equal((await handler.normalizeOperationResult(returned, { call: operation, descriptor })).effectState, 'absent');
});

test('explicit subfolders retain the task workspace scope for reads only', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'descriptor-subfolder-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'workspace');
  await fs.mkdir(path.join(cwd, 'records'), { recursive: true });
  await fs.mkdir(path.join(directory, 'other'));
  const descriptor = args => describeHostOperation(call('relay_workspace', args), { cwd });
  const task = await descriptor({ action: 'list', path: '.' });
  const workspaceKey = task.resources.find(resource => resource.key.startsWith('workspace:')).key;
  const scopes = result => result.resources.find(resource => !resource.scopeOnly && resource.key.startsWith('path:')).scopeKeys;
  assert.ok(scopes(await descriptor({ action: 'read', cwd: 'records', path: 'local.txt' })).includes(workspaceKey));
  assert.ok(!scopes(await descriptor({ action: 'write', cwd: 'records', path: 'local.txt', text: 'new' })).includes(workspaceKey));
  assert.ok(!scopes(await descriptor({ action: 'read', cwd: '../other', path: 'outside.txt' })).includes(workspaceKey));
});

const nativeTextBinding = extra => ({ version: 1, format: 'dom-text', resourceKey: 'origin:https://portal.test', record: '#status',
  confirmedValues: ['Your enrollment is confirmed.'], absentValues: ['Please correct the highlighted fields.'], history: false,
  outcomeFields: ['participantId', 'workshopId'], ...extra });
async function nativeTextFixture({ responseStatus = 200 } = {}) {
  const postData = 'participantId=p1&workshopId=w1';
  const observedForm = form(); observedForm.control.form.attachmentDigests = [];
  observedForm.control.form.requestPayloadDigest = urlencodedFormPayloadDigest(postData);
  const descriptor = await describeHostOperation(browserCall(), { browserObservation: observedForm });
  const commitment = { operationId: 'native-op', workItemId: 'enroll', deliveryState: 'dispatched', effectState: 'unknown',
    resources: descriptor.resources, commit: descriptor.commit, evidence: [] };
  const tracker = new BrowserSubmissionObservations();
  assert.equal(tracker.arm({ operationId: commitment.operationId, commit: descriptor.commit, sourceFrameId: 'actual-frame',
    sourceLoaderId: 'form-loader', sourceDocumentId: 'one:1' }), true);
  tracker.observe('Network.requestWillBeSent', { type: 'Document', requestId: 'actual-request', frameId: 'actual-frame', loaderId: 'response-loader',
    request: { method: 'POST', url: 'https://portal.test/tenant-a/enroll', postData, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } });
  tracker.observe('Network.responseReceived', { type: 'Document', requestId: 'actual-request', loaderId: 'response-loader',
    response: { url: 'https://portal.test/tenant-a/enroll', status: responseStatus } });
  tracker.observe('Network.loadingFinished', { requestId: 'actual-request' });
  const current = { frameId: 'actual-frame', loaderId: 'response-loader', documentId: 'one:2', url: 'https://portal.test/tenant-a/enroll' };
  const browserObservation = { current: true, tabId: 'relay:one', ...current, submissionCorrelations: tracker.current(current) };
  assert.equal(browserObservation.submissionCorrelations.length, 1);
  return { descriptor, commitment, browserObservation };
}
async function nativeTextResult(fixture, { receiptBinding = nativeTextBinding(), status = 'Your enrollment is confirmed.',
  observation = {}, commitments = [fixture.commitment], operation = browserCall('read') } = {}) {
  const browserObservation = { ...fixture.browserObservation, receipts: [{ bindingKey: browserReceiptBindingKey(receiptBinding), records: [{ status }] }], ...observation };
  return normalizeHostOperationResult(result({ documentId: browserObservation.documentId, url: browserObservation.url, text: status }), {
    call: operation, descriptor: operation.arguments.includes('"read"') ? await describeHostOperation(operation, { browserObservation }) : fixture.descriptor,
    browserObservation, criteria: [{ id: 'native-receipt', kind: 'external-confirmation', receiptBinding }], commitments });
}

test('native and structured receipts can only reconcile the criterion chosen for an actual commitment', async () => {
  const fixture = await nativeTextFixture();
  const operation = browserCall('read');
  for (const [receiptBinding, record] of [
    [nativeTextBinding(), { status: 'Your enrollment is confirmed.' }],
    [binding({ history: true }), receiptRecord()],
  ]) {
    const browserObservation = { ...fixture.browserObservation, receipts: [{ bindingKey: browserReceiptBindingKey(receiptBinding), records: [record] }] };
    const descriptor = await describeHostOperation(operation, { browserObservation });
    const commitments = [{ ...fixture.commitment, confirmationCriterionId: 'assigned' }];
    const normalize = id => normalizeHostOperationResult(result({ documentId: browserObservation.documentId, url: browserObservation.url }), {
      call: operation, descriptor, browserObservation, commitments, criteria: [{ id, kind: 'external-confirmation', receiptBinding }],
    });
    assert.deepEqual(confirmations(await normalize('different')), []);
    const proof = confirmations(await normalize('assigned'));
    assert.equal(proof.length, 1);
    assert.equal(proof[0].confirmation.effectKey, fixture.commitment.commit.effectKey);
  }
});

test('native text confirmation retains a real first-POST correlation before a binding exists and reconciles on a later read', async () => {
  const fixture = await nativeTextFixture();
  const first = await normalizeHostOperationResult(result({ documentId: 'one:2', url: fixture.browserObservation.url }), {
    call: browserCall(), descriptor: fixture.descriptor, browserObservation: fixture.browserObservation, criteria: [], commitments: [fixture.commitment] });
  assert.equal(confirmations(first).length, 0);
  const correlation = first.evidence.find(value => value.validation?.source === 'native-form-navigation');
  assert.equal(correlation.validation.correlation.requestId, 'actual-request');
  assert.equal(correlation.resourceKey, fixture.descriptor.commit.destinationKey);
  assert.equal(first.effectState, 'unconfirmed');
  const commitment = { ...fixture.commitment, deliveryState: 'returned', evidence: first.evidence };
  const later = await nativeTextResult(fixture, { observation: { submissionCorrelations: [] }, commitments: [commitment] });
  const proof = confirmations(later)[0];
  const observation = later.evidence.find(value => value.validation?.source === 'native-form-navigation');
  assert.equal(observation.resourceKey, 'url:' + fixture.browserObservation.url);
  assert.equal(observation.validation.correlation.destinationKey, fixture.descriptor.commit.destinationKey);
  assert.equal(confirmations(later).length, 1);
  assert.equal(proof.confirmation.effectKey, fixture.descriptor.commit.effectKey);
  assert.equal(proof.validation.source, 'host-correlated-native-form-text');
  assert.equal(proof.validation.receiptStatus, 'Your enrollment is confirmed.');
  assert.equal(proof.validation.requestId, 'actual-request');
});

test('plain status text cannot borrow a missing, stale, foreign or reserved native submission', async () => {
  const fixture = await nativeTextFixture();
  for (const observation of [{ submissionCorrelations: [] }, { documentId: 'reloaded:9' }, { frameId: 'another-frame' },
    { loaderId: 'another-loader' }, { url: 'https://portal.test/tenant-b/enroll' }, { current: false }]) {
    assert.equal(confirmations(await nativeTextResult(fixture, { observation })).length, 0);
  }
  for (const deliveryState of ['reserved', 'cancelled', undefined]) {
    assert.equal(confirmations(await nativeTextResult(fixture, { commitments: [{ ...fixture.commitment, deliveryState }] })).length, 0);
  }
  for (const change of [{ effectKey: hash('another-effect') }, { requestPayloadDigest: hash('another-request') },
    { documentKey: 'document:another-source' }, { destinationKey: 'destination:https://portal.test/tenant-b/enroll' }]) {
    assert.equal(confirmations(await nativeTextResult(fixture, { commitments: [{ ...fixture.commitment, commit: { ...fixture.commitment.commit, ...change } }] })).length, 0);
  }
});

test('native text binding requires exact fresh visible text and observed subject field names', async () => {
  const fixture = await nativeTextFixture();
  for (const status of ['Thank you.', 'your enrollment is confirmed.', ' Your enrollment is confirmed.']) {
    assert.equal(confirmations(await nativeTextResult(fixture, { status })).length, 0);
  }
  for (const receiptBinding of [nativeTextBinding({ history: true }), nativeTextBinding({ outcomeFields: ['unknownField'] }),
    nativeTextBinding({ outcomeFields: ['participantId', 'participantId'] }), nativeTextBinding({ resourceKey: 'origin:https://other.test' })]) {
    assert.equal(confirmations(await nativeTextResult(fixture, { receiptBinding })).length, 0);
  }
  const receiptBinding = nativeTextBinding(), key = browserReceiptBindingKey(receiptBinding);
  for (const records of [[{ status: 'Your enrollment is confirmed.', ambiguous: true }],
    [{ status: 'Your enrollment is confirmed.' }, { status: 'Your enrollment is confirmed.' }]]) {
    assert.equal(confirmations(await nativeTextResult(fixture, { observation: { receipts: [{ bindingKey: key, records }] } })).length, 0);
  }
});

test('native text cannot confirm from an error response while an actual explicit rejection can reconcile absence', async () => {
  const fixture = await nativeTextFixture({ responseStatus: 422 });
  assert.equal(confirmations(await nativeTextResult(fixture)).length, 0);
  const rejected = await nativeTextResult(fixture, { status: 'Please correct the highlighted fields.', operation: browserCall() });
  assert.equal(rejected.effectState, 'absent');
  assert.equal(confirmations(rejected)[0].confirmation.status, 'absent');
});

test('structured and native text observations count the same applicant and entity once despite new receipt IDs or payload edits', async () => {
  const first = confirmations(await confirmation({ records: [receiptRecord({ outcomeId: 'receipt-one' })] }))[0];
  const edited = form(); edited.control.form.payloadDigest = hash('changed cover letter');
  const descriptor = await describeHostOperation(browserCall(), { browserObservation: edited });
  const second = confirmations(await confirmation({ descriptor, records: [receiptRecord({ outcomeId: 'receipt-two' })] }))[0];
  const historical = confirmations(await confirmation({ records: [receiptRecord({ outcomeId: 'older-receipt' })], receiptBinding: binding({ history: true }), commitments: [] }))[0];
  const native = confirmations(await nativeTextResult(await nativeTextFixture()))[0];
  assert.equal(first.confirmation.outcomeId, second.confirmation.outcomeId);
  assert.equal(first.confirmation.outcomeId, historical.confirmation.outcomeId);
  assert.equal(first.confirmation.outcomeId, native.confirmation.outcomeId);
  assert.notEqual(first.confirmation.effectKey, second.confirmation.effectKey);
  assert.equal(first.validation.rawOutcomeId, 'receipt-one'); assert.equal(second.validation.rawOutcomeId, 'receipt-two');
  assert.equal(second.validation.outcomeBasis, 'observed-form-identity'); assert.equal(historical.confirmation.prior, true);
});

test('real DOM text extraction requires one connected visible record and normalizes only whitespace', () => {
  const previousDocument = globalThis.document, previousStyle = globalThis.getComputedStyle;
  let records = [{ isConnected: true, innerText: ' Your  enrollment\n is confirmed. ', getBoundingClientRect: () => ({ width: 100, height: 20 }) }];
  globalThis.document = { querySelectorAll: () => records };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  try {
    const b = nativeTextBinding(), read = () => observePageReceiptRecords([b])[0].records;
    assert.deepEqual(read(), [{ status: 'Your enrollment is confirmed.' }]);
    records[0].isConnected = false; assert.equal(read()[0].ambiguous, true); records[0].isConnected = true;
    globalThis.getComputedStyle = () => ({ display: 'none', visibility: 'visible' }); assert.equal(read()[0].ambiguous, true);
    globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
    records = [records[0], records[0]]; assert.ok(read().every(value => value.ambiguous));
  } finally { globalThis.document = previousDocument; globalThis.getComputedStyle = previousStyle; }
});


async function alternativeConfirmation({bindings,batches,observed=form(),document={}}){
 const descriptor=await describeHostOperation(browserCall(),{browserObservation:observed});
 const browserObservation={current:true,tabId:'relay:one',documentId:'one:2',url:'https://portal.test/tenant-a/confirmation',receipts:batches,...document};
 return normalizeHostOperationResult(result({documentId:browserObservation.documentId,url:browserObservation.url}),{call:browserCall(),descriptor,browserObservation,criteria:[{id:'one-goal',kind:'external-confirmation',targetCount:2,receiptBindings:bindings}],commitments:[{operationId:'op-alt',deliveryState:'returned',effectState:'unknown',commit:descriptor.commit}]});
}
test('receipt alternatives select observed site without splitting a criterion and equivalent formats count one fact',async()=>{
 const first=binding(),second=binding({format:'json',record:'/receipts',resourceKey:'origin:https://other.test'});
 const other=form();other.url='https://other.test/form';other.control.form.action='https://other.test/enroll';
 const mapped=await alternativeConfirmation({bindings:[first,second],batches:[{bindingKey:browserReceiptBindingKey(second),records:[receiptRecord({destination:'https://other.test/enroll'})]}],observed:other,document:{url:'https://other.test/receipt'}});
 assert.equal(confirmations(mapped).length,1);assert.equal(confirmations(mapped)[0].resourceKey,'origin:https://other.test');
 const sameSite={...second,resourceKey:first.resourceKey};const duplicate=await alternativeConfirmation({bindings:[first,sameSite],batches:[first,sameSite].map(b=>({bindingKey:browserReceiptBindingKey(b),records:[receiptRecord()]}))});
 assert.equal(confirmations(duplicate).length,1);
});
test('conflicting matching variants stay uncertain and a fresh consistent observation can resolve',async()=>{
 const positive=binding(),negative=binding({record:'#second',confirmedValues:[],absentValues:['confirmed']});
 const batches=[positive,negative].map(b=>({bindingKey:browserReceiptBindingKey(b),records:[receiptRecord()]}));
 const conflict=await alternativeConfirmation({bindings:[positive,negative],batches});assert.equal(confirmations(conflict).length,0);assert.equal(conflict.effectState,'unconfirmed');
 const fresh=await alternativeConfirmation({bindings:[positive,negative],batches:[batches[0],{bindingKey:browserReceiptBindingKey(negative),records:[]}],document:{documentId:'one:3'}});
 assert.equal(confirmations(fresh).length,1);assert.equal(fresh.effectState,'confirmed');
});
test('structured and native-text alternatives conflict before either path can authorize success',async()=>{
 const f=await nativeTextFixture(),structured=binding({confirmedValues:[],absentValues:['confirmed']}),native=nativeTextBinding();
 const observation={...f.browserObservation,receipts:[{bindingKey:browserReceiptBindingKey(structured),records:[receiptRecord()]},{bindingKey:browserReceiptBindingKey(native),records:[{status:'Your enrollment is confirmed.'}]}]};
 const mapped=await normalizeHostOperationResult(result({documentId:observation.documentId,url:observation.url}),{call:browserCall(),descriptor:f.descriptor,browserObservation:observation,criteria:[{id:'same-goal',kind:'external-confirmation',receiptBindings:[structured,native]}],commitments:[f.commitment]});
 assert.equal(confirmations(mapped).length,0);assert.equal(mapped.effectState,'unconfirmed');
});
test('native receipt refinement preserves its original fact alias and rejects changing the subject identity',async()=>{
 const f=await nativeTextFixture(),first=await nativeTextResult(f),prior=confirmations(first)[0];assert.ok(prior);
 const retained=[{...f.commitment,evidence:first.evidence}],selector={...nativeTextBinding(),record:'#renamed-success'};
 const same=await nativeTextResult(f,{receiptBinding:selector,commitments:retained});assert.equal(confirmations(same)[0].confirmation.outcomeId,prior.confirmation.outcomeId);
 const changed=await nativeTextResult(f,{receiptBinding:{...selector,outcomeFields:['participantId']},commitments:retained});assert.equal(confirmations(changed).length,0);
});

test('missing or failed matching alternative cannot silently become first-match confirmation',async()=>{const positive=binding(),other=binding({record:'#other'});for(const extra of [[],[{bindingKey:browserReceiptBindingKey(other),records:[],unavailable:true}],[{bindingKey:browserReceiptBindingKey(other),records:[],overflow:true}]]){const mapped=await alternativeConfirmation({bindings:[positive,other],batches:[{bindingKey:browserReceiptBindingKey(positive),records:[receiptRecord()]},...extra]});assert.equal(confirmations(mapped).length,0);}});
test('one conflicting target does not suppress independent criterion confirmation',async()=>{
 const first=await describeHostOperation(browserCall(),{browserObservation:form()}),otherForm=form();otherForm.control.form.payloadDigest=hash('other');otherForm.control.form.identityDigests[1].digest=hash('w2');const second=await describeHostOperation(browserCall(),{browserObservation:otherForm});
 const positive=binding({confirmedValues:['confirmed','success']}),negative=binding({record:'#other',confirmedValues:[],absentValues:['confirmed']}),independent=binding({record:'#independent',confirmedValues:['success']});
 const otherRecord=receiptRecord({status:'success',outcomeId:'p1:w2',identityValues:[{name:'participantId',field:'data-participant',value:'p1'},{name:'workshopId',field:'data-workshop',value:'w2'}]});
 const browserObservation={current:true,documentId:'one:2',url:'https://portal.test/confirmation',receipts:[{bindingKey:browserReceiptBindingKey(positive),records:[receiptRecord()]},{bindingKey:browserReceiptBindingKey(negative),records:[receiptRecord()]},{bindingKey:browserReceiptBindingKey(independent),records:[otherRecord]}]};
 const mapped=await normalizeHostOperationResult(result({documentId:'one:2'}),{call:browserCall(),descriptor:first,browserObservation,criteria:[{id:'conflicting',kind:'external-confirmation',receiptBindings:[positive,negative]},{id:'independent',kind:'external-confirmation',receiptBinding:independent}],commitments:[first,second].map((descriptor,i)=>({operationId:'op-'+i,deliveryState:'returned',effectState:'unknown',commit:descriptor.commit}))});
 assert.equal(confirmations(mapped).length,1);assert.equal(confirmations(mapped)[0].confirmation.effectKey,second.commit.effectKey);assert.equal(mapped.effectState,'unconfirmed');
});

test('production receipt extractor processes all 320 bounded alternatives and never truncates oversized input',()=>{const saved=globalThis.document;globalThis.document={querySelectorAll:()=>[]};try{const bindings=Array.from({length:320},(_,i)=>binding({record:'#receipt-'+i}));const observed=observePageReceiptRecords(bindings);assert.equal(observed.length,320);assert.deepEqual(observed.at(-1),{records:[]});assert.deepEqual(observePageReceiptRecords([...bindings,binding()]),[]);}finally{if(saved===undefined)delete globalThis.document;else globalThis.document=saved;}});

test('native application control labels bind classification to the inspected operation', async () => {
  const observed = form({ url: 'https://jobs.ashbyhq.com/exampleco/11111111-1111-4111-8111-111111111111', title: 'Operations Analyst | ExampleCo' });
  observed.control.form.submitLabel = 'Next';
  const next = await describeHostOperation(browserCall(), { browserObservation: observed });
  assert.equal(next.applicationPage.submission, 'intermediate');
  observed.control.form.submitLabel = 'Submit Application';
  const submit = await describeHostOperation(browserCall(), { browserObservation: observed });
  assert.equal(submit.applicationPage.submission, 'final');
  assert.notEqual(submit.operationKey, next.operationKey, 'label changes invalidate queued input');
  assert.equal(submit.commit.effectKey, next.commit.effectKey, 'receipt correlation does not change');
});

test('native normalization preserves boolean non-dispatch facts without trusting external tools', async () => {
  const descriptor = await describeHostOperation(browserCall(), { browserObservation: form() });
  for (const flag of ['actionDispatched', 'inputDispatched']) {
    for (const success of [false, true]) {
      const value = await normalizeHostOperationResult(result({ [flag]: false }, success), { call: browserCall(), descriptor });
      assert.equal(value.effectState, 'absent'); assert.equal(value[flag], false);
    }
    for (const operation of [call('external_tool', {}), call('relay_browser', {}, { namespace: 'external' })]) {
      const value = await normalizeHostOperationResult(result({ [flag]: false }, false), { call: operation, descriptor });
      assert.equal(value.effectState, 'unknown'); assert.equal(value[flag], undefined);
    }
    for (const value of ['false', 0, null]) {
      const normalized = await normalizeHostOperationResult(result({ [flag]: value }, false), { call: browserCall(), descriptor });
      assert.equal(normalized.effectState, 'unknown'); assert.equal(normalized[flag], undefined);
    }
  }
});

test('inspected native field Enter is opaque while ordinary field input stays available', async () => {
  const field = { isConnected: true, tagName: 'INPUT', type: 'text', name: 'name', value: 'Example',
    form: { isConnected: true, method: 'post', action: 'https://portal.test/apply' } };
  for (const [action, key, modifiers, expected] of [
    ['press', 'Enter', [], 'opaque'], ['press', 'Enter', ['Control'], 'opaque'],
    ['press', 'Tab', [], 'interact'], ['press', 'ArrowDown', [], 'interact'],
    ['press', 'a', [], 'interact'], ['click', undefined, [], 'interact'],
  ]) {
    const args = { action, ref: 'e1', key, modifiers };
    const control = await inspectObservedFormControl(field, {}, args);
    assert.equal(control.kind, 'field');
    const descriptor = await describeHostOperation(browserCall(action, { key, modifiers }), { browserObservation: form({ control }) });
    assert.equal(descriptor.effect, expected);
  }
});
