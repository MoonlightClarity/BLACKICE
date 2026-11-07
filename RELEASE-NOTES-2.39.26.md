# BLACKICE 2.39.26 — MP4 browser upload fix

This small, versioned update fixes media uploads made by BLACKICE agents through the contained browser.

## Fixed
- MP4 selections now carry the correct video/mp4 media type instead of application/octet-stream.
- This resolves LinkedIn rejecting valid MP4s when delivered through BLACKICE's browser upload tool.
- A regression test covers MP4 metadata and existing image/document MIME mappings.

## Verified
- A real BLACKICE-controlled browser upload delivered an MP4 as video/mp4. LinkedIn accepted it and completed the video post workflow.
- The browser driver change is included in this version's Windows installer and source code.

No new redaction, privacy masking, or information-protection controls are introduced.
