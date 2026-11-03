# BLACKICE 2.39.8 — Windows installer compatibility

This patch release updates the Windows installer toolset after the 2.39.7 Setup failed to launch on a Windows 11 host with an “Illegal System DLL Relocation” error.

## Windows installer

Windows Setup is now built with the pinned NSIS 3.12 bundle from electron-builder. The legacy NSIS 3.0.4.1 bundle used by 2.39.7 is replaced. A test installer using NSIS 3.12 opened successfully on the affected host; the release workflow will also verify the final installer before publication.

The application runtime and per-user install behavior are unchanged. Existing BLACKICE data and profiles remain in place during an update.
