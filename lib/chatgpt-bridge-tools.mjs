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
  description: "Queue work for an external ChatGPT conversation or read its saved answer. request requires requestId and prompt, with optional title/context; it returns a pending request and handoff instructions. The human copies the configured handoff from BLACKICE's ChatGPT bridge panel. Queueing does not start ChatGPT or a model. Use list/get to inspect requests; status completed includes the returned answer. cancel requires the saved id and current revision. Reuse requestId with identical content to recover a lost response. The working folder comes from the current task.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: Object.keys(fieldsByAction) },
      id: { ...text, format: 'uuid', description: 'The saved request UUID returned by request or list.' },
      requestId: { ...text, maxLength: CHATGPT_BRIDGE_LIMITS.requestIdChars, description: "Required for request. Reuse this client ID with unchanged prompt/context to recover the same saved request." },
      title: { ...text, maxLength: CHATGPT_BRIDGE_LIMITS.titleChars },
      prompt: { ...text, minLength: 1, maxLength: CHATGPT_BRIDGE_LIMITS.promptChars, description: 'The explicit task for ChatGPT.' },
      context: { ...text, maxLength: CHATGPT_BRIDGE_LIMITS.contextChars, description: "Additional task context sent with prompt. Conversation history and file contents are not attached automatically." },
      status: { type: 'string', enum: ['pending', 'completed', 'cancelled', 'all'] },
      limit: { type: 'integer', minimum: 1, maximum: CHATGPT_BRIDGE_LIMITS.listLimit },
      offset: { type: 'integer', minimum: 0 },
      revision: { type: 'integer', minimum: 1, description: 'Current request revision; required when cancelling.' },
    },
    required: ['action'], additionalProperties: false,
  },
};

export const CHATGPT_BRIDGE_INSTRUCTIONS = "\n\nCHATGPT BRIDGE\nrelay_chatgpt saves requests for an external ChatGPT conversation. A pending request waits for the human to copy the connector handoff from BLACKICE's bridge panel; it does not start ChatGPT. Use list/get to read the saved answer after the external connector completes it. The tool description lists request, retry and cancellation fields.\n";

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
