import { BENCHMARK_COMMAND, BENCHMARK_LIMITS, benchmarkError } from './benchmark-profile.mjs';

// One contract supplies both the published action variants and host validation.
const actions = {
  list: { required: [], optional: ['path', 'depth', 'limit'] },
  read: { required: ['path'], optional: ['startLine', 'lineCount'] },
  write: { required: ['path', 'text'], optional: ['expectedHash'] },
  patch: { required: ['path', 'oldText', 'newText'], optional: ['expectedHash'] },
  run: { required: ['command'], optional: ['timeoutMs'] },
};
const fields = {
  path: { type: 'string', description: 'One task-relative file or directory, using forward slashes. Only .cjs files below src are writable.' },
  text: { type: 'string', description: 'Complete UTF-8 source for write.' },
  oldText: { type: 'string', minLength: 1, description: 'Exact nonempty source text that occurs once, for patch.' },
  newText: { type: 'string', description: 'Replacement text for patch; empty text deletes oldText.' },
  expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Optional current-source SHA-256 for write or patch.' },
  startLine: { type: 'integer', minimum: 1, maximum: 200000 },
  lineCount: { type: 'integer', minimum: 1, maximum: 1500 },
  depth: { type: 'integer', minimum: 0, maximum: 3 },
  limit: { type: 'integer', minimum: 1, maximum: 300 },
  command: { type: 'string', enum: [BENCHMARK_COMMAND] },
  timeoutMs: { type: 'integer', minimum: 100, maximum: BENCHMARK_LIMITS.commandTimeoutMs },
};
const allowed = definition => ['action', ...definition.required, ...definition.optional];
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
freeze(actions);
freeze(fields);
const variants = Object.entries(actions).map(([name, definition]) => ({
  type: 'object',
  additionalProperties: false,
  required: ['action', ...definition.required],
  properties: {
    action: { type: 'string', const: name },
    ...Object.fromEntries(allowed(definition).filter(key => key !== 'action').map(key => [key, fields[key]])),
  },
}));
const actionUsage = Object.entries(actions).map(([name, definition]) =>
  name + ': ' + ['action', ...definition.required, ...definition.optional.map(key => key + '?')].join(', ')
).join('; ');

export const BENCHMARK_WORKSPACE_TOOL = freeze({
  type: 'function',
  name: 'relay_workspace',
  description: 'Read and edit this benchmark attempt, and run its fixed public check. read/list cover fixed task files and src; write/patch change only .cjs files below src; run accepts exactly node test-public.cjs. Paths are task-relative with forward slashes. Read the current source before editing, then inspect the saved bytes and actual command result. Supply only the fields for the selected action, including when a value would be empty. A ? marks an optional field: ' + actionUsage + '.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    // Keep root properties visible to clients; oneOf supplies the exact action contract.
    properties: {
      action: { type: 'string', enum: Object.keys(actions), description: 'Select one action and supply only its permitted fields.' },
      ...fields,
    },
    oneOf: variants,
  },
});

function fieldError(action, name, detail) {
  const code = name === 'path' ? 'BENCHMARK_PATH' : name === 'command' ? 'BENCHMARK_COMMAND' : 'BENCHMARK_ARGUMENTS';
  return benchmarkError(code, 'Field ' + JSON.stringify(name) + ' for ' + action + ' ' + detail);
}
function validateField(action, name, value) {
  const rule = fields[name];
  if (rule.type === 'string' && typeof value !== 'string') throw fieldError(action, name, 'must be a string.');
  if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum))
    throw fieldError(action, name, 'must be an integer from ' + rule.minimum + ' to ' + rule.maximum + '.');
  if (rule.minLength !== undefined && value.length < rule.minLength) throw fieldError(action, name, 'must be nonempty.');
  if (rule.pattern && !new RegExp(rule.pattern).test(value)) throw fieldError(action, name, 'must be a lowercase 64-character SHA-256.');
  if (rule.enum && !rule.enum.includes(value)) throw fieldError(action, name, 'must be exactly ' + JSON.stringify(rule.enum[0]) + '.');
}

/** Structural validation only; the handler separately verifies paths, integrity and effects. */
export function parseBenchmarkWorkspaceCall(call) {
  if (call?.name !== 'relay_workspace' || call.namespace)
    throw benchmarkError('BENCHMARK_TOOL_UNAVAILABLE', 'This benchmark exposes only its scoped workspace tool and relay_directory_action.');
  let args;
  try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; }
  catch { throw benchmarkError('BENCHMARK_ARGUMENTS', 'Tool arguments must be one JSON object.'); }
  if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, 'action') ||
      typeof args.action !== 'string' || !Object.hasOwn(actions, args.action))
    throw benchmarkError('BENCHMARK_ACTION', 'Use list, read, write, patch or run on relay_workspace. Plan and focus use relay_directory_action.');
  const definition = actions[args.action], permitted = allowed(definition);
  const unexpected = Object.keys(args).filter(name => !permitted.includes(name));
  if (unexpected.length)
    throw benchmarkError('BENCHMARK_ARGUMENTS', 'Action ' + args.action + ' does not accept fields ' +
      unexpected.map(name => JSON.stringify(name)).join(', ') + '. Allowed fields: ' + permitted.join(', ') +
      '. Required fields: ' + ['action', ...definition.required].join(', ') + '. Omit other fields entirely.');
  for (const name of definition.required)
    if (!Object.hasOwn(args, name)) throw fieldError(args.action, name, 'is required. Required fields: ' + ['action', ...definition.required].join(', ') + '.');
  for (const name of Object.keys(args))
    if (name !== 'action') validateField(args.action, name, args[name]);
  return args;
}
