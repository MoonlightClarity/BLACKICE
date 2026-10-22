import { randomBytes } from 'node:crypto';

export const DESKTOP_RESTART_ORIGIN_ENV = 'BLACKICE_RESTART_ORIGIN';
const tools = new Set(['blackice_run_command', 'blackice_restart']);
const fail = (code = 'DESKTOP_RESTART_ORIGIN_INVALID') => Object.assign(new Error(code === 'DESKTOP_RESTART_CANCELLED' ? 'The originating action cancelled this restart.' : 'The restart origin is no longer an owned, authorized direct action.'), { code, status: 409 });
const finished = job => job?.status === 'succeeded' && typeof job.finishedAt === 'string' && Number.isFinite(Date.parse(job.finishedAt));

/** In-memory capabilities bind one child command to its exact durable action. */
export class DesktopRestartOrigins {
  constructor({ getJob, getActive, authorize } = {}) {
    if ([getJob, getActive, authorize].some(callback => typeof callback !== 'function')) throw new TypeError('Restart origins need the owning executor and durable job reader.');
    Object.assign(this, { getJob, getActive, authorize });
    this.tokens = new Map(); this.jobs = new Map(); this.bindings = new WeakMap();
  }
  issue(job, signal) {
    const active = this.getActive(job.id);
    if (!tools.has(job.tool) || !job.ownerId || job.client?.id !== job.ownerId || !signal || active?.ownerId !== job.ownerId || active.controller.signal !== signal) throw fail();
    const existing = this.jobs.get(job.id);
    if (existing) { if (existing.signal !== signal) throw fail(); return existing.origin; }
    const origin = Object.freeze({});
    const binding = { origin, jobId: job.id, ownerId: job.ownerId, tool: job.tool, signal, token: job.tool === 'blackice_run_command' ? randomBytes(32).toString('hex') : null, requestId: null, retained: false, released: false };
    this.bindings.set(origin, binding); this.jobs.set(job.id, binding);
    if (binding.token) this.tokens.set(binding.token, binding);
    return origin;
  }
  binding(origin) {
    const binding = origin && this.bindings.get(origin);
    if (!binding || binding.released) throw fail();
    if (binding.signal.aborted) throw fail('DESKTOP_RESTART_CANCELLED');
    return binding;
  }
  token(origin) { return this.binding(origin).token; }
  async read(origin) {
    const binding = this.binding(origin);
    let job;
    try { job = await this.getJob(binding.jobId, { ownerId: binding.ownerId }); }
    catch { throw fail('DESKTOP_RESTART_RECEIPT_UNAVAILABLE'); }
    if (job?.id !== binding.jobId || job.ownerId !== binding.ownerId || job.client?.id !== binding.ownerId || job.tool !== binding.tool) throw fail();
    try { await this.authorize(job.client); } catch { throw fail('DESKTOP_RESTART_ORIGIN_UNAUTHORIZED'); }
    this.binding(origin);
    if (job.status === 'running') {
      const active = this.getActive(binding.jobId);
      if (active?.ownerId !== binding.ownerId || active.controller.signal !== binding.signal) throw fail();
    }
    return job;
  }
  async validate(origin, { requireFinished = false } = {}) {
    const job = await this.read(origin);
    if (job.status === 'cancelled' || job.status === 'cancelling') throw fail('DESKTOP_RESTART_CANCELLED');
    if (requireFinished ? !finished(job) : job.status !== 'running' && !finished(job)) throw fail('DESKTOP_RESTART_ORIGIN_FAILED');
    return { jobId: job.id, ownerId: job.ownerId, tool: job.tool };
  }
  async resolve(token, requestId) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw fail();
    const binding = this.tokens.get(token);
    if (!binding || binding.tool !== 'blackice_run_command') throw fail();
    await this.validate(binding.origin);
    // Recheck after asynchronous authorization: one command cannot bind two
    // different native restart requests through concurrent secondary processes.
    if (binding.requestId !== null && binding.requestId !== requestId) throw fail();
    binding.requestId = requestId;
    return binding.origin;
  }
  context(origin) {
    const binding = this.binding(origin);
    return { origin, jobId: binding.jobId, ownerId: binding.ownerId, signal: binding.signal, waitForReceipt: () => this.read(origin) };
  }
  retain(origin, handoff) {
    const binding = this.binding(origin); binding.retained = true;
    Promise.resolve(handoff).then(() => this.release(binding), () => this.release(binding));
  }
  finish(jobId) { const binding = this.jobs.get(jobId); if (binding && !binding.retained) this.release(binding); }
  release(binding) {
    if (binding.released) return;
    binding.released = true; this.jobs.delete(binding.jobId);
    if (binding.token) this.tokens.delete(binding.token);
  }
}
