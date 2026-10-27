// Opt-in outbound delivery for managed operations. Local results are preserved
// independently of remote transmission. No destination masking, host restriction,
// or extra permissions: BLACKICE displays the exact configured HTTP(S) URL.
// The delivery ledger prevents automatic duplicates after ambiguous outcomes.
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

export const MAX_OUTBOUND_ATTEMPTS = 3;
export const OUTBOUND_TIMEOUT_MS = 12000;
const backoffs = [10000, 60000];
const fail = message => Object.assign(Error(message), { status: 400 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 600) => String(value || '').slice(0, limit);

export function deliveryTarget(value, previous = { type: 'local' }) {
  if (value === undefined) return structuredClone(previous || { type: 'local' });
  if (value === null) return { type: 'local' };
  if (!object(value) || typeof value.type !== 'string')
    throw fail('Choose local results or an HTTP(S) webhook destination.');
  if (value.type === 'local') {
    if (Object.keys(value).some(key => key !== 'type'))
      throw fail('Local results do not need a URL.');
    return { type: 'local' };
  }
  if (value.type !== 'webhook' || Object.keys(value).some(key => !['type', 'url'].includes(key))
    || typeof value.url !== 'string' || value.url.length > 2048)
    throw fail('Webhook delivery requires one HTTP(S) URL.');
  let parsed;
  try { parsed = new URL(value.url); }
  catch { throw fail('Enter a valid HTTP(S) webhook URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw fail('Webhook delivery supports HTTP and HTTPS URLs.');
  return { type: 'webhook', url: parsed.href };
}

// The full value is intentionally shown in BLACKICE. Never silently remove
// a path, userinfo, port, query, or fragment from a configured destination.
export function visibleDeliveryTarget(target) {
  if (!target || target.type === 'local') return { type: 'local' };
  const parsed = new URL(target.url);
  return { type: 'webhook', url: parsed.href, host: parsed.hostname, configured: true };
}

export function newOutbound(jobId, target, at) {
  return !target || target.type !== 'webhook' ? null : {
    jobId, destination: 'webhook',
    url: target.url, host: new URL(target.url).hostname,
    state: 'waiting_result', revision: 1,
    createdAt: new Date(at).toISOString(), availableAt: null,
    nextAttemptAt: null, deliveredAt: null, attempts: [],
    error: null, httpStatus: null, outputTruncated: false,
  };
}

export function queueOutbound(job, at) {
  if (job.outbound?.state !== 'waiting_result'
    || !['available', 'acknowledged'].includes(job.delivery?.state)) return false;
  job.outbound.state = 'queued';
  job.outbound.revision++;
  job.outbound.availableAt = new Date(at).toISOString();
  job.outbound.nextAttemptAt = at;
  return true;
}

export function buildOutboundPayload(job) {
  const delivery = job.delivery;
  if (!['available', 'acknowledged'].includes(delivery?.state))
    throw Error('Local result must be available before outbound delivery.');
  return JSON.stringify({
    version: 1, deliveryId: job.id, jobId: job.id, deploymentId: job.deploymentId,
    deploymentName: job.deploymentName, outcome: delivery.outcome,
    createdAt: job.createdAt, finishedAt: job.finishedAt || null,
    runId: delivery.sourceRunId, outputPreview: delivery.preview,
    outputTruncated: delivery.previewTruncated === true, error: delivery.error,
  });
}
export const outboundHash = body => createHash('sha256').update(body, 'utf8').digest('hex');
export const outboundDue = (outbound, now) =>
  outbound && ['queued', 'retry_wait'].includes(outbound.state)
  && Number.isFinite(outbound.nextAttemptAt) && outbound.nextAttemptAt <= now;

export function claimOutbound(job, at) {
  const receipt = job.outbound;
  if (!outboundDue(receipt, at) || receipt.attempts.length >= MAX_OUTBOUND_ATTEMPTS) return null;
  const payload = buildOutboundPayload(job), number = receipt.attempts.length + 1;
  const attempt = {
    number, startedAt: new Date(at).toISOString(), finishedAt: null,
    state: 'sending', id: job.id + ':' + number,
    payloadHash: outboundHash(payload), httpStatus: null, reason: null,
  };
  receipt.attempts.push(attempt);
  receipt.state = 'sending';
  receipt.nextAttemptAt = null;
  receipt.revision++;
  return {
    deliveryId: job.id, idempotencyKey: job.id,
    target: structuredClone(job.definition.deliveryTarget),
    payload, attemptId: attempt.id,
  };
}

export function finishOutbound(job, outcome, at) {
  const receipt = job.outbound, attempt = receipt?.attempts.at(-1);
  if (receipt?.state !== 'sending' || attempt?.state !== 'sending') return false;
  const state = ['delivered', 'rejected', 'retryable', 'unknown'].includes(outcome?.state)
    ? outcome.state : 'unknown';
  const code = Number.isSafeInteger(outcome?.httpStatus)
    && outcome.httpStatus >= 100 && outcome.httpStatus <= 599 ? outcome.httpStatus : null;
  attempt.finishedAt = new Date(at).toISOString();
  attempt.state = state; attempt.httpStatus = code;
  attempt.reason = text(outcome?.reason || (state === 'delivered'
    ? 'Destination accepted the request.' : 'Delivery outcome is unverified.'));
  receipt.revision++; receipt.httpStatus = code;
  receipt.error = state === 'delivered' ? null : attempt.reason;
  if (state === 'delivered') {
    receipt.state = 'delivered';
    receipt.deliveredAt = attempt.finishedAt;
    receipt.nextAttemptAt = null;
  } else if (state === 'retryable' && receipt.attempts.length < MAX_OUTBOUND_ATTEMPTS) {
    receipt.state = 'retry_wait';
    receipt.nextAttemptAt = at + backoffs[receipt.attempts.length - 1];
  } else {
    receipt.state = state === 'unknown' ? 'unknown' : 'failed';
    receipt.nextAttemptAt = null;
  }
  return true;
}

export function cancelUnstartedOutbound(job, reason = 'Schedule removed before external delivery') {
  if (!job.outbound || !['waiting_result', 'queued', 'retry_wait'].includes(job.outbound.state))
    return false;
  job.outbound.state = 'cancelled';
  job.outbound.revision++; job.outbound.nextAttemptAt = null;
  job.outbound.error = String(reason).slice(0, 600);
  return true;
}
export function markLostOutbound(job, at) {
  if (job.outbound?.state !== 'sending') return false;
  finishOutbound(job, {
    state: 'unknown',
    reason: 'BLACKICE stopped during the outbound send. Delivery is unverified and will not be replayed automatically.',
  }, at);
  return true;
}

export function validOutbound(value, jobId) {
  if (!object(value) || value.jobId !== jobId || value.destination !== 'webhook'
    || !['waiting_result','queued','sending','retry_wait','delivered','failed','unknown','cancelled']
      .includes(value.state)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.host !== 'string' || value.host.length > 253
    || (value.url !== undefined && (typeof value.url !== 'string' || value.url.length > 2048))
    || !Array.isArray(value.attempts) || value.attempts.length > MAX_OUTBOUND_ATTEMPTS
    || value.attempts.some((attempt, index) => !object(attempt)
      || attempt.number !== index + 1 || typeof attempt.id !== 'string'
      || !['sending','delivered','rejected','retryable','unknown'].includes(attempt.state)))
    return false;
  if (['queued', 'retry_wait'].includes(value.state) && !Number.isFinite(value.nextAttemptAt))
    return false;
  return true;
}

// DNS/connectivity failures occur before an HTTP request has been sent.
// All other transport exceptions are treated as ambiguous to avoid silent duplicates.
const definitelyUnsent = new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH']);
export async function sendWebhook({ target, payload, idempotencyKey, signal },
  { httpRequest = http.request, httpsRequest = https.request } = {}) {
  let url;
  try { url = new URL(deliveryTarget(target).url); }
  catch { return { state: 'rejected', reason: 'Invalid webhook destination.' }; }
  if (signal?.aborted)
    return { state: 'retryable', reason: 'Outbound request cancelled before transmission.' };
  const request = url.protocol === 'http:' ? httpRequest : httpsRequest;
  return new Promise(done => {
    let settled = false, deadline, req;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      done(result);
    };
    try {
      req = request(url, {
        method: 'POST', timeout: OUTBOUND_TIMEOUT_MS, signal,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
          Accept: 'application/json', 'Idempotency-Key': idempotencyKey,
          'User-Agent': 'BLACKICE-cron-delivery/1',
        },
      }, response => {
        const status = response.statusCode || 0;
        response.resume();
        response.once('end', () => {
          if (status >= 200 && status < 300)
            finish({ state: 'delivered', httpStatus: status,
              reason: 'Destination acknowledged the HTTP request.' });
          else if (status >= 300 && status < 400)
            finish({ state: 'rejected', httpStatus: status,
              reason: 'Destination returned a redirect. No automatic redirect was followed.' });
          else if ([408,409,429].includes(status) || status >= 500)
            finish({ state: 'unknown', httpStatus: status,
              reason: 'Remote endpoint may have processed the request; retry requires manual review.' });
          else finish({ state: 'rejected', httpStatus: status,
            reason: 'Destination rejected the HTTP request.' });
        });
        response.once('error', () => finish({ state: 'unknown',
          reason: 'HTTP response incomplete; delivery may have occurred.' }));
      });
      deadline = setTimeout(() => req.destroy(Error('HTTP delivery deadline exceeded')),
        OUTBOUND_TIMEOUT_MS);
      deadline.unref?.();
      req.once('timeout', () => req.destroy(Error('HTTP delivery timed out')));
      req.once('error', error => finish(definitelyUnsent.has(error?.code)
        ? { state: 'retryable', reason: 'Webhook connection was unavailable before sending.' }
        : { state: 'unknown', reason: 'HTTP send failed; delivery outcome is unknown.' }));
      req.end(payload);
    } catch {
      try { req?.destroy(); } catch {}
      finish({ state: 'unknown', reason: 'HTTP dispatch outcome could not be verified.' });
    }
  });
}
// Historical alias used by early tests and the original scheduler integration.
export const sendHttpsWebhook = sendWebhook;
