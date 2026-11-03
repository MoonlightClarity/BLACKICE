# BLACKICE 2.39.14

## Browser recovery

- Let an agent recover from a batch of stale browser field references after a page changes, instead of ending the run before it can inspect the page.
- Keep browser actions bound to freshly observed controls; failed field fills are not retried or treated as completed applications.
