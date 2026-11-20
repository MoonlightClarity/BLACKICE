# BLACKICE 2.40.56

Windows test candidate.

- In Directory runs, batched browser fills and selections wait for the previous response before reserving the next action. A genuinely uncertain effect still blocks subsequent writes.
- An upload can use the observed file input ref without repeating the page ID and URL. BLACKICE uses the ref's original page binding and rejects it before reading a file if the binding is stale. Uploads through a pending file chooser still require both explicit page guards.
- Neither change retries a submission or treats filling or uploading as proof of submission.
