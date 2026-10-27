# BLACKICE 2.35.3 — Planning ontology and current source convergence

## Planning
- Introduces separate **analytical process** and **technical execution** lanes in the saved Planning view. The lanes are projections of actual recorded work; older or untyped actions remain visible instead of being classified by guesswork.
- Adds typed analytical questions, hypothesis tests, evidence evaluations, comparisons and judgments, distinct from technical methods, operations and verification.
- Extends text-native intelligence plans with Analysis and Technical Methods entities, typed references and validation of missing links.
- Generates intelligence project tasks from the analyst's authored collection, analysis and proposed-judgment entries rather than forcing six predefined workflow stages. An authored judgment requires its own evidence review; neither a completed command nor a completed collection task makes it true.
- Keeps source attribution, contradictory evidence, unresolved gaps and explicit real dependencies in the expected work and acceptance criteria.
- Normalizes the Planning surface to a neutral dark palette, with long-label wrapping and bounded source, map, and inspector regions.

## Workspace and source
- Native Applications remains retired while the virtualized-desktop approach is deferred until new hardware is available. No application-specific Windows reparenting or Excel startup work is exposed in the interface.
- Consolidates current installed runtime improvements and the prior Chat uploaded-file-label fix into the distributed source tree.
- Pins the published compatible `@peculiar/asn1-schema` 2.11.1 development dependency because the previously locked 2.12.0 tarball is not available from npm; the override is limited to build tooling.

## Validation and limits
- The release must be built from the committed source and pass its existing Windows installer, integrity, and verification requirements before public publication.
- Planning test coverage includes the ontology's non-implication rule: technical completion is not an analytical judgment; this is a data-model and workflow check, not proof that every model-produced assessment is correct.
- Automated testing cannot guarantee domain reasoning quality. Analysts should inspect real source grounding and the usefulness of the resulting conclusions on complex documents.
