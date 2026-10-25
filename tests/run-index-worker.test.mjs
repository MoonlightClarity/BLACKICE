import test from 'node:test';
import assert from 'node:assert/strict';

test('web worker fetches and parses original full runs off the renderer thread, posting only the compact index', async t => {
  const previousSelf = globalThis.self, previousFetch = globalThis.fetch;
  const results = [], sent = [];
  globalThis.self = { postMessage: message => results.push(message) };
  globalThis.fetch = async (url, options) => {
    sent.push({ url, options });
    return { ok: true, json: async () => [{
      id: 'only-run', status: 'completed', nodes: { a: { output: 'Visible answer' } },
      events: Array.from({ length: 5000 }, (_, i) => ({ type: 'tool.result', data: { i, output: 'x'.repeat(100) } })),
    }] };
  };
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf;
    globalThis.fetch = previousFetch; });
  await import('../public/run-index-worker.mjs?run-worker-test');
  await globalThis.self.onmessage({ data: { type: 'fetch', id: 42 } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/runs');
  assert.equal(sent[0].options.credentials, 'same-origin');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 42);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].runs[0].id, 'only-run');
  assert.equal(results[0].runs[0].nodes.a.output, 'Visible answer');
  assert.equal(results[0].runs[0].events.length, 0);
});
