# BLACKICE 2.39.71

## Storage & Data

- Opens with a clear summary of measured BLACKICE storage and temporary files, followed by compact rows with plain category names and descriptions.
- Places temporary-file cleanup beside the storage summary so everyday maintenance is easy to find. Cleanup still requires review before it is scheduled, and automatic cleanup remains limited to temporary files.
- Moves deletion of saved data into an expandable section with category descriptions, selected storage totals and explicit confirmation. Saved data is not selected automatically.
- Makes pending cleanup and cleanup history easier to read, including when a cleanup is scheduled to run and what it contains.
- Keeps storage locations and other technical details available on demand, while hiding empty retired categories from the main overview.
- Adds clear loading, empty and error states. A failed refresh keeps the last available measurements and acknowledged cleanup status visible.
- Allows large storage scans up to three minutes and reuses an overview request already in progress when you return to the section, avoiding duplicate scans during navigation.

## Delegation

- Uses the application's default delegation behavior and removes the Subagents and parallel-worker controls from chat and Settings.
- Normalizes retired saved delegation switches for future work while preserving historical run settings.
