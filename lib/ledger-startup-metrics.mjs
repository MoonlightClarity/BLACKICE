import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
export const LEDGER_METRIC_LIMIT = 86400000000;
export const LEDGER_METRIC_FIELDS = Object.freeze(['durationMs','processCpuMs','eventLoopActiveMs','eventLoopIdleMs','eventLoopDelayMaxMs','eventLoopSamples','leaseMs','enumerateMs','scanMs','sortMs','recoveryMs','statAggregateMs','readAggregateMs','validationMs','indexMs','receipts','bytes','recovered']);
const phases = new Set(['lease','enumerate','scan','sort','recovery']);
const bounded = n => Number.isFinite(n) ? Math.min(LEDGER_METRIC_LIMIT, Math.max(0, Math.round(n))) : 0;
/** Aggregate local startup metadata only. Concurrent I/O sums are NOT wall-time components.
 * CPU and event-loop measurements cover this process, including unrelated work.
 */
export class LedgerStartupMetrics {
  constructor() {
    this.values = Object.fromEntries(LEDGER_METRIC_FIELDS.map(key => [key,0]));
    this.started = performance.now(); this.phaseStarted = this.started; this.phase = 'lease';
    this.cpu = process.cpuUsage(); this.elu = performance.eventLoopUtilization();
    this.delay = monitorEventLoopDelay({ resolution: 20 }); this.delay.enable();
  }
  now() { return performance.now(); }
  add(key, value = 1) { if (Object.hasOwn(this.values,key)) this.values[key] += value; }
  elapsed(key, start) { this.add(key, performance.now()-start); }
  mark(phase) {
    if (!phases.has(phase)) return;
    const now = performance.now(); this.add(this.phase+'Ms',now-this.phaseStarted);
    this.phaseStarted=now;this.phase=phase;
  }
  finish(outcome) {
    const now=performance.now();this.add(this.phase+'Ms',now-this.phaseStarted);
    this.delay.disable();
    const cpu=process.cpuUsage(this.cpu), elu=performance.eventLoopUtilization(this.elu);
    Object.assign(this.values,{durationMs:now-this.started,processCpuMs:(cpu.user+cpu.system)/1000,
      eventLoopActiveMs:elu.active,eventLoopIdleMs:elu.idle,eventLoopDelayMaxMs:this.delay.max/1e6,eventLoopSamples:this.delay.count});
    return { component:'system',event:'direct_jobs_startup',outcome:outcome==='ready'?'ready':'failed',
      stage:this.phase,...Object.fromEntries(LEDGER_METRIC_FIELDS.map(key=>[key,bounded(this.values[key])])) };
  }
}
