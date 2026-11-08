# Receipt alternatives

Development-only canonical contractVersion 2 schema extension. Legacy receiptBinding remains accepted unchanged. A criterion may instead declare receiptBindings with one to eight observed bindings, never both fields. Alternatives share the SAME criterion ID and targetCount. Omit criterion resourceKey when alternatives span resources; each binding resource and owning work-item scope remain explicit. Duplicate normalized binding objects are rejected.

All matching alternatives are extracted and considered together. Conflicting status, prior/new meaning or outcome identity for one effect yields no confirmation; unrelated effects can still progress. Missing, failed or overflowed extraction of a matching alternative is not first-match permission. Fresh consistent observations can resolve uncertainty; this does not erase or reinterpret prior host evidence. Native fact aliases survive selector/format refinements, and changed interpretation of the same retained fact cannot manufacture another effect. Original native repeat guards remain unchanged.

The bounded extraction envelope supports 40 criteria times eight alternatives (320 bindings). Oversized driver requests fail rather than truncating away possible contradictions.

Compatibility is backward-read only: this runtime reads legacy version-2 contracts, but older runtimes with strict version-2 field validation will reject contracts using receiptBindings. Deployment/client schema refresh must be coordinated; do not silently strip alternatives or claim unchanged older-client forward compatibility.

Recovery limit: when an initial attempt has no established baseline, an observed structured absent/rejected record is not enough to clear its UNKNOWN claim. A later read time, source version or changed snapshot does not establish that the issuer record was produced after this attempt. The native POST/request-correlated rejection path can establish that link and resolve absence. Other structured formats need a future trustworthy attempt-correlated issuer adapter. Until then retain uncertainty, continue independent work, or use an authorized deliberate occurrence without deleting the earlier claim. Do not require a baseline read merely to permit the initial attempt.

Validation: receipt/model/schema checks passed 79/79; broader legacy runtime, evidence, history and editor regressions passed 144/144. These overlap. See verification/receipt-alternatives-regression.txt and verification/receipt-alternatives-broad.txt. No real submissions or production changes were used.
