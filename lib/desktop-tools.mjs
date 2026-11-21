export const DESKTOP_TOOL = {
  type: 'function', name: 'relay_desktop',
  description: "Operate existing Windows controls through background UI Automation. Call windows, then inspect with a returned windowId. Use the resulting refs and each control's advertised actions: invoke, set_value, select, toggle, expand, collapse, scroll or get_text. set_value replaces text or a supported numeric value. Inspect the result after a change; refresh refs after navigation or reconnection. This adapter uses accessibility controls and screenshots, not physical mouse or keyboard input.",
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['screenshot', 'windows', 'inspect', 'get_text', 'invoke', 'set_value', 'select', 'toggle', 'expand', 'collapse', 'scroll', 'scroll_into_view', 'wait'] },
      ref: { type: 'string', description: 'Stable accessibility element ref returned by inspect. Reinspect after navigation, stale refs, or reconnecting.' },
      windowId: { type: 'string', description: 'Window id returned by windows. Used for initial inspection.' },
      query: { type: 'string', maxLength: 200, description: 'Optional name, automation ID, or control type filter within a bounded inspected subtree.' },
      maxDepth: { type: 'integer', minimum: 0, maximum: 10, description: 'Inspection depth, default 5. Inspect a returned container ref to go deeper.' },
      maxNodes: { type: 'integer', minimum: 1, maximum: 300, description: 'Maximum controls visited, default 150. A truncated result needs a narrower subtree inspection.' },
      maxCharacters: { type: 'integer', minimum: 1, maximum: 12000, description: 'Maximum text returned by get_text, default 4000.' },
      value: { anyOf: [{ type: 'string', maxLength: 10000 }, { type: 'number' }], description: 'Replacement text or finite numeric value for set_value. Empty text clears a supported field; numeric controls enforce their native range.' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Required for scroll on a scrollable element ref.' },
      amount: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of semantic scroll steps, default 1.' },
      unit: { type: 'string', enum: ['small', 'large'], description: 'Semantic scroll step size, default large.' },
      milliseconds: { type: 'integer', minimum: 1, maximum: 2000 },
    },
  },
};

export const DESKTOP_INSTRUCTIONS = "\n\nBACKGROUND WINDOWS AUTOMATION\nFor relay_desktop, use windows -> inspect(windowId) -> an advertised action on ref -> inspect/get_text. A truncated tree can be narrowed with query or a container ref. scroll takes direction and optional amount/unit. If a ref expires, inspect again. If an action's result is uncertain, inspect the current control before retrying.\nSupport depends on the application's accessibility controls and Windows access. Use relay_windows to launch or attach applications and relay_browser for websites.\n";

const PHYSICAL_INPUT = new Set(['click', 'double_click', 'right_click', 'type', 'key', 'focus']);
const SUPPORTED_ACTIONS = new Set(DESKTOP_TOOL.inputSchema.properties.action.enum);
export function desktopToolForContainment(contained) {
  // Retain the existing call signature; every mode exposes the same UIA capabilities.
  return structuredClone(DESKTOP_TOOL);
}

/** Preserve supported provider actions without advertising unimplemented operations. */
export function desktopInspectionResult(value) {
  if (Array.isArray(value)) return value.map(desktopInspectionResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'actions' && Array.isArray(item)
      ? item.filter(action => SUPPORTED_ACTIONS.has(action))
      : desktopInspectionResult(item),
  ]));
}

export function createDesktopToolHandler({ desktop, onEvent, signal, maxCalls = null, contained = false }) {
  if (maxCalls !== null && (!Number.isSafeInteger(maxCalls) || maxCalls < 1)) throw new Error('Desktop action limit must be a positive whole number, or null for no application limit.');
  let calls = 0;
  return async (call, context = {}) => {
    const effectiveSignal = context.signal ? AbortSignal.any([signal, context.signal].filter(Boolean)) : signal;
    if (effectiveSignal?.aborted) throw new Error('Run cancelled.');
    if (call.name !== 'relay_desktop') throw new Error('Unknown desktop tool.');
    if (!desktop?.status().enabled) throw new Error('Windows desktop is detached. Ask the user to attach it in Relay.');
    if (maxCalls !== null && ++calls > maxCalls) throw new Error('The configured desktop action limit was reached.');
    const args = structuredClone(call.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Desktop tool arguments must be an object.');
    if (PHYSICAL_INPUT.has(args.action)) throw new Error('Physical input is not implemented by relay_desktop. Inspect the control and use its supported accessibility actions.');
    if (!SUPPORTED_ACTIONS.has(args.action)) throw new Error('Unsupported desktop action. Use an action advertised by relay_desktop and the inspected control.');
    if (Object.keys(args).some(key => !Object.hasOwn(DESKTOP_TOOL.inputSchema.properties, key))) throw new Error('Unknown desktop argument. Use element refs rather than coordinates or keyboard input.');
    if (effectiveSignal?.aborted || !desktop.status().enabled) throw new Error('Desktop control was stopped.');
    onEvent?.({ type: 'desktop', action: args.action, status: 'running' });
    if (effectiveSignal?.aborted || !desktop.status().enabled) throw new Error('Desktop control was stopped.');
    const result = await desktop.perform(args, { signal: effectiveSignal });
    if (effectiveSignal?.aborted || !desktop.status().enabled) throw new Error('Desktop control was stopped.');
    const { image, ...metadata } = desktopInspectionResult(result);
    const contentItems = [{ type: 'inputText', text: JSON.stringify(metadata) }];
    if (['invoke', 'set_value', 'select', 'toggle', 'expand', 'collapse', 'scroll', 'scroll_into_view'].includes(args.action) && metadata.observedInput?.foregroundChanged === true) {
      const code = 'DESKTOP_BACKGROUND_UNVERIFIED';
      contentItems[0].text = JSON.stringify({ ...metadata, ok: false, code, actionDispatched: true, backgroundVerified: false,
        error: 'The foreground changed during this live application action. Background-only execution was not verified; the action may already have completed. This observation alone does not identify whether the provider or concurrent user activity changed focus. Do not repeat the mutation or restore focus automatically. Inspect the possible effects and use a contained application integration or private session for background-only work.' });
      onEvent?.({ type: 'desktop', action: args.action, status: 'failed', code });
      return { success: false, code, contentItems };
    }
    onEvent?.({ type: 'desktop', action: args.action, status: 'completed' });
    if (image?.data) {
      // Include explicit mapping and target metadata alongside the image. Never persist pixels in run events.
      contentItems[0].text = JSON.stringify(metadata);
      contentItems.push({ type: 'inputImage', imageUrl: `data:${image.mimeType};base64,${image.data}` });
    }
    return { success: true, contentItems };
  };
}
