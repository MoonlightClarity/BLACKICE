import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';
import { createPlanningWorkerGuard, wrapPlanningToolHandler } from '../lib/planning-awareness.mjs';
import { createContractCompletionController, readContractJournal } from '../lib/planning-contract-runtime.mjs';
import { BrowserWorkspace, createBrowserToolHandler } from '../lib/browser.mjs';
import { browserReceiptBindingKey } from '../lib/operation-descriptors.mjs';
import { observePageReceiptRecords } from '../desktop/browser-operation-observation.mjs';
import { BrowserSubmissionObservations, urlencodedFormPayloadDigest } from '../desktop/browser-submission-observation.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const call = (name, args) => ({ name, arguments: args, callId: randomUUID() });
const body = result => JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
const operation = result => result.contentItems.map(item => { try { return JSON.parse(item.text); } catch { return null; } }).find(item => item?.type === 'planning.operation');
const origin = 'origin:https://portal.test', action = 'https://portal.test/tenant-a/enroll';
const rejection = 'Please correct the highlighted fields.', successText = 'Your enrollment is confirmed.';
const contract = () => ({ contractVersion: 2, goal: 'Complete one authorized enrollment and verify its actual result.',
  criteria: [{ id: 'receipt', kind: 'external-confirmation', description: 'One new enrollment is confirmed.', resourceKey: origin, targetCount: 1 },
    { id: 'discovery', kind: 'observation', description: 'Inspect the available service.', resourceKey: origin }],
  workItems: [{ id: 'enroll', title: 'Complete enrollment', objective: 'Submit the authorized form and recover from validation.', owner: 'coordinator', resourceKeys: [origin], effects: ['interact', 'commit'], dependsOn: [], criterionIds: ['receipt'] },
    { id: 'discover', title: 'Discover the service', objective: 'Inspect ordinary page metadata.', owner: 'coordinator', resourceKeys: [origin], effects: ['observe'], dependsOn: [], criterionIds: ['discovery'] }], instructions: [] });

// A deterministic observed page drives the production browser handler, descriptor,
// receipt extractor, normalizer, task store and operation journal. It supplies no
// external-confirmation evidence and cannot select an effect identity for a proof.
async function fixture(t, { format = 'dom', lostSecondResponse = false, initialLocation = 'invalid', ownerCanObserve = false, initialReceiptKind = 'external-confirmation' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-binding-recovery-'));
  const tasks = new TaskStateStore({ dataDir: path.join(root, 'data') }), taskId = 'recovery-task', runId = 'recovery-run', nodeId = 'coordinator-node';
  const controller = new AbortController(), tracker = new BrowserSubmissionObservations();
  const page = { documentId: 'one:1', loaderId: 'form-loader', frameId: 'actual-frame', url: action,
    location: initialLocation, status: null, text: '', outcome: 'p1:w1', participant: 'p1', prior: 'false', destination: '/tenant-a/enroll', correlation: true };
  let commits = 0, interactions = 0;
  const formFields = () => [['participantId', 'p1'], ['workshopId', 'w1'], ['location', page.location]];
  const form = () => ({ id: 'form-1', documentId: page.documentId, action, method: 'POST', enctype: 'application/x-www-form-urlencoded', target: '_self',
    payloadDigest: hash(formFields()), requestPayloadDigest: urlencodedFormPayloadDigest(new URLSearchParams(formFields()).toString()), attachmentDigests: [],
    identityDigests: formFields().map(([name, value]) => ({ name, digest: hash(value) })) });
  const attributes = () => ({ id: 'receipt', role: 'status', 'data-status': page.status, 'data-outcome': page.outcome,
    'data-participant': page.participant, 'data-workshop': 'w1', 'data-form-action': page.destination, 'data-prior': page.prior });
  const frames = () => [{ forms: [{ action, method: 'POST', fields: formFields().map(([name]) => ({ name, type: 'text' })) }],
    semanticRecords: page.status ? [{ selector: '#receipt', tag: 'output', attributes: attributes(), text: page.text }] : [] }];
  const receiptRecords = bindings => {
    const previousDocument = globalThis.document, previousStyle = globalThis.getComputedStyle;
    globalThis.document = { querySelectorAll: selector => selector === '#receipt' && page.status ? [{ isConnected: true, innerText: page.text,
      getAttribute: name => attributes()[name] ?? null, getBoundingClientRect: () => ({ width: 240, height: 30 }) }] : [] };
    globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
    try { return observePageReceiptRecords(bindings).map((record, index) => ({ bindingKey: browserReceiptBindingKey(bindings[index]), ...record })); }
    finally { globalThis.document = previousDocument; globalThis.getComputedStyle = previousStyle; }
  };
  const driver = {
    status: () => ({ available: true, contained: true, containedAvailable: true, activeTab: 'relay:one',
      tabs: [{ browser: 'relay', tabId: 'relay:one', url: page.url, documentId: page.documentId, purpose: 'task' }] }),
    observeOperation: async (args, options = {}) => ({ current: (!options.expectedDocumentId || options.expectedDocumentId === page.documentId)
        && (!options.expectedUrl || options.expectedUrl === page.url), tabId: 'relay:one', documentId: page.documentId, url: page.url,
      frameId: page.frameId, loaderId: page.loaderId,
      ...(args.action === 'click' ? { control: { ref: args.ref, kind: 'form-submit', form: form() } }
        : args.action === 'fill' ? { control: { ref: args.ref, kind: 'field' } } : {}),
      submissionCorrelations: page.correlation ? tracker.current(page) : [], receipts: receiptRecords(options.receiptBindings || []) }),
    perform: async (args, context) => {
      if (args.action === 'click') {
        commits++;
        const sourceDocumentId = page.documentId, sourceLoaderId = page.loaderId, postData = new URLSearchParams(formFields()).toString();
        assert.equal(tracker.arm({ operationId: context.operationId, commit: context.operationDescriptor.commit,
          sourceFrameId: page.frameId, sourceLoaderId, sourceDocumentId }), true);
        if (lostSecondResponse && commits === 2) throw Object.assign(new Error('The native POST response was lost.'), { code: 'BROWSER_RESPONSE_LOST', actionDispatched: true });
        page.loaderId = `response-loader-${commits}`; page.documentId = `one:${commits + 1}`;
        page.status = page.location === 'invalid' ? 'validation-rejected' : 'confirmed'; page.text = page.location === 'invalid' ? rejection : successText;
        const requestId = `actual-request-${commits}`;
        tracker.observe('Network.requestWillBeSent', { type: 'Document', requestId, frameId: page.frameId, loaderId: page.loaderId,
          request: { method: 'POST', url: action, postData, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } });
        tracker.observe('Network.responseReceived', { type: 'Document', requestId, loaderId: page.loaderId,
          response: { url: action, status: page.status === 'confirmed' ? 200 : 422 } });
        tracker.observe('Network.loadingFinished', { requestId });
      } else if (args.action === 'fill') { interactions++; page.location = args.text; }
      return { tabId: 'relay:one', documentId: page.documentId, url: page.url, frames: frames() };
    },
  };
  const browser = new BrowserWorkspace({ driver }), browserHandler = createBrowserToolHandler({ browser });
  await tasks.ensure({ taskId, runId, nodeId, cwd: root, goal: contract().goal, schemaVersion: 14, defaultPlan: true });
  const taskHandler = createTaskToolHandler({ store: tasks, taskId, runId, nodeId, task: contract().goal, schemaVersion: 14, planningMode: 'on', executionGuardrails: true, signal: controller.signal });
  const guard = await createPlanningWorkerGuard({ store: tasks, taskId, runId, nodeId, cwd: root, schemaVersion: 14, executionGuardrails: true,
    coordinator: true, signal: controller.signal, getOperationAdapter: item => item.name === 'relay_browser' ? browserHandler : undefined });
  const invoke = wrapPlanningToolHandler(guard, async (item, context = {}) => {
    const denied = await guard.before(item, context); if (denied) return denied;
    context = guard.dispatchContext(item, context); await guard.dispatchFallback(item, context);
    return item.name === 'relay_task' ? guard.after(item, await taskHandler(item, context)) : browserHandler(item, context);
  });
  const send = async item => { const result = await invoke(item, { signal: controller.signal }); guard.observeToolDelivery({ call: item, result }); return result; };
  const state = () => tasks.get(taskId), journal = () => readContractJournal(tasks, taskId);
  const focus = async workItemId => { const current = await state(); const result = await send(call('relay_task', { action: 'focus', workItemId, expectedPlanEpoch: current.contract.planEpoch })); assert.equal(result.success, true, JSON.stringify(result)); };
  const refine = async mutate => {
    await send(call('relay_task', { action: 'read' }));
    const current = await state(), next = structuredClone(current.contract); delete next.planEpoch; mutate(next);
    const result = await send(call('relay_task', { action: 'plan', expectedRevision: current.revision, contract: next })); assert.equal(result.success, true, JSON.stringify(result));
    return result;
  };
  const initial = await send(call('relay_task', { action: 'read' }));
  const authored = contract();
  authored.criteria[0].kind = initialReceiptKind;
  if (ownerCanObserve) authored.workItems[0].effects.push('observe');
  assert.equal((await send(call('relay_task', { action: 'plan', expectedRevision: body(initial).revision, contract: authored }))).success, true);
  await focus('enroll');
  t.after(async () => { await guard.finish('finished'); await tasks.close?.(); await fs.rm(root, { recursive: true, force: true }); });
  const bindingFrom = observed => {
    const record = observed.frames[0].semanticRecords[0], fields = observed.frames[0].forms[0].fields.map(field => field.name);
    assert.ok(fields.includes('participantId') && fields.includes('workshopId'));
    return format === 'dom-text' ? { version: 1, format, resourceKey: origin, record: record.selector, confirmedValues: [], absentValues: [record.text], history: false, outcomeFields: fields.filter(name => name !== 'location') }
      : { version: 1, format, resourceKey: origin, record: record.selector, status: 'data-status', confirmedValues: [], absentValues: [record.attributes['data-status']],
        outcomeId: 'data-outcome', destination: 'data-form-action', history: false, prior: { field: 'data-prior', values: ['true'] },
        identity: [{ field: 'data-participant', formField: fields.find(name => name === 'participantId') }, { field: 'data-workshop', formField: fields.find(name => name === 'workshopId') }] };
  };
  return { send, state, journal, focus, refine, page, bindingFrom,
    completion: () => createContractCompletionController({ store: tasks, taskId, runId, nodeId, signal: controller.signal }),
    bind: args => send(call('relay_task', { action: 'bind_receipt', workItemId: 'enroll', criterionId: 'receipt', ...args })),
    reserveSubmission: async () => {
      const item = call('relay_browser', { action: 'click', browser: 'relay', tabId: 'relay:one', ref: 'submit' });
      assert.equal(await guard.before(item), null);
      return async () => guard.annotate(item, await browserHandler(item, guard.dispatchContext(item)));
    },
    adoptNextOccurrence: async () => {
      const current = await state(), { planEpoch, ...contract } = current.contract;
      await tasks.setContract(taskId, contract, { expectedRevision: current.revision, schemaVersion: 14, adoption: {
        runId: 'next-occurrence', planRef: { cycleId: 'next-cycle' }, freshEvidence: true, requiredCriterionIds: ['receipt']
      } });
      return state();
    },
    browse: (action, extra = {}) => send(call('relay_browser', { action, browser: 'relay', tabId: 'relay:one', ...extra })),
    counts: () => ({ commits, interactions }) };
}

const receiptCriterion = state => state.contractRuntime.criteria.find(item => item.id === 'receipt');
const commitsOf = journal => journal.records.filter(item => item.effect === 'commit');

test('completion returns the exact unbound positive submission for authored recovery without replay', async t => {
  const f = await fixture(t, { initialLocation: 'valid', ownerCanObserve: true }), before = await f.state();
  const noPending = await f.bind({ expectedRevision: before.revision, receiptBinding: {} });
  assert.equal(noPending.code, 'TASK_CONTRACT_RECEIPT_NOT_PENDING');
  const first = await f.browse('click', { ref: 'submit' });
  const { recovery, note } = operation(first);
  assert.match(note, /Use bind_receipt/);
  assert.equal(recovery.reason, 'receipt-binding-missing');
  assert.equal(receiptCriterion(await f.state()).observedCount, 0, 'A visible success has not established confirmation.');
  const original = commitsOf(await f.journal())[0];
  assert.equal(original.effectState, 'unconfirmed');
  const completion = f.completion(), next = await completion.beforeFinal();
  assert.equal(next.continue, true);
  assert.match(next.prompt, /Use the tools to reconcile this exact retained browser submission before returning/);
  const instruction = JSON.parse(next.prompt.slice(next.prompt.lastIndexOf('\n') + 1));
  assert.deepEqual(instruction, recovery);
  assert.equal(instruction.operationId, original.operationId);
  assert.equal(instruction.destinationKey, 'destination:' + action);
  assert.deepEqual(instruction.bindReceipt, { tool: 'relay_task', action: 'bind_receipt', expectedRevision: before.revision, workItemId: 'enroll', criterionId: 'receipt' });
  assert.deepEqual(instruction.receiptBindingFields, [
    { formats: ['dom', 'json'], required: ['version', 'format', 'resourceKey', 'record', 'status', 'confirmedValues', 'outcomeId', 'history'],
      optional: ['destination', 'absentValues', 'prior', 'identity'] },
    { formats: ['dom-text'], required: ['version', 'format', 'resourceKey', 'record', 'confirmedValues', 'history', 'outcomeFields'],
      optional: ['absentValues'] },
  ]);
  assert.match(instruction.steps[1], /relay_task \{"action":"read"\}/);
  assert.match(instruction.steps[3], /current expectedPlanEpoch from the returned state, then relay_browser read or snapshot/);
  assert.equal((await f.browse('click', { ref: 'submit' })).code, 'TASK_CONTRACT_EFFECT_UNCERTAIN');

  const binding = f.bindingFrom(body(first));
  binding.confirmedValues = binding.absentValues;
  delete binding.absentValues;
  const wrongOwner = await f.bind({ expectedRevision: before.revision, workItemId: 'discover', receiptBinding: binding });
  assert.equal(wrongOwner.code, 'TASK_CONTRACT_OWNERSHIP');
  const saved = await f.bind({ expectedRevision: before.revision, receiptBinding: binding });
  assert.equal(saved.success, true, JSON.stringify(saved));
  const updated = await f.state();
  const expected = structuredClone(before.contract);
  expected.criteria[0].receiptBinding = binding;
  expected.planEpoch++;
  assert.deepEqual(updated.contract, expected, 'The scoped edit preserves every other criterion, item and instruction.');
  assert.equal(updated.revision, before.revision + 1);
  assert.equal((await f.bind({ expectedRevision: before.revision, receiptBinding: binding })).code, 'TASK_STATE_CONFLICT');
  assert.equal(receiptCriterion(await f.state()).observedCount, 0, 'Saving a binding does not confirm an effect.');
  await f.focus('enroll');
  const currentDocument = f.page.documentId;
  f.page.participant = 'different-subject';
  const mismatch = await f.browse('read');
  assert.equal(operation(mismatch).recovery.reason, 'receipt-not-matched');
  assert.equal(operation(mismatch).recovery.criteria[0].bindingState, 'confirmation-only');
  assert.equal(receiptCriterion(await f.state()).observedCount, 0);
  f.page.participant = 'p1';
  await f.browse('read');
  const [reconciled] = commitsOf(await f.journal());
  assert.equal(f.page.documentId, currentDocument);
  assert.equal(reconciled.operationId, original.operationId);
  assert.deepEqual(reconciled.commit, original.commit);
  assert.equal(reconciled.effectState, 'confirmed');
  assert.equal(receiptCriterion(await f.state()).observedCount, 1);
  const remaining = await completion.beforeFinal();
  assert.equal(remaining.continue, true, 'Independent observation remains available after receipt recovery.');
  assert.doesNotMatch(remaining.prompt, /browser-receipt-recovery/);
  await f.focus('discover');
  await f.browse('read');
  assert.equal(await completion.beforeFinal(), null);
  assert.deepEqual(f.counts(), { commits: 1, interactions: 0 });
});

test('a later occurrence can bind an older unresolved submission for the same owned item', async t => {
  const f = await fixture(t, { initialLocation: 'valid', ownerCanObserve: true });
  const first = await f.browse('click', { ref: 'submit' }), original = commitsOf(await f.journal())[0];
  assert.equal(operation(first).effectState, 'unconfirmed');
  const occurrence = await f.adoptNextOccurrence();
  assert.deepEqual(occurrence.contractRuntime.unresolved, [], 'The new occurrence excludes old submissions from its own accounting.');
  const observed = f.bindingFrom(body(first));
  observed.confirmedValues = observed.absentValues;
  delete observed.absentValues;
  const patched = await f.bind({ expectedRevision: occurrence.revision, receiptBinding: observed });
  assert.equal(patched.success, true, JSON.stringify(patched));
  assert.deepEqual((await f.state()).contract.criteria[0].receiptBinding, observed);
  assert.deepEqual(commitsOf(await f.journal()), [original], 'Authoring does not reconcile or replay the older effect.');
  assert.equal(receiptCriterion(await f.state()).observedCount, 0);
});

test('recovery accepts the same originally misclassified criterion without creating a new effect', async t => {
  const f = await fixture(t, { initialLocation: 'valid', ownerCanObserve: true, initialReceiptKind: 'judgment' });
  const first = await f.browse('click', { ref: 'submit' }), original = commitsOf(await f.journal())[0];
  assert.deepEqual(original.criteria.map(({ id, kind }) => ({ id, kind })), [{ id: 'receipt', kind: 'judgment' }]);
  assert.equal(operation(first).recovery.reason, 'receipt-criterion-required');
  assert.deepEqual(operation(first).recovery.recordedCriterionIds, ['receipt']);
  await f.refine(next => {
    next.criteria[0].kind = 'external-confirmation';
    next.criteria.push({ ...next.criteria[0], id: 'new-receipt' });
    next.workItems[0].criterionIds.push('new-receipt');
  });
  const read = await f.browse('read');
  assert.equal(operation(read).recovery.bindReceipt.criterionId, 'receipt');
  assert.deepEqual(operation(read).recovery.criteria.map(item => item.criterionId), ['receipt']);
  const observed = f.bindingFrom(body(first));
  observed.confirmedValues = observed.absentValues;
  delete observed.absentValues;
  const current = await f.state();
  const unrelated = await f.bind({ expectedRevision: current.revision, criterionId: 'new-receipt', receiptBinding: observed });
  assert.equal(unrelated.code, 'TASK_CONTRACT_RECEIPT_NOT_PENDING');
  assert.equal((await f.bind({ expectedRevision: current.revision, receiptBinding: observed })).success, true);
  assert.equal(receiptCriterion(await f.state()).observedCount, 0);
  await f.focus('enroll');
  f.page.participant = 'other-subject';
  await f.browse('read');
  assert.equal(receiptCriterion(await f.state()).observedCount, 0);
  f.page.participant = 'p1';
  await f.browse('read');
  const [verified] = commitsOf(await f.journal());
  assert.equal(verified.effectState, 'confirmed');
  assert.deepEqual(verified.commit, original.commit);
  assert.deepEqual(verified.criteria, original.criteria, 'Historical criteria remain immutable.');
  assert.equal(receiptCriterion(await f.state()).observedCount, 1);
  assert.deepEqual(f.counts(), { commits: 1, interactions: 0 });
});

test('adopted browser submission requires a receipt criterion at reservation and actual dispatch', async t => {
  const f = await fixture(t, { initialReceiptKind: 'judgment' });
  const dispatch = await f.reserveSubmission();
  await f.adoptNextOccurrence();
  const afterAdoption = await dispatch();
  assert.equal(afterAdoption.code, 'TASK_CONTRACT_RECEIPT_REQUIRED');
  assert.equal(body(afterAdoption).actionDispatched, false);
  const afterRace = await f.journal();
  assert.equal(afterRace.records.length, 1);
  assert.equal(afterRace.records[0].deliveryState, 'cancelled-before-dispatch');
  const denied = await f.browse('click', { ref: 'submit' });
  assert.equal(denied.code, 'TASK_CONTRACT_RECEIPT_REQUIRED');
  assert.equal(body(denied).workItemId, 'enroll');
  assert.match(body(denied).message, /Attach an external-confirmation criterion/);
  assert.deepEqual(await f.journal(), afterRace, 'The reservation rejection does not journal a new operation.');
  assert.deepEqual(f.counts(), { commits: 0, interactions: 0 });
});

test('an initially unbound browser submission is recovered by observed binding and owning-item refinement without replay', async t => {
  const f = await fixture(t), first = await f.browse('click', { ref: 'submit' }), submitted = operation(first);
  assert.equal(first.success, true); assert.equal(submitted.effectState, 'unconfirmed');
  assert.equal(submitted.recovery.reason, 'receipt-binding-missing'); assert.equal(submitted.recovery.ownerCanObserve, false);
  assert.deepEqual(submitted.recovery.observedFormFieldNames, ['participantId', 'workshopId', 'location']);
  assert.equal(receiptCriterion(await f.state()).observedCount, 0);
  const original = commitsOf(await f.journal())[0], originalCommit = structuredClone(original.commit);
  const repair = await f.browse('fill', { ref: 'location', text: 'valid' });
  assert.equal(repair.code, 'TASK_CONTRACT_EFFECT_UNCERTAIN'); assert.equal(body(repair).recovery.operationId, original.operationId);
  assert.deepEqual(f.counts(), { commits: 1, interactions: 0 });
  await f.focus('discover'); const discovery = await f.browse('read');
  assert.ok(body(discovery).frames[0].semanticRecords[0].attributes['data-status']);
  const partial = f.bindingFrom(body(discovery));
  await f.refine(next => { next.criteria[0].receiptBinding = partial; });
  await f.focus('discover'); await f.browse('read');
  assert.equal(commitsOf(await f.journal())[0].effectState, 'unconfirmed', 'Another owner cannot borrow the refined criterion.');
  await f.focus('enroll');
  const stillDiscovery = await f.browse('read');
  assert.equal(operation(stillDiscovery).workItemId, 'discover', 'The existing eligible reader owns this read; focus cannot imply observe.');
  assert.equal((await f.state()).contract.workItems[0].effects.includes('observe'), false);
  assert.equal(commitsOf(await f.journal())[0].effectState, 'unconfirmed');
  assert.equal(receiptCriterion(await f.state()).observedCount, 0);
  await f.refine(next => { next.workItems[0].effects.push('observe'); });
  await f.focus('enroll'); await f.browse('read');
  const recovered = await f.journal(), reconciled = commitsOf(recovered)[0];
  assert.equal(reconciled.effectState, 'absent'); assert.equal(reconciled.operationId, original.operationId); assert.deepEqual(reconciled.commit, originalCommit);
  assert.equal(commitsOf(recovered).length, 1); assert.deepEqual(f.counts(), { commits: 1, interactions: 0 });
  assert.equal(receiptCriterion(await f.state()).observedCount, 0, 'Absence is never a counted success.');
  const immutable = structuredClone(recovered.evidence);
  assert.equal((await f.browse('fill', { ref: 'location', text: 'valid' })).success, true);
  const second = await f.browse('click', { ref: 'submit' });
  assert.equal(operation(second).effectState, 'unconfirmed'); assert.equal(operation(second).recovery.criteria[0].bindingState, 'absence-only');
  assert.equal(receiptCriterion(await f.state()).observedCount, 0, 'An observed positive response is unmapped by an absence-only binding.');
  const observedPositive = body(second).frames[0].semanticRecords[0].attributes['data-status'];
  const observedBinding = f.bindingFrom(body(second));
  observedBinding.confirmedValues = [observedPositive];
  delete observedBinding.absentValues;
  const patched = await f.bind({ expectedRevision: (await f.state()).revision, receiptBinding: observedBinding });
  assert.equal(patched.success, true, JSON.stringify(patched));
  assert.deepEqual((await f.state()).contract.criteria[0].receiptBinding.absentValues, ['validation-rejected']);
  await f.focus('enroll');
  const savedPage = structuredClone(f.page);
  Object.assign(f.page, { status: 'validation-rejected', text: rejection });
  await f.browse('read');
  assert.equal(commitsOf(await f.journal())[1].effectState, 'unconfirmed', 'A stale rejection cannot migrate after binding refinement.');
  Object.assign(f.page, savedPage, { participant: 'unrelated' }); await f.browse('read');
  assert.equal(commitsOf(await f.journal())[1].effectState, 'unconfirmed');
  Object.assign(f.page, savedPage, { prior: 'true', outcome: 'preexisting-enrollment', participant: 'prior-participant' }); await f.browse('read');
  assert.equal(receiptCriterion(await f.state()).observedCount, 0, 'Prior outcomes do not satisfy the requested new result.');
  Object.assign(f.page, savedPage); await f.browse('read');
  const final = await f.journal(), committed = commitsOf(final);
  assert.equal(committed.length, 2); assert.equal(committed[1].effectState, 'confirmed');
  assert.equal(receiptCriterion(await f.state()).observedCount, 1);
  assert.deepEqual(f.counts(), { commits: 2, interactions: 1 });
  for (const proof of immutable) assert.deepEqual(final.evidence.find(item => item.id === proof.id), proof, 'Retained evidence bytes are immutable.');
});

test('native text uses retained POST correlation and an absence-only binding cannot count an unknown positive result', async t => {
  const f = await fixture(t, { format: 'dom-text' }), first = await f.browse('click', { ref: 'submit' });
  const firstId = operation(first).operationId;
  const original = await f.journal();
  assert.ok(original.evidence.some(item => item.validation?.source === 'native-form-navigation'));
  const partial = f.bindingFrom(body(first));
  await f.refine(next => { next.criteria[0].receiptBinding = partial; next.workItems[0].effects.push('observe'); });
  await f.focus('enroll'); f.page.correlation = false;
  await f.browse('read');
  assert.equal(commitsOf(await f.journal())[0].effectState, 'absent', 'The retained real request survives later observation without a tracker entry.');
  assert.equal(commitsOf(await f.journal())[0].operationId, firstId);
  assert.equal((await f.browse('fill', { ref: 'location', text: 'valid' })).success, true);
  f.page.correlation = true;
  const positive = await f.browse('click', { ref: 'submit' });
  assert.equal(operation(positive).effectState, 'unconfirmed'); assert.equal(operation(positive).recovery.criteria[0].bindingState, 'absence-only');
  assert.equal(receiptCriterion(await f.state()).observedCount, 0);
  await f.refine(next => { next.criteria[0].receiptBinding.confirmedValues = [body(positive).frames[0].semanticRecords[0].text]; });
  await f.focus('enroll'); f.page.correlation = false;
  const validDocument = f.page.documentId; f.page.documentId = 'unrelated-ajax-document';
  await f.browse('read');
  assert.equal(receiptCriterion(await f.state()).observedCount, 0, 'Identical AJAX text lacks the native response correlation.');
  f.page.documentId = validDocument; await f.browse('read');
  assert.equal(receiptCriterion(await f.state()).observedCount, 1);
  assert.equal(commitsOf(await f.journal()).length, 2); assert.deepEqual(f.counts(), { commits: 2, interactions: 1 });
});

test('a lost corrected response keeps unknown effect identity, actionable guidance and the original rejection isolated', async t => {
  const f = await fixture(t, { lostSecondResponse: true }), first = await f.browse('click', { ref: 'submit' });
  await f.refine(next => { next.criteria[0].receiptBinding = f.bindingFrom(body(first)); next.workItems[0].effects.push('observe'); });
  await f.focus('enroll'); await f.browse('read');
  assert.equal(commitsOf(await f.journal())[0].effectState, 'absent');
  assert.equal((await f.browse('fill', { ref: 'location', text: 'valid' })).success, true);
  const lost = await f.browse('click', { ref: 'submit' });
  assert.equal(lost.success, false); assert.equal(operation(lost).effectState, 'unknown');
  assert.equal(operation(lost).recovery.effectState, 'unknown');
  assert.equal(operation(lost).recovery.criteria[0].bindingState, 'absence-only');
  const beforeRead = commitsOf(await f.journal())[1];
  const observed = await f.browse('read');
  assert.equal(operation(observed).recovery.operationId, beforeRead.operationId);
  assert.equal(commitsOf(await f.journal())[1].effectState, 'unknown', 'Old visible rejection is not absence for the lost new request.');
  const denied = await f.browse('fill', { ref: 'location', text: 'different' });
  assert.equal(denied.code, 'TASK_CONTRACT_EFFECT_UNCERTAIN'); assert.equal(body(denied).recovery.effectState, 'unknown');
  assert.equal(body(denied).recovery.operationId, beforeRead.operationId);
  assert.equal(receiptCriterion(await f.state()).observedCount, 0);
  assert.deepEqual(f.counts(), { commits: 2, interactions: 1 });
});
