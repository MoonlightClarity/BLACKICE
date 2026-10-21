export const CHAT_MODE_MODEL = 'chatgpt::chat-mode';
export const CHAT_MODE_LABEL = 'ChatGPT Chat Mode';

export const isChatModeModel = (value, status = {}) => (value === 'default' ? status.defaultModel : value) === CHAT_MODE_MODEL;

export const CHAT_MODE_RETIRED_MESSAGE = 'ChatGPT Chat Mode has been retired. Use the BLACKICE connection from ChatGPT, or choose a supported model here. Your saved conversation and draft are kept.';

/** Historical identities stay visible; a stale catalog cannot revive a retired route. */
export function modelRouteMetadata(model = {}, status = {}) {
  if (isChatModeModel(model.id || model.model || model.value, status)) return {
    available: false, retired: true, routeLabel: CHAT_MODE_LABEL, routeState: 'retired',
    supportsTools: false, supportsImages: false, supportsReasoningSelection: false,
    availabilityReason: CHAT_MODE_RETIRED_MESSAGE, availabilityLabel: 'Retired',
  };
  const metadata = {};
  if (model.experimental === true) metadata.experimental = true;
  for (const name of ['supportsTools', 'supportsImages', 'supportsReasoningSelection']) if (typeof model[name] === 'boolean') metadata[name] = model[name];
  if (typeof model.availabilityReason === 'string' && model.availabilityReason.trim()) metadata.availabilityReason = model.availabilityReason;
  return metadata;
}

/** Historical route receipts never depend on the next-reply picker or live catalog. */
export function recordedResponseRoutes(run = {}) {
  const groups = new Map();
  for (const node of run.workflow?.nodes || []) {
    if (node.type !== 'agent') continue;
    const recorded = run.nodes?.[node.id]?.resolvedModel || [...(run.events || [])].reverse().find(event => event.nodeId === node.id && event.data?.type === 'thread' && typeof event.data.model === 'string')?.data.model;
    if (!isChatModeModel(recorded)) continue;
    if (!groups.has(recorded)) groups.set(recorded, { model: recorded, label: CHAT_MODE_LABEL, retired: true, agents: [] });
    groups.get(recorded).agents.push({ id: node.id, name: node.name || node.id });
  }
  return [...groups.values()];
}
