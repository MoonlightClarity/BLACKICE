# Map an unfamiliar code path

Trace an input through handlers, state, and output in an unfamiliar repository.

**What you need:** A readable repository or relevant excerpts; runtime logging is optional.

**Approach:** Start from an observed label, symbol, or error and find the entry point. Follow registered handlers, service boundaries, state writes, and read-back paths. Separate declared capabilities and settings from executed code.

**Check and recover:** Give a short file-and-symbol map and label where runtime evidence ends. If a dynamic dispatch or external service obscures a step, name the fastest trace or focused test that would resolve it.
