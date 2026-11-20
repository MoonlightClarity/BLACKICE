import { spawn, execFile, ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { llamaCppCatalog } from './llama-cpp-local.mjs';
import { buildLlamaCppLaunch, validateLlamaCppSettings } from './llama-cpp-launch-config.mjs';

const fail = (message, code = 'LOCAL_LLAMA_STARTUP_UNAVAILABLE', status = 503) =>
  Object.assign(new Error(message), {code, status});
const terminateOwned = child => new Promise(resolve => {
  if (process.platform !== 'win32' || !(child instanceof ChildProcess)) { try { child.kill(); } catch {} resolve(); return; }
  // Exact live child PID obtained from our spawn, never a process-name/port scan.
  execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000},()=>resolve());
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Process ownership is never inferred from a port or API response. Only a
 * child returned by this instance's own spawn can be stopped automatically.
 * Browser/model history and third-party llama-server processes are untouched.
 */
export class LlamaCppServerSupervisor {
  constructor({request, spawnImpl = spawn, fsImpl = fs, makeTemp = mkdtemp,
    removeDir = rm, writeText = writeFile, dataDir, executableCandidates = [],
    sleep = wait, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    readinessTimeoutMs = 45_000, port = 8080, resolveBundledRuntime, terminate = terminateOwned} = {}) {
    if (typeof request !== 'function') throw TypeError('A llama.cpp API request is required.');
    this.request = request;
    this.spawn = spawnImpl;
    this.fs = fsImpl; this.makeTemp = makeTemp; this.removeDir = removeDir; this.writeText = writeText;
    this.dataDir = dataDir || os.tmpdir();
    this.executableCandidates = executableCandidates;
    this.sleep = sleep; this.now = now;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.port = port; this.resolveBundledRuntime = resolveBundledRuntime; this.terminate = terminate;
    this.child = null; this.childExit = null; this.starting = null; this.active = 0;
    this.stopping = null; this.stopPendingChild = null; this.leases = 0;
    this.timer = null; this.generation = 0; this.closed = false;
    this.runDirectory = null; this.appliedRevision = null; this.lastUseAt = null;
    this.output = ''; this.shutdownIdleSeconds = 0;
  }
  status(revision = null) {
    return {
      runtimeBackend: this.runtime?.backend || null,
      owned: Boolean(this.child && !this.childExit),
      activeLeases: this.leases,
      starting: Boolean(this.starting),
      stopping: Boolean(this.stopping || this.stopPendingChild),
      appliedRevision: this.appliedRevision,
      pendingRestart: this.child && revision !== null && revision !== this.appliedRevision || false,
      idleShutdownEnabled: this.shutdownIdleSeconds > 0,
      lastUseAt: this.lastUseAt,
      // Never advertise process ownership for a pre-existing local endpoint.
    };
  }
  async probe() { return llamaCppCatalog(this.request); }
  cancelTimer() {
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    this.lastUseAt = new Date().toISOString();
    if (!this.active) this.scheduleShutdown();
  }
  scheduleShutdown() {
    this.cancelTimer();
    if (this.closed || !this.child || this.childExit || this.active || this.starting || this.stopPendingChild || !this.shutdownIdleSeconds) return;
    const epoch = this.generation;
    this.timer = this.setTimer(() => {
      if (epoch !== this.generation || this.active || this.starting || this.closed) return;
      this.timer = null;
      this.stopOwned();
    }, this.shutdownIdleSeconds * 1000);
    this.timer?.unref?.();
  }
  stopOwned() {
    if (!this.child || this.childExit || this.active || this.starting) return false;
    // Stop only our exact spawned process tree; never scan or kill by name/port.
    if (this.stopPendingChild) return false;
    void this.stopChild(this.child).catch(() => {}); return true;
  }
  stopChild(child) {
    if (this.stopping) return this.stopping;
    this.stopPendingChild = child;
    const operation = (async () => {
      const ended = new Promise(resolve => child.once('close',resolve));
      await this.terminate(child);
      await Promise.race([ended,this.sleep(5000)]);
      if (this.child === child && !this.childExit)
        throw fail('The owned llama-server is still stopping. No new work was admitted.', 'LOCAL_LLAMA_STOP_PENDING');
    })();
    this.stopping = operation;
    void operation.finally(() => { if (this.stopping === operation) this.stopping = null; }).catch(() => {});
    return operation;
  }
  async candidateExecutable(config) {
    const options = config.executablePath ? [config.executablePath] : this.executableCandidates;
    for (const candidate of options) {
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
      try { const info = await this.fs.stat(candidate); if (info.isFile()) return candidate; }
      catch {}
    }
    if (!config.executablePath && this.resolveBundledRuntime) {
      const runtime = await this.resolveBundledRuntime();
      if (runtime.available) { this.runtime = runtime; return runtime.executablePath; }
      throw fail(runtime.message, 'LOCAL_LLAMA_EXECUTABLE_MISSING');
    }
    throw fail('No verified llama-server executable was found. Set its absolute path in Settings → Models → llama.cpp. BLACKICE will not download or execute a guessed runtime.', 'LOCAL_LLAMA_EXECUTABLE_MISSING');
  }
  async usableModelPaths(config) {
    const modelPaths = {}, modelOverrides = {...config.modelOverrides};
    await Promise.all(Object.entries(config.modelPaths).map(async ([id, filename]) => {
      let available = false;
      try { available = (await this.fs.stat(filename)).isFile(); } catch {}
      if (available) modelPaths[id] = filename;
      else delete modelOverrides[id];
    }));
    let modelsDirectory = config.modelsDirectory;
    if (modelsDirectory) {
      try { if (!(await this.fs.stat(modelsDirectory)).isDirectory()) throw Error('Not a folder.'); }
      catch {
        if (!Object.keys(modelPaths).length)
          throw fail('The configured GGUF models directory is unavailable.', 'LOCAL_LLAMA_MODELS_DIRECTORY_MISSING');
        modelsDirectory = '';
      }
    }
    // Only the launch preset is filtered; a disconnected drive can return.
    return {...config, modelsDirectory, modelPaths, modelOverrides};
  }
  async launch(config, revision) {
    const executable = await this.candidateExecutable(config);
    config = await this.usableModelPaths(config);
    const directory = await this.makeTemp(path.join(os.tmpdir(), 'blackice-llama-'));
    const presetPath = path.join(directory, 'models.ini');
    let child = null, confirmed = false, closed = false, owned = false;
    try {
      const plan = buildLlamaCppLaunch(config, {presetPath,port:this.port});
      await this.writeText(presetPath, plan.preset, {encoding:'utf8', flag:'wx'});
      child = this.spawn(executable, plan.args, {
        cwd: path.dirname(executable), windowsHide: true, shell: false, stdio: ['ignore','pipe','pipe'],
      });
      const onExit = info => {
        closed = true;
        if (this.stopPendingChild === child) this.stopPendingChild = null;
        if (this.child === child) { this.childExit = info; this.child = null; }
        if (this.runDirectory === directory) this.runDirectory = null;
        void this.removeDir(directory, {recursive:true,force:true}).catch(() => {});
      };
      // Failed Node spawns may have no PID but still emit error on the next tick.
      child?.once?.('error', error => onExit({error: error?.message || 'Spawn failed'}));
      child?.once?.('close', code => onExit({code}));
      if (!child || typeof child.kill !== 'function' || !Number.isSafeInteger(child.pid) || child.pid <= 0)
        throw fail('The llama-server launch did not return a live child process.', 'LOCAL_LLAMA_SPAWN_FAILED');
      owned = true;
      this.child = child; this.childExit = null; this.runDirectory = directory; this.output = '';
      for (const stream of [child.stdout, child.stderr])
        stream?.on?.('data', chunk => { this.output = (this.output + String(chunk)).slice(-2000); });
      const startedAt = this.now();
      while (this.now() - startedAt < this.readinessTimeoutMs) {
        if (closed) throw fail('llama-server exited before readiness. ' + this.output.slice(-700), 'LOCAL_LLAMA_EARLY_EXIT');
        try {
          const catalog = await this.probe();
          if (closed) throw fail('llama-server exited before readiness.', 'LOCAL_LLAMA_EARLY_EXIT');
          if (catalog.mode !== 'router') throw fail('The newly started endpoint is not a llama.cpp model router.', 'LOCAL_LLAMA_ROUTER_REQUIRED', 409);
          confirmed = true; this.appliedRevision = revision;
          this.shutdownIdleSeconds = config.shutdownIdleSeconds;
          this.lastUseAt = new Date().toISOString();
          return catalog;
        } catch (cause) {
          if (cause?.code !== 'LOCAL_ENGINE_OFFLINE') throw cause;
        }
        await this.sleep(250);
      }
      throw fail('llama-server did not become ready before the startup timeout.', 'LOCAL_LLAMA_STARTUP_TIMEOUT', 504);
    } finally {
      if (!confirmed) {
        // Preserve the owned child identity until its actual close callback.
        // A failed kill or late exit must not permit a competing second spawn.
        if (owned && !closed) {
          const ended = new Promise(resolve=>child.once('close',resolve));
          await this.terminate(child);
          await Promise.race([ended,this.sleep(5000)]);
        }
        if (!owned || closed) await this.removeDir(directory, {recursive:true,force:true}).catch(() => {});
      }
    }
  }
  ensure(configValue, revision, {rediscover = false} = {}) {
    if (this.closed) return Promise.reject(fail('Local llama.cpp server management is closed.', 'LOCAL_LLAMA_CLOSED'));
    if (this.starting) return rediscover
      ? this.starting.then(() => this.ensure(configValue, revision, {rediscover:true}))
      : this.starting;
    // Singleflight starts before even the first offline probe: two picker
    // callbacks cannot both decide to spawn the same port.
    const operation = this.ensureOnce(configValue, revision, {rediscover});
    this.starting = operation;
    void operation.finally(() => {
      if (this.starting !== operation) return;
      this.starting = null;
      if (!this.active) this.scheduleShutdown();
    }).catch(() => {});
    return operation;
  }
  async ensureOnce(configValue, revision, {rediscover = false} = {}) {
    // A healthy response during asynchronous teardown cannot grant a new lease.
    if (this.stopping) await this.stopping;
    if (this.stopPendingChild) throw fail('The owned llama-server is still stopping. No new work was admitted.', 'LOCAL_LLAMA_STOP_PENDING');
    if (this.closed) throw fail('Local llama.cpp server management is closed.', 'LOCAL_LLAMA_CLOSED');
    if (this.child && !this.childExit && this.appliedRevision !== revision) {
      const next = validateLlamaCppSettings(configValue);
      const usable = await this.usableModelPaths(next);
      buildLlamaCppLaunch(usable);
      await this.candidateExecutable(next);
      if (this.leases) throw fail(rediscover
        ? 'Wait for the current local response to finish, then discover folder models again.'
        : 'Model settings were saved. Wait for the current local response to finish, then choose Load again.', 'LOCAL_LLAMA_RESTART_BUSY', 409);
      await this.stopChild(this.child);
      if (this.closed) throw fail('Local llama.cpp server management is closed.', 'LOCAL_LLAMA_CLOSED');
    }
    // A port response is never evidence of process ownership.
    try {
      const catalog = await this.probe();
      const owned = Boolean(this.child && !this.childExit);
      if (rediscover && owned && catalog.mode === 'router') {
        if (this.leases) throw fail('Wait for the current local response to finish, then discover folder models again.', 'LOCAL_LLAMA_RESTART_BUSY', 409);
        // The pinned router can scan its configured directory in place. The
        // start singleflight holds new leases until this request completes.
        await this.request('llamacpp','/models?reload=1',{timeoutMs:30000});
      }
      return {owned, mode: catalog.mode};
    } catch (cause) {
      if (cause?.code !== 'LOCAL_ENGINE_OFFLINE') throw cause;
      if (this.child && !this.childExit)
        throw fail('BLACKICE owns a llama-server process, but its API is not responding. Inspect its status rather than launching a duplicate.', 'LOCAL_LLAMA_OWNED_NOT_READY');
    }
    const config = validateLlamaCppSettings(configValue);
    let catalog;
    try { catalog = await this.launch(config, revision); }
    catch (cause) {
      const fallback = !config.executablePath && this.runtime?.fallbackPath;
      if (!fallback || this.child || !['LOCAL_LLAMA_EARLY_EXIT','LOCAL_LLAMA_STARTUP_TIMEOUT','LOCAL_LLAMA_SPAWN_FAILED'].includes(cause.code)) throw cause;
      catalog = await this.launch({...config,executablePath:fallback},revision);
      this.runtime = {...this.runtime,backend:'CPU',executablePath:fallback,fallbackPath:null,message:'CPU fallback selected after the GPU runtime could not start.'};
    }
    return {owned:true, mode:catalog.mode};
  }
  async acquire(config, revision, {signal,rediscover = false} = {}) {
    if (this.closed || signal?.aborted) throw signal?.reason || fail('Local llama.cpp server management is closed.', 'LOCAL_LLAMA_CLOSED');
    this.active++;
    this.cancelTimer();
    let released = false, leased = false;
    const release = () => { if (!released) { released = true; if (leased) this.leases--; this.release(); } };
    try {
      const result = await this.ensure(config, revision, {rediscover});
      signal?.throwIfAborted?.();
      if (this.closed) throw fail('Local llama.cpp server management is closed.', 'LOCAL_LLAMA_CLOSED');
      if (result.owned && this.appliedRevision !== revision) throw fail('Model settings were saved while another local model was starting. Choose Load again to apply them when it is idle.', 'LOCAL_LLAMA_RESTART_BUSY', 409);
      leased = true; this.leases++;
      return {...result, release};
    } catch (cause) {
      release();
      throw cause;
    }
  }
  async close() {
    this.closed = true; this.cancelTimer();
    if (this.starting) await this.starting.catch(() => {});
    if (this.stopping) await this.stopping;
    if (this.child && !this.childExit) await this.stopChild(this.child);
  }
}
