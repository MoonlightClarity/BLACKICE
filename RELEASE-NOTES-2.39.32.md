# BLACKICE 2.39.32 - Run a saved schedule with one click

- Run now checks a saved schedule when needed and starts one job if it is ready. A disabled schedule stays disabled for future runs.
- If the task needs an answer, BLACKICE shows the question before starting. If a check fails, BLACKICE explains that the schedule is still saved and the job did not start.
- Fixed a strict output format that could cause Codex and OpenAI to reject schedule readiness checks. BLACKICE still validates the full Planning response locally.
- If the readiness check fails while enabling a new schedule, BLACKICE shows the saved draft and keeps future runs off.

The Windows installer updates BLACKICE while keeping its existing profile and schedules.
