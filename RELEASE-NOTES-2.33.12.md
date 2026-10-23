# BLACKICE 2.33.12: composer layout and bulk chat management

This update addresses two issues found by dogfooding the installed 2.33.11 UI. It does not change saved schedule definitions, provider credentials, the run engine, or the underlying Windows/contained-browser capabilities.

## Changes

- Composer actions **Save for later**, **Prompts** and **Attach** now have icon-only footprints (38px normally; 34px in narrow windows), accessible names, and hover tooltips. The Send/Stop controls remain on the same nonwrapping flex row. This avoids the old 36px square widgets rendering multi-word labels below the composer.
- Chat sidebar now offers **Select** mode with native checkboxes and **Select visible**, scoped strictly to the current view/filter/search rather than hidden chats.
- Bulk **Archive**, **Restore** and **Move to Trash** reuse the existing per-conversation, reversible archive operations and preserve selected-chat drafts.
- Moving to Trash requires explicit inline confirmation and is refused for any selected running or unsettled chat. No permanent deletion is introduced.
- Selection is guarded against changed run identity and archive state. Batch calls are single-flight; the UI reports partial failures and keeps failed items selected for an explicit retry. Changing filter/search clears selection, and while a bulk change runs those controls are disabled.
- Context-sensitive actions hide unrelated buttons in archived and Trash views. The old single-chat menu remains available outside selection mode.
- The new bulk-selection module and stylesheet are explicitly served by the local HTTP asset allowlist; the production import graph and both asset responses are covered by integration tests.

## Verification

Focused conversation, menu, sidebar, visual-system, source and persistence tests passed. Headless Chrome DOM geometry checks at approximately 504–1502 CSS-pixel viewports confirmed one composer action row, no clipping, and accessible icon labels, including with Undo visible. A narrow-window fallback for visible Stop and Send controls is covered by source regression checks; real-browser measurements below 504 CSS pixels have not been confirmed.

As with 2.33.11, packaging prepares a separate unsigned Windows Setup candidate and never publishes it. Use the normal registered Setup installer to update the application. Existing BLACKICE profile data is preserved by the installer; keep verified backups of important runs and settings before significant maintenance.
