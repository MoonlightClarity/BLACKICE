import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDOM } from './fixture-planning-dom.mjs';
import { createStorageSettings } from '../public/next/workspaces/settings-storage.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const until = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await tick();
  }
  throw Error('Storage settings did not settle.');
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const category = (id, bytes, extra = {}) => ({ id, title: id, detail: 'Internal detail', bytes, files: bytes ? 1 : 0, deletable: true, unsafe: false, ...extra });
const initial = () => ({
  at: '2026-11-12T18:00:00.000Z',
  categories: [
    category('conversations', 2048), category('temporary', 4096),
    category('workspaceFiles', 8192, { unsafe: true }),
    category('vm', 0, { deletable: false })
  ],
  pending: null, policy: { autoClearTemporaryOnStartup: false }, lastCleanup: null,
  externalWorkspace: null
});
async function setup(t, { state = initial(), beforeApi = async () => {}, waitForScan = true } = {}) {
  const dom = planningDOM(t), calls = [], notices = [];
  const api = async (route, method = 'GET', body, options) => {
    calls.push({ route, method, body, options });
    const response = await beforeApi(route, method, body, options);
    if (response !== undefined) return response;
    if (route === '/api/storage/overview') return structuredClone(state);
    if (route === '/api/storage/cleanup') {
      state.pending = { categories: body.categories, status: 'queued' };
      return { pending: state.pending, applies: 'next-startup' };
    }
    if (route === '/api/storage/cleanup/cancel') {
      const partial = Boolean(state.pending && state.pending.status !== 'queued');
      state.pending = null;
      return { cancelled: true, partial };
    }
    if (route === '/api/storage/policy') return state.policy = { ...body };
    throw Error('Unexpected route ' + route);
  };
  const workspace = createStorageSettings({ mount: dom.mount, api, notify: (...args) => notices.push(args) });
  t.after(() => workspace.destroy());
  workspace.enter();
  if (waitForScan) await until(() => !dom.$('#storage-refresh').disabled);
  const inputFor = id => Array.from(dom.$('#storage-categories').querySelectorAll('input')).find(input => input.value === id);
  return { ...dom, workspace, calls, notices, state, inputFor, posts: () => calls.filter(call => call.method === 'POST') };
}

test('a new install shows an empty saved-data state without empty legacy controls', async t => {
  const state = initial();
  state.categories = state.categories.map(item => ({ ...item, bytes: 0, files: 0, unsafe: false }));
  state.categories.push(category('runtimeSettings', 128, { deletable: false }));
  const d = await setup(t, { state });
  assert.equal(d.$('#storage-total').textContent, '128 B');
  assert.equal(d.$('#storage-empty').hidden, false);
  assert.equal(d.$('#storage-usage').children.length, 0);
  assert.match(d.$('#storage-system').textContent, /App settings/);
  assert.doesNotMatch(d.$('#storage-system').textContent, /Files from earlier versions/);
  assert.equal(d.$('#storage-categories').querySelectorAll('input').length, 0);
  assert.equal(d.$('#storage-delete').open, false);
  assert.equal(d.$('#storage-review-temporary').disabled, true);
  assert.match(d.$('#storage-temporary-state').textContent, /No temporary files/);
  assert.deepEqual(d.posts(), []);
});

test('refresh preserves prior measurements and disables mutations until a successful retry', async t => {
  const hold = deferred();
  let scan = 0;
  const d = await setup(t, { beforeApi: route => route === '/api/storage/overview' && ++scan === 2 ? hold.promise : undefined });
  const checkbox = d.inputFor('conversations');
  checkbox.checked = true; await checkbox.dispatch('change');
  await d.input('#storage-confirm', 'DELETE SELECTED DATA');
  assert.equal(d.$('#storage-schedule').disabled, false);
  const measured = d.$('#storage-total').textContent;
  await d.click('#storage-refresh');
  assert.equal(d.$('#storage-total').textContent, measured);
  assert.match(d.$('#storage-scan-status').textContent, /Refreshing.*Previous measurement/);
  for (const id of ['storage-schedule', 'storage-save-policy', 'storage-review-temporary', 'storage-confirm']) assert.equal(d.$('#' + id).disabled, true);
  hold.reject(Error('Offline'));
  await until(() => /scan failed/i.test(d.$('#storage-scan-status').textContent));
  assert.equal(d.$('#storage-total').textContent, measured);
  assert.equal(d.$('#storage-schedule').disabled, true);
  assert.equal(d.$('#storage-save-policy').disabled, true);
  assert.equal(d.$('#storage-refresh').disabled, false);
  await d.click('#storage-schedule');
  assert.deepEqual(d.posts(), []);
  await d.click('#storage-refresh');
  await until(() => !d.$('#storage-save-policy').disabled);
  assert.equal(d.$('#storage-scan-status').textContent, '');
});

test('an initial scan failure reports unavailable usage and permits retry', async t => {
  let failed = false;
  const d = await setup(t, { beforeApi: route => {
    if (route === '/api/storage/overview' && !failed) { failed = true; throw Error('Cannot measure storage'); }
  } });
  assert.equal(d.$('#storage-total').textContent, 'Unavailable');
  assert.equal(d.$('#storage-temporary-total').textContent, 'Unavailable');
  assert.match(d.$('#storage-scan-status').textContent, /Refresh usage to try again/);
  assert.equal(d.$('#storage-review-temporary').disabled, true);
  assert.equal(d.$('#storage-save-policy').disabled, true);
  assert.deepEqual(d.posts(), []);
  await d.click('#storage-refresh');
  await until(() => !d.$('#storage-review-temporary').disabled);
  assert.notEqual(d.$('#storage-total').textContent, 'Unavailable');
});

test('temporary cleanup reviews only temporary files and requires fresh exact confirmation', async t => {
  const d = await setup(t), chat = d.inputFor('conversations');
  chat.checked = true; await chat.dispatch('change');
  await d.input('#storage-confirm', 'DELETE SELECTED DATA');
  await d.click('#storage-review-temporary');
  assert.equal(d.$('#storage-delete').open, true);
  assert.equal(d.document.activeElement, d.inputFor('temporary'));
  assert.equal(chat.checked, false);
  assert.equal(d.inputFor('temporary').checked, true);
  assert.equal(d.$('#storage-confirm').value, '');
  assert.match(d.$('#storage-selection').textContent, /1 category.*Temporary files/);
  assert.deepEqual(d.posts(), []);
  await d.input('#storage-confirm', 'delete selected data');
  await d.click('#storage-schedule');
  assert.deepEqual(d.posts(), []);
  await d.input('#storage-confirm', 'DELETE SELECTED DATA');
  await d.click('#storage-schedule');
  assert.deepEqual(d.posts().map(call => ({ route: call.route, body: call.body })), [
    { route: '/api/storage/cleanup', body: { categories: ['temporary'], confirmation: 'DELETE SELECTED DATA' } }
  ]);
  assert.match(d.$('#storage-pending').textContent, /Temporary files.*next startup.*still present/);
});

test('a linked workspace cannot be selected for deletion', async t => {
  const d = await setup(t), workspace = d.inputFor('workspaceFiles');
  assert.equal(workspace.disabled, true);
  assert.match(d.$('#storage-usage').textContent, /Cleanup unavailable.*linked/);
  workspace.checked = true; await workspace.dispatch('change');
  await d.input('#storage-confirm', 'DELETE SELECTED DATA');
  assert.match(d.$('#storage-selection').textContent, /No categories selected/);
  assert.equal(d.$('#storage-schedule').disabled, true);
  await d.click('#storage-schedule');
  assert.deepEqual(d.posts(), []);
});

test('queued cleanup, cancellation, and history describe data using public category names', async t => {
  const state = initial();
  state.pending = { categories: ['actions', 'browserCredentials'], status: 'queued' };
  state.lastCleanup = { completedAt: '2026-11-11T18:00:00.000Z', categories: ['context', 'workspaces'], bytesInspected: 2048 };
  const d = await setup(t, { state });
  assert.equal(d.$('#storage-pending-notice').hidden, false);
  assert.match(d.$('#storage-pending').textContent, /Action history & undo, Saved passwords/);
  assert.doesNotMatch(d.$('#storage-pending').textContent, /browserCredentials/);
  assert.equal(d.$('#storage-review-temporary').disabled, true);
  assert.match(d.$('#storage-report').textContent, /Knowledge & plans, Projects & schedules/);
  assert.doesNotMatch(d.$('#storage-report').textContent, /T18:00:00/);
  await d.click('#storage-cancel');
  assert.deepEqual(d.posts().map(call => call.route), ['/api/storage/cleanup/cancel']);
  assert.equal(d.$('#storage-pending-notice').hidden, true);
  assert.match(d.$('#storage-feedback').textContent, /cancelled before startup/);
  assert.equal(d.$('#storage-review-temporary').disabled, false);
});

test('reentry shares an in-flight measurement and a later refresh starts a new scan', async t => {
  const hold = deferred();
  let scan = 0;
  const d = await setup(t, { waitForScan: false, beforeApi: route => route === '/api/storage/overview' && ++scan === 1 ? hold.promise : undefined });
  d.workspace.leave();
  d.workspace.enter();
  assert.equal(d.calls.filter(call => call.route === '/api/storage/overview').length, 1);
  assert.equal(d.calls[0].options.deadlineMs, 180000);
  assert.equal(d.$('#storage-refresh').disabled, true);
  hold.resolve({ ...initial(), categories: [category('conversations', 1024 * 1024)] });
  await until(() => !d.$('#storage-refresh').disabled);
  assert.equal(d.$('#storage-total').textContent, '1 MiB');
  assert.equal(d.$('#storage-pending-notice').hidden, true);
  await d.click('#storage-refresh');
  await until(() => !d.$('#storage-refresh').disabled);
  assert.equal(d.calls.filter(call => call.route === '/api/storage/overview').length, 2);
  assert.equal(d.$('#storage-total').textContent, '14 KiB');
  assert.equal(d.$('#storage-review-temporary').disabled, false);
  assert.deepEqual(d.posts(), []);
});

test('acknowledged cleanup stays cancellable after a scan failure and recovery clears errors', async t => {
  let failScan = false;
  const d = await setup(t, { beforeApi: route => {
    if (route === '/api/storage/overview' && failScan) throw Error('Storage scan interrupted');
  } });
  await d.click('#storage-review-temporary');
  await d.input('#storage-confirm', 'DELETE SELECTED DATA');
  failScan = true;
  await d.click('#storage-schedule');
  assert.match(d.$('#storage-scan-status').textContent, /scan failed/i);
  assert.equal(d.$('#storage-pending-notice').hidden, false);
  assert.match(d.$('#storage-pending').textContent, /Temporary files.*still present/);
  assert.equal(d.$('#storage-cancel').hidden, false);
  assert.equal(d.$('#storage-cancel').disabled, false);
  assert.equal(d.$('#storage-schedule').disabled, true);
  await d.click('#storage-cancel');
  assert.deepEqual(d.posts().map(call => call.route), ['/api/storage/cleanup', '/api/storage/cleanup/cancel']);
  assert.equal(d.$('#storage-pending-notice').hidden, true);
  assert.match(d.$('#storage-feedback').textContent, /cancelled before startup/);
  await d.click('#storage-refresh');
  await until(() => !d.$('#storage-refresh').disabled);
  assert.equal(d.$('#storage-feedback').dataset.state, 'error');
  assert.match(d.$('#storage-feedback').textContent, /Storage scan interrupted/);
  failScan = false;
  await d.click('#storage-refresh');
  await until(() => !d.$('#storage-review-temporary').disabled);
  assert.equal(d.$('#storage-scan-status').textContent, '');
  assert.equal(d.$('#storage-feedback').textContent, '');
  assert.equal(d.$('#storage-feedback').dataset.state, 'info');
});
