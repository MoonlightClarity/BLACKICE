import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { BrowserRouter } from '../../desktop/browser-router.mjs';
import { BrowserWorkspace, agentBrowserRequest, browserOwnerKey } from '../../lib/browser.mjs';
import { observeBrowserModel } from '../../public/observe-model.mjs';

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const dataDir = argument('fixture-data'), origin = argument('fixture-origin'), identityOrigin = argument('fixture-identity-origin');
if (!dataDir || !origin || !identityOrigin) throw new Error('Disposable fixture data and two loopback origins required.');
for (const value of [origin, identityOrigin]) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== value) throw new Error('This fixture only visits its two disposable loopback websites.');
}
assert.notEqual(origin, identityOrigin, 'the popup must start at a different origin');
app.setPath('userData', path.join(dataDir, 'profile'));
app.on('window-all-closed', () => {});

const nonce = 'disposable-popup-fixture';
const resultPath = path.join(dataDir, 'result.json');
const events = [];
const record = (stage, details = {}) => { events.push({ stage, ...details }); };
const pageURL = (site, route, flow) => `${site}/${route}?${new URLSearchParams({ flow, nonce })}`;
const text = snapshot => snapshot.frames.map(frame => frame.text).join('\n');
const control = (snapshot, name) => {
  const value = snapshot.frames.flatMap(frame => frame.elements).find(element => element.name === name);
  assert.ok(value, `The disposable page must expose ${name}.`);
  return value.ref;
};
async function until(label, read, matches, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

app.whenReady().then(async () => {
  let driver, router, browser, result, foregrounded = false;
  try {
    app.on('browser-window-created', (_event, window) => {
      window.on('show', () => { foregrounded = true; });
      window.on('focus', () => { foregrounded = true; });
    });
    driver = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(dataDir, 'downloads') }).init();
    router = new BrowserRouter({ independent: driver });
    browser = new BrowserWorkspace({ driver: router });
    const unrelated = await browser.perform({ action: 'open', url: `${origin}/unrelated` }, { source: 'user' });
    const flows = [];

    async function runFlow(flow, owner = null) {
      const options = owner ? { owner } : { source: 'user' };
      let snapshot = await browser.perform({ action: 'open', url: pageURL(origin, 'parent', flow) }, options);
      const parentId = snapshot.tabId;
      // Observe can follow a task page without taking ownership of its routing.
      // A user snapshot selects the parent; the task itself opens the popup.
      if (owner) snapshot = await browser.perform({ action: 'snapshot', tabId: parentId }, { source: 'user' });
      assert.equal(browser.status().activeTab, parentId);
      const personalActiveBefore = driver.status().activeTab;
      assert.equal(personalActiveBefore, parentId);
      const pinnedId = parentId;
      record(`${flow}:parent`, { parentId, unrelatedId: unrelated.tabId });

      const opening = await browser.perform({ action: 'click', tabId: parentId, ref: control(snapshot, 'Open identity popup') }, options);
      assert.equal(opening.tabId, parentId, 'the opening action must retain its parent receipt');
      const child = await until('native popup adoption', () => browser.status().tabs.filter(tab => tab.parentTabId === parentId), tabs => tabs.length === 1);
      const childId = child[0].tabId;
      const assertSelection = () => {
        const status = browser.status();
        assert.equal(status.activeTab, childId, 'global Follow must select the native popup without another action selecting it');
        assert.equal(observeBrowserModel(status).selected?.tabId, childId, 'Observe Follow uses the actual router selection');
        assert.equal(observeBrowserModel(status, pinnedId).selected?.tabId, parentId, 'an explicit Observe pin must stay on the parent');
      };
      assertSelection();
      if (owner) {
        assert.deepEqual(child[0].owner, owner, 'the native popup must inherit its task owner');
        assert.equal(driver.status().activeTab, personalActiveBefore, 'task popup creation must not replace personal driver selection');
        assert.equal(driver.status().ownerActiveTabs[browserOwnerKey(owner)], childId);
        assert.equal(agentBrowserRequest({ action: 'snapshot' }, browser.status(), owner).tabId, childId, 'task routing must independently select its popup');
      } else assert.equal(driver.status().activeTab, childId);
      record(`${flow}:popup-followed`, { parentId, childId, explicitPin: pinnedId });

      snapshot = await browser.perform({ action: 'wait', tabId: childId, text: 'Cross-origin identity ready' }, options);
      assert.equal(snapshot.url, pageURL(identityOrigin, 'identity', flow));
      assert.match(text(snapshot), /Cross-origin identity ready/);
      const popupContents = driver.tab(childId).window.webContents;
      const parentContents = driver.tab(parentId).window.webContents;
      assert.equal(popupContents.session, parentContents.session, 'the native popup must use its parent session');
      const opener = await popupContents.executeJavaScript(`(() => {
        let crossOriginReadBlocked = false;
        try { void window.opener.document.title; } catch (error) { crossOriginReadBlocked = error.name === 'SecurityError'; }
        return { exists: !!window.opener, crossOriginReadBlocked };
      })()`);
      assert.deepEqual(opener, { exists: true, crossOriginReadBlocked: true }, 'a real cross-origin opener must survive with ordinary origin isolation');
      const messages = () => parentContents.executeJavaScript('window.fixtureMessages');
      const identityMessages = await until('identity postMessage', messages, values => values.some(value => value.phase === 'identity'));
      assert.deepEqual(identityMessages, [{ flow, nonce, phase: 'identity', origin: identityOrigin, sourceMatches: true }]);
      assertSelection();
      record(`${flow}:cross-origin-opener`);

      snapshot = await browser.perform({ action: 'click', tabId: childId, ref: control(snapshot, 'Complete fixture sign-in') }, options);
      if (snapshot.url !== pageURL(origin, 'feed', flow) || !text(snapshot).includes('Fixture feed ready')) {
        snapshot = await browser.perform({ action: 'wait', tabId: childId, text: 'Fixture feed ready' }, options);
      }
      assert.equal(snapshot.url, pageURL(origin, 'feed', flow), 'the same native popup must follow the HTTP redirect back to the parent origin');
      assertSelection();
      const received = await until('feed postMessage', messages, values => values.some(value => value.phase === 'feed'));
      assert.deepEqual(received, [
        { flow, nonce, phase: 'identity', origin: identityOrigin, sourceMatches: true },
        { flow, nonce, phase: 'feed', origin, sourceMatches: true, storage: nonce },
      ]);
      assert.equal(await popupContents.executeJavaScript('!!window.opener'), true);
      assert.equal(browser.status().tabs.find(tab => tab.tabId === childId)?.parentTabId, parentId);
      record(`${flow}:redirect-and-message`, { childId, url: snapshot.url });

      // Ask the fixture page to close itself. Sending from the live parent avoids
      // making a destroyed renderer's executeJavaScript promise the close receipt.
      // No browser action selects the parent before the router handles closure.
      await parentContents.executeJavaScript(`window.fixturePopup.postMessage(${JSON.stringify({ kind: 'blackice-popup-close', flow, nonce })}, ${JSON.stringify(origin)}); true`);
      await until('native popup close', () => browser.status(), status => !status.tabs.some(tab => tab.tabId === childId));
      const closed = browser.status();
      assert.equal(closed.activeTab, parentId, 'closing the selected popup must return to its parent, not the first personal tab');
      assert.notEqual(closed.activeTab, unrelated.tabId);
      assert.equal(observeBrowserModel(closed).selected?.tabId, parentId);
      assert.equal(observeBrowserModel(closed, pinnedId).selected?.tabId, parentId);
      assert.equal(await parentContents.executeJavaScript('window.fixturePopup.closed'), true);
      if (owner) assert.equal(agentBrowserRequest({ action: 'snapshot' }, closed, owner).tabId, parentId);
      record(`${flow}:closed-to-parent`, { parentId });
      flows.push({ flow, taskOwned: Boolean(owner), parentId, childId, crossOriginOpener: true, identityMessage: true, httpRedirect: true, feedMessage: true, sharedStorage: true, followedPopup: true, explicitPinPreserved: true, closedToParent: true });
    }

    await runFlow('personal');
    await runFlow('task', { taskId: 'popup-fixture-task', runId: 'popup-fixture-run', nodeId: 'popup-fixture-node' });
    const hidden = !foregrounded && BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused());
    assert.equal(hidden, true, 'fixture browser windows must remain contained and hidden');
    result = { ok: true, suite: 'native-popup-redirect-selection', processId: process.pid, electron: process.versions.electron, platform: process.platform, hidden, onlyDisposableLocalSites: true, actualUserBrowserAccessed: false, observeSelection: 'real observeBrowserModel over live router status', fullObserveUiTested: false, flows };
  } catch (error) {
    result = { ok: false, error: error?.stack || String(error) };
  } finally {
    try { await (browser?.close() || router?.close() || driver?.close()); }
    catch (error) { result = { ...result, ok: false, shutdownError: error?.stack || String(error) }; }
    await fs.writeFile(resultPath, JSON.stringify({ ...result, events }, null, 2) + '\n');
    if (result?.ok) app.quit(); else app.exit(1);
  }
}).catch(async error => {
  await fs.writeFile(resultPath, JSON.stringify({ ok: false, error: error?.stack || String(error), events }, null, 2) + '\n');
  app.exit(1);
});
