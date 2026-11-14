/**
 * Bounded, explicit retirement of a Codex process whose native tool-result
 * stream write callback never settled. This module never retries a tool, replays
 * a model turn, silently discards unknown delivery, or starts a new process.
 *
 * The owning CodexRuntime is responsible for retaining the resulting
 * `native.write.uncertain` events in its durable run store.
 */
export const CODEX_NATIVE_WRITE_STALL_MS = 30_000;

function nativeError(code, message) {
  return Object.assign(new Error(message), {code});
}
function redacted(value) {
  return typeof value === 'string' ? value.slice(0, 120) : null;
}
function exited(child) {
  return child && (child.exitCode != null || child.signalCode != null);
}

export class NativeWriteRecovery {
  constructor(runtime, {now = Date.now, stallMs = CODEX_NATIVE_WRITE_STALL_MS, retireTimeoutMs = 4000} = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(stallMs) || stallMs < 0
      || !Number.isSafeInteger(retireTimeoutMs) || retireTimeoutMs < 1) {
      throw nativeError('CODEX_NATIVE_WRITE_CONFIG_INVALID', 'Native write recovery configuration is invalid.');
    }
    this.runtime = runtime;
    this.now = now;
    this.stallMs = stallMs;
    this.retireTimeoutMs = retireTimeoutMs;
    this.sequence = 0;
    this.uncertain = []; // Complete redacted ledger; never evict an unknown effect.
    this.recovering = null;
    this.blockedChild = null;
    this.lastRecovery = null;
  }

  _current() {
    return [...(this.runtime.pendingNativeWrites || [])].filter(row => row.child === this.runtime.child);
  }

  status() {
    const now = this.now();
    const active = this._current();
    const age = row => Math.max(0, now - row.startedAt);
    const oldest = active.reduce((best, row) => !best || row.startedAt < best.startedAt ? row : best, null);
    const blocked = this.blockedChild != null && this.blockedChild === this.runtime.child;
    const running = this.recovering;
    return {
      thresholdMs: this.stallMs,
      retireTimeoutMs: this.retireTimeoutMs,
      pendingCount: active.length,
      stalledCount: active.filter(row => age(row) >= this.stallMs).length,
      oldestWriteId: oldest?.writeId ?? null,
      oldestAgeMs: oldest ? age(oldest) : null,
      pid: this.runtime.child?.pid ?? null,
      recoveryRequired: blocked || active.some(row => age(row) >= this.stallMs),
      blocked,
      pending: active.map(row => ({
        writeId: row.writeId, ageMs: age(row), kind: row.kind,
        threadId: row.threadId, callId: row.callId,
      })),
      uncertainCount: this.uncertain.length,
      uncertain: this.uncertain.slice(-64).map(row => ({...row})),
      recovery: running
        ? {state: running.state, expectedWriteId: running.expectedWriteId, pid: running.pid, startedAt: running.startedAt}
        : this.lastRecovery ? {...this.lastRecovery} : null,
    };
  }

  allUncertain() {
    return this.uncertain.map(row => ({...row}));
  }

  assertStartAllowed() {
    if (this.recovering) {
      throw nativeError('CODEX_NATIVE_WRITE_RECOVERY_BUSY', 'Native result-write recovery is retiring this process.');
    }
    if (this.blockedChild && this.blockedChild === this.runtime.child) {
      throw nativeError('CODEX_NATIVE_WRITE_RETIRE_UNCONFIRMED',
        'The old Codex process did not confirm exit. Explicitly reconcile its retained recovery; never replay the tool.');
    }
    if (this.status().stalledCount > 0) {
      throw nativeError('CODEX_NATIVE_WRITE_STALLED',
        'A tool-result native write has stalled. Inspect nativeWrites and invoke explicit recovery before starting new work.');
    }
  }

  track(child, provenance = {}) {
    if (this.recovering || this.blockedChild === child) {
      throw nativeError('CODEX_NATIVE_WRITE_RECOVERY_BUSY', 'The current native process is blocked from new result writes.');
    }
    const entry = {
      child,
      writeId: ++this.sequence,
      startedAt: this.now(),
      kind: redacted(provenance.kind) || 'native-response',
      threadId: redacted(provenance.threadId),
      turnId: redacted(provenance.turnId),
      callId: redacted(provenance.callId),
      tool: redacted(provenance.tool),
      state: provenance.state || null,
      uncertain: null,
    };
    (this.runtime.pendingNativeWrites ||= new Set()).add(entry);
    return entry;
  }

  _emitUnknown(entry) {
    if (entry.state && typeof this.runtime._emitRun === 'function') {
      this.runtime._emitRun(entry.state, {type: 'native.write.uncertain', ...entry.uncertain});
    }
    this.runtime.emit?.('native.write.uncertain', {...entry.uncertain});
  }

  rememberUnknown(entry, reason) {
    if (entry.uncertain) return entry.uncertain;
    const receipt = {
      writeId: entry.writeId,
      kind: entry.kind,
      threadId: entry.threadId,
      turnId: entry.turnId,
      callId: entry.callId,
      tool: entry.tool,
      startedAt: entry.startedAt,
      observedAt: this.now(),
      reason,
      deliveryStatus: 'unknown',
      localWriteCallback: 'unconfirmed',
      providerAcknowledged: false,
      effectStatus: 'reconciliation-required',
      replayAllowed: false,
    };
    entry.uncertain = receipt;
    this.uncertain.push(receipt);
    this._emitUnknown(entry);
    return receipt;
  }

  /** Callback settling can never upgrade a previously UNKNOWN delivery. */
  settledCallback(entry, cause) {
    this.runtime.pendingNativeWrites?.delete(entry);
    if (entry.uncertain) {
      entry.uncertain.localWriteCallback = cause ? 'error-after-unknown' : 'completed-after-unknown';
      entry.uncertain.lateCallbackAt = this.now();
      this._emitUnknown(entry);
      return false;
    }
    if (cause || entry.child !== this.runtime.child || entry.child.killed) {
      this.rememberUnknown(entry, cause ? 'write-callback-error' : 'connection-changed-before-callback');
      if (cause && entry.child === this.runtime.child) {
        // A failed local write is also an explicit recovery target, even though
        // its callback has settled and it is no longer in pendingNativeWrites.
        this.blockedChild = entry.child;
        this.lastRecovery = {
          state: 'write-error', expectedWriteId: entry.writeId,
          pid: entry.child.pid ?? null,
          threadIds: entry.threadId ? [entry.threadId] : [],
          startedAt: this.now(), reconnectAllowed: false,
        };
        if (this.runtime.info) {
          this.runtime.info.connected = false;
          this.runtime.info.authenticated = false;
          this.runtime.info.lastError = 'Native tool-result write failed; delivery remains unknown until explicit recovery.';
        }
        // Constructor-bypassing transport fixtures lack a status object.
        // In a running runtime the phase is updated, but uncertainty is
        // recorded even when no connection status facade is installed.
        if (this.runtime.info?.connection) this.runtime._connectionPhase?.('failed');
      }
      return false;
    }
    return true;
  }

  connectionLost(child) {
    for (const entry of [...(this.runtime.pendingNativeWrites || [])]) {
      if (child && entry.child !== child) continue;
      this.rememberUnknown(entry, 'connection-closed-before-write-confirmation');
      this.runtime.pendingNativeWrites.delete(entry);
    }
    if (child && this.blockedChild === child && exited(child)) this.blockedChild = null;
  }

  /** One explicit attempt, pinned to the oldest write ID and current child.
   * Successful retirement requires a real process exit; recovery never calls
   * runtime.start(), onToolCall(), turn/start or any external action.
   */
  async recover({expectedWriteId, expectedPid} = {}) {
    const runtime = this.runtime;
    if (runtime.closing) throw nativeError('CODEX_CLOSED', 'Codex runtime is closing.');
    if (this.recovering) throw nativeError('CODEX_NATIVE_WRITE_RECOVERY_BUSY', 'Another recovery owns the native process.');
    const child = runtime.child;
    const entries = this._current();
    const oldest = entries.reduce((best, row) => !best || row.startedAt < best.startedAt ? row : best, null);
    const retry = !!child && this.blockedChild === child && this.lastRecovery?.expectedWriteId === expectedWriteId;
    if (!child || !Number.isSafeInteger(expectedWriteId) || expectedWriteId < 1
      || (!retry && oldest?.writeId !== expectedWriteId)
      || (expectedPid !== undefined && child.pid !== expectedPid)) {
      throw nativeError('CODEX_NATIVE_WRITE_RECOVERY_STALE', 'The observed write or process changed. Inspect again; never replay the tool.');
    }
    const now = this.now();
    if (entries.some(row => now - row.startedAt < this.stallMs)) {
      throw nativeError('CODEX_NATIVE_WRITE_NOT_STALLED', 'At least one native write has not yet reached its stall threshold.');
    }
    const ownedThreads = retry
      ? new Set(this.lastRecovery.threadIds || [])
      : new Set(entries.map(row => row.threadId).filter(Boolean));
    const activeThreads = [...(runtime.threads?.values() || [])];
    if (runtime.startPromise || runtime.preThreadAdmissions?.size || runtime.openingThreads?.size
      || runtime.pending?.size || runtime.modelCheck || runtime.catalogRefresh
      || [...(runtime.hostOnlyPreflights?.values() || [])].some(row => row.child === child)
      || activeThreads.some(state => !ownedThreads.has(state.threadId)
        || state.toolCalls?.size || state.imageJobs?.size)) {
      throw nativeError('CODEX_NATIVE_WRITE_RECOVERY_BUSY',
        'An unrelated native request, protected preflight or actual local effect is active. Nothing was retired.');
    }
    const op = {child, expectedWriteId, pid: child.pid ?? null, startedAt:now, state:'retiring'};
    // Synchronous reservation before the first await prevents an unrelated
    // start, preflight or tool callback from joining the retiring connection.
    this.recovering = op;
    const threadIds = [...new Set([...ownedThreads, ...entries.map(row => row.threadId).filter(Boolean)])];
    for (const entry of entries) this.rememberUnknown(entry, 'explicit-stalled-write-recovery');
    runtime.emit?.('status', runtime.status?.());
    try {
      // The underlying audited retire helper is already bounded. This outer
      // deadline also protects against a future implementation that forgets to
      // settle. A late retire completion does not authorize process replacement.
      let timer, didExit = false;
      try {
        const retire = Promise.resolve().then(() => runtime._retireReplacedProcess(child));
        didExit = await Promise.race([retire,
          new Promise(resolve => {timer = setTimeout(() => resolve(false), this.retireTimeoutMs);})]);
      } catch { /* Preserve the old process and classify exit as unconfirmed. */ }
      finally { clearTimeout(timer); }
      if (!didExit) {
        op.state = 'exit-unconfirmed';
        this.blockedChild = child;
        if (runtime.info) {
          runtime.info.connected = false;
          runtime.info.authenticated = false;
          runtime.info.lastError = 'The native tool result remains uncertain and the old process did not confirm exit.';
        }
        runtime._connectionPhase?.('failed');
        this.lastRecovery = {
          state: op.state, expectedWriteId, pid: op.pid, threadIds,
          startedAt: now, completedAt: this.now(), reconnectAllowed:false,
        };
        throw nativeError('CODEX_NATIVE_WRITE_RETIRE_UNCONFIRMED',
          'The old Codex process did not confirm exit. Preserve the unknown delivery; a new process was not started.');
      }
      if (runtime.child && runtime.child !== child) {
        throw nativeError('CODEX_NATIVE_WRITE_RECOVERY_STALE',
          'A different process appeared during recovery. No tool action was replayed.');
      }
      if (runtime.child === child) {
        runtime._connectionFailed(nativeError('CODEX_NATIVE_WRITE_DELIVERY_UNKNOWN',
          'Native tool-result delivery was not confirmed; the old process has exited.'), child);
      }
      this.blockedChild = null;
      op.state = 'retired';
      this.lastRecovery = {
        state:op.state, expectedWriteId, pid:op.pid, threadIds,
        startedAt:now, completedAt:this.now(), reconnectAllowed:true,
      };
      return {
        status:'retired', reconnectRequired:true, deliveryStatus:'unknown',
        expectedWriteId, uncertainWriteIds:entries.map(row => row.writeId),
        oldProcessExitObserved:true, replayAllowed:false,
      };
    } finally {
      if (this.recovering === op) this.recovering = null;
      runtime.emit?.('status', runtime.status?.());
    }
  }
}
