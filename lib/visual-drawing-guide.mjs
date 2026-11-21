// Drawing techniques and an example palette; adapt them to the user's brief.
export const SVG_DRAWING_GUIDE = {
  "canvas": "Choose dimensions for the requested destination and useful content. Give the SVG explicit width, height and viewBox. Derive height from the lowest visible mark or text and its required margin. Preserve a supplied aspect ratio and valid existing geometry.",
  "palette": {
    "background": "#14181e",
    "text": "#d4dbe2",
    "secondary": "#a8b2be",
    "rule": "#414a55",
    "accent": "#9fb8c6",
    "uncertainty": "#c6b99f",
    "quietFill": "#20262d"
  },
  "color": "The palette here is one example for a dark background. Match the requested style or brand. Use consistent colors for equal meanings and support important distinctions with labels or line styles. Keep data coordinates faithful to their values. This SVG profile uses explicit presentation attributes rather than CSS classes.",
  "typography": "Choose an available local font stack and inspect text at its display size. As a starting example at 1:1 scale, 16-unit labels with 20-unit line spacing can be readable. Align comparable text. Use headings and annotations when they help the requested composition.",
  "textFit": "Estimate text width while planning, then check the rendered result. A rough Latin estimate is half the font size per character; CJK, emoji and wide letters can differ. Wrap with positioned text/tspan lines. Reserve padding and descenders. Resolve overflow by reflowing, enlarging or carefully editing the wording.",
  "spacing": "Use common anchors and a spacing rhythm suited to the display size. Leave enough room for text, connectors and their labels. Enclosures should correspond to the intended grouping or visual style. Inspect accidental near-touches and crowded regions.",
  "drawingOrder": "Draw backgrounds and rear regions, then connectors and foreground forms, then labels. Set fill=\"none\" for open stroked paths. Draw arrowheads as explicit path segments because marker references are unsupported.",
  "routing": "Connect the intended objects and avoid unrelated marks and labels. For a cubic from (x1,y1) to (x2,y2), controls (x1,ym) and (x2,ym), with ym midway between y values, provide one starting curve. Adjust it to the actual geometry. Reserve room for labels before routing long connections.",
  "alignment": "Derive repeated positions from shared anchors, for example x(i)=left+i*columnPitch and y(j)=top+j*rowPitch. Compare quantities on common scales or explain scale differences. Use the layout to make the relevant comparison visible.",
  "uncertainty": "Explain hypothetical links, missing observations and intervals with labels. A dashed line can represent a hypothesis if its meaning is stated. Keep a visible gap for absent coverage. Quantitative widths require supported values.",
  "displaySize": "Check the actual display size: a 16-unit label on a 720-unit SVG displayed at 360 pixels becomes 8 pixels tall. Reflow or split content when scaled text is unreadable. Keep an accurate text alternative."
};
export const SVG_CONSTRUCTION_PATTERNS = [
 {purpose:'Shared dependence: merge three paths at one source position. Geometry expresses dependence without three evidence boxes. This is a local construction fragment, not a mandatory layout.',svg:'<g fill="none" stroke="#9fb8c6" stroke-width="1.25"><path d="M 80 32 C 80 64 180 64 180 96"/><path d="M 180 32 L 180 96"/><path d="M 280 32 C 280 64 180 64 180 96"/></g><circle cx="180" cy="102" r="4" fill="#9fb8c6"/><text x="180" y="130" text-anchor="middle" font-size="16" fill="#d4dbe2">One underlying source</text>'},
 {purpose:'Unknown interval: an open bracket expresses the span. The words explain missing coverage, not low confidence in a measured quantity.',svg:'<path d="M 40 52 L 40 62 L 280 62 L 280 52" fill="none" stroke="#c6b99f" stroke-width="1"/><text x="160" y="88" text-anchor="middle" font-size="14" fill="#d4dbe2">No reporting in this interval</text>'},
 {purpose:'Displaced annotation: reserve a separate row for a long label instead of clipping midpoint text or overlapping a relationship.',svg:'<path d="M 44 30 L 44 58 L 68 58" fill="none" stroke="#9fb8c6" stroke-width="1"/><text x="76" y="62" font-size="14" fill="#d4dbe2">Independent confirmation</text><text x="76" y="80" font-size="14" fill="#a8b2be">has not yet been collected</text>'},
];
