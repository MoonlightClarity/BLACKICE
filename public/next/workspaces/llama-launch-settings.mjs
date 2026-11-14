/** Persisted llama.cpp startup preferences; no model/process action occurs here. */
export function createLlamaCppLaunchSettings({mount, api} = {}) {
  const doc = mount.ownerDocument;
  const make = (tag, text = '', css = '') => {
    const node = doc.createElement(tag);
    node.textContent = text;
    if (css) node.className = css;
    return node;
  };
  const label = (text, input) => { const item = make('label', text, 'next-label');item.append(input);return item; };
  const button = text => { const item = make('button', text); item.setAttribute('type', 'button'); return item; };
  const section = make('details', '', 'next-provider-advanced');
  section.open = true;
  section.id = 'next-llama-launch-settings';
  section.append(make('summary', 'llama.cpp on-demand launch defaults'),
    make('p', 'Settings apply on the next BLACKICE-owned server launch. Saving never restarts a server or changes model weights, precision, or saved chats. External llama-server processes are never stopped by BLACKICE.', 'next-help'));
  const definitions = [
    ['executablePath', 'llama-server executable path (absolute, blank = discover)', 'text'],
    ['modelsDirectory', 'GGUF models directory (absolute path)', 'text'],
    ['sleepIdleSeconds', 'Model sleep after idle seconds', 'number'],
    ['shutdownIdleSeconds', 'Stop owned server after idle seconds (0 = disabled)', 'number'],
    ['modelsMax', 'Maximum loaded models', 'number'],
    ['memoryMarginMiB', 'Router GPU memory margin (MiB)', 'number'],
    ['fitTargetMiB', 'Model GPU fitting reserve (MiB)', 'number'],
    ['ctxSize', 'Context tokens (0 = model automatic)', 'number'],
    ['gpuLayers', 'GPU layers (auto, all, or a number)', 'text'],
    ['flashAttention', 'Flash Attention', 'select'],
    ['parallel', 'Parallel server slots', 'number'],
    ['cacheRamMiB', 'RAM prompt cache (MiB; 0 = off)', 'number'],
    ['poll', 'CPU polling percentage (0–100)', 'number'],
  ];
  const controls = {};
  for (const [key, title, type] of definitions) {
    const control = make(type === 'select' ? 'select' : 'input', '', 'next-field');
    control.id = 'next-llama-default-' + key;
    if (type === 'select') for (const v of ['auto','on','off']) {
      const option = make('option', v);option.value = v;control.append(option);
    }
    else control.setAttribute('type', type);
    controls[key] = control;
    section.append(label(title, control));
  }
  const advanced = make('details', '', 'next-provider-advanced');
  const modelPaths = make('textarea', '', 'next-field');modelPaths.id = 'next-llama-paths';modelPaths.rows = 4;
  const modelOverrides = make('textarea', '', 'next-field');modelOverrides.id = 'next-llama-overrides';modelOverrides.rows = 4;
  advanced.append(make('summary', 'Per-model settings and explicit GGUF paths'),
    make('p', 'Optional JSON maps keyed by exact model ID. Model paths are absolute .gguf filenames; overrides support ctxSize, gpuLayers, flashAttention, fitTargetMiB, parallel, cacheRamMiB, and poll.', 'next-help'),
    label('Model file paths (JSON)', modelPaths), label('Model-specific overrides (JSON)', modelOverrides));
  const commands = make('div', '', 'next-row');
  const save = button('Save launch defaults'), reset = button('Restore recommended values');
  save.id = 'next-llama-default-save';reset.id = 'next-llama-default-reset';
  save.className = 'next-primary';
  commands.append(save, reset);
  const feedback = make('p', '', 'next-help'); feedback.setAttribute('role', 'status');
  feedback.id = 'next-llama-default-feedback'; feedback.setAttribute('aria-live','polite');
  const preview = make('pre', '', 'next-help'); preview.id='next-llama-default-preview';
  section.append(advanced, commands, feedback, preview);
  mount.append(section);
  let alive = true, active = false, pending = false, generation = 0;
  let revision = null, recommended = null;
  function loadSettingsIntoForm(value) {
    for (const [key] of definitions) controls[key].value = String(value[key]);
    modelPaths.value = JSON.stringify(value.modelPaths || {}, null, 2);
    modelOverrides.value = JSON.stringify(value.modelOverrides || {}, null, 2);
  }
  function draw(snapshot) {
    revision = snapshot.revision; recommended = snapshot.recommended;
    loadSettingsIntoForm(snapshot.settings);
    const args = snapshot.launchArgs || [];
    preview.textContent = args.length
      ? 'Effective next-launch arguments:\nllama-server ' + args.join(' ') +
        '\nModel-specific settings are generated in a separate INI file.'
      : 'No launch preview: configure an executable and models directory or model paths.';
    feedback.textContent = 'Saved revision ' + revision + '. ' + (
      snapshot.process?.pendingRestart ? 'Changed settings apply after the owned process exits.' :
        snapshot.process?.owned ? 'Owned server running; no restart was requested.' :
          'No BLACKICE-owned server is running.');
  }
  function readSettings() {
    const settings = {};
    for (const [key, ,type] of definitions) {
      const value = controls[key].value.trim();
      settings[key] = type === 'number' ? Number(value) :
        key === 'gpuLayers' && /^\d+$/.test(value) ? Number(value) : value;
    }
    try {
      settings.modelPaths = JSON.parse(modelPaths.value || '{}');
      settings.modelOverrides = JSON.parse(modelOverrides.value || '{}');
    } catch { throw Error('Model paths and overrides must be valid JSON objects.'); }
    return settings;
  }
  async function refresh() {
    const token = ++generation;
    try {
      const snapshot = await api('/api/local-models/config');
      if (alive && active && token === generation) draw(snapshot);
    } catch (cause) {
      if (alive && active && token === generation)
        feedback.textContent = cause.message || 'Could not read launcher defaults.';
    }
  }
  save.addEventListener('click', async () => {
    if (pending || revision === null || !alive) return;
    pending = true; save.disabled = true;
    feedback.textContent = 'Saving preferences without restarting any server…';
    try {
      const snapshot = await api('/api/local-models/config','POST',{
        expectedRevision: revision, settings: readSettings(),
      });
      if (alive) draw(snapshot);
    } catch (cause) {
      if (alive) feedback.textContent = cause.message || 'Could not save launcher defaults.';
    } finally {pending = false;save.disabled = false;}
  });
  reset.addEventListener('click', () => {
    if (!recommended || pending) return;
    loadSettingsIntoForm(recommended);
    feedback.textContent = 'Recommended values are staged. Choose Save to persist them.';
  });
  return {
    enter() {if (active || !alive) return; active = true;void refresh();},
    leave() {active = false;generation++;},
    destroy() {this.leave();alive=false;mount.replaceChildren();},
  };
}
