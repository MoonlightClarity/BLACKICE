# Analyze Quantization Error

Use this method when a lower-bit representation changes model behavior or when choosing a compression method. Analyze the numerical transformation and the workload it affects. A bit count describes storage granularity, not a universal accuracy level.

## Primitives

Record the original values, quantizer, scale, zero point, clipping range, group size, calibration data, storage packing, dequantization, and accumulation precision. Separate weight quantization, activation quantization, cache quantization, and lower-precision arithmetic. They introduce different errors at different locations.

## Procedure

1. Establish the same model and runtime at a higher-precision reference. Hold tokenizer, preprocessing, prompt, context, and decoding settings fixed before attributing failure to quantization.
2. Inspect the actual quantization rule. For uniform nearest rounding without clipping, the reconstruction error is bounded by half a quantization step. Clipped values require a separate error calculation.
3. Measure error by tensor, channel, and relevant activation range. Include extreme values and structured patterns rather than relying only on a global mean error.
4. Propagate the perturbation through a representative operation. For y = Wx and reconstructed weights W + E, the immediate output difference is Ex when x is held fixed. Thus activation direction and magnitude matter as well as weight error.
5. Compare intermediate activations and same-prefix output logits to identify sensitive components. Later autoregressive divergence can be a consequence of one early ranking change.
6. Test a targeted intervention: preserve one sensitive tensor at higher precision, change group size or clipping, improve calibration coverage, or use an appropriate activation-aware method. Measure quality and memory together.
7. Evaluate on examples outside the calibration set and on the actual task. Track interaction with runtime kernels; a format's mathematical representation and its implementation are separate variables.
8. Report the smallest supported precision change that repairs the observed behavior, along with remaining failures.

## Worked example

A weight perturbation E = [0.01, -0.01] has a small average magnitude. With x = [1,1], its dot-product error is zero. With x = [100,0], the error is 1. The same weight error therefore has different consequences across inputs. A calibration set missing large first-channel activations can underestimate the relevant loss.

## Output and check

Produce a tensor error map, activation-sensitive comparison, targeted precision experiment, end-task result, and measured resource cost. Distinguish lossless repacking from lossy quantization and from training a model to tolerate a low-bit representation.

## Failure boundary

A script cannot generally rewrite arbitrary high-precision weights into fewer bits while preserving all information. Special structure may permit compression, but prove the claimed equivalence. Do not transfer an accuracy result from a large language model to a small multimodal model without testing its architecture, processor, and workload.

## References

- [GPTQ: Accurate Post-Training Quantization](https://arxiv.org/abs/2210.17323)
- [AWQ: Activation-aware Weight Quantization](https://arxiv.org/abs/2306.00978)
