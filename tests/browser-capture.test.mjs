import test from 'node:test';
import assert from 'node:assert/strict';
import { captureHiddenPage } from '../desktop/browser-capture.mjs';

const image = { isEmpty: () => false, getSize: () => ({ width: 1280, height: 900 }) };
const fake = fn => { let calls = 0; return { isDestroyed: () => false, capturePage: (...args) => { calls++; return fn(calls, args); }, get calls() { return calls; } }; };

test('hidden capture retries a transient Viz failure without changing hidden capture options', async () => {
  const contents = fake((call, args) => { assert.deepEqual(args, [undefined, { stayHidden: true }]); if (call === 1) throw new Error('UnknownVizError'); return image; });
  const result = await captureHiddenPage(contents, { retryDelays: [0, 0] }); assert.equal(result.image, image); assert.equal(result.retries, 1); assert.equal(contents.calls, 2);
});
test('empty frames and readiness errors have a finite three-attempt budget', async () => {
  const contents = fake(call => { if (call === 1) return { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }; if (call === 2) throw new Error('Current display surface not available for capture'); return image; });
  assert.equal((await captureHiddenPage(contents, { retryDelays: [0, 0] })).retries, 2);
  const broken = fake(() => { throw new Error('UnknownVizError'); }); await assert.rejects(captureHiddenPage(broken, { retryDelays: [0, 0] }), { code: 'BROWSER_CAPTURE_UNAVAILABLE' }); assert.equal(broken.calls, 3);
});
test('unrelated failures and stale-page validation are never retried', async () => {
  const original = new Error('Renderer process crashed.'), contents = fake(() => { throw original; }); await assert.rejects(captureHiddenPage(contents), error => error === original); assert.equal(contents.calls, 1);
  let navigated = false; const changed = fake(() => { navigated = true; throw new Error('UnknownVizError'); }); await assert.rejects(captureHiddenPage(changed, { assertCurrent: () => { if (navigated) throw new Error('Take a fresh snapshot.'); } }), /fresh snapshot/); assert.equal(changed.calls, 1);
});
test('cancellation during capture or retry wait stops promptly without another attempt', async () => {
  const controller = new AbortController(), pending = fake(() => new Promise(() => {})), captured = captureHiddenPage(pending, { signal: controller.signal }); controller.abort(); await assert.rejects(captured, { name: 'AbortError', code: 'ABORT_ERR' }); assert.equal(pending.calls, 1);
  const waiting = new AbortController(), transient = fake(() => { setTimeout(() => waiting.abort(), 5); throw new Error('UnknownVizError'); }); await assert.rejects(captureHiddenPage(transient, { signal: waiting.signal }), { name: 'AbortError' }); assert.equal(transient.calls, 1);
});
test('a closed page cannot capture and a hung renderer respects the overall deadline', async () => {
  const contents = fake(() => image); contents.isDestroyed = () => true; await assert.rejects(captureHiddenPage(contents), { code: 'BROWSER_CLOSED' }); assert.equal(contents.calls, 0);
  const hung = fake(() => new Promise(() => {})), start = Date.now(); await assert.rejects(captureHiddenPage(hung, { timeoutMs: 25 }), { code: 'BROWSER_CAPTURE_TIMEOUT' }); assert.equal(hung.calls, 1); assert.ok(Date.now() - start < 1000);
});
