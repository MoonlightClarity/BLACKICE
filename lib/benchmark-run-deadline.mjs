import { BENCHMARK_PROFILE, BENCHMARK_AGENT_TOOLS_PROFILE } from './benchmark-profile.mjs';
// Pure benchmark deadline contract. The engine owns timers, persistence and cancellation.
export const BENCHMARK_DEADLINE_SCHEMA = 'blackice.minicpm.run-deadline.v1';
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked']);
function fail(code, message) { throw Object.assign(new Error(message), { code, status: 400 }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clock(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail('BENCHMARK_DEADLINE_CLOCK', label + ' must be a canonical UTC timestamp.');
  }
  return Date.parse(value);
}
function id(value, label, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !value || value.length > 200 || value.includes('\0')) {
    fail('BENCHMARK_DEADLINE_IDENTITY', 'Invalid ' + label + '.');
  }
  return value;
}
export function normalizeBenchmarkBudget(value, { required = false } = {}) {
  if (value === undefined) {
    if (required) fail('BENCHMARK_BUDGET_REQUIRED', 'An explicit benchmarkBudget.wallMs is required.');
    return null;
  }
  if (!object(value) || Object.keys(value).sort().join(',') !== 'wallMs' ||
      !Number.isSafeInteger(value.wallMs) || value.wallMs < 1000 || value.wallMs > 3600000) {
    fail('BENCHMARK_BUDGET_INVALID', 'benchmarkBudget must contain only integer wallMs from 1000 to 3600000.');
  }
  return { wallMs: value.wallMs };
}
export function createBenchmarkDeadline(run) {
  if (![BENCHMARK_PROFILE, BENCHMARK_AGENT_TOOLS_PROFILE].includes(run?.benchmark?.profile)) {
    fail('BENCHMARK_DEADLINE_SCOPE', 'A selected MiniCPM benchmark profile is required.');
  }
  const budget = normalizeBenchmarkBudget(run.benchmarkBudget, { required: true });
  const created = clock(run.createdAt, 'run.createdAt');
  const runId = id(run.id, 'run.id'), taskId = id(run.taskId, 'run.taskId');
  if (taskId !== runId) fail('BENCHMARK_DEADLINE_IDENTITY', 'A benchmark deadline must belong to one fresh task/run.');
  return {
    schema: BENCHMARK_DEADLINE_SCHEMA,
    runId, taskId, requestId: id(run.metadata?.clientRequestId, 'clientRequestId', true),
    createdAt: run.createdAt, wallMs: budget.wallMs,
    deadlineAt: new Date(created + budget.wallMs).toISOString(),
  };
}
export function inspectBenchmarkDeadline(run, now) {
  const expected = createBenchmarkDeadline(run), actual = run.benchmarkDeadline;
  if (!object(actual) || Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(',') ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    fail('BENCHMARK_DEADLINE_IDENTITY', 'The saved deadline differs from the admitted run identity or wall budget.');
  }
  const observed = clock(now, 'now'), created = Date.parse(expected.createdAt), due = Date.parse(expected.deadlineAt);
  if (observed < created) fail('BENCHMARK_DEADLINE_CLOCK', 'The current host clock precedes run admission.');
  if (!ACTIVE.has(run.status) && !TERMINAL.has(run.status)) {
    fail('BENCHMARK_DEADLINE_STATE', 'The observed run has no supported execution status.');
  }
  if (run.settled === true && ACTIVE.has(run.status)) {
    fail('BENCHMARK_DEADLINE_STATE', 'An active run cannot already be settled.');
  }
  const remainingMs = Math.max(0, due - observed), latenessMs = Math.max(0, observed - due);
  const action = TERMINAL.has(run.status)
    ? (run.settled === true ? 'settled' : 'terminal')
    : (observed >= due ? 'cancel' : 'wait');
  return { action, deadlineAt: expected.deadlineAt, observedAt: now, remainingMs, latenessMs };
}
