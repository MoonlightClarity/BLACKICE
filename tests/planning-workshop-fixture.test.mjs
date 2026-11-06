import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createWorkshopPortal } from './fixtures/planning-workshop-portal.mjs';

async function fixture(t, options = {}) {
  const portal = await createWorkshopPortal({ seed: t.name, ...options });
  t.after(() => portal.close());
  return portal;
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function get(portal, pathname) {
  const response = await fetch(portal.origin + pathname);
  assert.equal(response.status, 200);
  return response.json();
}
async function fields(portal, workshopId, changes = {}) {
  const locations = await get(portal, '/api/locations?q=' + encodeURIComponent(portal.profile.location));
  assert.equal(locations.items.length, 1);
  return {
    workshopId,
    participantId: portal.profile.participantId,
    firstName: portal.profile.firstName,
    lastName: portal.profile.lastName,
    email: portal.profile.email,
    phone: portal.profile.phone,
    locationText: portal.profile.location,
    locationId: locations.items[0].id,
    contactPreference: 'email',
    notes: '',
    ...changes,
  };
}
async function commit(portal, workshopId, values, options = {}) {
  return fetch(portal.origin + '/api/workshops/' + workshopId + '/enroll', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values), ...options,
  });
}
const effects = portal => portal.oracle().newEffects;

test('the standalone native acceptance fixture expires and preserves its private final oracle', { timeout: 8000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-workshop-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./fixtures/planning-workshop-portal.mjs', import.meta.url)),
    '--directory=' + directory, '--count=1', '--duration-ms=1000',
    '--receipt-style=native-text', '--validation=off', '--lost-response=off',
  ], { timeout: 6000 });
  assert.equal(stderr, '');
  const receipt = JSON.parse(stdout.trim());
  assert.equal(new URL(receipt.origin).hostname, '127.0.0.1');
  assert.ok(Number.isSafeInteger(receipt.pid));
  assert.ok(Date.parse(receipt.expiresAt) > Date.parse(receipt.startedAt));
  const oracle = JSON.parse(await readFile(receipt.oraclePath, 'utf8'));
  assert.equal(oracle.newEffects.length, 0);
  await assert.rejects(fetch(receipt.origin + '/workshops'), /fetch failed|ECONNREFUSED/);
});

test('workshop portal serves ordinary custom-control forms and immutable paginated catalog data', async t => {
  const portal = await fixture(t, { pageSize: 2 });
  const seen = [];
  let pageNumber = 1;
  let totalPages;
  let version;
  do {
    const result = await get(portal, '/api/workshops?page=' + pageNumber);
    version ||= result.source.sourceVersion;
    assert.equal(result.source.sourceVersion, version);
    assert.equal(result.source.coverage.start, (pageNumber - 1) * 2);
    assert.equal(result.source.coverage.end, result.source.coverage.start + result.items.length);
    totalPages = result.totalPages;
    seen.push(...result.items);
    pageNumber++;
  } while (pageNumber <= totalPages);
  assert.equal(seen.length, 8);
  assert.equal(new Set(seen.map(item => item.canonicalId)).size, 6);
  assert.equal(seen.at(-1).canonicalId, portal.priorItems.at(-1).id, 'The final page must matter to the prior-record check.');
  const again = await get(portal, '/api/workshops?page=1');
  assert.deepEqual(again.source.coverage, { unit: 'records', start: 0, end: 2, total: 8 });
  assert.equal(again.source.sourceVersion, version);
  const catalogHtml = await (await fetch(portal.origin + '/workshops')).text();
  assert.match(catalogHtml, /<form action="\/workshops" method="get">/);
  const searched = await get(portal, '/api/workshops?q=' + encodeURIComponent(portal.newItems[0].title));
  assert.ok(searched.items.length > 0);
  assert.ok(searched.items.every(item => item.title === portal.newItems[0].title));
  assert.notEqual(searched.source.sourceVersion, version);
  const alias = portal.aliases[0];
  const markup = await (await fetch(portal.origin + '/workshops/' + alias.id)).text();
  assert.match(markup, /role="combobox"/);
  assert.doesNotMatch(markup, /<select[\s>]/i);
  assert.match(markup, /<form id="enrollment-form"/);
  assert.ok(markup.includes('action="/api/workshops/' + alias.canonicalId + '/enroll"'));
  assert.ok(markup.includes('name="workshopId" type="hidden" value="' + alias.canonicalId + '"'));
  assert.ok(markup.includes('name="participantId"'));
  const program = await (await fetch(portal.origin + '/assets/portal.js')).text();
  assert.match(program, /addEventListener\('submit'/);
  assert.match(program, /addEventListener\('input'/);
  assert.equal(effects(portal).length, 0);
});

test('form validation produces no effect until actual location selection and revealed preference are supplied', async t => {
  const portal = await fixture(t, { newCount: 1, existingCount: 0, loseReceipt: false });
  const id = portal.newItems[0].id;
  const values = await fields(portal, id);
  const unselected = await commit(portal, id, { ...values, locationId: '', contactPreference: '' });
  assert.equal(unselected.status, 422);
  const rejected = await unselected.json();
  assert.equal(rejected.code, 'LOCATION_SELECTION_REQUIRED');
  assert.deepEqual(rejected.receipt, {
    status: 'validation-rejected', outcomeId: portal.profile.participantId + ':' + id,
    workshopId: id, participantId: portal.profile.participantId, attendeeEmail: values.email,
    formAction: portal.origin + '/api/workshops/' + id + '/enroll', prior: false,
  }, 'A failed request publishes an actual destination-issued rejection with matching identity and endpoint.');
  const preference = await commit(portal, id, { ...values, contactPreference: '' });
  assert.equal(preference.status, 422);
  assert.equal((await preference.json()).code, 'CONTACT_PREFERENCE_REQUIRED');
  assert.equal(effects(portal).length, 0);
  const created = await commit(portal, id, values);
  assert.equal(created.status, 201);
  const receipt = await created.json();
  assert.equal(receipt.status, 'confirmed');
  assert.equal(receipt.workshopId, id);
  assert.equal(receipt.formAction, portal.origin + '/api/workshops/' + id + '/enroll');
  assert.deepEqual(effects(portal)[0].fields, values);
  const html = await (await fetch(receipt.receiptUrl)).text();
  assert.match(html, /id="receipt" role="status"/);
  assert.ok(html.includes('data-outcome-id="' + receipt.outcomeId + '"'));
  assert.ok(html.includes('data-form-action="' + receipt.formAction + '"'));
  assert.ok(html.includes('data-attendee-email="' + portal.profile.email + '"'));
  assert.equal(portal.oracle().requests.filter(event => event.kind === 'validation-returned').length, 2);
  assert.equal(portal.oracle().requests.filter(event => event.kind === 'commit-accepted').length, 1);
});

test('ordinary text-only confirmation publishes no machine receipt identifier or hidden ideal confirmation record', async t => {
  const portal = await fixture(t, { newCount: 1, existingCount: 0, recoverableValidation: false, loseReceipt: false, receiptStyle: 'text-only' });
  const id = portal.newItems[0].id;
  const response = await commit(portal, id, await fields(portal, id));
  assert.equal(response.status, 201);
  const destination = await response.json();
  assert.deepEqual(Object.keys(destination).sort(), ['created', 'receiptUrl']);
  assert.equal(destination.receiptUrl, portal.origin + '/workshops/' + id + '/confirmation');
  const html = await (await fetch(destination.receiptUrl)).text();
  assert.match(html, /Your enrollment request has been received\./);
  assert.match(html, /<section role="status">/);
  assert.doesNotMatch(html, /data-receipt-|data-outcome-|data-form-action|confirmation-[a-f0-9]/);
  const history = await (await fetch(portal.origin + '/enrollments')).text();
  assert.match(history, /Enrollment request received/);
  assert.doesNotMatch(history, /data-receipt-|data-outcome-|data-form-action|confirmation-[a-f0-9]/);
  const publicHistory = await get(portal, '/api/enrollments');
  assert.deepEqual(Object.keys(publicHistory.items[0]).sort(), ['message', 'receiptUrl', 'workshop']);
  const actual = portal.oracle().newEffects[0];
  assert.equal(portal.oracle().newEffects.length, 1);
  assert.equal((await fetch(portal.origin + '/api/confirmations/' + actual.confirmationId)).status, 404,
    'A browser acceptance test cannot bypass ordinary text by borrowing the attribute-rich fixture API.');
});

test('a lost commit response is observable through normal history and its destination-issued receipt', async t => {
  const portal = await fixture(t, { newCount: 2, recoverableValidation: false });
  const id = portal.newItems[1].id;
  const values = await fields(portal, id);
  const interrupted = await commit(portal, id, values);
  assert.equal(interrupted.status, 201, 'The response starts after the destination effect, preventing transparent pre-header retries.');
  await assert.rejects(interrupted.json(), /socket|terminated|incomplete/i);
  const oracle = portal.oracle();
  assert.equal(oracle.lostReceiptUsed, true);
  assert.equal(oracle.requests.find(event => event.kind === 'response-lost').phase, 'response-body');
  assert.equal(oracle.newEffects.length, 1);
  assert.equal(oracle.requests.filter(event => event.kind === 'commit-request').length, 1);
  let result = await get(portal, '/api/enrollments');
  const records = [...result.items];
  for (let page = 2; page <= result.totalPages; page++) {
    const next = await get(portal, '/api/enrollments?page=' + page + '&version=' + result.source.sourceVersion);
    records.push(...next.items);
  }
  const observed = records.find(item => item.workshopId === id);
  assert.ok(observed, 'History must expose the already committed effect without replay.');
  const receipt = await get(portal, '/api/confirmations/' + observed.confirmationId);
  assert.equal(receipt.outcomeId, portal.profile.participantId + ':' + id);
  assert.equal(receipt.attendeeEmail, values.email);
  assert.equal(receipt.prior, false);
  assert.equal(effects(portal).length, 1);
  const historyHtml = await (await fetch(portal.origin + '/enrollments')).text();
  assert.match(historyHtml, /<tr class="enrollment-record"/);
  assert.match(historyHtml, /data-receipt-status="confirmed"/);
});

test('native text confirmation is the actual URL-encoded Document POST response without machine receipt fields', async t => {
  const portal = await fixture(t, { newCount: 1, existingCount: 0, recoverableValidation: false, loseReceipt: false, receiptStyle: 'native-text' });
  const id = portal.newItems[0].id;
  const markup = await (await fetch(portal.origin + '/workshops/' + id)).text();
  assert.match(markup, /method="post" enctype="application\/x-www-form-urlencoded" target="_self"/);
  assert.match(markup, /"nativeSubmit":true/);
  const values = await fields(portal, id);
  const response = await fetch(portal.origin + '/api/workshops/' + id + '/enroll', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.equal(response.redirected, false);
  const html = await response.text();
  assert.match(html, /<section role="status"><p>Your enrollment request has been received\.<\/p><\/section>/);
  assert.doesNotMatch(html, /data-receipt-|data-outcome-|data-form-action|confirmation-[a-f0-9]/);
  assert.equal(effects(portal).length, 1);
  assert.deepEqual(effects(portal)[0].fields, values);
  assert.equal(portal.oracle().requests.find(event => event.kind === 'commit-request').contentType, 'application/x-www-form-urlencoded');
});

test('the independent fixture oracle exposes accidental replay and canonical aliases instead of hiding duplicates', async t => {
  const portal = await fixture(t, { recoverableValidation: false, loseReceipt: false });
  const id = portal.newItems[0].id;
  const values = await fields(portal, id, { notes: 'Synthetic note retained verbatim.' });
  assert.equal((await commit(portal, id, values)).status, 201);
  const alias = portal.aliases.find(item => item.canonicalId === id);
  assert.equal((await commit(portal, alias.id, values)).status, 201);
  const state = portal.oracle();
  assert.equal(state.newEffects.length, 2, 'The destination is deliberately non-idempotent for new commits.');
  assert.deepEqual(state.newUniqueCanonicalIds, [id]);
  assert.equal(state.requests.filter(event => event.kind === 'commit-request').length, 2);
  assert.notEqual(state.newEffects[0].confirmationId, state.newEffects[1].confirmationId);
  assert.equal(state.newEffects[1].fields.notes, values.notes);
  assert.equal(state.newEffects[1].formAction, portal.origin + '/api/workshops/' + alias.id + '/enroll');
  const prior = portal.priorItems[0].id;
  const priorResponse = await commit(portal, prior, await fields(portal, prior));
  assert.equal(priorResponse.status, 200);
  assert.equal((await priorResponse.json()).prior, true);
  assert.equal(effects(portal).length, 2);
});

test('history pages remain bound to their source version when a new enrollment changes the current view', async t => {
  const portal = await fixture(t, { pageSize: 1, recoverableValidation: false, loseReceipt: false });
  const before = await get(portal, '/api/enrollments?page=1');
  assert.deepEqual(before.source.coverage, { unit: 'records', start: 0, end: 1, total: 2 });
  const version = before.source.sourceVersion;
  const id = portal.newItems[0].id;
  assert.equal((await commit(portal, id, await fields(portal, id))).status, 201);
  const oldPage = await get(portal, '/api/enrollments?page=2&version=' + version);
  assert.equal(oldPage.source.sourceVersion, version);
  assert.equal(oldPage.source.coverage.total, 2);
  assert.ok(oldPage.items.every(item => item.prior));
  const current = await get(portal, '/api/enrollments?page=1');
  assert.notEqual(current.source.sourceVersion, version);
  assert.equal(current.source.coverage.total, 3);
  const stale = await fetch(portal.origin + '/api/enrollments?version=not-a-real-version');
  assert.equal(stale.status, 409);
});

test('fixture barriers allow independent observations to finish out of order without altering their evidence', { timeout: 5000 }, async t => {
  const started = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const portal = await fixture(t, { beforeRequest: async request => {
    if (request.path === '/api/workshops') { started.resolve(); await release.promise; }
  } });
  let firstFinished = false;
  const first = get(portal, '/api/workshops').then(value => { firstFinished = true; return value; });
  await started.promise;
  const second = await get(portal, '/api/enrollments');
  assert.equal(firstFinished, false);
  assert.equal(second.source.resourceKey, portal.origin + '/enrollments');
  release.resolve();
  const catalog = await first;
  assert.equal(catalog.source.resourceKey, portal.origin + '/workshops');
  assert.notEqual(catalog.source.sourceVersion, second.source.sourceVersion);
});

test('an accepted effect survives response cancellation and remains available to independent history inspection', { timeout: 5000 }, async t => {
  const accepted = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const portal = await fixture(t, { recoverableValidation: false, loseReceipt: false,
    afterCommit: async receipt => { accepted.resolve(receipt); await release.promise; } });
  const id = portal.newItems[0].id;
  const controller = new AbortController();
  const pending = commit(portal, id, await fields(portal, id), { signal: controller.signal });
  const receipt = await accepted.promise;
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(effects(portal).length, 1);
  const observed = await get(portal, '/api/confirmations/' + receipt.confirmationId);
  assert.equal(observed.status, 'confirmed');
  release.resolve();
  assert.equal(portal.oracle().requests.filter(event => event.kind === 'commit-accepted').length, 1);
});

test('fixture profile and oracle artifacts are synthetic and the oracle is not a worker-facing HTTP endpoint', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-workshop-fixture-'));
  const portal = await createWorkshopPortal({ seed: t.name, recoverableValidation: false, loseReceipt: false });
  t.after(async () => {
    await portal.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const artifacts = await portal.writeArtifacts(directory);
  const profile = JSON.parse(await readFile(artifacts.profilePath, 'utf8'));
  assert.equal(profile.fixture, true);
  assert.deepEqual(profile.preferences, [], 'The ordinary acceptance profile carries no audit-specific reminder.');
  assert.match(profile.email, /^demo-[a-f0-9]+@example\.test$/);
  const id = portal.newItems[0].id;
  assert.equal((await commit(portal, id, await fields(portal, id))).status, 201);
  const oracle = JSON.parse(await readFile(artifacts.oraclePath, 'utf8'));
  assert.equal(oracle.newEffects.length, 1);
  assert.equal(oracle.newUniqueCanonicalIds[0], id);
  assert.equal((await fetch(portal.origin + '/api/oracle')).status, 404);
  assert.equal((await fetch(portal.origin + '/fixture-oracle.json')).status, 404);
});
