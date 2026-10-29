import { Session } from 'node:inspector';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

const DEFAULT_EVENT_LIMIT = 1000;
const DEFAULT_EVENT_BYTES = 8 * 1024 * 1024;

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

function limit(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer.`);
  return value;
}

function snapshotExpression(options = {}) {
  const settings = {
    textLimit: limit(options.textLimit, 50000, 'snapshotOptions.textLimit'),
    controlLimit: limit(options.controlLimit, 500, 'snapshotOptions.controlLimit'),
  };
  return `(${function snapshot({ textLimit, controlLimit }) {
    const bodyText = document.body?.innerText || '';
    const nodes = [...document.querySelectorAll('button,input,select,textarea,a[href],summary,[role="button"],[role="tab"]')];
    const controls = nodes.slice(0, controlLimit).map(node => {
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      let visible = Boolean(box.width && box.height), nativeVisibility = false;
      if (typeof node.checkVisibility === 'function') {
        try {
          visible = visible && node.checkVisibility({ opacityProperty: true, visibilityProperty: true,
            checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });
          nativeVisibility = true;
        } catch { /* Older renderers can still use the explicit DOM/style fallback. */ }
      }
      if (!nativeVisibility) visible = visible && !['hidden', 'collapse'].includes(style.visibility);
      for (let ancestor = node; visible && ancestor; ancestor = ancestor.parentElement) {
        if (ancestor !== node && ancestor.tagName === 'DETAILS' && !ancestor.open) {
          const summary = [...ancestor.children].find(child => child.tagName === 'SUMMARY');
          if (!summary?.contains(node)) { visible = false; break; }
        }
        if (!nativeVisibility) {
          const ancestorStyle = ancestor === node ? style : getComputedStyle(ancestor);
          if (ancestorStyle.display === 'none' || Number.parseFloat(ancestorStyle.opacity) === 0 ||
            ancestor !== node && ancestorStyle.contentVisibility === 'hidden') visible = false;
        }
      }
      return {
        tag: node.tagName.toLowerCase(), id: node.id || null, name: node.getAttribute('name'),
        type: node.getAttribute('type'), role: node.getAttribute('role'),
        ariaLabel: node.getAttribute('aria-label'), title: node.getAttribute('title'),
        text: node.innerText || node.textContent || '',
        value: 'value' in node ? node.value : undefined,
        checked: 'checked' in node ? node.checked : undefined,
        disabled: 'disabled' in node ? node.disabled : undefined,
        ariaSelected: node.getAttribute('aria-selected'), ariaExpanded: node.getAttribute('aria-expanded'),
        href: node.getAttribute('href'),
        visible,
        // Viewport intersection is separate from rendering visibility; it does
        // not claim that another element cannot cover this control.
        inViewport: Boolean(visible && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight),
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
    });
    return {
      url: location.href, title: document.title, readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY },
      text: bodyText.slice(0, textLimit), textCharacters: bodyText.length, textTruncated: bodyText.length > textLimit,
      controls, controlCount: nodes.length, controlsTruncated: nodes.length > controlLimit,
    };
  }.toString()})(${JSON.stringify(settings)})`;
}

/** Native owner developer access. Authorization and durable execution belong to the caller. */
export function createFrontendDevtools({ getWindow, getAppMetrics, inspectorSessionFactory = () => new Session() } = {}) {
  if (typeof getWindow !== 'function') throw new TypeError('Frontend developer access needs getWindow.');
  if (typeof inspectorSessionFactory !== 'function') throw new TypeError('inspectorSessionFactory must be a function.');

  let closed = false, frontend = null, main = null;
  let eventLimit = DEFAULT_EVENT_LIMIT, eventByteLimit = DEFAULT_EVENT_BYTES, eventBytes = 0, sequence = 0;
  const events = [], overflow = { totalDropped: 0, frontend: 0, main: 0, lastDroppedSequence: 0, serializationErrors: 0 };
  let lastSerializationError = null;
  const closeController = new AbortController();
  const startedAt = new Date().toISOString(), started = performance.now();
  const initialCpu = process.cpuUsage(), initialElu = performance.eventLoopUtilization();
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();

  function discardOldest() {
    const entry = events.shift();
    if (!entry) return;
    eventBytes -= entry.bytes;
    overflow.totalDropped++;
    overflow[entry.value.target]++;
    overflow.lastDroppedSequence = entry.value.sequence;
  }

  function trimEvents() {
    while (events.length > eventLimit || eventBytes > eventByteLimit) discardOldest();
  }

  function record(target, method, params, extra = {}) {
    const value = { sequence: ++sequence, at: new Date().toISOString(), target, method, params, ...extra };
    try {
      // CDP and Inspector notifications are protocol JSON. A byte budget keeps
      // tracing/console payloads from making the diagnostic itself unbounded.
      const bytes = Buffer.byteLength(JSON.stringify(value));
      events.push({ value, bytes });
      eventBytes += bytes;
      trimEvents();
    } catch (error) {
      overflow.totalDropped++;
      overflow[target]++;
      overflow.lastDroppedSequence = value.sequence;
      overflow.serializationErrors++;
      lastSerializationError = String(error.message || error);
    }
  }

  function ensureOpen() {
    if (closed) throw failure('Frontend developer access is closed.', 'FRONTEND_DEVTOOLS_CLOSED');
  }

  function windowOf({ required = true } = {}) {
    const window = getWindow();
    const usable = window && !window.isDestroyed?.() && window.webContents && !window.webContents.isDestroyed?.();
    if (!usable && required) throw failure('The BLACKICE frontend window is unavailable.', 'FRONTEND_WINDOW_UNAVAILABLE');
    return usable ? window : null;
  }

  function metadata(target, window = null) {
    if (target === 'main') return { target, processId: process.pid, processRole: 'electron-main' };
    const contents = (window || windowOf()).webContents;
    return { target, processId: contents.getOSProcessId?.() ?? null, processRole: 'renderer', webContentsId: contents.id };
  }

  function releaseFrontend() {
    const entry = frontend;
    frontend = null;
    if (!entry) return;
    entry.debugger.removeListener('message', entry.onMessage);
    entry.debugger.removeListener('detach', entry.onDetach);
    entry.contents.removeListener?.('destroyed', entry.onDestroyed);
    if (entry.owned && !entry.contents.isDestroyed?.() && entry.debugger.isAttached()) entry.debugger.detach();
  }

  function frontendDebugger(window) {
    const contents = window.webContents;
    if (frontend?.contents !== contents) releaseFrontend();
    if (!frontend) {
      const debug = contents.debugger;
      if (!debug) throw failure('This webContents does not expose the native debugger.', 'FRONTEND_DEBUGGER_UNAVAILABLE');
      const entry = { contents, debugger: debug, owned: false };
      entry.onMessage = (_event, method, params, sessionId) => record('frontend', method, params, {
        webContentsId: contents.id, ...(sessionId ? { sessionId } : {}),
      });
      entry.onDetach = (_event, reason) => {
        entry.owned = false;
        record('frontend', 'Debugger.detached', { reason }, { webContentsId: contents.id });
      };
      entry.onDestroyed = () => {
        // Chromium has already destroyed this target. Release listeners without
        // invoking methods on a now-invalid native debugger wrapper.
        entry.owned = false;
        if (frontend === entry) releaseFrontend();
      };
      debug.on('message', entry.onMessage);
      debug.on('detach', entry.onDetach);
      contents.on?.('destroyed', entry.onDestroyed);
      frontend = entry;
    }
    if (!frontend.debugger.isAttached()) {
      // Electron's debugger is attached once, not once per command. In
      // particular, Profiler.start/stop and tracing can span durable jobs.
      frontend.debugger.attach('1.3');
      frontend.owned = true;
    }
    return frontend.debugger;
  }

  function mainInspector() {
    if (main) return main.session;
    const session = inspectorSessionFactory();
    const onNotification = notification => record('main', notification.method, notification.params, { processId: process.pid });
    session.on('inspectorNotification', onNotification);
    try { session.connect(); }
    catch (error) { session.removeListener('inspectorNotification', onNotification); throw error; }
    main = { session, onNotification };
    return session;
  }

  async function dispatched(operation, { signal, target, method }) {
    const signals = [signal, closeController.signal].filter(Boolean);
    let didDispatch = false, listener;
    const cancelled = () => Object.assign(new Error(didDispatch
      ? 'Caller stopped waiting after dispatch; the command may still be executing.'
      : 'Command cancelled before dispatch.'), {
      name: 'AbortError', code: 'ABORT_ERR', target, method,
      commandDispatched: didDispatch, executionMayContinue: didDispatch,
    });
    if (signals.some(item => item.aborted)) throw cancelled();
    const stopped = new Promise((_, reject) => {
      listener = () => reject(cancelled());
      for (const item of signals) item.addEventListener('abort', listener, { once: true });
    });
    try {
      if (signals.some(item => item.aborted)) throw cancelled();
      didDispatch = true;
      let pending;
      try { pending = Promise.resolve(operation()); }
      catch (error) { pending = Promise.reject(error); }
      return await Promise.race([pending, stopped]);
    } finally {
      for (const item of signals) item.removeEventListener('abort', listener);
    }
  }

  async function command(target, method, params, sessionId, signal) {
    if (typeof method !== 'string' || !method) throw new TypeError('CDP method must be a nonempty string.');
    if (target === 'main' && sessionId !== undefined) {
      throw failure('Node inspector.Session has no out-of-band CDP sessionId transport. Pass the native Node inspector method and its parameters directly.', 'MAIN_INSPECTOR_SESSION_ROUTING_UNAVAILABLE');
    }
    if (signal?.aborted || closeController.signal.aborted) {
      return dispatched(() => {}, { signal, target, method });
    }
    const window = target === 'frontend' ? windowOf() : null;
    const identity = metadata(target, window);
    const transport = target === 'frontend' ? frontendDebugger(window) : mainInspector();
    const result = await dispatched(() => target === 'frontend'
      ? transport.sendCommand(method, params, sessionId)
      : new Promise((resolve, reject) => transport.post(method, params, (error, response) => error ? reject(error) : resolve(response))),
    { signal, target, method });
    return { ...identity, method, ...(sessionId !== undefined ? {
      sessionId, webContentsProcessId: identity.processId, processId: null, processRole: 'frontend-cdp-session',
    } : {}), result: result ?? {} };
  }

  async function state() {
    const window = windowOf({ required: false }), contents = window?.webContents;
    let metrics = null, metricsError = null;
    try { metrics = getAppMetrics ? await getAppMetrics() : null; }
    catch (error) { metricsError = { name: error.name, message: error.message, code: error.code }; }
    const finite = value => Number.isFinite(value) ? value : null;
    const elapsedMs = performance.now() - started, cpu = process.cpuUsage(initialCpu);
    return {
      at: new Date().toISOString(), startedAt,
      window: window ? {
        id: window.id, webContentsId: contents.id, url: contents.getURL(), title: contents.getTitle(),
        rendererProcessId: contents.getOSProcessId?.() ?? null,
        visible: window.isVisible?.() ?? null, focused: window.isFocused?.() ?? null,
        minimized: window.isMinimized?.() ?? null, bounds: window.getBounds?.() ?? null,
        zoomFactor: contents.getZoomFactor?.() ?? null,
        debuggerAttached: contents.debugger?.isAttached() ?? false,
        debuggerOwned: frontend?.contents === contents && frontend.owned,
      } : null,
      main: {
        processId: process.pid, uptimeSeconds: process.uptime(), memory: process.memoryUsage(),
        cpuMicroseconds: process.cpuUsage(), elapsedMs,
        cpuSinceControllerStartMicroseconds: cpu,
        cpuPercentOfOneCoreSinceControllerStart: elapsedMs > 0 ? (cpu.user + cpu.system) / (elapsedMs * 10) : null,
        eventLoopUtilization: performance.eventLoopUtilization(initialElu),
        eventLoopDelayMs: { min: delay.count ? finite(delay.min / 1e6) : null, max: finite(delay.max / 1e6),
          mean: finite(delay.mean / 1e6), p50: finite(delay.percentile(50) / 1e6), p95: finite(delay.percentile(95) / 1e6),
          p99: finite(delay.percentile(99) / 1e6), samples: delay.count },
        inspectorConnected: Boolean(main),
      },
      appMetrics: metrics, ...(metricsError ? { appMetricsError: metricsError } : {}),
      events: { buffered: events.length, bytes: eventBytes, eventLimit, eventByteLimit, latestSequence: sequence,
        overflow: { ...overflow }, lastSerializationError },
    };
  }

  async function execute(args = {}, { signal } = {}) {
    ensureOpen();
    if (signal?.aborted) throw Object.assign(new Error('Command cancelled before dispatch.'), {
      name: 'AbortError', code: 'ABORT_ERR', commandDispatched: false, executionMayContinue: false,
    });
    const target = args.target ?? 'frontend';
    if (target !== 'frontend' && target !== 'main') throw new TypeError('target must be frontend or main.');
    const nextEventLimit = limit(args.eventLimit, eventLimit, 'eventLimit');
    const nextEventByteLimit = limit(args.eventByteLimit, eventByteLimit, 'eventByteLimit');
    eventLimit = nextEventLimit; eventByteLimit = nextEventByteLimit;
    trimEvents();
    switch (args.action ?? 'state') {
      case 'state': return state();
      case 'events': {
        const after = limit(args.after, 0, 'after'), count = limit(args.limit, 100, 'limit');
        const available = events.filter(entry => entry.value.target === target && entry.value.sequence > after);
        const selected = available.slice(0, count), values = structuredClone(selected.map(entry => entry.value));
        if (args.clear) {
          const selectedEntries = new Set(selected);
          for (let index = events.length - 1; index >= 0; index--) if (selectedEntries.has(events[index])) {
            eventBytes -= events[index].bytes; events.splice(index, 1);
          }
        }
        return {
          target, after, events: values, nextCursor: values.at(-1)?.sequence ?? after,
          latestSequence: sequence, remaining: available.length - selected.length,
          firstAvailableSequence: available[0]?.value.sequence ?? null,
          cleared: args.clear ? selected.length : 0,
          buffered: events.length, bytes: eventBytes, eventLimit, eventByteLimit,
          overflow: { ...overflow }, lastSerializationError,
        };
      }
      case 'cdp': return command(target, args.method, args.params ?? {}, args.sessionId, signal);
      case 'evaluate': {
        const expression = args.expression ?? args.params?.expression;
        if (typeof expression !== 'string') throw new TypeError('evaluate needs an expression string.');
        return command(target, 'Runtime.evaluate', { awaitPromise: true, returnByValue: true, ...args.params, expression }, args.sessionId, signal);
      }
      case 'snapshot': {
        if (target !== 'frontend') throw failure('A DOM snapshot belongs to the frontend renderer. Use evaluate or cdp for the main process.', 'FRONTEND_DOM_TARGET_REQUIRED');
        const receipt = await command(target, 'Runtime.evaluate', {
          expression: snapshotExpression(args.snapshotOptions), awaitPromise: true, returnByValue: true,
        }, args.sessionId, signal);
        if (receipt.result.exceptionDetails) return receipt;
        return { target, processId: receipt.processId, processRole: receipt.processRole, webContentsId: receipt.webContentsId,
          snapshot: receipt.result.result?.value ?? null };
      }
      case 'screenshot': {
        if (target !== 'frontend') throw failure('A screenshot belongs to the frontend renderer.', 'FRONTEND_SCREENSHOT_TARGET_REQUIRED');
        const window = windowOf(), identity = metadata(target, window);
        const image = await dispatched(() => args.rect === undefined ? window.webContents.capturePage() : window.webContents.capturePage(args.rect),
          { signal, target, method: 'webContents.capturePage' });
        if (image.isEmpty?.()) throw failure('Native capture returned an empty image.', 'FRONTEND_CAPTURE_EMPTY');
        return { ...identity, mimeType: 'image/png', ...image.getSize(), imageUrl: 'data:image/png;base64,' + image.toPNG().toString('base64') };
      }
      default: throw new TypeError('Unknown frontend developer action: ' + args.action);
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    closeController.abort();
    delay.disable();
    const errors = [];
    try { releaseFrontend(); } catch (error) { errors.push(error); }
    if (main) {
      const entry = main; main = null;
      entry.session.removeListener('inspectorNotification', entry.onNotification);
      try { entry.session.disconnect(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Could not release all owned developer sessions.');
  }

  return { execute, close };
}
