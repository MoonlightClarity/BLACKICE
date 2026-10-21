import { codexModelAccessLabel, codexModelAccessDetails, codexModelLifecycleLabel } from './connection-models.mjs';
import { modelRouteMetadata, isChatModeModel } from './model-routes.mjs';
const CONNECT = '__connections__';
const compactName = (value, label = value) => {
  const text = String(label || value || '').replace(/^Default\s*·\s*/i, '').replace(/^Codex\s*·\s*/i, '');
  return text === value && String(value).includes('::') ? text.slice(text.indexOf('::') + 2) : text;
};

/** Preserve model IDs and the inherited default; display names never become routing keys. */
export function modelPickerChoices(models = [], status = {}, selected = 'default') {
  const providers = new Map((status.providers || []).map(provider => [provider.id, provider]));
  const providerName = id => id === 'codex' ? 'Codex' : providers.get(id)?.name || providers.get(id)?.displayName || (id === 'chatgpt' ? 'ChatGPT' : id) || 'Provider';
  const selectedEntry = (status.models || []).find(entry => entry.id === selected || entry.model === selected);
  const choices = models.filter(model => model.value !== CONNECT && (!isChatModeModel(model.value, status) || model.value === selected || model.value === 'default')).map(model => {
    const inherited = model.value === 'default', provider = model.provider || 'codex';
    const choiceValue = !inherited && selected !== 'default' && provider === 'codex' && selectedEntry && (selectedEntry.id === model.value || selectedEntry.model === model.value) ? selected : model.value;
    const value = inherited ? status.defaultModel || '' : choiceValue;
    const entry = (status.models || []).find(candidate => candidate.id === value || candidate.model === value);
    const route = modelRouteMetadata({ ...entry, ...model, id: value }, status);
    const name = route.routeLabel || compactName(value, entry ? entry.displayName || entry.model || entry.id : inherited ? model.label : model.label || value) || 'Choose a model';
    const hidden = provider === 'codex' && (entry?.hidden ?? model.hidden) === true;
    const custom = provider === 'codex' && (entry?.source ?? model.source) === 'custom';
    const access = provider === 'codex' ? entry?.access ?? model.access ?? { state: 'unverified' } : undefined;
    const lifecycle = provider === 'codex' ? entry?.lifecycle ?? model.lifecycle : undefined, lifecycleLabel = codexModelLifecycleLabel({ lifecycle });
    const notice = provider === 'codex' ? entry?.availabilityNux?.message ?? model.availabilityNux?.message : undefined;
    const modalities = provider === 'codex' ? entry?.inputModalities ?? model.inputModalities : undefined;
    const providerLabel = providerName(provider), failure = model.error || route.availabilityReason || providers.get(provider)?.lastFailure?.message || '';
    return { value: choiceValue, modelId: value, ...(entry?.model && entry.model !== value ? { routingId: entry.model } : {}), name, provider, providerLabel, inherited, available: model.available === true,
      ...route, label: inherited ? 'Use default' : name,
      detail: `${inherited ? `${name} · ${providerLabel}` : providerLabel}${hidden ? ' · Hidden by Codex' : custom ? ' · Custom model ID' : ''}${lifecycleLabel ? ` · ${lifecycleLabel}` : ''}`,
      ...(lifecycle ? { lifecycle, lifecycleLabel } : {}),
      ...(access ? { access, accessLabel: codexModelAccessLabel({ access }) } : {}),
      ...(custom ? { source: 'custom' } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(typeof notice === 'string' ? { availabilityNux: { message: notice } } : {}),
      ...(Array.isArray(modalities) ? { inputModalities: modalities.filter(value => typeof value === 'string') } : {}),
      unavailable: failure || `Connect ${providerLabel} to use this model.` };
  });
  if (!choices.some(choice => choice.value === selected)) {
    const provider = String(selected).includes('::') ? selected.split('::')[0] : 'codex', route = modelRouteMetadata({ id: selected, available: false }, status), name = route.routeLabel || compactName(selected);
    choices.push({ value: selected, modelId: selected, name, label: name, provider, providerLabel: providerName(provider), detail: providerName(provider), inherited: false, available: false, ...route, unavailable: route.availabilityReason || 'This saved model is not connected. Open Models to reconnect it.' });
  }
  return choices;
}

export function filterModelChoices(choices, query = '') {
  const normalize = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  return choices.filter(choice => tokens.every(token => normalize(`${choice.value} ${choice.name} ${choice.label} ${choice.providerLabel} ${choice.detail || ''} ${choice.accessLabel || ''} ${choice.availabilityNux?.message || ''} ${choice.inherited ? 'default' : ''} ${choice.experimental ? 'experimental' : ''} ${choice.availabilityLabel || ''}`).includes(token)));
}

export function modelPickerPosition({ anchor, width, height, viewportWidth, viewportHeight, margin = 12 }) {
  const left = Math.max(margin, Math.min(anchor.left, viewportWidth - width - margin));
  const above = anchor.top - margin, below = viewportHeight - anchor.bottom - margin;
  const top = above >= height || above > below ? Math.max(margin, anchor.top - height - 7) : Math.min(viewportHeight - height - margin, anchor.bottom + 7);
  return { left, top: Math.max(margin, top) };
}

/** Enhance a native select. Its existing change handler owns persistence and validation. */
export function initModelPicker({ select, owner = select?.parentElement, onConnect }) {
  if (!select || select.tagName !== 'SELECT' || !owner || !document.body) return { update() {}, close() {}, destroy() {} };
  const doc = select.ownerDocument || document, create = (tag, className, text) => { const element = doc.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const wasHidden = select.hidden, button = create('button', 'model-picker-button'), info = create('span', 'model-picker-button-info'), name = create('span', 'model-picker-name'), metaLine = create('span', 'model-picker-meta-line'), meta = create('span', 'model-picker-meta'), badge = create('span', 'model-picker-experimental', 'Experimental'), chevron = create('span', 'model-picker-chevron', '⌄');
  badge.hidden = true; metaLine.append(badge, meta); button.type = 'button'; button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false'); info.append(name, metaLine); chevron.setAttribute('aria-hidden', 'true'); button.append(info, chevron);
  const panel = create('div', 'model-picker-panel model-picker-compact'), search = create('input', 'model-picker-search'), list = create('div', 'model-picker-list'), empty = create('p', 'model-picker-empty', 'No matching models. Try a name or provider.'), catalogNotice = create('p', 'model-picker-status'), observation = create('details', 'model-picker-observation'), observationSummary = create('summary'), observationBody = create('div', 'model-picker-observation-body'), connect = create('button', 'model-picker-connect', '+ Connect a provider');
  const id = `${select.id || 'relay-model'}-picker`;
  panel.id = id; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Choose a model'); button.setAttribute('aria-controls', id);
  search.type = 'search'; search.maxLength = 200; search.placeholder = 'Search models or providers'; search.autocomplete = 'off'; search.setAttribute('aria-label', 'Search models or providers'); search.setAttribute('role', 'combobox'); search.setAttribute('aria-autocomplete', 'list'); search.setAttribute('aria-expanded', 'false'); search.setAttribute('aria-controls', `${id}-list`);
  list.id = `${id}-list`; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Models'); empty.hidden = true; empty.setAttribute('role', 'status'); catalogNotice.hidden = true; catalogNotice.setAttribute('role', 'status'); observation.hidden = true; observation.append(observationSummary, observationBody); connect.type = 'button'; panel.append(search, catalogNotice, list, empty, observation, connect);
  // Fit the actual result rows. The shared theme has a fixed list basis which
  // otherwise reserves empty space even after the user filters to one model.
  list.style.flex = '0 1 auto';
  select.hidden = true; owner.classList.add('has-model-picker'); owner.append(button); doc.body.append(panel);
  let choices = [], selected = select.value, activeValue = null, visible = [], opened = false, disposed = false, catalogSignature = '', observationSignature = '', observationValue = null, optionNodes = new Map();
  function position() {
    if (!opened) return;
    const anchor = button.getBoundingClientRect(), margin = 12, gap = 7;
    const availableHeight = Math.max(anchor.top - margin - gap, window.innerHeight - anchor.bottom - margin - gap);
    panel.style.width = `${Math.max(0, Math.min(460, window.innerWidth - 24))}px`;
    panel.style.maxHeight = `${Math.max(0, Math.min(480, window.innerHeight - 24, availableHeight))}px`;
    const rect = panel.getBoundingClientRect(), point = modelPickerPosition({ anchor, width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    panel.style.left = `${point.left}px`; panel.style.top = `${point.top}px`;
  }
  function highlight(value, scroll = false) {
    activeValue = value;
    for (const [key, option] of optionNodes) option.classList.toggle('is-active', key === value);
    const active = optionNodes.get(value); if (active) search.setAttribute('aria-activedescendant', active.id); else search.removeAttribute('aria-activedescendant');
    refreshObservation(choices.find(choice => choice.value === value));
    position();
    if (scroll) active?.scrollIntoView?.({ block: 'nearest' });
  }
  function refreshObservation(choice) {
    const result = choice?.provider === 'codex' ? codexModelAccessDetails(choice) : null;
    const notice = choice?.availabilityNux?.message;
    const identity = JSON.stringify([choice?.value, choice?.modelId, choice?.routingId]);
    const signature = JSON.stringify([identity, choice?.name, result, notice]);
    if (signature === observationSignature) return;
    observationSignature = signature;
    if (observationValue !== identity) observation.open = false;
    observationValue = identity;
    observation.hidden = !result && !notice;
    if (observation.hidden) {
      if (observation.contains(doc.activeElement) && opened) search.focus({ preventScroll: true });
      observation.open = false; observationBody.replaceChildren(); return;
    }
    observation.setAttribute('aria-label', `Model details for ${choice.name}`);
    observationSummary.textContent = result?.label || 'Model details';
    const entries = [['Model ID', choice.modelId || choice.value], ...(choice.routingId ? [['Endpoint model ID', choice.routingId]] : []), ...(result?.entries || []), ...(notice ? [['Codex notice', notice]] : [])];
    const definition = create('dl');
    for (const [label, value] of entries) { const row = create('div'); row.append(create('dt', '', label), create('dd', '', value)); definition.append(row); }
    observationBody.replaceChildren(definition);
    if (result) observationBody.append(create('p', '', result.note));
  }
  function renderList() {
    visible = filterModelChoices(choices, search.value); list.replaceChildren(); optionNodes = new Map();
    const groups = new Map();
    for (const choice of visible) { const key = choice.inherited ? '__default__' : choice.provider; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(choice); }
    let index = 0;
    for (const [provider, entries] of groups) {
      const group = create('div', 'model-picker-group'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', provider === '__default__' ? 'Default model' : entries[0].providerLabel);
      for (const choice of entries) {
        const option = create('button', 'model-picker-option'); option.type = 'button'; option.tabIndex = -1; option.id = `${id}-option-${index++}`; option.dataset.modelValue = choice.value; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(choice.value === selected));
        option.title = [choice.label, choice.detail, choice.modelId || choice.value, !choice.available ? choice.unavailable : ''].filter(Boolean).join('\n');
        if (!choice.available) { option.classList.add('is-unavailable'); option.setAttribute('aria-description', `${choice.unavailable} Activate to open Models.`); }
        const text = create('span', 'model-picker-option-info'), title = create('span', 'model-picker-option-name', choice.label), detail = create('span', 'model-picker-option-detail', choice.availabilityLabel || (choice.available ? choice.detail : `${choice.detail} · Connect`)), check = create('span', 'model-picker-check', choice.value === selected ? '✓' : ''); check.setAttribute('aria-hidden', 'true');
        text.append(title, detail);
        if (choice.experimental) { option.classList.add('is-experimental'); text.append(create('span', 'model-picker-experimental', 'Experimental')); }
        option.append(text, check); group.append(option); optionNodes.set(choice.value, option);
      }
      list.append(group);
    }
    empty.hidden = visible.length > 0;
    highlight(visible.some(choice => choice.value === activeValue) ? activeValue : visible.find(choice => choice.value === selected)?.value ?? visible[0]?.value ?? null);
  }
  function close({ restoreFocus = true } = {}) {
    if (!opened) return; const ownsFocus = panel.contains(doc.activeElement); opened = false; panel.hidden = true; button.setAttribute('aria-expanded', 'false'); search.setAttribute('aria-expanded', 'false');
    if (restoreFocus && ownsFocus && !disposed && button.isConnected) button.focus({ preventScroll: true });
  }
  function open() {
    if (disposed || select.disabled) return;
    if (opened) { close(); return; }
    opened = true; search.value = ''; activeValue = selected; panel.hidden = false; button.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-expanded', 'true'); renderList(); search.focus({ preventScroll: true });
  }
  function commit(value) {
    if (disposed || select.disabled || !opened) return;
    const choice = choices.find(item => item.value === value); if (value !== CONNECT && !choice) return;
    // Disconnected entries explain the problem and lead to setup; they never replace a working preference.
    const next = value === CONNECT || !choice.available ? CONNECT : value;
    close();
    if (next === CONNECT && onConnect) { onConnect(choice); return; }
    if (select.options && ![...select.options].some(option => option.value === next)) return;
    select.value = next;
    if (select.value !== next) return; // A newer native catalog may have removed this entry.
    selected = next; refreshButton();
    const ChangeEvent = doc.defaultView?.Event || Event; select.dispatchEvent(new ChangeEvent('change', { bubbles: true }));
  }
  const onButton = event => { event.preventDefault(); open(); };
  const onInput = () => renderList();
  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.target !== search) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (activeValue !== null) commit(activeValue); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !visible.length) return;
    // Home and End retain normal text editing unless a modifier explicitly requests list navigation.
    if ((event.key === 'Home' || event.key === 'End') && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault(); const current = visible.findIndex(choice => choice.value === activeValue), index = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : event.key === 'ArrowDown' ? (current + 1) % visible.length : (current - 1 + visible.length) % visible.length; highlight(visible[index].value, true);
  };
  const onButtonKey = event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); if (!opened) open(); } };
  const onListClick = event => { const option = event.target.closest?.('[data-model-value]'); if (option && list.contains(option)) { event.preventDefault(); commit(option.dataset.modelValue); } };
  const onConnectClick = event => { event.preventDefault(); commit(CONNECT); };
  const onOutside = event => { if (opened && !panel.contains(event.target) && !button.contains(event.target)) close({ restoreFocus: false }); };
  const onFocus = event => { if (opened && !panel.contains(event.target) && !button.contains(event.target)) close({ restoreFocus: false }); };
  const onScroll = event => { if (opened && !panel.contains(event.target)) close(); };
  button.addEventListener('click', onButton); button.addEventListener('keydown', onButtonKey); search.addEventListener('input', onInput); panel.addEventListener('keydown', onKey); list.addEventListener('click', onListClick); observation.addEventListener('toggle', position); connect.addEventListener('click', onConnectClick);
  doc.addEventListener('pointerdown', onOutside, true); doc.addEventListener('focusin', onFocus, true); doc.addEventListener('scroll', onScroll, true); window.addEventListener('resize', position);
  function refreshButton() {
    const choice = choices.find(item => item.value === selected); name.textContent = choice?.name || selected; badge.hidden = choice?.experimental !== true; meta.textContent = choice ? `${choice.inherited ? 'Default · ' : ''}${choice.availabilityLabel || choice.providerLabel}${choice.hidden ? ' · Hidden by Codex' : choice.source === 'custom' ? ' · Custom ID' : ''}${choice.available || choice.availabilityLabel ? '' : ' · Connect'}` : 'Choose model';
    button.disabled = select.disabled; button.title = [select.title || '', choice?.lifecycleLabel || '', choice?.availabilityReason || ''].filter(Boolean).join(' · '); if (choice?.lifecycleLabel) meta.textContent += ` · ${choice.lifecycleLabel}`; button.setAttribute('aria-label', `Model: ${name.textContent}. ${choice?.experimental ? 'Experimental. ' : ''}${meta.textContent}. Change model`);
  }
  return {
    update({ models = [], status = {}, selected: next = select.value, choices: customChoices } = {}) {
      if (disposed) return; selected = next; const nextChoices = customChoices || modelPickerChoices(models, status, selected), signature = JSON.stringify([nextChoices, selected]); choices = nextChoices;
      const catalog = status.codex?.modelCatalog || status.modelCatalog || {};
      const nextNotice = catalog.refreshing ? 'Updating models…' : catalog.error ? 'Model list could not refresh. Saved choices are shown.' : '', noticeChanged = catalogNotice.textContent !== nextNotice;
      if (noticeChanged) { catalogNotice.textContent = nextNotice; catalogNotice.hidden = !nextNotice; }
      list.setAttribute('aria-busy', String(catalog.refreshing === true));
      refreshButton();
      if (select.disabled) close();
      if (signature !== catalogSignature) { catalogSignature = signature; if (opened) renderList(); }
      else if (noticeChanged && opened) position();
    },
    close,
    destroy() {
      disposed = true; close({ restoreFocus: false }); button.remove(); panel.remove(); select.hidden = wasHidden; owner.classList.remove('has-model-picker');
      button.removeEventListener('click', onButton); button.removeEventListener('keydown', onButtonKey); search.removeEventListener('input', onInput); panel.removeEventListener('keydown', onKey); list.removeEventListener('click', onListClick); observation.removeEventListener('toggle', position); connect.removeEventListener('click', onConnectClick);
      doc.removeEventListener('pointerdown', onOutside, true); doc.removeEventListener('focusin', onFocus, true); doc.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', position);
    },
  };
}
