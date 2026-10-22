import { createHash } from 'node:crypto';

const invalidCatalog = message => Object.assign(new Error(message), {
  code: 'CHATGPT_TOOL_CATALOG_INVALID',
  status: 503,
});

/**
 * Capture one catalog for discovery, authorization and dispatch. The providers
 * remain the owners of tool behavior; this snapshot never executes a tool or
 * changes its capabilities. Build a new snapshot when beginning a new request.
 */
export function createChatGPTToolCatalog({ providers, version }) {
  if (!Array.isArray(providers)) throw invalidCatalog('Provide the BLACKICE tool providers.');

  const definitions = [], entries = new Map();
  for (const provider of providers) {
    const list = provider?.tools, call = provider?.call;
    if (typeof list !== 'function' || typeof call !== 'function') {
      throw invalidCatalog('Each BLACKICE tool provider must support discovery and execution.');
    }
    const source = list.call(provider);
    if (!Array.isArray(source)) throw invalidCatalog('BLACKICE tool discovery must return a catalog.');
    const invoke = call.bind(provider);

    for (const original of source) {
      if (!original || typeof original !== 'object' || Array.isArray(original) || typeof original.name !== 'string' || !original.name) {
        throw invalidCatalog('Every BLACKICE tool must have a name.');
      }
      const { scope, requiredScope, requiredScopes, scopes, annotations, ...definition } = structuredClone(original);
      // Match the original Currents connector's public contract: optional
      // action-classification hints are omitted, not replaced with false claims.
      // Keep display annotations and the actual OAuth admission rules intact.
      if (annotations && typeof annotations === 'object' && !Array.isArray(annotations)) {
        const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint, ...displayAnnotations } = annotations;
        if (Object.keys(displayAnnotations).length) definition.annotations = displayAnnotations;
      }
      if (entries.has(definition.name)) {
        throw invalidCatalog(`The BLACKICE tool name ${definition.name} is registered more than once.`);
      }
      const required = requiredScopes || scopes || [scope || requiredScope || 'read'];
      const securitySchemes = [{ type: 'oauth2', scopes: [...new Set(['read', ...required])] }];
      const tool = {
        ...definition,
        securitySchemes,
        _meta: {
          ...definition._meta,
          securitySchemes: structuredClone(securitySchemes),
          'openai/toolInvocation/invoking': 'Contacting BLACKICE',
          'openai/toolInvocation/invoked': 'Action status received',
        },
      };
      definitions.push(tool);
      entries.set(tool.name, { definition: tool, requiredScopes: securitySchemes[0].scopes, invoke });
    }
  }

  const status = {
    sha256: createHash('sha256').update(JSON.stringify(definitions)).digest('hex'),
    toolCount: definitions.length,
    serverVersion: version,
  };
  return Object.freeze({
    tools: () => structuredClone(definitions),
    status: () => ({ ...status }),
    get(name) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      return {
        definition: structuredClone(entry.definition),
        requiredScopes: [...entry.requiredScopes],
        call: (args, client) => entry.invoke(name, args, client),
      };
    },
  });
}
