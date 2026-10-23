# BLACKICE 2.33.9: native browser scrolling

This update brings wheel and trackpad scrolling into the contained browser while retaining the focused workspaces and black-ice visual hierarchy introduced in [2.33.8](RELEASE-NOTES-2.33.8.md).

## Scroll the page under the pointer

- Wheel and trackpad gestures over a contained page reach the page itself, including nested scrollable panels.
- Horizontal and vertical movement follow the gesture. The current tab and observed page identity remain checked before input is delivered.
- Directional scrolling remains available for agent tools, including the existing reduced-motion behavior.

## Keep the focused workspace

Chat retains its visible model, reasoning, planning, attachment, Send and Stop controls. Secondary lists, plan editors, workflow maps and advanced settings open when chosen. Planning, Swarms and Schedules remain connected through Change area, with drafts and selection retained during navigation.

Planning names the plan-and-chat scope of Archive and Trash, explains restoration before moving to Trash, and states that step removal saves immediately without Undo. Removing a named group keeps its assigned plans in Ungrouped. Trash retains its existing Restore action.

## Update the installed app

Use the 2.33.9 Setup installer to update the Windows installation. Restarting an older installation alone does not install the new release. The existing per-user profile continues to hold saved conversations, settings and browser sign-ins.

## Verification

Release evidence must identify the exact source commit, application fingerprint and installer SHA-256. Source tests, browser interaction checks and installation receipts are published with the release as those checks complete; this note does not substitute for their recorded results.
