# Draw a concept diagram

Explain a process, relationship, or system with a labeled static SVG and a short text equivalent.

**What you need:** The concept and its intended audience. Delivering an SVG file requires a writable task location; visual checking requires a renderer available in the session.

**Approach:** Choose one relationship to clarify: sequence, hierarchy, comparison, or part-to-whole. Sketch labels and connections before styling. Use readable text and enough spacing, label arrows where direction matters, and distinguish multiple paths by more than color. Keep the SVG standalone with a viewBox and no scripts, remote images, or font dependencies.

**Check and recover:** Check that each arrow corresponds to a real relationship, labels fit at the intended size, and the drawing has a readable title and text equivalent. If you can save but cannot render it, say that visual layout is unverified. If saving fails, provide the SVG source inline; if the input relationships are unclear, provide a labeled text outline.

Workflow reference: [Concept Diagrams by v1k22 and Nous Research](https://github.com/NousResearch/hermes-agent/blob/52811481bc07b18b073790cd2a168a832c92acd7/optional-skills/creative/concept-diagrams/SKILL.md) ([MIT license](https://github.com/NousResearch/hermes-agent/blob/52811481bc07b18b073790cd2a168a832c92acd7/LICENSE)). Written for BLACKICE; no upstream templates, scripts, or assets included.
