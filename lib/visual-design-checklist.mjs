// Optional checks selected by the current visual brief.
export const SVG_DESIGN_CHECKLIST = {
  "defaultDirection": "Use the user's visual brief and references. When style is unspecified, choose a coherent direction suited to the subject, audience and destination. Flat, dimensional, playful and technical treatments are all available choices.",
  "use": "Apply the checks that can reveal a defect in this deliverable. Keep notes only where they help revision or explain a limitation. A small visual does not need a separate report for every check.",
  "beforeDrawing": [
    {
      "id": "intent",
      "decision": "Identify the artifact, intended size and background, exact content and what the viewer should recognize first.",
      "evidence": "A brief description of the result and any consequential assumption.",
      "repair": "Resolve a missing constraint only when it changes the deliverable; otherwise choose a reasonable default and continue."
    },
    {
      "id": "direction",
      "decision": "Choose shapes, viewpoint, type and surface treatment that fit the brief.",
      "evidence": "Concrete design choices, such as flat shapes with bold outlines or a metal form with visible thickness.",
      "repair": "Compare the result with the requested reference and change the feature that causes the mismatch."
    },
    {
      "id": "structure",
      "decision": "Arrange major forms or content groups before details. Give connected parts consistent anchors and overlaps.",
      "evidence": "The subject or reading order is clear in the main geometry.",
      "repair": "Correct proportions, grouping or overlap before adding detail."
    },
    {
      "id": "color-plan",
      "decision": "Assign colors to materials, content, magnitude, state or decoration. Check them against the destination background.",
      "evidence": "The important regions remain distinguishable and the focal contrast fits their role.",
      "repair": "Adjust the confusing region's color, lightness, label or geometry."
    }
  ],
  "whileDrawing": [
    {
      "id": "construction",
      "check": "Build major geometry, then supporting features. Keep viewpoint, joins and light consistent where those matter.",
      "evidence": "Parts connect convincingly or information groups align as intended.",
      "repair": "Correct the faulty join, proportion or alignment before polishing."
    },
    {
      "id": "craft",
      "check": "Inspect contours, spacing, edge treatment and detail at the intended size.",
      "evidence": "The relevant features and text remain legible without accidental tangencies or clutter.",
      "repair": "Reshape or simplify the affected region and preserve the requested style."
    }
  ],
  "beforeDelivery": [
    {
      "id": "rendered-review",
      "check": "Inspect the rendered image at intended size. For assets, use preview's asset inspection mode when small views, grayscale or background variants help answer a concrete question.",
      "evidence": "Name the visible defect or useful observation, such as a label clipped at the right edge.",
      "repair": "Revise the most consequential defect and inspect the changed result. Thumbnail views are stress tests, not a replacement for the requested asset size."
    },
    {
      "id": "finish",
      "check": "Compare the result with the brief and source content. Preserve requested editable source and an accurate text alternative.",
      "evidence": "The delivered artifact matches the requested content, format and use, with remaining limitations identified.",
      "repair": "Fix the specific mismatch or report what remains. Successful parsing alone does not establish visual or factual quality."
    }
  ],
  "applicableChecks": {
    "illustration": [
      {
        "check": "Form and style",
        "observe": "Does the form match the chosen style? For dimensional subjects, do surfaces and overlaps describe the intended volume?",
        "repair": "Correct geometry or shading where it contradicts the brief; retain flat construction when flat artwork is requested."
      },
      {
        "check": "Recognition",
        "observe": "Can the subject and orientation be identified at the intended size?",
        "repair": "Clarify the main contour or defining feature."
      },
      {
        "check": "Values",
        "observe": "Are important adjacent forms distinguishable, including in grayscale when that check matters?",
        "repair": "Adjust their lightness, spacing or outlines."
      },
      {
        "check": "Material and light",
        "observe": "Do similar materials and light-facing surfaces use a consistent treatment?",
        "repair": "Correct the inconsistent plane, reflection or highlight."
      },
      {
        "check": "Color hierarchy",
        "observe": "Does the region attracting attention fit the requested focus?",
        "repair": "Adjust its area, contrast or surrounding competition."
      },
      {
        "check": "Context and scale",
        "observe": "Do edges and meaningful details survive the intended background and export size?",
        "repair": "Adjust the affected geometry or values and recheck that destination."
      }
    ],
    "data": [
      {
        "check": "Layout",
        "observe": "Are labels, units, ticks and notes readable and aligned without hiding data?",
        "repair": "Reflow annotations or plot margins while preserving the data geometry."
      },
      {
        "check": "Encoding",
        "observe": "Do marks reproduce source values, scale, units, uncertainty and missing observations?",
        "repair": "Correct the source-to-mark calculation before styling."
      },
      {
        "check": "Color meaning",
        "observe": "Does color encode the intended categories or magnitude, with labels or shapes available where needed?",
        "repair": "Remove or explain an encoding that implies unsupported values."
      }
    ],
    "ux": [
      {
        "check": "Task and state",
        "observe": "Can the viewer find the next action and recover from the depicted error?",
        "repair": "Reorder or label controls and show the relevant recovery state."
      },
      {
        "check": "Layout and legibility",
        "observe": "Do groups, long labels and supporting text fit the target viewport?",
        "repair": "Reflow the affected content and check the actual display size."
      }
    ],
    "analysis": [
      {
        "check": "Reading order",
        "observe": "Does the spatial arrangement make the intended comparison or relationship clear?",
        "repair": "Align comparable information or relabel the ambiguous relationship."
      },
      {
        "check": "Evidence",
        "observe": "Can the viewer distinguish observation, assumption, uncertainty and missing information?",
        "repair": "Correct unsupported arrows, precision or continuity; choose prose or a table when that communicates the result more clearly."
      }
    ]
  }
};

export const SVG_ASSET_REVIEW = [
  "Recognition: check the subject and orientation at the intended size.",
  "Values: inspect important adjacent forms and focal contrast; use grayscale when helpful.",
  "Color: check that the visible emphasis matches the brief.",
  "Construction: inspect relevant joins, overlap, viewpoint and lighting.",
  "Destination: check the intended background, export size, clipping and lost detail.",
  "Revision: fix the most consequential observed defect and inspect the changed result."
];
