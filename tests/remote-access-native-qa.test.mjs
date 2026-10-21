import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { parseRemoteAccessNativeQAArguments, validateRemoteAccessNativeReceipt, REMOTE_ACCESS_NATIVE_QA_CHECKS, REMOTE_ACCESS_NATIVE_QA_SOURCES } from '../scripts/remote-access-native-qa.mjs';
import { createFixtureCertificate, createFixtureFetch, FIXTURE_HOSTNAME, FIXTURE_ORIGIN } from './fixtures/remote-access-native-tls.mjs';

test('native access acceptance requires bounded output outside the candidate and exact options', () => {
  const candidate = path.resolve('candidate'), out = path.resolve('qa-owned');
  const parsed = parseRemoteAccessNativeQAArguments(['--candidate', candidate, '--out', out, '--timeout-ms', '120000']);
  assert.equal(parsed.timeoutMs, 120000); assert.equal(parsed.out, out);
  for (const args of [['--timeout-ms', '1'], ['--timeout-ms', '180001'], ['--unknown', 'true'], ['--out', out, '--out', out], ['--candidate', candidate, '--out', candidate], ['--candidate', candidate, '--out', path.join(candidate, 'qa')]]) assert.throws(() => parseRemoteAccessNativeQAArguments(args));
  assert.equal(new Set(REMOTE_ACCESS_NATIVE_QA_SOURCES).size, REMOTE_ACCESS_NATIVE_QA_SOURCES.length);
  assert.ok(REMOTE_ACCESS_NATIVE_QA_SOURCES.includes('scripts/remote-access-cli.mjs'));
  assert.ok(REMOTE_ACCESS_NATIVE_QA_SOURCES.includes('tests/fixtures/remote-access-native.mjs'));
});

test('native access receipt rejects missing evidence, secret output, wrong ownership, or real exposure', () => {
  const expected = { nonce: 'test-nonce', pid: 1234, profile: path.resolve('qa-profile'), executable: path.resolve('electron.exe') };
  const good = { schema: 1, ...expected, platform: 'win32', runtime: { executable: expected.executable, electronVersion: '44.7.2' }, providerTurnsRequested: 0, realRemoteExposure: false, realCredentialIssued: false, fixtureOnly: true, transport: { tlsValidated: true, dnsMappedToOwnedLoopback: true, trustStoreChanged: false }, commands: Array.from({ length: 10 }, (_, index) => ({ pid: 2000 + index, executable: expected.executable, exited: true, exitCode: 0, expectedExitCode: 0, stdinLogged: false, stdoutLogged: false })), checks: REMOTE_ACCESS_NATIVE_QA_CHECKS.map(name => ({ name, passed: true })), errors: [], cleanup: true, forcedCleanup: false };
  assert.equal(validateRemoteAccessNativeReceipt(good, expected), good);
  for (const invalid of [
    { ...good, pid: 4321 }, { ...good, checks: good.checks.slice(1) }, { ...good, cleanup: false }, { ...good, forcedCleanup: true },
    { ...good, realRemoteExposure: true }, { ...good, providerTurnsRequested: 1 }, { ...good, transport: { ...good.transport, trustStoreChanged: true } },
    { ...good, commands: [{ ...good.commands[0], stdoutLogged: true }, ...good.commands.slice(1)] },
    { ...good, accidental: 'blackice_agent_' + 'a'.repeat(43) }, { ...good, accidental: Array(8).fill('ABCD').join('-') },
  ]) assert.throws(() => validateRemoteAccessNativeReceipt(invalid, expected));
});

test('owned fixture TLS has a valid signature and one short-lived host and refuses other targets', async () => {
  const now = Date.now(), generated = createFixtureCertificate(now), certificate = new X509Certificate(generated.certificate);
  assert.equal(certificate.checkHost(FIXTURE_HOSTNAME), FIXTURE_HOSTNAME);
  assert.equal(certificate.checkHost('other.example'), undefined);
  assert.equal(certificate.verify(createPublicKey(createPrivateKey(generated.key))), true);
  assert.ok(Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) > now);
  assert.ok(Date.parse(certificate.validTo) <= now + 86400000);
  assert.throws(() => createFixtureFetch({ origin: 'https://other.example', port: 12345, certificate: generated.certificate }));
  assert.throws(() => createFixtureFetch({ origin: FIXTURE_ORIGIN, port: 80, certificate: generated.certificate }));
  const fetchFixture = createFixtureFetch({ origin: FIXTURE_ORIGIN, port: 12345, certificate: generated.certificate });
  await assert.rejects(fetchFixture('https://outside.example/private'), /outside address/);
});
