# Recover Idempotent Effects

Recover an API request after a timeout or interrupted response. Separate an uncertain committed effect from transport failure, reconcile the original intent, and prevent duplicate effects when deciding whether to retry.

## Primitives

Separate user intent, request identifier, authorization or session scope, payload, durable job identity, remote effect, and local observation. Classify the effect as confirmed absent, confirmed present, still pending, or unresolved. An idempotency key belongs to an API-defined scope and retention period; the same text is not universally the same request.

## Procedure

1. Retain the original request identity and exact arguments before dispatch. Record any returned job or resource identity. Reuse the authorization already supporting the task.
2. After uncertainty, inspect the original durable receipt or authoritative resource state. Prefer a receipt tied to the intent over a broad search that might find another actor's similar resource.
3. If the original job is pending, follow it to settlement while continuing independent work. Cancellation is a request to stop; verify which effects completed before it took effect.
4. Retry with the same key and payload only when the API's idempotency contract applies to the same scope. A changed payload represents a new operation or requires the API's specified update semantics.
5. If scope changed or deduplication expired, reconcile the original effect before a new mutation. Obtain evidence that a late original write cannot still arrive when that race matters.
6. When the effect is confirmed present, continue from that result. When confirmed absent and unable to arrive later, issue the necessary action under the appropriate new identity. Keep the unresolved distinction visible if authoritative evidence is unavailable.
7. Verify the requested external state and account for partial effects, rather than treating a recovered success response as proof of every downstream step.

## Worked example

A document creation request uses intent key K. The server commits the document, but the response is lost. The client times out. Reissuing with a new key K2 can create a duplicate. Reading K's receipt identifies the created document; a supported retry with K can return the same result. If the account or grant changes and K is scoped to the old grant, the client first reconciles the old operation.

## Output and check

Produce an effect ledger: original identity, settlement evidence, existing effects, remaining requirement, and next action. The check is one intended effect with the correct content, not merely one successful client response.

## Failure boundary

Identical payloads can represent two legitimate intended operations. Deduplicate by the supported intent contract, not by guessed similarity. Do not turn every read timeout into a user confirmation request, and do not conceal unknown effects by declaring failure and starting again.

## Reference

- [AWS Builders' Library: Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
