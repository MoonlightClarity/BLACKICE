# Validate Models Against Their Intended Use

Determine whether a mathematical, statistical, computational, or explanatory model is adequate for the decision it will support. Use this when good fit, passing examples, or successful execution is being treated as complete validation.

## Primitives

- Verification asks whether an implementation matches its specification; validation asks whether the model serves the intended use.
- Fit to used data differs from prediction on new cases.
- Model errors can arise from implementation, measurement, parameter estimates, missing structure, or changed conditions.

## Procedure

1. Define the intended use, target conditions, required outputs, and errors that would change the decision. Choose meaningful acceptance observations.
2. Check basic implementation behavior with known cases, units, limiting cases, or simulated data whose generating process is understood.
3. Inspect model assumptions and compare predicted patterns with observed ones. Look for systematic residuals, impossible outputs, and failure concentrated in a meaningful subgroup.
4. Evaluate on cases not used to select or tune the model, preserving relevant grouping and time order. Avoid information leakage through preprocessing, repeated cases, or adaptive selection.
5. Compare against a useful baseline and quantify uncertainty in the difference. Test the deployment conditions that materially differ from the evaluation.
6. Repair the identified failure or restrict the supported use. Report the evidence that passed, the limitations that remain, and the next task action justified by the result.

## Worked example

A runtime estimator predicts execution time from input length. It matches short examples but underestimates long requests. Inspection shows a second phase whose cost increases differently with length.

First verify that timestamps measure the same start and end events. Then compare residuals across input sizes. Add the missing term only if its mechanism and data support it. Reserve new long examples for checking the revision rather than reporting the tuning examples as fresh validation.

If the revised estimator predicts isolated requests well, it still may not predict concurrent load. Validate that use separately when concurrency affects the actual decision; do not claim every deployment regime from one successful setting.

## Check and output

Produce intended use, baseline, evaluation cases, observed errors, uncertainty, supported scope, and remaining limitations. Distinguish a bounded demonstration from a measured generalization claim. Check that the final evaluated artifact is the one being delivered.

## Failure boundary

Validation is not an invitation to endless testing. Run checks that address the intended use or a concrete remaining risk, then act. A model can be useful despite imperfection, but its usefulness must be judged against the user's outcome rather than a convenient score.

## Reference

- Gelman and colleagues, model construction, checking, and validation: https://sites.stat.columbia.edu/gelman/research/unpublished/Bayesian_Workflow_article.pdf
