import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createLocalModelSettings} from '../public/next/workspaces/settings-local-models.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const until = async read => { for (let i = 0; i < 100; i++) { if (read()) return; await settle(); } throw Error('Local model settings did not settle.'); };
const deferred = () => { let resolve; return {promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value)}; };
const catalog = () => ({engines: [
  {id: 'ollama', name: 'Ollama', available: true, models: [{id: 'fixture-local:latest', displayName: 'Fixture local', loaded: false}]},
  {id: 'lmstudio', name: 'LM Studio', available: true, models: [{id: 'fixture-studio', displayName: 'Fixture studio', loaded: true, instanceIds: ['fixture-instance']}]},
]});
function fixture(t, hook) {
  const dom = planningDOM(t), calls = [], state = {catalog: catalog(), changed: 0};
  const api = async (route, method = 'GET', body) => {
    const call = {route, method, body}; calls.push(call);
    const result = hook?.(call, state); if (result !== undefined) return result;
    if (route === '/api/local-models' && method === 'GET') return structuredClone(state.catalog);
    if (method === 'POST' && ['/api/local-models/load', '/api/local-models/unload', '/api/local-models/import'].includes(route)) {
      const engine = state.catalog.engines.find(item => item.id === (body.engine || 'ollama'));
      let model = engine.models.find(item => item.id === body.model);
      if (route.endsWith('/import')) { model = {id: body.model, displayName: body.model}; engine.models.push(model); }
      assert.ok(model); model.loaded = !route.endsWith('/unload');
      return {model: model.id, selection: engine.id + '::' + model.id};
    }
    throw Error('Unexpected local model request ' + route);
  };
  const panel = createLocalModelSettings({mount: dom.mount, api, onChanged: () => { state.changed++; }});
  t.after(() => panel.destroy());
  return {...dom, panel, calls, state, writes: () => calls.filter(call => call.method !== 'GET'),
    async enter() { panel.enter(); await until(() => dom.$('#next-local-runtime-status').textContent.includes('is running')); }};
}

test('local model settings construct typed controls and exact runtime/model options without mutating on entry', async t => {
  const f = fixture(t);
  assert.deepEqual(f.calls, []);
  for (const id of ['refresh', 'load', 'unload', 'import']) assert.equal(f.$('#next-local-' + id).type, 'button');
  assert.equal(f.$('#next-local-context').type, 'number');
  assert.equal(f.$('#next-local-source-path').type, 'text');
  assert.deepEqual(f.$('#next-local-engine').children.map(item => item.getAttribute('value')), ['ollama', 'lmstudio']);
  assert.equal(f.$('#next-local-engine').value, 'ollama');
  await f.enter(); f.panel.enter(); await settle();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.writes(), []);
  assert.equal(f.$('#next-local-model').value, 'fixture-local:latest');
  assert.equal(f.$('#next-local-model').children[0].getAttribute('value'), 'fixture-local:latest');
  assert.equal(f.$('#next-local-load').disabled, false); assert.equal(f.$('#next-local-unload').disabled, true);
  const runtime = f.$('#next-local-engine'); runtime.value = 'lmstudio'; await runtime.dispatch('change');
  assert.equal(f.$('#next-local-model').value, 'fixture-studio');
  assert.equal(f.$('#next-local-unload').disabled, false); assert.deepEqual(f.writes(), []);
});

test('a pending local load captures exact model/context and suppresses duplicate writes', async t => {
  const gate = deferred();
  const f = fixture(t, (call, state) => {
    if (call.route === '/api/local-models/load') return gate.promise.then(() => {
      state.catalog.engines[0].models[0].loaded = true;
      return {model: call.body.model, selection: 'ollama::' + call.body.model};
    });
  });
  await f.enter(); await f.input('#next-local-context', '8192');
  await f.click('#next-local-load'); await f.click('#next-local-load');
  assert.deepEqual(f.writes().map(call => call.body), [{engine: 'ollama', model: 'fixture-local:latest', contextLength: 8192}]);
  for (const id of ['refresh', 'load', 'unload', 'import', 'engine', 'model', 'context', 'source-path', 'import-name']) assert.equal(f.$('#next-local-' + id).disabled, true);
  gate.resolve(); await until(() => !f.$('#next-local-load').disabled);
  assert.equal(f.state.changed, 1); assert.equal(f.$('#next-local-unload').disabled, false);
  assert.match(f.$('#next-local-feedback').textContent, /Loaded fixture-local:latest/);
  assert.equal(f.calls.filter(call => call.route === '/api/local-models').length, 2);
});

test('invalid local context never writes and unload preserves files/defaults while using the runtime instance', async t => {
  const f = fixture(t); await f.enter();
  for (const value of ['127', '262145', '128.5', 'not-a-number']) {
    await f.input('#next-local-context', value); await f.click('#next-local-load');
    assert.match(f.$('#next-local-feedback').textContent, /Context length must be from 128 through 262144/);
    assert.deepEqual(f.writes(), []);
  }
  const runtime = f.$('#next-local-engine'); runtime.value = 'lmstudio'; await runtime.dispatch('change');
  await f.click('#next-local-unload'); await until(() => !f.$('#next-local-refresh').disabled);
  assert.deepEqual(f.writes(), [{route: '/api/local-models/unload', method: 'POST', body: {engine: 'lmstudio', model: 'fixture-studio', instanceId: 'fixture-instance'}}]);
  assert.equal(f.state.changed, 0); assert.match(f.$('#next-local-feedback').textContent, /Model files and saved conversations are unchanged/);
  assert.equal(f.state.catalog.engines[1].models.length, 1); assert.equal(f.$('#next-local-unload').disabled, true);
});

test('local import validates the path/name, refreshes the catalog and selects the imported model', async t => {
  const f = fixture(t); await f.enter();
  await f.click('#next-local-import'); assert.deepEqual(f.writes(), []);
  assert.match(f.$('#next-local-feedback').textContent, /Provide an absolute model path and a local model name/);
  await f.input('#next-local-source-path', ' C:\\synthetic-models\\fixture.gguf ');
  await f.input('#next-local-import-name', ' fixture-import ');
  await f.click('#next-local-import'); await until(() => !f.$('#next-local-import').disabled);
  assert.deepEqual(f.writes(), [{route: '/api/local-models/import', method: 'POST', body: {sourcePath: 'C:\\synthetic-models\\fixture.gguf', model: 'fixture-import'}}]);
  assert.equal(f.state.changed, 1); assert.equal(f.$('#next-local-engine').value, 'ollama');
  assert.equal(f.$('#next-local-model').value, 'fixture-import'); assert.equal(f.$('#next-local-unload').disabled, false);
});

test('a late local catalog read cannot overwrite a newer entry or repaint a destroyed panel', async t => {
  const first = deferred(), last = deferred(); let reads = 0;
  const f = fixture(t, call => {
    if (call.route !== '/api/local-models') return;
    reads++; if (reads === 1) return first.promise; if (reads === 3) return last.promise;
  });
  f.panel.enter(); f.panel.leave(); await f.enter();
  first.resolve({engines: [{id: 'ollama', name: 'Stale runtime', available: false, models: []}]});
  await settle(); assert.match(f.$('#next-local-runtime-status').textContent, /^Ollama is running/);
  f.panel.leave(); f.panel.enter();
  const card = f.mount.children[0], status = f.$('#next-local-runtime-status'), previous = status.textContent;
  f.panel.destroy(); assert.equal(card.parentElement, null); assert.equal(card.isConnected === true, false);
  last.resolve({engines: [{id: 'ollama', name: 'Destroyed runtime', available: false, models: []}]});
  await settle(); assert.equal(status.textContent, previous); assert.equal(f.mount.children.length, 0); assert.deepEqual(f.writes(), []);
});

test('shared DOM replacement detaches old children and reparents replacements without per-test shims', t => {
  const f = planningDOM(t), old = f.element('section'), replacement = f.element('section');
  f.mount.append(old); old.textContent = 'old content';
  f.mount.replaceChildren(replacement);
  assert.equal(old.parentElement, null); assert.equal(old.isConnected === true, false);
  assert.equal(replacement.parentElement, f.mount); assert.equal(replacement.isConnected, true);
  assert.deepEqual(f.mount.children, [replacement]); assert.equal(f.mount.textContent, '');
  f.mount.replaceChildren(); assert.equal(replacement.parentElement, null); assert.equal(f.mount.children.length, 0);
});

test('shared select replacement resets removed selections and preserves a reused selected option', t => {
  const f = planningDOM(t), select = f.element('select');
  const option = value => { const node = f.element('option'); node.setAttribute('value', value); return node; };
  const first = option('first'), second = option('second'); select.append(first, second); select.value = 'second';
  select.replaceChildren(second, first); assert.equal(select.value, 'second');
  const replacement = option('replacement'); select.replaceChildren(replacement);
  assert.equal(select.value, 'replacement'); assert.equal(first.parentElement, null); assert.equal(second.parentElement, null);
  select.replaceChildren(); assert.equal(select.value, ''); assert.equal(replacement.parentElement, null);
});
