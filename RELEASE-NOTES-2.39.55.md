# BLACKICE 2.39.55

- Fix Planning evidence validation by making nonempty bounded accuracy fields explicit in the generation schema.
- Report exact nested field paths and bounds when repairing rejected output, including integer and nullable schema variants, while retaining strict validation.
- Show a plan as running only while work is executing. Separate queued, waiting, blocked, completed, and idle plans with clearer counts and status labels.
- Refine the Planning layout, selection, empty states, and task detail hierarchy, with a responsive sidebar that avoids nested scrolling on narrow screens.

Validation uses the complete synthetic Windows source suite and offline replay of previously rejected Planning output. Live provider acceptance is not established by these tests.
