# Diagnose Training Signals

Use this method when training appears to run but the intended capability does not improve. Follow the complete path from a real example to a parameter update and an independent behavioral result.

## Primitives

Identify raw input, preprocessing, target, mask, loss terms, reduction, trainable parameters, gradients, optimizer state, update magnitude, and held-out behavior. The scalar loss is a measurement of a particular objective. It is not a direct measurement of every capability the user wants.

## Procedure

1. Write the intended learned behavior and one small example that would demonstrate it. Inspect the actual transformed input and target rather than trusting the dataset description.
2. Check target alignment, masks, padding, class mappings, and sequence shifts. Confirm that the loss rewards the desired answer at the desired positions.
3. Decompose the reported loss by relevant token type, class, task, or component. A large easy subset can dominate the average while the difficult behavior remains unchanged.
4. Verify the computation graph and trainable parameters. Inspect whether gradients exist where expected, whether they are finite, and whether the optimizer actually owns those parameters.
5. Compare parameters before and after a step. Check learning rate, gradient accumulation, clipping, mixed precision, skipped steps, and accidental resets when the update differs from expectation.
6. Attempt a small diagnostic overfit on a few clean examples when appropriate. Failure here suggests a pipeline or optimization problem; success establishes only local learnability, not generalization.
7. Evaluate on held-out examples using the intended inference path. Separate training-mode behavior, memorization, distribution mismatch, and decoding differences.
8. Change the first broken relationship in the chain and rerun the focused diagnostic before spending substantial compute on a larger training run.

## Worked example

A sequence training job reports steadily falling loss. Most positions are padding, and the padding mask is accidentally omitted. The model improves at predicting padding while answers remain poor. Inspecting loss by token category reveals that answer-token loss barely changes. Correcting the mask changes what the objective measures; a small clean batch and a held-out task check verify the revised signal.

## Output and check

Return the example-to-update trace, objective decomposition, measured gradient or update evidence, behavioral check, and localized correction. Report learning on the diagnostic batch separately from performance on unseen examples. Keep saved checkpoints and configuration identities tied to the measured results.

## Failure boundary

A tiny-batch overfit is a diagnostic, not evidence of broad skill acquisition. Nonzero gradients do not guarantee useful updates, and a lower loss can result from altered weighting or easier data. Do not silently change the task's target to obtain an attractive curve. Preserve a reference model so improvements and regressions can both be measured.

## Reference

- [PyTorch: Autograd mechanics](https://docs.pytorch.org/docs/stable/notes/autograd.html)
