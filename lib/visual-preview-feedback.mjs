// Native code-mode may flatten dynamic-tool image parts into newline-separated
// text and data URLs. Keep the recipe on demand; never inline image bytes here.
export const VISUAL_PREVIEW_FEEDBACK = {
 instruction: 'Display the returned image before judging the artwork. In code mode retain the preview result and forward its images with image(...); printing text metadata does not display them. Native results may be a string of metadata followed by newline-separated data:image/png;base64 URLs, not JSON. Extract those URL lines and forward them in the same execution cell. Structured results instead expose contentItems with inputImage/imageUrl. Do not print or manually copy base64, call preview again just to retrieve the same pixels, or infer appearance from SVG source.',
 nativeStringExample: 'const result = await tools.relay_visual(args); for (const line of String(result).split("\\n")) { const url = line.trim(); if (url.startsWith("data:image/png;base64,")) image(url); }',
 fallback: 'If images still cannot be displayed, report visual inspection as unavailable. Successful rendering and text diagnostics are not visual review.'
};
