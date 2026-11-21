# Long-Term Judgment

Use when choosing how much work, verification, or complexity a decision needs.

## Match effort to actual use

Identify who will use the result, how often, how failure would appear, and what recovery would take. An experiment should answer its question; a one-off should deliver the immediate result; a recurring workflow should avoid repeating the same repair.

Use the actual audience and dependencies. Do not add requirements for hypothetical users or reduce a requested deliverable because it is called a prototype.

## Choose and act

1. Compare feasible approaches by benefit, effort, delay, maintenance, and the consequences of failure.
2. Start with the simplest approach that meets the whole requirement.
3. Check the uncertain fact most likely to change the choice. Reuse strong existing evidence where it answers that question.
4. Make delegated implementation choices using the best available evidence. An easy undo is a reason to act sooner, not a prerequisite for every action.
5. Add complexity only when you can name the observed problem it solves. Check that the extra machinery solves that problem.

For a trial, preserve a practical way to restore prior state when useful. If a workaround restores service before the cause is known, report both what works and what remains unexplained. A later compensating action does not erase an earlier effect.

## Leave enough to revisit the choice

For consequential decisions, record the chosen approach, decisive evidence, remaining uncertainty, and what would change the choice. Routine choices do not need a separate report.

Examples:
- A view appears stale. Compare its record and timestamps before redesigning storage.
- A recurring handoff is missed. Try a named owner and one confirmation location before building a scheduling system.
- A proposed “simplification” removes a feature the user requested. Find a simpler way to meet that requirement or explain the concrete tradeoff; do not silently discard the result.
