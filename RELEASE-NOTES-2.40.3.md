# BLACKICE 2.40.3

## Changes

- Added separate general-browser and job-search skills. Browser guidance covers source selection, purposeful navigation, forms, recovery and outcome verification. Job-search guidance prefers native job-board searches and current employer/ATS routes, using general web search as a supplement.
- Both skills are discoverable and readable through relay_skills and visible in Skills. The agent receives the exact skill IDs and applicability guidance with its attached skills tool; full skill bodies are read on demand rather than inserted into every conversation.
- Bundled procedures are read-only through agent knowledge tools. Users' saved skills remain separate and editable. Package validation and source/build fingerprints include both new files.

## Verification scope

128 focused checks passed with no failures or skips, including real HarnessEngine skill reads and provider request delivery on initial and continued turns. These deterministic fixtures prove discoverability and delivery, not that a live model will always select or follow the skills. Full Windows source and installer verification are recorded separately.

## Limitations

No live applications were submitted and no real-world job-search throughput improvement is established. This release does not include a startup-performance change. Publication and installation are distinct; this note is not an installation receipt.
