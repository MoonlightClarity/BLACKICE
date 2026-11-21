# Review a code change

Use when reviewing a patch, pull request, or changed files for defects.

1. Read the requested behavior, diff, and affected callers. Identify the input and output each edited path is meant to preserve or change.
2. Trace the cases most likely to break: missing values, failed operations, repeated requests, persistence, and compatibility with existing callers.
3. For each suspected defect, find a concrete triggering input and the wrong result. Read nearby tests or run a focused check when it can resolve the question.
4. Rank findings by their effect on users. Keep style preferences separate from behavior defects.

For each finding, give the file and symbol or line, triggering condition, observed or predicted effect, and a repair direction. Say when a finding is an inference that still needs a check.

If the patch or comparison branch is missing, inspect the available source and name the exact comparison you could not make. If no defect is found, say which paths you reviewed and which checks ran; that is more useful than a blanket “looks good.”
