/** Local model management lives in the main Models section, not the advanced API editor. */
import { createLlamaCppLaunchSettings } from './llama-launch-settings.mjs';

export function createLocalModelSettings({ mount, api, onChanged = () => {}, storage } = {}) {
  const doc = mount.ownerDocument;
  if(storage===undefined)try{storage=globalThis.localStorage;}catch{}
  const selectionKey='blackice.next.local-model-runtime';
  let savedEngine;try{savedEngine=storage?.getItem(selectionKey);}catch{}
  if(!['ollama','lmstudio','llamacpp'].includes(savedEngine))savedEngine=null;
  let selectionChosen=Boolean(savedEngine);
  const node = (tag, value = '', css = '') => {
    const el = doc.createElement(tag);
    if (css) el.className = css;
    el.textContent = value;
    return el;
  };
  const label = (name, control) => { const el = node('label', name, 'next-label'); el.append(control); return el; };
  const button = name => { const el = node('button', name); el.setAttribute('type', 'button'); return el; };
  const card = node('section', '', 'next-card next-stack');
  card.setAttribute('aria-label', 'Local model loading');
  card.append(node('h2', 'Local models'));
  const row = node('div', '', 'next-row');
  const engine = node('select', '', 'next-field');
  for (const [id, name] of [['ollama', 'Ollama'], ['lmstudio', 'LM Studio'], ['llamacpp', 'llama.cpp']]) {
    const option = node('option', name); option.setAttribute('value', id); engine.append(option);
  }
  engine.id = 'next-local-engine';if(savedEngine)engine.value=savedEngine;
  const refresh = button('Refresh list'); refresh.id = 'next-local-refresh';
  row.append(label('Runtime', engine), refresh);
  const runtimeStatus = node('p', 'Checking local runtimes…', 'next-help');
  runtimeStatus.id = 'next-local-runtime-status'; runtimeStatus.setAttribute('role', 'status');
  const setup = node('details', '', 'next-stack'); setup.id = 'next-llama-setup';
  setup.append(node('summary', 'Advanced: manual runtime downloads'));
  const discover = button('Search release metadata'); discover.id = 'next-llama-discover';
  const releases = node('a', 'Open official llama.cpp releases'); releases.id = 'next-llama-releases'; releases.className = 'next-llama-releases-primary'; releases.setAttribute('href', 'https://github.com/ggml-org/llama.cpp/releases');
  releases.setAttribute('target', '_blank'); releases.setAttribute('rel', 'noopener noreferrer');
  const assets = node('select', '', 'next-field'); assets.id = 'next-llama-asset'; assets.hidden = true;
  const download = node('a', 'Download selected archive'); download.id = 'next-llama-download'; download.hidden = true;
  download.setAttribute('target', '_blank'); download.setAttribute('rel', 'noopener noreferrer');
  const companionLink = node('a', 'Download required CUDA runtime DLLs'); companionLink.id = 'next-llama-companion'; companionLink.hidden = true;
  companionLink.setAttribute('target', '_blank'); companionLink.setAttribute('rel', 'noopener noreferrer');
  const downloadStatus = node('p', '', 'next-help'); downloadStatus.id = 'next-llama-download-status'; downloadStatus.setAttribute('role', 'status');
  const discovery = node('details', '', 'next-provider-advanced next-llama-download-discovery'); discovery.id = 'next-llama-discovery';
  const discoveryContents = node('div', '', 'next-stack');
  discoveryContents.append(discover, label('Official binary archive (platform and architecture are in the filename)', assets), download, companionLink, downloadStatus);
  discovery.append(node('summary', 'Advanced: search release metadata for a specific archive'), discoveryContents);
  setup.append(releases,
    node('p', 'Choose the archive for your operating system, architecture and CPU/GPU backend. Windows CUDA builds require the matching cudart DLL archive extracted beside the runtime binaries. These are runtime binaries, not model weights. Downloads open your default browser; BLACKICE does not install or run them automatically.', 'next-help'), discovery,
    node('p', 'Extract the runtime archive and keep its libraries beside llama-server. With an existing GGUF model, start the server locally, then use Refresh local models above. Replace the example model path with yours.', 'next-help'),
    node('pre', 'llama-server -m "path/to/model.gguf" --host 127.0.0.1 --port 8080'),
    node('p', 'On Windows use llama-server.exe from the extracted folder; on macOS/Linux use ./llama-server. Select matching dependencies from the same release when required. Downloading does not make the runtime available until you start it.', 'next-help'));
  const choiceRow = node('div', '', 'next-row');
  const models = node('select', '', 'next-field'); models.id = 'next-local-model'; models.style.flex = '1'; models.style.minWidth = '180px';
  const load = button('Load'); load.id = 'next-local-load'; load.className = 'next-primary';
  const unload = button('Unload'); unload.id = 'next-local-unload';
  choiceRow.append(label('Local model', models), load);
  const context = node('input', '', 'next-field'); context.setAttribute('type', 'number'); context.min = '128'; context.max = '262144';
  context.placeholder = 'Runtime default'; context.id = 'next-local-context'; context.style.maxWidth = '180px';
  const contextLabel = label('Context length (optional)', context);
  const contextHelp = node('p', 'Optional context window for the next load. Leave blank to use the runtime default. Unloading does not delete model files or BLACKICE conversations.', 'next-help');
  const importDetails = node('details', '', 'next-provider-advanced');
  const summary = node('summary', 'Import local weights into Ollama');
  const importHelp = node('p', 'Select an existing .gguf file or a folder with config.json and .safetensors files. Enter its absolute path; the source precision is not deliberately reduced. Supported architectures depend on your Ollama version.', 'next-help');
  const sourcePath = node('input', '', 'next-field'); sourcePath.setAttribute('type', 'text'); sourcePath.id = 'next-local-source-path'; sourcePath.placeholder = 'C:\\Models\\my-model or /home/me/models/my-model'; sourcePath.spellcheck = false;
  const alias = node('input', '', 'next-field'); alias.id = 'next-local-import-name'; alias.placeholder = 'my-local-model'; alias.spellcheck = false;
  const importButton = button('Import & load'); importButton.id = 'next-local-import'; importButton.className = 'next-primary';
  const importRow = node('div', '', 'next-row'); importRow.append(importButton);
  importDetails.append(summary, importHelp, label('Model file or directory', sourcePath), label('Local Ollama model name', alias), importRow);
  const feedback = node('p', '', 'next-help'); feedback.id = 'next-local-feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const localDefaultRow = node('div', '', 'next-row');
  const localDefaultChoice = node('select', '', 'next-field'); localDefaultChoice.id = 'next-local-default-choice';
  const useLocalDefault = button('Use as local default'); useLocalDefault.id = 'next-local-default-set';
  const clearLocalDefault = button('Clear local default'); clearLocalDefault.id = 'next-local-default-clear';
  localDefaultRow.append(label('Local default model', localDefaultChoice), useLocalDefault, clearLocalDefault);
  const localDefaultFeedback = node('p', '', 'next-help'); localDefaultFeedback.id = 'next-local-default-status'; localDefaultFeedback.setAttribute('role', 'status');
  const profileCard = node('section', '', 'next-stack'); profileCard.id = 'next-local-profile'; profileCard.hidden = true;
  const profileHelp = node('p', '', 'next-help'); profileHelp.id = 'next-local-profile-help';
  const profileSetup = button('Set up MiniCPM for Local'); profileSetup.id = 'next-local-profile-setup'; profileSetup.className = 'next-primary';
  const profileFeedback = node('p', '', 'next-help'); profileFeedback.id = 'next-local-profile-status'; profileFeedback.setAttribute('role', 'status');
  profileCard.append(node('h3', 'MiniCPM for Local'), profileHelp, profileSetup, profileFeedback);
  const launchMount = node('div');launchMount.hidden = true;
  const advancedControls = node('details', '', 'next-provider-advanced');
  const llamaAdvanced = node('div'); llamaAdvanced.hidden = true;
  advancedControls.id = 'next-local-advanced';
  advancedControls.append(node('summary', 'More options'), row, unload, contextLabel, contextHelp, importDetails, llamaAdvanced, setup);
  card.append(profileCard, runtimeStatus, choiceRow, launchMount, localDefaultRow, localDefaultFeedback, feedback, advancedControls);
  mount.append(card);
  const launchSettings = createLlamaCppLaunchSettings({mount:launchMount,advancedMount:llamaAdvanced,api,onChanged:async result=>{await onChanged();await refreshCatalog({preferredEngine:'llamacpp',preferredModel:result.model});},
    onDiscovered:async result=>{
      generation++;
      const item={id:'llamacpp',name:'llama.cpp',available:true,mode:result.mode,models:result.models};
      snapshot={...snapshot,engines:[...snapshot.engines.filter(entry=>entry.id!=='llamacpp'),item]};
      updateChoices();
    }});
  let alive = true, active = false, busy = false, generation = 0, snapshot = { engines: [] };
  let downloadGeneration = 0, discovering = false, downloadAssets = [];
  let localDefaultKnown = false, localDefaultStatus = {model:null, eligible:false, reason:null}, localDefaultOptions = [];
  let pendingProfileIntent = null, profileFeedbackIntent = null;
  const selected = () => snapshot.engines?.find(item => item.id === engine.value) || { available: false, models: [] };
  const info = (message, isError = false) => { feedback.textContent = message; feedback.dataset.error = String(isError); };
  function profileResult(receipt) {
    const completed = [];
    const status = receipt.status === 'interrupted' || receipt.outcomeUncertain
      ? 'Setup was interrupted. The last stage may have completed; review the confirmed stages before starting a new setup.'
      : receipt.status === 'running' ? 'Setup is still running. Retry this setup to check the same saved intent.' : '';
    const verified = new Set([...(receipt.assets || []), ...(receipt.assetPreparation?.assets || [])]
      .filter(item => ['verified', 'reused', 'published'].includes(item.status)).map(item => item.id));
    if (verified.size === 2) completed.push('Model and projector verified.');
    else if (verified.size) completed.push('One model asset is verified on disk and can be reused.');
    if (receipt.settings) completed.push(receipt.settings.profileApplied ? 'Local runtime defaults configured.' : 'Existing per-model settings preserved.');
    if (receipt.registration) completed.push('MiniCPM registered in the model picker.');
    if (receipt.localDefault) completed.push(receipt.localDefault.status === 'initialized' ? 'MiniCPM is the Local default.' : 'Your Local preference was preserved.');
    return [...(status ? [status] : []), ...completed, ...(receipt.limitations || []), ...(receipt.error?.message ? [receipt.error.message] : []),
      ...(receipt.persistenceError ? [receipt.persistenceError] : [])].join(' ') || 'Setup has no confirmed completed stages.';
  }
  function updateProfile() {
    const profile = snapshot.localModelProfile;
    profileCard.hidden = profile?.available !== true;
    profileSetup.disabled = busy || profile?.available !== true;
    if (profile?.available) {
      const bytes = profile.downloadBytes;
      profileHelp.textContent = 'MiniCPM-V 4.7 1B heretic · Q4_K_S. Downloads up to ' + (bytes / 1073741824).toFixed(2) +
        ' GiB (' + Number(bytes).toLocaleString('en-US') + ' bytes). Existing model and projector files are reused after verification. Setup does not load the model or change your current chat.';
      if (!busy && profile.receipt && (!profileFeedbackIntent || profile.receipt.intentId === profileFeedbackIntent)) profileFeedback.textContent = profileResult(profile.receipt);
    }
  }
  async function setupProfile() {
    const profile = snapshot.localModelProfile;
    if (busy || profile?.available !== true) return;
    const request = pendingProfileIntent || {
      intentId:globalThis.crypto.randomUUID(), profileId:profile.profileId, expectedRevision:profile.expectedRevision,
      expectedLocalDefaultModel:profile.expectedLocalDefaultModel, expectedLocalDefaultInitialized:profile.expectedLocalDefaultInitialized,
    };
    pendingProfileIntent = request;
    profileFeedbackIntent = request.intentId;
    busy = true; updateChoices(); profileFeedback.textContent = 'Verifying existing files and preparing MiniCPM for Local…';
    try {
      const result = await api('/api/local-models/profile', 'POST', request);
      if (result?.receipt?.intentId !== request.intentId || result.receipt.status !== 'complete') throw Error('The setup result could not be confirmed. Refresh its saved status.');
      pendingProfileIntent = null;
      await onChanged(); await refreshCatalog({preferredEngine:'llamacpp'});
      if (alive) { profileFeedback.textContent = profileResult(result.receipt); profileFeedback.dataset.error = 'false'; }
    } catch (cause) {
      await refreshCatalog();
      const saved = snapshot.localModelProfile?.receipt;
      if (saved?.intentId === request.intentId && ['complete', 'failed', 'cancelled', 'interrupted'].includes(saved.status)) {
        pendingProfileIntent = null;
        if (alive) { profileFeedback.textContent = profileResult(saved); profileFeedback.dataset.error = String(saved.status !== 'complete'); }
      } else if (alive) {
        profileFeedback.textContent = (cause.message || 'Local setup could not be confirmed.') + ' Retry this setup to check the same saved intent.';
        profileFeedback.dataset.error = 'true';
      }
    } finally { busy = false; if (alive) updateChoices(); }
  }
  function updateLocalDefaultChoices() {
    const saved = snapshot.localDefaultModelStatus;
    localDefaultKnown = Boolean(saved && (saved.model === null || typeof saved.model === 'string') && typeof saved.eligible === 'boolean');
    localDefaultStatus = localDefaultKnown ? saved : {model:null, eligible:false, reason:null};
    const listed = new Set((snapshot.engines?.find(item => item.id === 'llamacpp')?.models || []).map(item => item.id));
    const choices = Array.isArray(snapshot.localDefaultChoices) ? snapshot.localDefaultChoices : [];
    localDefaultOptions = choices.filter(item => typeof item.id === 'string' && item.id.includes('::')).map(item => ({
      ...item, disabled:!listed.has(item.id.slice(item.id.indexOf('::')+2)),
    }));
    if (saved?.model && !localDefaultOptions.some(item => item.id === saved.model))
      localDefaultOptions.push({id:saved.model, displayName:saved.model, disabled:true});
    const previous = localDefaultChoice.value;
    localDefaultChoice.replaceChildren();
    for (const item of localDefaultOptions) {
      const option = node('option', (item.displayName || item.id) + (item.disabled ? ' · unavailable' : ''));
      option.setAttribute('value', item.id); option.disabled = item.disabled; localDefaultChoice.append(option);
    }
    if (!localDefaultOptions.length) { const option = node('option', 'Add a registered llama.cpp model'); option.setAttribute('value', ''); localDefaultChoice.append(option); }
    const preferred = localDefaultOptions.some(item => item.id === previous) ? previous : saved?.model;
    if (preferred && localDefaultOptions.some(item => item.id === preferred)) localDefaultChoice.value = preferred;
    const target = localDefaultOptions.find(item => item.id === localDefaultChoice.value);
    localDefaultChoice.disabled = busy || !localDefaultKnown || !localDefaultOptions.length;
    useLocalDefault.disabled = busy || !localDefaultKnown || !target || target.disabled || target.id === saved?.model;
    clearLocalDefault.disabled = busy || !localDefaultKnown || !saved?.model;
    const current = localDefaultOptions.find(item => item.id === saved?.model),name = current?.displayName || saved?.model;
    localDefaultFeedback.textContent = !localDefaultKnown ? 'Local default settings are unavailable. Refresh to read the saved preference.'
      : !saved.model ? 'No local default selected. Choose a registered model, or use llama.cpp’s Add GGUF setup.'
      : !saved.eligible ? 'Local default unavailable: ' + (saved.reason || name) + ' Restore its setup, choose another model, or clear this preference.'
      : current?.disabled ? 'Local default is not in the local catalog: ' + name + '. Restore its GGUF setup or choose another model.'
      : 'Local default: ' + name + '. Chat’s Local choice uses this exact model; availability is checked when selected.';
  }
  async function changeLocalDefault(clear = false) {
    if (busy || !localDefaultKnown || (clear ? clearLocalDefault.disabled : useLocalDefault.disabled)) return;
    const model = clear ? null : localDefaultChoice.value, expectedLocalDefaultModel = localDefaultStatus.model;
    busy = true; updateChoices(); info(clear ? 'Clearing the local default…' : 'Saving the local default…');
    try {
      const result = await api('/api/local-models/default', 'POST', {model, expectedLocalDefaultModel});
      if (!result?.localDefaultModelStatus || result.localDefaultModelStatus.model !== model) throw Error('The local preference response could not be verified. Refresh its saved status.');
      snapshot = {...snapshot, localDefaultModelStatus:result.localDefaultModelStatus};
      await onChanged();
      await refreshCatalog();
      info(clear ? 'Local default cleared.' : 'Local default saved. Select Local in Chat to use it.');
    } catch (e) {
      info(e.message || 'The local default could not be changed.', true);
      await refreshCatalog();
    } finally { busy = false; if (alive) updateChoices(); }
  }
  function updateChoices() {
    const value = selected();
    const isLlama = engine.value === 'llamacpp';
    contextLabel.hidden=isLlama;
    choiceRow.hidden=isLlama && !(value.models || []).length;
    setup.hidden = !isLlama;
    launchMount.hidden = llamaAdvanced.hidden = !isLlama;
    contextHelp.textContent = isLlama
      ? 'Adjust context and performance under Advanced runtime & model settings. Unloading never deletes weights or conversations.'
      : 'Optional context window for the next load. Leave blank to use the runtime default. Unloading does not delete model files or BLACKICE conversations.';
    importDetails.hidden = engine.value !== 'ollama';
    const previous = models.value;
    models.replaceChildren();
    for (const model of value.models || []) {
      const option = node('option', (model.displayName || model.id) + (model.status === 'sleeping' ? ' · Sleeping' : model.loaded ? ' · Loaded' : ' · On disk'));
      option.setAttribute('value', model.id); models.append(option);
    }
    if ((value.models || []).some(item => item.id === previous)) models.value = previous;
    const loaded = (value.models || []).filter(item => item.loaded && item.status !== 'sleeping');
    const names = loaded.slice(0, 2).map(item => item.displayName || item.id).join(', ');
    runtimeStatus.textContent = loaded.length ? 'Loaded: ' + names + (loaded.length > 2 ? ' +' + (loaded.length - 2) + ' more' : '')
      : value.available || isLlama ? 'No local model loaded.' : (value.name || 'Runtime') + ' is not running.';
    const model = (value.models || []).find(item => item.id === models.value);
    load.textContent = model?.loaded ? 'Add to Chat' : 'Load';
    models.disabled = busy || (!value.available && !isLlama) || !model;
    load.disabled = busy || !model;
    unload.hidden = !model?.loaded || model.manageable === false;
    unload.disabled = busy || unload.hidden;
    refresh.disabled = busy;
    engine.disabled = busy;
    importButton.disabled = busy;
    sourcePath.disabled = busy;
    alias.disabled = busy;
    context.disabled = busy || isLlama;
    updateLocalDefaultChoices();
    updateProfile();
  }
  async function refreshCatalog({ preferredModel, preferredEngine } = {}) {
    const token = ++generation;
    try {
      const value = await api('/api/local-models');
      if (!alive || token !== generation) return;
      snapshot = value && Array.isArray(value.engines) ? value : { engines: [] };
      if (preferredEngine) {engine.value = preferredEngine;selectionChosen=true;}
      if(!selectionChosen){
        const existing=snapshot.engines.find(item=>item.models?.length&&(item.available||item.id==='llamacpp'));
        let initial=existing?.id;
        if(!initial){
          try{const providers=await api('/api/providers');initial=(Array.isArray(providers)?providers:[]).find(p=>p.enabled!==false&&p.models?.length&&['ollama','lmstudio','llamacpp'].includes(p.preset))?.preset;}catch{}
          if(!alive||token!==generation||selectionChosen)return;
          if(!initial)try{const config=await api('/api/local-models/config');if(config.runtime?.available&&config.runtime.source==='bundled')initial='llamacpp';}catch{}
        }
        if(!alive||token!==generation||selectionChosen)return;
        engine.value=initial||'llamacpp';selectionChosen=true;
        if(active&&engine.value==='llamacpp')launchSettings.enter();
      }
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
    if (action === 'unload' && unload.disabled) return;
    if (action !== 'import' && !model) return;
    if (action === 'import' && (!sourcePath.value.trim() || !alias.value.trim())) return info('Provide an absolute model path and a local model name.', true);
    const contextLength = runtime === 'llamacpp' ? undefined : context.value.trim() ? Number(context.value) : undefined;
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
        : 'Ready in the chat model picker: ' + result.model + '.');
      await refreshCatalog({ preferredEngine: action === 'import' ? 'ollama' : runtime, preferredModel: result.model });
    } catch (e) { info(e.message || 'Local model operation failed.', true); }
    finally { busy = false; if (alive) updateChoices(); }
  }
  function selectDownload() {
    const asset = downloadAssets.find(item => item.name === assets.value);
    companionLink.hidden = true; companionLink.removeAttribute('href');
    download.hidden = !asset;
    if (!asset) { download.removeAttribute('href'); return; }
    download.setAttribute('href', asset.url);
    const companion = asset.companionName && downloadAssets.find(item => item.name === asset.companionName);
    if (companion) {
      companionLink.hidden = false; companionLink.setAttribute('href', companion.url);
      companionLink.textContent = 'Download required DLLs: ' + companion.name + ' (' + (companion.sizeBytes / 1048576).toFixed(1) + ' MiB)';
    }
    downloadStatus.textContent = (asset.dependency ? 'CUDA dependency archive. ' : 'Runtime archive. ') +
      (asset.sizeBytes / 1048576).toFixed(1) + ' MiB.' + (asset.sha256 ? ' SHA-256: ' + asset.sha256 : ' Checksum not provided by upstream metadata.') +
      (asset.companionRequired ? companion ? ' Also download the matching DLL archive linked here and extract both into the same folder before starting llama-server.exe.' : ' Required matching CUDA DLL archive is missing from this release. Do not assume this archive will start; choose another backend or inspect official releases.' : '');
  }
  assets.addEventListener('change', selectDownload);
  discover.addEventListener('click', async () => {
    if (discovering || !alive || !active) return;
    const token = ++downloadGeneration; discovering = true; discover.disabled = true;
    download.hidden = true; download.removeAttribute('href'); assets.hidden = true;
    companionLink.hidden = true; companionLink.removeAttribute('href');
    downloadStatus.textContent = 'Checking official release metadata…';
    try {
      const result = await api('/api/local-models/downloads');
      if (!alive || !active || token !== downloadGeneration) return;
      downloadAssets = result.assets || []; assets.replaceChildren();
      const placeholder = node('option', 'Choose an archive for your computer'); placeholder.setAttribute('value', ''); assets.append(placeholder);
      for (const asset of downloadAssets) {
        const option = node('option', asset.name + ' · ' + (asset.sizeBytes / 1048576).toFixed(1) + ' MiB');
        option.setAttribute('value', asset.name); assets.append(option);
      }
      assets.hidden = false; assets.value = '';
      downloadStatus.textContent = 'Official ' + (result.prerelease ? 'prerelease/nightly ' : 'release ') + result.tag + '. Select the matching platform, architecture and backend; no download has started.';
    } catch (e) {
      if (alive && active && token === downloadGeneration) downloadStatus.textContent = (e.message || 'Could not check downloads.') + ' Use the official releases link or try again.';
    } finally {
      if (token === downloadGeneration) { discovering = false; discover.disabled = false; }
    }
  });
  refresh.addEventListener('click', () => { if (!busy) {void refreshCatalog();if(engine.value==='llamacpp')void launchSettings.refresh();} });
  engine.addEventListener('change', () => { selectionChosen=true;try{storage?.setItem(selectionKey,engine.value);}catch{} updateChoices(); if(active && engine.value==='llamacpp') launchSettings.enter(); else launchSettings.leave(); });
  models.addEventListener('change', updateChoices);
  localDefaultChoice.addEventListener('change', updateChoices);
  useLocalDefault.addEventListener('click', () => changeLocalDefault());
  clearLocalDefault.addEventListener('click', () => changeLocalDefault(true));
  profileSetup.addEventListener('click', () => setupProfile());
  load.addEventListener('click', () => void operation('load'));
  unload.addEventListener('click', () => void operation('unload'));
  importButton.addEventListener('click', () => void operation('import'));
  updateChoices();
  return {
    enter() { if (!alive || active) return; active = true; if(engine.value==='llamacpp') launchSettings.enter(); void refreshCatalog(); },
    leave() { active = false; generation++; downloadGeneration++; discovering = false; discover.disabled = false; launchSettings.leave(); },
    destroy() { this.leave(); alive = false; launchSettings.destroy(); mount.replaceChildren(); },
  };
}
