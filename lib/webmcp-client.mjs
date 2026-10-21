import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';

// Chromium's experimental WebMCP domain. This module owns neither a browser nor
// a debugger connection. Its caller must provide one explicitly owned tab.
// https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/
export const WEBMCP_LIMITS = Object.freeze({ tools: 128, definitionBytes: 131072, inputBytes: 1048576, outputBytes: 4194304, pending: 8, timeoutMs: 30000 });
const fault = (message, code = 'WEBMCP_PROTOCOL', extra = {}) => Object.assign(new Error(message), { code, status: 409, ...extra });
const aborted = () => fault('The site tool operation was cancelled.', 'ABORT_ERR', { name: 'AbortError' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const boundedString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');

function jsonValue(value, limit, code = 'WEBMCP_PROTOCOL') {
  let serialized, measured = 0;
  try {
    const visit = (item, depth = 0) => {
      measured += 2;
      if (measured > limit) throw Error();
      if (depth > 24) throw Error();
      if (typeof item === 'string') { measured += Buffer.byteLength(item); if (measured > limit) throw Error(); return; }
      if (item === null || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if (Array.isArray(item)) { for (const entry of item) visit(entry, depth + 1); return; }
      if (object(item)) { for (const [key, entry] of Object.entries(item)) { measured += Buffer.byteLength(key); visit(entry, depth + 1); } return; }
      throw Error();
    };
    visit(value); serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > limit) throw Error();
  } catch { throw fault('The site tool payload is invalid or exceeds its size limit.', code); }
  return { value: JSON.parse(serialized), serialized };
}

function documentIdentity(value) {
  if (!object(value) || !boundedString(value.tabId, 160) || !boundedString(value.frameId, 160)
      || !(boundedString(value.generation, 160) || Number.isSafeInteger(value.generation) && value.generation >= 0)) throw fault('The owned browser document is unavailable.', 'WEBMCP_DOCUMENT_UNAVAILABLE');
  let url;
  try { url = new URL(value.url); } catch { throw fault('The owned browser document is unavailable.', 'WEBMCP_DOCUMENT_UNAVAILABLE'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fault('This document cannot provide site tools.', 'WEBMCP_ORIGIN');
  return { tabId: value.tabId, frameId: value.frameId, generation: value.generation, origin: url.origin };
}
const sameDocument = (left, right) => left && right && ['tabId', 'frameId', 'generation', 'origin'].every(key => left[key] === right[key]);

/**
 * sendCommand(method, params) -> Promise<CDP response>
 * subscribe(listener) -> unsubscribe, where listener receives {method, params}.
 * getDocument() -> {tabId, frameId, generation, url}, or null after detachment.
 * The owner increments generation on top-level document navigation and calls
 * invalidate() on detach/close. Only the current top-level frame is admitted.
 */
export class WebMCPClient extends EventEmitter {
  constructor({ sendCommand, subscribe, getDocument, timeoutMs = WEBMCP_LIMITS.timeoutMs } = {}) {
    super();
    if (![sendCommand, subscribe, getDocument].every(value => typeof value === 'function')) throw Error('An owned browser transport, event subscription, and document identity are required.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw Error('Use a bounded site tool timeout.');
    this.sendCommand = sendCommand; this.subscribe = subscribe; this.getDocument = getDocument; this.timeoutMs = timeoutMs;
    this.document = null; this.catalog = new Map(); this.handles = new Map(); this.pending = new Map(); this.operations = new Set();
    this.state = 'uninitialized'; this.supported = null; this.reason = null; this.closed = false; this.sequence = 0; this.startPromise = null; this.unsubscribe = null;
  }

  status() { return { state: this.state, supported: this.supported, ready: this.state === 'ready', toolCount: this.catalog.size, pendingCount: this.operations.size, document: this.document ? { ...this.document } : null, reason: this.reason }; }
  update() { this.emit('status', this.status()); }
  tools() { this.assertDocument(); return [...this.catalog.values()].map(tool => structuredClone(tool)).sort((left, right) => left.name.localeCompare(right.name)); }
  currentDocument() { try { return documentIdentity(this.getDocument()); } catch { return null; } }
  assertDocument() {
    if (this.closed) throw fault('The site tool connection is closed.', 'WEBMCP_CLOSED');
    if (!this.document || !sameDocument(this.document, this.currentDocument())) {
      this.invalidate('document-changed');
      throw fault('The browser document changed. Refresh its site tools before continuing.', 'WEBMCP_DOCUMENT_CHANGED');
    }
  }

  start() {
    if (this.closed) return Promise.reject(fault('The site tool connection is closed.', 'WEBMCP_CLOSED'));
    if (this.startPromise) return this.startPromise;
    if (this.state === 'ready' && sameDocument(this.document, this.currentDocument())) return Promise.resolve(this.status());
    this.invalidate('refresh');
    try { this.document = documentIdentity(this.getDocument()); } catch (cause) { return Promise.reject(cause); }
    this.state = 'checking'; this.reason = null; this.supported = null;
    const sequence = this.sequence;
    try { this.unsubscribe = this.subscribe(event => this.receive(event)); }
    catch { this.invalidate('detached'); return Promise.reject(fault('The browser event connection is unavailable.', 'WEBMCP_DISCOVERY_FAILED')); }
    this.update();
    this.startPromise = (async () => {
      try {
        await this.command('WebMCP.enable', {}, this.timeoutMs);
        if (this.closed || sequence !== this.sequence) throw fault('The browser document changed during site tool discovery.', 'WEBMCP_DOCUMENT_CHANGED');
        this.assertDocument(); this.state = 'ready'; this.supported = true; this.reason = null; this.update();
        return this.status();
      } catch (cause) {
        if (!this.closed && sequence === this.sequence) {
          this.clearCatalog();
          // Only the protocol's method-not-found code proves unsupported. Other
          // failures must remain distinguishable from a legitimate empty list.
          const unsupported = cause?.code === -32601 || cause?.code === 'WEBMCP_UNSUPPORTED';
          this.supported = unsupported ? false : null; this.state = unsupported ? 'unsupported' : 'error';
          this.reason = unsupported ? 'This browser does not expose the experimental WebMCP protocol.' : 'Site tool discovery did not finish. Refresh the owned browser tab to try again.';
          this.update();
        }
        if (cause?.code === -32601) throw fault('This browser does not expose the experimental WebMCP protocol.', 'WEBMCP_UNSUPPORTED');
        if (['WEBMCP_TIMEOUT', 'WEBMCP_DOCUMENT_CHANGED', 'WEBMCP_CLOSED'].includes(cause?.code)) throw cause;
        throw fault('Site tool discovery failed.', 'WEBMCP_DISCOVERY_FAILED');
      } finally { if (sequence === this.sequence) this.startPromise = null; }
    })();
    return this.startPromise;
  }

  command(method, params, timeoutMs = this.timeoutMs) {
    let timer;
    const operation = Promise.resolve().then(() => this.sendCommand(method, params));
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(fault('The site tool operation timed out.', 'WEBMCP_TIMEOUT')), timeoutMs); });
    return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
  }

  clearCatalog() { this.catalog.clear(); this.handles.clear(); }
  invalidate(reason = 'document-changed') {
    this.sequence++; this.startPromise = null;
    try { this.unsubscribe?.(); } catch {} this.unsubscribe = null;
    this.clearCatalog();
    for (const operation of [...this.operations]) this.finish(operation, fault('The browser connection changed before the site tool result was confirmed.', 'WEBMCP_DOCUMENT_CHANGED', { outcome: operation.dispatched ? 'unknown' : 'not-dispatched' }));
    this.pending.clear(); this.document = null;
    if (!this.closed) { this.state = 'stale'; this.supported = null; this.reason = ['document-changed', 'detached', 'closed', 'tool-changed', 'refresh'].includes(reason) ? reason : 'document-changed'; }
    this.update();
  }

  receive(event) {
    if (this.closed || !this.document || !object(event) || typeof event.method !== 'string' || !object(event.params)) return;
    if (!sameDocument(this.document, this.currentDocument())) { this.invalidate('document-changed'); return; }
    const params = event.params;
    if (event.method === 'WebMCP.toolsAdded') {
      if (!Array.isArray(params.tools) || params.tools.length > WEBMCP_LIMITS.tools) { this.invalidate('tool-changed'); return; }
      let changed = false;
      for (const raw of params.tools) {
        if (!object(raw) || raw.frameId !== this.document.frameId || !/^[A-Za-z0-9_.-]{1,128}$/.test(raw.name || '') || typeof raw.description !== 'string' || raw.description.length > 24000) continue;
        try {
          const schema = raw.inputSchema === undefined ? { type: 'object', properties: {}, additionalProperties: false } : raw.inputSchema;
          if (!object(schema) || schema.type !== 'object') continue;
          const { value: inputSchema, serialized } = jsonValue(schema, WEBMCP_LIMITS.definitionBytes);
          const previous = this.catalog.get(raw.name);
          if (previous) {
            this.handles.delete(previous.id);
            for (const operation of [...this.operations]) if (operation.handleId === previous.id) this.finish(operation, fault('The site tool changed before its result was confirmed.', 'WEBMCP_TOOL_CHANGED', { outcome: operation.dispatched ? 'unknown' : 'not-dispatched' }));
          } else if (this.catalog.size >= WEBMCP_LIMITS.tools) continue;
          const tool = { id: randomUUID(), name: raw.name, description: raw.description, inputSchema, schemaHash: digest(serialized), frameId: this.document.frameId, generation: this.document.generation, origin: this.document.origin };
          this.catalog.set(tool.name, tool); this.handles.set(tool.id, tool); changed = true;
        } catch { /* Malformed definitions are never executable. */ }
      }
      if (changed) { this.emit('tools', this.tools()); this.update(); }
    } else if (event.method === 'WebMCP.toolsRemoved') {
      if (!Array.isArray(params.tools) || params.tools.length > WEBMCP_LIMITS.tools) return;
      let changed = false;
      for (const removed of params.tools) {
        if (!object(removed) || removed.frameId !== this.document.frameId) continue;
        const tool = this.catalog.get(removed.name); if (!tool) continue;
        this.catalog.delete(tool.name); this.handles.delete(tool.id); changed = true;
        for (const operation of [...this.operations]) if (operation.handleId === tool.id) this.finish(operation, fault('The site tool was removed before its result was confirmed.', 'WEBMCP_TOOL_CHANGED', { outcome: operation.dispatched ? 'unknown' : 'not-dispatched' }));
      }
      if (changed) { this.emit('tools', this.tools()); this.update(); }
    } else if (event.method === 'WebMCP.toolResponded') {
      const operation = this.pending.get(params.invocationId);
      // Never collect another consumer's invocation inputs, outputs, or history.
      if (!operation) return;
      if (params.status === 'Completed') {
        try { this.finish(operation, null, { invocationId: operation.invocationId, status: 'Completed', output: jsonValue(params.output, WEBMCP_LIMITS.outputBytes).value }); }
        catch { this.finish(operation, fault('The site tool returned an invalid or oversized result.', 'WEBMCP_PROTOCOL', { outcome: 'unknown' })); }
      } else if (params.status === 'Canceled') this.finish(operation, fault('The site tool invocation was cancelled.', 'WEBMCP_CANCELLED', { outcome: 'unknown' }));
      else if (params.status === 'Error') this.finish(operation, fault('The site tool reported an error.', 'WEBMCP_TOOL_ERROR', { outcome: 'unknown' }));
      else this.finish(operation, fault('The site tool did not report a recognized completion status.', 'WEBMCP_PROTOCOL', { outcome: 'unknown' }));
    }
  }

  invoke(handle, input = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    try {
      this.assertDocument();
      if (this.state !== 'ready') throw fault('Refresh this document’s site tools before invoking one.', 'WEBMCP_NOT_READY');
      if (signal?.aborted) throw aborted();
      const tool = object(handle) && this.handles.get(handle.id);
      if (!tool || tool.name !== handle.name || tool.frameId !== handle.frameId || tool.generation !== handle.generation || tool.schemaHash !== handle.schemaHash || tool.origin !== handle.origin) throw fault('Choose a tool from the current document’s observed catalog.', 'WEBMCP_STALE_TOOL');
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw fault('Use a bounded site tool deadline.', 'WEBMCP_ARGUMENTS');
      if (!object(input)) throw fault('Site tool arguments must be a JSON object.', 'WEBMCP_ARGUMENTS');
      const payload = jsonValue(input, WEBMCP_LIMITS.inputBytes, 'WEBMCP_ARGUMENTS').value;
      if (this.operations.size >= WEBMCP_LIMITS.pending) throw fault('Too many site tool operations are pending.', 'WEBMCP_BUSY');
      const operation = { handleId: tool.id, sequence: this.sequence, signal, dispatched: false, done: false, invocationId: null };
      operation.promise = new Promise((resolve, reject) => { operation.resolve = resolve; operation.reject = reject; });
      // Attach ownership before sending the command. Chromium sends its command
      // acknowledgement before toolResponded, even for a synchronous page tool.
      this.operations.add(operation);
      operation.abort = () => this.stop(operation, aborted());
      signal?.addEventListener('abort', operation.abort, { once: true });
      operation.timer = setTimeout(() => this.stop(operation, fault('The site tool result was not confirmed before the deadline.', 'WEBMCP_TIMEOUT', { outcome: operation.dispatched ? 'unknown' : 'not-dispatched' })), timeoutMs);
      this.update();
      Promise.resolve().then(async () => {
        if (operation.done) return;
        this.assertDocument(); operation.dispatched = true;
        let result;
        try { result = await this.sendCommand('WebMCP.invokeTool', { frameId: tool.frameId, toolName: tool.name, input: payload }); }
        catch { this.finish(operation, fault('The site tool invocation could not be confirmed.', 'WEBMCP_INVOKE_FAILED', { outcome: 'unknown' })); return; }
        if (!object(result) || !boundedString(result.invocationId, 160)) { this.finish(operation, fault('The browser did not return an invocation receipt.', 'WEBMCP_PROTOCOL', { outcome: 'unknown' })); return; }
        operation.invocationId = result.invocationId;
        if (operation.done || operation.sequence !== this.sequence) { this.cancelRemote(operation); return; }
        if (this.pending.has(result.invocationId)) { this.finish(operation, fault('The browser returned a duplicate invocation receipt.', 'WEBMCP_PROTOCOL', { outcome: 'unknown' })); return; }
        this.pending.set(result.invocationId, operation);
      }).catch(() => this.finish(operation, fault('The browser document changed before invocation.', 'WEBMCP_DOCUMENT_CHANGED', { outcome: operation.dispatched ? 'unknown' : 'not-dispatched' })));
      return operation.promise;
    } catch (cause) { return Promise.reject(cause); }
  }

  cancelRemote(operation) {
    if (!operation.invocationId || operation.cancelSent || operation.sequence !== this.sequence || !sameDocument(this.document, this.currentDocument())) return;
    operation.cancelSent = true;
    // Cancellation cannot undo a page action. It is bounded and never retried.
    this.command('WebMCP.cancelInvocation', { invocationId: operation.invocationId }, Math.min(this.timeoutMs, 1000)).catch(() => {});
  }
  stop(operation, cause) { if (operation.done) return; cause.outcome ||= operation.dispatched ? 'unknown' : 'not-dispatched'; this.cancelRemote(operation); this.finish(operation, cause); }
  finish(operation, cause, result) {
    if (operation.done) return;
    operation.done = true; clearTimeout(operation.timer); operation.signal?.removeEventListener('abort', operation.abort);
    this.operations.delete(operation); if (operation.invocationId && this.pending.get(operation.invocationId) === operation) this.pending.delete(operation.invocationId);
    if (cause) operation.reject(cause); else operation.resolve(result);
    this.update();
  }
  close() {
    if (this.closed) return;
    for (const operation of [...this.operations]) this.cancelRemote(operation);
    this.closed = true; this.invalidate('closed'); this.state = 'closed'; this.supported = null; this.reason = 'closed'; this.update();
    // The shared debugger stays attached for its other contained-browser users.
  }
}
