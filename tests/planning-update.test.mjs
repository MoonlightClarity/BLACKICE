import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateAdditionalAcceptance, validatePlanningBaseline, candidateChanges } from '../scripts/install-planning-update.mjs';

const context = { name: 'isolated fixture', requiredChecks: ['real start', 'real cleanup'], requiredSources: ['desktop/lifecycle.mjs', 'scripts/fixture.mjs'], fingerprint: 'b'.repeat(64), sourceFiles: { 'desktop/lifecycle.mjs': 'a'.repeat(64), 'scripts/fixture.mjs': 'c'.repeat(64) }, candidate: path.resolve('owned-candidate'), noProviderTurns: true };
const good = () => ({ passed: true, version: '2.29.0', platform: 'win32', candidate: context.candidate, appFingerprintBefore: context.fingerprint, appFingerprintAfter: context.fingerprint, unchangedDuringChecks: true, checks: context.requiredChecks.map(name => ({ name, passed: true })), sourceHashesBefore: { ...context.sourceFiles }, sourceHashesAfter: { ...context.sourceFiles }, errors: [], cleanup: true, forcedCleanup: false, providerTurnsRequested: 0 });

test('planning update binds additional acceptance to the measured runtime and complete source inventory', () => {
  assert.deepEqual(validateAdditionalAcceptance(good(), context), { passed: true, checks: 2, sourceFiles: 2, unchangedDuringChecks: true, cleanup: true });
  for (const patch of [{ version: '2.28.0' }, { platform: 'linux' }, { candidate: path.resolve('another-candidate') }, { appFingerprintAfter: 'd'.repeat(64) }, { unchangedDuringChecks: 'true' }, { passed: 1 }]) assert.throws(() => validateAdditionalAcceptance({ ...good(), ...patch }, context), /exact Windows candidate/);
  for (const field of ['sourceHashesBefore', 'sourceHashesAfter']) {
    const missing = good(); delete missing[field]['scripts/fixture.mjs']; assert.throws(() => validateAdditionalAcceptance(missing, context), /source inventory/);
    const changed = good(); changed[field]['desktop/lifecycle.mjs'] = 'f'.repeat(64); assert.throws(() => validateAdditionalAcceptance(changed, context), /source inventory/);
  }
});

test('planning update rejects partial, reordered, failed or force-cleaned native/API acceptance', () => {
  for (const checks of [[], [good().checks[0]], [...good().checks].reverse(), good().checks.map(entry => ({ ...entry, passed: 'true' }))]) assert.throws(() => validateAdditionalAcceptance({ ...good(), checks }, context), /required observed scenario/);
  for (const patch of [{ cleanup: false }, { forcedCleanup: true }, { errors: ['native exit failed'] }, { cleanupError: 'profile retained' }]) assert.throws(() => validateAdditionalAcceptance({ ...good(), ...patch }, context), /clean owned-state cleanup/);
  assert.throws(() => validateAdditionalAcceptance({ ...good(), providerTurnsRequested: 1 }, context), /no provider turns/);
  assert.throws(() => validateAdditionalAcceptance(good(), { ...context, requiredChecks: [] }), /reviewed/);
});

test('planning update rejects a substituted baseline and never removes or collides with preserved source files', () => {
  assert.throws(() => validatePlanningBaseline(Buffer.from('{"version":"2.28.0"}')), /exact inspected 2.28.0 baseline bytes/);
  const baseline = { sourceFiles: { 'public/app.js': 'a'.repeat(64) }, preservedSourceFiles: { 'scripts/retained-helper.mjs': { sha256: 'c'.repeat(64), bytes: 1 } } };
  assert.throws(() => candidateChanges(baseline, {}), /omitted a baseline file/);
  assert.throws(() => candidateChanges(baseline, { ...baseline.sourceFiles, 'scripts/retained-helper.mjs': 'd'.repeat(64) }), /conflicting/);
  assert.deepEqual(candidateChanges(baseline, { ...baseline.sourceFiles, 'desktop/lifecycle.mjs': 'b'.repeat(64) }), [{ path: 'desktop/lifecycle.mjs', sha256: 'b'.repeat(64), previousSha256: null }]);
});
