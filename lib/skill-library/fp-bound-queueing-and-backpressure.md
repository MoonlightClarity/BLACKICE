# Bound Queueing and Backpressure

Use this method when work accumulates faster than it completes, latency rises under load, or retries worsen a slowdown. Model admitted demand and service capacity before adding concurrency.

## Primitives

Measure arrival rate, admitted rate, service time, active concurrency, queue length, completion rate, deadline, and retry rate. Distinguish waiting time from execution time. Different requests can consume different amounts of the limiting resource, so requests per second may hide large changes in demand.

## Procedure

1. Choose a time window and identify the constrained resource. Count original requests separately from retries, speculative work, and duplicate effects.
2. Estimate service demand per request class. Convert arrivals into resource demand, such as GPU-seconds per second or disk bytes per second.
3. Compare sustained admitted demand with effective capacity. If demand persistently exceeds capacity, the backlog must grow unless work is removed, deferred, rejected, or accelerated.
4. Inspect variability and burst size. Even average demand below capacity can produce long queues when arrivals or service times are uneven.
5. For a stable system with consistent boundaries, use Little's relation L = lambda W to connect average items in the system, throughput, and average time. Do not apply a stationary average to an exploding backlog.
6. Identify feedback amplification. Timeouts can generate retries while original work still runs; adding workers can increase contention and reduce per-worker throughput.
7. Choose an explicit pressure response consistent with the task: bound admitted work, apply upstream pacing, prioritize deadlines, coalesce equivalent reads, or increase measured bottleneck capacity. Preserve the user's required quality and completion semantics.
8. Verify queue evolution during a representative burst and recovery. A short throughput improvement that leaves an ever-growing backlog is not stable capacity.

## Worked example

A worker completes 100 comparable tasks per second. New work arrives at 110 per second. Ignoring variability, the queue gains 10 tasks each second. Raising the timeout does not remove that imbalance. If timeouts also create 20 retries per second while originals continue, offered demand rises to 130. Pacing admission to sustainable capacity while preventing duplicate effects addresses the mechanism; doubling workers helps only if the limiting resource scales with them.

## Output and check

Produce a demand-and-capacity table, backlog growth estimate, retry contribution, chosen pressure response, and observed recovery. Report latency distributions when deadlines or tail behavior matter, rather than only a mean. Show what happens to deferred work so it is not silently lost.

## Failure boundary

Queueing formulas depend on their assumptions. Do not import an M/M/1 latency formula without appropriate arrival, service, and server assumptions. Little's relation is broader but still requires compatible stable averages. Overload handling is not permission to silently drop required work or replace the requested result with a lower-quality one.

## Reference

- [Google SRE: Handling Overload](https://sre.google/sre-book/handling-overload/)
