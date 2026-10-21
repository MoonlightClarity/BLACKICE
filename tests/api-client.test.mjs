import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../public/api-client.mjs';

test('a stalled response body and an abort-ignoring fetch both return by the deadline', async () => {
  for (const fetcher of [async () => new Promise(() => {}), async () => ({ ok: true, json: () => new Promise(() => {}) })]) {
    const api = createApiClient({ fetcher, timeoutMs: 15 });
    await assert.rejects(api('/api/status'), error => error.code === 'API_TIMEOUT' && error.timedOut === true && error.uncertain === false && /Connection timed out/.test(error.message));
  }
});
test('ambiguous mutations are never replayed and say their outcome is unknown', async () => {
  let calls = 0;
  const api = createApiClient({ fetcher: async () => { calls++; throw new Error('Connection lost.'); } });
  await assert.rejects(api('/api/runs', 'POST', {}), error => error.uncertain && /may have completed/.test(error.message));
  assert.equal(calls, 1);
});
test('malformed success is an error and explicit server rejection is unambiguous', async () => {
  let api = createApiClient({ fetcher: async () => ({ ok: true, json: async () => { throw Error('invalid'); } }) });
  await assert.rejects(api('/api/runs', 'POST'), error => error.uncertain && /unreadable/.test(error.message));
  api = createApiClient({ fetcher: async () => ({ ok: false, status: 409, json: async () => ({ error: 'Already running.' }) }) });
  await assert.rejects(api('/api/runs', 'POST'), error => !error.uncertain && error.status === 409 && error.message === 'Already running.');
});

test('method/body and options requests normalize to the same JSON mutation without replay', async () => {
  const requests = [], payload = { action: 'open', url: 'https://example.test/' };
  const api = createApiClient({ fetcher: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ tabId: 'fixture' }) }; } });
  await api('/api/browser/action', 'post', payload);
  await api('/api/browser/action', { method: 'POST', body: payload, headers: { 'X-Fixture': 'options' } });
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.equal(url, '/api/browser/action'); assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), payload); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers.get('Content-Type'), 'application/json'); assert.equal(options.signal.aborted, false);
  }
  assert.equal(requests[1].options.headers.get('X-Fixture'), 'options');
  await api('/api/status', {});
  assert.equal(requests[2].options.method, 'GET'); assert.equal(requests[2].options.body, undefined);
});

test('options mutations preserve uncertainty and deadlines without making a second request', async () => {
  let requests = 0, signal;
  const api = createApiClient({ timeoutMs: 15, fetcher: async (_url, options) => { requests++; signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(api('/api/providers', { method: 'POST', body: { id: 'fixture' } }), error => error.uncertain && error.code === 'API_TIMEOUT' && error.timedOut === true && /may have completed/.test(error.message));
  assert.equal(requests, 1); assert.equal(signal.aborted, true);
});

test('unsupported method shapes fail before dispatch and optional cancellation reaches fetch', async () => {
  let requests = 0, activeSignal;
  const api = createApiClient({ fetcher: async (_url, options) => { requests++; activeSignal = options.signal; return { ok: true, json: async () => ({}) }; } });
  await assert.rejects(api('/api/runs', { method: {} }), /supported request method/);
  await assert.rejects(api('/api/runs', []), /supported request method/); assert.equal(requests, 0);
  const controller = new AbortController(); await api('/api/status', { signal: controller.signal }); controller.abort();
  assert.equal(activeSignal.aborted, true); assert.equal(requests, 1);
});

test('structured connector timeout and rejection codes survive the client without replaying a mutation', async () => {
  for (const failure of [{ status: 504, code: 'CHATGPT_BRIDGE_TIMEOUT', timedOut: true, message: 'Connector timed out while waiting for BLACKICE.' }, { status: 422, code: 'CHATGPT_BRIDGE_CHAT_MODE_REQUIRED', message: 'Stay in Chat Mode.' }]) {
    let calls = 0;
    const api = createApiClient({ fetcher: async () => { calls++; return { ok: false, status: failure.status, json: async () => ({ error: failure }) }; } });
    await assert.rejects(api('/api/chatgpt-bridge/requests/id/complete', 'POST', {}), error => error.code === failure.code && error.timedOut === failure.timedOut && error.status === failure.status && error.uncertain === (failure.status >= 500) && error.message.startsWith(failure.message));
    assert.equal(calls, 1);
  }
});

test('an explicit caller abort is not reported as a timeout', async () => {
  const controller = new AbortController(); let calls = 0;
  const api = createApiClient({ fetcher: async (_url, { signal }) => { calls++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Read cancelled.'), { name: 'AbortError' })), { once: true })); } });
  const request = api('/api/chatgpt-bridge', { signal: controller.signal }); controller.abort();
  await assert.rejects(request, error => error.code !== 'API_TIMEOUT' && error.timedOut !== true && error.uncertain === false && /Read cancelled/.test(error.message));
  assert.equal(calls, 1);
});

test('a bounded per-request deadline can cover a native check without changing ordinary deadlines or replaying it', async () => {
  const calls = [], api = createApiClient({ timeoutMs: 10, fetcher: async (url, options) => {
    calls.push({ url, options }); await new Promise(resolve => setTimeout(resolve, 25)); return { ok: true, json: async () => ({ completed: true }) };
  } });
  assert.deepEqual(await api('/api/codex/models/check', { method: 'POST', body: { model: 'fixture' }, timeoutMs: 100 }), { completed: true });
  await assert.rejects(api('/api/status'), error => error.code === 'API_TIMEOUT');
  for (const timeoutMs of [0, -1, Infinity, '50000', 60001]) await assert.rejects(api('/api/codex/models/check', { method: 'POST', timeoutMs }), /deadline/);
  assert.equal(calls.length, 2); assert.equal(calls[0].options.method, 'POST'); assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'fixture' });
});
