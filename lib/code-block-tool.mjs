import { createHash } from 'node:crypto';

const MAX_CODE_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const error = (message, code = 'CODE_BLOCK_ARGUMENTS') => Object.assign(new Error(message), { code, actionDispatched: false });
const aliases = { js: 'javascript', node: 'javascript', nodejs: 'javascript', cjs: 'javascript', mjs: 'javascript', py: 'python', ts: 'typescript', sh: 'shell', bash: 'shell', ps1: 'powershell', txt: 'text' };
const languageName = value => aliases[value.toLowerCase()] || value.toLowerCase();
const properties = {
  action: { type: 'string', enum: ['save', 'check'] },
  language: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_+.-]{0,39}$', description: 'Source language, for example javascript, json or python. This does not select an executable.' },
  path: { type: 'string', minLength: 1, description: 'One file path accepted by the attached workspace. No cwd override.' },
  code: { type: 'string', description: 'Complete source for save, separate from explanatory prose. Maximum 1 MiB of UTF-8 source.' },
  format: { type: 'string', enum: ['raw', 'fenced'], description: 'Save only. raw preserves every byte; fenced accepts one whole fenced block, with no surrounding prose.' },
  check: { type: 'string', enum: ['syntax', 'public'], description: 'Check only. Uses an attached host checker; never accepts a model-supplied command. An unavailable checker is reported explicitly.' },
  expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Expected current-file SHA-256. Save requires a backend with guarded writes. Check rejects a different source.' }
};

export const CODE_BLOCK_TOOL = {
  type: 'function', name: 'relay_code',
  description: 'Save explicit source code and verify its saved bytes, or check a saved file. save requires language, path and code; optional format defaults to raw. No prose or final-answer text is searched for code. check requires language, path and check:syntax or check:public. Saving does not run the source. Readback verification, syntax checking and public-test results are separate evidence; a syntax pass is not task correctness. Paths, writes and checks retain the attached workspace restrictions.',
  inputSchema: {
    type: 'object', properties, required: ['action', 'language', 'path'], additionalProperties: false,
    oneOf: [
      { type: 'object', properties: Object.fromEntries(['action', 'language', 'path', 'code', 'format', 'expectedHash'].map(key => [key, key === 'action' ? { const: 'save' } : properties[key]])), required: ['action', 'language', 'path', 'code'], additionalProperties: false },
      { type: 'object', properties: Object.fromEntries(['action', 'language', 'path', 'check', 'expectedHash'].map(key => [key, key === 'action' ? { const: 'check' } : properties[key]])), required: ['action', 'language', 'path', 'check'], additionalProperties: false }
    ]
  }
};

// Expose only checks that the selected execution workspace actually supports.
// The parser still understands both actions for backward-compatible saved
// calls; the provider-facing catalog must not advertise unavailable routes.
export function codeBlockToolForChecks({syntax=true,publicCheck=false}={}) {
  if(typeof syntax!=='boolean'||typeof publicCheck!=='boolean'||(!syntax&&!publicCheck))
    throw new TypeError('At least one attached code checker must be identified.');
  const checks=[...(syntax?['syntax']:[]),...(publicCheck?['public']:[])];
  const tool=structuredClone(CODE_BLOCK_TOOL);
  tool.inputSchema.properties.check.enum=checks;
  tool.inputSchema.oneOf[1].properties.check.enum=checks;
  const alternatives=syntax&&publicCheck?'syntax or public':syntax?'syntax':'public';
  tool.description=tool.description.replace('check requires language, path and check:syntax or check:public.',
    'check requires language, path and check:'+alternatives+'. Other check kinds are not available in this workspace.');
  return tool;
}

function fencedSource(input, language) {
  const text = input.replace(/^[ \t\r\n]+/, '');
  const opening = /^[ \t]*(\x60{3,}|~{3,})([A-Za-z][A-Za-z0-9_+.-]*)?[ \t]*\r?\n/.exec(text);
  if (!opening) throw error('Supply exactly one complete fenced block, or choose format raw.', 'CODE_BLOCK_FENCE');
  if (opening[2] && languageName(opening[2]) !== language)
    throw error('The fenced language does not match language.', 'CODE_BLOCK_LANGUAGE');
  const marker = opening[1][0] === '~' ? '~' : '\\x60';
  const rest = text.slice(opening[0].length);
  const markers = [...rest.matchAll(new RegExp('^[ \\t]*' + marker + '{' + opening[1].length + ',}[^\\r\\n]*(?:\\r?\\n|$)', 'gm'))];
  if (markers.length !== 1) throw error('Supply one complete fenced block; multiple or unclosed blocks are not accepted.', 'CODE_BLOCK_FENCE');
  const closing = markers[0];
  const closingOnly = new RegExp('^[ \\t]*' + marker + '{' + opening[1].length + ',}[ \\t]*(?:\\r?\\n|$)$');
  if (!closingOnly.test(closing[0]) || rest.slice(closing.index + closing[0].length).trim())
    throw error('The fence must end the submitted block; surrounding prose is not accepted.', 'CODE_BLOCK_FENCE');
  return rest.slice(0, closing.index);
}

function assertUnicodeSource(code) {
  for (let index = 0; index < code.length; index++) {
    const unit = code.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = code.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { index++; continue; }
    } else if (unit < 0xDC00 || unit > 0xDFFF) continue;
    throw error('Source contains an unpaired UTF-16 surrogate; supply valid Unicode text.', 'CODE_BLOCK_UNICODE');
  }
}

export function parseCodeBlockCall(call) {
  if (!object(call) || call.name !== CODE_BLOCK_TOOL.name || call.namespace)
    throw error('Use the attached relay_code tool.');
  let args;
  try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; }
  catch { throw error('Code-tool arguments must be a JSON object.'); }
  if (!object(args) || !['save', 'check'].includes(args.action)) throw error('Choose save or check.');
  const allowed = new Set(args.action === 'save'
    ? ['action', 'language', 'path', 'code', 'format', 'expectedHash']
    : ['action', 'language', 'path', 'check', 'expectedHash']);
  if (Object.keys(args).some(key => !allowed.has(key))) throw error('Supply only fields belonging to the selected code action.');
  if (typeof args.language !== 'string' || !/^[A-Za-z][A-Za-z0-9_+.-]{0,39}$/.test(args.language))
    throw error('Supply a source language identifier.');
  if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 4096 || args.path.includes('\0'))
    throw error('Supply one file path.');
  if (args.expectedHash !== undefined && (typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash)))
    throw error('expectedHash must be a lowercase SHA-256.');
  const normalized = { action: args.action, language: languageName(args.language), path: args.path,
    ...(args.expectedHash === undefined ? {} : { expectedHash: args.expectedHash }) };
  if (args.action === 'check') {
    if (!['syntax', 'public'].includes(args.check)) throw error('Choose syntax or public checking.');
    return { ...normalized, check: args.check };
  }
  if (typeof args.code !== 'string' || !['raw', 'fenced'].includes(args.format ?? 'raw'))
    throw error('Supply code text and format raw or fenced.');
  const format = args.format ?? 'raw';
  const code = format === 'fenced' ? fencedSource(args.code, normalized.language) : args.code;
  if (code.length > MAX_CODE_BYTES || code.includes('\0'))
    throw error('Source must be UTF-8 text of at most 1 MiB without NUL bytes.', 'CODE_BLOCK_SOURCE');
  assertUnicodeSource(code);
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES)
    throw error('Source must be UTF-8 text of at most 1 MiB without NUL bytes.', 'CODE_BLOCK_SOURCE');
  return { ...normalized, format, code };
}

const response = (value, success = true, code) => ({
  success, ...(code ? { code } : {}),
  ...(typeof value.actionDispatched === 'boolean' ? { actionDispatched: value.actionDispatched } : {}),
  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }]
});
function receiptBody(receipt) {
  if (!object(receipt) || typeof receipt.success !== 'boolean' || !Array.isArray(receipt.contentItems))
    throw error('The scoped backend returned an invalid receipt.', 'CODE_BACKEND_RECEIPT');
  const item = receipt.contentItems.find(item => item?.type === 'inputText' && typeof item.text === 'string');
  try { const value = JSON.parse(item?.text); if (object(value)) return value; } catch {}
  throw error('The scoped backend did not return a structured receipt.', 'CODE_BACKEND_RECEIPT');
}
const readSummary = value => {
  const { content, ...metadata } = value;
  return { ...metadata, ...(content === undefined ? {} : { contentOmitted: true }) };
};
function sourceIdentity(value) {
  const bytes = value.size ?? value.bytes ?? value.bytesRead;
  if (!/^[a-f0-9]{64}$/.test(value.sha256 || '') || !Number.isSafeInteger(bytes) || bytes < 0)
    throw error('The readback has no complete saved-file hash and byte count.', 'CODE_READBACK_UNVERIFIED');
  return { sha256: value.sha256, bytes };
}
const workspaceCall = (call, args) => ({ ...call, name: 'relay_workspace', arguments: args });
const checkSignal = context => {
  if (context.signal?.aborted) throw Object.assign(error('Code-tool action cancelled.', 'ABORT_ERR'), { name: 'AbortError' });
};

/** The injected workspace/checkers own all filesystem, process and authorization effects. */
export function createCodeBlockToolHandler({ workspaceHandler, syntaxCheck, publicCheck, guardedWrites = false } = {}) {
  if (typeof workspaceHandler !== 'function') throw new TypeError('A scoped workspace handler is required.');
  if ([syntaxCheck, publicCheck].some(value => value !== undefined && typeof value !== 'function'))
    throw new TypeError('Code checkers must be scoped native-call callbacks.');
  if (typeof guardedWrites !== 'boolean') throw new TypeError('guardedWrites must be a boolean.');
  const checkerFor = args => {
    const checker = args.check === 'syntax' ? syntaxCheck : publicCheck;
    if (!checker) throw error('The selected workspace has no ' + args.check + ' checker.', 'CODE_CHECK_UNAVAILABLE');
    return checker;
  };
  const saveCall = (call, args) => workspaceCall(call, { action: 'write', path: args.path, text: args.code,
    ...(args.expectedHash === undefined ? {} : { expectedHash: args.expectedHash }) });
  const validate = call => {
    const args = parseCodeBlockCall(call);
    if (args.action === 'save' && args.expectedHash !== undefined && !guardedWrites)
      throw error('This workspace does not advertise guarded writes; expectedHash was not ignored.', 'CODE_GUARDED_WRITE_UNAVAILABLE');
    return args;
  };
  const readSource = async (call, args, context) => {
    checkSignal(context);
    const receipt = await workspaceHandler(workspaceCall(call, { action: 'read', path: args.path, startLine: 1, lineCount: 1 }), { signal: context.signal });
    const value = receiptBody(receipt);
    if (!receipt.success) throw Object.assign(error('The saved source could not be read back.', 'CODE_READBACK_FAILED'), { readbackReceipt: receipt });
    return { identity: sourceIdentity(value), receipt: readSummary(value) };
  };
  const handler = async (call, context = {}) => {
    let args, phase = 'validation', saved, written, checked;
    try {
      checkSignal(context); args = validate(call);
      if (args.action === 'save') {
        phase = 'save';
        written = await workspaceHandler(saveCall(call, args), context);
        if (written?.success === false) return written;
        phase = 'save-receipt';
        saved = receiptBody(written);
        const expected = { sha256: sha256(args.code), bytes: Buffer.byteLength(args.code, 'utf8') };
        phase = 'readback';
        const readback = await readSource(call, args, context);
        if (readback.identity.sha256 !== expected.sha256 || readback.identity.bytes !== expected.bytes)
          throw Object.assign(error('Saved bytes do not match the submitted source. The save receipt is retained.', 'CODE_READBACK_MISMATCH'), { readback });
        return response({ ...saved, action: 'save', language: args.language, format: args.format,
          saved: true, sha256: readback.identity.sha256, sourceSha256: expected.sha256, sourceBytes: expected.bytes,
          readback: { verified: true, ...readback.identity, receipt: readback.receipt },
          checks: { performed: false }, saveReceipt: saved });
      }
      const checker = checkerFor(args);
      phase = 'check-read';
      const before = await readSource(call, args, context);
      if (args.expectedHash !== undefined && before.identity.sha256 !== args.expectedHash)
        throw error('The source differs from expectedHash; no check was run.', 'CODE_CHECK_SOURCE_CONFLICT');
      phase = 'check';
      checked = await checker({ ...call, arguments: args }, { ...context, codeSource: { ...before.identity } });
      phase = 'check-receipt';
      const result = receiptBody(checked);
      if (result.performed === false || checked.code === 'CODE_CHECK_UNAVAILABLE' || result.code === 'CODE_CHECK_UNAVAILABLE')
        return response({ ...result, action: 'check', language: args.language, path: before.receipt.path || args.path,
          check: { kind: args.check, performed: false, passed: false, receipt: result }, source: before.identity }, false, checked.code || result.code || 'CODE_CHECK_UNAVAILABLE');
      if (!checked.success && !Number.isInteger(result.exitCode) && result.timedOut !== true && result.cancelled !== true)
        return response({ ...result, action: 'check', language: args.language, path: before.receipt.path || args.path,
          check: { kind: args.check, performed: result.actionDispatched === false ? false : 'unconfirmed', passed: false, receipt: result }, source: before.identity }, false, checked.code || result.code || 'CODE_CHECK_FAILED');
      if (!Number.isInteger(result.exitCode) && result.timedOut !== true && result.cancelled !== true)
        throw error('The checker returned no terminal exit status or timeout/cancellation result.', 'CODE_CHECK_RECEIPT_INVALID');
      phase = 'check-readback';
      const after = await readSource(call, args, context);
      const sourceUnchanged = before.identity.sha256 === after.identity.sha256 && before.identity.bytes === after.identity.bytes;
      const passed = checked.success && result.exitCode === 0 && !result.timedOut && !result.cancelled && !context.signal?.aborted && sourceUnchanged;
      const code = passed ? undefined : !sourceUnchanged ? 'CODE_CHECK_SOURCE_CHANGED' : checked.code || result.code || 'CODE_CHECK_FAILED';
      return response({ ...result, action: 'check', language: args.language, path: before.receipt.path || args.path,
        check: { kind: args.check, performed: true, passed, receipt: result },
        source: { before: before.identity, after: after.identity, unchanged: sourceUnchanged } }, passed, code);
    } catch (cause) {
      const saveConfirmed = written?.success === true;
      const code = cause.code || 'CODE_TOOL_FAILED';
      return response({ action: args?.action, phase, error: cause.message, code,
        actionDispatched: saveConfirmed || checked || ['save-receipt', 'check-receipt', 'check-readback'].includes(phase) ? true : ['save', 'check'].includes(phase) && cause.actionDispatched !== false ? true : false,
        ...(written ? { saved: saveConfirmed ? true : 'unconfirmed', saveReceipt: saved || written } : phase === 'save' ? { saved: 'unconfirmed' } : {}),
        ...(checked ? { checkReceipt: checked } : {}),
        ...(cause.readbackReceipt ? { readbackReceipt: cause.readbackReceipt } : {}),
        ...(cause.readback ? { readback: { verified: false, ...cause.readback } } : {}) }, false, code);
    }
  };
  handler.validateCall = validate;
  handler.describeOperation = async (call, context = {}) => {
    const args = validate(call);
    if (args.action === 'save') {
      if (typeof workspaceHandler.describeOperation !== 'function') throw error('Workspace operation description is unavailable.', 'CODE_OPERATION_UNAVAILABLE');
      return workspaceHandler.describeOperation(saveCall(call, args), context);
    }
    const checker = checkerFor(args);
    if (typeof checker.describeOperation !== 'function')
      throw error('The checker has no scoped operation descriptor.', 'CODE_OPERATION_UNAVAILABLE');
    return checker.describeOperation({ ...call, arguments: args }, context);
  };
  handler.operationAdapter = CODE_BLOCK_TOOL.name;
  handler.normalizeOperationResult = (result, context = {}) => {
    const normalizeWorkspace = mapped => typeof workspaceHandler.normalizeOperationResult === 'function'
      ? workspaceHandler.normalizeOperationResult(result, mapped) : result;
    let args;
    try { args = parseCodeBlockCall(context.call); }
    catch { return normalizeWorkspace(context); }
    if (args.action === 'save') return normalizeWorkspace({ ...context, call: saveCall(context.call, args) });
    const checker = args.check === 'syntax' ? syntaxCheck : publicCheck;
    return typeof checker?.normalizeOperationResult === 'function'
      ? checker.normalizeOperationResult(result, { ...context, call: { ...context.call, arguments: args } })
      : normalizeWorkspace(context);
  };
  return handler;
}
