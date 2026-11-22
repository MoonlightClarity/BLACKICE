import { createHash } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => Object.assign(new Error(message), { code: 'CONTEXT_USER_ORIGIN_INVALID' });
const keysAre = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys;
const validTurn = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
const digest = message => createHash('sha256').update(JSON.stringify(message)).digest('hex');

function entryFor(record, messageIndex, kind) {
  if (!Array.isArray(record?.messages) || !Number.isSafeInteger(messageIndex) || messageIndex < 0 || messageIndex >= record.messages.length)
    throw invalid('The current user origin does not identify a saved message.');
  const message = record.messages[messageIndex];
  if (!object(message) || message.role !== 'user' || typeof message.content !== 'string')
    throw invalid('A current user origin must refer to its original text prompt.');
  return { kind, messageIndex, messageSha256: digest(message) };
}

function validate(record, expectedTurnId) {
  const origin = record.currentUserOrigin;
  if (origin === undefined) return null;
  if (!keysAre(origin, 'anchors,turnId,version') || origin.version !== 1 || !validTurn(origin.turnId)
      || !Array.isArray(origin.anchors) || !origin.anchors.length)
    throw invalid('The saved current user origin is unsupported or malformed.');
  if (expectedTurnId !== undefined && origin.turnId !== expectedTurnId)
    throw invalid('The current user origin belongs to a different foreground turn.');
  let previous = -1;
  for (const [index, entry] of origin.anchors.entries()) {
    const kind = index === 0 ? 'current-request' : 'accepted-user-direction';
    if (!keysAre(entry, 'kind,messageIndex,messageSha256') || entry.kind !== kind
        || typeof entry.messageSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.messageSha256)
        || !Number.isSafeInteger(entry.messageIndex) || entry.messageIndex <= previous)
      throw invalid('The current user origin has invalid or repeated message positions.');
    const actual = entryFor(record, entry.messageIndex, kind);
    if (actual.messageSha256 !== entry.messageSha256)
      throw invalid('The current user origin no longer matches its original message.');
    previous = entry.messageIndex;
  }
  return origin;
}

/** Call only at the trusted foreground prompt append site. Older turns are history. */
export function createCurrentUserOrigin(record, messageIndex, turnId) {
  if (!validTurn(turnId)) throw invalid('A current user origin needs its foreground turn identity.');
  return { version: 1, turnId, anchors: [entryFor(record, messageIndex, 'current-request')] };
}

/** A direction cannot create an origin or attach itself to an older foreground turn. */
export function extendCurrentUserOrigin(record, messageIndex, turnId) {
  if (!validTurn(turnId)) throw invalid('An accepted direction needs its foreground turn identity.');
  const entry = entryFor(record, messageIndex, 'accepted-user-direction');
  if (record.currentUserOrigin === undefined || record.currentUserOrigin?.turnId !== turnId) return undefined;
  const origin = validate(record, turnId);
  if (messageIndex <= origin.anchors.at(-1).messageIndex)
    throw invalid('An accepted user direction must follow the current request.');
  return { ...origin, anchors: [...origin.anchors, entry] };
}

/**
 * Pin explicit prefix anchors before a single generated checkpoint's retained tail.
 * Message references are preserved: transient image decoration uses prompt identity.
 * No roles, markers, transcript text or summaries are used to infer missing origin.
 */
export function pinCurrentUserOrigin(record, cut, expectedTurnId) {
  const origin = validate(record, expectedTurnId);
  if (!origin) return null;
  if (!Number.isSafeInteger(cut) || cut < 0 || cut > record.messages.length)
    throw invalid('The compaction boundary is outside the current conversation.');
  const prefix = origin.anchors.filter(entry => entry.messageIndex < cut);
  const prefixIndexes = new Map(prefix.map((entry, index) => [entry.messageIndex, index + 1]));
  return {
    prefixMessages: prefix.map(entry => record.messages[entry.messageIndex]),
    origin: {
      ...origin,
      anchors: origin.anchors.map(entry => ({
        ...entry,
        messageIndex: prefixIndexes.has(entry.messageIndex)
          ? prefixIndexes.get(entry.messageIndex)
          : 1 + prefix.length + entry.messageIndex - cut,
      })),
    },
  };
}
