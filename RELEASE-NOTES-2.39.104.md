# BLACKICE 2.39.104 candidate

This candidate combines packed startup history with ordinary browser execution fixes.

- Ordinary browser actions no longer require a legacy task contract or reactivate old execution gates through a saved task-context attachment.
- Stopped connector/native task tabs can be adopted through the shared lifecycle resolver. Active or settling task ownership and uncertain prior effects remain represented; completed actions are not replayed.
- Credential helper forms may include ordinary extra fields and omit autocomplete hints. Unsupported form shapes return actionable pre-dispatch fallback guidance; ambiguous dispatch still reports uncertainty. Checkboxes are not automatically accepted.
- Packed direct-job history keeps raw receipts intact and adds a nullable browser conversation ID to the metadata projection, not the persisted legacy receipt schema.

Qualification at the integrated pre-version source: 424 focused tests passed. The initial failed legacy snapshot assertion is preserved, with a narrowly scoped comparison correction for the added metadata projection. This is not a full-suite pass, installed-profile migration result, live application submission, or performance guarantee. Packaged qualification is tracked separately and must not be inferred from source tests.

No claim is made that all authorization, origin, credential secrecy, or active-task ownership protections have been removed. This release removes the identified legacy browser execution vetoes and form-shape dead ends.

Bundled llama.cpp requires a separate packaged runtime inventory comparison. No user profile, password vault, or live application draft is changed by source qualification.
