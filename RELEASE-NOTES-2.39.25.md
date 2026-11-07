# BLACKICE 2.39.25

Error display and model-switch recovery update on the verified 2.39.24 installed runtime.

- Saved provider, model, tool and runtime errors appear inline in Chat.
- A settled failed run can continue even if the agent did not reach its terminal state.
- Selecting a different API model opens a fresh provider session while retaining saved chat history and attribution.
- Active work is never treated as a safe stopped run.

The installer retains the installed 2.39.24 runtime modules and applies only the verified hotfix. No unrelated feature was replaced.
