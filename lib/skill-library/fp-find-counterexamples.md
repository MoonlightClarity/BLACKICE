# Find Minimal Counterexamples

Search for a concrete case where a broad claim fails, then use that case to improve the result. Apply this to algorithms, explanations, policies, mathematical assertions, and claims that something always works.

## Primitives

- One valid counterexample refutes a universal statement over the case's domain.
- A case outside the stated domain does not refute the claim, though it may expose an unsuitable boundary.
- A statistical claim such as “usually” requires a frequency or distributional assessment, not just one exception.

## Procedure

1. Write the claim with its quantifier and domain. Identify the conditions it assumes and the property it promises.
2. Search cases near boundaries or interacting assumptions: empty inputs, duplicated identities, delayed messages, simultaneous actions, extreme ratios, and changed order.
3. Construct a complete example with actual values or an explicit event sequence. Derive why it satisfies the premises and violates the conclusion.
4. Minimize the example by removing irrelevant elements while retaining the failure. This helps locate the mechanism and creates a useful regression case.
5. Determine whether the repair is a changed mechanism, an additional valid condition, or a narrower claim. Preserve the user's required behavior when choosing the repair.
6. Recheck the repaired claim against the counterexample and a representative ordinary case. Look for a new failure only when a concrete unresolved risk remains.

## Worked example

Consider the claim “if a request times out, it had no effect.” Construct this event sequence: a server receives a request, commits its change, sends a response, and the response is lost before reaching the caller. The caller times out even though the effect occurred.

No complicated distributed system is required; one committed change and one lost response refute the universal claim. The repair is to distinguish receipt of a response from occurrence of an effect. Use an operation identity and inspect the original result or state before deciding how to recover.

This counterexample does not imply that every timeout committed a change. It establishes that timeout alone cannot determine which state occurred.

## Check and output

Produce the precise claim, minimal case, valid premises, violated conclusion, and practical repair. Check the case against the real specification instead of an easier invented version. Retain enough detail for another operator to reproduce the contradiction.

## Failure boundary

Do not use contrived cases outside the user's actual requirements to derail a useful solution. A counterexample should expose a relevant mechanism or scope issue. Conversely, do not discard a valid inconvenient case by silently rewriting the requirements after the failure.

## Reference

- Lamport, finite models and invariant violations: https://lamport.azurewebsites.net/tla/tutorial/session6.html
