import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

// Exercise the production renderer function and public driver read path. Only
// Electron and DOM boundaries are fixtures; no website or native app is opened.
const sourceURL = new URL('../desktop/browser-driver.mjs', import.meta.url);
const source = await readFile(sourceURL, 'utf8');
const snapshotSource = source.slice(source.indexOf('function pageSnapshot('), source.indexOf('\nasync function smoothPageScroll('));
const importKey = '__read_context_' + randomUUID().replaceAll('-', '');
const importSource = source.replace("import { BrowserWindow, session } from 'electron';", `const {BrowserWindow,session}=globalThis[${JSON.stringify(importKey)}];`).replace(/from '(\.\.?\/[^']+)'/g, (_all, relative) => `from '${new URL(relative, sourceURL).href}'`);
globalThis[importKey] = { BrowserWindow: class {}, session: {} };
let ElectronBrowserDriver;
try { ({ ElectronBrowserDriver } = await import('data:text/javascript;base64,' + Buffer.from(importSource).toString('base64'))); } finally { delete globalThis[importKey]; }

const text = value => ({ nodeType: 3, textContent: value });
function element(tag, value = '', options = {}) {
  const attributes = options.attributes || {}, children = options.children || [], childNodes = options.childNodes || (value ? [text(value), ...children] : children);
  return {
    tagName: tag.toUpperCase(), children, childNodes, tabIndex: -1, isConnected: true,
    ...options, getAttribute: name => attributes[name] || null,
    getBoundingClientRect: () => ({ width: 100, height: 24 }),
    get textContent() { return childNodes.map(node => node.textContent || '').join(''); }
  };
}
function domFixture(children, protectedFields = []) {
  const key = '__snapshot_fixture', document = { title: 'Role fixture', readyState: 'complete', documentElement: { children: [element('body', '', { children })] }, getElementById: () => null };
  const context = vm.createContext({ document, location: { href: 'https://jobs.example.test/role' }, getComputedStyle: el => ({ display: el.hidden ? 'none' : 'block', visibility: el.invisible ? 'hidden' : 'visible' }), [key]: { document, prefix: 'old', credentialFields: new WeakSet(protectedFields) } });
  const run = (query = '', readContext = false) => JSON.parse(JSON.stringify(vm.runInContext(`(${snapshotSource})(${JSON.stringify(key)},"current",${JSON.stringify(query)},${readContext})`, context)));
  return { key, context, run };
}
function roleFixture() {
  const password = element('input', 'PASSWORD_CHILD_SECRET', { type: 'password', value: 'PASSWORD_VALUE_SECRET', attributes: { 'aria-label': 'Password' } });
  const opaque = element('textarea', 'OPAQUE_PASSWORD_SECRET', { type: 'text', value: 'OPAQUE_PASSWORD_SECRET', attributes: { 'aria-label': 'Protected field' } });
  const children = [
    element('p', 'Far unrelated content ' + 'unrelated '.repeat(12000)),
    element('p', 'Role summary'), element('h2', 'About the role'),
    element('p', 'Build resilient customer systems.'), element('h3', 'Requirements'),
    element('p', 'Three years of Python experience.'),
    element('div', '', { hidden: true, children: [element('p', 'HIDDEN_JOB_SECRET')] }),
    element('script', 'SCRIPT_JOB_SECRET'), password, opaque,
    element('p', 'Remote within the United States.'), element('p', 'Authorization to work is required.'),
    element('p', 'Salary range: $90,000 to $120,000.'), element('button', 'Apply now'),
    element('p', 'Eighth visible context line.'), element('p', 'OUTSIDE_CONTEXT_SECTION ' + 'huge '.repeat(10000))
  ];
  return domFixture(children, [opaque]);
}

test('queried read includes role requirements while snapshot keeps exact filtering and private fields stay opaque', () => {
  const f = roleFixture();
  const all = f.run(); assert.ok(all.elements.some(item => item.name === 'Apply now'));
  const priorRefs = new Set(all.elements.filter(item => item.name !== 'About the role').map(item => item.ref));
  const snapshot = f.run('About the role');
  assert.equal(snapshot.text, 'About the role'); assert.equal(snapshot.textContext, undefined);
  assert.deepEqual(snapshot.elements.map(item => item.name), ['About the role']);
  const read = f.run('About the role', true);
  for (const wanted of ['Role summary', 'About the role', 'Build resilient customer systems.', 'Requirements', 'Three years of Python experience.', 'Remote within the United States.', 'Salary range:', 'Eighth visible context line.']) assert.ok(read.text.includes(wanted), wanted);
  assert.doesNotMatch(read.text, /Far unrelated content|OUTSIDE_CONTEXT_SECTION|HIDDEN_JOB_SECRET|SCRIPT_JOB_SECRET|PASSWORD_.*SECRET/);
  assert.deepEqual(read.elements, snapshot.elements, 'Text context must not grant refs to nearby unmatched controls.');
  assert.deepEqual(read.textContext, { matches: 1, before: 1, after: 8 });
  assert.ok(read.text.length <= 22000);
  for (const ref of priorRefs) assert.equal(f.context[f.key].elements.has(ref), false, 'Unreturned controls must be retired in the renderer.');
  assert.equal(f.context[f.key].elements.size, read.elements.length);
  const secretSearch = f.run('PASSWORD', true); assert.equal(secretSearch.text, '');
  assert.deepEqual(secretSearch.elements.map(item => item.name), ['Password']);
  assert.ok(secretSearch.elements.every(item => !Object.hasOwn(item, 'value')));
});

test('a huge adjacent paragraph cannot bury the match and context stays within per-node and total caps', () => {
  const f = domFixture([element('p', 'Previous paragraph '.repeat(10000)), element('h2', 'About the role'), element('p', 'Required: Python and SQL.'), ...Array.from({ length: 20 }, (_, index) => element('p', `Large context ${index}: ` + 'details '.repeat(1500)))]);
  const read = f.run('About the role', true);
  assert.match(read.text, /About the role/); assert.match(read.text, /Required: Python and SQL/);
  assert.equal(read.truncated, true); assert.ok(read.text.length <= 22000);
  assert.ok(read.text.split('\n').every(value => value.length <= 2000));
  assert.doesNotMatch(read.text, /Large context 8:/);
  const giantMatch = domFixture([element('p', 'prefix '.repeat(10000) + 'About the role' + ' suffix'.repeat(10000))]).run('About the role', true);
  assert.match(giantMatch.text, /About the role/); assert.ok(giantMatch.text.length <= 2000);
});

test('queried read limits matching passages and text-node scans even inside one large element', () => {
  const children = Array.from({ length: 20 }, (_, index) => [element('h2', `Section needle ${index}`), ...Array.from({ length: 9 }, (_, line) => element('p', `Passage ${index} detail ${line}`))]).flat();
  const read = domFixture(children).run('Section needle', true);
  assert.equal(read.textContext.matches, 12); assert.equal(read.truncated, true);
  assert.match(read.text, /Section needle 11/); assert.doesNotMatch(read.text, /Section needle 12|Passage 12 detail/);
  let inspected = 0;
  const nodes = Array.from({ length: 17000 }, () => ({ nodeType: 3, get textContent() { inspected++; return 'No matching content'; } }));
  const bounded = domFixture([element('p', '', { childNodes: nodes })]).run('unseen query', true);
  assert.equal(inspected, 16000); assert.equal(bounded.truncated, true); assert.equal(bounded.text, '');
});

test('the actual public read path opts into context and keeps host refs exact; no-query reads remain unchanged', async () => {
  const f = roleFixture(), frame = { processId: 1, routingId: 1, framesInSubtree: [], executeJavaScript: async code => JSON.parse(JSON.stringify(vm.runInContext(code, f.context))) };
  const tab = { id: 'tab-one', revision: 1, refs: new Map(), suspendedWork: new Set(), window: { isDestroyed: () => false, webContents: { mainFrame: frame, getURL: () => 'https://jobs.example.test/role', getTitle: () => 'Role fixture' } } };
  const driver = Object.create(ElectronBrowserDriver.prototype);
  Object.assign(driver, { key: f.key, tabs: new Map([[tab.id, tab]]), activeTab: tab.id, activate: async () => {}, settle: async () => {}, pageWork: async (_tab, work) => work, status: () => ({ tabs: [{ tabId: tab.id }] }) });
  const all = await driver.perform({ action: 'snapshot', tabId: tab.id });
  const oldApplyRef = all.frames[0].elements.find(item => item.name === 'Apply now').ref;
  assert.equal(tab.refs.has(oldApplyRef), true);
  const snapshot = await driver.perform({ action: 'snapshot', tabId: tab.id, query: 'About the role' });
  const read = await driver.perform({ action: 'read', tabId: tab.id, query: 'About the role' });
  assert.equal(snapshot.frames[0].text, 'About the role'); assert.match(read.frames[0].text, /Three years of Python/);
  assert.equal(tab.refs.has(oldApplyRef), false); assert.equal(tab.refs.size, 1);
  assert.equal(f.context[f.key].elements.size, 1);
  assert.deepEqual([...tab.refs.keys()], read.frames[0].elements.map(item => item.ref));
  const unfilteredSnapshot = await driver.perform({ action: 'snapshot', tabId: tab.id });
  const unfilteredRead = await driver.perform({ action: 'read', tabId: tab.id });
  assert.deepEqual(unfilteredRead, unfilteredSnapshot); assert.equal(unfilteredRead.frames[0].textContext, undefined);
});

function frameFixture(mainFrame) {
  let activations = 0, settlements = 0, acquisitions = 0;
  const timeouts = [], contents = { getURL: () => 'https://jobs.example.test/role', getTitle: () => 'Role fixture', loadURL: () => assert.fail('Snapshot recovery must never navigate or replay input.') };
  Object.defineProperty(contents, 'mainFrame', { get() { acquisitions++; return mainFrame(acquisitions); } });
  const tab = { id: 'tab-one', revision: 7, refs: new Map([['stale-ref', {}]]), suspendedWork: new Set(), window: { isDestroyed: () => false, webContents: contents } };
  const driver = Object.create(ElectronBrowserDriver.prototype);
  Object.assign(driver, { key: '__snapshot_fixture', tabs: new Map([[tab.id, tab]]), activeTab: tab.id, activate: async () => { activations++; }, settle: async () => { settlements++; }, pageWork: async (_tab, work, _signal, timeout) => { timeouts.push(timeout); return work; }, status: () => ({ tabs: [{ tabId: tab.id }] }) });
  return { driver, tab, timeouts, get counts() { return { activations, settlements, acquisitions }; } };
}
const disposed = () => new Error('Render frame was disposed before WebFrameMain could be accessed');
const readableFrame = dom => ({ processId: 9, routingId: 12, framesInSubtree: [], executeJavaScript: async code => JSON.parse(JSON.stringify(vm.runInContext(code, dom.context))) });

for (const phase of ['enumeration', 'metadata', 'execution']) test(`a disposed frame during ${phase} is reacquired once for the current read without replaying the preceding action`, async () => {
  const dom = roleFixture(), fresh = readableFrame(dom), stale = { processId: 1, routingId: 2, framesInSubtree: [], executeJavaScript: async () => { throw disposed(); } };
  Object.defineProperty(stale, 'url', { get() { assert.fail('Error handling must not access disposed frame metadata.'); } });
  if (phase === 'enumeration') Object.defineProperty(stale, 'framesInSubtree', { get() { throw disposed(); } });
  if (phase === 'metadata') Object.defineProperty(stale, 'processId', { get() { throw disposed(); } });
  const f = frameFixture(attempt => attempt === 1 ? stale : fresh);
  const read = await f.driver.perform({ action: 'read', tabId: f.tab.id, query: 'About the role' });
  assert.match(read.frames[0].text, /Three years of Python/); assert.equal(read.frames[0].frame, '9-12');
  assert.deepEqual(f.counts, { activations: 1, settlements: 1, acquisitions: 2 });
  assert.equal(f.tab.refs.has('stale-ref'), false); assert.equal(f.tab.refs.size, 1);
  assert.ok([...f.tab.refs.keys()].every(ref => ref.startsWith('7-9-12:')));
  assert.ok([...f.tab.refs.values()].every(frame => frame === fresh));
});

test('repeated disposal stays bounded, ordinary frame errors are not retried, and partial reads keep their successful frames', async () => {
  let executions = 0;
  const stale = { processId: 1, routingId: 2, framesInSubtree: [], executeJavaScript: async () => { executions++; throw disposed(); } };
  Object.defineProperty(stale, 'url', { get() { assert.fail('A disposed URL getter must stay untouched.'); } });
  const repeated = frameFixture(() => stale), failed = await repeated.driver.perform({ action: 'snapshot', tabId: repeated.tab.id });
  assert.deepEqual(failed.frames, []); assert.equal(failed.frameErrors.length, 1); assert.match(failed.frameErrors[0].error, /disposed/);
  assert.equal(repeated.counts.acquisitions, 2); assert.equal(executions, 2); assert.equal(repeated.tab.refs.size, 0);
  const ordinary = frameFixture(() => ({ processId: 1, routingId: 2, framesInSubtree: [], executeJavaScript: async () => { throw new Error('Unrelated inspection failure'); } }));
  const ordinaryFailure = await ordinary.driver.perform({ action: 'read', tabId: ordinary.tab.id });
  assert.equal(ordinary.counts.acquisitions, 1); assert.match(ordinaryFailure.frameErrors[0].error, /Unrelated inspection failure/);
  const dom = roleFixture(), fresh = readableFrame(dom); fresh.framesInSubtree = [fresh, stale];
  const partial = frameFixture(() => fresh), result = await partial.driver.perform({ action: 'read', tabId: partial.tab.id });
  assert.equal(result.frames.length, 1); assert.equal(result.frames[0].frame, '9-12'); assert.equal(result.frameErrors.length, 1);
  assert.equal(partial.counts.acquisitions, 1);
});

test('frame reacquisition shares the original read deadline and cancellation forbids its retry', async t => {
  let now = 0; t.mock.method(Date, 'now', () => now);
  const dom = roleFixture(), fresh = readableFrame(dom), stale = { processId: 1, routingId: 2, framesInSubtree: [], executeJavaScript: async () => { await Promise.resolve(); now = 6500; throw disposed(); } };
  const f = frameFixture(attempt => attempt === 1 ? stale : fresh);
  const read = await f.driver.perform({ action: 'read', tabId: f.tab.id, query: 'About the role' });
  assert.equal(read.frames.length, 1); assert.deepEqual(f.timeouts, [5000, 500]);
  const controller = new AbortController(), cancelledFrame = {};
  Object.defineProperty(cancelledFrame, 'framesInSubtree', { get() { controller.abort(); throw disposed(); } });
  const stopped = frameFixture(() => cancelledFrame);
  await assert.rejects(stopped.driver.perform({ action: 'snapshot', tabId: stopped.tab.id }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(stopped.counts.acquisitions, 1); assert.equal(stopped.tab.refs.size, 0);
});
