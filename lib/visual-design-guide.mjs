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
  "intent": "Make the visual the user requested. For art, follow the subject and style; for data or analysis, show supported information; for a mockup, show the relevant task and state. Use an optional visual when its spatial form helps the reader understand the answer.",
  "composition": [
    "Supply an accessible title and an accurate summary. Visible headings, legends and notes depend on the brief and surrounding presentation.",
    "Align comparable information. Use a table for exact lookup and connectors when the relationship itself matters. Label a connector with its actual meaning.",
    "Distinguish observations, assumptions, uncertainty and missing information. Appearance alone does not establish confidence, causation or evidence strength.",
    "Choose color, type, framing and spacing from the user's references or a coherent design choice. The tool does not require BLACKICE colors, a particular illustration style or a fixed layout.",
    "Choose composed items for editable simple relationships, custom SVG for deliberate geometry, or regions when both help. Reserve room for complete labels and check the intended display size."
  ],
  "custom": "Author a complete static SVG with explicit dimensions and viewBox, or a static region within a composed document. Use the supported local shapes, text, groups and gradient paints described in constructionBudget. The parser rejects executable behavior, external resources, CSS, filters and reusable references. Custom graphics preserve source; their individual shapes have no inferred semantic editing model.",
  "review": "Use preview to inspect the rendered result. Check the requested content, intended size, text fit, clipping and important visual relationships. Repair a visible defect and check the change. Read the current artifact and revision before editing saved work. When image inspection is unavailable, distinguish that from successful compilation.",
  "examples": [
    "Several reports share one source: show that shared dependency instead of counting each report as independent evidence.",
    "Two explanations fit one observation: align their different predictions and the evidence needed to distinguish them.",
    "A timeline has a reporting gap: label the gap instead of implying continuous observation.",
    "A requested illustration or mockup: use the appropriate subject and style chapter; the analytical examples are optional."
  ]
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
