import path from 'node:path';
import { parseCodeBlockCall } from './code-block-tool.mjs';
import { benchmarkNodeExecutable } from './benchmark-workspace.mjs';
import { BENCHMARK_COMMAND } from './benchmark-profile.mjs';

const JSON_CHECK = "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'))";
const CHECK_TIMEOUT_MS = 10000;
const error = (message, code, details = {}) => Object.assign(new Error(message), { code, actionDispatched: false, ...details });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const response = (value, success = false, code) => ({
  success, ...(code ? { code } : {}),
  ...(typeof value.actionDispatched === 'boolean' ? { actionDispatched: value.actionDispatched } : {}),
  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
});
const quote = value => "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
const invalidReceipt = message => error(message, 'CODE_CHECK_RECEIPT_INVALID', { actionDispatched: undefined });
const sourceIdentity = value => {
  if (!object(value) || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || !Number.isSafeInteger(value.bytes) || value.bytes < 0)
    throw error('The code checker requires CB1 pre-read source identity.', 'CODE_CHECK_SOURCE_UNVERIFIED');
  return { sha256: value.sha256, bytes: value.bytes };
};
function body(result) {
  if (!object(result) || typeof result.success !== 'boolean' || !Array.isArray(result.contentItems))
    throw invalidReceipt('The selected workspace returned no native check receipt.');
  const item = result.contentItems.find(item => item?.type === 'inputText' && typeof item.text === 'string');
  let value;
  try { value = JSON.parse(item?.text); } catch { throw invalidReceipt('The workspace check receipt is not a JSON object.'); }
  if (!object(value)) throw invalidReceipt('The workspace check receipt is not a JSON object.');
  return value;
}
const nativeError = cause => ({
  name: cause.name || 'Error', message: String(cause.message || cause),
  ...(cause.code === undefined ? {} : { code: cause.code }),
  ...(typeof cause.actionDispatched === 'boolean' ? { actionDispatched: cause.actionDispatched } : {}),
  ...(cause.launch === undefined ? {} : { launch: cause.launch }),
  ...(cause.recovery === undefined ? {} : { recovery: cause.recovery }),
});

/** The chosen workspace owns admission, process execution and cancellation settlement. */
export function createCodeCheckAdapters({ workspaceHandler, benchmark = false, cwd } = {}) {
  if (typeof workspaceHandler !== 'function') throw new TypeError('A selected workspace handler is required.');
  if (typeof benchmark !== 'boolean') throw new TypeError('benchmark must be a boolean.');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw new TypeError('An absolute check working directory is required.');

  function prepare(call, kind) {
    const args = parseCodeBlockCall(call);
    if (args.action !== 'check' || args.check !== kind)
      throw error('Use the adapter for the requested code check.', 'CODE_CHECK_KIND_MISMATCH');
    if (Buffer.from(args.path, 'utf8').toString('utf8') !== args.path)
      throw error('The code-check path must round-trip as UTF-8.', 'CODE_CHECK_PATH');
    const supported = benchmark ? kind === 'public' && args.language === 'javascript'
      : kind === 'syntax' && ['javascript', 'json'].includes(args.language);
    if (!supported) return { args, supported: false };
    let command;
    if (benchmark) command = BENCHMARK_COMMAND;
    else {
      const executable = benchmarkNodeExecutable(), target = path.resolve(cwd, args.path);
      const parameters = args.language === 'javascript' ? ['--check', '--', target] : ['-e', JSON_CHECK, '--', target];
      command = (process.platform === 'win32' ? '& ' : '') + [executable, ...parameters].map(quote).join(' ');
    }
    return { args, supported: true, call: { ...call, name: 'relay_workspace',
      arguments: { action: 'run', command, ...(benchmark ? {} : { timeoutMs: CHECK_TIMEOUT_MS }) } } };
  }

  function unavailable(args) {
    return { code: 'CODE_CHECK_UNAVAILABLE', error: 'No ' + args.check + ' checker for ' + args.language + ' is attached to this workspace.',
      performed: false, actionDispatched: false, kind: args.check, language: args.language, path: args.path };
  }

  function adapter(kind) {
    const check = async (call, context = {}) => {
      let prepared, source, result, invoked = false;
      try {
        prepared = prepare(call, kind);
        if (!prepared.supported) return response(unavailable(prepared.args), false, 'CODE_CHECK_UNAVAILABLE');
        source = sourceIdentity(context.codeSource);
        if (prepared.args.expectedHash !== undefined && prepared.args.expectedHash !== source.sha256)
          throw error('The pre-read source differs from expectedHash; no check was dispatched.', 'CODE_CHECK_SOURCE_CONFLICT');
        if (context.signal?.aborted) throw error('Code check cancelled before dispatch.', 'ABORT_ERR', { name: 'AbortError' });
        invoked = true;
        result = await workspaceHandler(prepared.call, context);
        const value = body(result);
        const cancelled = value.cancelled === true || value.code === 'ABORT_ERR' || result.code === 'ABORT_ERR' || context.signal?.aborted === true;
        const terminal = Number.isInteger(value.exitCode) || value.timedOut === true || cancelled;
        const performed = value.actionDispatched === false || value.performed === false ? false : terminal ? true : 'unconfirmed';
        const passed = result.success && terminal && performed === true && value.exitCode === 0
          && !value.timedOut && !cancelled && (value.signal === null || value.signal === undefined);
        const code = passed ? undefined : result.code || value.code || (terminal ? 'CODE_CHECK_FAILED' : 'CODE_CHECK_RECEIPT_INVALID');
        return response({ ...value, kind, language: prepared.args.language, path: prepared.args.path,
          performed, ...(cancelled ? { cancelled: true } : {}),
          checkedSource: source, sourceAtomic: false,
          sourceBinding: 'CB1 pre-read identity; this receipt does not claim an atomic read-and-check.',
          nativeResult: result }, passed, code);
      } catch (cause) {
        const cancelled = cause.name === 'AbortError' || cause.code === 'ABORT_ERR' || context.signal?.aborted === true;
        const dispatched = cause.actionDispatched;
        return response({ kind, ...(prepared ? { language: prepared.args.language, path: prepared.args.path } : {}),
          performed: !invoked || dispatched === false ? false : 'unconfirmed',
          ...(!invoked || dispatched === false ? { actionDispatched: false } : typeof dispatched === 'boolean' ? { actionDispatched: dispatched } : {}),
          ...(cancelled ? { cancelled: true } : {}), error: String(cause.message || cause),
          code: cause.code || (cancelled ? 'ABORT_ERR' : 'CODE_CHECK_FAILED'),
          ...(source ? { checkedSource: source, sourceAtomic: false } : {}),
          ...(result === undefined ? {} : { nativeResult: result }), nativeError: nativeError(cause) },
        false, cause.code || (cancelled ? 'ABORT_ERR' : 'CODE_CHECK_FAILED'));
      }
    };
    check.describeOperation = async (call, context = {}) => {
      const prepared = prepare(call, kind);
      if (!prepared.supported) throw error(unavailable(prepared.args).error, 'CODE_CHECK_UNAVAILABLE', { performed: false });
      if (typeof workspaceHandler.describeOperation !== 'function')
        throw error('The selected workspace has no operation descriptor.', 'CODE_OPERATION_UNAVAILABLE');
      return workspaceHandler.describeOperation(prepared.call, context);
    };
    check.normalizeOperationResult = (result, context = {}) => {
      const prepared = prepare(context.call, kind);
      if (!prepared.supported) return result;
      return typeof workspaceHandler.normalizeOperationResult === 'function'
        ? workspaceHandler.normalizeOperationResult(result, { ...context, call: prepared.call }) : result;
    };
    return check;
  }
  return { syntaxCheck: adapter('syntax'), publicCheck: adapter('public') };
}
