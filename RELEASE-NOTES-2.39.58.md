# BLACKICE 2.39.58

- Expose shared Planning lifecycle, canonical contract editing, execution readback, and cancellation through native and direct tool surfaces.
- Permit the seven existing Planning read actions through read-only worker guards while preserving write, run, and cancel restrictions.
- Preserve request identity, saved cancellation outcomes, and evidence-only projections across those surfaces.
- Extend bounded field repair to the two declared scalar families while preserving already-valid values and durable raw/base/merged provenance.
- Include a complete missing-field, enum, and duplicate-member checklist in the existing full-response repair turn, without adding another repair attempt.
- Keep provider-facing Planning metadata canonical and choose the expanded control catalog only when its backing service exists, preserving saved catalog versions.
- Include the Ollama and LM Studio local-model loading support already published on main.
- Correct local-model settings controls and expand shared DOM regression coverage.
- Preserve the shared Planning theme and both refreshed stylesheet URLs.

Release validation uses synthetic and offline fixtures plus the exact Windows source suite. It does not establish fresh live-provider acceptance or automatically run or resume existing user tasks.
