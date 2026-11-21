import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Benchmark-only host transport evidence. Headers contain opaque IDs and a
// request digest; no prompt, credential, path or user data is sent in them.
const SCHEMA = 'blackice.minicpm.provider-exchange.v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clock = () => new Date().toISOString();
const failure = (message, code = 'BENCHMARK_TRACE_INVALID') => Object.assign(new Error(message), { code });
const inside = (root, file) => {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) throw failure('The benchmark trace write made no progress.', 'BENCHMARK_TRACE_IO');
    offset += count;
  }
}
function durable(file, bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const fd = fs.openSync(file, 'wx');
  try { writeAll(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const actual = fs.readFileSync(file);
  if (!actual.equals(data)) throw failure('Benchmark trace readback differs.', 'BENCHMARK_TRACE_IO');
  return { path: file, sha256: sha(actual), bytes: actual.length };
}
const saveJSON = (file, value) => durable(file, JSON.stringify(value, null, 2) + '\n');
function safeError(cause) {
  return { name: typeof cause?.name === 'string' ? cause.name : 'Error',
    code: typeof cause?.code === 'string' ? cause.code : null };
}
export function validateBenchmarkTraceContext(context) {
  if (!context || context.schema !== 'blackice.minicpm.provider-trace-context.v1' ||
      !path.isAbsolute(context.directory || '') || !path.isAbsolute(context.workspace || '') ||
      inside(context.workspace, context.directory)) throw failure('Benchmark trace must use a host-owned directory outside the model workspace.');
  for (const key of ['runId', 'taskId', 'nodeId']) {
    if (typeof context[key] !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(context[key])) throw failure('Benchmark trace host binding is missing: ' + key);
  }
  if (context.clientRequestId !== null && (typeof context.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(context.clientRequestId))) throw failure('An observed client request ID or explicit null is required.');
  return structuredClone(context);
}
export function createBenchmarkExchangeTrace({ context, threadId, turnId, messageId, providerId, model,
  providerType, target, serializedBody, maxResponseBytes = 64 * 1024 * 1024 }) {
  const host = validateBenchmarkTraceContext(context), url = new URL(target);
  if (providerType !== 'compatible' || url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw failure('Benchmark transport capture requires the explicitly selected loopback compatible endpoint.', 'BENCHMARK_TRACE_ENDPOINT');
  for (const [key, value] of Object.entries({ threadId, turnId, messageId, providerId, model })) {
    if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw failure('Benchmark provider binding is missing: ' + key);
  }
  if (typeof serializedBody !== 'string' || !serializedBody || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)
    throw failure('Exact serialized request and a positive response-byte bound are required.');
  const body = JSON.parse(serializedBody);
  if (!body || Array.isArray(body) || body.model !== model || !Array.isArray(body.messages)) throw failure('The exact request does not match the bound compatible model/input.');
  const exchangeId = randomUUID(), directory = path.join(host.directory, exchangeId);
  fs.mkdirSync(directory, { recursive: true });
  const request = Object.freeze(durable(path.join(directory, 'request.json'), serializedBody));
  const binding = Object.freeze({ runId: host.runId, taskId: host.taskId, nodeId: host.nodeId,
    clientRequestId: host.clientRequestId, threadId, turnId, messageId, providerId, model, providerType });
  const opened = { schema: SCHEMA, exchangeId, at: clock(), binding, target: url.href, request,
    complete: false, maxResponseBytes, responseByteMeaning: 'Decoded HTTP entity bytes received by the native fetch reader, before text/SSE parsing.' };
  const openedEvidence = saveJSON(path.join(directory, 'exchange-open.json'), opened);
  const attempts = [], openedAttempts = []; let current = null, closed = false;
  const ensureOpen = () => { if (closed) throw failure('Benchmark exchange is already settled.'); };
  const reference = () => ({ schema: SCHEMA, exchangeId, directory, binding, request,
    opened: openedEvidence, openedAttempts: openedAttempts.map(item => structuredClone(item)), attempts: attempts.map(item => ({ attemptId: item.attemptId, ...item.evidence })) });
  return {
    exchangeId, request, binding,
    reference,
    beginAttempt(actualSerializedBody) {
      ensureOpen();
      if (current) throw failure('The previous HTTP attempt has not settled.');
      if (actualSerializedBody !== serializedBody || sha(Buffer.from(actualSerializedBody)) !== request.sha256)
        throw failure('The serialized request changed before dispatch.', 'BENCHMARK_TRACE_REQUEST_CHANGED');
      const attemptId = randomUUID(), index = openedAttempts.length + 1, prefix = 'attempt-' + String(index).padStart(4, '0');
      const started = { schema: 'blackice.minicpm.provider-attempt.v1', exchangeId, attemptId, index,
        at: clock(), binding, requestSha256: request.sha256, target: url.href, complete: false, dispatched: 'not-observed' };
      const startEvidence = saveJSON(path.join(directory, prefix + '-open.json'), started);
      const responsePath = path.join(directory, prefix + '-response.bin');
      const openedAttempt = { attemptId, index, opened: startEvidence, responsePath, settlementError: null };
      openedAttempts.push(openedAttempt);
      let fd;
      try { fd = fs.openSync(responsePath, 'wx'); }
      catch (cause) { openedAttempt.settlementError = safeError(cause); throw cause; }
      current = { ...started, prefix, startEvidence, openedAttempt, fd, responsePath, bytes: 0, chunks: 0,
        responseHash: createHash('sha256'), http: null, responseIds: new Set(), terminal: null, captureError: null };
      return { attemptId, exchangeId, requestSha256: request.sha256,
        headers: { 'X-Blackice-Exchange-Id': exchangeId, 'X-Blackice-Attempt-Id': attemptId,
          'X-Blackice-Request-Sha256': request.sha256 }, evidence: startEvidence };
    },
    observeHTTP(response) {
      ensureOpen(); if (!current) throw failure('No pending benchmark HTTP attempt.');
      current.http = { status: response.status, contentType: response.headers?.get('content-type') || null,
        responseExchangeId: response.headers?.get('x-blackice-exchange-id') || null,
        responseAttemptId: response.headers?.get('x-blackice-attempt-id') || null };
    },
    appendResponse(value) {
      ensureOpen(); if (!current) throw failure('No pending benchmark HTTP attempt.');
      const bytes = Buffer.from(value);
      try {
        if (current.bytes + bytes.length > maxResponseBytes) throw failure('Benchmark response capture exceeded its explicit byte bound.', 'BENCHMARK_TRACE_LIMIT');
        writeAll(current.fd, bytes); current.responseHash.update(bytes);
        current.bytes += bytes.length; current.chunks++;
      } catch (cause) { current.captureError = safeError(cause); throw String(cause?.code || '').startsWith('BENCHMARK_TRACE') ? cause : Object.assign(failure('Benchmark response capture could not be saved.', 'BENCHMARK_TRACE_IO'), { cause }); }
    },
    observeEvent(event) {
      ensureOpen(); if (!current) throw failure('No pending benchmark HTTP attempt.');
      if (typeof event?.id === 'string' && event.id) current.responseIds.add(event.id);
    },
    terminal(reason) {
      ensureOpen(); if (!current) throw failure('No pending benchmark HTTP attempt.');
      if (!['done-marker', 'consumer-terminal', 'eof', 'json-eof', 'read-limit', 'unavailable-reader'].includes(reason)) throw failure('Unknown transport terminal boundary.');
      current.terminal = reason;
    },
    finishAttempt({ outcome, error = null } = {}) {
      ensureOpen(); if (!current) throw failure('No pending benchmark HTTP attempt.');
      if (!['accepted', 'http-rejected', 'failed'].includes(outcome)) throw failure('An explicit HTTP outcome is required.');
      const item = current; current = null;
      try {
        let ioError = item.captureError;
        try { fs.fsyncSync(item.fd); } catch (cause) { ioError ||= safeError(cause); }
        finally { try { fs.closeSync(item.fd); } catch (cause) { ioError ||= safeError(cause); } }
        const actual = fs.readFileSync(item.responsePath), expectedHash = item.responseHash.digest('hex');
        if (actual.length !== item.bytes || sha(actual) !== expectedHash) ioError ||= { name: 'Error', code: 'BENCHMARK_TRACE_READBACK' };
        const terminalComplete = ['done-marker', 'consumer-terminal', 'eof', 'json-eof'].includes(item.terminal);
        const status = item.http?.status;
        const httpKnown = Number.isInteger(status) && status >= 100 && status <= 599;
        const outcomeMatches = outcome === 'accepted' ? status >= 200 && status < 300 : outcome === 'http-rejected' && httpKnown && (status < 200 || status >= 300);
        const complete = !ioError && !error && httpKnown && outcomeMatches && terminalComplete;
        const record = { schema: item.schema, exchangeId, attemptId: item.attemptId, index: item.index,
          startedAt: item.at, finishedAt: clock(), binding, requestSha256: request.sha256,
          opened: item.startEvidence, http: item.http, outcome, terminal: item.terminal,
          response: { path: item.responsePath, sha256: sha(actual), bytes: actual.length, chunks: item.chunks },
          responseIds: [...item.responseIds], captureError: ioError, error: error ? safeError(error) : null, complete };
        const evidence = saveJSON(path.join(directory, item.prefix + '-settled.json'), record);
        attempts.push({ ...record, evidence }); return { ...record, evidence };
      } catch (cause) { item.openedAttempt.settlementError = safeError(cause); throw cause; }
    },
    finishSemantic({ success, result = null, error = null } = {}) {
      ensureOpen();
      if (current) this.finishAttempt({ outcome: 'failed', error: error || failure('Model exchange ended with an unsettled HTTP attempt.') });
      if (typeof success !== 'boolean') throw failure('Model semantic completion must be explicit.');
      closed = true;
      const last = attempts.at(-1), complete = success && result?.incomplete !== true && result?.termination?.providerFinishReason !== 'length' && attempts.length > 0 && attempts.length === openedAttempts.length &&
        attempts.every(item => item.complete) && last.outcome === 'accepted' &&
        last.http?.status >= 200 && last.http?.status < 300;
      const record = { ...opened, finishedAt: clock(), openedAttempts: openedAttempts.map(item => structuredClone(item)), attempts: attempts.map(item => ({
        attemptId: item.attemptId, index: item.index, outcome: item.outcome, complete: item.complete, evidence: item.evidence })),
        semantic: { success, incomplete: result?.incomplete === true,
          providerFinishReason: result?.termination?.providerFinishReason || null, error: error ? safeError(error) : null },
        complete, responseIds: [...new Set(attempts.flatMap(item => item.responseIds))] };
      const evidence = saveJSON(path.join(directory, 'exchange-settled.json'), record);
      return { ...reference(), complete, semantic: record.semantic, settled: evidence };
    }
  };
}
export { SCHEMA as BENCHMARK_EXCHANGE_SCHEMA };
