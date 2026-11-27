# Detect Evaluation Leakage

Use this method when evaluation performance may overstate performance on genuinely new cases. Trace what information the model, preprocessing, and experiment design can access, then compare that access with the intended deployment situation.

## Primitives

Define the prediction event, available information at that time, target, unit of independence, training set, validation set, test set, preprocessing fit, and selection process. Independence often belongs to a person, source, document family, event, or time period rather than an individual row.

## Procedure

1. State the deployment question. Predicting a future outcome for a new person requires a different split from predicting another measurement for a known person.
2. Trace every feature to its origin and timestamp. Identify fields created after the outcome, labels embedded in filenames, post-event summaries, and proxies that would be unavailable at prediction time.
3. Search for exact duplicates, near-duplicates, shared templates, related entities, and repeated measurements across partitions. Determine whether those relationships violate the intended generalization boundary.
4. Check where preprocessing is fitted. Imputation, normalization, feature selection, vocabulary construction, and target encoding can transmit information if fitted using held-out data.
5. Inspect model and prompt selection. Repeatedly choosing the best configuration on the test set turns that set into a selection resource, even if no gradient update uses it.
6. Create a corrected split or processing boundary based on the real independence unit and temporal order. Keep a separate untouched evaluation where practical.
7. Rerun the same task and compare failure patterns, not only the headline score. Attribute the score change to the altered boundary only after checking other changed conditions.
8. Record known contamination and uncertainty in imported benchmarks without pretending that absence of an exact match proves complete independence.

## Worked example

A document classifier scores 98% after random row splitting. Several pages from each report appear on both sides, sharing a distinctive header and near-identical text. Deployment concerns entirely new reports. Splitting by report identity prevents the same report from crossing the boundary, and accuracy drops. The earlier score measured recognition of related material more than transfer to new reports.

## Output and check

Produce an information-access map, independence unit, contamination examples, corrected partition rule, and revised result. Include the fit/transform boundary for learned preprocessing. State exactly what population and prediction event the revised evaluation supports.

## Failure boundary

Overlap is not automatically leakage: known-user personalization may legitimately use earlier records from that user. Conversely, removing identical rows does not eliminate semantic duplicates or future information. Keep the boundary aligned with the user's actual task rather than choosing a split solely because it produces the most pessimistic or flattering score.

## Reference

- [scikit-learn: Common pitfalls and data leakage](https://scikit-learn.org/stable/common_pitfalls.html)
