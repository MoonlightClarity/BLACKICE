import { createHash } from 'node:crypto';
import { evaluateUserCostDecision, assertUserCostChoice } from '../public/user-cost-decision.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'INVALID_CONTENT_SELECTION') => Object.assign(new Error(message), { code, status: 409 });
const keys = ['decisionId', 'inputSha256', 'argumentPointer'];
export const CONTENT_SELECTION_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: keys,
  properties: {
    decisionId: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$' },
    inputSha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Copy inputSha256 from the saved decision assessment. A changed input requires a newly adopted selection.' },
    argumentPointer: { type: 'string', minLength: 1, maxLength: 256, description: 'JSON Pointer to one literal string argument, such as /text or /body/content. At most 12 own-property segments; ~0 and ~1 escape tilde and slash. No prototype or accessor traversal.' },
  },
  description: 'Optional selected-content consistency for an explicitly bound tool operation in enforced sequential plans. The named argument must exactly equal the saved decision\'s selected or recommended proceed outcome. Put actual candidate wording in options[].outcome. This is not semantic validation, privacy enforcement, authority to act, or a delivery guarantee in advisory mode. Omit for routine unbound work.',
});

function pointerTokens(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 256 || pointer.includes('\0') || /~(?![01])/u.test(pointer))
    throw fail('contentSelection.argumentPointer must be one bounded JSON Pointer to a string argument.');
  const tokens = pointer.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (tokens.length > 12 || tokens.some(token => ['__proto__', 'prototype', 'constructor'].includes(token)))
    throw fail('contentSelection.argumentPointer cannot traverse prototype fields or more than 12 segments.');
  return tokens;
}

export function normalizeContentSelection(value) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))
    || typeof value.decisionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value.decisionId)
    || typeof value.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputSha256))
    throw fail('contentSelection needs exactly decisionId, inputSha256 and argumentPointer from an adopted saved decision.');
  pointerTokens(value.argumentPointer);
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

// Object-key order is not a change of evidence; option/array order is preserved.
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const decisionInputSha256 = input => createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');

export function decisionOutcomeProjection(assessment, evaluation = assessment.evaluation) {
  const outcome = id => assessment.input.options.find(option => option.id === id)?.outcome ?? null;
  return {
    inputSha256: decisionInputSha256(assessment.input),
    recommendedOutcome: outcome(evaluation.recommendedOptionId),
    selectedOutcome: outcome(assessment.selectedOptionId),
  };
}

/** Resolve only saved raw inputs; cached totals and caller wording confer no authority. */
export function resolveSavedDecisionContent(state, value) {
  const selection = normalizeContentSelection(value);
  const assessment = state.decisionAssessments?.find(item => item.id === selection.decisionId);
  if (!assessment) throw fail('The bound decision is not saved. Read the current plan and adopt an existing assessed decision; no operation was dispatched.', 'TASK_PLAN_CONTENT_SELECTION_MISSING');
  const evaluation = assessment.selectedOptionId == null ? evaluateUserCostDecision(assessment.input)
    : assertUserCostChoice(assessment.input, assessment.selectedOptionId);
  if (decisionInputSha256(assessment.input) !== selection.inputSha256)
    throw fail('The bound decision inputs changed. Read the updated assessment and explicitly update this unfinished operation\'s contentSelection; no operation was dispatched.', 'TASK_PLAN_CONTENT_SELECTION_STALE');
  const optionId = assessment.selectedOptionId ?? evaluation.recommendedOptionId;
  const option = assessment.input.options.find(item => item.id === optionId);
  if (evaluation.status !== 'evaluated' || option?.id !== evaluation.recommendedOptionId || option?.action !== 'proceed')
    throw fail('The bound decision has no calculated eligible proceed outcome. Resolve its actual comparison before using its content; this does not itself require a user question. No operation was dispatched.', 'TASK_PLAN_CONTENT_SELECTION_UNRESOLVED');
  return { decisionId: selection.decisionId, inputSha256: selection.inputSha256, optionId, text: option.outcome };
}

/** Equality only: never mutate arguments, scan their words, or infer authorization. */
export function assertPlannedContentSelection(state, operation, args) {
  if (operation?.contentSelection === undefined) return null;
  const selection = normalizeContentSelection(operation.contentSelection);
  const resolved = resolveSavedDecisionContent(state, selection);
  let actual = args;
  for (const token of pointerTokens(selection.argumentPointer)) {
    const descriptor = actual !== null && typeof actual === 'object' ? Object.getOwnPropertyDescriptor(actual, token) : undefined;
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) { actual = undefined; break; }
    actual = descriptor.value;
  }
  if (typeof actual !== 'string' || actual !== resolved.text)
    throw fail('Argument ' + selection.argumentPointer + ' must exactly match outcome ' + resolved.optionId + ' from the bound decision. Copy that saved outcome, or reassess and adopt revised content before this operation. No arguments were changed and no operation was dispatched.', 'TASK_PLAN_CONTENT_SELECTION_MISMATCH');
  return resolved;
}
