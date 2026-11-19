const boundedPath = { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$' };
export const FIND_FILES_TOOL = {
  type: 'function', name: 'relay_find_files',
  description: 'Find local files by a literal filename or full-path substring, then read selected returned paths (including PDF or DOCX) directly with relay_workspace action read. If an unattached local document is a task input, find it early when its path is unknown. Search is recursive and returns bounded pages, not directory dumps. query is required on every call, including continuation; repeat the returned query with cursor for the next page. Omitted path/roots searches computer-wide filesystem roots under current OS permissions, prioritizing common personal folders and the working folder. Explicit path/roots narrows coverage. Recursive traversal follows symbolic-link targets with cycle prevention. An empty partial page is not absence; continue its cursor. Check searchComplete, errors, skippedCount and roots for actual coverage. No contents are read.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: {
    query: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\r\\n\\u0000]*[^\\s\\r\\n\\u0000][^\\r\\n\\u0000]*$', description: 'Required literal substring, for example resume. No glob or regex syntax; | is literal. Repeat unchanged when using cursor.' },
    path: { ...boundedPath, description: 'One explicit file or directory root. Use path or roots, not both.' },
    roots: { type: 'array', minItems: 1, maxItems: 64, items: boundedPath, description: 'Explicit roots, relative to cwd or absolute. Use roots or path, not both.' },
    match: { type: 'string', enum: ['name', 'path'], description: 'Match filename (default) or complete path.' },
    extensions: { type: 'array', maxItems: 16, items: { type: 'string', pattern: '^\\.?[\\p{L}\\p{N}_-]{1,16}$' }, description: 'Optional extensions, for example pdf or .docx.' },
    caseSensitive: { type: 'boolean' },
    cursor: { type: 'string', pattern: '^fs1:[a-f0-9-]{36}:[a-f0-9-]{36}$', description: 'Opaque next-page cursor. Repeat query; other filters may be omitted or unchanged. Expires on idle timeout, capacity eviction or process restart.' },
    cwd: { ...boundedPath, description: 'Optional working folder; preserve it when continuing.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum matches per page; default 50.' },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 10000, description: 'Cooperative scan budget per page; default 1000 ms.' }
  } }
};
const invalid = (field, expected) => Object.assign(new Error('relay_find_files: ' + field + ' ' + expected), { code: 'FILE_SEARCH_ARGUMENT_INVALID', field, actionDispatched: false });
// Validate the exact advertised schema; the host and model do not get different ranges.
function validate(schema, value, field) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(field, 'must be an object.');
    for (const name of schema.required || []) if (value[name] === undefined) throw invalid(name, 'is required. Supply a literal filename substring such as query: "resume"; continuation also repeats query with cursor.');
    for (const name of Object.keys(value)) {
      if (!schema.properties[name]) throw invalid(name, 'is not supported. Use the advertised field names; file filtering uses query, not pattern or glob.');
      validate(schema.properties[name], value[name], name);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw invalid(field, 'must be an array.');
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) throw invalid(field, 'must contain ' + (schema.minItems || 0) + ' to ' + schema.maxItems + ' items.');
    value.forEach((item, index) => validate(schema.items, item, field + '[' + index + ']'));
  } else {
    if (schema.type === 'integer' ? !Number.isInteger(value) : typeof value !== schema.type) throw invalid(field, 'must be ' + schema.type + '.');
    if (schema.enum && !schema.enum.includes(value)) throw invalid(field, 'must be one of: ' + schema.enum.join(', ') + '.');
    if (schema.type === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength) throw invalid(field, 'must contain ' + (schema.minLength || 0) + ' to ' + schema.maxLength + ' characters.');
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) throw invalid(field, field === 'query' ? 'must be nonempty single-line literal text.' : 'does not match the advertised format.');
    }
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) throw invalid(field, 'must be an integer from ' + schema.minimum + ' to ' + schema.maximum + '.');
  }
}
export function validateFileSearchCall(args) {
  validate(FIND_FILES_TOOL.inputSchema, args, 'arguments');
  if (args.path !== undefined && args.roots !== undefined) throw invalid('path/roots', 'are mutually exclusive; supply only one.');
  return args;
}

