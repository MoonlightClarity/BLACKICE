const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Do not turn optional fields into required values or silently remove constraints. */
export function strictProviderSchema(schema) {
  if (!object(schema) || schema.type !== 'object') return false;
  const visit = (entry, depth = 0) => {
    if (!object(entry) || depth > 24) return false;
    if (entry.enum !== undefined && (!Array.isArray(entry.enum) || !entry.enum.length)) return false;
    const types = Array.isArray(entry.type) ? entry.type : [entry.type];
    if (types.includes('object') || entry.properties !== undefined) {
      if (!types.includes('object') || !object(entry.properties) || entry.additionalProperties !== false || !Array.isArray(entry.required)) return false;
      const names = Object.keys(entry.properties);
      if (entry.required.length !== names.length || new Set(entry.required).size !== names.length || entry.required.some(name => !Object.hasOwn(entry.properties, name))) return false;
      if (!Object.values(entry.properties).every(value => visit(value, depth + 1))) return false;
    }
    if (types.includes('array') && !visit(entry.items, depth + 1)) return false;
    for (const name of ['anyOf', 'allOf', 'oneOf']) if (entry[name] !== undefined && (!Array.isArray(entry[name]) || !entry[name].length || !entry[name].every(value => visit(value, depth + 1)))) return false;
    return true;
  };
  return visit(schema);
}

/** Capability evidence comes only from this runtime's fresh provider catalog. */
export function compatibleOutputSchemaProfile({ schema, model, catalog, now = Date.now(), unavailable = false } = {}) {
  const fallback = reason => ({ structuredOutput: 'prompt-and-host-validation', structuredOutputReason: reason, hostValidationRequired: true });
  if (!schema) return fallback('schema_not_requested');
  if (!strictProviderSchema(schema)) return fallback('schema_not_strict_compatible');
  if (unavailable || !catalog || !Number.isFinite(catalog.expiresAt) || catalog.expiresAt <= now) return fallback('catalog_unavailable');
  const advertised = catalog.models?.find(item => item.id === model);
  if (!advertised) return fallback('model_not_in_catalog');
  if (!Array.isArray(advertised.supportedParameters)) return fallback('structured_output_support_unknown');
  // response_format alone may describe JSON mode without JSON Schema support.
  if (!advertised.supportedParameters.includes('structured_outputs')) return fallback('structured_output_not_advertised');
  return { structuredOutput: 'provider-json-schema', structuredOutputReason: 'provider_reported_structured_outputs', structuredOutputTransport: 'chat-completions-response-format', hostValidationRequired: true };
}
