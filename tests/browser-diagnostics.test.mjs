import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserDiagnostics } from '../lib/browser-diagnostics.mjs';

test('browser failure evidence omits all credentials, request paths and response payloads', () => {
  const diagnostics = new BrowserDiagnostics({ now: () => 'fixture' });
  diagnostics.request({ url: 'https://user:password@example.com/token-secret?access_token=query-secret#fragment-secret', statusCode: 401, resourceType: 'xhr', requestHeaders: { Authorization: 'header-secret' }, body: 'body-secret' });
  diagnostics.request({ url: 'https://example.com/', error: 'server-secret https://example.com/?token=secret' });
  diagnostics.cookie({ name: 'name-secret', value: 'cookie-secret', domain: '.example.com' }, 'explicit', true);
  assert.deepEqual(diagnostics.snapshot(), {
    failedRequests: [{ at: 'fixture', origin: 'https://example.com', resourceType: 'xhr', status: 401 }, { at: 'fixture', origin: 'https://example.com', resourceType: 'unknown', error: 'Network request failed' }],
    cookieRemovals: [{ at: 'fixture', domain: 'example.com', cause: 'explicit' }],
  });
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /secret|password|user:|Authorization/);
});

test('browser evidence stays bounded and ignores successful requests and cookie updates', () => {
  const diagnostics = new BrowserDiagnostics({ limit: 2, now: () => 'fixture' });
  diagnostics.request({ url: 'https://example.com/', statusCode: 200 });
  diagnostics.request({ url: 'https://example.com/', statusCode: 200, error: 'net::OK' });
  assert.deepEqual(diagnostics.snapshot().failedRequests, [], 'Electron reports net::OK on successful completions');
  diagnostics.request({ url: 'data:text/plain,secret', statusCode: 500 });
  diagnostics.cookie({ domain: '.example.com' }, 'overwrite', true);
  diagnostics.cookie({ domain: '.example.com' }, 'explicit', false);
  for (let i = 0; i < 3; i++) { diagnostics.request({ url: `https://site${i}.example.com/`, error: 'net::ERR_CONNECTION_RESET' }); diagnostics.cookie({ domain: `.site${i}.example.com` }, 'explicit', true); }
  const value = diagnostics.snapshot(); assert.equal(value.failedRequests.length, 2); assert.equal(value.cookieRemovals.length, 2);
  assert.equal(value.failedRequests[0].origin, 'https://site1.example.com');
  value.failedRequests[0].origin = 'mutated'; assert.equal(diagnostics.snapshot().failedRequests[0].origin, 'https://site1.example.com');
});
