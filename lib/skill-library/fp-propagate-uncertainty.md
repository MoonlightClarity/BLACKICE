# Propagate Uncertainty Through Calculations

Determine how uncertainty in inputs affects a derived result. Use this when a calculation looks precise despite uncertain measurements, shared biases, estimated parameters, or nonlinear relationships.

## Primitives

- An interval, standard deviation, confidence interval, and plausible scenario range are different objects.
- Shared error can move several inputs together; independence must be justified.
- Input uncertainty, numerical approximation, and model inadequacy contribute different limitations.

## Procedure

1. Write the measurement or calculation model y = f(x). Include inputs that materially affect the result and define their units.
2. Assign each uncertain input an appropriate representation: supported distribution, standard uncertainty, bounded interval, or explicitly assumed scenarios.
3. Identify dependence, especially shared calibration, common data sources, and coupled constraints. Preserve covariance or joint scenarios where relevant.
4. Select a propagation method. For small perturbations in a smooth model, use sensitivity derivatives and covariance. For broad or nonlinear inputs, evaluate ranges or simulate from a justified joint distribution.
5. Inspect which inputs dominate output uncertainty and whether nonlinearities create skew, thresholds, or impossible values. Keep model uncertainty visible rather than folding it into an unsupported decimal.
6. Report a result with the type and interpretation of its uncertainty. Identify the measurement whose improvement would most reduce decision-relevant uncertainty.

## Worked example

A total combines two measured quantities, each with standard uncertainty two units. If their errors are independent, the sum has variance 2² + 2² = 8 and standard uncertainty about 2.83 units.

If both errors come entirely from the same additive calibration offset, they move together. The total's error is twice that offset, so standard uncertainty is four units. Treating them as independent understates uncertainty.

For a general smooth model, the first-order expression is Var(y) ≈ gᵀΣg, where g contains derivatives with respect to the inputs and Σ is their covariance matrix. This approximation needs checking when uncertainty crosses a threshold or the function is strongly curved.

## Check and output

Produce the calculation model, input uncertainty types, dependence assumptions, propagation method, output uncertainty, and dominant contributors. Check units and whether the reported interval has the stated meaning. When simulation is used, record the joint input model and assess numerical stability.

## Failure boundary

Do not apply root-sum-of-squares to arbitrary bounds or correlated inputs. More repetitions cannot remove a common systematic offset. A mathematically correct uncertainty calculation remains incomplete when an important mechanism or input is absent from the model.

## Reference

- NIST TN 1297, covariance and uncertainty propagation: https://www.nist.gov/pml/nist-technical-note-1297/nist-tn-1297-appendix-law-propagation-uncertainty
