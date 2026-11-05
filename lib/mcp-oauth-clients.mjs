import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const OAUTH_CLIENT_AUTH_METHODS = Object.freeze(['none', 'client_secret_basic', 'client_secret_post']);
export const MAX_REGISTERED_OAUTH_CLIENTS = 64;
const CLIENT_ID = /^blackice_client_[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;
const CLIENT_KEYS = ['clientId', 'clientName', 'redirectUris', 'tokenEndpointAuthMethod', 'clientSecretHash', 'createdAt'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const sameHash = (left, right) => HASH.test(left || '') && HASH.test(right || '') && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
const validName = value => typeof value === 'string' && value.length >= 1 && value.length <= 160 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const validRedirect = value => {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\x00-\x20\x7f]/.test(value) || value.includes('#')) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.hash; }
  catch { return false; }
};
const validRedirects = value => Array.isArray(value) && value.length >= 1 && value.length <= 20 && new Set(value).size === value.length && value.every(validRedirect);
const invalid = (description, error = 'invalid_client_metadata', status = 400) => Object.assign(new Error(description), {
  oauthError: error, code: `OAUTH_${error.toUpperCase()}`, status,
});
const clientFailure = (description, method = 'none') => Object.assign(invalid(description, 'invalid_client', method === 'client_secret_basic' ? 401 : 400),
  method === 'client_secret_basic' ? { oauthHeaders: { 'WWW-Authenticate': 'Basic realm="BLACKICE OAuth"' } } : {});

/** Validate the persisted registry without trusting client names as identities. */
export function validateRegisteredOAuthClients(value) {
  if (!Array.isArray(value) || value.length > MAX_REGISTERED_OAUTH_CLIENTS) throw Error('Invalid registered OAuth clients.');
  const ids = new Set();
  return value.map(client => {
    if (!object(client) || Object.keys(client).some(key => !CLIENT_KEYS.includes(key))
      || !CLIENT_ID.test(client.clientId || '') || ids.has(client.clientId) || !validName(client.clientName)
      || !validRedirects(client.redirectUris) || !OAUTH_CLIENT_AUTH_METHODS.includes(client.tokenEndpointAuthMethod)
      || (client.tokenEndpointAuthMethod === 'none' ? client.clientSecretHash !== null : !HASH.test(client.clientSecretHash || ''))
      || typeof client.createdAt !== 'string' || !Number.isFinite(Date.parse(client.createdAt))) throw Error('Invalid registered OAuth client.');
    ids.add(client.clientId);
    return { ...client, redirectUris: [...client.redirectUris] };
  });
}

export function findRegisteredOAuthClient(clients, clientId) {
  return Array.isArray(clients) && typeof clientId === 'string' ? clients.find(client => client.clientId === clientId) || null : null;
}

/** RFC 7591 registration supplies an identity, never an access grant. */
export function createRegisteredOAuthClient(metadata, { now = Date.now } = {}) {
  if (!object(metadata)) throw invalid('Send a JSON object of OAuth client metadata.');
  if (!validRedirects(metadata.redirect_uris)) throw invalid('Register one or more exact HTTPS redirect URIs without fragments or credentials.', 'invalid_redirect_uri');
  const clientName = metadata.client_name === undefined ? 'MCP client' : typeof metadata.client_name === 'string' ? metadata.client_name.trim() : null;
  if (!validName(clientName)) throw invalid('Use a client name of 1–160 characters without control characters.');
  const method = metadata.token_endpoint_auth_method === undefined ? 'client_secret_basic' : metadata.token_endpoint_auth_method;
  if (!OAUTH_CLIENT_AUTH_METHODS.includes(method)) throw invalid('Use none, client_secret_basic, or client_secret_post.');
  if (metadata.response_types !== undefined && (!Array.isArray(metadata.response_types) || metadata.response_types.length !== 1 || metadata.response_types[0] !== 'code')) throw invalid('Use the authorization-code response type.');
  if (metadata.grant_types !== undefined && (!Array.isArray(metadata.grant_types) || !metadata.grant_types.length || metadata.grant_types.length > 2
    || new Set(metadata.grant_types).size !== metadata.grant_types.length || !metadata.grant_types.includes('authorization_code')
    || metadata.grant_types.some(type => !['authorization_code', 'refresh_token'].includes(type)))) throw invalid('Use authorization_code and optionally refresh_token.');
  const createdAt = new Date(now()).toISOString();
  const clientSecret = method === 'none' ? null : `blackice_cs_${randomBytes(32).toString('base64url')}`;
  const client = {
    clientId: `blackice_client_${randomBytes(32).toString('base64url')}`,
    clientName, redirectUris: [...metadata.redirect_uris], tokenEndpointAuthMethod: method,
    clientSecretHash: clientSecret === null ? null : digest(clientSecret), createdAt,
  };
  // Unknown metadata is deliberately ignored, as RFC 7591 requires. Both grant
  // types describe the effective registration: BLACKICE issues renewable grants.
  const response = {
    client_id: client.clientId, client_id_issued_at: Math.floor(Date.parse(createdAt) / 1000),
    client_name: client.clientName, redirect_uris: [...client.redirectUris], token_endpoint_auth_method: method,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    ...(clientSecret === null ? {} : { client_secret: clientSecret, client_secret_expires_at: 0 }),
  };
  return { client, response };
}

/** Read exactly one client-authentication method. This does not authorize it. */
export function parseOAuthClientAuthentication(params, req = {}) {
  if (!object(params)) throw clientFailure('Provide OAuth client authentication.');
  if (params.client_assertion !== undefined || params.client_assertion_type !== undefined) throw clientFailure('Use the client’s registered authentication method.');
  const header = req.headers?.authorization;
  const count = (req.rawHeaders || []).filter((value, index) => index % 2 === 0 && String(value).toLowerCase() === 'authorization').length;
  if (count > 1) throw clientFailure('Send only one client authentication header.', header ? 'client_secret_basic' : 'none');
  if (header !== undefined) {
    const match = typeof header === 'string' && header.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
    if (!match || match[1].length > 16384 || match[1].length % 4) throw clientFailure('Use valid HTTP Basic client authentication.', 'client_secret_basic');
    const bytes = Buffer.from(match[1], 'base64'), decoded = bytes.toString('utf8');
    if (bytes.toString('base64') !== match[1] || !Buffer.from(decoded, 'utf8').equals(bytes)) throw clientFailure('Use valid HTTP Basic client authentication.', 'client_secret_basic');
    const separator = decoded.indexOf(':');
    if (separator < 1) throw clientFailure('Provide a client ID and secret.', 'client_secret_basic');
    let clientId, clientSecret;
    try {
      clientId = decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, ' '));
      clientSecret = decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, ' '));
    } catch { throw clientFailure('Use valid encoded client credentials.', 'client_secret_basic'); }
    if (!clientId.length || clientId.length > 4096 || !clientSecret.length || clientSecret.length > 4096
      || /[\x00-\x1f\x7f]/.test(clientId + clientSecret) || params.client_secret !== undefined
      || params.client_id !== undefined && params.client_id !== clientId) throw clientFailure('Send matching credentials using only HTTP Basic.', 'client_secret_basic');
    return { clientId, method: 'client_secret_basic', clientSecret };
  }
  if (typeof params.client_id !== 'string' || !params.client_id.length || params.client_id.length > 4096 || /[\x00-\x1f\x7f]/.test(params.client_id)) throw clientFailure('Provide the registered OAuth client ID.');
  const method = params.client_secret === undefined ? 'none' : 'client_secret_post';
  if (method === 'client_secret_post' && (typeof params.client_secret !== 'string' || !params.client_secret.length || params.client_secret.length > 4096 || /[\x00-\x1f\x7f]/.test(params.client_secret))) throw clientFailure('Provide the registered client secret.', method);
  return { clientId: params.client_id, method, clientSecret: params.client_secret ?? null };
}

export function verifyRegisteredOAuthClientAuthentication(client, authentication) {
  if (!client || client.clientId !== authentication.clientId || client.tokenEndpointAuthMethod !== authentication.method
    || authentication.method !== 'none' && !sameHash(client.clientSecretHash, digest(authentication.clientSecret || ''))) {
    throw clientFailure('The registered OAuth client credentials are invalid.', authentication.method);
  }
  return client;
}
