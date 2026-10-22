import { directJobTerminal } from './direct-execution-jobs.mjs';

const fail = (message, code = 'DESKTOP_RESTART_BUSY', status = 409) => Object.assign(new Error(message), { code, status });
const privateSessionActive = value => ['starting', 'running', 'needs_attention'].includes(value?.state);

/** A temporary admission gate: no work is cancelled and no queue is paused. */
export function createDesktopRestartBarrier({ isClosing, isMaintenance, getEngineStatus, getLearningActive, getApplicationSessions, getBrowserStatus, getDirectJobs, getOriginJob = async () => { throw fail('The restart origin is not owned by this executor.', 'DESKTOP_RESTART_ORIGIN_INVALID'); }, getPendingActions, setMaintenance, drain, timeoutMs = 10000 } = {}) {
  for (const callback of [isClosing, isMaintenance, getEngineStatus, getLearningActive, getApplicationSessions, getBrowserStatus, getDirectJobs, getPendingActions, setMaintenance, drain]) {
    if (typeof callback !== 'function') throw new TypeError('Desktop restart barrier callbacks are required.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('The desktop restart drain timeout must be positive.');
  let current = null, gateOwner = null;

  const checkBrowser = () => {
    const status = getBrowserStatus();
    if (!status || typeof status !== 'object' || Array.isArray(status)) throw fail('Browser state could not be checked before restarting BLACKICE.', 'DESKTOP_RESTART_BROWSER_STATE', 503);
    const views = [status, ...Object.values(status.browsers || {}).filter(value => value && typeof value === 'object')];
    if (views.some(value => value.persistence?.healthy === false)) throw fail('Browser folders and pages have unsaved changes. Resolve the browser storage error before restarting BLACKICE.', 'DESKTOP_RESTART_STORAGE', 503);
    if (views.some(value => value.busy || value.recovery?.required || ['recovering', 'disconnecting', 'closing'].includes(value.lifecycle))) throw fail('Finish browser actions and recovery before restarting BLACKICE.', 'DESKTOP_RESTART_BROWSER_BUSY');
    if (views.some(value => value.tabs?.some(tab => tab.loading || tab.pendingInteraction || tab.interactionSettling))) throw fail('Finish the browser page load or resolve its pending interaction before restarting BLACKICE.', 'DESKTOP_RESTART_BROWSER_BUSY');
    if (views.some(value => value.activeDownloads > 0 || value.downloads?.some(item => item.status === 'downloading'))) throw fail('Finish active browser downloads before restarting BLACKICE.', 'DESKTOP_RESTART_BROWSER_BUSY');
  };
  const checkLive = owner => {
    if (isClosing()) throw fail('BLACKICE is already closing.', 'DESKTOP_RESTART_CLOSING', 503);
    if (isMaintenance() && (!owner || gateOwner !== owner)) throw fail('BLACKICE is already preparing profile maintenance.');
    if (getEngineStatus()?.activeCount || getLearningActive()) throw fail('Finish active work before restarting BLACKICE.');
    if (getApplicationSessions().some(privateSessionActive)) throw fail('End private application sessions before restarting BLACKICE; they may contain unsaved work.');
    if (getPendingActions()) throw fail('Finish pending work, sign-ins, or connection checks before restarting BLACKICE.');
    checkBrowser();
  };
  const checkReady = async ({ origin } = {}, owner = null) => {
    checkLive(owner);
    const allowed = origin ? await getOriginJob(origin) : null;
    const jobs = await getDirectJobs();
    if (!Array.isArray(jobs)) throw fail('Direct action storage could not be checked before restarting BLACKICE.', 'DESKTOP_RESTART_STORAGE', 503);
    const exactOrigin = job => allowed && typeof allowed.jobId === 'string' && allowed.jobId.length > 0 && typeof allowed.ownerId === 'string' && ['blackice_run_command', 'blackice_restart'].includes(allowed.tool) && job?.id === allowed.jobId && job.ownerId === allowed.ownerId && job.tool === allowed.tool && job.status === 'running';
    if (jobs.some(job => !exactOrigin(job) && !directJobTerminal(job))) {
      throw fail('Finish pending direct actions before restarting BLACKICE.');
    }
    // These values may change while the durable job ledger is being read.
    checkLive(owner);
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
  const drainWithTimeout = async signal => {
    let timer, abort;
    try {
      await Promise.race([
        Promise.resolve().then(drain),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fail('BLACKICE could not finish pending writes before the restart deadline.', 'DESKTOP_RESTART_DRAIN_TIMEOUT', 503)), timeoutMs); }),
        new Promise((_, reject) => { abort = () => reject(fail('The restart request was cancelled before relaunch was armed.', 'DESKTOP_RESTART_CANCELLED')); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); }),
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
    begin({ jobId, origin, signal } = {}) {
      const identity = origin ?? jobId ?? null;
      if (current) {
        if (current.identity === identity) return current.promise;
        return Promise.reject(fail('Another BLACKICE restart is already being prepared.'));
      }
      const owner = { identity, signal, ended: false, prepared: false, promise: null };
      current = owner;
      owner.promise = Promise.resolve().then(async () => {
        try {
          // Scheduling may exempt its exact authenticated origin. Preparation
          // begins only after that origin has a durable success, so no unfinished
          // action receives an exemption here or in the final drained check.
          await checkReady();
          ensureCurrent(owner);
          // No await between the final live check and acquiring the shared gate.
          checkLive();
          gateOwner = owner;
          setMaintenance(true);
          await drainWithTimeout(signal);
          ensureCurrent(owner);
          await checkReady({}, owner);
          ensureCurrent(owner);
          owner.prepared = true;
        } catch (error) {
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
      release(owner);
      if (current === owner) current = null;
    },
  };
}
