import { providerModelsForSave, mergeDiscoveredProviderModels, createProviderModelSelection, connectionDefaultModels, providerHeadersForSave, codexModelAccessDetails, codexModelSourceLabel, codexModelLifecycleLabel } from './connection-models.mjs';
import { runtimeConnectionFeedback } from './composer-helpers.mjs';
import { PROVIDER_PRESETS, getProviderPreset, isOpenRouterProvider } from './provider-catalog.mjs';
export { providerModelsForSave, mergeDiscoveredProviderModels, createProviderModelSelection, connectionDefaultModels, providerHeadersForSave } from './connection-models.mjs';

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const capacityLines = models => models.filter(model => model.contextWindowTokens).map(model => `${model.id} = ${model.contextWindowTokens}`).join('\n');
export const providerModelIssues = provider => Object.entries(provider.modelChecks||{}).filter(([id,check])=>check.lastFailure && check.lastFailure.scope!=='request' && (provider.models||[]).some(model=>(typeof model==='string'?model:model.id)===id));
const contextLabel = model => model.contextWindowTokens ? `${Number(model.contextWindowTokens).toLocaleString()} context` : 'Context not reported';
const presetFor = provider => getProviderPreset(provider.preset) || (isOpenRouterProvider(provider) ? getProviderPreset('openrouter') : null) || PROVIDER_PRESETS.find(preset => preset.baseUrl && preset.baseUrl === provider.baseUrl) || (provider.baseUrl ? getProviderPreset('compatible') : getProviderPreset(provider.type)) || PROVIDER_PRESETS[0];

function renderModelObservation(model, { escape = escapeText, fields = [] } = {}) {
  const observation = codexModelAccessDetails(model);
  if (!observation) return '';
  return `<details class="connection-model-observation"><summary>${escape(observation.label)}</summary><dl>${[...fields, ...observation.entries].map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl><p class="connection-field-note">${escape(observation.note)}</p></details>`;
}

export function renderCodexCheckDetails(result = {}, { escape = escapeText } = {}) {
  if (!['accepted', 'failed', 'interrupted'].includes(result.status)) return '';
  const fields = [['Requested model ID', result.requestedModel || result.model || 'Not recorded'], ['Reported model ID', result.effectiveModel || 'Not reported']];
  if (typeof result.startedAt === 'string' && Number.isFinite(Date.parse(result.startedAt))) fields.push(['Started', new Date(result.startedAt).toISOString().replace('T', ' ').replace('Z', ' UTC')]);
  if (result.error?.message) fields.push(['Request error', result.error.message]);
  return renderModelObservation({ access: { state: result.status === 'accepted' ? 'accepted' : 'failed', outcome: result.status, checkedAt: result.checkedAt, scope: result.scope, errorCode: result.error?.code } }, { escape, fields });
}

export function renderProviderModelRows(models, { escape = escapeText, selected = false } = {}) {
  return models.map(model => {
    const name = model.displayName || model.name || model.id, failure = model.lastFailure && model.lastFailure.scope !== 'request' ? model.lastFailure.message : '';
    return `<label class="connection-model-row connection-model-list-row" title="${escape([model.id, contextLabel(model), failure].filter(Boolean).join(' · '))}"><input type="checkbox" data-model-id="${escape(model.id)}" aria-label="Use ${escape(name)}"${selected || model.selected ? ' checked' : ''}><span class="connection-model-identity"><strong>${escape(name)}</strong>${name !== model.id ? `<small>${escape(model.id)}</small>` : ''}</span><span class="connection-model-meta">${escape(contextLabel(model))}${failure ? `<small class="connection-model-error" title="${escape(failure)}">Needs attention</small>` : model.supportsTools === true ? '<small>Tools</small>' : model.supportsTools === false ? '<small>No tools reported</small>' : ''}</span></label>`;
  }).join('');
}

export function filterCodexModels(models, query = '') {
  const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  return models.filter(model => words.every(word => normalize([model.id, model.model, model.displayName, codexModelSourceLabel(model), codexModelLifecycleLabel(model)].filter(Boolean).join(' ')).includes(word)));
}

export function renderCodexModelRows(models, { customModels = [], escape = escapeText, candidate = false, ready = false, checkingModel = null, checkBlocked = false } = {}) {
  return models.map(model => {
    const route = model.model || model.id, saved = customModels.filter(id => id === model.id || id === route);
    const details = [];
    if (model.description) details.push(['Description', model.description]);
    if (model.inputModalities?.length) details.push(['Input', model.inputModalities.join(', ')]);
    if (model.supportedReasoningEfforts?.length) details.push(['Reasoning', model.supportedReasoningEfforts.map(option => typeof option === 'string' ? option : option.reasoningEffort).join(', ')]);
    if (model.defaultReasoningEffort) details.push(['Default reasoning', model.defaultReasoningEffort]);
    if (model.serviceTiers?.length) details.push(['Reported speed tiers', model.serviceTiers.map(tier => `${tier.name || tier.id} (${tier.id})${tier.description ? `: ${tier.description}` : ''}`).join(' · ')]);
    else if (model.additionalSpeedTiers?.length) details.push(['Reported speed tiers', model.additionalSpeedTiers.join(', ')]);
    if (model.defaultServiceTier) details.push(['Default speed tier', model.defaultServiceTier]);
    if (model.modelSpecialty) details.push(['Specialty', model.modelSpecialty]);
    if (model.multiAgentVersion) details.push(['Multi-agent capability', model.multiAgentVersion]);
    if (model.availableAccessPrograms?.cyber?.length) details.push(['Reported access programs', model.availableAccessPrograms.cyber.join(', ')]);
    if (model.upgrade) details.push(['Suggested upgrade', model.upgrade]);
    for (const [key, label] of [['model', 'Upgrade model'], ['upgradeCopy', 'Upgrade information'], ['modelLink', 'Upgrade reference'], ['migrationMarkdown', 'Migration information']]) if (model.upgradeInfo?.[key]) details.push([label, model.upgradeInfo[key]]);
    if (Number.isFinite(model.upgradeInfo?.retirementAt)) details.push(['Reported retirement time', String(model.upgradeInfo.retirementAt)]);
    if (model.contextWindowTokens) details.push(['Reported context', Number(model.contextWindowTokens).toLocaleString()]);
    const lifecycle = codexModelLifecycleLabel(model), sourceUrl = /^https:\/\/(?:learn\.chatgpt\.com|developers\.openai\.com|openai\.com)\//.test(model.provenance?.url || '') ? model.provenance.url : null;
    const identity = [['Model ID', model.id || route], ...(model.id && model.id !== route ? [['Routing ID', route]] : []), ['Catalog', codexModelSourceLabel(model)]];
    const summary = candidate ? 'Documented' : model.hidden ? 'Hidden' : model.source === 'custom' ? 'Custom ID' : 'Codex';
    return `<article class="connection-codex-model connection-codex-list-row" role="listitem" data-codex-model="${escape(model.id || route)}"${candidate ? ` data-codex-candidate="${escape(route)}"` : ''}><div class="connection-codex-row"><strong title="${escape(model.displayName || route)}">${escape(model.displayName || route)}</strong><small class="connection-codex-provider" title="${escape(codexModelSourceLabel(model))}">${escape(summary)}</small>${lifecycle ? `<small class="connection-codex-lifecycle">${escape(lifecycle)}</small>` : ''}</div><details class="connection-codex-more"><summary aria-label="Details for ${escape(model.displayName || route)}">Details</summary><div class="connection-codex-more-body"><dl class="connection-codex-identity">${identity.map(([label,value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>${model.lifecycle?.note ? `<p class="connection-field-note">${escape(model.lifecycle.note)}</p>` : ''}${sourceUrl ? `<p class="connection-field-note"><a href="${escape(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escape(model.provenance.title || 'OpenAI documentation')}</a>${model.provenance.checkedAt ? ` · Source reviewed ${escape(model.provenance.checkedAt)}` : ''}</p>` : ''}${model.availabilityNux?.message ? `<p class="connection-field-note">${escape(model.availabilityNux.message)}</p>` : ''}${renderModelObservation(model, { escape })}${details.length ? `<details class="connection-codex-capabilities"><summary>Reported details</summary><dl>${details.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl><p class="connection-field-note">Reported capabilities are informational. The selected native model and its reasoning level are sent for your task; speed tiers and access programs are not selected here.</p></details>` : ''}<p class="connection-field-note">Try model sends one short request and may use account quota.</p><div class="connection-codex-actions"><button type="button" class="button subtle" data-codex-check="${escape(route)}" aria-label="Send a test request to ${escape(route)}"${!ready || checkingModel || checkBlocked ? ' disabled' : ''}>${checkingModel === route ? 'Trying…' : 'Try model'}</button>${candidate && !saved.length ? `<button type="button" class="button subtle" data-codex-candidate-add="${escape(route)}">Add to model choices</button>` : ''}${saved.map(id => `<button type="button" class="button subtle" data-codex-remove="${escape(id)}" aria-label="Remove saved model ID ${escape(id)}">Remove saved ID</button>`).join('')}</div></div></details></article>`;
  }).join('');
}

export function codexCheckReceipt(result = {}) {
  const model = result.model || result.requestedModel || 'Model';
  if (result.status === 'checking') return `Checking ${model}… Read check status for its saved result.`;
  const observation = codexModelAccessDetails({ access: { state: result.status === 'accepted' ? 'accepted' : ['failed', 'interrupted'].includes(result.status) ? 'failed' : '', outcome: result.status, errorCode: result.error?.code } });
  return observation ? `${model}: ${observation.label.replace('Last request', 'test request')}.` : 'No completed model test is recorded.';
}

/** Keys remain in the password input until saved, then are cleared immediately. */
export async function openConnections({ api, toast = () => {}, onChanged = () => {}, showModal, closeModal, escape = escapeText, icon = () => '' }) {
  if (!document.getElementById('relay-connections-styles')) { const link = document.createElement('link'); link.id = 'relay-connections-styles'; link.rel = 'stylesheet'; link.href = '/connections.css'; document.head.append(link); }
  let providers = [], status = {}, busy = false, generation = 0, catalogRequest = 0, searchTimer, selected, selection, preset, catalog = null, existing = false, syncDefaultChoice = () => {}, codexDraft = '', codexQuery = '', codexDetailsOpen = false, codexToolsOpen = false, addProviderOpen = false, uncertainCheck = false;
  const $ = selector => document.querySelector(selector);
  showModal('connections', `<div class="modal-header"><div class="modal-title"><h2>Models &amp; connections</h2><p>Connect a provider and choose the models BLACKICE can use.</p></div><button class="icon-button" data-action="close-modal" aria-label="Close models and connections">${icon('close', 17)}</button></div><div id="connections-view" class="connection-workspace"><p class="connection-loading" role="status" aria-live="polite"><span class="connection-progress-spinner" aria-hidden="true"></span> Loading saved models…</p></div>`, true);
  const view = $('#connections-view'); $('#modal-root .modal')?.classList.add('connections-modal');
  const alive = () => $('#connections-view') === view;
  const focusIfOutside = selector => { if (alive() && !$('#modal-root .modal')?.contains(document.activeElement)) revealField($(selector)); };
  const current = form => alive() && $('#connection-form') === form;
  const revealField = field => { if (!field) return; for (let parent = field.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; field.focus?.({ preventScroll: false }); };
  const error = (message, fieldName) => {
    for (const id of ['connection-error', 'connection-key-error']) { const target = $(`#${id}`); if (target) target.textContent = id === (fieldName === 'apiKey' ? 'connection-key-error' : 'connection-error') ? message : ''; }
    const form = $('#connection-form');
    for (const field of Object.values(form?.elements || {})) field?.removeAttribute?.('aria-invalid');
    if (message && fieldName) { const field = form?.elements?.[fieldName] || $(`#connection-${fieldName}`); field?.setAttribute?.('aria-invalid', 'true'); revealField(field); }
  };
  const receipt = (message, pending = false) => { const target = $('#connection-receipt'); if (target) { target.textContent = message; target.dataset.connecting = String(pending); } };
  async function load(modelDraft) {
    const version = ++generation, result = await Promise.all([api('/api/providers'), api('/api/status')]);
    if (!alive() || version !== generation) return false; [providers, status] = result; renderHome(modelDraft); return true;
  }
  function renderHome(modelDraft) {
    if (!alive()) return; generation++; catalogRequest++; clearTimeout(searchTimer);
    const codex = status.codex || status, ready = codex.connected && codex.authenticated, choice = status.defaultModelSelection || 'default';
    const nativeConnection = runtimeConnectionFeedback({ status, model: 'codex' });
    const displayedChoice = typeof modelDraft === 'string' ? modelDraft : choice;
    const nativeModels = Array.isArray(status.models) ? status.models.filter(model => !String(model.id || model.model).includes('::')) : codex.models || [];
    const customModels = status.customCodexModels || [], advertisedCount = nativeModels.filter(model => model.source !== 'custom').length;
    const candidates = (status.codexModelCandidates || []).filter(candidate => !nativeModels.some(model => model.id === candidate.model || model.model === candidate.model));
    const checkingModel = codex.modelCheck?.status === 'checking' ? codex.modelCheck.model : null, checkBlocked = codex.modelCheckBlocked === true || uncertainCheck;
    const hiddenCount = nativeModels.filter(model => model.hidden === true).length, modelCatalog = codex.modelCatalog || {};
    const modelCount = `${advertisedCount} model${advertisedCount === 1 ? '' : 's'} advertised${customModels.length ? ` · ${customModels.length} saved custom ID${customModels.length === 1 ? '' : 's'}` : ''}`;
    const catalogNote = modelCatalog.refreshing ? 'Refreshing your account and model list…'
      : modelCatalog.error ? `Refresh failed: ${modelCatalog.error} The last successful model list is kept.`
      : modelCatalog.hiddenModelsIncluded === false ? 'This Codex version does not expose hidden models. Update Codex to load the full catalog.'
      : modelCatalog.stale ? 'The model list may be out of date. Refresh models to update it.'
      : hiddenCount ? 'Hidden by Codex means omitted from its usual picker. You can choose these models here.' : '';
    const codexSection = `<details id="connection-codex-details" class="connection-codex-details"${codexDetailsOpen ? ' open' : ''}><summary>Codex models</summary>
      <div class="connection-codex-search"><label class="sr-only" for="connection-codex-search">Filter Codex models</label><input id="connection-codex-search" type="search" value="${escape(codexQuery)}" placeholder="Find a model by name or ID" maxlength="200" autocomplete="off" aria-label="Filter Codex models"></div>
      <p id="connection-codex-empty" class="connection-field-note" role="status" hidden>No matching models.</p>
      <p id="connection-codex-receipt" role="status">${checkingModel ? escape(`Checking ${checkingModel}… Read check status for its saved result.`) : codex.modelCheck ? escape(codexCheckReceipt(codex.modelCheck)) : ''}</p>
      <details id="connection-codex-tools" class="connection-codex-tools"${codexToolsOpen ? ' open' : ''}><summary>Custom IDs and model checks</summary>
        <div class="connection-codex-add"><label for="connection-codex-id">Add an explicit model ID</label><p id="connection-codex-id-note" class="connection-field-note">Enter an exact ID, including one missing from this list. Codex decides whether it can serve each request.</p><div><input id="connection-codex-id" value="${escape(codexDraft)}" placeholder="Exact native Codex model ID" maxlength="400" spellcheck="false" autocomplete="off" aria-describedby="connection-codex-id-note"><button type="button" class="button" id="connection-codex-add">Add model ID</button></div></div>
        ${codex.modelCheck ? renderCodexCheckDetails(codex.modelCheck, { escape }) : ''}<p class="connection-field-note">Try model sends one short text request and may use your account’s quota. It has a 45-second deadline. The recorded result describes that request and account. It does not start a task or change your chosen model.</p><button type="button" class="button subtle" id="connection-codex-read-status">Read check status</button>
      </details>
      <div class="connection-codex-models" role="list" aria-label="Codex models">${renderCodexModelRows(nativeModels, { customModels, escape, ready, checkingModel, checkBlocked }) || '<p class="connection-field-note">No native models are listed yet. Connect Codex or save an explicit ID.</p>'}</div>
      ${candidates.length ? `<section id="connection-codex-candidates" role="list" aria-label="Documented model candidates"><h4>Documented candidates</h4><p class="connection-field-note">Exact IDs from OpenAI documentation that are absent from this catalog. Lifecycle labels follow that documentation.</p>${renderCodexModelRows(candidates, { customModels, escape, candidate: true, ready, checkingModel, checkBlocked })}</section>` : ''}
    </details>`;
    view.innerHTML = `<div class="connection-home-scroll"><section class="connection-default"><div class="connection-section-heading"><h3>Default model</h3><span>For new tasks</span></div><label class="sr-only" for="connection-default-model">Default model</label><div><select id="connection-default-model" aria-label="Default model">${connectionDefaultModels({ ...status, defaultModelSelection: displayedChoice }).map(model => `<option value="${escape(model.value)}"${displayedChoice === model.value ? ' selected' : ''}>${escape(model.label)}</option>`).join('')}</select><button class="button primary" id="connection-use-default">Use as default</button></div><p id="connection-default-note" role="status">${escape(status.defaultModelError || (status.defaultModel ? `Now: ${status.models?.find(model => (model.id === status.defaultModel || model.model === status.defaultModel))?.displayName || status.defaultModel}` : 'Used for new tasks.'))}</p></section><section class="connection-saved"><div class="connection-section-heading"><h3>Your connections</h3></div><div class="connection-row"><div><strong>Codex</strong><small>${ready ? escape(`Connected with your Codex account · ${modelCount}${hiddenCount ? ` · ${hiddenCount} Hidden by Codex` : ''}`) : codex.connected ? 'Sign in to Codex, then connect' : codex.lastError ? `Unavailable: ${escape(codex.lastError)}` : 'Not connected · Codex CLI is separate from OpenRouter'}</small>${catalogNote ? `<small id="connection-codex-catalog" role="status">${escape(catalogNote)}</small>` : ''}</div><button type="button" class="button" id="connection-codex-connect" aria-label="${ready ? 'Refresh Codex models' : 'Connect Codex'}">${ready ? 'Refresh models' : 'Connect Codex'}</button></div><p id="connection-native-progress" class="connection-native-progress" role="status" aria-live="polite" data-connecting="${Boolean(nativeConnection?.busy)}"${nativeConnection?'':' hidden'}>${nativeConnection?escape(`${nativeConnection.title} ${nativeConnection.detail}`):''}</p>${codexSection}${providers.map(provider => `<div class="connection-row"><div><strong>${escape(provider.name)}</strong><small>${escape(provider.lastFailure?.message || provider.lastError || (providerModelIssues(provider).length?`${providerModelIssues(provider).length} model${providerModelIssues(provider).length===1?'':'s'} need attention · Edit for details`:null) || (provider.enabled === false ? 'Disabled' : provider.configured ? `${provider.models.length} selected models · saved` : 'Key needed'))}</small></div><button class="button" data-connection-edit="${escape(provider.id)}">Edit</button></div>`).join('')}</section><details id="connection-add-provider" class="connection-add"${addProviderOpen ? ' open' : ''}><summary>Add a provider</summary><p class="connection-section-note">Use an API key, or connect a model server on your computer.</p><div class="connection-provider-grid">${PROVIDER_PRESETS.map(item => `<button type="button" data-connection-new="${escape(item.id)}"><span class="connection-provider-mark" aria-hidden="true">${escape(item.name.slice(0, 1))}</span>${escape(item.name)}<span aria-hidden="true">+</span></button>`).join('')}</div></details><p class="connection-storage-note">${status.secretStorage === 'session' ? 'Keys are saved for this BLACKICE session.' : status.secretStorage === 'encrypted' ? 'Keys are encrypted for your Windows account.' : 'Keys stay on this computer.'}</p></div><footer class="connection-footer"><span id="connection-home-error" role="alert"></span><button class="button" data-connection-done>Done</button></footer>`;
    const addProvider = $('#connection-add-provider'); if (addProvider) addProvider.ontoggle = () => { addProviderOpen = addProvider.open; };
    view.querySelectorAll('[data-connection-new]').forEach(button => button.onclick = () => edit({ preset: button.dataset.connectionNew }));
    const defaultSelect = $('#connection-default-model'); defaultSelect.value = displayedChoice;
    syncDefaultChoice = () => { if (!alive() || $('#connection-default-model') !== defaultSelect) return; const changed = defaultSelect.value !== choice; $('#connection-use-default').disabled = busy || !changed; $('#connection-default-note').textContent = changed ? 'Unsaved choice · use it as the default for new tasks.' : status.defaultModelError || `Saved default: ${connectionDefaultModels(status).find(model => model.value === choice)?.label || choice}`; };
    defaultSelect.onchange = syncDefaultChoice; syncDefaultChoice();
    const codexInput = $('#connection-codex-id'), codexAdd = $('#connection-codex-add'), codexDetails = $('#connection-codex-details');
    codexInput.oninput = () => { codexDraft = codexInput.value; };
    if (codexDetails) codexDetails.ontoggle = () => { codexDetailsOpen = codexDetails.open; };
    const codexTools = $('#connection-codex-tools');
    if (codexTools) codexTools.ontoggle = () => { codexToolsOpen = codexTools.open; };
    const codexSearch = $('#connection-codex-search'), codexRows = [...view.querySelectorAll('[data-codex-model]')];
    const filterNative = () => {
      codexQuery = codexSearch.value;
      const matches = new Set(filterCodexModels([...nativeModels, ...candidates], codexQuery).map(model => model.id || model.model));
      for (const row of codexRows) row.hidden = !matches.has(row.dataset.codexModel);
      $('#connection-codex-empty').hidden = matches.size > 0 || !codexQuery.trim();
      const candidateSection = $('#connection-codex-candidates');
      if (candidateSection) candidateSection.hidden = candidates.length > 0 && !candidates.some(model => matches.has(model.id || model.model));
    };
    codexSearch.oninput = filterNative;
    codexSearch.onkeydown = event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') { event.preventDefault(); return; }
      if (event.key === 'ArrowDown') { const row = codexRows.find(row => !row.hidden); if (row) { event.preventDefault(); row.querySelector?.('summary')?.focus(); } }
    };
    filterNative();
    async function changeCodexModel(method, model) {
      if (busy) return;
      const ownsHome = () => alive() && $('#connection-codex-add') === codexAdd, modelDraft = defaultSelect.value;
      if (typeof model !== 'string' || !model || model.length > 400 || /[\x00-\x20\x7f]/.test(model) || ['codex', 'default'].includes(model) || model.includes('::')) {
        $('#connection-home-error').textContent = 'Enter an exact native Codex model ID, without spaces or a provider prefix.'; revealField(codexInput); return;
      }
      codexDraft = codexInput.value; busy = true; codexAdd.disabled = true; codexInput.disabled = true; defaultSelect.disabled = true; syncDefaultChoice();
      $('#connection-home-error').textContent = ''; $('#connection-codex-receipt').textContent = '';
      try {
        await api('/api/codex/models', method, { model });
        if (!ownsHome()) return;
        if (method === 'POST' && model === codexDraft) codexDraft = '';
        codexDetailsOpen = true;
        await onChanged(); if (!ownsHome()) return;
        if (!await load(modelDraft) || !alive() || !$('#connection-codex-receipt')) return;
        $('#connection-codex-receipt').textContent = method === 'POST' ? 'Model ID saved. Choose it for a task or use it as your default.' : 'Saved ID removed. Your default and existing task choices are unchanged. Advertised models remain listed.';
        revealField($('#connection-codex-id'));
      } catch (cause) {
        if (ownsHome()) $('#connection-home-error').textContent = cause.message;
      } finally {
        busy = false;
        if (ownsHome()) { codexAdd.disabled = false; codexInput.disabled = false; defaultSelect.disabled = false; }
        syncDefaultChoice();
      }
    }
    codexAdd.onclick = () => changeCodexModel('POST', codexInput.value);
    codexInput.onkeydown = event => { if (!event.isComposing && event.keyCode !== 229 && event.key === 'Enter') { event.preventDefault(); return codexAdd.onclick(); } };
    view.querySelectorAll('[data-codex-remove]').forEach(button => { button.onclick = () => changeCodexModel('DELETE', button.dataset.codexRemove); });
    view.querySelectorAll('[data-codex-candidate-add]').forEach(button => { button.onclick = () => changeCodexModel('POST', button.dataset.codexCandidateAdd); });
    const checkButtons = [...view.querySelectorAll('[data-codex-check]')];
    function syncCheckControls() {
      for (const button of checkButtons) button.disabled = busy || !ready || Boolean(checkingModel) || checkBlocked || uncertainCheck;
      codexAdd.disabled = busy; codexInput.disabled = busy; defaultSelect.disabled = busy; syncDefaultChoice();
    }
    checkButtons.forEach(button => { button.onclick = async () => {
      if (busy || checkingModel || checkBlocked || uncertainCheck || !ready) return;
      const model = button.dataset.codexCheck, modelDraft = defaultSelect.value, ownsHome = () => alive() && $('#connection-codex-add') === codexAdd;
      codexDraft = codexInput.value; codexDetailsOpen = true; busy = true; syncCheckControls();
      button.textContent = 'Checking…'; $('#connection-home-error').textContent = ''; $('#connection-codex-receipt').textContent = `Checking ${model}… One bounded native text request; your tasks and default are unchanged.`;
      try {
        const response = await api('/api/codex/models/check', { method: 'POST', body: { model }, timeoutMs: 50000 });
        if (!ownsHome()) return;
        await onChanged(); if (!ownsHome()) return;
        if (!await load(modelDraft) || !alive() || !$('#connection-codex-receipt')) return;
        const latest = (status.codex || status).modelCheck;
        if (!latest || latest.scope !== 'current-connection' || response.result?.scope !== 'current-connection' || !Number.isFinite(Date.parse(latest.checkedAt)) || latest.checkedAt !== response.result.checkedAt || (latest.requestedModel || latest.model) !== (response.result.requestedModel || response.result.model) || latest.status !== response.result.status) {
          $('#connection-codex-receipt').textContent = 'The response does not match the current connection’s saved result. Read check status for the current result; no new check was started.';
        } else $('#connection-codex-receipt').textContent = codexCheckReceipt(response.result);
        focusIfOutside('#connection-codex-read-status');
      } catch (cause) {
        if (ownsHome()) {
          uncertainCheck = cause.uncertain === true || cause.timedOut === true;
          $('#connection-home-error').textContent = `${cause.message}${uncertainCheck ? ' Read check status before checking again; the native request may already have completed.' : ''}`;
          $('#connection-codex-receipt').textContent = ''; button.textContent = 'Try model';
        }
      } finally {
        busy = false;
        if (ownsHome()) syncCheckControls();
        syncDefaultChoice();
      }
    }; });
    $('#connection-codex-read-status').onclick = async () => {
      if (busy) return;
      const readButton = $('#connection-codex-read-status'), ownsHome = () => alive() && $('#connection-codex-read-status') === readButton, modelDraft = defaultSelect.value;
      codexDraft = codexInput.value; busy = true; readButton.disabled = true; syncCheckControls();
      try {
        await api('/api/codex/models');
        if (!ownsHome()) return;
        uncertainCheck = false;
        if (!await load(modelDraft) || !alive() || !$('#connection-codex-receipt')) return;
        const latest = (status.codex || status).modelCheck;
        $('#connection-codex-receipt').textContent = latest ? codexCheckReceipt(latest) : 'No model check result is saved for the current connection. No inference was started.';
        focusIfOutside('#connection-codex-read-status');
      } catch (cause) { if (ownsHome()) { $('#connection-home-error').textContent = cause.message; $('#connection-codex-receipt').textContent = ''; } }
      finally { busy = false; if (ownsHome()) { readButton.disabled = false; syncCheckControls(); } syncDefaultChoice(); }
    };
    view.querySelectorAll('[data-connection-edit]').forEach(button => button.onclick = () => edit(providers.find(provider => provider.id === button.dataset.connectionEdit)));
    $('[data-connection-done]').onclick = closeModal;
    $('#connection-codex-connect').onclick = async () => {
      if (busy) return;
      const button = $('#connection-codex-connect'), modelDraft = $('#connection-default-model').value;
      const ownsHome = () => alive() && $('#connection-codex-connect') === button;
      busy = true; button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = ready ? 'Refreshing models…' : 'Connecting…'; $('#connection-home-error').textContent = '';
      const progress = $('#connection-native-progress'); progress.hidden = false; progress.dataset.connecting = 'true'; progress.textContent = ready ? 'Refreshing your Codex account and model list…' : 'Connecting to your local Codex runtime…';
      try {
        const connected = await api('/api/runtime/reconnect', 'POST', {});
        if (!ownsHome()) return;
        await onChanged(); if (!ownsHome()) return;
        await load(modelDraft); if (!alive()) return;
        const native = connected.codex || connected;
        if (!native.connected || !native.authenticated) $('#connection-home-error').textContent = native.lastError || native.error || 'Codex is not ready. Sign in to Codex, then connect again.';
        else if (native.modelCatalog?.error) $('#connection-home-error').textContent = native.modelCatalog.error;
        else toast(ready ? 'Codex models refreshed.' : 'Codex connected.');
      } catch (cause) {
        if (!ownsHome()) return;
        // Refresh errors can still carry a confirmed account change. Reload the
        // status while keeping this form's unsaved default selection.
        try { await load(modelDraft); } catch { /* The original action error remains the useful explanation. */ }
        if (alive() && $('#connection-home-error')) $('#connection-home-error').textContent = cause.message;
      }
      finally { busy = false; if (alive() && $('#connection-codex-connect') === button) { button.disabled = false; button.setAttribute('aria-busy', 'false'); button.textContent = ready ? 'Refresh models' : 'Connect Codex'; progress.dataset.connecting = 'false'; } syncDefaultChoice(); }
    };
    $('#connection-use-default').onclick = async () => {
      if (busy || $('#connection-default-model').value === choice) return; const button = $('#connection-use-default'), model = $('#connection-default-model').value; busy = true; button.disabled = true;
      try { await api('/api/models/default', 'POST', { model }); if (!alive()) return; await onChanged(); await load(); toast('Default model saved.'); }
      catch (cause) { if (alive()) $('#connection-home-error').textContent = cause.message; }
      finally { busy = false; syncDefaultChoice(); }
    };
    focusIfOutside('#connection-default-model');
  }
  function edit(provider = {}) {
    if (!alive() || busy) return; generation++; catalogRequest++; clearTimeout(searchTimer);
    existing = Boolean(provider.id); preset = presetFor(provider); selected = { ...provider, type: provider.type || preset.type, id: provider.id || `${preset.id}-${crypto.randomUUID().slice(0, 8)}` };
    selection = createProviderModelSelection(provider.models || []); catalog = null;
    const custom = preset.id === 'compatible';
    const protocolField = `<label>Protocol<select name="type"${custom ? '' : ' disabled'}>${[['compatible','Chat Completions'],['openai','OpenAI Responses'],['anthropic','Anthropic Messages']].map(([value,label]) => `<option value="${value}"${selected.type === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
    const addressField = `<label>API address<input name="baseUrl" type="url" required spellcheck="false" placeholder="https://your-api.example/v1" value="${escape(provider.baseUrl || preset.baseUrl)}"></label>`;
    view.innerHTML = `<form id="connection-form" class="connection-form"><div class="connection-editor-top"><button type="button" class="button subtle" id="connection-back">${icon('chevron', 12)}Back</button><label><span class="sr-only">Provider</span><select id="connection-preset" aria-label="Provider"${existing ? ' disabled' : ''}>${PROVIDER_PRESETS.map(item => `<option value="${escape(item.id)}"${item.id === preset.id ? ' selected' : ''}>${escape(item.name)}</option>`).join('')}</select></label></div><div class="connection-editor-body"><section class="connection-setup-stage" aria-labelledby="connection-stage-connect"><div class="connection-stage-heading"><span aria-hidden="true">1</span><div><h3 id="connection-stage-connect">Connect ${escape(preset.name)}</h3><p>${provider.hasApiKey?'Your API key is saved. Leave it blank to keep it.':preset.requiresApiKey?'Add your API key to find the models available to you.':'Keep your local model server running, then find its models.'}</p></div></div>${custom ? `<div class="connection-custom-basics">${addressField}${protocolField}</div>` : ''}<div class="connection-key-row"><div class="connection-key-label"><label for="connection-key">API key${preset.requiresApiKey ? '' : ' · optional'}</label>${preset.keyUrl?`<a href="${escape(preset.keyUrl)}" target="_blank" rel="noopener noreferrer">Get an API key ↗</a>`:preset.docsUrl?`<a href="${escape(preset.docsUrl)}" target="_blank" rel="noopener noreferrer">Server setup ↗</a>`:''}</div><div><input id="connection-key" aria-describedby="connection-key-error connection-save-note" name="apiKey" type="password" autocomplete="new-password" maxlength="20000" placeholder="${provider.hasApiKey ? 'Saved · leave blank to keep' : preset.requiresApiKey ? 'Enter your API key' : 'Leave blank for a local server'}"><button class="button" type="button" id="connection-find">${icon('search', 13)}Connect &amp; find models</button></div><p id="connection-key-error" class="connection-error" role="alert"></p><p id="connection-save-note" class="connection-field-note">Find and test save your connection settings before checking the provider.</p></div></section><section class="connection-selection-stage" aria-labelledby="connection-stage-models"><div class="connection-stage-heading"><span aria-hidden="true">2</span><div><h3 id="connection-stage-models">Choose your models</h3><p>Select the models you want available in BLACKICE.</p></div></div><div class="connection-model-heading"><label for="connection-model-search">Models <span id="connection-selected-count"></span></label><input id="connection-model-search" type="search" placeholder="Search models…" aria-label="Search provider models" autocomplete="off"></div><div id="connection-selected" class="connection-selected" aria-label="Selected models"></div><div id="connection-catalog" class="connection-catalog" aria-label="Available models"></div><div id="connection-pagination" class="connection-pagination"></div><details class="connection-manual"><summary>Enter a model ID</summary><div><label class="sr-only" for="connection-manual-model">Exact model ID</label><input id="connection-manual-model" placeholder="Exact model ID" spellcheck="false"><button type="button" class="button" id="connection-add-model">Add</button></div></details></section><details class="connection-advanced"><summary>Advanced connection settings</summary><div class="connection-advanced-fields"><label>Name<input name="name" maxlength="100" required value="${escape(provider.name || preset.name)}"></label>${custom ? '' : `${protocolField}${addressField}`}<div class="connection-limit-row"><label>Output limit<input name="maxTokens" type="number" min="1" max="128000" value="${Number(provider.maxTokens) || 8192}"></label><label>Maximum steps<input name="maxSteps" type="number" min="1" step="1" placeholder="No app limit" value="${provider.maxSteps == null ? '' : Number(provider.maxSteps)}" aria-describedby="connection-step-note"></label></div><small id="connection-step-note">Blank removes the tool-step limit.</small><details class="connection-model-capacities"><summary>Context capacities</summary><label>Model ID = maximum tokens<textarea name="capacities" rows="3" spellcheck="false" placeholder="model-id = 900000">${escape(capacityLines(selection.selected()))}</textarea></label><p>Omitted models keep their capacity. Use model-id = unknown to clear one.</p></details><details class="connection-header-settings"><summary>Request headers</summary><p id="connection-header-status">${provider.hasHeaders ? `Saved: ${escape((provider.headerNames || []).join(', '))}. Values stay hidden.` : 'Optional for API gateways.'}</p><label>Replacement headers<textarea name="headers" rows="3" autocomplete="off" spellcheck="false" placeholder="api-version: 2026-01-01"></textarea></label><p>Blank keeps saved headers.</p><label class="connection-checkbox"><input name="clearHeaders" type="checkbox">Remove saved headers</label></details><label class="connection-checkbox"><input name="enabled" type="checkbox"${provider.enabled === false ? '' : ' checked'}>Use this connection</label>${existing ? '<button class="button subtle" id="connection-remove" type="button">Remove connection</button>' : ''}</div></details><p id="connection-receipt" class="connection-receipt" role="status"></p><p id="connection-error" class="connection-error" role="alert"></p></div><footer class="connection-footer"><button type="button" class="button" id="connection-test">Save &amp; test connection</button><button class="button primary" type="submit">Save selected models</button></footer></form>`;
    const form = $('#connection-form');
    $('#connection-back').onclick = renderHome;
    $('#connection-preset').onchange = event => edit({ preset: event.target.value });
    form.onsubmit = async event => { event.preventDefault(); await act('save', form); };
    $('#connection-find').onclick = () => act('find', form); $('#connection-test').onclick = () => act('test', form);
    $('#connection-model-search').oninput = () => { catalogRequest++; clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (current(form)) findPage(form, 0); }, 250); };
    $('#connection-model-search').onkeydown = event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchTimer); return findPage(form, 0); }
      if (event.key === 'ArrowDown') { const input = [...view.querySelectorAll('[data-model-id]')].find(input => !input.checked); if (input) { event.preventDefault(); input.focus(); } }
    };
    $('#connection-add-model').onclick = () => { try { selection.addManual($('#connection-manual-model').value); $('#connection-manual-model').value = ''; error(''); renderCatalog(); } catch (cause) { error(cause.message, 'manual-model'); } };
    $('#connection-manual-model').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('#connection-add-model').click(); } };
    if (existing) $('#connection-remove').onclick = () => act('remove', form);
    form.addEventListener?.('invalid', event => revealField(event.target), true);
    renderCatalog(); if (custom && !provider.baseUrl) form.elements.baseUrl.focus(); else if (provider.hasApiKey || existing && !preset.requiresApiKey) $('#connection-model-search').focus(); else $('#connection-key').focus();
  }
  function renderCatalog() {
    const form = $('#connection-form'); if (!form || !alive()) return;
    const focusedModel = document.activeElement?.dataset?.modelId;
    const decorate=models=>models.map(model=>({...model,lastFailure:selected.modelChecks?.[model.id]?.lastFailure})), chosen = decorate(selection.selected()), page = decorate(selection.page());
    $('#connection-selected-count').textContent = `${chosen.length} / 200 selected`;
    $('#connection-selected').innerHTML = chosen.length ? `<div class="connection-selected-label">Selected</div>${renderProviderModelRows(chosen, { escape, selected: true })}` : '';
    $('#connection-catalog').innerHTML = page.filter(model => !chosen.some(item => item.id === model.id)).length ? renderProviderModelRows(page.filter(model => !chosen.some(item => item.id === model.id)), { escape }) : `<p>${catalog ? catalog.total ? 'No other models on this page.' : 'No matching models. Try a model name or ID.' : 'Connect above to load models, or enter an exact model ID below.'}</p>`;
    $('#connection-pagination').innerHTML = catalog ? `<button type="button" class="button subtle" id="connection-page-prev"${catalog.offset > 0 ? '' : ' disabled'}>Previous</button><span>${catalog.total ? `${Math.min(catalog.offset + 1, catalog.total)}–${catalog.offset + page.length} of ${catalog.total}` : 'No matches'}</span><button type="button" class="button subtle" id="connection-page-next"${catalog.hasMore ? '' : ' disabled'}>Next</button>` : '';
    for (const input of view.querySelectorAll('[data-model-id]')) input.onchange = () => { try { selection.toggle(input.dataset.modelId, input.checked); error(''); } catch (cause) { input.checked = false; error(cause.message); } renderCatalog(); };
    if (focusedModel) ([...view.querySelectorAll('[data-model-id]')].find(input => input.dataset.modelId === focusedModel) || $('#connection-model-search'))?.focus({ preventScroll: true });
    if (catalog) { $('#connection-page-prev').onclick = () => findPage(form, Math.max(0, catalog.offset - 100)); $('#connection-page-next').onclick = () => findPage(form, catalog.offset + 100); }
  }
  async function findPage(form, offset = 0) {
    if (!current(form)) return;
    if (!selected.saved && !existing) { receipt('Connect the provider above to find models.'); return; }
    const version = ++catalogRequest, query = $('#connection-model-search').value.trim();
    receipt('Finding models…', true); $('#connection-catalog').setAttribute?.('aria-busy', 'true');
    try {
      const result = await api(`/api/providers/${encodeURIComponent(selected.id)}/models`, 'POST', { query, offset, limit: 100 });
      if (!current(form) || version !== catalogRequest || query !== $('#connection-model-search').value.trim()) return;
      selection.setPage(result.models || []); catalog = { ...result, offset: Number(result.offset) || offset, total: result.total ?? result.models?.length ?? 0 };
      renderCatalog(); receipt('Connection saved. Choose models, then save your selection.');
    } catch (cause) { if (current(form) && version === catalogRequest) { error(cause.message); receipt('Catalog unavailable. Your selections are kept.'); } }
    finally { if (current(form) && version === catalogRequest) $('#connection-catalog').setAttribute?.('aria-busy', 'false'); }
  }
  async function act(action, form) {
    if (busy || !current(form) || !form.reportValidity()) return;
    let models;
    try { models = selection.forSave(form.elements.capacities.value); }
    catch (cause) { error(cause.message, 'capacities'); return; }
    if (action === 'save' && form.elements.enabled.checked && !models.length) { error('Select at least one model, or enter its ID.', 'model-search'); return; }
    let headers;
    try { headers = providerHeadersForSave(form.elements.headers.value, form.elements.clearHeaders.checked); } catch (cause) { error(cause.message, 'headers'); return; }
    const key = form.elements.apiKey.value.trim();
    if (action !== 'remove' && preset.requiresApiKey && !key && !selected.hasApiKey) { error('Enter an API key for this provider.', 'apiKey'); return; }
    busy = true; error(''); receipt(action === 'remove' ? 'Removing connection…' : 'Saving connection…', true); form.dataset.connecting = 'true'; const controls = [...form.querySelectorAll('input,select,textarea,button')]; controls.forEach(control => control.disabled = true);
    try {
      if (action === 'remove') { await api(`/api/providers/${encodeURIComponent(selected.id)}`, 'DELETE', {}); if (!current(form)) return; await onChanged(); await load(); toast('Connection removed.'); return; }
      const value = { id: selected.id, preset: preset.id, type: form.elements.type.value, name: form.elements.name.value.trim(), baseUrl: form.elements.baseUrl.value.trim(), models, enabled: form.elements.enabled.checked, maxTokens: Number(form.elements.maxTokens.value), maxSteps: form.elements.maxSteps.value.trim() ? Number(form.elements.maxSteps.value) : null, ...(key ? { apiKey: key } : {}), ...(headers !== undefined ? { headers } : {}) };
      const saved = await api('/api/providers', 'POST', value); if (!current(form)) return;
      selected = { ...saved, saved: true }; form.elements.apiKey.value = ''; form.elements.headers.value = ''; form.elements.clearHeaders.checked = false; $('#connection-header-status').textContent = saved.hasHeaders ? `Saved: ${(saved.headerNames || []).join(', ')}. Values stay hidden.` : 'Optional for API gateways.'; form.elements.apiKey.placeholder = saved.hasApiKey ? 'Saved · leave blank to keep' : 'Optional'; $('#connection-find').textContent = 'Save & refresh models';
      await onChanged(); if (!current(form)) return;
      if (action === 'find') await findPage(form);
      else if (action === 'test') { receipt('Checking the provider connection…', true); const result = await api(`/api/providers/${encodeURIComponent(selected.id)}/test`, 'POST', {}); if (current(form)) receipt(result.credentialVerified === true ? 'Connection saved · key verified.' : 'Connection saved · catalog reachable; key not verified.'); }
      else { await load(); toast('Models saved.'); }
    } catch (cause) { if (current(form)) { receipt(''); error(cause.message); } }
    finally { busy = false; if (current(form)) { form.dataset.connecting = 'false'; $('#connection-receipt').dataset.connecting = 'false'; controls.forEach(control => control.disabled = false); $('#connection-preset').disabled = existing; form.elements.type.disabled = preset.id !== 'compatible'; renderCatalog(); } }
  }
  try { await load(); } catch (cause) { if (alive()) view.innerHTML = `<p class="connection-error" role="alert">${escape(cause.message)}</p><button class="button" id="connection-retry">Try again</button>`; const retry = $('#connection-retry'); if (retry) retry.onclick = () => load().catch(error => toast(error.message, true)); focusIfOutside('#connection-retry'); }
}
