import test from 'node:test';
import assert from 'node:assert/strict';
import { RELAY_OPENROUTER_HEADERS, providerRequestHeaders } from '../lib/openrouter-attribution.mjs';

const router = { preset: 'openrouter', type: 'compatible', baseUrl: 'https://openrouter.ai/api/v1' };
const api = { preset: 'compatible', type: 'compatible', baseUrl: 'https://some-other-gateway.example/api/v1' };

test('OpenRouter is truthfully identified as the private BLACKICE personal agent, without impersonating an approved harness', () => {
  const headers=providerRequestHeaders(router);
  assert.deepEqual(headers, RELAY_OPENROUTER_HEADERS);
  assert.equal(headers['X-OpenRouter-Title'], 'BLACKICE');
  assert.equal(headers['X-OpenRouter-Categories'], 'personal-agent');
  assert.equal(headers['X-OpenRouter-App-Visibility'], 'hidden');
  assert.equal(new URL(headers['HTTP-Referer']).hostname, 'localhost');
});

test('OpenRouter attribution respects explicit custom headers regardless of case and legacy title aliases', () => {
  const input = { 'http-referer': 'https://example.net/real-relay-instance', 'x-title': 'Custom Relay', 'X-OpenRouter-Categories': 'programming-app', 'x-openrouter-app-visibility': 'public', 'X-Custom-Header': 'user-setting' };
  const headers=providerRequestHeaders(router,input);
  assert.equal(headers['HTTP-Referer'],undefined);
  assert.equal(headers['http-referer'],input['http-referer']);
  assert.equal(headers['X-OpenRouter-Title'],undefined);
  assert.equal(headers['x-title'], 'Custom Relay');
  assert.equal(headers['X-OpenRouter-Categories'],'programming-app');
  assert.equal(headers['X-OpenRouter-App-Visibility'],undefined);
  assert.equal(headers['x-openrouter-app-visibility'],'public');
  assert.equal(headers['X-Custom-Header'],'user-setting');
  assert.equal(Object.keys(headers).length,5);
});

test('non-OpenRouter providers receive no OpenRouter identity or extra network headers',()=>{
  assert.deepEqual(providerRequestHeaders(api),{});
  assert.deepEqual(providerRequestHeaders(api,{'X-My-Header':'ok'}),{'X-My-Header':'ok'});
  assert.deepEqual(providerRequestHeaders({preset:'compatible',baseUrl:'https://openrouter.ai/api/v1'}),RELAY_OPENROUTER_HEADERS);
});
