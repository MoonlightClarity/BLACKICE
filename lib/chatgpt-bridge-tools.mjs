import { CHATGPT_BRIDGE_LIMITS } from './chatgpt-bridge.mjs';

const text = { type: 'string' };
const fieldsByAction = {
  status: [], list: ['status', 'limit', 'offset'], get: ['id'],
  request: ['requestId', 'title', 'prompt', 'context'], cancel: ['id', 'revision'],
};
const fail = message => Object.assign(new Error(message), { code: 'CHATGPT_BRIDGE_INVALID' });
const check = signal => { if (signal?.aborted) throw Object.assign(new Error('Task stopped.'), { code: 'CHATGPT_BRIDGE_STOPPED' }); };

export const CHATGPT_BRIDGE_TOOL = {
  type: 'function', name: 'relay_chatgpt',
  description: 'Manual handoff only: queue a request when the user explicitly asks to exchange work with an external ChatGPT conversation through the configured BLACKICE bridge, inspect saved requests and answers, or cancel pending work. Never use this as automatic routing or fallback for a model error, unavailable tool, timeout, or approval interruption. This tool returns immediately; it does not call a model, wake ChatGPT, open a browser, or fall back to an API. The human uses the bridge panel to copy the configured connector handoff. Only the external ChatGPT connector can complete requests. Reuse requestId with unchanged content for exact retries. The working folder is inherited from this task.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: Object.keys(fieldsByAction) },
      id: { ...text, format: 'uuid', description: 'The saved request UUID returned by request or list.' },
      requestId: { ...text, maxLength: CHATGPT_BRIDGE_LIMITS.requestIdChars, description: 'Required for request: a stable client ID reused only for an exact retry.' },
      title: { ...text, maxLength: CHATGPT_BRIDGE_LIMITS.titleChars },
      prompt: { ...text, minLength: 1, maxLength: CHATGPT_BRIDGE_LIMITS.promptChars, description: 'The explicit task for ChatGPT.' },
      context: { ...text, maxLength: CHATGPT_BRIDGE_LIMITS.contextChars, description: 'Only the context the user wants supplied to ChatGPT; no implicit conversation or file contents are attached.' },
      status: { type: 'string', enum: ['pending', 'completed', 'cancelled', 'all'] },
      limit: { type: 'integer', minimum: 1, maximum: CHATGPT_BRIDGE_LIMITS.listLimit },
      offset: { type: 'integer', minimum: 0 },
      revision: { type: 'integer', minimum: 1, description: 'Current request revision; required when cancelling.' },
    },
    required: ['action'], additionalProperties: false,
  },
};

export const CHATGPT_BRIDGE_INSTRUCTIONS = '\n\nCHATGPT BRIDGE\nUse relay_chatgpt only when the user explicitly asks for a manual ChatGPT handoff through their configured connector. Ordinary requests for BLACKICE or its selected model must continue on that connection. Do not automatically route a task to Chat Mode, use the bridge as a fallback for an unavailable model or capability, or use it to avoid a host approval. ChatGPT can pause for its own approvals or mode changes, so do not promise unattended execution or round-trip reliability. Supply an explicit prompt and only relevant context. request saves pending work and returns immediately; it does not wake ChatGPT or use an API provider. Reuse the same requestId and unchanged content after an uncertain response. Direct the human to the ChatGPT bridge panel to copy the configured handoff. Use list/get to inspect saved answers; do not poll continuously, invent an answer, or mark a request complete yourself. Only a completed receipt contains a returned ChatGPT answer. Read the current revision before cancelling. The working folder is inherited from the current task.\n';

export function createChatGPTBridgeToolHandler({ store, cwd, signal } = {}) {
  return async (call, context = {}) => {
    const effectiveSignal = context.signal ? AbortSignal.any([signal, context.signal].filter(Boolean)) : signal;
    try {
      check(effectiveSignal);
      if (call.name !== CHATGPT_BRIDGE_TOOL.name) throw fail('Unknown ChatGPT bridge tool.');
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(fieldsByAction, args.action)) throw fail('Choose an action from the ChatGPT bridge tool schema.');
      const allowed = ['action', ...fieldsByAction[args.action]];
      if (Object.keys(args).some(key => !allowed.includes(key))) throw fail('Use only the fields allowed for this ChatGPT bridge action.');
      if (!store) throw Object.assign(new Error('The ChatGPT bridge is not available.'), { code: 'CHATGPT_BRIDGE_UNAVAILABLE' });
      let result;
      if (args.action === 'status') result = { bridge: store.status() };
      else if (args.action === 'list') {
        const options = Object.fromEntries(['status', 'limit', 'offset'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
        result = store.list(options);
      } else if (args.action === 'get') result = { request: store.get(args.id) };
      else if (args.action === 'request') {
        check(effectiveSignal);
        const request = await store.enqueue({ requestId: args.requestId, ...(args.title === undefined ? {} : { title: args.title }), prompt: args.prompt, ...(args.context === undefined ? {} : { context: args.context }), cwd });
        result = { request, ...(request.status === 'pending' ? { handoff: 'Open the ChatGPT bridge panel to copy this request’s configured connector handoff. The request is waiting for ChatGPT; it has not started automatically.' } : {}) };
      } else {
        check(effectiveSignal);
        result = { request: await store.cancel({ id: args.id, revision: args.revision }) };
      }
      // A successful durable write remains a truthful receipt even if cancellation arrives during its save.
      if (!['request', 'cancel'].includes(args.action)) check(effectiveSignal);
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (cause) {
      return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: cause.message, ...(cause.code ? { code: cause.code } : {}) }) }] };
    }
  };
}
