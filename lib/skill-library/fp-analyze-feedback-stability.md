# Analyze Feedback Stability

Analyze control feedback loops for stability, gain, delay and saturation. Derive closed-loop dynamics, identify when corrective action becomes unstable, and test the assumptions behind a stable operating range.

## Primitives

Identify the plant or process, state, measured output, target, controller, actuator, disturbance, sampling interval, delay, and saturation. Separate the sign of feedback from the complete closed-loop dynamics. A controller that acts in the apparently corrective direction can still be unstable when gain or delay is inappropriate.

## Procedure

1. Define the state and the quantity to regulate. State which parts are measured directly and which are estimated from observations.
2. Write a minimal dynamic model for the operating region. Distinguish continuous-time and discrete-time equations; their stability conditions differ.
3. Insert the control law into the process model to obtain the closed-loop equation. Analyze the resulting dynamics rather than the controller in isolation.
4. For a scalar discrete linear model x_next = a*x + b*u with u = -k*x, the closed-loop multiplier is a - b*k. Asymptotic stability requires its absolute value to be less than one.
5. Include relevant observation and actuation delays. A command based on an older state adds dynamics and can change the stable gain range.
6. Check actuator limits and accumulated controller state. Saturation can invalidate the linear prediction, especially if an integral term continues accumulating.
7. Compare stability, settling time, overshoot, steady error, and disturbance rejection separately. The fastest nominal response may be fragile to uncertain parameters.
8. Test a small representative disturbance or simulation with the actual sampling and limits. Measure the response and refine the model when observed dynamics disagree.

## Worked example

Suppose x_next = 1.1*x + u. With u = -0.3*x, the closed-loop multiplier is 0.8, so deviations shrink by a factor of 0.8 each step in this idealized model. With k = 2.3, the multiplier becomes -1.2: the sign alternates and magnitude grows. “More correction” has made the system unstable. This calculation assumes immediate feedback and no saturation; a delayed implementation requires a different state model.

## Output and check

Return the process equation, control law, closed-loop dynamics, stability region, and measured response. State the operating region and parameter uncertainty. Identify whether a failure comes from incorrect sign, excessive gain, delay, missing state information, or nonlinear limits.

## Failure boundary

A stable linearization provides a local conclusion, not a guarantee for every state. Observability and controllability constrain what feedback can achieve. Do not apply continuous-time negative-real-part conditions to discrete-time multipliers, or infer robustness solely from a successful nominal simulation. Feedback in social or organizational systems needs an independently justified dynamic model.

## Reference

- [Astrom and Murray: State Feedback](https://www.cds.caltech.edu/~murray/FBS/State_Feedback.html)
