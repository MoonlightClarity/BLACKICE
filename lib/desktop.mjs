import { EventEmitter } from 'node:events';
import { createWindowsSession } from './windows-session.mjs';
const ACTIONS = new Set(['screenshot', 'windows', 'inspect', 'get_text', 'invoke', 'set_value', 'select', 'toggle', 'expand', 'collapse', 'scroll', 'scroll_into_view', 'wait']);
const LEGACY_INPUT = new Set(['click', 'double_click', 'right_click', 'type', 'key', 'focus']);
const REFERENCE = /^uia_[a-f0-9]{12}_[1-9]\d{0,6}$/;

function desktopError(message, code = 'DESKTOP_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function abortError(message = 'Desktop access was revoked or the operation was cancelled.') {
  const error = desktopError(message, 'ABORT_ERR');
  error.name = 'AbortError';
  return error;
}

function invalid(message) { throw desktopError(message, 'DESKTOP_VALIDATION'); }

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} must be an integer between ${min} and ${max}.`);
  return value;
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Background UI Automation. No physical pointer, keyboard, or foreground APIs are used. */
export class DesktopController extends EventEmitter {
  constructor({ platform = process.platform, runner } = {}) {
    super();
    this.platform = platform;
    this.runner = runner || createWindowsSession();
    this.enabled = false;
    this.epoch = 0;
    this.pending = new Set();
    this.tail = Promise.resolve();
    this.capture = null;
    this.busy = false;
    this.lastError = null;
  }

  status() {
    return {
      available: this.platform === 'win32', enabled: this.enabled,
      platform: this.platform, mode: 'background_uia', scope: 'windows_accessibility_automation',
      liveWindowsDesktop: true, isolated: false, busy: this.busy,
      physicalInput: false, requiresForeground: false,
      limitations: ['Actions require current accessibility refs and the native control\'s supported patterns; disabled or read-only controls enforce their actual state.', 'Custom surfaces may not expose readable or actionable accessibility controls.', 'This adapter does not implement physical mouse, keyboard or foreground-focus input.', 'Windows security boundaries and elevated or secure desktops are not bypassed.'],
      description: 'Inspect and operate existing Windows application controls through background UI Automation, including supported value edits, button invocation, selection, toggling, expansion and scrolling.',
      actions: [...ACTIONS], coordinates: this.capture ? { ...this.capture } : null,
      lastError: this.lastError,
    };
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') invalid('Desktop enabled state must be a boolean.');
    if (enabled && this.platform !== 'win32') throw desktopError('Desktop inspection requires Windows.', 'DESKTOP_UNAVAILABLE');
    this.enabled = enabled;
    if (!enabled) {
      this.epoch += 1;
      this.capture = null;
      for (const controller of this.pending) controller.abort();
      this.runner.close?.();
      this.emit('revoked');
    }
    this.emit('status', this.status());
    return this.status();
  }

  async perform(args, { signal } = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('A supported desktop action is required.');
    if (LEGACY_INPUT.has(args.action)) invalid('Physical mouse, keyboard and focus actions are disabled. Use windows, inspect(windowId), then invoke, set_value or another advertised accessibility action with its ref.');
    if (!ACTIONS.has(args.action)) invalid('A supported desktop action is required.');
    if (!this.enabled) throw desktopError('Desktop access is detached. Attach the live Windows desktop first.', 'DESKTOP_DISABLED');
    if (signal?.aborted) throw abortError();
    const epoch = this.epoch;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    this.pending.add(controller);
    const queued = this.tail.then(async () => {
      if (controller.signal.aborted || !this.enabled || epoch !== this.epoch) throw abortError();
      const request = this.normalize(args);
      this.busy = true;
      this.emit('status', this.status());
      try {
        const result = request.action === 'wait'
          ? await delay(request.milliseconds, controller.signal).then(() => ({ text: `Waited ${request.milliseconds} ms.` }))
          : await this.runner(request, { signal: controller.signal, timeoutMs: 20_000 });
        // A result from an old attachment must never restore access or a screenshot after revocation.
        if (controller.signal.aborted || !this.enabled || epoch !== this.epoch) throw abortError();
        if (!result || typeof result !== 'object') throw desktopError('Windows desktop helper returned no result.');
        if (request.action === 'screenshot') {
          this.validateCapture(result);
          this.capture = { ...result.coordinates };
        }
        this.lastError = null;
        this.emit('action', { action: request.action, source: args.source === 'preview' ? 'preview' : 'agent', at: new Date().toISOString() });
        return result;
      } catch (error) {
        if (error.name !== 'AbortError') this.lastError = error.message;
        throw error;
      } finally {
        this.busy = false;
        this.emit('status', this.status());
      }
    });
    this.tail = queued.catch(() => {});
    try { return await queued; }
    finally {
      this.pending.delete(controller);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  normalize(args) {
    const request = { action: args.action };
    const target = args.handle ?? args.windowId;
    if (target !== undefined) {
      if (typeof target !== 'string' || !/^[1-9]\d{0,18}$/.test(target)) invalid('handle must be a window handle string returned by windows.');
      request.handle = target;
    }
    if (args.ref !== undefined) {
      if (typeof args.ref !== 'string' || !REFERENCE.test(args.ref)) invalid('ref must be an accessibility element reference returned by inspect. Inspect the target window again.');
      request.ref = args.ref;
    }
    if (target !== undefined && args.ref !== undefined) invalid('Choose either windowId or ref, not both.');
    switch (args.action) {
      case 'screenshot':
        return { ...request, maxWidth: 1280, maxHeight: 900 };
      case 'windows': return request;
      case 'inspect':
        if (!request.handle && !request.ref) invalid('inspect needs a windowId from windows or a ref from a previous inspection.');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200 || args.query.includes('\0'))) invalid('query must be text of at most 200 characters.');
        return { ...request, maxDepth: integer(args.maxDepth ?? 5, 'maxDepth', 0, 10), maxNodes: integer(args.maxNodes ?? 150, 'maxNodes', 1, 300), query: args.query || '' };
      case 'scroll': {
        this.requireRef(request);
        if (args.x !== undefined || args.y !== undefined || args.delta !== undefined) invalid('Coordinate and wheel input are disabled. Inspect a scrollable element and use its ref with direction and amount.');
        if (!['up', 'down', 'left', 'right'].includes(args.direction)) invalid('Scroll direction must be up, down, left, or right.');
        if (args.unit !== undefined && !['small', 'large'].includes(args.unit)) invalid('Scroll unit must be small or large.');
        return { ...request, direction: args.direction, amount: integer(args.amount ?? 1, 'scroll steps', 1, 10), unit: args.unit || 'large' };
      }
      case 'set_value':
        this.requireRef(request);
        if (!['string', 'number'].includes(typeof args.value) || (typeof args.value === 'number' && !Number.isFinite(args.value)) || String(args.value).length > 10000 || String(args.value).includes('\0')) invalid('value must be text of at most 10000 characters or a finite number. Empty text clears a supported field.');
        return { ...request, value: args.value };
      case 'get_text':
        this.requireRef(request);
        return { ...request, maxCharacters: integer(args.maxCharacters ?? 4000, 'maxCharacters', 1, 12000) };
      case 'invoke': case 'select': case 'toggle': case 'expand': case 'collapse': case 'scroll_into_view':
        this.requireRef(request); return request;
      case 'wait': return { ...request, milliseconds: integer(args.milliseconds ?? 500, 'milliseconds', 1, 2000) };
      default: invalid('Unsupported desktop action.');
    }
  }

  requireRef(request) { if (!request.ref || request.handle) invalid('This action requires an element ref from inspect(windowId). Window handles and screen coordinates do not identify an accessibility control.'); }

  validateCapture(result) {
    const c = result.coordinates;
    const image = result.image;
    if (!c || !image || image.mimeType !== 'image/png' || typeof image.data !== 'string' || image.data.length > 16 * 1024 * 1024) {
      throw desktopError('Windows desktop screenshot is invalid.');
    }
    for (const field of ['width', 'height', 'nativeWidth', 'nativeHeight']) {
      if (!Number.isSafeInteger(c[field]) || c[field] < 1) throw desktopError('Windows desktop screenshot dimensions are invalid.');
    }
    if (c.width > 1280 || c.height > 900 || image.width !== c.width || image.height !== c.height || !Number.isSafeInteger(c.originX) || !Number.isSafeInteger(c.originY)) {
      throw desktopError('Windows desktop screenshot coordinates are invalid.');
    }
  }
}
