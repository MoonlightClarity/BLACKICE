# Inspect Multimodal Alignment

Use this method when a model's answer depends on images, audio, or video and the failure may precede reasoning. Follow the information from the original media through the model's actual input representation and back to the requested output.

## Primitives

Record source media, decoding, dimensions, orientation, color or sample format, crop, resize, normalization, patches or frames, projector, placeholder tokens, attention masks, positions, and output coordinate system. Distinguish the file the user supplied from the tensor the model actually received.

## Procedure

1. Identify the decisive information in the task: a small label, object position, temporal event, spoken phrase, or relation between media and text. Check that it exists in the source.
2. Inspect the decoded media and transformation metadata. Account for orientation, alpha handling, sampling rate, frame selection, and crop boundaries where relevant.
3. Compare preprocessing with the model's required processor configuration. Verify resize policy, normalization, patch order, tiling, and selected frames.
4. Inspect the actual tensors or a faithful visualization of them. Determine whether the decisive information survives preprocessing at usable resolution.
5. Trace media features through the correct encoder and projector. Check artifact compatibility, output shapes, feature order, and the correspondence between media items and textual placeholders.
6. Verify chat template, attention masks, special tokens, and positions. Supplying a filename or an image token does not prove the associated media features reached the model.
7. For spatial actions, map predicted coordinates back through resize, crop, and viewport transformations. For temporal actions, map sampled indices back to original time.
8. Compare a controlled correction and an adjacent case, then assess the end task. Only after the pipeline preserves the necessary information should the remaining error be attributed to model reasoning.

## Worked example

A screenshot contains a small button label. The application resizes the entire image to 224 pixels across, making the label unreadable. The model chooses a neighboring button. A full-resolution crop of the relevant area restores the label and the correct choice. This result localizes an information-loss mechanism; it does not establish that the model can reason about every screen. Coordinate conversion must still map the crop-relative prediction back to the original screen.

## Output and check

Produce an alignment ledger from source to tensor to output, the first lost or mismatched information, and the observed correction. Include actual dimensions, item counts, and coordinate transforms. Preserve evidence of the model's received representation rather than only the original attachment.

## Failure boundary

A readable source image is insufficient when the model receives a different crop or encoding. A successful text-only prompt does not verify vision support. Changing resolution can also change token count, memory, and latency, so evaluate those costs alongside the recovered task information.

## References

- [Hugging Face: Image processors](https://huggingface.co/docs/transformers/en/image_processors)
- [Hugging Face: Multimodal chat templates](https://huggingface.co/docs/transformers/en/chat_templating_multimodal)
