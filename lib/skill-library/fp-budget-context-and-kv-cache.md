# Budget Context and KV Cache

Use this method when extending context, fitting local inference into memory, or comparing attention-cache strategies. Derive the cost from the actual architecture and distinguish memory capacity from successful reasoning over long inputs.

## Primitives

Read layer count, key-value head count, head dimension, retained tokens, batch or sequence count, key/value representation, attention pattern, and cache implementation. Query heads and key-value heads need not be equal. Sliding windows, shared prefixes, recurrent state, and compressed caches can change the calculation.

## Procedure

1. Inspect the model configuration and runtime's effective settings. Record supported and configured positional range, cache dtype, context reservation, and maximum simultaneous sequences.
2. For a conventional full-attention cache, calculate bytes as B * T * L * Hkv * D * (sK + sV), where sK and sV are bytes per cached key and value element. State every dimension and assumption.
3. Add cache metadata, padding, block allocation, and implementation overhead. Distinguish reserved capacity from live tokens and shared physical blocks from logically repeated prefixes.
4. Combine cache cost with weights, temporary buffers, multimodal inputs, and runtime overhead using overlapping lifetimes. A weight-only capacity estimate omits a growing inference allocation.
5. Estimate prefill and decoding behavior separately. Long input processing and one-token decoding can have different arithmetic, bandwidth, and latency limits.
6. If changing positional scaling or extending context, test retrieval and reasoning at several lengths and positions. An accepted configuration value does not establish useful long-context behavior.
7. Compare capacity interventions under the same task: lower cache precision, fewer simultaneous sequences, a smaller retained window, or an architecture-supported cache strategy. Preserve information needed for the task.
8. Verify actual peak memory and task accuracy at the intended context, including output growth.

## Worked example

Consider a hypothetical model with 24 layers, four KV heads, head dimension 64, one sequence, and 32,768 retained tokens. FP16 keys and values require 2 bytes each. The simple cache estimate is 1 * 32,768 * 24 * 4 * 64 * 4 = 805,306,368 bytes, or 768 MiB. This excludes metadata and other allocations. Doubling retained tokens doubles this cache term; it does not automatically double every other cost.

## Output and check

Return the configuration-derived formula, capacity table across relevant lengths and concurrency, measured peak, latency, and long-context task result. Label hypothetical architecture values so they cannot be mistaken for a named model's requirements.

## Failure boundary

Do not apply the conventional cache formula unchanged to an architecture with a different state representation. Quantized caches add scales and may affect quality. Positional extrapolation, available memory, and task accuracy are independent requirements; satisfying one does not establish the others.

## References

- [Hugging Face: Cache strategies](https://huggingface.co/docs/transformers/en/kv_cache)
- [PagedAttention: Efficient memory management for LLM serving](https://arxiv.org/abs/2309.06180)
