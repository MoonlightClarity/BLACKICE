// Evaluator-only observation of the native request boundary. This never changes
// model inputs, request arguments, or the promise returned to the runtime.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const observedMethods = new Set(['thread/start', 'thread/resume', 'turn/start']);
const hash = value => createHash('sha256').update(value).digest('hex');
const textReceipt = text => ({ text, chars: text.length, utf8Bytes: Buffer.byteLength(text), sha256: hash(text) });
const errorReceipt = error => ({ name: error?.name || 'Error', message: error?.message || String(error), ...(error?.code === undefined ? {} : { code: String(error.code) }) });
const cwdKey = cwd => {
  if (typeof cwd !== 'string') return null;
  const normalized = path.resolve(cwd);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

function requestReceipt(params) {
  const receipt = {};
  for (const key of ['cwd', 'model', 'threadId']) if (typeof params?.[key] === 'string') receipt[key] = params[key];
  receipt.developerInstructionsProvided = Object.hasOwn(params || {}, 'developerInstructions');
  if (typeof params?.developerInstructions === 'string') receipt.developerInstructions = textReceipt(params.developerInstructions);
  if (Object.hasOwn(params || {}, 'input')) {
    receipt.inputSha256 = hash(JSON.stringify(params.input));
    receipt.inputTexts = typeof params.input === 'string'
      ? [{ index: 0, ...textReceipt(params.input) }]
      : Array.isArray(params.input)
        ? params.input.flatMap((item, index) => typeof item?.text === 'string' ? [{ index, ...(typeof item.type === 'string' ? { type: item.type } : {}), ...textReceipt(item.text) }] : [])
        : [];
  }
  return receipt;
}

/** The caller creates the receipt directory outside every model task cwd. */
export function installNativeRequestRecorder(codex, { file, append = fs.appendFile, now = () => new Date().toISOString() }) {
  if (!codex || typeof codex._request !== 'function') throw Error('Native Codex request boundary is unavailable.');
  const original = codex._request;
  const ownDescriptor = Object.getOwnPropertyDescriptor(codex, '_request');
  const records = [], recordingErrors = [];
  let sequence = 0, writes = Promise.resolve();
  const noteError = error => recordingErrors.push(errorReceipt(error));
  const persist = value => {
    try {
      const line = JSON.stringify(value) + '\n';
      writes = writes.then(() => append(file, line)).catch(noteError);
    } catch (error) { noteError(error); }
  };
  const finish = (record, status, value) => {
    try {
      record.status = status;
      record.finishedAt = now();
      if (status === 'fulfilled') {
        record.response = {};
        const threadId = value?.thread?.id ?? value?.threadId;
        const turnId = value?.turn?.id ?? value?.turnId;
        if (typeof threadId === 'string') record.response.threadId = threadId;
        if (typeof turnId === 'string') record.response.turnId = turnId;
        if (typeof value?.thread?.ephemeral === 'boolean') record.response.ephemeral = value.thread.ephemeral;
      } else record.error = errorReceipt(value);
      persist({ event: 'settled', ...record });
    } catch (error) { noteError(error); }
  };
  function observedRequest(...args) {
    if (!observedMethods.has(args[0])) return Reflect.apply(original, this, args);
    let record;
    try {
      record = { id: ++sequence, method: args[0], requestedAt: now(), status: 'pending', request: requestReceipt(args[1]) };
      records.push(record);
      persist({ event: 'requested', ...record });
    } catch (error) { noteError(error); }
    let promise;
    try { promise = Reflect.apply(original, this, args); }
    catch (error) {
      if (record) finish(record, 'threw', error);
      throw error;
    }
    if (record) {
      try { promise.then(value => finish(record, 'fulfilled', value), error => finish(record, 'rejected', error)); }
      catch (error) { noteError(error); }
    }
    return promise;
  }
  codex._request = observedRequest;
  return {
    file,
    async flush() {
      await writes;
      if (recordingErrors.length) throw new AggregateError(recordingErrors.map(error => Object.assign(new Error(error.message), error)), 'Native request receipt recording failed: ' + recordingErrors.map(error => error.message).join('; '));
    },
    forCwd(cwd) {
      const key = cwdKey(cwd), threadIds = new Set(), selected = new Set();
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of records) {
          if (selected.has(record)) continue;
          if (cwdKey(record.request.cwd) === key || threadIds.has(record.request.threadId) || threadIds.has(record.response?.threadId)) {
            selected.add(record);
            if (record.request.threadId) threadIds.add(record.request.threadId);
            if (record.response?.threadId) threadIds.add(record.response.threadId);
            changed = true;
          }
        }
      }
      return JSON.parse(JSON.stringify(records.filter(record => selected.has(record))));
    },
    restore() {
      if (codex._request !== observedRequest) throw Error('Native request observer was replaced; refusing to overwrite another hook.');
      if (ownDescriptor) Object.defineProperty(codex, '_request', ownDescriptor);
      else delete codex._request;
    },
  };
}
