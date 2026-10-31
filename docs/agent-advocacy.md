# Agent advocacy, form completion and browser routing

BLACKICE's interactive, scheduled and delegated agents act on the user's requested outcome. The current harness instructions apply to new and continued conversations with Planning On or Off.

## Carry authorized work through completion

A request to do work includes its ordinary navigation, inspection, editing, form filling, checking and recovery steps. The agent carries that authorization through planning and continuation instead of asking whether to start, proceed or continue. When applying or submitting is part of the requested outcome, the agent completes that action and checks the destination result.

Saved assistant cautions and old approval checkpoints do not create new user requirements. Actual user constraints and real service interactions still determine what can be completed. An uncertain send is reconciled before another attempt; a recoverable tool failure is corrected from fresh evidence.

## Complete forms with available evidence

The agent first uses supplied records, relevant profile information, attachments, established answers and saved task context. It maps equivalent labels and formats, makes ordinary supported inferences, and drafts the strongest truthful response to the actual question.

Routine form-profile questions, including nationality, do not interrupt the user:

| Available evidence or form behavior | Agent action |
| --- | --- |
| The answer is explicitly known | Reuse it without asking again. |
| An unknown field is optional | Leave it blank or use an offered truthful non-disclosure answer. |
| An unknown required field offers a truthful non-disclosure answer | Select that answer and continue. |
| An unknown required field has no usable truthful answer | Complete independent fields and tasks, preserve the unfinished form, and report the precise remaining site requirement without asking the profile question. |

Nationality, citizenship and work authorization are distinct facts. The agent does not derive them from a person's name, address, language or from one another. Completing a form to the best of its ability does not mean inventing an answer.

## Keep agent browsing inside BLACKICE

Task agents use `relay_browser`, BLACKICE's contained browser. They do not connect Chrome, Neo or another external browser when a site, saved plan or recovery suggestion names one. Navigation, sign-in, forms, uploads and retries keep the same route. If the contained browser is unavailable, the agent reports that specific limitation and continues other work.

The task-agent connection gateway applies the contained browser policy during discovery and dispatch, including old requests restored from a saved conversation. Ordinary non-browser integrations remain available. The native provider receives the same browser policy so a missing browser capability does not restore an external browser skill as a fallback.

## Verification

The focused regression suite checks instruction delivery, continued authorization, contained-browser connection routing and preservation of ordinary integrations. The opt-in Luna verification uses fictional profiles and local form fixtures with the actual engine instructions. Its evidence records real model decisions and observed form values; it does not submit a real application or contact a recipient. A passing instruction-wiring test alone is not evidence that a model completed a form.
