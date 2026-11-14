import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { llamaCppCatalog } from './llama-cpp-local.mjs';
import { buildLlamaCppLaunch, validateLlamaCppSettings } from './llama-cpp-launch-config.mjs';

const fail = (message, code = 'LOCAL_LLAMA_STARTUP_UNAVAILABLE', status = 503) =>
  Object.assign(new Error(message), {code, status});
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
    readinessTimeoutMs = 45_000} = {}) {
    if (typeof request !== 'function') throw TypeError('A llama.cpp API request is required.');
    this.request = request;
    this.spawn = spawnImpl;
    this.fs = fsImpl; this.makeTemp = makeTemp; this.removeDir = removeDir; this.writeText = writeText;
    this.dataDir = dataDir || os.tmpdir();
    this.executableCandidates = executableCandidates;
    this.sleep = sleep; this.now = now;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.child = null; this.childExit = null; this.starting = null; this.active = 0;
    this.timer = null; this.generation = 0; this.closed = false;
    this.runDirectory = null; this.appliedRevision = null; this.lastUseAt = null;
    this.output = ''; this.shutdownIdleSeconds = 0;
  }
  status(revision = null) {
    return {
      owned: Boolean(this.child && !this.childExit),
      activeLeases: this.active,
      starting: Boolean(this.starting),
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
    if (this.closed || !this.child || this.childExit || this.active || this.starting || !this.shutdownIdleSeconds) return;
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
    // No PID scan, process name match, port kill or taskkill /T. A child tree
    // teardown is still a Windows integration gate, so default shutdown is off.
    try { return this.child.kill() === true; } catch { return false; }
  }
  async candidateExecutable(config) {
    const options = config.executablePath ? [config.executablePath] : this.executableCandidates;
    for (const candidate of options) {
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
      try { const info = await this.fs.stat(candidate); if (info.isFile()) return candidate; }
      catch {}
    }
    throw fail('No verified llama-server executable was found. Set its absolute path in Settings → Models → llama.cpp. BLACKICE will not download or execute a guessed runtime.', 'LOCAL_LLAMA_EXECUTABLE_MISSING');
  }
  async verifyModelPaths(config) {
    if (config.modelsDirectory) {
      try { if (!(await this.fs.stat(config.modelsDirectory)).isDirectory()) throw Error('Not a folder.'); }
      catch { throw fail('The configured GGUF models directory is unavailable.', 'LOCAL_LLAMA_MODELS_DIRECTORY_MISSING'); }
    }
    for (const [id, filename] of Object.entries(config.modelPaths)) {
      try { if (!(await this.fs.stat(filename)).isFile()) throw Error('Not a file.'); }
      catch { throw fail('The configured GGUF file for ' + id + ' is unavailable.', 'LOCAL_LLAMA_MODEL_FILE_MISSING'); }
    }
  }
  async launch(config, revision) {
    const executable = await this.candidateExecutable(config);
    await this.verifyModelPaths(config);
    const directory = await this.makeTemp(path.join(os.tmpdir(), 'blackice-llama-'));
    const presetPath = path.join(directory, 'models.ini');
    let child = null, confirmed = false, closed = false;
    try {
      const plan = buildLlamaCppLaunch(config, {presetPath});
      await this.writeText(presetPath, plan.preset, {encoding:'utf8', flag:'wx'});
      child = this.spawn(executable, plan.args, {
        cwd: path.dirname(executable), windowsHide: true, shell: false, stdio: ['ignore','pipe','pipe'],
      });
      if (!child || typeof child.kill !== 'function' || !Number.isSafeInteger(child.pid) || child.pid <= 0)
        throw fail('The llama-server launch did not return a live child process.', 'LOCAL_LLAMA_SPAWN_FAILED');
      this.child = child; this.childExit = null; this.runDirectory = directory; this.output = '';
      const onExit = info => {
        closed = true;
        this.childExit = info;
        if (this.child === child) this.child = null;
        if (this.runDirectory === directory) this.runDirectory = null;
        void this.removeDir(directory, {recursive:true,force:true}).catch(() => {});
      };
      child.once('error', error => onExit({error: error?.message || 'Spawn failed'}));
      child.once('close', code => onExit({code}));
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
        if (child && !closed) try { child.kill(); } catch {}
        if (!child || closed) await this.removeDir(directory, {recursive:true,force:true}).catch(() => {});
      }
    }
  }
  ensure(configValue, revision) {
    if (this.closed) return Promise.reject(fail('Local llama.cpp server management is closed.', 'LOCAL_LLAMA_CLOSED'));
    if (this.starting) return this.starting;
    // Singleflight starts before even the first offline probe: two picker
    // callbacks cannot both decide to spawn the same port.
    const operation = this.ensureOnce(configValue, revision);
    this.starting = operation;
    void operation.finally(() => {
      if (this.starting !== operation) return;
      this.starting = null;
      if (!this.active) this.scheduleShutdown();
    }).catch(() => {});
    return operation;
  }
  async ensureOnce(configValue, revision) {
    // A port response is never evidence of process ownership.
    try {
      const catalog = await this.probe();
      return {owned: Boolean(this.child && !this.childExit), mode: catalog.mode};
    } catch (cause) {
      if (cause?.code !== 'LOCAL_ENGINE_OFFLINE') throw cause;
      if (this.child && !this.childExit)
        throw fail('BLACKICE owns a llama-server process, but its API is not responding. Inspect its status rather than launching a duplicate.', 'LOCAL_LLAMA_OWNED_NOT_READY');
    }
    const config = validateLlamaCppSettings(configValue);
    const catalog = await this.launch(config, revision);
    return {owned:true, mode:catalog.mode};
  }
  async acquire(config, revision, {signal} = {}) {
    if (this.closed || signal?.aborted) throw signal?.reason || fail('Local llama.cpp server management is closed.', 'LOCAL_LLAMA_CLOSED');
    this.active++;
    this.cancelTimer();
    let released = false;
    const release = () => { if (!released) { released = true; this.release(); } };
    try {
      const result = await this.ensure(config, revision);
      signal?.throwIfAborted?.();
      return {...result, release};
    } catch (cause) {
      release();
      throw cause;
    }
  }
  async close() {
    this.closed = true; this.cancelTimer();
    if (this.starting) await this.starting.catch(() => {});
    if (this.child && !this.childExit) {
      try { this.child.kill(); } catch {}
    }
  }
}
