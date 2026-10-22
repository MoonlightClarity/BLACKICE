import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrowserAddress } from '../public/browser-address.mjs';

test('omitted schemes use HTTPS without correcting the entered hostname', () => {
  for (const [address, expected] of [
    ['www.linkedin.comm', 'https://www.linkedin.comm/'],
    ['  www.linkedin.com/feed/?view=all#updates  ', 'https://www.linkedin.com/feed/?view=all#updates'],
    ['example.test:8443/report', 'https://example.test:8443/report'],
    ['//www.linkedin.comm/feed/', 'https://www.linkedin.comm/feed/'],
    ['//example.test:443/report', 'https://example.test/report'],
    ['EXAMPLE.test/with a space', 'https://example.test/with%20a%20space'],
    ['bücher.example/catalog', 'https://xn--bcher-kva.example/catalog'],
  ]) assert.equal(normalizeBrowserAddress(address), expected, address);
});

test('omitted schemes on localhost and literal IP addresses use HTTP and preserve ports', () => {
  for (const [address, expected] of [
    ['localhost', 'http://localhost/'],
    ['localhost:3000/page', 'http://localhost:3000/page'],
    ['localhost:443/page', 'http://localhost:443/page'],
    ['app.localhost:8080/page', 'http://app.localhost:8080/page'],
    ['//localhost:443/page', 'http://localhost:443/page'],
    ['127.0.0.1:8080/page', 'http://127.0.0.1:8080/page'],
    ['192.168.1.20:443/page', 'http://192.168.1.20:443/page'],
    ['[::1]:9222/json', 'http://[::1]:9222/json'],
    ['//[::1]:443/page', 'http://[::1]:443/page'],
    ['[2001:db8::1]:8080/page', 'http://[2001:db8::1]:8080/page'],
  ]) assert.equal(normalizeBrowserAddress(address), expected, address);
});

test('explicit HTTP and HTTPS addresses keep their existing URL semantics', () => {
  for (const address of [
    'http://example.test:8080/path?q=1#section',
    'https://localhost:3000/page',
    'https://127.0.0.1:443/page',
    'https://[::1]:8443/page',
    'HTTP://EXAMPLE.test:80/a/../b',
    'https:example.test/path',
  ]) assert.equal(normalizeBrowserAddress(address), new URL(address).href, address);
  assert.equal(normalizeBrowserAddress(new URL('https://example.test/')), 'https://example.test/');
});

test('invalid addresses and existing unsupported URL forms still fail validation', () => {
  for (const address of [
    '', '   ', undefined, null, 123, {}, 'not a url', '/relative/path', '?query', '#fragment',
    'https://', 'example.test:70000', '[::1',
    'javascript:alert(1)', 'javascript:123', 'data:text/html,hello', 'file:///c:/Windows/a.txt',
    'ftp://example.test/file', 'mailto:name@example.test', 'chrome://settings',
    'https://name:password@example.test/', '//name:password@example.test/', 'name@example.test',
  ]) assert.throws(() => normalizeBrowserAddress(address), TypeError, String(address));
});
