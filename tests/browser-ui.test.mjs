import test from 'node:test';
import assert from 'node:assert/strict';
import { browserWorkspaceMarkup, openBrowserWorkspace } from '../public/browser-ui.mjs';

const independent = { available: true, tabs: [{ tabId: 'tab-1', title: 'Fixture page', url: 'https://example.com/' }], activeTab: 'tab-1', downloads: [] };

test('connected BrowserOS is manual, may foreground and remains unavailable to task agents', () => {
  const html = browserWorkspaceMarkup({ ...independent, signedBrowser: { available: true, endpoint: 'http://127.0.0.1:9000/mcp', accountAuthenticated: null } }, { selected: 'tab-1' });
  assert.match(html, /BrowserOS neo/); assert.match(html, />Connected</);
  assert.match(html, /Manual external connection\. Neo may activate its window; it is unavailable to task agents\./);
  assert.doesNotMatch(html, /Uses your BrowserOS sign-ins|agent checks each site before acting/);
  assert.match(html, /id="browser-reconnect"/); assert.doesNotMatch(html, /id="browser-start"|LinkedIn|account is signed in/);
  assert.match(html, /<details id="browser-separate" class="browser-downloads"><summary>Separate browser/);
  assert.ok(html.indexOf('BrowserOS neo') < html.indexOf('Separate browser'));
});

test('manual external start is offered only for a disconnected browser with a configured endpoint', () => {
  const offline = { ...independent, signedBrowser: { available: false, endpoint: 'http://127.0.0.1:9000/mcp', reason: 'The browser is not running.' } };
  assert.match(browserWorkspaceMarkup(offline), /id="browser-start">Start external browser/);
  assert.doesNotMatch(browserWorkspaceMarkup(offline), /Start in background/);
  assert.match(browserWorkspaceMarkup(offline), /The browser is not running\./);
  for (const endpoint of [undefined, '', ' ']) assert.doesNotMatch(browserWorkspaceMarkup({ ...offline, signedBrowser: { ...offline.signedBrowser, endpoint } }), /id="browser-start"/);
});

test('separate browser expansion survives a refresh and its controls remain available', () => {
  const html = browserWorkspaceMarkup({ ...independent, signedBrowser: { available: true } }, { selected: 'tab-1', separateOpen: true });
  assert.match(html, /id="browser-separate" class="browser-downloads" open/);
  for (const control of ['browser-open-form', 'data-browser-show="tab-1"', 'data-browser-close="tab-1"', 'id="browser-preview"', 'id="browser-inspect"']) assert.ok(html.includes(control));
});

test('legacy native browser status keeps direct controls without a signed-browser section', () => {
  const html = browserWorkspaceMarkup(independent, { selected: 'tab-1' });
  assert.match(html, /id="browser-open-form"/); assert.match(html, /data-browser-show="tab-1"/);
  assert.doesNotMatch(html, /BrowserOS neo|browser-separate|browser-reconnect|browser-start/);
  const unavailable = browserWorkspaceMarkup({ available: false });
  assert.match(unavailable, /Open the desktop app/); assert.match(unavailable, /data-browser-done/);
});

test('connection errors and separate-browser metadata render as text', () => {
  const html = browserWorkspaceMarkup({ ...independent, signedBrowser: { available: false, reason: '<img src=x onerror=alert(1)>' }, tabs: [{ tabId: '\" onclick=\"bad', title: '<script>bad</script>', url: 'https://example.com/?a=1&b=2' }] });
  assert.doesNotMatch(html, /<img|<script|tab="" onclick=/);
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script/); assert.match(html, /a=1&amp;b=2/);
});

test('stale Firefox availability never offers copying sessions or claims an authenticated account', () => {
  const status = { ...independent, sessionReuse: { browser: 'firefox', available: true, accountAuthenticated: 'unknown' }, signedBrowser: { available: false, endpoint: 'http://127.0.0.1:9000/mcp' } };
  const html = browserWorkspaceMarkup(status);
  assert.match(html, /Existing browser<\/strong><span>Direct connection<\/span>/);
  assert.match(html, /Manual external connections keep their own sign-ins\. Agent browser work stays inside Activity\./);
  assert.ok(html.indexOf('BrowserOS neo') < html.indexOf('Existing browser'));
  assert.match(html, /<details id="browser-separate" class="browser-downloads"><summary>Separate browser/);
  assert.match(html, /id="browser-reconnect"/); assert.match(html, /id="browser-start"/);
  assert.doesNotMatch(html, /LinkedIn|signed into|account is|Import session|Configure Firefox|Firefox sign-ins|Agents can reuse saved website sessions|id="browser-neo"/);
});

test('disabled Firefox reuse metadata keeps direct connection guidance and BrowserOS controls', () => {
  const html = browserWorkspaceMarkup({ ...independent, sessionReuse: { browser: 'firefox', available: false, accountAuthenticated: 'unknown' }, signedBrowser: { available: true } });
  assert.match(html, /Existing browser<\/strong><span>Direct connection<\/span>/);
  assert.doesNotMatch(html, /Firefox sign-ins|id="browser-neo"|Agents can reuse saved website sessions/);
  assert.match(html, /BrowserOS neo<\/strong><span>Connected/);
});

test('Chrome connection is explicit and warns about foreground dialogs while agent work stays contained', () => {
  const status = { ...independent, chromeBrowser: { available: true, connected: false, accountAuthenticated: 'unknown', reason: 'Chrome is waiting for its connection request.' }, signedBrowser: { available: true } };
  const html = browserWorkspaceMarkup(status);
  assert.match(html, /Chrome<\/strong><span>Not connected/); assert.match(html, /id="browser-chrome-connect">Connect Chrome/);
  assert.match(html, /Manual connection\. Chrome dialogs can appear in front of your work; agents use the contained browser\./);
  assert.doesNotMatch(html, /Your sign-ins stay in Chrome\. The agent checks each site\./);
  assert.match(html, /<details id="browser-chrome-setup"><summary>Connection setup/);
  assert.match(html, /chrome:\/\/inspect\/#remote-debugging/); assert.match(html, /choose Allow in Chrome’s connection prompt/);
  assert.doesNotMatch(html, /<details id="browser-neo"/);
  assert.ok(html.indexOf('BrowserOS neo') < html.indexOf('Chrome</strong>'));
  assert.match(html, /id="browser-reconnect"/); assert.match(html, /Chrome is waiting for its connection request\./);
  assert.doesNotMatch(html, /Firefox sign-ins|Import session|LinkedIn|account is signed in/);
});

test('only an established Chrome connection earns Connected status and setup errors stay text', () => {
  const available = browserWorkspaceMarkup({ ...independent, chromeBrowser: { available: true, connected: false, reason: '<img src=x onerror=alert(1)>' } });
  assert.doesNotMatch(available, /Chrome<\/strong><span>Connected|<img/); assert.match(available, /&lt;img/);
  const connected = browserWorkspaceMarkup({ ...independent, chromeBrowser: { available: true, connected: true, connectionId: 'chrome-live', accountAuthenticated: 'unknown' } }, { chromeSetupOpen: true });
  assert.match(connected, /Chrome<\/strong><span>Connected/); assert.match(connected, />Reconnect Chrome<\/button>/);
  assert.match(connected, /id="browser-chrome-setup" open/); assert.doesNotMatch(connected, /Import session|authenticated account/);
});

test('opening the browser workspace never connects Chrome until its explicit button is pressed', async t => {
  const previousDocument = globalThis.document, calls = [], button = { textContent: 'Connect Chrome', isConnected: true }, error = { textContent: '' };
  const view = { innerHTML: '' }, done = {}, setup = { open: false };
  const elements = new Map([['#browser-workspace-view', view], ['#browser-chrome-connect', button], ['#browser-chrome-setup', setup], ['#browser-ui-error', error], ['[data-browser-done]', done]]);
  globalThis.document = { querySelector: selector => elements.get(selector) || null, querySelectorAll: () => [] };
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  let connected = false;
  await openBrowserWorkspace({ api: async (route, method, body) => { calls.push({ route, method, body }); if (route === '/api/browser/chrome/connect') { connected = true; return {}; } return { available: false, chromeBrowser: { available: true, connected } }; }, showModal() {}, closeModal() {}, toast() {} });
  assert.deepEqual(calls.map(call => call.route), ['/api/browser/status']);
  assert.equal(typeof button.onclick, 'function');
  await button.onclick();
  assert.deepEqual(calls[1], { route: '/api/browser/chrome/connect', method: 'POST', body: {} });
  assert.equal(calls[2].route, '/api/browser/status'); assert.equal(error.textContent, ''); assert.equal(button.disabled, false);
});

test('native BrowserOS discovery exposes manual controls with an explicit foreground limitation', () => {
  const html = browserWorkspaceMarkup({ ...independent, signedBrowser: { available: false, discovering: true, nativeIntegration: true, canStart: true }, chromeBrowser: { connected: false } });
  assert.match(html, /BrowserOS neo<\/strong><span>Connecting…/);
  assert.match(html, /Manual controls · may foreground a window/); assert.match(html, /Manual external connection is unavailable\. Use Activity for contained browser work\./);
  assert.doesNotMatch(html, /Automatic · no tool server setup|BLACKICE finds BrowserOS neo automatically/);
  assert.match(html, /id="browser-start"/); assert.doesNotMatch(html, /<details id="browser-neo"/);
  assert.ok(html.indexOf('BrowserOS neo') < html.indexOf('Chrome<\/strong>'));
});
