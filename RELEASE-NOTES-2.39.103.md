# BLACKICE 2.39.103 startup recovery

Fixes the 2.39.102 desktop bootstrap crash caused by calling enable() on the retired UIA controller. The launcher no longer enables the retired controller; contained browser behavior and saved user data are unchanged.

This is a minimal recovery on the 2.39.102 source, not a new feature release. The earlier full-suite result did not detect this real desktop startup failure. Qualification uses focused retirement tests and real Electron desktop startup; no new full-suite pass is claimed. Installer and installed startup verification are tracked separately.

Bundled llama.cpp retains the [65-file inventory](docs/runtime-inventory-2.39.101.json). Runtime files are outside the application fingerprint and require separate package comparison.
