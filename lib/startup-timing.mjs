import { performance } from 'node:perf_hooks';

export const STARTUP_PHASES = Object.freeze([
  'browser', 'history', 'conversations', 'direct-jobs', 'remote-route', 'local-harness', 'window',
]);
const phases = new Set(STARTUP_PHASES);
const MAX_DURATION_MS = 86_400_000;

/** Time a named local startup operation without exposing its inputs or errors. */
export async function startupPhase(diagnostics, phase, operation) {
  if (!phases.has(phase)) throw new TypeError('Use a supported startup phase.');
  if (typeof operation !== 'function') throw new TypeError('A startup phase requires an operation.');
  const started = performance.now();
  const record = async outcome => {
    try {
      const durationMs = Math.min(MAX_DURATION_MS, Math.max(0, Math.round(performance.now() - started)));
      await diagnostics?.record?.({ component: 'system', event: 'startup_phase',
        level: outcome === 'ready' ? 'info' : 'error', phase, durationMs, outcome });
    } catch { /* Diagnostic failures must preserve the operation's value or error. */ }
  };
  let value;
  try { value = await operation(); }
  catch (error) { await record('failed'); throw error; }
  await record('ready');
  return value;
}
