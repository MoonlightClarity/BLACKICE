/** Node timers overflow after about 24.8 days. Long user budgets need rearming. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function normalizeRunTimeout(value) {
  if (value === null || Number.isSafeInteger(value) && value > 0) return value;
  throw Object.assign(new Error('Choose no time limit or a positive whole number of milliseconds.'), { status: 400, code: 'INVALID_RUN_TIMEOUT' });
}

/** A total execution deadline, independent of individual network request health. */
export function startRunDeadline(timeoutMs, onTimeout, { setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, now = () => performance.now() } = {}) {
  normalizeRunTimeout(timeoutMs);
  if (timeoutMs === null) return () => {};
  const startedAt = now(); let timer, cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const remaining = timeoutMs - Math.max(0, now() - startedAt);
    if (remaining <= 0) { cancelled = true; onTimeout(); return; }
    timer = setTimeoutImpl(arm, Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.ceil(remaining))));
  };
  arm();
  return () => { if (cancelled) return; cancelled = true; clearTimeoutImpl(timer); };
}
