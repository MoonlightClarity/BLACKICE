# Calculate Memory Liveness

Use this method to estimate RAM or VRAM requirements and explain out-of-memory failures. Count what must coexist at the peak. File size, parameter count, and steady-state process memory each answer a different question.

## Primitives

Identify allocations, representation sizes, ownership, device placement, creation time, release time, allocator reservations, and available capacity. Distinguish logical tensor bytes, physical allocations, reserved pools, mapped files, and actual resident pages. Shared buffers must not be counted twice; temporary copies must not disappear from the model.

## Procedure

1. Define the operation and measurement boundary: loading, preprocessing, prefill, decoding, training, or concurrent requests. Record the exact artifact and configuration.
2. Build an allocation ledger. Include parameters, quantization metadata, activations, scratch workspaces, key-value caches, gradients or optimizer state when applicable, and framework overhead.
3. Derive each allocation from dimensions and representation. For an uncompressed tensor, bytes equal element count multiplied by bytes per element. For grouped quantization, add scales, zero points, packing, and alignment.
4. Draw allocation lifetimes over the operation. Estimate the sum of simultaneously live allocations at each important phase, then take the maximum. Do not add mutually exclusive phase maxima.
5. Account for conversion and transfer paths. A loader may retain the source tensor while allocating its destination, or briefly keep CPU and GPU copies.
6. Compare the model with measured allocated, reserved, and system-reported memory. Investigate gaps through allocator behavior, hidden buffers, other processes, and measurement timing.
7. Change one capacity driver and check its predicted effect. Shortening context, lowering concurrency, releasing a duplicate, or changing precision should alter the corresponding ledger row.
8. Report a range when overhead is unmeasured. Separate the calculated minimum from the observed configuration that actually completed.

## Worked example

A hypothetical dense model contains 1.5 billion parameters stored as FP16. Weight storage alone is 3 billion bytes, about 2.79 GiB. If loading creates a second complete FP16 copy before releasing the first, the weight-related peak is about 5.59 GiB. A later 1 GiB cache does not necessarily coexist with both copies. The ledger determines whether peak load or peak inference is larger. None of these figures establishes requirements for a named model without its actual allocation path.

## Output and check

Produce a table of allocation, size derivation, lifetime, device, and evidence. State the estimated peak, measured peak, remaining discrepancy, and the smallest change likely to fit. Verify with the workload and concurrency that matter to the user.

## Failure boundary

Allocated memory and reserved memory are not interchangeable. Compression ratio does not automatically equal runtime memory reduction. A successful short prompt does not establish long-context capacity, and a capacity calculation says nothing by itself about model accuracy or latency.

## Reference

- [Hugging Face: Cache strategies](https://huggingface.co/docs/transformers/en/kv_cache)
