# Balance Stocks, Flows, and Residuals

Account for where a quantity came from and where it went. Use this when totals disagree, work disappears between stages, or a process claims success without reconciling its inputs and outputs.

## Primitives

- A stock is measured at a time; a flow accumulates across an interval.
- Closing stock equals opening stock plus additions minus removals, with explicit production, destruction, and reclassification where applicable.
- An unexplained residual is a finding to investigate, not a category named “other” that resolves itself.

## Procedure

1. Choose the counted entity and unit. Separate unique tasks from attempts, money from transactions, and physical objects from references to those objects.
2. Define opening and closing times and a common boundary. Record opening stock, closing stock, and all known flows during that interval.
3. Write the accounting identity before inserting values. Include creation, consumption, conversion, duplication, cancellation, and category transfers only when the process actually permits them.
4. Calculate the residual. Test clock mismatches, duplicate identifiers, different filters, delayed recording, and cross-boundary transfers before blaming arithmetic.
5. Reconcile at a finer level using stable identities or subaccounts. Match each transfer's departure and arrival where possible.
6. Report the balanced result or unresolved residual with the evidence needed to settle it. Use the reconciliation to identify the next concrete repair.

## Worked example

A queue starts with 100 unique tasks. Fifteen new tasks arrive, 80 complete, five cancel, and ten fail permanently. Expected pending stock is 100 + 15 − 80 − 5 − 10 = 20.

The dashboard reports 25 pending. Inspection finds that five failed tasks were returned for retry, so “fail permanently” was the wrong classification. Those five failures were attempt outcomes, not task removals. Correct task accounting is 100 + 15 − 80 − 5 − 5 = 25.

The numerical discrepancy exposes a semantic bug: attempts and unique tasks were mixed. Increasing a display counter would hide the error. The correct repair distinguishes task state from execution-attempt history.

## Check and output

Produce the identity, interval, units, reconciled categories, and residual. Check that categories are mutually exclusive where summed and collectively cover the intended population. For transformations, show conversion factors and any yield or loss term.

## Failure boundary

Do not assume every quantity is conserved. Information can be copied, task attempts can multiply, and value can be created or lost. Apply conservation only where justified; otherwise use explicit production and destruction. A zero residual does not prove records are correct if equal errors cancel.

## Reference

- W3C, provenance relationships for generation and derivation: https://www.w3.org/TR/prov-primer/
