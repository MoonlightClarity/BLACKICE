// Shared across native previews, direct job results and the on-demand design guide.
// Describe returned data without assuming that the caller has a particular code helper.
export const VISUAL_PREVIEW_FEEDBACK = {
  instruction: 'Inspect the returned render to check appearance. Use the image display capability provided by the calling client; text diagnostics alone describe rendering checks.',
  imageFormats: {
    structured: 'Image parts have type inputImage and an imageUrl. Text metadata uses inputText.',
    flattened: 'Some native code-mode clients return metadata text followed by newline-separated data:image URLs.',
    directJob: 'When a direct preview returns a jobId, read the saved job with includeImages:true. Its result.images entries contain imageUrl.',
  },
  fallback: 'If no image can be viewed, report the rendering result and text diagnostics separately from visual inspection.',
};
