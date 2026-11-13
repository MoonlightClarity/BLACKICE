# BLACKICE 2.39.88

## Conversation-owned browser tab cleanup

- The Browser workspace has a **Close All Tabs** button. A person can close all ordinary contained-browser tabs with one action, including Personal and conversation-associated tabs. The dedicated ChatGPT calling tab is excluded.
- **Archive** and **Move to Trash** close only tabs attributed to that conversation, including tab ownership retained from older turns in the same saved conversation family. Tabs belonging to other conversations and Personal tabs are preserved.
- Ordinary task completion no longer automatically closes an agent's browser tabs. The conversation retains them for review and continuation until an explicit browser close, Archive, or Trash action.
- Closing is serialized with browser ownership transfers. Archive/Trash saves the conversation state first and reports any tab-close failures separately; the saved conversation change is never falsely reported as rolled back.
- Chat and task management surfaces report when an archived/trashed conversation has tabs that could not be closed.

## Verification and limits

- Regression suites cover browser tab ownership, closed calling-chat exclusion, archive/trash scoping, repeated close-all, incomplete closes, task retention and chat/task lifecycle. Tests use isolated synthetic browsers and do not close the user's live tabs.
- Source changes alone do not establish a published installer or installed update. Windows packaging, source fingerprint, exact candidate, installer and installed-instance verification are separate release gates.
