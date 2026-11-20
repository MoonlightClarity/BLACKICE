# BLACKICE 2.40.31

Windows test candidate.

- Config saves defaults for Directory, Planning, and Search Previous Chats. Existing conversations keep their values.
- New chats use Maximal receipts. Chat no longer has a depth picker; saved receipt levels and machine-readable export remain available.
- Once the event history is full, appending events trims old auxiliary entries without reserializing the whole timeline.
- The browser tool explains how to use authorized signed-in webmail when no mail connector is attached, to check for an earlier send and verify the result of one new send.
- If one delivery route fails, check an alternative when the user asked for a result that another option can deliver.
