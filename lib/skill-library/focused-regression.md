# Verify a code change

Choose focused regression checks and distinguish verified behavior from untested paths.

**What you need:** A patch or changed files and, for execution, a suitable local test command and dependencies.

**Approach:** Map the edit to user-visible behavior and choose a regression case that would fail before the change if possible. Add the edge most likely to regress, then run the narrowest useful suite and expand only where dependencies or regression risk warrant it.

**Check and recover:** Record actual commands and pass, fail, or skip outcomes. Treat missing dependencies and timeouts as not verified; give a reproducible rerun command and do not infer a release pass from static inspection.
