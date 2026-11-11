import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDOM } from './fixture-planning-dom.mjs';
import { createNativeModelSettings } from '../public/next/workspaces/settings-native-models.mjs';
import { createSubscriptionModelSettings } from '../public/next/workspaces/settings-subscriptions.mjs';

const sessionId = 'native_' + 'e'.repeat(32);
const settle = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await settle();
  }
  throw Error('Native model settings did not settle.');
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(t, { generateResponse } = {}) {
  const dom = planningDOM(t), calls = [];
  dom.mount.replaceChildren = function (...nodes) {
    for (const child of [...this.children]) child.remove();
    this.textContent = '';
    this.append(...nodes);
  };
  const state = {
    engines: [
      { id: 'blackice', available: true, implementation: 'Owned reference' },
      { id: 'llama.cpp', available: false, implementation: 'Binary missing' },
    ],
    sessions: [],
  };
  const api = async (route, method = 'GET', body, options) => {
    calls.push({ route, method, body, options });
    if (route === '/api/native-inference/status') return structuredClone(state);
    if (route === '/api/native-inference/load') {
      state.sessions.push({ id: sessionId, backend: body.backend, modelPath: body.modelPath, status: 'loaded' });
      return { id: sessionId, backend: body.backend, modelPath: body.modelPath };
    }
    if (route === '/api/native-inference/generate') {
      const current = state.sessions.find(session => session.id === body.id);
      current.status = 'running';
      try {
        return generateResponse ? await generateResponse({ body, state }) :
          { backend: 'blackice', completed: true, text: ' Answer', tokenIds: [21806], promptTokens: 1 };
      } finally { current.status = 'loaded'; }
    }
    if (route === '/api/native-inference/cancel') {
      state.sessions.find(session => session.id === body.id).status = 'loaded';
      return { id: body.id, cancellationRequested: true };
    }
    if (route === '/api/native-inference/unload') {
      state.sessions = state.sessions.filter(session => session.id !== body.id);
      return { id: body.id, unloaded: true };
    }
    throw Error('Unexpected API ' + method + ' ' + route);
  };
  const panel = createNativeModelSettings({ mount: dom.mount, api });
  t.after(() => panel.destroy());
  panel.enter();
  return { ...dom, panel, api, calls, state, writes: () => calls.filter(item => item.method !== 'GET') };
}
test('BLACKICE native panel exposes own engine and keeps llama.cpp clearly unavailable', async t => {
  const f = fixture(t);
  await until(() => f.$('#next-native-refresh').disabled === false && f.$('#next-native-engine').children.length === 2);
  assert.equal(f.$('#next-native-engine').value, 'blackice');
  assert.equal(f.$('#next-native-cpu-kernel').value, 'simd');
  assert.equal(f.$('#next-native-engine').children[1].disabled, true);
  assert.equal(f.$('#next-native-load').disabled, false);
  assert.equal(f.$('#next-native-generate').disabled, true);
  assert.equal(f.$('#next-native-cancel').disabled, true);
  assert.equal(f.writes().length, 0);
  assert.match(f.$('#next-native-inference').textContent, /without Ollama or LM Studio/);
});

test('native panel explicitly loads model, generates a response, then unloads without altering cloud providers', async t => {
  const f = fixture(t);
  await until(() => f.$('#next-native-engine').children.length === 2);
  await f.input('#next-native-model-path', 'C:\\Models\\Qwen3-FP16');
  await f.click('#next-native-load');
  await until(() => f.state.sessions.length === 1 && f.$('#next-native-load').disabled === false);
  assert.equal(f.writes()[0].route, '/api/native-inference/load');
  assert.deepEqual(f.writes()[0].body, { backend: 'blackice', modelPath: 'C:\\Models\\Qwen3-FP16', maxContext: 64, cpuKernel: 'simd' });
  assert.equal(f.$('#next-native-generate').disabled, false);
  await f.input('#next-native-input', 'Hello');
  await f.click('#next-native-generate');
  await until(() => f.$('#next-native-output').textContent === ' Answer');
  assert.equal(f.writes()[1].route, '/api/native-inference/generate');
  assert.equal(f.writes()[1].body.prompt, 'Hello');
  assert.equal(f.writes()[1].body.maxTokens, 1);
  assert.equal(f.writes()[1].options.deadlineMs, 600000);
  await f.click('#next-native-unload');
  await until(() => f.state.sessions.length === 0);
  assert.deepEqual(f.writes().map(item => item.route),
    ['/api/native-inference/load', '/api/native-inference/generate', '/api/native-inference/unload']);
  assert.equal(f.calls.some(item => item.route.startsWith('/api/providers')), false);
});

test('native panel requests cancellation while inference is active, without replaying generation', async t => {
  const pending = deferred();
  const f = fixture(t, { generateResponse: () => pending.promise });
  await until(() => f.$('#next-native-engine').children.length === 2);
  await f.input('#next-native-model-path', 'C:\\Models\\Qwen3-FP16');
  await f.click('#next-native-load');
  await until(() => f.state.sessions.length === 1 && f.$('#next-native-generate').disabled === false);
  await f.click('#next-native-generate');
  await until(() => f.state.sessions[0].status === 'running' && f.$('#next-native-cancel').disabled === false);
  await f.click('#next-native-cancel');
  await until(() => f.writes().some(item => item.route === '/api/native-inference/cancel'));
  pending.reject(Object.assign(new Error('Native generation cancelled.'), { code: 'ABORT_ERR' }));
  await until(() => f.$('#next-native-generate').disabled === false);
  assert.equal(f.writes().filter(item => item.route === '/api/native-inference/generate').length, 1);
  assert.match(f.$('#next-native-feedback').textContent, /cancelled/i);
});

test('native panel remains separate from native subscription status and saved API drafts', async t => {
  const dom = planningDOM(t);
  dom.mount.replaceChildren = function (...nodes) {
    for (const child of [...this.children]) child.remove();
    this.textContent = '';
    this.append(...nodes);
  };
  const api = async route => {
    if (route === '/api/status') return { codex: { connected: true, authenticated: true }, subscriptionProviders: [] };
    if (route === '/api/native-inference/status') return { engines: [{ id: 'blackice', available: true }], sessions: [] };
    if (route === '/api/local-models') return { engines: [] };
    throw Error('Unexpected API: ' + route);
  };
  const panel = createSubscriptionModelSettings({ mount: dom.mount, api }, ({ mount }) => {
    const draft = dom.element('input'); draft.id = 'draft-retained'; draft.value = 'My API settings';
    mount.append(draft);
    return { enter() {}, leave() {}, destroy() {} };
  });
  t.after(() => panel.destroy());
  panel.enter();
  await until(() => dom.$('#next-native-engine')?.children.length === 1);
  assert.equal(dom.$('#next-mistral-vibe')?.id, 'next-mistral-vibe');
  assert.equal(dom.$('#next-native-inference')?.id, 'next-native-inference');
  assert.equal(dom.$('#next-local-engine')?.id, 'next-local-engine');
  assert.equal(dom.$('#draft-retained')?.value, 'My API settings');
});
