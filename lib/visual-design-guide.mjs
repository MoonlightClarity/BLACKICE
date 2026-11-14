import {VISUAL_PREVIEW_FEEDBACK} from './visual-preview-feedback.mjs';
import {SVG_DRAWING_GUIDE,SVG_CONSTRUCTION_PATTERNS} from './visual-drawing-guide.mjs';
import {SVG_CRAFT_FOUNDATION,SVG_CRAFT_CHAPTERS} from './visual-craft-guide.mjs';
import {SVG_DESIGN_CHECKLIST} from './visual-design-checklist.mjs';
import {SVG_GENERAL_EXAMPLES,SVG_CRAFT_EXAMPLES} from './visual-craft-examples.mjs';
import {VISUAL_DESIGN_EXAMPLES} from './visual-design-examples.mjs';
// Retrieved with describe, rather than inserting the complete design guide in every turn.
export const VISUAL_DESIGN_GUIDE = {
 imageFeedback:VISUAL_PREVIEW_FEEDBACK,
 foundation:SVG_CRAFT_FOUNDATION,
 drawing:SVG_DRAWING_GUIDE,
 construction:SVG_CONSTRUCTION_PATTERNS,
 intent: 'Create a purpose-built SVG for the requested subject: artwork, a game asset, a data graphic, a UX study, an explanatory illustration or an analytical figure. The foundation teaches general drawing. Analytical drawing defaults belong to the analysis chapter, not every creative brief. A requested artwork or design does not need an analytical justification. Each example teaches construction, not a template to rename. For unsolicited figures, first identify what the reader gains over prose.',
 composition: [
  'Keep an accessible title and a concise analytical takeaway as the summary. A visible heading is optional; omit it when the surrounding response already introduces the figure. State uncertainty in words. Visual polish is not evidence.',
  'Arrange comparable explanations in aligned columns; align observations across them when comparison matters. Use a grid for exact evidence comparisons. Use links only when the relationship itself needs inspection; write meaningful verbs on them.',
  'Separate observations, assumptions, claims and missing evidence through explicit labels. Do not assign confidence, scores, causal direction or evidence strength from appearance or position.',
  'Compose groups, statements, comparisons, notes and custom regions around the question. A useful figure may be a table with a small causal inset, an uncertainty spectrum, a timeline with missing intervals, or a claim with competing explanations. Do not force every problem into boxes and arrows.',
  'Match BLACKICE in chat: charcoal and gray surfaces, readable sans-serif type and restrained blue-gray accents. Avoid large bright fields, saturated fills and ornamental framing that compete with the answer. Generated composed previews already receive a subdued chat palette; custom SVG keeps your authored colors, so choose them deliberately. Light backgrounds are appropriate for a print-style export. Use ample whitespace and aligned headings. Prefer short readable phrases, with qualifications in a note. Keep full text alternatives. Color must have a stated meaning or remain decorative.',
  'Author a custom SVG when deliberate typography, alignment, emphasis or spatial form carries the argument. The composed helpers are conveniences for simple editable relationships, not the default visual style. Avoid generic goal/evidence/action flows, identical rounded boxes, ornamental arrows and oversized empty canvases. Three renamed boxes are not a finished analytical figure.',
  'Use the concrete drawing rules below, not a slide layout. Prefer 16-unit labels and 14-unit annotations; an optional visible heading is 18-20 units. Use sentence case, open alignment and one restrained accent. Omit all-caps kickers, subtitle stacks, decorative cards and automatic footers. Never invent numbers to fill a design.',
  'Start with a readable canvas; design its geometry around the argument; automatic placement is only a convenience for simple relationship sketches. For deliberate placement reserve space for complete labels, uncertainty suffixes and legends. Keep meaningful text at least 14 SVG units, do not squeeze text to fit, and check the displayed size. Split an overfull figure.',
 ],
 custom: 'For a purpose-built figure, author a custom static SVG or a custom region instead of forcing the example layout. For example, a two-axis uncertainty field needs named axes/endpoints and positioned observations; a temporal comparison needs a common scale and explicit unknown intervals. Use simple rect/line/path/polygon/text elements, explicit dimensions and viewBox, local presentation attributes, and a complete summary. No scripts, external images/fonts, CSS, references, filters or HTML. Draw arrowheads directly with path segments rather than marker URLs. Wrap construction fragments in an SVG with explicit dimensions, viewBox and font family; adapt the coordinates to the actual evidence. Custom graphics remain source-editable; do not promise object-level semantic editing.',
 review: 'Review against the brief: recognizable form and intentional style for art; correct scales and evidence for data; task hierarchy and realistic states for UX; supported relationships for analysis. Call preview with the unsaved document before create/revise. Inspect the image as well as diagnostics: warning-free is not good design. Check intended size, silhouette, reading order, text fit, spacing, contrast and accidental overlaps. Simplify or recompose rather than shrinking text. For unsolicited explanatory figures reject decorative text slides; for requested art, visual expression is the purpose. Diagnostics cannot judge all graphic overlaps, aesthetics or truth. If preview is unavailable do not claim inspection. Read current revisions before changing user work. Prefer plain text for simple factual answers rather than adding an unsolicited figure.',
 examples: [
  'Three reports repeat one source: show the shared source and its dependent reports, not three independent evidence votes.',
  'Two explanations fit: align what each predicts, show the shared observation once, and identify the observation that would distinguish them.',
  'A timeline has a reporting gap: represent the gap explicitly rather than drawing an uninterrupted sequence.',
  'An explicit visual test deserves a meaningful demonstration, such as shared dependence or missing coverage. Do not respond with generic advice about asking better questions.',
  'One factual answer or a short sequence: use prose or a list. Do not open a canvas merely because the tool exists.',
 ],
};

export const VISUAL_GUIDE_FOCUSES=['general','illustration','data','ux','analysis'];
export function visualDesignDescription(focus='general'){
 if(!VISUAL_GUIDE_FOCUSES.includes(focus))throw Object.assign(new Error('Unknown SVG guidance focus.'),{code:'VISUAL_INVALID',status:400});
 const topics=Object.fromEntries(Object.entries(SVG_CRAFT_CHAPTERS).map(([key,value])=>[key,value.purpose]));
 const general={imageFeedback:VISUAL_PREVIEW_FEEDBACK,intent:VISUAL_DESIGN_GUIDE.intent,foundation:SVG_CRAFT_FOUNDATION,review:VISUAL_DESIGN_GUIDE.review,
  furtherGuidance:'For depth call describe with focus illustration, data, ux or analysis. These are optional craft chapters, not output categories or required templates. Combine techniques across chapters. General guidance is sufficient for other subjects.',topics};
 const checklist={...SVG_DESIGN_CHECKLIST,applicableChecks:focus==='general'?SVG_DESIGN_CHECKLIST.applicableChecks:{[focus]:SVG_DESIGN_CHECKLIST.applicableChecks[focus]}};
 return {designGuide:{...(focus==='analysis'?VISUAL_DESIGN_GUIDE:{...general,...(focus==='general'?{}:{craft:SVG_CRAFT_CHAPTERS[focus]})}),checklist},
  examples:focus==='analysis'?VISUAL_DESIGN_EXAMPLES:focus==='general'?SVG_GENERAL_EXAMPLES:SVG_CRAFT_EXAMPLES[focus]};
}
