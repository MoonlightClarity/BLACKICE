# Profile Compute and Data Movement

Use this method when a workload is slow and several plausible optimizations compete. Derive how much computation and data movement the task requires, then identify the resource currently limiting useful progress.

## Primitives

Record useful operations, bytes moved at each memory level, arithmetic intensity, effective throughput, effective bandwidth, transfers, synchronization, and launch overhead. Arithmetic intensity is useful operations divided by bytes moved across a specified boundary. State that boundary: register, cache, device memory, interconnect, or storage.

## Procedure

1. Define one representative phase and its completed work. Separate loading, prefill, decoding, preprocessing, and output processing when they have different resource behavior.
2. Estimate operations F and relevant traffic B. Compute intensity I = F/B. Include repeated reads caused by poor reuse; a tensor's logical size is not always the traffic volume.
3. Obtain realistic compute rate C and bandwidth M for the hardware and execution mode. Peak specifications are upper bounds, not observations of the current kernel.
4. Calculate idealized floors F/C and B/M. Their maximum is a lower bound when computation and transfer can overlap; serialized stages can require more. Compare that bound with measured duration.
5. Profile the largest unexplained gap. Consider cache misses, small kernels, synchronization, CPU preparation, transfers, low occupancy, and format conversion.
6. Choose an intervention targeting the measured limitation. Reuse data for a bandwidth limit, reduce arithmetic for a compute limit, fuse or batch tiny operations for overhead, and overlap independent transfers when dependencies permit.
7. Predict the measurable effect before changing code. Reprofile the same work after the change and check whether the bottleneck moved.
8. Include output quality and actual completed work in the comparison; skipping required computation is not the same performance result.

## Worked example

A kernel performs 200 million operations and moves 100 million bytes, giving intensity 2 operations per byte. If effective bandwidth is 50 GB/s, the traffic floor is 2 ms. At an effective compute rate of 1 trillion operations/s, the arithmetic floor is 0.2 ms. Halving arithmetic cannot remove the 2 ms traffic requirement. Reducing redundant traffic to 25 million bytes offers a more relevant hypothesis, subject to overhead and measured reuse.

## Output and check

Return the operation and traffic estimates, resource bounds, observed duration, dominant gap, and intervention result. State units and whether rates are measured or assumed. Include fixed setup cost when amortizing it across a batch materially changes the conclusion.

## Failure boundary

A roofline model does not prove that a kernel reaches either ceiling. Mixed phases can alternate between limits, and traffic measured at one cache level cannot be substituted for another. Compare the same dtype, shape, device, and quality requirement; nominally faster hardware may not support the required execution path efficiently.

## Reference

- [NVIDIA: Nsight Compute Profiling Guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html)
