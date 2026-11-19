# Diagnose a software bug

Find where a software behavior first diverges using a focused reproduction and evidence.

**What you need:** Relevant source, logs, or a runnable local repro; test access helps but is not required for an evidence-limited diagnosis.

**Approach:** Record expected versus observed behavior and pick the smallest signal that distinguishes likely causes. Trace inputs, state, and outputs around the first divergence; change one variable at a time when helpful. A symptom alone is not a diagnosed root cause.

**Check and recover:** Confirm a suspected cause against a discriminating observation. If you cannot run or reproduce the issue, report observations, remaining hypotheses, and the next probe instead of claiming a fix.
