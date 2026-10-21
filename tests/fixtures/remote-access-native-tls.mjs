/** Owned acceptance transport only. Never imported by runtime code. */
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import https from 'node:https';

export const FIXTURE_HOSTNAME = 'blackice-cli-fixture.ts.net';
export const FIXTURE_ORIGIN = 'https://' + FIXTURE_HOSTNAME + ':8443';
const concatenate = values => Buffer.concat(values.map(value => Buffer.isBuffer(value) ? value : Buffer.from(value)));
function der(tag, ...values) {
  const body = concatenate(values), parts = [];
  for (let length = body.length; length; length >>>= 8) parts.unshift(length & 255);
  return concatenate([[tag], body.length < 128 ? [body.length] : [0x80 | parts.length, ...parts], body]);
}
const sequence = (...values) => der(0x30, ...values);
const integer = value => der(0x02, value);
const oid = hex => der(0x06, Buffer.from(hex, 'hex'));
const pem = (name, value) => '-----BEGIN ' + name + '-----\n' + value.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END ' + name + '-----\n';
const utc = value => der(0x17, Buffer.from(value.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:T]/g, '').slice(2)));

/** Generate a two-day self-signed fixture certificate without using a trust store. */
export function createFixtureCertificate(now = Date.now()) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = sequence(oid('2a864886f70d01010b'), der(0x05));
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from(FIXTURE_HOSTNAME)))));
  const basicConstraints = sequence(oid('551d13'), der(0x01, [0xff]), der(0x04, sequence(der(0x01, [0xff]))));
  const subjectAltName = sequence(oid('551d11'), der(0x04, sequence(der(0x82, Buffer.from(FIXTURE_HOSTNAME)))));
  const serial = randomBytes(16); serial[0] |= 0x80;
  const body = sequence(der(0xa0, integer([2])), integer(concatenate([[0], serial])), algorithm, name,
    sequence(utc(new Date(now - 86400000)), utc(new Date(now + 86400000))), name,
    publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, sequence(basicConstraints, subjectAltName)));
  const certificate = pem('CERTIFICATE', sequence(body, algorithm, der(0x03, concatenate([[0], sign('sha256', body, privateKey)]))));
  const parsed = new X509Certificate(certificate);
  if (!parsed.verify(publicKey) || parsed.checkHost(FIXTURE_HOSTNAME) !== FIXTURE_HOSTNAME) throw new Error('The owned TLS certificate is invalid.');
  return { certificate, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** Map only the exact fixture origin to an owned loopback port, with TLS validation. */
export function createFixtureFetch({ origin, port, certificate }) {
  if (origin !== FIXTURE_ORIGIN || !Number.isInteger(port) || port < 1024 || port > 65535 || new X509Certificate(certificate).checkHost(FIXTURE_HOSTNAME) !== FIXTURE_HOSTNAME) throw new Error('Use the owned TLS fixture target.');
  return async (value, options = {}) => {
    const url = new URL(value);
    if (url.origin !== FIXTURE_ORIGIN || url.username || url.password) throw new Error('Acceptance cannot contact an outside address.');
    return new Promise((resolve, reject) => {
      const request = https.request({ hostname: '127.0.0.1', port, servername: FIXTURE_HOSTNAME, ca: certificate, rejectUnauthorized: true, method: options.method || 'GET', path: url.pathname + url.search, headers: { ...options.headers, Host: new URL(FIXTURE_ORIGIN).host }, signal: options.signal, agent: false }, response => {
        if (response.socket.authorized !== true) { response.destroy(); reject(new Error('The fixture TLS connection was not verified.')); return; }
        let length = 0; const chunks = [];
        response.on('data', chunk => { length += chunk.length; if (length > 2 * 1024 * 1024) response.destroy(new Error('Fixture response is too large.')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
      });
      request.setTimeout(10000, () => request.destroy(new Error('The owned TLS fixture timed out.')));
      request.on('error', reject); request.end(options.body);
    });
  };
}
