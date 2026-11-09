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

// These constraints remain in the model's full prompt and local validators.
const hostOnlyKeywords = ['uniqueItems', 'allOf', 'not', 'dependentRequired', 'dependentSchemas', 'if', 'then', 'else'];
const wireKeywords = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'const', 'title', 'description',
  'pattern', 'format', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
]);

const wireTypes = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/** Project strict wire grammar without mutating the authoritative host schema. */
export function compatibleWireOutputSchema(schema) {
  const wire = structuredClone(schema);
  const visit = entry => {
    if (!object(entry)) return false;
    // Unsupported exclusive branches or unknown grammar cannot be forwarded.
    // Use the complete host prompt rather than guessing how to encode them.
    if (Object.keys(entry).some(key => !wireKeywords.has(key) && !hostOnlyKeywords.includes(key))) return false;
    for (const key of hostOnlyKeywords) delete entry[key];
    if (entry.anyOf && !Array.isArray(entry.anyOf)) return false;
    if (entry.type === 'object' && object(entry.properties) && entry.anyOf?.length &&
      entry.anyOf.every(branch => object(branch) && Object.keys(branch).length &&
        Object.keys(branch).every(key => key === 'properties' || key === 'required'))) {
      // A closed base object remains usable when its attached conditional
      // checks, such as receipt confirmation/absence rules, are host-only.
      delete entry.anyOf;
    }
    if (entry.type === undefined && !entry.anyOf?.length && entry.const === undefined && entry.enum === undefined) return false;
    if (entry.type !== undefined) {
      const types = Array.isArray(entry.type) ? entry.type : [entry.type];
      if (!types.length || new Set(types).size !== types.length || !types.every(type => wireTypes.has(type))) return false;
    }
    return Object.values(entry.properties || {}).every(visit) &&
      (entry.items === undefined || visit(entry.items)) && (entry.anyOf || []).every(visit);
  };
  return visit(wire) && wire.anyOf === undefined && strictProviderSchema(wire) ? wire : null;
}

export function outputSchemaPrompt(instructions, schema) {
  const declaration = JSON.stringify(schema);
  if (instructions?.includes(declaration)) return instructions;
  return [instructions, 'Return a single JSON object matching the complete output schema below. BLACKICE validates the response locally.\n' + declaration]
    .filter(Boolean).join('\n\n');
}

/** Capability evidence comes only from this runtime's fresh provider catalog. */
export function compatibleOutputSchemaProfile({ schema, model, catalog, now = Date.now(), unavailable = false } = {}) {
  const fallback = reason => ({ structuredOutput: 'prompt-and-host-validation', structuredOutputReason: reason, hostValidationRequired: true });
  if (!schema) return fallback('schema_not_requested');
  if (!strictProviderSchema(schema)) return fallback('schema_not_strict_compatible');
  if (!compatibleWireOutputSchema(schema)) return fallback('schema_uniqueness_projection_unsafe');
  if (unavailable || !catalog || !Number.isFinite(catalog.expiresAt) || catalog.expiresAt <= now) return fallback('catalog_unavailable');
  const advertised = catalog.models?.find(item => item.id === model);
  if (!advertised) return fallback('model_not_in_catalog');
  if (!Array.isArray(advertised.supportedParameters)) return fallback('structured_output_support_unknown');
  // response_format alone may describe JSON mode without JSON Schema support.
  if (!advertised.supportedParameters.includes('structured_outputs')) return fallback('structured_output_not_advertised');
  return { structuredOutput: 'provider-json-schema', structuredOutputReason: 'provider_reported_structured_outputs', structuredOutputTransport: 'chat-completions-response-format', hostValidationRequired: true };
}
