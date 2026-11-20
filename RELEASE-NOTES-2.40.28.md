# BLACKICE 2.40.28

Windows test candidate.

- The execution prompt tells BLACKICE to take the next useful step instead of ending with a status report. It receives the full What Makes Done skill even when planning and Directory are off.
- Model instructions name the action, what to check, and what to try when the check fails. The default SOUL uses plain language; existing custom identities are preserved.
- Goals recognize written dates such as Friday, November 20, 2026 at 6:00 AM EST (11:00 UTC) and reject contradictory clock times or weekdays.
