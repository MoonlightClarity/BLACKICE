# BLACKICE 2.39.26 - Browser uploads and Workbench pairing

This update fixes two issues found while an AI agent was actually operating BLACKICE.

## Browser upload fix

- MP4 video uploads use the correct `video/mp4` media type instead of `application/octet-stream`.
- LinkedIn accepted the corrected upload in a real BLACKICE-controlled browser session.

## Workbench pairing and automatic recovery

- The Workbench **Pair & auto-repair** action can set up the dedicated host share account and generate the password without asking the user to do routine credential setup.
- It copies the setup files into the existing Windows VM through Hyper-V, even when `W:` is missing.
- A guest-local helper maps `W:`, starts the guest agent, and automatically reconnects the drive every 15 seconds while the guest is signed in.
- The reconnect helper starts after guest sign-in and resolves the current host after Hyper-V changes its IP address.
- BLACKICE exposes an `auto_pair` agent action and documents the entire workflow in the built-in Workbench guide.

## Tested on the development VM

- The existing Windows VM was preserved.
- A fresh guest agent heartbeat and pairing challenge completed.
- Host/guest shared-folder read and write access worked.
- A guest desktop screenshot was returned through the paired agent.
- We deliberately disconnected `W:`; the watcher remounted it, and BLACKICE stayed paired and ready.
- 95 targeted Workbench and installer regression tests passed, including a test for starting the reconnect helper before `W:` exists.

The released Windows Setup.exe includes the updated source and guest helper scripts. No privacy blurring, video redaction or additional information-protection features were introduced.
