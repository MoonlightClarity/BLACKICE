import test from 'node:test';
import assert from 'node:assert/strict';
import { browserWorkspaceMarkup, openBrowserWorkspace } from '../public/browser-ui.mjs';

const status = { available: false, signedBrowser: { available: false, nativeIntegration: true }, neoImport: { available: true, localManagement: true, capabilities: { open: true } } };
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

test('Neo import is offered from verified installation metadata and explains its native destination', () => {
  const html = browserWorkspaceMarkup(status);
  assert.match(html, /id="browser-neo-import">Import into Neo…/);
  assert.match(html, /native Neo window/); assert.match(html, /source browser, profile, and data/);
  assert.match(html, /Imported data goes to Neo; Activity’s contained browser has its own sign-ins/);
  assert.match(html, /Some sites require signing in again/);
  for (const neoImport of [undefined, { available: false }, { ...status.neoImport, localManagement: false }]) assert.doesNotMatch(browserWorkspaceMarkup({ ...status, neoImport }), /id="browser-neo-import"/);
  const unavailable = browserWorkspaceMarkup({ ...status, neoImport: { available: false, reason: '<script>not installed</script>' } });
  assert.doesNotMatch(unavailable, /<script>/); assert.match(unavailable, /&lt;script&gt;/);
  assert.match(browserWorkspaceMarkup({ ...status, neoImport: { ...status.neoImport, capabilities: { open: false } } }), /id="browser-neo-import" disabled/);
});

function dom(t) {
  const previous = globalThis.document;
  const button = { id: 'browser-neo-import', textContent: 'Import into Neo…', isConnected: true }, view = { innerHTML: '' }, error = { textContent: '' }, done = { dataset: { browserDone: '' } };
  const elements = new Map([['#browser-workspace-view', view], ['#browser-neo-import', button], ['#browser-ui-error', error], ['[data-browser-done]', done]]);
  globalThis.document = { querySelector: selector => elements.get(selector) || null, querySelectorAll: selector => selector === '#browser-workspace-view button' ? [button, done] : [] };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  return { button, view, error };
}

test('opening Browser workspace does not import; one explicit click sends only an empty handoff request', async t => {
  const { button, view, error } = dom(t), release = deferred(), calls = []; let modal = '';
  await openBrowserWorkspace({ api: async (route, method, body) => {
    calls.push({ route, method, body });
    if (route === '/api/browser/neo/import') { await release.promise; return { requested: true, destination: 'neo', importCompleted: false, windowVerified: false }; }
    return status;
  }, showModal(_id, value) { modal = value; }, closeModal() {}, toast() {} });
  assert.match(modal, /Manage browser connections and browser data/); assert.doesNotMatch(modal, /Agents work here/);
  assert.deepEqual(calls.map(value => value.route), ['/api/browser/status']);
  const opening = button.onclick(); await button.onclick();
  assert.equal(button.disabled, true);
  assert.deepEqual(calls[1], { route: '/api/browser/neo/import', method: 'POST', body: {} }); assert.equal(calls.length, 2);
  release.resolve(); await opening;
  assert.equal(calls.length, 3); assert.equal(calls[2].route, '/api/browser/status');
  assert.equal(error.textContent, ''); assert.equal(button.disabled, false);
  assert.match(view.innerHTML, /Neo import settings were requested/); assert.match(view.innerHTML, /BLACKICE has not verified an import/);
  assert.doesNotMatch(view.innerHTML, /Import complete|Sign-ins imported|Successfully imported/);
});

test('unverified handoff responses remain errors without an imported-session success message', async t => {
  const { button, view, error } = dom(t);
  await openBrowserWorkspace({ api: async route => route === '/api/browser/neo/import' ? { requested: true, destination: 'relay', importCompleted: true } : status, showModal() {}, closeModal() {}, toast() {} });
  await button.onclick(); assert.match(error.textContent, /did not confirm/);
  assert.doesNotMatch(view.innerHTML, /import settings were requested|Import complete|Successfully imported/);
});
