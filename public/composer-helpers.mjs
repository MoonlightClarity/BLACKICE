/**
 * Small, portable composer affordances. Do not send template instructions until
 * the user reviews and submits the draft.
 */
export const STARTER_PROMPTS = Object.freeze([
  Object.freeze({
    id: 'review-files',
    icon: 'file',
    tint: 'teal',
    label: 'Review files',
    detail: 'Explore a project folder',
    prompt: 'Inspect the files in my selected working folder and give me an organized overview of what is there. Do not change any files yet.',
  }),
  Object.freeze({
    id: 'research',
    icon: 'search',
    tint: 'violet',
    label: 'Research',
    detail: 'Find answers with sources',
    prompt: 'Help me research a question. Ask what I need to find out and how I intend to use the results, then investigate using available sources. Distinguish what is verified from what is uncertain.',
  }),
  Object.freeze({
    id: 'plan',
    icon: 'plan',
    tint: 'amber',
    label: 'Make a plan',
    detail: 'Turn an idea into steps',
    prompt: 'Help me plan a task. Ask what outcome I want, then propose a short, practical plan and carry it out once the goal is clear. Verify actual results.',
  }),
  Object.freeze({
    id: 'draft',
    icon: 'artifact',
    tint: 'blue',
    label: 'Draft content',
    detail: 'Write something worth sharing',
    prompt: 'Help me draft something for a specific audience and purpose. Ask what I want to create and the tone before preparing an editable first draft. Do not publish or send anything without an explicit request.',
  }),
]);

export function starterPrompt(id) {
  return STARTER_PROMPTS.find(item => item.id === id)?.prompt || null;
}

/** Progress comes from the selected route, never an unused provider or a model turn. */
export function runtimeConnectionFeedback({ statusLoaded = true, status = {}, model = 'default' } = {}) {
  if (!statusLoaded) return { busy: true, phase: 'workspace', title: 'Connecting to BLACKICE…', detail: 'Loading your saved workspace. You can keep writing.' };
  const route = model === 'default' ? status.defaultModelSelection || status.automaticDefaultModel || status.defaultModel : model;
  if (typeof route === 'string' && route.includes('::')) {
    return model === 'default' && status.defaultModelInitializing ? { busy: true, phase: 'choosing-model', title: 'Preparing your model…', detail: 'Saving the initial model choice.' } : null;
  }
  const codex = status.codex || status, phase = codex.connection?.phase;
  const stages = {
    starting: ['Starting Codex…', 'Opening the local model runtime.'],
    initializing: ['Connecting to Codex…', 'Waiting for the local runtime to respond.'],
    'reading-account-and-models': [codex.connected ? 'Refreshing Codex models…' : 'Loading Codex models…', 'Checking your account and reading the model list.'],
  };
  if (stages[phase]) return { busy: true, phase, title: stages[phase][0], detail: stages[phase][1] };
  if (phase === 'failed') return { busy: false, phase, title: codex.connected ? 'Model refresh needs attention' : 'Could not connect to Codex', detail: codex.modelCatalog?.error || codex.lastError || 'Open Models to review the connection and try again.' };
  if (phase === 'sign-in-required') return { busy: false, phase, title: 'Sign in to Codex', detail: 'Connect your Codex account, then reconnect in Models.' };
  if (model === 'default' && status.defaultModelInitializing) return { busy: true, phase: 'choosing-model', title: 'Preparing your model…', detail: 'Saving the initial model choice.' };
  return null;
}

/** Describe the selected model and workspace without implying an unverified connection. */
export function welcomeReadiness({ statusLoaded = false, streamState, status = {}, selectedModel = 'default', model, cwd = '', settingsError = '' } = {}) {
  if (!statusLoaded) return { state: 'loading', title: 'Connecting to BLACKICE', detail: 'You can write your message while the workspace loads.', action: null, label: '' };
  if (streamState === 'reconnecting') return { state: 'reconnecting', title: 'Reconnecting to BLACKICE', detail: 'Your draft is kept. Live updates will resume when the connection returns.', action: null, label: '' };
  const connection = runtimeConnectionFeedback({ statusLoaded, status, model: selectedModel });
  if (connection) return { state: connection.busy ? 'connecting' : 'attention', title: connection.title, detail: connection.detail, action: connection.busy ? null : 'connections', label: connection.busy ? '' : 'Open Models' };
  if (model?.available !== true) return { state: 'setup', title: 'Connect a model to start', detail: 'Open Models to choose a connected model. You can keep writing while you set it up.', action: 'connections', label: 'Open Models' };
  if (settingsError) return { state: 'attention', title: 'Review your response settings', detail: String(settingsError), action: 'chat-context', label: 'Review settings' };
  if (!String(cwd || '').trim()) return { state: 'attention', title: 'Choose a working folder', detail: 'Select the folder BLACKICE should use for this conversation.', action: 'message-options', label: 'Choose folder' };
  return { state: 'ready', title: 'Ready when you are', detail: `${model.label || 'Your selected model'} is connected.`, action: 'connections', label: 'Change model' };
}

export function workingFolderLabel(value) {
  const path = typeof value === 'string' ? value.trim() : '';
  if (!path) return { name: 'Choose folder', path: '', missing: true };
  const normalized = path.replace(/[\\/]+$/g, '');
  const name = /^[A-Za-z]:$/.test(normalized) ? normalized + '\\'
    : normalized.split(/[\\/]/).filter(Boolean).at(-1) || path;
  return { name, path, missing: false };
}
