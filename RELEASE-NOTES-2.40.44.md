# BLACKICE 2.40.44

Windows test candidate.

- When an older ordinary chat has no recorded Search Other Chats choice, its next reply or retry uses the current Config default. Recorded On and Off choices stay with their chats.
- If the inherited choice is Off, BLACKICE starts a fresh provider session and carries over this chat's saved context. It does not reuse a provider session that may have searched other chats.
- Changing the Config default does not change an active turn, a saved receipt level, or the separate Fresh Task behavior.
