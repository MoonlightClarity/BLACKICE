import { directJobTerminal } from './direct-execution-jobs.mjs';

const fail = (message, code = 'DESKTOP_RESTART_BUSY', status = 409, blocker) => Object.assign(new Error(message), { code, status, ...(blocker ? { blocker } : {}) });
const privateSessionActive = value => ['starting', 'running', 'needs_attention'].includes(value?.state) || value?.restartCleanup?.outcome === 'uncertain';
const BROWSER_EFFECT_OUTCOMES = Object.freeze({ loads: ['stopped', 'uncertain'], interactions: ['dismissed', 'uncertain'], downloads: ['cancelled', 'completed', 'interrupted', 'uncertain'] });
function summarizeBrowserEffects(value) {
  if (!value?.browsers || typeof value.browsers !== 'object' || Array.isArray(value.browsers)) return undefined;
  const result = {};
  for (const browser of Object.values(value.browsers)) for (const [kind, outcomes] of Object.entries(BROWSER_EFFECT_OUTCOMES)) {
    if (!Array.isArray(browser?.[kind])) continue;
    for (const item of browser[kind]) if (outcomes.includes(item?.outcome)) {
      result[kind] ||= {}; result[kind][item.outcome] = (result[kind][item.outcome] || 0) + 1;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

/** Ordinary restart is read-only until drain; force stops work only after taking the admission gate. */
export function createDesktopRestartBarrier({ isClosing, isMaintenance, getEngineStatus, getLearningActive, getApplicationSessions, getBrowserStatus, getDirectJobs, getOriginJob = async () => { throw fail('The restart origin is not owned by this executor.', 'DESKTOP_RESTART_ORIGIN_INVALID'); }, getPendingActions, setMaintenance, drain, stopWork = null, timeoutMs = 10000 } = {}) {
  for (const callback of [isClosing, isMaintenance, getEngineStatus, getLearningActive, getApplicationSessions, getBrowserStatus, getDirectJobs, getPendingActions, setMaintenance, drain]) {
    if (typeof callback !== 'function') throw new TypeError('Desktop restart barrier callbacks are required.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('The desktop restart drain timeout must be positive.');
  if (stopWork !== null && typeof stopWork !== 'function') throw new TypeError('Force restart requires an owned work stopper.');
  let current = null, gateOwner = null;

  const checkBrowser = ({ allowActivity = false } = {}) => {
    const status = getBrowserStatus();
    if (!status || typeof status !== 'object' || Array.isArray(status)) throw fail('Browser state could not be checked before restarting BLACKICE.', 'DESKTOP_RESTART_BROWSER_STATE', 503);
    const views = [status, ...Object.values(status.browsers || {}).filter(value => value && typeof value === 'object')];
    if (views.some(value => value.persistence?.healthy === false)) throw fail('Browser folders and pages have unsaved changes. Resolve the browser storage error before restarting BLACKICE.', 'DESKTOP_RESTART_STORAGE', 503);
    // Force preparation needs to reach stopWork before it can cancel an owned
    // browser action. Activity is checked again after cancellation and at the
    // native handoff; allowing admission does not imply it has settled.
    if (!allowActivity) {
      if (views.some(value => value.busy || value.recovery?.required || ['recovering', 'disconnecting', 'closing'].includes(value.lifecycle))) throw fail('Finish browser actions and recovery before restarting BLACKICE.', 'DESKTOP_RESTART_BROWSER_BUSY');
      if (views.some(value => value.tabs?.some(tab => tab.loading || tab.pendingInteraction || tab.interactionSettling))) throw fail('Finish the browser page load or resolve its pending interaction before restarting BLACKICE.', 'DESKTOP_RESTART_BROWSER_BUSY');
      if (views.some(value => value.activeDownloads > 0 || value.downloads?.some(item => item.status === 'downloading'))) throw fail('Finish active browser downloads before restarting BLACKICE.', 'DESKTOP_RESTART_BROWSER_BUSY');
    }
  };
  const checkLive = (owner, force = false) => {
    if (isClosing()) throw fail('BLACKICE is already closing.', 'DESKTOP_RESTART_CLOSING', 503);
    if (isMaintenance() && (!owner || gateOwner !== owner)) throw fail('BLACKICE is already preparing profile maintenance.', undefined, undefined, 'maintenance');
    if (!force && getEngineStatus()?.activeCount) throw fail('Finish active work before restarting BLACKICE.', undefined, undefined, 'active_runs');
    if (!force && getLearningActive()) throw fail('Finish background learning before restarting BLACKICE.', undefined, undefined, 'learning');
    const sessions = getApplicationSessions();
    if (!Array.isArray(sessions)) throw fail('Private application session state could not be checked before restarting BLACKICE.', 'DESKTOP_RESTART_STORAGE', 503);
    if (!force && sessions.some(privateSessionActive)) throw fail('End private application sessions before restarting BLACKICE; they may contain unsaved work.', undefined, undefined, 'application_sessions');
    if (!force && getPendingActions()) throw fail('Finish pending work, sign-ins, or connection checks before restarting BLACKICE.', undefined, undefined, 'pending_actions');
    checkBrowser({ allowActivity: force });
  };
  const checkReady = async ({ origin, force = false } = {}, owner = null) => {
    if (force && !stopWork) throw fail('Force restart is unavailable in this runtime.', 'DESKTOP_RESTART_PREPARE_FAILED', 503);
    checkLive(owner, force);
    const allowed = origin ? await getOriginJob(origin) : null;
    const jobs = await getDirectJobs();
    if (!Array.isArray(jobs)) throw fail('Direct action storage could not be checked before restarting BLACKICE.', 'DESKTOP_RESTART_STORAGE', 503);
    const exactOrigin = job => allowed && typeof allowed.jobId === 'string' && allowed.jobId.length > 0 && typeof allowed.ownerId === 'string' && ['blackice_run_command', 'blackice_restart'].includes(allowed.tool) && job?.id === allowed.jobId && job.ownerId === allowed.ownerId && job.tool === allowed.tool && job.status === 'running';
    if (jobs.some(job => !exactOrigin(job) && !directJobTerminal(job) && !(force && ['queued', 'running', 'cancelling', 'awaiting_input'].includes(job?.status)))) {
      throw fail('Finish pending direct actions before restarting BLACKICE.', undefined, undefined, 'direct_actions');
    }
    // These values may change while the durable job ledger is being read.
    checkLive(owner, force);
  };
  const release = owner => {
    if (gateOwner !== owner) return;
    gateOwner = null;
    setMaintenance(false);
  };
  const ensureCurrent = owner => {
    if (owner.ended || current !== owner) throw fail('The pending restart was released.', 'DESKTOP_RESTART_RELEASED');
    if (owner.signal?.aborted) throw fail('The restart request was cancelled before relaunch was armed.', 'DESKTOP_RESTART_CANCELLED');
  };
  const drainWithTimeout = async (signal, operation = drain) => {
    let timer, abort; const bounded = new AbortController();
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(bounded.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => { bounded.abort(); reject(fail('BLACKICE could not finish pending writes before the restart deadline.', 'DESKTOP_RESTART_DRAIN_TIMEOUT', 503)); }, timeoutMs); }),
        new Promise((_, reject) => { abort = () => { const error = signal?.reason?.code === 'DESKTOP_RESTART_RELEASED' ? signal.reason : fail('The restart request was cancelled before relaunch was armed.', 'DESKTOP_RESTART_CANCELLED'); bounded.abort(error); reject(error); }; signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); }),
      ]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };

  return {
    assertReady: options => checkReady(options),
    assertPrepared() {
      if (!current?.prepared || gateOwner !== current) throw fail('BLACKICE has no prepared restart gate.', 'DESKTOP_RESTART_NOT_PREPARED');
      ensureCurrent(current);
      // Native pages can begin downloads or dialogs after asynchronous drain.
      // This last check is synchronous and runs immediately before relaunch.
      checkLive(current);
    },
    begin({ jobId, origin, signal, force = false } = {}) {
      const identity = origin ?? jobId ?? null;
      if (current) {
        if (current.identity === identity && current.force === force) return current.promise;
        return Promise.reject(fail('Another BLACKICE restart is already being prepared.'));
      }
      const controller = new AbortController();
      const owner = { identity, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, controller, force, ended: false, prepared: false, promise: null };
      current = owner;
      owner.promise = Promise.resolve().then(async () => {
        const privateSessions = [];
        let browser;
        const onPrivateSessionStopped = value => {
          if (owner.ended || current !== owner || owner.signal?.aborted) return;
          if (value && typeof value.sessionId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value.sessionId) && ['requested', 'confirmed', 'uncertain'].includes(value.outcome)) {
            const existing = privateSessions.find(item => item.sessionId === value.sessionId);
            if (existing) existing.outcome = value.outcome; else privateSessions.push({ sessionId: value.sessionId, outcome: value.outcome });
          }
        };
        const onBrowserEffects = value => {
          if (owner.ended || current !== owner || owner.signal?.aborted) return;
          browser = summarizeBrowserEffects(value);
        };
        const forceEffects = () => privateSessions.length || browser ? { ...(privateSessions.length ? { privateSessions: structuredClone(privateSessions) } : {}), ...(browser ? { browser: structuredClone(browser) } : {}) } : undefined;
        try {
          // Scheduling may exempt its exact authenticated origin. Preparation
          // begins only after that origin has a durable success, so no unfinished
          // action receives an exemption here or in the final drained check.
          await checkReady({ force });
          ensureCurrent(owner);
          // No await between the final live check and acquiring the shared gate.
          checkLive(null, force);
          gateOwner = owner;
          setMaintenance(true);
          if (force) {
            await drainWithTimeout(owner.signal, boundedSignal => stopWork({ signal: boundedSignal, onPrivateSessionStopped, onBrowserEffects }));
            ensureCurrent(owner);
            await checkReady({}, owner);
            ensureCurrent(owner);
          }
          await drainWithTimeout(owner.signal);
          ensureCurrent(owner);
          await checkReady({}, owner);
          ensureCurrent(owner);
          owner.prepared = true;
          return forceEffects() ? { forceEffects: forceEffects() } : undefined;
        } catch (error) {
          if (forceEffects()) {
            if (!error || typeof error !== 'object') error = new Error(String(error));
            error.forceEffects = forceEffects();
          }
          release(owner);
          if (current === owner) current = null;
          throw error;
        }
      });
      return owner.promise;
    },
    end() {
      const owner = current;
      if (!owner) return;
      owner.ended = true;
      // Controller deadlines can release the gate before our own stop/drain
      // timeout. Retire those continuations before allowing another admission.
      owner.controller.abort(fail('The pending restart was released.', 'DESKTOP_RESTART_RELEASED'));
      release(owner);
      if (current === owner) current = null;
    },
  };
}
