/**
 * Release-tooling orchestration for a caller-owned availability responder.
 *
 * marker contains only { id, pid, port }. control(action) closes over the
 * authenticated native marker and uses the installed availabilityControl API.
 * No credential, path, process lookup, profile mutation or installer logic is
 * implemented here.
 *
 * The caller owns the exclusive attempt claim and the captured native process,
 * creation time, profile, saved marker and configuration proofs. verifyAdmission
 * must recheck those proofs, including absence of a newly opened owner, and
 * return true. recordStopIntent must durably record the supplied nonsecret
 * identity before returning true. observeRetirement must perform bounded,
 * read-only checks of the captured worker/marker and preserved configuration,
 * returning true only when retirement is proved. It must not resend stop.
 *
 * After this function returns, the caller still enforces its complete native
 * zero-process installer admission gate. Reusing an invocation after uncertain
 * process termination requires reconciliation of the caller's durable attempt.
 */
const failure = (message, code) => Object.assign(new Error(message), { code });
const requireValue = (condition, message, code) => {
  if (!condition) throw failure(message, code);
};
const validPort = value => Number.isSafeInteger(value) && value >= 1024 && value <= 65535;

function identityFor(marker, expectedGeneration) {
  requireValue(
    marker && typeof marker === 'object' && !Array.isArray(marker)
      && Object.keys(marker).sort().join('|') === 'id|pid|port'
      && typeof marker.id === 'string' && marker.id.length > 0
      && Number.isSafeInteger(marker.pid) && marker.pid > 0
      && validPort(marker.port)
      && Number.isSafeInteger(expectedGeneration) && expectedGeneration > 0,
    'Provide the nonsecret marker identity and exact captured generation.',
    'RELEASE_AVAILABILITY_INPUT',
  );
  return Object.freeze({
    id: marker.id, pid: marker.pid, port: marker.port, generation: expectedGeneration,
  });
}

// Validation leaves the raw wire reply intact. It does not return a summary
// that could later be mistaken for the wire shape { state: { state: 'closed' } }.
function validateRawPing(reply, identity) {
  requireValue(
    reply && typeof reply === 'object' && !Array.isArray(reply)
      && reply.id === identity.id && reply.pid === identity.pid
      && reply.port === identity.port && reply.generation === identity.generation,
    'The authenticated availability ping identity or generation changed.',
    'RELEASE_AVAILABILITY_PING',
  );
  requireValue(
    reply.targetAttached === false && reply.lifetimeConnected === false
      && reply.state && typeof reply.state === 'object' && !Array.isArray(reply.state)
      && reply.state.state === 'closed',
    'The availability responder is still attached or is not confirmed closed.',
    'RELEASE_AVAILABILITY_PING',
  );
}

export async function retireReleaseAvailability({
  marker,
  expectedGeneration,
  control,
  verifyAdmission,
  recordStopIntent,
  observeRetirement,
} = {}) {
  const identity = identityFor(marker, expectedGeneration);
  for (const callback of [control, verifyAdmission, recordStopIntent, observeRetirement]) {
    requireValue(typeof callback === 'function', 'Provide all release retirement callbacks.', 'RELEASE_AVAILABILITY_INPUT');
  }
  const admit = async () => requireValue(
    await verifyAdmission() === true,
    'The caller did not confirm native process, marker and profile admission.',
    'RELEASE_AVAILABILITY_ADMISSION',
  );

  await admit();
  const firstPing = await control('ping');
  validateRawPing(firstPing, identity);
  await admit();
  const finalPing = await control('ping');
  validateRawPing(finalPing, identity);

  requireValue(
    await recordStopIntent(identity) === true,
    'The caller did not confirm a durable stop intent.',
    'RELEASE_AVAILABILITY_INTENT',
  );
  // Recheck after the durable write, immediately before the only stop request.
  await admit();

  let stopAcknowledged = false;
  let stopErrorCode = null;
  try {
    const reply = await control('stop');
    stopAcknowledged = reply?.id === identity.id && reply?.stopping === true;
    if (!stopAcknowledged) stopErrorCode = 'RELEASE_AVAILABILITY_STOP_ACK_UNCONFIRMED';
  } catch {
    // Return a fixed code; transport messages and arbitrary error properties
    // may contain private information and are not copied into release reports.
    stopErrorCode = 'RELEASE_AVAILABILITY_STOP_REQUEST_FAILED';
  }

  // Exactly one reconciliation invocation, including an uncertain response.
  // Its bounded polling belongs to the caller; the stop request is never retried.
  requireValue(
    await observeRetirement() === true,
    'The caller did not prove availability retirement.',
    'RELEASE_AVAILABILITY_RETIREMENT_UNCONFIRMED',
  );
  return Object.freeze({ retired: true, stopAcknowledged, stopErrorCode });
}

