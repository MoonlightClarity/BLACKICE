# Draw a concept diagram

Use when a static SVG can explain a process, hierarchy, relationship, or system.

1. Identify the question the diagram should answer and the intended reader.
2. List the required labels and connections. Choose one main relationship to show; split unrelated relationships into separate diagrams.
3. Draw a standalone SVG with a viewBox, readable text, enough spacing, and labeled arrows where direction matters. Use shapes or labels as well as color to distinguish paths.
4. Save it to the requested location. Render and inspect it at the intended size when a renderer is available.
5. Check that every arrow means a real relationship and that all labels fit.

Deliver the SVG and a short text description of the relationship. If rendering is unavailable, report that layout has not been visually checked. If a relationship is uncertain, label that connection as uncertain instead of inventing it.

Example: show a request branching to a cache hit or database lookup, then joining at the response. Put implementation details that do not affect that flow in the accompanying text.

Workflow reference: [Concept Diagrams](https://github.com/NousResearch/hermes-agent/blob/52811481bc07b18b073790cd2a168a832c92acd7/optional-skills/creative/concept-diagrams/SKILL.md) ([MIT](https://github.com/NousResearch/hermes-agent/blob/52811481bc07b18b073790cd2a168a832c92acd7/LICENSE)); adapted for BLACKICE.
