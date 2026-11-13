# BLACKICE 2.39.73

## Browser tabs by conversation

- Separates Personal tabs from AI-owned tabs. Personal tabs stay outside conversations, including pages opened manually while an AI conversation is selected.
- Filters AI tabs by saved conversation, with conversation names and tab counts. The current conversation is selected when available; all conversations and unassigned AI tabs remain accessible.
- Adds a Move to control for transferring a page to another saved conversation or back to Personal. Conversations with no existing browser tabs are valid destinations.
- Moves the existing page and its related popup branch without reopening or navigating it. Tab identity, the current document, browser history, and in-progress page state remain intact.
- Keeps transferred conversation tabs available to later turns and workers in that conversation. Prior per-turn owners are grouped under their saved conversation, and ownership survives browser restoration.
- Remembers the selected tab independently in Personal, All AI, Unassigned AI, and each conversation, so switching views returns to the page you were using. Updates the destination view after a move on both native and preview surfaces.

## Browser tools and reliability

- Lets direct browser tools use an explicit saved conversation context while preserving existing connection-owned tabs for reassignment.
- Carries conversation ownership through credential operations and cleanup so a later turn can continue working with the right pages.
- Rechecks the observed page and destination before applying a queued move. A closed or changed page, or a conversation moved to Trash while waiting, leaves the original ownership unchanged.

Behavioral coverage includes conversation filtering, transfers into empty conversations, Personal and AI separation, popup branches, later-turn access, persisted ownership, stale-page rejection, and queued destination changes. The release workflow binds the Windows source-suite result and installer verification to this exact version.
