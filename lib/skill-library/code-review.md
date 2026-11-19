# Review a code change

Find behavior regressions and missing verification in a local patch with actionable findings.

**What you need:** A readable diff with enough surrounding source and test context.

**Approach:** Read the change against its stated intent and trace edited call sites. Prioritize user-visible defects, lost data, error handling, and unavailable behavior over formatting preferences. Note the triggering condition and likely effect for each finding.

**Check and recover:** Cite file and line where possible and separate confirmed findings from questions. If the diff or target branch was incomplete, state the boundary and what evidence would confirm the highest-risk uncertainty.
