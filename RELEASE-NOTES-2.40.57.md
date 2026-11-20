# BLACKICE 2.40.57

Windows test candidate.

- The desktop browser now passes an observed upload input's page binding through its browser router. This lets the desktop app use the same guarded upload path as the contained driver. A stale or mismatched reference still fails before file use; chooser and submit behavior is unchanged.
