# Isolate Model and Runtime Failures

Use this method when an inference failure could come from the model, its representation, or the execution pipeline. Establish a matched reference and locate the earliest divergence before changing the model or declaring the backend unsuitable.

## Primitives

Identify source weights, converted artifact, architecture configuration, tokenizer, chat template, multimodal processor, numerical precision, kernels, positional encoding, context, and decoding settings. A model name does not guarantee that two executions implement the same function.

## Procedure

1. Preserve a small failing input and define the expected behavior. Record exact artifacts and configuration. Include an adjacent input that succeeds when it helps distinguish the failure.
2. Establish a reference path at a precision and context both implementations support. Verify that it actually performs the task; do not treat the reference as correct merely because it is conventional.
3. Compare inputs before transformer execution: token IDs, special tokens, masks, positions, image or audio tensors, and prompt boundaries.
4. Compare equivalent tensor values and shapes after conversion. Check architecture-specific packing, transposes, normalization, projector weights, and vocabulary dimensions.
5. With matched inputs, use teacher forcing to compare logits or intermediate activations for the same token sequence. Free generation can amplify an early small difference into entirely different later contexts.
6. Locate the first meaningful divergence using a tracer or targeted instrumentation. Separate expected floating-point variation from shape, masking, scale, or indexing errors.
7. Run one-variable interventions: reference versus candidate runtime at matched precision, higher versus lower precision within one runtime, or one changed kernel. If two changes may interact, compare neither, each alone, and both.
8. Recheck the end task after the numerical or configuration repair. Preserve measured distinctions among conversion defects, runtime defects, precision sensitivity, and an intrinsic model limitation.

## Worked example

A small vision model succeeds in one backend and gives unrelated answers in another. The same image file was supplied, but traces show different patch order before the projector. Matching the processor restores comparable activations and task behavior. Increasing model size would have hidden neither the cause nor the defect. If patch tensors match and divergence first appears only with a lower-bit linear layer, the next experiment instead isolates that quantization path.

## Output and check

Return a comparison matrix with held-constant factors, changed factor, earliest observed divergence, intervention, and task result. Identify untested explanations explicitly. A trace is evidence of where outputs differ; a controlled correction supplies stronger evidence of why.

## Failure boundary

Bitwise identity is not guaranteed across all mathematically equivalent floating-point executions. Use task-relevant tolerances and inspect ranking changes near tied logits. Do not change templates, precision, context length, and runtime simultaneously and then attribute the outcome to one factor. A single passing prompt does not establish broad backend equivalence.

## References

- [PyTorch: Numerical accuracy](https://docs.pytorch.org/docs/stable/notes/numerical_accuracy.html)
- [Hugging Face: Multimodal chat templates](https://huggingface.co/docs/transformers/en/chat_templating_multimodal)
