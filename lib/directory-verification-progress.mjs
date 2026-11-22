import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseBenchmarkWorkspaceCall } from './benchmark-workspace-contract.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = value => object(value) && hash(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
const sameSource = (a, b) => identity(a) && identity(b) && a.sha256 === b.sha256 && a.bytes === b.bytes;
const argsOf = call => {
  try {
    const args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments;
    return object(args) ? args : null;
  } catch { return null; }
};
const textOf = result => Array.isArray(result?.contentItems)
  && result.contentItems.every(item => item?.type === 'inputText' && typeof item.text === 'string')
  ? result.contentItems.map(item => item.text).join('\n') : null;
const bodyOf = result => {
  try { const value = JSON.parse(result.contentItems[0].text); return object(value) ? value : null; }
  catch { return null; }
};
const terminalSuccess = value => object(value) && value.exitCode === 0
  && value.timedOut !== true && value.cancelled !== true && value.actionDispatched !== false
  && (value.signal === null || value.signal === undefined);
const checkCall = call => {
  const args = argsOf(call);
  return !call?.namespace && call?.name === 'relay_code' && args?.action === 'check'
    && ['syntax', 'public'].includes(args.check) ? args : null;
};

/**
 * A new checked artifact may justify feedback, never host-authored completion.
 * Call start/finish around actual dispatch; receipts and delivery are separate.
 * No filesystem, provider, Directory mutation, or retry budget belongs here.
 */
export function createDirectoryVerificationProgress({ runId, taskId = runId, nodeId, cwd, workspacePublicCheck = null } = {}) {
  if (![runId, taskId, nodeId].every(value => typeof value === 'string' && value)
    || typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('A current run/task/node and absolute workspace are required.');
  let workspaceCheck = null;
  if (workspacePublicCheck !== null) {
    if (!object(workspacePublicCheck)
      || Object.keys(workspacePublicCheck).sort().join(',') !== 'caseCount,caseId,command'
      || typeof workspacePublicCheck.caseId !== 'string' || !workspacePublicCheck.caseId
      || !Number.isSafeInteger(workspacePublicCheck.caseCount) || workspacePublicCheck.caseCount < 1) {
      throw new TypeError('A host-bound workspace public-check capability is required.');
    }
    const args = parseBenchmarkWorkspaceCall({ name: 'relay_workspace',
      arguments: { action: 'run', command: workspacePublicCheck.command } });
    workspaceCheck = Object.freeze({ caseId: workspacePublicCheck.caseId,
      caseCount: workspacePublicCheck.caseCount, command: args.command });
  }
  const scopedCheckCall = call => {
    const code = checkCall(call);
    if (code || !workspaceCheck) return code;
    try {
      const args = parseBenchmarkWorkspaceCall(call);
      return args.action === 'run' ? args : null;
    } catch { return null; }
  };
  const operations = new WeakMap(), pending = new Map(), delivered = new Map(), consumed = new Set();
  const publicOrigins = new Map();
  let epoch = 0, mutations = 0;
  const target = value => {
    if (typeof value !== 'string' || !value || value.includes('\0')) return null;
    const resolved = path.resolve(cwd, value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const invalidate = () => { epoch++; pending.clear(); delivered.clear(); };
  const ownReceipt = (receipt, tool = 'relay_code') => object(receipt) && typeof receipt.id === 'string' && receipt.id
    && receipt.runId === runId && receipt.taskId === taskId && receipt.nodeId === nodeId
    && receipt.tool === tool && receipt.state === 'returned' && receipt.success === true;
  const callKey = call => {
    const args = scopedCheckCall(call);
    if (args?.action === 'run') return JSON.stringify(['workspace-public', args.command, args.timeoutMs ?? null]);
    return args ? JSON.stringify([args.check, args.language, target(args.path), args.expectedHash ?? null]) : null;
  };
  const publicSourceKey = (snapshotHash, command) => workspaceCheck && hash(snapshotHash)
    && command === workspaceCheck.command
    ? digest(JSON.stringify([target('.'), workspaceCheck.caseId, workspaceCheck.caseCount, command, snapshotHash])) : null;
  const wasConsumed = ({ signature, publicKey, origin }) => consumed.has(signature)
    || Boolean(publicKey && (origin === 'workspace'
      ? publicOrigins.get(publicKey)?.size : publicOrigins.get(publicKey)?.has('workspace')));
  const consume = entry => {
    consumed.add(entry.signature);
    if (entry.publicKey) {
      const origins = publicOrigins.get(entry.publicKey) || new Set();
      origins.add(entry.origin);
      publicOrigins.set(entry.publicKey, origins);
    }
  };
  const workspaceSource = (args, body) => {
    if (!workspaceCheck || !terminalSuccess(body) || body.actionDispatched !== true
      || body.timedOut !== false || body.truncated !== false || body.signal !== null
      || body.command !== args.command || body.shell !== 'none'
      || typeof body.cwd !== 'string' || !path.isAbsolute(body.cwd) || target(body.cwd) !== target('.')
      || !Array.isArray(body.args) || body.args.length !== 1 || body.args[0] !== 'test-public.cjs'
      || typeof body.executable !== 'string' || !path.isAbsolute(body.executable)
      || body.reportValid !== true || body.sourceSnapshotVerified !== true
      || !hash(body.sourceSnapshotBeforeSha256)
      || body.sourceSnapshotBeforeSha256 !== body.sourceSnapshotAfterSha256
      || typeof body.stdout !== 'string' || typeof body.stderr !== 'string') return null;
    let report;
    try { report = JSON.parse(body.stdout); } catch { return null; }
    if (!object(report) || report.schema !== 'blackice.minicpm.public-smoke.v1'
      || report.taskId !== workspaceCheck.caseId || report.publicSmokeOnly !== true
      || report.caseCount !== workspaceCheck.caseCount || report.executedCases !== workspaceCheck.caseCount
      || report.passedCases !== workspaceCheck.caseCount || report.semanticPass !== true
      || report.sourceSnapshotSha256 !== body.sourceSnapshotBeforeSha256
      || !Number.isSafeInteger(report.moduleCount) || report.moduleCount < 1
      || report.compileError !== null || report.workerError !== null
      || !Array.isArray(report.failures) || report.failures.length
      || !terminalSuccess(report.child) || report.child.status !== 0
      || report.child.timedOut !== false || report.child.signal !== null || report.child.error !== null
      || typeof report.child.executable !== 'string' || !path.isAbsolute(report.child.executable)
      || target(report.child.executable) !== target(body.executable)
      || typeof report.child.cwd !== 'string' || !path.isAbsolute(report.child.cwd)
      || target(report.child.cwd) !== target('test-support')) return null;
    return body.sourceSnapshotBeforeSha256;
  };

  return {
    start(call, { mutating = false } = {}) {
      const check = scopedCheckCall(call);
      // A check's subprocess is an effect in the host ledger but is not a source edit.
      const mutation = mutating === true && !check;
      if (mutation) { invalidate(); mutations++; }
      const handle = {};
      operations.set(handle, { epoch, blocked: mutations > 0, check: Boolean(check), mutation, finished: false });
      return handle;
    },
    finish(handle) {
      const operation = operations.get(handle);
      if (!operation || operation.finished) return;
      operation.finished = true;
      if (operation.mutation) { mutations--; invalidate(); }
    },
    record({ call, result, receipt, snapshot, operation: handle } = {}) {
      const operation = operations.get(handle);
      if (handle && typeof handle === 'object') operations.delete(handle);
      const args = scopedCheckCall(call), fullText = textOf(result);
      if (!operation?.finished || !operation.check || operation.blocked || mutations || operation.epoch !== epoch
        || !args || typeof call.callId !== 'string' || !call.callId || result?.success !== true || fullText === null
        || !ownReceipt(receipt, call.name) || !snapshot || receipt.actionId !== snapshot.focus
        || !snapshot.actions?.some(action => action.id === receipt.actionId && action.state === 'active')
        || !Number.isSafeInteger(snapshot.actionRevision)) return false;
      const body = bodyOf(result);
      if (args.action === 'run') {
        const snapshotHash = workspaceSource(args, body);
        if (!snapshotHash) return false;
        const publicKey = publicSourceKey(snapshotHash, args.command);
        const signature = digest(JSON.stringify([2, 'workspace-public', publicKey]));
        if (wasConsumed({ signature, publicKey, origin: 'workspace' })) return false;
        pending.set(call.callId, {
          callId: call.callId, callKey: callKey(call), textSha256: digest(fullText), textChars: fullText.length,
          receiptId: receipt.id, actionId: receipt.actionId, actionRevision: snapshot.actionRevision,
          signature, publicKey, origin: 'workspace', tool: 'relay_workspace', epoch,
          kind: 'public', language: 'javascript', sha256: snapshotHash, sourceScope: 'module-snapshot',
        });
        return true;
      }
      const checked = body?.check, source = body?.source, actual = checked?.receipt;
      const native = bodyOf(actual?.nativeResult);
      const checkedTarget = target(args.path);
      if (!checkedTarget || body?.action !== 'check' || body.language !== args.language || target(body.path) !== checkedTarget
        || checked?.kind !== args.check || checked.performed !== true || checked.passed !== true
        || !terminalSuccess(body) || !terminalSuccess(actual) || actual?.performed !== true
        || actual.kind !== args.check || actual.language !== args.language || target(actual.path) !== checkedTarget
        || actual.nativeResult?.success !== true || !terminalSuccess(native)
        || source?.unchanged !== true || !sameSource(source.before, source.after)
        || !sameSource(source.before, actual.checkedSource)
        || args.expectedHash !== undefined && args.expectedHash !== source.before.sha256) return false;
      if (args.check === 'syntax' && !['javascript', 'json'].includes(args.language)) return false;
      if (args.check === 'public' && args.language !== 'javascript') return false;
      let snapshotHash = null;
      if (actual.sourceSnapshotVerified !== undefined || actual.sourceSnapshotBeforeSha256 !== undefined || actual.sourceSnapshotAfterSha256 !== undefined) {
        if (actual.sourceSnapshotVerified !== true || !hash(actual.sourceSnapshotBeforeSha256)
          || actual.sourceSnapshotBeforeSha256 !== actual.sourceSnapshotAfterSha256) return false;
        snapshotHash = actual.sourceSnapshotBeforeSha256;
      }
      if (actual.reportValid === false) return false;
      const signature = digest(JSON.stringify([1, checkedTarget, source.before.sha256, source.before.bytes,
        args.check, args.language, typeof actual.command === 'string' ? actual.command : null, snapshotHash]));
      const publicKey = args.check === 'public' ? publicSourceKey(snapshotHash, actual.command) : null;
      if (wasConsumed({ signature, publicKey, origin: 'code' })) return false;
      pending.set(call.callId, {
        callId: call.callId, callKey: callKey(call), textSha256: digest(fullText), textChars: fullText.length,
        receiptId: receipt.id, actionId: receipt.actionId, actionRevision: snapshot.actionRevision,
        signature, publicKey, origin: 'code', tool: 'relay_code', epoch, kind: args.check, language: args.language, path: body.path,
        sha256: source.before.sha256, bytes: source.before.bytes,
      });
      return true;
    },
    delivered({ call, result } = {}) {
      const entry = pending.get(call?.callId), text = textOf(result);
      // Compatible delivery omits success metadata; exact locally successful text is authoritative.
      if (!entry || result?.success === false || entry.epoch !== epoch || mutations || text === null
        || callKey(call) !== entry.callKey || text.length !== entry.textChars || digest(text) !== entry.textSha256) return false;
      pending.delete(call.callId);
      delivered.set(entry.signature, entry);
      return true;
    },
    take({ snapshot, state, admitted = false } = {}) {
      if (!admitted || mutations || state?.reason !== 'pending-actions' || state.unknown?.length
        || !snapshot || snapshot.focus !== state.focus
        || !snapshot.actions?.some(action => action.id === state.focus && action.state === 'active')) return null;
      for (const entry of [...delivered.values()].reverse()) {
        if (entry.epoch !== epoch || wasConsumed(entry) || entry.actionId !== state.focus
          || entry.actionRevision !== snapshot.actionRevision
          || !snapshot.receipts?.some(receipt => ownReceipt(receipt, entry.tool) && receipt.id === entry.receiptId && receipt.actionId === entry.actionId)) continue;
        consume(entry);
        delivered.delete(entry.signature);
        return { actionId: entry.actionId, receiptId: entry.receiptId, kind: entry.kind,
          language: entry.language, path: entry.path, sha256: entry.sha256, bytes: entry.bytes, signature: entry.signature,
          ...(entry.sourceScope ? { sourceScope: entry.sourceScope } : {}) };
      }
      return null;
    },
    checkpoint() {
      // Compare with the preceding final, not old receipts replayed under fresh IDs.
      for (const entry of delivered.values()) consume(entry);
      pending.clear(); delivered.clear();
    },
  };
}
