import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContainedBrowserFixture, WorkspaceFixtureRuntime, REQUIRED_FEATURES, SOURCES, installClipboardFixture, parseArguments, remoteDisableSettled } from '../scripts/planning-remote-ui-qa.mjs';
import { measuredChatModeRetirement } from '../scripts/chat-mode-retirement-ui-journey.mjs';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';

const asUser = { source: 'user' };
const page = (fixture, action, fields = {}) => fixture.perform({ browser: 'relay', action, ...fields }, asUser);

test('Planning UI acceptance requires retirement evidence and exposes no reverse ChatGPT browser fixture', async () => {
  const acceptance = await import('../scripts/planning-remote-ui-qa.mjs');
  assert.equal(Object.hasOwn(acceptance, 'ChatModeFixture'), false);
  assert.equal(Object.hasOwn(acceptance, 'measuredChatModePicker'), false);
  assert.deepEqual(REQUIRED_FEATURES.filter(name => /^chatMode/i.test(name)), ['chatModeRetirement']);
  for (const expected of ['lib/retired-models.mjs', 'scripts/chat-mode-retirement-ui-journey.mjs', 'lib/chatgpt-connector.mjs', 'scripts/chatgpt-connector-ui-journey.mjs']) assert.ok(SOURCES.includes(expected), expected);
  for (const retired of ['lib/chat-mode-runtime.mjs', 'lib/chat-mode-response.mjs', 'desktop/chat-mode-driver.mjs', 'scripts/chat-mode-dom-ui-journey.mjs', 'tests/fixtures/chat-mode-owned-client.mjs']) assert.equal(SOURCES.includes(retired), false, retired);
  const contained = new ContainedBrowserFixture(), runtime = new WorkspaceFixtureRuntime('/tmp/owned-planning-fixture');
  contained.tabs.push({ tabId: 'unrelated', browser: 'relay', visible: false, title: 'Unrelated page', url: 'https://example.test/' }); contained.activeTab = 'unrelated';
  const before = structuredClone(contained.tabs);
  assert.equal(runtime.status().models.some(model => (model.id || model.model) === 'chatgpt::chat-mode'), false);
  assert.deepEqual(runtime.calls, []); assert.deepEqual(contained.tabs, before);
  assert.equal(contained.activeTab, 'unrelated'); assert.deepEqual(contained.requests, []);
  await runtime.close();
});

test('rendered retirement evidence rejects reverse setup, successful retired endpoints, fallback and unmeasured preservation', () => {
  const route = 'chatgpt::chat-mode', evidence = { fixtureOnly: true, route, catalogAbsent: true, setupActionsAbsent: true, endpointReceipts: Array.from({ length: 4 }, () => ({ status: 410, code: 'CHAT_MODE_RETIRED' })), savedSelection: route, selectionAfterReload: route, draftPreserved: true, retiredVisible: true, historicalRoute: route, routeAfterNextReplyChange: route, nextReplyModel: 'fixture-model', connectionPresent: true, mobile: { width: 320, fits: true, reverseActions: 0 }, externalRequestCount: 0, turnsBefore: 6, turnsAfter: 6, historyRecordsAdded: 1 };
  assert.equal(measuredChatModeRetirement(evidence), true);
  const patches = [
    { fixtureOnly: false }, { catalogAbsent: false }, { setupActionsAbsent: false },
    { endpointReceipts: evidence.endpointReceipts.slice(1) },
    { endpointReceipts: evidence.endpointReceipts.map((receipt, index) => index ? receipt : { status: 200, code: 'CHAT_MODE_RETIRED' }) },
    { endpointReceipts: evidence.endpointReceipts.map((receipt, index) => index ? receipt : { status: 410, code: 'FEATURE_NOT_OFFERED' }) },
    { savedSelection: 'default' }, { selectionAfterReload: 'fixture-model' }, { draftPreserved: false }, { retiredVisible: false },
    { historicalRoute: null }, { routeAfterNextReplyChange: 'fixture-model' }, { nextReplyModel: route }, { connectionPresent: false },
    { externalRequestCount: 1 }, { turnsAfter: 7 }, { historyRecordsAdded: 0 },
    { mobile: { ...evidence.mobile, width: 375 } }, { mobile: { ...evidence.mobile, fits: false } }, { mobile: { ...evidence.mobile, reverseActions: 1 } },
  ];
  for (const patch of patches) assert.equal(measuredChatModeRetirement({ ...evidence, ...patch }), false, JSON.stringify(patch));
});

test('rendered Copy acceptance isolates both browser write paths and never retains copied text in evidence', async () => {
  let nativeCalls = 0;
  const supplied = 'One-time fixture text that must remain inside the owned page', listeners = new Map();
  const field = { tagName: 'TEXTAREA', readOnly: true, value: supplied, selectionStart: 0, selectionEnd: supplied.length, getAttribute: name => name === 'aria-label' ? 'Copy text' : null };
  const surface = { document: { activeElement: field, execCommand() { nativeCalls++; throw Error('Native document command reached.'); }, querySelectorAll() { return []; }, addEventListener(name, handler) { listeners.set(name, handler); } }, navigator: { clipboard: { writeText() { nativeCalls++; throw Error('Native clipboard reached.'); }, readText() { nativeCalls++; throw Error('Native clipboard read reached.'); } } } };
  installClipboardFixture(surface); const fixture = surface.__qaClipboard; fixture.expect(supplied);
  assert.equal(surface.document.execCommand('copy'), false);
  await assert.rejects(surface.navigator.clipboard.writeText(supplied), { name: 'NotAllowedError' });
  fixture.setMode('pending'); const pending = surface.navigator.clipboard.writeText(supplied);
  assert.equal(fixture.observe().pending, true); assert.equal(fixture.observe().events.at(-1).accepted, false);
  fixture.finish(); await pending; assert.equal(fixture.observe().events.at(-1).accepted, true);
  fixture.setMode('selection'); assert.equal(surface.document.execCommand('copy'), true);
  assert.equal(nativeCalls, 0); assert.equal(fixture.observe().reads, 0); assert.ok(fixture.observe().events.every(event => event.exact));
  assert.equal(JSON.stringify(fixture.observe()).includes(supplied), false);
  let prevented = false; listeners.get('copy')({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  assert.throws(() => installClipboardFixture({ ...surface, relayDesktop: { writeClipboard() {} } }), /browser-only/);
});

test('remote completion waits for owned-route removal after admission and credentials are already disabled', { timeout: 5000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-ui-remote-disable-'));
  const fixture = createRemoteTransportFixture(), pristine = fixture.config;
  let release, removalStarted, disabling;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { removalStarted = resolve; });
  const remove = fixture.transport.disable.bind(fixture.transport);
  fixture.transport.disable = async ownership => { removalStarted(); await held; return remove(ownership); };
  // The production manager and transport own the transaction; no socket or
  // real Tailscale command is needed to hold its final removal phase.
  const manager = await new RemoteAccessManager({ dataDir, transport: fixture.transport, defaultHttpsPort: 8443, gatewayFactory: () => ({ port: 32124, listening: false, accepting: true, async listen() { this.listening = true; return 'http://127.0.0.1:32124'; }, suspend() { this.accepting = false; }, async close() { this.accepting = false; this.listening = false; } }) }).init();
  t.after(async () => { release(); await disabling?.catch(() => {}); await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  await manager.attach({ origin: 'http://127.0.0.1:32123', sessionCookie: `relay_session_32123=${'c'.repeat(64)}` });
  const enabled = await manager.enable({ mode: 'public', confirmPublic: true }); assert.equal(enabled.enabled, true);
  disabling = manager.disable(); await started;
  const pending = manager.status();
  assert.equal(pending.enabled, false); assert.equal(pending.configuredEnabled, false); assert.equal(pending.devices.length, 0);
  assert.equal(fixture.config.AllowFunnel[`${fixture.hostname}:8443`], true, 'The held owned route has not yet been removed.');
  assert.equal(remoteDisableSettled(pending), false, 'Admission suspension alone is not a completed disable transaction.');
  release(); const complete = await disabling;
  assert.equal(remoteDisableSettled(complete), true);
  assert.deepEqual(fixture.config, pristine, 'The full unrelated 443 configuration remains exact after owned 8443 cleanup.');
});

test('Planning UI acceptance starts with the contained fixture unavailable and starts no page work during inspection', async () => {
  const fixture = new ContainedBrowserFixture();
  assert.equal(fixture.status().available, false);
  assert.equal(fixture.status().acceptingActions, false);
  assert.deepEqual(fixture.status().tabs, []);
  assert.deepEqual(fixture.requests, []);
  await assert.rejects(page(fixture, 'open', { url: 'https://first.qa.example.test/' }));
  assert.equal(fixture.status().tabs.length, 0);
  assert.deepEqual(fixture.requests, []);
});

test('the contained UI fixture returns explicit current-tab document and frame receipts and closes only the requested tab', async () => {
  const fixture = new ContainedBrowserFixture(); fixture.enabled = true;
  fixture.frameImage = 'data:image/png;base64,AA==';
  const first = await page(fixture, 'open', { url: 'https://first.qa.example.test/' });
  const second = await page(fixture, 'open', { url: 'https://second.qa.example.test/' });
  assert.notEqual(first.tabId, second.tabId);
  assert.equal(fixture.status().activeTab, second.tabId);
  assert.equal(first.frames[0].elements[0].ref, 'qa-field-' + first.tabId);
  const captured = await page(fixture, 'screenshot', { tabId: first.tabId });
  assert.equal(captured.tabId, first.tabId);
  assert.equal(captured.imageUrl, fixture.frameImage);
  assert.equal(fixture.status().activeTab, second.tabId, 'Observation does not activate a different page.');
  assert.deepEqual(await page(fixture, 'close', { tabId: first.tabId }), { tabId: first.tabId, closed: true });
  assert.deepEqual(fixture.status().tabs.map(tab => tab.tabId), [second.tabId]);
  assert.equal(fixture.status().activeTab, second.tabId);
  await assert.rejects(page(fixture, 'snapshot', { tabId: first.tabId }), /current contained tab/);
});

test('site protection is scoped to an observed origin and stale navigation cannot change exemptions', async () => {
  const fixture = new ContainedBrowserFixture(); fixture.enabled = true;
  const first = await page(fixture, 'open', { url: 'https://first.qa.example.test/' });
  const second = await page(fixture, 'open', { url: 'https://second.qa.example.test/' });
  const original = new URL(first.url).origin;
  let status = await fixture.configureProtection({ action: 'site', tabId: first.tabId, origin: original, enabled: false }, asUser);
  assert.deepEqual(status.exemptOrigins, [original]);
  assert.equal(status.tabs.find(tab => tab.tabId === first.tabId).enabled, false);
  assert.equal(status.tabs.find(tab => tab.tabId === second.tabId).enabled, true);
  await page(fixture, 'navigate', { tabId: first.tabId, url: 'https://changed.qa.example.test/' });
  await assert.rejects(fixture.configureProtection({ action: 'site', tabId: first.tabId, origin: original, enabled: true }, asUser), { status: 409 });
  assert.deepEqual(fixture.protectionStatus().exemptOrigins, [original]);
  status = await fixture.configureProtection({ action: 'global', enabled: false }, asUser);
  assert.ok(status.tabs.every(tab => !tab.enabled));
  status = await fixture.configureProtection({ action: 'global', enabled: true }, asUser);
  assert.ok(status.tabs.every(tab => tab.enabled));
  const before = status.filterCount;
  status = await fixture.configureProtection({ action: 'refresh' }, asUser);
  assert.equal(status.filterCount, before + 1);
});

test('the UI fixture refuses unrequested agent and native-browser actions before creating a tab', async () => {
  const fixture = new ContainedBrowserFixture(); fixture.enabled = true;
  await assert.rejects(fixture.perform({ browser: 'relay', action: 'open', url: 'https://qa.example.test/' }, { source: 'agent' }));
  await assert.rejects(fixture.perform({ browser: 'edge', action: 'open', url: 'https://qa.example.test/' }, asUser));
  await assert.rejects(page(fixture, 'open', { url: 'file:///private/path' }));
  await assert.rejects(page(fixture, 'open', { url: 'https://name:password@qa.example.test/' }));
  assert.equal(fixture.tabs.length, 0);
});

test('the Planning UI command requires bounded deadlines and explicit values', () => {
  assert.deepEqual(parseArguments(['--help']), { help: true });
  const valid = parseArguments(['--candidate', '/tmp/owned-candidate', '--out', '/tmp/owned-ui', '--timeout-ms', '180000']);
  assert.equal(valid.candidate, '/tmp/owned-candidate');
  assert.equal(valid.out, '/tmp/owned-ui');
  assert.equal(valid.timeoutMs, 180000);
  for (const args of [['--timeout-ms', '0'], ['--timeout-ms', '180001'], ['--timeout-ms', 'Infinity'], ['--out'], ['--unknown', 'value']]) assert.throws(() => parseArguments(args));
});
