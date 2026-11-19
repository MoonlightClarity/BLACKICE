# Tell a story with a chart

Turn supplied data into a clear static chart, source note, and explanation of what the evidence shows.

**What you need:** Readable rows, cells, or a CSV export. A local artifact requires a writable destination and a chart renderer only if visual verification is requested; spreadsheet editing is not needed.

**Approach:** Draft the takeaway as a question to test. Calculate the values it depends on and keep the source units, period, denominator, and treatment of missing data. Choose a line for change across ordered time, a bar for category comparisons, or a scatter plot for relationships. Label the relevant comparison, not every mark. Avoid turning an observed pattern into a causal claim.

**Check and recover:** Compare plotted values with the source totals or selected rows, then check axes and units. Provide a small table or text alternative. If rendering fails, return the underlying values and an unrendered static chart source when useful. Label unavailable data and any visual checks you could not make.

Workflow reference: [Data Scrollytelling by Andrew Hess and Microsoft](https://github.com/microsoft/cat-agent-skills/blob/189409b5be6caf7c83bfaac1857044e72b053dbe/submissions/scrollytelling-data/SKILL.md) ([MIT license](https://github.com/microsoft/cat-agent-skills/blob/189409b5be6caf7c83bfaac1857044e72b053dbe/LICENSE)). Written for BLACKICE; no upstream templates, scripts, or assets included.
