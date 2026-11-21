# Map an unfamiliar code path

Use when locating where an input, action, or error travels through a repository.

1. Start from a distinctive error, UI label, route, or symbol. Search the repository for that exact text.
2. Read the entry point and follow the registered handler, direct calls, state writes, and output.
3. Record each step as file + symbol + input/output. Include only boundaries needed to explain the requested behavior.
4. Compare declared settings with the code that reads them. Find the actual runtime selection or dispatch when several implementations exist.
5. Confirm uncertain links with a focused test or existing trace when available.

Return a compact path with the first relevant failure or unanswered boundary. Distinguish source-based inference from observed execution.

Example: button → request handler → saved setting → reload reader → rendered value. If the saved value is correct but reload shows the old value, inspect the read path before changing persistence.
