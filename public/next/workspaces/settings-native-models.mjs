/** Explicit development preview for BLACKICE's own worker-isolated inference engine
 * and the separately bundled llama.cpp backend. No automatic provider fallback.
 */
export function createNativeModelSettings({ mount, api } = {}) {
  const doc = mount.ownerDocument;
  const element = (tag, value = '', className = '') => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    node.textContent = value;
    return node;
  };
  const label = (text, control) => {
    const field = element('label', text, 'next-label');
    field.append(control);
    return field;
  };
  const action = (id, text) => {
    const button = element('button', text);
    button.setAttribute('type', 'button');
    button.id = id;
    return button;
  };
  const card = element('section', '', 'next-card next-stack');
  card.id = 'next-native-inference';
  card.setAttribute('aria-label', 'Built-in native inference preview');
  card.append(
    element('h2', 'BLACKICE native inference (experimental)'),
    element('p',
      'Independent BLACKICE Qwen3 engine and optional bundled llama.cpp. Both run locally without Ollama or LM Studio. This preview does not change your chat model or default provider.',
      'next-help'),
    element('p',
      'The BLACKICE engine is an unoptimized FP16/BF16/F32 CPU reference. A single real-model token can take tens of seconds. Model compatibility and numerical parity are still under verification.',
      'next-help'),
  );

  const runtime = element('select', '', 'next-field');
  runtime.id = 'next-native-engine';
  const cpuKernel = element('select', '', 'next-field');
  cpuKernel.id = 'next-native-cpu-kernel';
  for (const [id, name] of [['simd', 'BLACKICE SIMD CPU (optimized)'], ['reference', 'BLACKICE JavaScript reference']]) {
    const option = element('option', name); option.value = id; cpuKernel.append(option);
  }
  cpuKernel.value = 'simd';
  const modelPath = element('input', '', 'next-field');
  modelPath.id = 'next-native-model-path';
  modelPath.setAttribute('type', 'text');
  modelPath.spellcheck = false;
  modelPath.placeholder = 'C:\\Models\\Qwen3-FP16 (or absolute GGUF path for llama.cpp)';
  modelPath.maxLength = 4096;
  const context = element('input', '', 'next-field');
  context.id = 'next-native-context';
  context.setAttribute('type', 'number');
  context.min = '1';
  context.max = '131072';
  context.value = '64';
  const reload = action('next-native-refresh', 'Refresh engines');
  const load = action('next-native-load', 'Load native model');
  load.className = 'next-primary';
  const loadRow = element('div', '', 'next-row');
  loadRow.append(load, reload);

  const sessions = element('select', '', 'next-field');
  sessions.id = 'next-native-session';
  const sessionActions = element('div', '', 'next-row');
  const unload = action('next-native-unload', 'Unload selected');
  const cancel = action('next-native-cancel', 'Cancel generation');
  sessionActions.append(unload, cancel);
  const prompt = element('textarea', '', 'next-field');
  prompt.id = 'next-native-input';
  prompt.rows = 2;
  prompt.maxLength = 100000;
  prompt.value = 'Hello';
  const chat = element('input');
  chat.id = 'next-native-chat';
  chat.setAttribute('type', 'checkbox');
  const chatLabel = element('label', ' Use Qwen chat template', 'next-row');
  chatLabel.append(chat);
  const maxTokens = element('input', '', 'next-field');
  maxTokens.id = 'next-native-tokens';
  maxTokens.setAttribute('type', 'number');
  maxTokens.min = '1';
  maxTokens.max = '8';
  maxTokens.value = '1';
  const generate = action('next-native-generate', 'Generate locally');
  generate.className = 'next-primary';
  const output = element('pre', '', 'next-card');
  output.id = 'next-native-output';
  output.setAttribute('aria-label', 'Native inference output');
  output.style.whiteSpace = 'pre-wrap';
  output.style.overflowWrap = 'anywhere';
  const feedback = element('p', '', 'next-help');
  feedback.id = 'next-native-feedback';
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');

  card.append(
    label('Inference engine', runtime),
    label('BLACKICE CPU kernel', cpuKernel),
    label('Absolute model directory or GGUF file', modelPath),
    label('Context window', context),
    loadRow,
    label('Loaded native sessions', sessions),
    sessionActions,
    label('Prompt', prompt),
    chatLabel,
    label('Tokens to generate (1–8 in preview)', maxTokens),
    generate, feedback, output,
  );
  mount.append(card);
  let alive = true, active = false, busy = '', generation = 0;
  let state = { engines: [], sessions: [] };
  const knownSession = () => state.sessions.find(s => s.id === sessions.value);
  const chosenEngine = () => state.engines.find(e => e.id === runtime.value);
  const info = (message, isError = false) => {
    feedback.textContent = message;
    feedback.dataset.error = String(isError);
  };
  function render() {
    const previousEngine = runtime.value || 'blackice';
    for (const option of [...runtime.children]) option.remove();
    for (const engine of state.engines) {
      const option = element('option', engine.id + (engine.available ? '' : ' (not built)'));
      option.value = engine.id;
      option.disabled = engine.available !== true;
      runtime.append(option);
    }
    runtime.value = state.engines.some(e => e.id === previousEngine && e.available) ? previousEngine : 'blackice';
    const previous = sessions.value;
    for (const option of [...sessions.children]) option.remove();
    for (const session of state.sessions) {
      const option = element('option', session.backend + ' · ' + session.modelPath + ' · ' + session.status);
      option.value = session.id;
      sessions.append(option);
    }
    if (state.sessions.some(s => s.id === previous)) sessions.value = previous;
    const selected = knownSession();
    const running = selected?.status === 'running' || busy === 'generate';
    runtime.disabled = Boolean(busy);
    cpuKernel.disabled = Boolean(busy) || runtime.value !== 'blackice';
    modelPath.disabled = Boolean(busy);
    context.disabled = Boolean(busy);
    load.disabled = Boolean(busy) || chosenEngine()?.available !== true;
    reload.disabled = Boolean(busy);
    sessions.disabled = Boolean(busy) || !state.sessions.length;
    unload.disabled = Boolean(busy) || !selected || selected.status === 'running';
    cancel.disabled = !selected || !running;
    generate.disabled = Boolean(busy) || !selected || selected.status === 'running';
    prompt.disabled = Boolean(busy);
    chat.disabled = Boolean(busy);
    maxTokens.disabled = Boolean(busy);
  }
  async function refresh({ selectedId } = {}) {
    const token = ++generation;
    try {
      const result = await api('/api/native-inference/status');
      if (!alive || token !== generation) return;
      state = result;
      render();
      if (selectedId && state.sessions.some(s => s.id === selectedId)) {
        sessions.value = selectedId;
        render();
      }
    } catch (error) {
      if (alive && token === generation) info(error.message || 'Native inference status unavailable.', true);
    }
  }
  async function loadModel() {
    if (busy) return;
    const backend = runtime.value, chosenPath = modelPath.value.trim();
    const maxContext = Number(context.value);
    if (!chosenPath || !Number.isSafeInteger(maxContext) || maxContext < 1 || maxContext > 131072)
      return info('Enter an absolute model path and a positive context window.', true);
    busy = 'load'; render(); info('Loading model into a native BLACKICE worker…');
    try {
      const result = await api('/api/native-inference/load', 'POST',
        { backend, modelPath: chosenPath, maxContext,
          ...(backend === 'blackice' ? { cpuKernel: cpuKernel.value } : {}) },
        { deadlineMs: 180000 });
      info('Loaded ' + result.backend + ' · ' + result.modelPath);
      await refresh({ selectedId: result.id });
    } catch (error) { info(error.message || 'Native model load failed.', true); }
    finally { busy = ''; if (alive) render(); }
  }
  async function run() {
    const selected = knownSession();
    if (busy || !selected) return;
    const input = prompt.value, budget = Number(maxTokens.value);
    if (!input || !Number.isSafeInteger(budget) || budget < 1 || budget > 8)
      return info('Enter a prompt and choose 1–8 tokens.', true);
    busy = 'generate'; render(); info('Generating locally…');
    output.textContent = '';
    try {
      const result = await api('/api/native-inference/generate', 'POST',
        { id: selected.id, ...(chat.checked && selected.backend === 'blackice'
          ? { messages: [{ role: 'user', content: input }], enableThinking: false }
          : { prompt: input }), maxTokens: budget }, { deadlineMs: 600000 });
      if (!alive) return;
      output.textContent = result.text || '';
      info('Generated ' + (result.tokenIds?.length ?? '?') + ' tokens with ' + result.backend +
        ' · ' + (result.completed ? 'completed' : 'incomplete'));
    } catch (error) {
      if (alive) info(error.message || 'Native generation failed.', true);
    } finally {
      busy = '';
      if (alive) await refresh({ selectedId: selected.id });
    }
  }
  async function cancelRun() {
    const selected = knownSession();
    if (!selected) return;
    try {
      const result = await api('/api/native-inference/cancel', 'POST', { id: selected.id });
      info(result.cancellationRequested ? 'Cancellation requested for the selected worker.' : 'No active generation to cancel.');
    } catch (error) { info(error.message || 'Cancellation failed.', true); }
  }
  async function unloadModel() {
    const selected = knownSession();
    if (!selected || busy) return;
    busy = 'unload'; render(); info('Unloading native model…');
    try {
      const result = await api('/api/native-inference/unload', 'POST', { id: selected.id });
      info(result.unloaded ? 'Native model unloaded.' : 'Session was already absent.');
      await refresh();
    } catch (error) { info(error.message || 'Unload failed.', true); }
    finally { busy = ''; if (alive) render(); }
  }
  reload.addEventListener('click', () => { if (!busy) void refresh(); });
  load.addEventListener('click', () => void loadModel());
  generate.addEventListener('click', () => void run());
  cancel.addEventListener('click', () => void cancelRun());
  unload.addEventListener('click', () => void unloadModel());
  sessions.addEventListener('change', render);
  runtime.addEventListener('change', render);
  render();
  return {
    enter() { if (!alive || active) return; active = true; void refresh(); },
    leave() { active = false; generation++; },
    destroy() { this.leave(); alive = false; for (const child of [...mount.children]) child.remove(); },
  };
}
