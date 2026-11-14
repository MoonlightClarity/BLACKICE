// Retrieved with describe, rather than inserting the complete design guide in every turn.
export const VISUAL_DESIGN_GUIDE = {
 intent: 'Design an intelligence briefing figure that answers this particular question. First identify what the reader should notice, compare or test. Choose the spatial relationships that expose it. The example document demonstrates syntax, not a template to rename for every task.',
 composition: [
  'Use a question or finding as the title and a concise analytical takeaway as the summary. State uncertainty in words. Visual polish is not evidence.',
  'Arrange comparable explanations in aligned columns; align observations across them when comparison matters. Use a grid for exact evidence comparisons. Use links only when the relationship itself needs inspection; write meaningful verbs on them.',
  'Separate observations, assumptions, claims and missing evidence through explicit labels. Do not assign confidence, scores, causal direction or evidence strength from appearance or position.',
  'Compose groups, statements, comparisons, notes and custom regions around the question. A useful figure may be a table with a small causal inset, an uncertainty spectrum, a timeline with missing intervals, or a claim with competing explanations. Do not force every problem into boxes and arrows.',
  'Use light backgrounds, dark sans-serif type, restrained teal or blue accents, ample whitespace and aligned headings. Prefer short readable phrases, with qualifications in a note. Keep full text alternatives. Color must have a stated meaning or remain decorative.',
  'Start with a readable canvas; omit coordinates when automatic placement is enough. For deliberate placement reserve space for complete labels, uncertainty suffixes and legends. Keep text at least 14 SVG units, do not squeeze text to fit, and check the displayed size. Split an overfull figure.',
 ],
 custom: 'If the primitives obscure the analysis, author a custom static SVG or a custom region instead of forcing the example layout. For example, a two-axis uncertainty field needs named axes/endpoints and positioned observations; a temporal comparison needs a common scale and explicit unknown intervals. Use simple rect/line/path/polygon/text elements, explicit dimensions and viewBox, local presentation attributes, and a complete summary. No scripts, external images/fonts, CSS, references, filters or HTML. Custom graphics remain source-editable; do not promise object-level semantic editing.',
 review: 'Before saving, check: does the visual reveal something useful beyond prose; are all labels legible and inside the viewport; do marks overlap or suggest unsupported relationships; can the full meaning be read without color; are missing evidence and uncertainty visible? After saving, inspect the returned text and saved artifact. Revise targeted objects after reading user changes. Prefer plain text if the visual adds no analytical value.',
 examples: [
  'Three reports repeat one source: show the shared source and its dependent reports, not three independent evidence votes.',
  'Two explanations fit: align what each predicts, show the shared observation once, and identify the observation that would distinguish them.',
  'A timeline has a reporting gap: represent the gap explicitly rather than drawing an uninterrupted sequence.',
  'One factual answer or a short sequence: use prose or a list. Do not open a canvas merely because the tool exists.',
 ],
};
