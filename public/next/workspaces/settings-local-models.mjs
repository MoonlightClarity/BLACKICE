/** Local model management lives in the main Models section, not the advanced API editor. */
export function createLocalModelSettings({ mount, api, onChanged = () => {} } = {}) {
  const doc = mount.ownerDocument;
  const node = (tag, value = '', css = '') => {
    const el = doc.createElement(tag);
    if (css) el.className = css;
    el.textContent = value;
    return el;
  };
  const label = (name, control) => { const el = node('label', name, 'next-label'); el.append(control); return el; };
  const button = name => { const el = node('button', name); el.type = 'button'; return el; };
  const card = node('section', '', 'next-card next-stack');
  card.setAttribute('aria-label', 'Local model loading');
  card.append(node('h2', 'Local models'),
    node('p', 'Load and unload models on this computer with Ollama or LM Studio. Import GGUF files or Safetensors model folders through Ollama without a quantization step. Once loaded, models appear in the normal BLACKICE model picker.', 'next-help'));
  const row = node('div', '', 'next-row');
  const engine = node('select', '', 'next-field');
  for (const [id, name] of [['ollama', 'Ollama'], ['lmstudio', 'LM Studio']]) {
    const option = node('option', name); option.value = id; engine.append(option);
  }
  engine.id = 'next-local-engine';
  const refresh = button('Refresh local models'); refresh.id = 'next-local-refresh';
  row.append(label('Runtime', engine), refresh);
  const runtimeStatus = node('p', 'Checking local runtimes…', 'next-help');
  runtimeStatus.id = 'next-local-runtime-status'; runtimeStatus.setAttribute('role', 'status');
  const choiceRow = node('div', '', 'next-row');
  const models = node('select', '', 'next-field'); models.id = 'next-local-model'; models.style.flex = '1'; models.style.minWidth = '180px';
  const load = button('Load & add to BLACKICE'); load.id = 'next-local-load'; load.className = 'next-primary';
  const unload = button('Unload'); unload.id = 'next-local-unload';
  choiceRow.append(label('Local model', models), load, unload);
  const context = node('input', '', 'next-field'); context.type = 'number'; context.min = '128'; context.max = '262144';
  context.placeholder = 'Runtime default'; context.id = 'next-local-context'; context.style.maxWidth = '180px';
  const contextHelp = node('p', 'Optional context window for the next load. Leave blank to use the runtime default. Unloading does not delete model files or BLACKICE conversations.', 'next-help');
  const importDetails = node('details', '', 'next-provider-advanced');
  const summary = node('summary', 'Import local weights into Ollama');
  const importHelp = node('p', 'Select an existing .gguf file or a folder with config.json and .safetensors files. Enter its absolute path; the source precision is not deliberately reduced. Supported architectures depend on your Ollama version.', 'next-help');
  const sourcePath = node('input', '', 'next-field'); sourcePath.type = 'text'; sourcePath.id = 'next-local-source-path'; sourcePath.placeholder = 'C:\\Models\\my-model or /home/me/models/my-model'; sourcePath.spellcheck = false;
  const alias = node('input', '', 'next-field'); alias.id = 'next-local-import-name'; alias.placeholder = 'my-local-model'; alias.spellcheck = false;
  const importButton = button('Import & load'); importButton.id = 'next-local-import'; importButton.className = 'next-primary';
  const importRow = node('div', '', 'next-row'); importRow.append(importButton);
  importDetails.append(summary, importHelp, label('Model file or directory', sourcePath), label('Local Ollama model name', alias), importRow);
  const feedback = node('p', '', 'next-help'); feedback.id = 'next-local-feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  card.append(row, runtimeStatus, choiceRow, label('Context length (optional)', context), contextHelp, importDetails, feedback);
  mount.append(card);
  let alive = true, active = false, busy = false, generation = 0, snapshot = { engines: [] };
  const selected = () => snapshot.engines?.find(item => item.id === engine.value) || { available: false, models: [] };
  const info = (message, isError = false) => { feedback.textContent = message; feedback.dataset.error = String(isError); };
  function updateChoices() {
    const value = selected();
    const previous = models.value;
    models.replaceChildren();
    for (const model of value.models || []) {
      const option = node('option', (model.displayName || model.id) + (model.loaded ? ' · Loaded' : ' · On disk'));
      option.value = model.id; models.append(option);
    }
    if ((value.models || []).some(item => item.id === previous)) models.value = previous;
    runtimeStatus.textContent = value.available
      ? value.name + ' is running · ' + (value.models || []).length + ' local models found.'
      : value.name + ' is not available. Start its local server to list and load models.' + (value.error ? ' ' + value.error : '');
    const model = (value.models || []).find(item => item.id === models.value);
    models.disabled = busy || !value.available || !model;
    load.disabled = busy || !model;
    unload.disabled = busy || !model?.loaded;
    refresh.disabled = busy;
    engine.disabled = busy;
    importButton.disabled = busy;
    sourcePath.disabled = busy;
    alias.disabled = busy;
    context.disabled = busy;
  }
  async function refreshCatalog({ preferredModel, preferredEngine } = {}) {
    const token = ++generation;
    try {
      const value = await api('/api/local-models');
      if (!alive || token !== generation) return;
      snapshot = value && Array.isArray(value.engines) ? value : { engines: [] };
      if (preferredEngine) engine.value = preferredEngine;
      updateChoices();
      if (preferredModel && (selected().models || []).some(item => item.id === preferredModel)) models.value = preferredModel;
      updateChoices();
    } catch (e) {
      if (!alive || token !== generation) return;
      runtimeStatus.textContent = e.message || 'Unable to read local runtimes.';
      info(runtimeStatus.textContent, true);
    }
  }
  async function operation(action) {
    if (busy) return;
    const runtime = engine.value, model = models.value;
    if (action !== 'import' && !model) return;
    if (action === 'import' && (!sourcePath.value.trim() || !alias.value.trim())) return info('Provide an absolute model path and a local model name.', true);
    const contextLength = context.value.trim() ? Number(context.value) : undefined;
    if (action === 'load' && contextLength !== undefined && (!Number.isSafeInteger(contextLength) || contextLength < 128 || contextLength > 262144)) return info('Context length must be from 128 through 262144.', true);
    busy = true; updateChoices(); info(action === 'import' ? 'Importing local weights and loading the model…' : action === 'load' ? 'Loading model into memory…' : 'Unloading model…');
    try {
      const item = (selected().models || []).find(entry => entry.id === model);
      const payload = action === 'import' ? { sourcePath: sourcePath.value.trim(), model: alias.value.trim() }
        : action === 'load' ? { engine: runtime, model, ...(contextLength ? { contextLength } : {}) }
          : { engine: runtime, model, ...(item?.instanceIds?.[0] ? { instanceId: item.instanceIds[0] } : {}) };
      const result = await api('/api/local-models/' + action, 'POST', payload);
      if (action !== 'unload') await onChanged();
      info(action === 'unload' ? 'Unloaded ' + model + '. Model files and saved conversations are unchanged.'
        : 'Loaded ' + result.model + ' · available in BLACKICE as ' + result.selection + '.');
      await refreshCatalog({ preferredEngine: action === 'import' ? 'ollama' : runtime, preferredModel: result.model });
    } catch (e) { info(e.message || 'Local model operation failed.', true); }
    finally { busy = false; if (alive) updateChoices(); }
  }
  refresh.addEventListener('click', () => { if (!busy) void refreshCatalog(); });
  engine.addEventListener('change', updateChoices);
  models.addEventListener('change', updateChoices);
  load.addEventListener('click', () => void operation('load'));
  unload.addEventListener('click', () => void operation('unload'));
  importButton.addEventListener('click', () => void operation('import'));
  updateChoices();
  return {
    enter() { if (!alive || active) return; active = true; void refreshCatalog(); },
    leave() { active = false; generation++; },
    destroy() { this.leave(); alive = false; mount.replaceChildren(); },
  };
}
