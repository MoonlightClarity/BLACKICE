export const DEFAULT_FILE_SEARCH_TIMEOUT_MS = 3000;
const boundedPath = { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$' };
export const FIND_FILES_TOOL = {
  type: 'function', name: 'relay_find_files',
  description: "Find local files by a literal filename or full-path substring ONLY. Never use this tool to find text inside a known file; use relay_workspace action search with path and query. Use query and, when the likely location is known, path or roots for those folders. For a known absolute file path, read it directly with relay_workspace action:\"read\".\npath/roots select search coverage. cwd resolves relative roots; it does not confine this search to the working folder. Omitting path/roots uses the native default: common personal folders, the working folder and computer-wide filesystem roots under current OS permissions. Traversal is recursive and follows symbolic links without revisiting cycles.\nThe working folder is an execution convenience, not a preferred source of user information. A filename or directory hit is only a candidate: generated, tailored, historical, and original documents can coexist. Do not infer source authority from location, name similarity, discovery order, or convenience. Prefer the user's designated current source; if ambiguous, compare relevant candidates using targeted discovery and read enough to establish identity before relying on the document. Do not require exhaustive search once the intended source is established.\nEach call returns one page of paths and metadata, not file contents. An empty page is not absence. Follow the returned cursor with the same query and supplied filters while cursor is present. When no cursor remains, scanComplete shows whether traversal finished; searchComplete also requires no errors or skipped paths. Review errors, skippedCount and roots before describing what was searched or not found.",
  inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: {
    query: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\r\\n\\u0000]*[^\\s\\r\\n\\u0000][^\\r\\n\\u0000]*$', description: 'Required literal FILENAME or PATH substring, for example resume. This does not search file contents. No glob or regex syntax; | is literal. Repeat unchanged when using cursor.' },
    path: { ...boundedPath, description: 'One explicit root for NAME/PATH matching only. This does not read the contents of a file at that path. Use path or roots, not both.' },
    roots: { type: 'array', minItems: 1, maxItems: 64, items: boundedPath, description: 'Explicit roots, relative to cwd or absolute. Use roots or path, not both.' },
    match: { type: 'string', enum: ['name', 'path'], description: 'Match filename (default) or complete path.' },
    extensions: { type: 'array', maxItems: 16, items: { type: 'string', pattern: '^\\.?[\\p{L}\\p{N}_-]{1,16}$' }, description: 'Optional extensions, for example pdf or .docx.' },
    caseSensitive: { type: 'boolean' },
    cursor: { type: 'string', pattern: '^fs1:[a-f0-9-]{36}:[a-f0-9-]{36}$', description: 'Opaque next-page cursor. Repeat query; other filters may be omitted or unchanged. Expires on idle timeout, capacity eviction or process restart.' },
    cwd: { ...boundedPath, description: "Optional working folder for resolving relative roots; not a source-authority preference or access boundary. Preserve it when continuing a cursor." },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum matches per page; default 50.' },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 10000, description: `Cooperative scan budget per page; default ${DEFAULT_FILE_SEARCH_TIMEOUT_MS} ms.` }
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

