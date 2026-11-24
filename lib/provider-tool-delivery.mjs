export const ACCEPTED_PROVIDER_TOOL_DELIVERY = 'accepted-provider-request';

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

// Match the exact active request owned by this turn, never a historical,
// assistant, tool, checkpoint or merely assembled copy.
function submittedCurrentPrompt(serializedBody, state, type, promptIndex) {
  const current = state.inputImageMessage;
  if (typeof current?.content !== 'string' || !state.record?.messages?.includes(current)) return undefined;
  let body;
  try { body = JSON.parse(serializedBody); } catch { return undefined; }
  const messages = type === 'openai' ? body?.input : body?.messages;
  if (!Array.isArray(messages)) return undefined;
  const message = messages[promptIndex];
  if (message?.role !== 'user') return undefined;
  if (message.content === current.content || Array.isArray(message.content) && message.content.some(
    item => ['text','input_text'].includes(item?.type) && item.text === current.content)) return current.content;
}

/** A delivery observer cannot replay an operation or replace the actual transport result. */
export function providerToolDeliveryObserver(state, type, promptIndex = -1) {
  if (typeof state?.onToolResultDelivered !== 'function' && typeof state?.onPromptAccepted !== 'function') return undefined;
  const tools = state.tools;
  return { onAccepted: serializedBody => {
    if (!state.promptAcceptanceObserved && typeof state.onPromptAccepted === 'function') {
      const prompt = submittedCurrentPrompt(serializedBody, state, type, promptIndex);
      if (prompt !== undefined) {
        state.promptAcceptanceObserved = true;
        try { state.onPromptAccepted(prompt); } catch { /* A receipt cannot replace transport settlement. */ }
      }
    }
    if (typeof state.onToolResultDelivered !== 'function') return;
    for (const delivery of providerToolResultDeliveries(serializedBody, { type, tools })) {
      const host=state.record?.hostReviewFeedback?.find(row=>row.callId===delivery.call.callId);
      try { state.onToolResultDelivered({ ...delivery, ...(host?{origin:'host-initiated-read',feedbackId:host.feedbackId}:{}), delivery: ACCEPTED_PROVIDER_TOOL_DELIVERY, providerType: type }); } catch { /* Missing acknowledgment remains fail-closed in the caller. */ }
    }
  } };
}
