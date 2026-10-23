import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopRestartController } from '../desktop/restart.mjs';
import { FilePatchStore } from '../lib/file-patches.mjs';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';

async function directory(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-install-reconcile-'));
  t.after(async () => { assert.match(path.basename(root), /^blackice-install-reconcile-/); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test('restart persistence recognizes a rename that committed before reporting an error, without relaunching', async t => {
  const root = await directory(t); let promotions = 0, launches = 0;
  const controller = new DesktopRestartController({ profileDir: root, getIdentity() {}, getLaunchOptions() {}, checkReady() {}, prepare() {}, release() {}, relaunch() { launches++; }, quit() { launches++; }, io: {
    rename: async (from, to) => { promotions++; await fs.rename(from, to); throw new Error('Acknowledgement lost after committed rename.'); },
  } });
  await controller.persist([]);
  assert.deepEqual(JSON.parse(await fs.readFile(controller.file, 'utf8')), { version: 1, receipts: [] });
  assert.equal(controller.storageError, null); assert.equal(promotions, 1); assert.equal(launches, 0);
  assert.deepEqual(await fs.readdir(root), ['desktop-restart.json']);
});

test('restart persistence does not claim success for a mismatching destination after a rename error', async t => {
  const root = await directory(t), file = path.join(root, 'desktop-restart.json'), previous = 'Unrelated existing receipt bytes';
  await fs.writeFile(file, previous);
  const controller = new DesktopRestartController({ profileDir: root, getIdentity() {}, getLaunchOptions() {}, checkReady() {}, prepare() {}, release() {}, relaunch() { assert.fail('No relaunch is allowed.'); }, quit() { assert.fail('No quit is allowed.'); }, io: { rename: async () => { throw new Error('No promotion occurred.'); } } });
  await assert.rejects(controller.persist([]), { code: 'DESKTOP_RESTART_STORAGE_UNAVAILABLE' });
  assert.equal(await fs.readFile(file, 'utf8'), previous); assert.equal(controller.receipts.length, 0);
  assert.deepEqual(await fs.readdir(root), ['desktop-restart.json']);
});

for (const outcome of ['committed', 'unknown']) test(`file-patch promotion error preserves actual ${outcome} destination state and receipt`, async t => {
  const root = await directory(t), file = path.join(root, 'owned.txt'); let promotions = 0;
  await fs.writeFile(file, 'before');
  const io = { ...fs, rename: async (from, to) => {
    if (to !== file) return fs.rename(from, to);
    promotions++;
    if (outcome === 'committed') await fs.rename(from, to);
    else await fs.writeFile(file, 'Other author text');
    throw new Error('Destination promotion acknowledgement failed.');
  } };
  const store = new FilePatchStore({ dataDir: path.join(root, 'data'), io }); t.after(() => store.close());
  const work = store.patch({ cwd: root, path: file, oldText: 'before', newText: 'after' });
  if (outcome === 'committed') {
    const receipt = await work; assert.equal(receipt.status, 'applied'); assert.equal((await store.get(receipt.id)).status, 'applied');
    assert.equal(await fs.readFile(file, 'utf8'), 'after');
  } else {
    await assert.rejects(work, /promotion acknowledgement failed/);
    const history = await store.list({ cwd: root }); assert.equal(history.total, 1); assert.equal(history.patches[0].status, 'prepared', 'Unknown destination state must not be falsely labeled not_applied or applied.');
    assert.equal(await fs.readFile(file, 'utf8'), 'Other author text');
  }
  assert.equal(promotions, 1, 'A completed or uncertain effect must not be replayed.');
  assert.equal((await fs.readdir(root)).some(name => name.includes('.relay-patch-')), false);
});

test('literal rg search distinguishes exactly limit from limit-plus-one through a trusted executable prefix', async t => {
  const root = await directory(t), stub = path.join(root, 'bounded-rg-fixture.mjs');
  await fs.writeFile(stub, `import fs from 'node:fs';
const args=process.argv.slice(2);
if(args[0]!=='trusted-prefix'||!args.includes('--fixed-strings'))throw Error('Unexpected fixture invocation.');
const limit=Number(args[args.indexOf('--max-count')+1]),marker=args.indexOf('--'),query=args[marker+1],file=args[marker+2];
const matches=fs.readFileSync(file,'utf8').split(/\\r?\\n/).map((text,index)=>({text,line:index+1})).filter(row=>row.text.includes(query)).slice(0,limit);
for(const row of matches)process.stdout.write(file+':'+row.line+':'+row.text+'\\n');
if(!matches.length)process.exitCode=1;
`);
  const handler = createWorkspaceToolHandler({ cwd: root, rgCommand: [process.execPath, stub, 'trusted-prefix'] });
  for (const count of [2, 3]) {
    const file = `matches-${count}.txt`; await fs.writeFile(path.join(root, file), 'needle|literal\n'.repeat(count));
    const response = await handler({ name: 'relay_workspace', arguments: { action: 'search', path: file, query: 'needle|literal', limit: 2 } });
    assert.equal(response.success, true, response.contentItems[0].text);
    const found = JSON.parse(response.contentItems[0].text);
    assert.equal(found.engine, 'rg'); assert.equal(found.matchMode, 'literal'); assert.equal(found.query, 'needle|literal');
    assert.equal(found.output.split('\n').length, 2); assert.equal(found.truncated, count > 2);
  }
});

test('browser coordinate, ref-upload and prompt decisions reject missing observed guards before dispatch', async t => {
  const calls = [], driver = { status: () => ({ available: true, contained: true, activeTab: 'owned-tab', tabs: [{ tabId: 'owned-tab' }] }), perform: async args => { calls.push(args); return { receipt: { completed: true } }; } };
  const browser = new BrowserWorkspace({ driver }); t.after(() => browser.close());
  const guard = { browser: 'relay', tabId: 'owned-tab', expectedDocumentId: 'owned-tab:1', expectedUrl: 'https://example.invalid/form' };
  for (const action of ['click', 'hover']) {
    const valid = { ...guard, action, x: 12, y: 24 };
    for (const override of [{ expectedDocumentId: undefined }, { expectedUrl: undefined }, { x: NaN }, { y: Infinity }]) await assert.rejects(browser.perform({ ...valid, ...override }), { code: 'BROWSER_VALIDATION' });
    assert.equal(calls.length, action === 'click' ? 0 : 1); await browser.perform(valid);
  }
  const upload = { ...guard, action: 'upload', ref: 'observed-file-input', paths: [path.join(tmpdir(), 'inert-fixture.pdf')] };
  for (const override of [{ expectedDocumentId: undefined }, { expectedUrl: undefined }]) await assert.rejects(browser.perform({ ...upload, ...override }), { code: 'BROWSER_VALIDATION' });
  assert.equal(calls.length, 2); await browser.perform(upload);
  const prompt = { ...guard, action: 'interaction', interactionId: 'browser_input_11111111-1111-4111-8111-111111111111', promptText: 'Inert fixture response' };
  for (const decision of ['dismiss', 'acknowledge']) await assert.rejects(browser.perform({ ...prompt, decision }), { code: 'BROWSER_VALIDATION' });
  assert.equal(calls.length, 3); await browser.perform({ ...prompt, decision: 'accept' }); assert.equal(calls.length, 4);
});

test('wait rejects input-only guards with actionable recovery and dispatches without them', async t => {
  const calls = [], driver = { status: () => ({ available: true, contained: true, activeTab: 'owned-tab', tabs: [{ tabId: 'owned-tab' }] }), perform: async args => { calls.push(args); return { matched: args.query }; } };
  const browser = new BrowserWorkspace({ driver }); t.after(() => browser.close());
  const wait = { action: 'wait', browser: 'relay', tabId: 'owned-tab', query: 'Ready', timeoutMs: 10000 };
  for (const guards of [{ expectedUrl: 'https://example.invalid/form' }, { expectedUrl: 'https://example.invalid/form', expectedDocumentId: 'owned-tab:1' }]) {
    await assert.rejects(browser.perform({ ...wait, ...guards }), error => {
      assert.equal(error.code, 'BROWSER_VALIDATION');
      assert.match(error.message, /wait action does not accept expectedDocumentId or expectedUrl\. Omit both fields/);
      return true;
    });
  }
  assert.equal(calls.length, 0, 'Rejected calls must not dispatch.');
  assert.equal((await browser.perform(wait)).matched, 'Ready');
  assert.deepEqual(calls, [wait]);
  await assert.rejects(browser.perform({ ...wait, action: 'fill', ref: 'observed-field', text: 'Fixture', expectedUrl: 'https://example.invalid/form' }), /Page input requires the current observed document identity and URL/);
  assert.equal(calls.length, 1, 'Input actions still require a complete guard pair when supplied.');
});
