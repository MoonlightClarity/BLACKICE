import test from 'node:test';
import assert from 'node:assert/strict';
import { providerModelsForSave, mergeDiscoveredProviderModels, createProviderModelSelection, connectionDefaultModels, providerHeadersForSave, renderProviderModelRows, renderCodexModelRows, renderCodexCheckDetails, codexCheckReceipt, openConnections } from '../public/connections-ui.mjs';
import { codexModelAccessLabel, codexModelAccessDetails, codexModelSourceLabel } from '../public/connection-models.mjs';
import { PROVIDER_PRESETS } from '../public/provider-catalog.mjs';

const reported = { id: 'large-model', displayName: 'Large model', contextWindowTokens: 1000000, contextWindowSource: 'provider-reported' };
const configured = { id: 'local-model', displayName: 'Local model', contextWindowTokens: 900000, contextWindowSource: 'user-configured' };

test('editing model IDs keeps reported capacity, label and provenance when advanced lines are omitted', () => {
  assert.deepEqual(providerModelsForSave('large-model\nnew-model', '', [reported]), [reported, { id: 'new-model', displayName: 'new-model' }]);
});
test('an unchanged visible capacity retains provider source; a changed capacity records user configuration', () => {
  assert.deepEqual(providerModelsForSave('large-model', 'large-model = 1,000,000', [reported]), [reported]);
  assert.deepEqual(providerModelsForSave('large-model', 'large-model = 900000', [reported]), [{ ...reported, contextWindowTokens: 900000, contextWindowSource: 'user-configured' }]);
});
test('unknown clears explicitly while untouched model capacities remain intact', () => {
  assert.deepEqual(providerModelsForSave('large-model\nlocal-model', 'large-model = unknown', [reported, configured]), [{ id: reported.id, displayName: reported.displayName }, configured]);
});
test('removing a model from the simple list removes its metadata without requiring hidden capacity edits', () => {
  assert.deepEqual(providerModelsForSave('local-model', 'large-model = 1000000\nlocal-model = 900000', [reported, configured]), [configured]);
});
test('discovery captures real reported metadata, preserves manual overrides, and keeps metadata omitted by a provider', () => {
  assert.deepEqual(mergeDiscoveredProviderModels([configured, reported], [{ id: 'local-model', contextWindowTokens: 1000000, contextWindowSource: 'provider-reported' }, { id: 'large-model' }, { id: 'new', contextWindowTokens: 200000, contextWindowSource: 'provider-reported' }]), [configured, reported, { id: 'new', contextWindowTokens: 200000, contextWindowSource: 'provider-reported' }]);
});
test('capacity validation catches wrong IDs, duplicates and invalid limits without silently dropping entries', () => {
  assert.throws(() => providerModelsForSave('large-model', 'other = 900000'), /missing from the model IDs/);
  assert.throws(() => providerModelsForSave('large-model', 'large-model = 900000\nlarge-model = 900000'), /one capacity/);
  for (const value of ['1', '4000001', 'NaN', '900000.5', '-900000']) assert.throws(() => providerModelsForSave('large-model', `large-model = ${value}`), /whole token count/);
  assert.throws(() => providerModelsForSave('large-model', '900000'), /Capacity line 1/);
});

test('named provider choices have distinct real endpoints and cloud key requirements', () => {
  const presets = Object.fromEntries(PROVIDER_PRESETS.map(preset => [preset.id, preset]));
  assert.equal(presets.openrouter.name, 'OpenRouter'); assert.equal(presets.openrouter.baseUrl, 'https://openrouter.ai/api/v1'); assert.equal(presets.openrouter.requiresApiKey, true);
  assert.equal(presets.openai.baseUrl, 'https://api.openai.com/v1'); assert.equal(presets.anthropic.type, 'anthropic');
  assert.equal(presets.ollama.baseUrl, 'http://127.0.0.1:11434/v1'); assert.equal(presets.lmstudio.baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(presets.ollama.requiresApiKey, false); assert.equal(presets.compatible.baseUrl, '');
});

test('catalog selection reaches models beyond the first 200 and pins them across page searches', () => {
  const selection = createProviderModelSelection([configured]);
  selection.setPage(Array.from({ length: 100 }, (_, index) => ({ id: `model-${index}`, displayName: `Model ${index}` })));
  selection.toggle('model-50', true);
  selection.setPage(Array.from({ length: 100 }, (_, index) => ({ id: `model-${index + 700}`, displayName: `Model ${index + 700}`, contextWindowTokens: 1000000, contextWindowSource: 'provider-reported' })));
  selection.toggle('model-750', true); selection.setPage([{ id: 'search-result', displayName: 'Search result' }]);
  assert.deepEqual(selection.selected().map(model => model.id), ['local-model', 'model-50', 'model-750']);
  const saved = selection.forSave(); assert.equal(saved[2].contextWindowTokens, 1000000); assert.equal(saved[2].contextWindowSource, 'provider-reported'); assert.equal(saved[2].displayName, 'Model 750');
  assert.deepEqual(selection.page().map(model => model.id), ['search-result']);
});

test('selection limits and failed manual additions preserve the current 200 choices', () => {
  const selection = createProviderModelSelection(Array.from({ length: 200 }, (_, index) => ({ id: `chosen-${index}` })));
  selection.setPage([{ id: 'another', displayName: 'Another' }]);
  assert.throws(() => selection.toggle('another', true), /up to 200/); assert.throws(() => selection.addManual('manual-model'), /up to 200/);
  assert.equal(selection.selected().length, 200); assert.equal(selection.page()[0].selected, false);
  selection.toggle('chosen-0', false); selection.toggle('another', true); assert.equal(selection.selected().length, 200);
});

test('catalog updates retain user context overrides and omitted metadata on selected models', () => {
  const selection = createProviderModelSelection([configured, reported]);
  selection.setPage([{ id: configured.id, contextWindowTokens: 1000000, contextWindowSource: 'provider-reported' }, { id: reported.id }]);
  assert.deepEqual(selection.forSave(), [configured, reported]);
  selection.toggle(configured.id, false); selection.setPage([{ id: 'other-page' }]);
  assert.deepEqual(selection.forSave('local-model = 900000'), [reported], 'removing a saved model also removes its hidden old capacity after paging');
  selection.setPage([{ id: 'capable', displayName: 'Capable model', supportsTools: true, maxOutputTokens: 8000, inputModalities: ['text', 'image'], outputModalities: ['text'] }]); selection.toggle('capable', true);
  const capable = selection.forSave().find(model => model.id === 'capable'); assert.equal(capable.supportsTools, true); assert.deepEqual(capable.inputModalities, ['text', 'image']); assert.equal(capable.maxOutputTokens, 8000);
});

test('model labels and context metadata render as escaped readable checkbox rows', () => {
  const html = renderProviderModelRows([{ id: 'vendor/model<id>', displayName: 'Readable <script>', contextWindowTokens: 900000, supportsTools: true, selected: true }]);
  assert.match(html, /type="checkbox"/); assert.match(html, / checked/); assert.match(html, /900,000 context/); assert.match(html, /Tools/);
  assert.match(html, /Readable &lt;script&gt;/); assert.doesNotMatch(html, /<script>|<textarea/);
});

test('application default offers available configured and Codex models while preserving an unavailable explicit choice', () => {
  const models = connectionDefaultModels({ codex: { connected: true, authenticated: true }, defaultModelSelection: 'offline::kept', models: [{ id: 'codex-model', displayName: 'Codex model' }, { id: 'cloud::model', displayName: 'Cloud model', available: true }, { id: 'disabled::model', available: false }] });
  assert.deepEqual(models.map(model => model.value), ['default', 'codex', 'codex-model', 'cloud::model', 'offline::kept']);
  assert.match(models.at(-1).label, /unavailable/);
  assert.deepEqual(connectionDefaultModels({ codex: { connected: false }, models: [{ id: 'offline-native' }] }).map(model => model.value), ['default']);
});

test('native defaults retain canonical aliases and selectable hidden labels without duplicate or unavailable choices', () => {
  const status = { codex: { connected: true, authenticated: true }, defaultModelSelection: 'wire-hidden', models: [{ id: 'picker-hidden', model: 'wire-hidden', displayName: 'Hidden model', hidden: true }, { id: 'visible', displayName: 'Visible model', hidden: false }] };
  const models = connectionDefaultModels(status);
  assert.deepEqual(models.map(model => model.value), ['default', 'codex', 'wire-hidden', 'visible']);
  assert.equal(models[2].label, 'Hidden model · Hidden by Codex'); assert.doesNotMatch(models[2].label, /unavailable/);
  status.defaultModelSelection = 'picker-hidden';
  assert.equal(connectionDefaultModels(status)[2].value, 'picker-hidden', 'stored aliases are preserved without being rewritten');
});

test('native catalog details distinguish advertisement, hidden visibility and observed access with no row cap or unsafe markup', () => {
  const entries = Array.from({ length: 252 }, (_, index) => ({ id: `native-${index}`, displayName: `Native ${index}`, source: 'advertised', hidden: index % 2 === 0, access: { state: 'unverified' } }));
  entries.push({ id: 'Vendor/Custom:preview', model: 'Vendor/Custom:preview', source: 'custom', displayName: '<script>literal name</script>', access: { state: 'failed', outcome: 'interrupted' }, serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Reported speed only.' }], availableAccessPrograms: { cyber: ['standard'] }, upgradeInfo: { migrationMarkdown: '<b>Literal migration notice</b>' } });
  const html = renderCodexModelRows(entries, { customModels: ['Vendor/Custom:preview'] });
  assert.equal((html.match(/data-codex-model=/g) || []).length, 253); assert.equal((html.match(/data-codex-remove=/g) || []).length, 1);
  assert.match(html, /Advertised by Codex/); assert.match(html, /Hidden by Codex/); assert.match(html, /Custom model ID/); assert.match(html, /<details class="connection-model-observation"><summary>Last request interrupted<\/summary>/); assert.doesNotMatch(html, /unverified|untested/i); assert.equal((html.match(/class="connection-model-observation"/g) || []).length, 1, 'catalog membership alone creates no result row');
  assert.match(html, /Reported speed tiers/); assert.match(html, /Reported access programs/); assert.match(html, /not selected here/);
  assert.match(html, /&lt;script&gt;literal name/); assert.match(html, /&lt;b&gt;Literal migration/); assert.doesNotMatch(html, /<script>|<b>/);
  assert.equal(codexModelAccessLabel({ access: { state: 'accepted' } }), 'Last request completed');
  assert.equal(codexModelAccessLabel({ available: true, hidden: true, availabilityNux: { message: 'Available.' } }), '');
  assert.equal(codexModelSourceLabel({ source: 'custom' }), 'Custom model ID');
});

test('model details distinguish timed and interrupted requests and never invent an observation time or account scope', () => {
  assert.equal(codexModelAccessDetails({ access: { state: 'unverified', checkedAt: '2026-10-18T01:00:00Z' }, available: true }), null);
  const unknown = codexModelAccessDetails({ access: { state: 'accepted', checkedAt: 'not-a-date' } });
  assert.deepEqual(unknown.entries, [['Observed', 'Time not recorded'], ['Scope', 'Account and connection not recorded']]);
  const expired = codexModelAccessDetails({ access: { state: 'failed', outcome: 'interrupted', scope: 'expired-connection', errorCode: 'CODEX_MODEL_CHECK_TIMEOUT', checkedAt: '2026-10-18T02:00:00+01:00', lastSuccessAt: '2026-10-18T00:00:00Z' } });
  assert.equal(expired.label, 'Last request timed out'); assert.deepEqual(expired.entries, [['Observed', '2026-10-18 01:00:00.000 UTC'], ['Scope', 'Earlier Codex account or connection'], ['Result code', 'CODEX_MODEL_CHECK_TIMEOUT'], ['Earlier completed request', '2026-10-18 00:00:00.000 UTC']]);
  assert.equal(codexModelAccessLabel({ access: { state: 'failed', outcome: 'interrupted', errorCode: 'CODEX_DISCONNECTED' } }), 'Last request interrupted');
  assert.equal(codexModelAccessLabel({ access: { state: 'failed', outcome: 'failed', errorCode: 'MODEL_NOT_FOUND' } }), 'Last request failed');
});

test('a concrete model test exposes exact requested and reported IDs, timestamp, scope and escaped endpoint errors in details', () => {
  const result = { model: 'Exact/<candidate>:ID', requestedModel: 'Exact/<candidate>:ID', effectiveModel: null, status: 'failed', startedAt: '2026-10-18T01:00:00Z', checkedAt: '2026-10-18T01:00:01Z', scope: 'current-connection', error: { code: 'MODEL_NOT_FOUND', message: 'Endpoint rejected <candidate> for this account.' } };
  const html = renderCodexCheckDetails(result);
  assert.match(html, /<summary>Last request failed<\/summary>/); assert.match(html, /Requested model ID<\/dt><dd>Exact\/&lt;candidate&gt;:ID/); assert.match(html, /Reported model ID<\/dt><dd>Not reported/);
  assert.match(html, /2026-10-18 01:00:01\.000 UTC/); assert.match(html, /Current Codex account and connection/); assert.match(html, /MODEL_NOT_FOUND/); assert.match(html, /Endpoint rejected &lt;candidate&gt; for this account\./); assert.doesNotMatch(html, /<candidate>|access verified|guaranteed|untested/i);
  assert.equal(codexCheckReceipt(result), 'Exact/<candidate>:ID: test request failed.');
  assert.equal(codexCheckReceipt({ ...result, status: 'interrupted', error: { code: 'CODEX_MODEL_CHECK_TIMEOUT' } }), 'Exact/<candidate>:ID: test request timed out.');
  assert.equal(renderCodexCheckDetails({ status: 'checking' }), '');
});

test('custom request headers are an explicit write-only replacement with unambiguous preservation and clearing', () => {
  assert.equal(providerHeadersForSave(''), undefined); assert.deepEqual(providerHeadersForSave('', true), {});
  assert.deepEqual(providerHeadersForSave('x-api-key: fixture-secret\napi-version: 2026-01-01\nx-tenant: https://tenant.example.test/'), { 'x-api-key': 'fixture-secret', 'api-version': '2026-01-01', 'x-tenant': 'https://tenant.example.test/' });
  assert.throws(() => providerHeadersForSave('x-api-key: private', true), /replacement headers or remove/);
  assert.throws(() => providerHeadersForSave('X-Key: private\nx-key: secret'), /each header name once/);
  assert.throws(() => providerHeadersForSave('bad header: private'), error => !error.message.includes('private') && /line 1/.test(error.message));
});

// A small event surface exercises the production form handlers without a DOM
// dependency or a real provider request. It deliberately models disabled fields
// retaining values, as native HTML forms do.
function connectionDocument(t) {
  const before = globalThis.document, nodes = new Map(); let mounted = true, markup = '', form;
  const decode = value => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
  const attribute = (tag, key) => decode(tag.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1] || '');
  const make = () => {
    const attrs = new Map(), node = { textContent: '', value: '', checked: false, hidden: false, disabled: false, dataset: {}, classList: { add() {} }, setAttribute(key, value) { attrs.set(key, String(value)); }, getAttribute(key) { return attrs.get(key); }, removeAttribute(key) { attrs.delete(key); }, focus() { this.focused = true; globalThis.document.activeElement = this; }, click() { return this.onclick?.(); } };
    Object.defineProperty(node, 'innerHTML', { configurable: true, get() { return this.markup || ''; }, set(value) { this.markup = value; for (const match of value.matchAll(/\bid="([^"]+)"/g)) if (!nodes.has(`#${match[1]}`)) nodes.set(`#${match[1]}`, make()); } }); return node;
  };
  const allMarkup = () => markup + [...nodes.values()].map(node => node.innerHTML || '').join('');
  const buttons = (name, key) => [...markup.matchAll(new RegExp(`<button[^>]*data-${name}="([^"]+)"[^>]*>`, 'g'))].map(match => { const button = make(); button.dataset[key] = decode(match[1]); button.disabled = /\sdisabled\b/.test(match[0]); return button; });
  let providerButtons = [], editButtons = [], modelInputs = [], codexRemoveButtons = [], codexCheckButtons = [], codexCandidateButtons = [], codexRows = [];
  const view = make(); Object.defineProperty(view, 'innerHTML', { get: () => markup, set(value) {
    markup = value; nodes.clear(); nodes.set('#connections-view', view); form = value.includes('id="connection-form"') ? make() : null;
    for (const match of value.matchAll(/<(input|select|textarea|button|div|p|span|details|section)[^>]*\bid="([^"]+)"[^>]*>/g)) { const node = make(); node.tagName = match[1].toUpperCase(); node.value = attribute(match[0], 'value'); node.disabled = /\sdisabled\b/.test(match[0]); node.hidden = /\shidden\b/.test(match[0]); node.open = /\sopen\b/.test(match[0]); nodes.set(`#${match[2]}`, node); }
    if (form) {
      form.elements = {};
      for (const match of value.matchAll(/<(input|textarea|select)[^>]*\bname="([^"]+)"[^>]*>/g)) {
        const node = nodes.get(`#${attribute(match[0], 'id')}`) || make(); node.value = attribute(match[0], 'value'); node.checked = /\schecked\b/.test(match[0]);
        if (match[1] === 'textarea') node.value = decode(value.slice(match.index + match[0].length).split('</textarea>')[0]);
        if (match[1] === 'select') { const options = value.slice(match.index + match[0].length).split('</select>')[0]; node.value = attribute(options.match(/<option[^>]* selected[^>]*>/)?.[0] || options.match(/<option[^>]*>/)?.[0] || '', 'value'); }
        form.elements[match[2]] = node;
      }
      form.reportValidity = () => true; form.querySelectorAll = () => [...new Set([...nodes.values(), ...Object.values(form.elements)])].filter(node => node !== view); nodes.set('#connection-form', form);
    }
    providerButtons = buttons('connection-new', 'connectionNew'); editButtons = buttons('connection-edit', 'connectionEdit'); codexRemoveButtons = buttons('codex-remove', 'codexRemove');
    codexCheckButtons = buttons('codex-check', 'codexCheck'); codexCandidateButtons = buttons('codex-candidate-add', 'codexCandidateAdd');
    const tools = nodes.get('#connection-codex-tools'), details = nodes.get('#connection-codex-details');
    if (tools) { tools.parentElement = details; for (const id of ['connection-codex-id', 'connection-codex-read-status']) { const field = nodes.get(`#${id}`); if (field) field.parentElement = tools; } }
    codexRows = [...value.matchAll(/<article[^>]*data-codex-model="([^"]+)"[^>]*>/g)].map(match => { const row = make(), summary = make(); row.dataset.codexModel = decode(match[1]); row.querySelector = selector => selector === 'summary' ? summary : null; summary.parentElement = row; return row; });
  } });
  view.querySelectorAll = selector => {
    if (selector === '[data-connection-new]') return providerButtons;
    if (selector === '[data-connection-edit]') return editButtons;
    if (selector === '[data-codex-remove]') return codexRemoveButtons;
    if (selector === '[data-codex-check]') return codexCheckButtons;
    if (selector === '[data-codex-candidate-add]') return codexCandidateButtons;
    if (selector === '[data-codex-model]') return codexRows;
    if (selector === '[data-model-id]') {
      modelInputs = [...allMarkup().matchAll(/<input[^>]*data-model-id="([^"]+)"[^>]*>/g)].map(match => { const input = make(); input.dataset.modelId = decode(match[1]); input.checked = /\schecked\b/.test(match[0]); return input; }); return modelInputs;
    }
    return [];
  };
  nodes.set('#connections-view', view);
  const modal = make(), close = make(), outside = make(); modal.contains = node => node === modal || node === close || [...nodes.values()].includes(node);
  globalThis.document = { activeElement: outside, head: { append() {} }, createElement: make, getElementById: () => null,
    querySelector: selector => { if (!mounted) return null; if (selector === '#modal-root .modal') return modal; if (selector.startsWith('[data-') && markup.includes(selector.slice(1, -1))) { if (!nodes.has(selector)) nodes.set(selector, make()); return nodes.get(selector); } return nodes.get(selector) || null; } };
  t.after(() => { globalThis.document = before; });
  return { view, showModal() {}, close() { mounted = false; }, focusClose:()=>close.focus(), active:()=>globalThis.document.activeElement, closeControl:close, get: selector => nodes.get(selector), provider: id => providerButtons.find(button => button.dataset.connectionNew === id), edit: id => editButtons.find(button => button.dataset.connectionEdit === id), removeCodex: id => codexRemoveButtons.find(button => button.dataset.codexRemove === id), checkCodex: id => codexCheckButtons.find(button => button.dataset.codexCheck === id), addCandidate: id => codexCandidateButtons.find(button => button.dataset.codexCandidateAdd === id), model: id => modelInputs.find(input => input.dataset.modelId === id), nativeRows: () => codexRows, form: () => form };
}
const uiTurn = () => new Promise(resolve => setImmediate(resolve));
const heldRequest = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

const sparkCandidate = () => ({ id: 'gpt-5.3-codex-spark', model: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark', source: 'documented', lifecycle: { state: 'retired', date: '2026-09-14', note: 'OpenAI reports Spark retired from Codex.' }, provenance: { url: 'https://learn.chatgpt.com/docs/models', title: 'OpenAI model documentation', checkedAt: '2026-10-18' }, access: { state: 'unverified' } });
const candidateStatus = (candidate, modelCheck = null, custom = []) => ({ codex: { connected: true, authenticated: true, modelCheck, modelCheckBlocked: false }, defaultModelSelection: 'native-default', defaultModel: 'native-default', models: [{ id: 'native-default' }, { id: 'native-other' }, ...custom.map(id => ({ ...candidate, id, model: id, source: 'custom' }))], customCodexModels: custom, codexModelCandidates: [candidate] });

test('native model search filters the entire list locally and keeps model choices and custom drafts intact', async t => {
  const dom = connectionDocument(t), candidate = sparkCandidate(), reads = [], writes = [];
  const models = Array.from({ length: 251 }, (_, index) => ({ id: `native-${index}`, displayName: index === 250 ? 'Raisonnement élargi' : `Model ${index}` }));
  const api = async (url, method, body) => { if (method) { writes.push({ url, method, body }); return {}; } reads.push(url); return url === '/api/providers' ? [] : { ...candidateStatus(candidate), models }; };
  await openConnections({ api, ...dom });
  assert.equal(dom.nativeRows().length, 252); assert.equal(dom.get('#connection-codex-tools').open, false);
  const search = dom.get('#connection-codex-search'), draft = dom.get('#connection-codex-id'), choice = dom.get('#connection-default-model');
  draft.value = 'Keep/Exact:Draft'; draft.oninput(); choice.value = 'native-17'; choice.onchange();
  search.focus(); search.value = 'ELARGI'; search.oninput();
  assert.deepEqual(dom.nativeRows().filter(row => !row.hidden).map(row => row.dataset.codexModel), ['native-250']);
  assert.equal(dom.get('#connection-codex-empty').hidden, true); assert.equal(dom.get('#connection-codex-candidates').hidden, true); assert.equal(dom.active(), search);
  let prevented = false; search.onkeydown({ key: 'Enter', preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  search.onkeydown({ key: 'ArrowDown', preventDefault() {} }); assert.equal(dom.active(), dom.nativeRows().find(row => row.dataset.codexModel === 'native-250').querySelector('summary'));
  search.value = 'nothing matches'; search.oninput(); assert.equal(dom.nativeRows().every(row => row.hidden), true); assert.equal(dom.get('#connection-codex-empty').hidden, false);
  search.value = 'retired Spark'; search.oninput(); assert.deepEqual(dom.nativeRows().filter(row => !row.hidden).map(row => row.dataset.codexModel), [candidate.id]); assert.equal(dom.get('#connection-codex-candidates').hidden, false);
  assert.equal(draft.value, 'Keep/Exact:Draft'); assert.equal(choice.value, 'native-17'); assert.equal(dom.get('#connection-use-default').disabled, false);
  assert.deepEqual(reads.sort(), ['/api/providers', '/api/status']); assert.deepEqual(writes, [], 'filtering and disclosure navigation never register or test models');
});

test('documented candidates remain separate from advertised models and only an explicit bounded check changes evidence', async t => {
  const dom = connectionDocument(t), held = heldRequest(), calls = [], candidate = sparkCandidate(); let check = null;
  const api = async (url, options) => {
    if (url === '/api/status') return candidateStatus(candidate, check); if (url === '/api/providers') return [];
    calls.push({ url, options }); assert.equal(url, '/api/codex/models/check'); assert.equal(options.method, 'POST'); assert.deepEqual(options.body, { model: candidate.id }); assert.equal(options.timeoutMs, 50000);
    check = { model: candidate.id, status: 'checking', startedAt: '2026-10-18T01:00:00Z' }; await held.promise;
    candidate.access = { state: 'accepted', scope: 'current-connection', checkedAt: '2026-10-18T01:00:01Z' };
    check = { model: candidate.id, requestedModel: candidate.id, effectiveModel: candidate.id, status: 'accepted', scope: 'current-connection', checkedAt: candidate.access.checkedAt };
    return { result: check };
  };
  await openConnections({ api, ...dom }); assert.deepEqual(calls, []); assert.match(dom.view.innerHTML, /Documented candidate/); assert.match(dom.view.innerHTML, /Retired 2026-09-14/); assert.doesNotMatch(dom.view.innerHTML, /access unverified|untested access/i); assert.match(dom.view.innerHTML, /href="https:\/\/learn\.chatgpt\.com\/docs\/models"/);
  assert.doesNotMatch(dom.view.innerHTML.match(/<select id="connection-default-model"[\s\S]*?<\/select>/)[0], /gpt-5.3-codex-spark/, 'a discovery row does not silently register a picker option');
  dom.get('#connection-default-model').value = 'native-other'; dom.get('#connection-default-model').onchange(); dom.get('#connection-codex-id').value = 'Kept/Manual:Draft';
  const button = dom.checkCodex(candidate.id), checking = button.onclick(); assert.equal(button.disabled, true); assert.match(dom.get('#connection-codex-receipt').textContent, /Checking/);
  await button.onclick(); assert.equal(calls.length, 1); held.resolve(); await checking;
  assert.equal(dom.get('#connection-default-model').value, 'native-other'); assert.equal(dom.get('#connection-use-default').disabled, false); assert.equal(dom.get('#connection-codex-id').value, 'Kept/Manual:Draft');
  assert.match(dom.get('#connection-codex-receipt').textContent, /test request completed/); assert.match(dom.view.innerHTML, /Retired 2026-09-14/); assert.match(dom.view.innerHTML, /Last request completed/); assert.equal(calls.length, 1);
});

test('adding a documented candidate is separate from checking and preserves an unrelated manual ID draft', async t => {
  const dom = connectionDocument(t), candidate = sparkCandidate(), calls = []; let custom = [];
  const api = async (url, method, body) => { if (url === '/api/status') return candidateStatus(candidate, null, custom); if (url === '/api/providers') return []; calls.push({ url, method, body }); custom = [body.model]; return {}; };
  await openConnections({ api, ...dom }); dom.get('#connection-codex-id').value = 'Keep/This:ID'; dom.get('#connection-default-model').value = 'native-other';
  await dom.addCandidate(candidate.id).onclick();
  assert.deepEqual(calls, [{ url: '/api/codex/models', method: 'POST', body: { model: candidate.id } }]); assert.equal(dom.get('#connection-codex-id').value, 'Keep/This:ID'); assert.equal(dom.get('#connection-default-model').value, 'native-other');
  assert.match(dom.view.innerHTML, /Custom model ID/); assert.match(dom.view.innerHTML, /Retired 2026-09-14/); assert.equal(dom.addCandidate(candidate.id), undefined);
});

test('a lost check response permits only an explicit status read, which cannot claim success when its read fails', async t => {
  const dom = connectionDocument(t), candidate = sparkCandidate(), calls = []; let readFails = true;
  const api = async (url, options) => {
    if (url === '/api/status') return candidateStatus(candidate); if (url === '/api/providers') return [];
    calls.push(url);
    if (url === '/api/codex/models/check') throw Object.assign(Error('The check response timed out.'), { uncertain: true, timedOut: true });
    if (url === '/api/codex/models') { if (readFails) throw Error('The current check status could not be read.'); return {}; }
    throw Error(`Unexpected endpoint ${url}`);
  };
  await openConnections({ api, ...dom }); await dom.checkCodex(candidate.id).onclick();
  assert.match(dom.get('#connection-home-error').textContent, /Read check status before checking again/); assert.equal(dom.checkCodex(candidate.id).disabled, true);
  await dom.checkCodex(candidate.id).onclick(); assert.equal(calls.length, 1);
  await dom.get('#connection-codex-read-status').onclick(); assert.match(dom.get('#connection-home-error').textContent, /could not be read/); assert.equal(dom.get('#connection-codex-receipt').textContent, '');
  readFails = false; await dom.get('#connection-codex-read-status').onclick(); assert.match(dom.get('#connection-codex-receipt').textContent, /No model check result/); assert.equal(dom.checkCodex(candidate.id).disabled, false);
  assert.deepEqual(calls, ['/api/codex/models/check', '/api/codex/models', '/api/codex/models']);
});

test('an old-connection result cannot publish success or failure for the current connection or redraw a closed Models dialog', async t => {
  for (const outcome of ['accepted', 'failed', 'interrupted']) for (const close of [false, true]) await t.test(`${outcome}: ${close ? 'closed dialog' : 'changed connection'}`, async subtest => {
    const dom = connectionDocument(subtest), candidate = sparkCandidate(), held = heldRequest(); let changed = 0;
    const api = async url => { if (url === '/api/status') return candidateStatus(candidate); if (url === '/api/providers') return []; await held.promise; return { result: { model: candidate.id, requestedModel: candidate.id, effectiveModel: candidate.id, status: outcome, scope: 'expired-connection', checkedAt: '2026-10-18T01:00:00Z', ...(outcome === 'accepted' ? {} : { error: { code: 'OLD_REQUEST_FAILURE', message: 'An earlier connection failed.' } }) } }; };
    await openConnections({ api, ...dom, onChanged: () => { changed++; } }); const checking = dom.checkCodex(candidate.id).onclick();
    if (close) dom.close(); const before = dom.view.innerHTML; held.resolve(); await checking;
    if (close) { assert.equal(dom.view.innerHTML, before); assert.equal(changed, 0); }
    else { assert.match(dom.get('#connection-codex-receipt').textContent, /does not match the current connection/); assert.doesNotMatch(dom.get('#connection-codex-receipt').textContent, /test request completed|test request failed|test request interrupted/); assert.doesNotMatch(dom.view.innerHTML, /access unverified|untested access|OLD_REQUEST_FAILURE/i); }
  });
});

test('Models and connections never offers the retired ChatGPT Bridge', async t => {
  const dom = connectionDocument(t), calls = []; let opened = 0;
  const api = async url => { calls.push(url); if (url === '/api/providers') return []; if (url === '/api/status') return candidateStatus(sparkCandidate()); throw Error(`Unexpected request ${url}`); };
  await openConnections({ api, ...dom, onChatGPTBridge: () => { opened++; } });
  assert.doesNotMatch(dom.view.innerHTML, /ChatGPT bridge|manual handoff|manual bridge|connection-chatgpt-bridge/i);
  assert.equal(opened, 0); assert.deepEqual(calls, ['/api/providers', '/api/status']);
});

test('explicit native ID handlers save exact choices, preserve drafts and change defaults only through the default action', async t => {
  const dom = connectionDocument(t), writes = [], id = 'Vendor/Explicit.Model:preview'; let custom = [], chosen = 'native-default';
  const snapshot = () => ({ codex: { connected: true, authenticated: true }, models: [{ id: 'native-default', model: 'native-default' }, { id: 'native-other', model: 'native-other' }, ...custom.map(id => ({ id, model: id, source: 'custom', access: { state: 'unverified' } }))], customCodexModels: [...custom], defaultModelSelection: chosen, defaultModel: chosen, defaultModelAvailable: chosen.startsWith('native-') || custom.includes(chosen), ...(!chosen.startsWith('native-') && !custom.includes(chosen) ? { defaultModelError: 'The saved model is not registered.' } : {}) });
  const api = async (url, method, body) => {
    if (url === '/api/status') return snapshot(); if (url === '/api/providers') return [];
    writes.push({ url, method, body });
    if (url === '/api/codex/models') { custom = method === 'DELETE' ? custom.filter(id => id !== body.model) : [...new Set([...custom, body.model])]; return {}; }
    if (url === '/api/models/default') { chosen = body.model; return {}; }
    throw Error(`Unexpected native UI request ${url}`);
  };
  await openConnections({ api, ...dom }); dom.get('#connection-default-model').value = 'native-other'; dom.get('#connection-default-model').onchange();
  dom.get('#connection-codex-id').value = ' bad model'; await dom.get('#connection-codex-add').onclick(); assert.equal(writes.length, 0); assert.match(dom.get('#connection-home-error').textContent, /exact native Codex model ID/);
  dom.get('#connection-codex-id').value = id; dom.get('#connection-codex-id').oninput(); await dom.get('#connection-codex-add').onclick();
  assert.deepEqual(writes, [{ url: '/api/codex/models', method: 'POST', body: { model: id } }]);
  assert.equal(chosen, 'native-default'); assert.equal(dom.get('#connection-default-model').value, 'native-other'); assert.equal(dom.get('#connection-use-default').disabled, false);
  assert.equal(dom.get('#connection-codex-id').value, ''); assert.equal(dom.get('#connection-codex-details').open, true); assert.match(dom.get('#connection-codex-receipt').textContent, /Model ID saved/); assert.doesNotMatch(dom.get('#connection-codex-receipt').textContent, /unverified|untested/i);
  dom.get('#connection-default-model').value = id; await dom.get('#connection-use-default').onclick(); assert.equal(chosen, id); assert.equal(writes.at(-1).url, '/api/models/default');
  await dom.removeCodex(id).onclick(); assert.deepEqual(writes.at(-1), { url: '/api/codex/models', method: 'DELETE', body: { model: id } });
  assert.equal(chosen, id); assert.equal(dom.get('#connection-default-model').value, id); assert.match(dom.view.innerHTML, /Vendor\/Explicit.Model:preview · unavailable/);
  assert.match(dom.get('#connection-codex-receipt').textContent, /default and existing task choices are unchanged/); assert.equal(writes.length, 3);
});

test('failed explicit native ID saves keep the exact draft and selected default without automatic retry', async t => {
  const dom = connectionDocument(t), failure = heldRequest(); let mutations = 0;
  const api = async (url, method) => { if (url === '/api/status') return { codex: { connected: true, authenticated: true }, models: [{ id: 'kept' }], defaultModelSelection: 'kept' }; if (url === '/api/providers') return []; mutations++; return failure.promise; };
  await openConnections({ api, ...dom }); const input = dom.get('#connection-codex-id'); input.value = 'unsaved/Exact:ID'; input.oninput();
  const save = dom.get('#connection-codex-add').onclick(); assert.equal(input.disabled, true); assert.equal(dom.get('#connection-default-model').disabled, true);
  await dom.get('#connection-codex-add').onclick(); assert.equal(mutations, 1);
  failure.reject(new Error('Fixture settings write timed out. Check saved settings before retrying.')); await save;
  assert.equal(input.value, 'unsaved/Exact:ID'); assert.equal(input.disabled, false); assert.equal(dom.get('#connection-default-model').value, 'kept'); assert.equal(dom.get('#connection-default-model').disabled, false);
  assert.match(dom.get('#connection-home-error').textContent, /timed out/); assert.equal(dom.get('#connection-codex-receipt').textContent, ''); assert.equal(mutations, 1);
});

test('a late explicit ID save cannot redraw or report success in a closed Models dialog', async t => {
  const dom = connectionDocument(t), saving = heldRequest(); let changes = 0;
  const api = async (url, method) => { if (url === '/api/status') return {}; if (url === '/api/providers') return []; return saving.promise; };
  await openConnections({ api, ...dom, onChanged: () => { changes++; } }); dom.get('#connection-codex-id').value = 'new-model'; const pending = dom.get('#connection-codex-add').onclick(), before = dom.view.innerHTML;
  dom.close(); saving.resolve({}); await pending; assert.equal(dom.view.innerHTML, before); assert.equal(changes, 0);
});

test('actual connection handlers save disabled field values, clear saved secrets, page models and save only selections', async t => {
  const dom = connectionDocument(t), requests = []; let changed = 0;
  const status = { codex: { connected: true, authenticated: true }, models: [], secretStorage: 'session' };
  const api = async (url, method, body) => {
    requests.push({ url, method, body });
    if (url === '/api/status') return status; if (!method) return [];
    if (url === '/api/providers') { assert.equal(dom.form().elements.name.disabled, true); assert.equal(dom.form().elements.baseUrl.disabled, true); return { ...body, hasApiKey: true, apiKey: undefined }; }
    if (url.endsWith('/models')) return { models: [{ id: body.offset ? 'vendor/far-model' : 'vendor/first', displayName: body.offset ? 'Far model' : 'First model', contextWindowTokens: 900000 }], offset: body.offset, total: 501, hasMore: body.offset === 0 };
    throw new Error(`Unexpected fixture request ${url}`);
  };
  await openConnections({ api, ...dom, onChanged: () => { changed++; } });
  assert.ok(dom.provider('openrouter'), dom.view.innerHTML);
  dom.provider('openrouter').onclick(); const form = dom.form();
  form.elements.apiKey.value = 'fixture-not-a-real-key'; await dom.get('#connection-find').onclick();
  assert.equal(form.elements.apiKey.value, ''); assert.equal(form.elements.name.value, 'OpenRouter'); assert.equal(form.elements.baseUrl.value, 'https://openrouter.ai/api/v1');
  const firstSave = requests.find(request => request.url === '/api/providers' && request.method === 'POST'); assert.equal(firstSave.body.apiKey, 'fixture-not-a-real-key'); assert.deepEqual(firstSave.body.models, []);
  assert.doesNotMatch(dom.view.innerHTML, /fixture-not-a-real-key/);
  // Catalog rendering creates page controls dynamically in the real DOM. The
  // fixture exposes those IDs as event targets without parsing layout.
  assert.match(dom.get('#connection-pagination').innerHTML, /connection-page-next/);
  const selected = dom.model('vendor/first'); selected.checked = true; selected.onchange();
  await dom.get('#connection-page-next').onclick(); await dom.get('#connection-page-next').onclick(); await dom.get('#connection-page-next').onclick();
  const far = dom.model('vendor/far-model'); far.checked = true; far.onchange();
  assert.ok(requests.some(request => request.url.endsWith('/models') && request.body.offset === 300 && request.body.limit === 100));
  dom.get('#connection-model-search').value = 'far';
  // Trigger debounced production search and its actual catalog request.
  dom.get('#connection-model-search').oninput(); await new Promise(resolve => setTimeout(resolve, 275));
  await uiTurn();
  await form.onsubmit({ preventDefault() {} });
  const saves = requests.filter(request => request.url === '/api/providers' && request.method === 'POST');
  assert.equal(saves.length, 2); assert.equal(saves[1].body.apiKey, undefined); assert.deepEqual(saves[1].body.models.map(model => model.id), ['vendor/first', 'vendor/far-model']);
  assert.ok(changed >= 2); assert.equal(saves[1].body.preset, 'openrouter'); assert.equal(saves[1].body.maxTokens, 8192);
});

test('provider step budgets keep saved values, allow large choices and save blank as no app limit', async t => {
  const dom = connectionDocument(t), saves = [];
  let provider = { id: 'local', preset: 'ollama', type: 'compatible', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', maxSteps: 24, models: [configured] };
  const api = async (url, method, body) => { if (url === '/api/status') return {}; if (!method) return [provider]; if (url === '/api/providers') { saves.push(body); provider = { ...provider, ...body }; return provider; } throw Error('Unexpected budget fixture request.'); };
  await openConnections({ api, ...dom });
  dom.edit('local').onclick(); assert.equal(dom.form().elements.maxSteps.value, '24');
  assert.doesNotMatch(dom.view.innerHTML, /name="maxSteps"[^>]*max="100"/);
  dom.form().elements.maxSteps.value = '10000'; await dom.form().onsubmit({ preventDefault() {} }); assert.equal(saves.at(-1).maxSteps, 10000);
  dom.edit('local').onclick(); assert.equal(dom.form().elements.maxSteps.value, '10000');
  dom.form().elements.maxSteps.value = ''; await dom.form().onsubmit({ preventDefault() {} }); assert.equal(saves.at(-1).maxSteps, null);
  dom.edit('local').onclick(); assert.equal(dom.form().elements.maxSteps.value, ''); assert.match(dom.view.innerHTML, /placeholder="No app limit"/);
  dom.get('#connection-back').onclick(); dom.provider('ollama').onclick(); assert.equal(dom.form().elements.maxSteps.value, '');
});

test('failed credential save and catalog fetch keep the editor draft and selected models without replaying requests', async t => {
  const dom = connectionDocument(t), provider = { id: 'fixture', preset: 'openrouter', type: 'compatible', name: 'My router', baseUrl: 'https://openrouter.ai/api/v1', hasApiKey: true, enabled: true, models: [configured] }; let saves = 0, catalogs = 0;
  const api = async (url, method, body) => {
    if (url === '/api/status') return { models: [] }; if (!method) return [provider];
    if (url === '/api/providers') { if (++saves === 1) throw new Error('Fixture save failed.'); return { ...body, apiKey: undefined, hasApiKey: true }; }
    if (url.endsWith('/models')) { catalogs++; throw new Error('Fixture catalog unavailable.'); }
  };
  await openConnections({ api, ...dom }); dom.edit('fixture').onclick(); const form = dom.form();
  form.elements.apiKey.value = 'fixture-unsaved-key'; form.elements.name.value = 'My edited router'; form.elements.maxTokens.value = '12345';
  await dom.get('#connection-find').onclick();
  assert.equal(form.elements.apiKey.value, 'fixture-unsaved-key', 'a key not accepted by the server remains editable'); assert.equal(saves, 1); assert.equal(catalogs, 0);
  await dom.get('#connection-find').onclick();
  assert.equal(form.elements.apiKey.value, '', 'the server-saved secret is cleared even when catalog lookup then fails');
  assert.equal(dom.form(), form); assert.equal(form.elements.name.value, 'My edited router'); assert.equal(form.elements.maxTokens.value, '12345');
  assert.match(dom.get('#connection-selected').innerHTML, /Local model/); assert.match(dom.get('#connection-error').textContent, /catalog unavailable/);
  assert.match(dom.get('#connection-receipt').textContent, /selections are kept/); assert.equal(saves, 2); assert.equal(catalogs, 1);
});

test('late catalog results cannot redraw a closed connection dialog', async t => {
  const dom = connectionDocument(t), result = heldRequest(); let requested = false;
  const provider = { id: 'local', preset: 'ollama', type: 'compatible', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', models: [] };
  const api = async (url, method, body) => {
    if (url === '/api/status') return {}; if (!method) return [provider]; if (url === '/api/providers') return body;
    if (url.endsWith('/models')) { requested = true; return result.promise; }
  };
  await openConnections({ api, ...dom }); dom.edit('local').onclick(); const finding = dom.get('#connection-find').onclick(); await uiTurn(); assert.equal(requested, true);
  const before = dom.get('#connection-catalog').innerHTML; dom.close(); result.resolve({ models: [{ id: 'late-private-result', displayName: 'Late private result' }] }); await finding;
  assert.equal(dom.get('#connection-catalog').innerHTML, before); assert.doesNotMatch(dom.view.innerHTML, /late-private-result/);
});

test('provider search Enter filters without saving the editor and rejects an earlier query before its debounce completes', async t => {
  const dom = connectionDocument(t), first = heldRequest(), second = heldRequest(), requests = [];
  const provider = { id: 'local', preset: 'ollama', type: 'compatible', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true, models: [configured] };
  const api = async (url, method, body) => {
    if (url === '/api/status') return {}; if (!method) return [provider]; requests.push({ url, method, body });
    assert.equal(url, '/api/providers/local/models', 'search must never save provider settings or start a task'); return body.query === 'earlier' ? first.promise : second.promise;
  };
  await openConnections({ api, ...dom }); dom.edit('local').onclick(); const form = dom.form(), search = dom.get('#connection-model-search');
  form.elements.name.value = 'Unsaved local name'; form.elements.apiKey.value = 'unsaved-test-value'; search.value = 'earlier';
  let prevented = false; const earlier = search.onkeydown({ key: 'Enter', preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.equal(requests.length, 1); assert.equal(dom.get('#connection-catalog').getAttribute('aria-busy'), 'true');
  const previousPage = dom.get('#connection-catalog').innerHTML;
  search.value = 'new query'; search.oninput(); first.resolve({ models: [{ id: 'stale-model' }], total: 1 }); await earlier;
  assert.equal(dom.get('#connection-catalog').innerHTML, previousPage, 'the old request is stale immediately, including the debounce interval');
  const current = search.onkeydown({ key: 'Enter', preventDefault() {} }); second.resolve({ models: [{ id: 'new-model', displayName: 'New model' }], total: 1 }); await current;
  assert.match(dom.get('#connection-catalog').innerHTML, /New model/); assert.doesNotMatch(dom.get('#connection-catalog').innerHTML, /stale-model/); assert.equal(dom.get('#connection-catalog').getAttribute('aria-busy'), 'false');
  assert.equal(dom.form(), form); assert.equal(form.elements.name.value, 'Unsaved local name'); assert.equal(form.elements.apiKey.value, 'unsaved-test-value'); assert.match(dom.get('#connection-selected').innerHTML, /Local model/);
  assert.deepEqual(requests.map(request => request.body.query), ['earlier', 'new query']);
  search.onkeydown({ key: 'ArrowDown', preventDefault() {} }); assert.equal(dom.active().dataset.modelId, 'new-model'); assert.equal(dom.active().checked, false);
  const beforeIme = requests.length; search.onkeydown({ key: 'Enter', isComposing: true, preventDefault() { throw Error('Composition must remain native.'); } }); assert.equal(requests.length, beforeIme);
});

test('custom API keeps its selected protocol and sends an explicitly chosen application default', async t => {
  const dom = connectionDocument(t), posts = [];
  const provider = { id: 'custom', type: 'anthropic', name: 'Gateway', baseUrl: 'https://gateway.example.test/api', models: [reported], enabled: true, hasHeaders: true, headerNames: ['x-api-key'] };
  const api = async (url, method, body) => { if (url === '/api/status') return { defaultModelSelection: 'default', models: [{ id: 'custom::large-model', displayName: 'Gateway model', available: true }] }; if (!method) return [provider]; posts.push({ url, body }); return url === '/api/providers' ? body : {}; };
  await openConnections({ api, ...dom }); dom.edit('custom').onclick(); const form = dom.form();
  assert.equal((dom.view.innerHTML.match(/name="baseUrl"/g) || []).length, 1); assert.equal((dom.view.innerHTML.match(/name="type"/g) || []).length, 1);
  assert.match(dom.view.innerHTML, /connection-custom-basics/); assert.match(dom.view.innerHTML, /<details class="connection-advanced">/);
  assert.equal(form.elements.type.value, 'anthropic'); assert.equal(form.elements.type.disabled, false);
  assert.equal(form.elements.headers.value, ''); assert.match(dom.view.innerHTML, /Saved: x-api-key/);
  form.elements.type.value = 'openai'; form.elements.headers.value = 'x-api-key: fixture-header-secret\napi-version: 2026-01-01'; await form.onsubmit({ preventDefault() {} });
  assert.equal(posts[0].body.type, 'openai'); assert.equal(posts[0].body.preset, 'compatible');
  assert.deepEqual(posts[0].body.headers, { 'x-api-key': 'fixture-header-secret', 'api-version': '2026-01-01' });
  assert.equal(form.elements.headers.value, ''); assert.doesNotMatch(dom.view.innerHTML, /fixture-header-secret/);
  dom.get('#connection-default-model').value = 'custom::large-model'; await dom.get('#connection-use-default').onclick();
  assert.deepEqual(posts.at(-1), { url: '/api/models/default', body: { model: 'custom::large-model' } });
  dom.edit('custom').onclick(); const clearing = dom.form(); clearing.elements.clearHeaders.checked = true;
  await clearing.onsubmit({ preventDefault() {} }); assert.deepEqual(posts.at(-1).body.headers, {});
});

test('Models directly connects Codex without changing an API default or an unsaved model choice', async t => {
  const dom = connectionDocument(t), posts = [], toasts = []; let changed = 0, connected = false;
  const status = () => ({ codex: { connected, authenticated: connected }, defaultModelSelection: 'api::model', defaultModel: 'api::model', models: [{ id: 'api::model', available: true }, { id: 'api::another', available: true }] });
  const api = async (url, method, body) => {
    if (url === '/api/status') return status(); if (!method) return [];
    posts.push({ url, body }); assert.equal(url, '/api/runtime/reconnect'); connected = true; return status();
  };
  await openConnections({ api, ...dom, toast: message => toasts.push(message), onChanged: () => { changed++; } });
  assert.match(dom.view.innerHTML, /Connect Codex/); dom.get('#connection-default-model').value = 'api::another';
  await dom.get('#connection-codex-connect').onclick();
  assert.deepEqual(posts, [{ url: '/api/runtime/reconnect', body: {} }]); assert.equal(changed, 1); assert.deepEqual(toasts, ['Codex connected.']);
  assert.match(dom.view.innerHTML, /Refresh models/); assert.equal(dom.get('#connection-default-model').value, 'api::another');
  assert.equal(status().defaultModelSelection, 'api::model');
});

test('Models refreshes the native catalog with visible counts and honest hidden-model compatibility feedback', async t => {
  const dom = connectionDocument(t), posts = [], toasts = [], held = heldRequest();
  const models = Array.from({ length: 9 }, (_, index) => ({ id: `native-${index}`, displayName: `Native ${index}`, hidden: index >= 7 }));
  let fresh = false;
  const status = () => ({ codex: { connected: true, authenticated: true, models: fresh ? models : models.slice(0, 7), modelCatalog: { hiddenModelsIncluded: fresh, stale: false, error: null } }, defaultModelSelection: 'default', models: fresh ? models : models.slice(0, 7) });
  const api = async (url, method, body) => {
    if (url === '/api/status') return status(); if (!method) return [];
    posts.push({ url, body }); await held.promise; fresh = true; return status();
  };
  await openConnections({ api, ...dom, toast: message => toasts.push(message) });
  assert.match(dom.view.innerHTML, /7 models/); assert.match(dom.view.innerHTML, /does not expose hidden models/);
  dom.get('#connection-default-model').value = 'native-5';
  const button = dom.get('#connection-codex-connect'), pending = button.onclick();
  assert.equal(button.disabled, true); assert.equal(button.textContent, 'Refreshing models…');
  held.resolve(); await pending;
  assert.deepEqual(posts, [{ url: '/api/runtime/reconnect', body: {} }]); assert.deepEqual(toasts, ['Codex models refreshed.']);
  assert.match(dom.view.innerHTML, /9 models/); assert.match(dom.view.innerHTML, /2 Hidden by Codex/);
  assert.match(dom.view.innerHTML, /Native 8 · Hidden by Codex/); assert.doesNotMatch(dom.view.innerHTML, /does not expose hidden models/);
  assert.equal(dom.get('#connection-default-model').value, 'native-5'); assert.equal(dom.get('#connection-use-default').disabled, false);
});

test('a failed catalog refresh reloads confirmed sign-out and preserves an unavailable unsaved model draft', async t => {
  const dom = connectionDocument(t), toasts = [], posts = []; let signedOut = false;
  const model = { id: 'native-choice', displayName: 'Saved catalog model' };
  const status = () => ({ codex: { connected: true, authenticated: !signedOut, models: [model], modelCatalog: { hiddenModelsIncluded: true, stale: signedOut, error: signedOut ? 'Catalog requires sign-in.' : null } }, models: [{ ...model, available: !signedOut }], defaultModelSelection: 'default' });
  const api = async (url, method) => {
    if (url === '/api/status') return status(); if (!method) return [];
    posts.push(url); signedOut = true; throw new Error('Catalog requires sign-in.');
  };
  await openConnections({ api, ...dom, toast: message => toasts.push(message) });
  dom.get('#connection-default-model').value = 'native-choice';
  await dom.get('#connection-codex-connect').onclick();
  assert.match(dom.view.innerHTML, /Sign in to Codex, then connect/); assert.match(dom.view.innerHTML, /Refresh failed/);
  assert.equal(dom.get('#connection-default-model').value, 'native-choice'); assert.match(dom.view.innerHTML, /native-choice · unavailable/);
  assert.equal(dom.get('#connection-home-error').textContent, 'Catalog requires sign-in.');
  assert.equal(dom.get('#connection-codex-connect').disabled, false); assert.deepEqual(toasts, []); assert.deepEqual(posts, ['/api/runtime/reconnect']);
});

test('Models shows native connection errors inline and lets the user retry without a provider change', async t => {
  const dom = connectionDocument(t); let attempts = 0;
  const api = async (url, method) => {
    if (url === '/api/status') return { codex: { connected: false, authenticated: false }, defaultModelSelection: 'api::model' }; if (!method) return [];
    assert.equal(url, '/api/runtime/reconnect');
    if (++attempts === 1) throw new Error('Codex fixture could not start.');
    return { codex: { connected: true, authenticated: false, lastError: 'Sign in to the Codex fixture first.' } };
  };
  await openConnections({ api, ...dom });
  await dom.get('#connection-codex-connect').onclick();
  assert.match(dom.get('#connection-home-error').textContent, /could not start/); assert.equal(dom.get('#connection-codex-connect').disabled, false);
  await dom.get('#connection-codex-connect').onclick();
  assert.match(dom.get('#connection-home-error').textContent, /Sign in/); assert.equal(attempts, 2);
});

for (const outcome of ['success', 'failure']) test(`a late Codex connection ${outcome} cannot redraw or toast after Models closes`, async t => {
  const dom = connectionDocument(t), held = heldRequest(), toasts = []; let changed = 0;
  const api = async (url, method) => { if (url === '/api/status') return { codex: { connected: false } }; if (!method) return []; return held.promise; };
  await openConnections({ api, ...dom, toast: message => toasts.push(message), onChanged: () => { changed++; } });
  const pending = dom.get('#connection-codex-connect').onclick(), before = dom.view.innerHTML;
  dom.close(); if (outcome === 'success') held.resolve({ codex: { connected: true, authenticated: true } }); else held.reject(new Error('Late connection error.'));
  await pending;
  assert.equal(dom.view.innerHTML, before); assert.deepEqual(toasts, []); assert.equal(changed, 0);
});

test('asynchronously loaded model settings focus the default picker',async t=>{
  const dom=connectionDocument(t);
  await openConnections({api:async url=>url==='/api/status'?{models:[]}:[],...dom});
  assert.equal(dom.active(),dom.get('#connection-default-model'));
});

test('model loading keeps focus on Close when the user chose it during the request',async t=>{
  const dom=connectionDocument(t),pending=heldRequest(),opening=openConnections({api:async url=>url==='/api/status'?{models:[]}:pending.promise,...dom});
  dom.focusClose();pending.resolve([]);await opening;
  assert.equal(dom.active(),dom.closeControl);
});

test('an initial model-loading error focuses its retry control without touching provider data',async t=>{
  const dom=connectionDocument(t),calls=[];
  await openConnections({api:async(url,method)=>{calls.push({url,method});throw new Error('Temporary local failure');},...dom});
  assert.equal(dom.active(),dom.get('#connection-retry'));assert.ok(calls.every(call=>!call.method));
});

test('the default model action distinguishes a saved preference from an unsaved choice', async t => {
  const dom = connectionDocument(t), writes = [], status = { defaultModelSelection: 'default', models: [{ id: 'cloud::fast', displayName: 'Fast model', available: true }] };
  const api = async (url, method, body) => {
    if (url === '/api/status') return status; if (!method) return [];
    if (url === '/api/models/default') { writes.push(body); status.defaultModelSelection = body.model; return {}; }
    throw Error('Unexpected default preference request.');
  };
  await openConnections({ api, ...dom }); assert.equal(dom.get('#connection-use-default').disabled, true);
  assert.match(dom.get('#connection-default-note').textContent, /Saved default/);
  const select = dom.get('#connection-default-model'); select.value = 'cloud::fast'; select.onchange();
  assert.equal(dom.get('#connection-use-default').disabled, false); assert.match(dom.get('#connection-default-note').textContent, /Unsaved choice/);
  await dom.get('#connection-use-default').onclick(); assert.deepEqual(writes, [{ model: 'cloud::fast' }]);
  assert.equal(dom.get('#connection-use-default').disabled, true); await dom.get('#connection-use-default').onclick(); assert.equal(writes.length, 1);
});

test('provider setup explains persistence, links to key help and locates validation errors', async t => {
  const dom = connectionDocument(t), writes = [];
  const api = async (url, method, body) => {
    if (url === '/api/status') return {}; if (!method) return [];
    if (url === '/api/providers') { writes.push(body); return { ...body, hasApiKey: true }; }
    if (url.endsWith('/models')) return { models: [{ id: 'one', displayName: 'One model' }], offset: 0, total: 1, hasMore: false };
    throw Error('Unexpected provider setup request.');
  };
  await openConnections({ api, ...dom }); dom.provider('openai').onclick();
  assert.match(dom.view.innerHTML, /Connect &amp; find models/); assert.match(dom.view.innerHTML, /Find and test save your connection settings/);
  assert.match(dom.view.innerHTML, /href="https:\/\/platform.openai.com\/api-keys" target="_blank" rel="noopener noreferrer"/);
  assert.match(dom.view.innerHTML, /Choose your models/); assert.match(dom.view.innerHTML, /Save selected models/);
  await dom.get('#connection-find').onclick(); assert.equal(writes.length, 0);
  assert.match(dom.get('#connection-key-error').textContent, /Enter an API key/); assert.equal(dom.active(), dom.form().elements.apiKey);
  dom.form().elements.apiKey.value = 'fixture-key'; await dom.get('#connection-find').onclick();
  assert.equal(writes.length, 1); assert.match(dom.get('#connection-receipt').textContent, /Connection saved/);
  await dom.form().onsubmit({ preventDefault() {} }); assert.equal(writes.length, 1); assert.equal(dom.active(), dom.get('#connection-model-search'));
  const advanced = { tagName: 'DETAILS', open: false }, headers = { tagName: 'DETAILS', open: false, parentElement: advanced };
  dom.form().elements.headers.parentElement = headers; dom.form().elements.headers.value = 'malformed line';
  await dom.get('#connection-find').onclick(); assert.equal(advanced.open, true); assert.equal(headers.open, true); assert.equal(dom.active(), dom.form().elements.headers);
  assert.equal(writes.length, 1);
});


test('provider save and test show live progress immediately and stop it without changing the model choice', async t => {
  const dom = connectionDocument(t), saved = heldRequest(), checked = heldRequest(), calls = []; let submitted;
  const api = async (url, method, body) => {
    if (url === '/api/status') return { defaultModelSelection: 'keep::model', defaultModel: 'keep::model', codex: { connected: false } };
    if (!method) return [];
    calls.push(url);
    if (url === '/api/providers') { submitted = body; await saved.promise; return { ...body, hasApiKey: false }; }
    if (url.endsWith('/test')) return checked.promise;
    throw Error('Unexpected metadata request.');
  };
  await openConnections({ api, ...dom }); dom.provider('compatible').onclick();
  const button = dom.get('#connection-test'), pending = button.onclick();
  assert.match(dom.get('#connection-receipt').textContent, /Saving connection/); assert.equal(dom.get('#connection-receipt').dataset.connecting, 'true'); assert.equal(button.disabled, true);
  saved.resolve(); await uiTurn();
  assert.match(dom.get('#connection-receipt').textContent, /Checking the provider/); assert.equal(dom.get('#connection-receipt').dataset.connecting, 'true');
  checked.resolve({ credentialVerified: false }); await pending;
  assert.match(dom.get('#connection-receipt').textContent, /catalog reachable; key not verified/); assert.equal(dom.get('#connection-receipt').dataset.connecting, 'false'); assert.equal(dom.form().dataset.connecting, 'false');
  assert.equal(button.disabled, false); assert.equal(calls.length, 2); assert.equal(calls.includes('/api/models/default'), false); assert.ok(submitted);
});

test('a failed provider test clears the spinner, reports the actual error and never retries automatically', async t => {
  const dom = connectionDocument(t), check = heldRequest(), calls = [];
  const api = async (url, method, body) => {
    if (url === '/api/status') return {}; if (!method) return [];
    calls.push(url); if (url === '/api/providers') return { ...body, hasApiKey: false };
    if (url.endsWith('/test')) return check.promise;
    throw Error('Unexpected metadata request.');
  };
  await openConnections({ api, ...dom }); dom.provider('compatible').onclick();
  const pending = dom.get('#connection-test').onclick(); await uiTurn(); assert.equal(dom.get('#connection-receipt').dataset.connecting, 'true');
  check.reject(Error('Fixture provider did not respond.')); await pending;
  assert.equal(dom.get('#connection-receipt').textContent, ''); assert.equal(dom.get('#connection-receipt').dataset.connecting, 'false');
  assert.match(dom.get('#connection-error').textContent, /Fixture provider did not respond/); assert.equal(dom.get('#connection-test').disabled, false); assert.equal(calls.length, 2);
});

test('native connect has persistent inline progress and a terminal failure preserves the API default draft', async t => {
  const dom = connectionDocument(t), connect = heldRequest(), calls = []; let failed = false;
  const api = async (url, method) => {
    if (url === '/api/providers') return [];
    if (url === '/api/status') return { defaultModelSelection: 'api::saved', defaultModel: 'api::saved', codex: { connected: false, authenticated: false, connection: { phase: failed ? 'failed' : 'initializing' }, ...(failed ? { lastError: 'Fixture native handshake failed.' } : {}) } };
    calls.push(url); return connect.promise;
  };
  await openConnections({ api, ...dom }); assert.match(dom.view.innerHTML, /Waiting for the local runtime to respond/);
  dom.get('#connection-default-model').value = 'api::unsaved'; const pending = dom.get('#connection-codex-connect').onclick();
  assert.match(dom.get('#connection-native-progress').textContent, /Connecting to your local Codex runtime/); assert.equal(dom.get('#connection-native-progress').dataset.connecting, 'true');
  failed = true; connect.reject(Error('Fixture native handshake failed.')); await pending;
  assert.equal(dom.get('#connection-default-model').value, 'api::unsaved'); assert.match(dom.get('#connection-home-error').textContent, /Fixture native handshake failed/);
  assert.match(dom.view.innerHTML, /data-connecting="false"/); assert.deepEqual(calls, ['/api/runtime/reconnect']);
});
