/** Exact tool result texts in the final serialized provider request, after context projection. */
export function providerToolResultDeliveries(body, { type, tools = [] } = {}) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return []; } }
  if (!body || typeof body !== 'object') return [];
  const messages = type === 'openai' ? body.input : body.messages;
  if (!Array.isArray(messages)) return [];
  const catalog = new Map(tools.filter(tool => typeof tool?.wireName === 'string').map(tool => [tool.wireName, tool]));
  const calls = new Map(), outputs = [];
  const addCall = (id, name, args) => {
    const spec = catalog.get(name);
    if (typeof id !== 'string' || !id || !spec) return;
    const call = { name: spec.name, ...(spec.namespace === undefined ? {} : { namespace: spec.namespace }), arguments: args, callId: id };
    const previous = calls.get(id);
    if (previous === null) return;
    if (previous && JSON.stringify(previous) !== JSON.stringify(call)) calls.set(id, null);
    else calls.set(id, call);
  };
  const textItems = content => typeof content === 'string' ? [{ type: 'inputText', text: content }]
    : Array.isArray(content) ? content.flatMap(item => ['text', 'input_text'].includes(item?.type) && typeof item.text === 'string'
      ? [{ type: 'inputText', text: item.text }] : []) : [];
  for (const message of messages) {
    if (type === 'openai') {
      if (message?.type === 'function_call') addCall(message.call_id, message.name, message.arguments);
      if (message?.type === 'function_call_output') outputs.push({ id: message.call_id, contentItems: textItems(message.output) });
    } else if (type === 'anthropic') {
      if (!Array.isArray(message?.content)) continue;
      for (const item of message.content) {
        if (message.role === 'assistant' && item?.type === 'tool_use') addCall(item.id, item.name, item.input);
        if (message.role === 'user' && item?.type === 'tool_result') outputs.push({ id: item.tool_use_id, contentItems: textItems(item.content), success: item.is_error !== true });
      }
    } else {
      if (message?.role === 'assistant') for (const call of message.tool_calls || []) addCall(call.id, call.function?.name, call.function?.arguments);
      if (message?.role === 'tool') outputs.push({ id: message.tool_call_id, contentItems: textItems(message.content) });
    }
  }
  return outputs.flatMap(output => {
    const call = calls.get(output.id);
    return call ? [{ call, result: { contentItems: output.contentItems, ...(output.success === undefined ? {} : { success: output.success }) } }] : [];
  });
}

/** A delivery observer cannot replay an operation or replace the actual transport result. */
export function providerToolDeliveryObserver(state, type) {
  if (typeof state?.onToolResultDelivered !== 'function') return undefined;
  const tools = state.tools;
  return { onAccepted: serializedBody => {
    for (const delivery of providerToolResultDeliveries(serializedBody, { type, tools })) {
      try { state.onToolResultDelivered(delivery); } catch { /* Missing acknowledgment remains fail-closed in the caller. */ }
    }
  } };
}
