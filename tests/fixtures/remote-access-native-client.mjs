/** Runs the production Node-mode helper with only an explicit owned TLS fixture transport. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureFetch, FIXTURE_ORIGIN } from './remote-access-native-tls.mjs';

assert.ok(process.versions.electron, 'Acceptance uses the actual Electron executable.');
const file = process.env.BLACKICE_ACCESS_QA_CONTEXT, nonce = process.env.BLACKICE_ACCESS_QA_NONCE;
assert.ok(path.isAbsolute(file || '')); assert.match(nonce || '', /^[a-f0-9-]{36}$/);
assert.equal(path.basename(file), 'tls-context-' + nonce + '.json');
const context = JSON.parse(await fs.readFile(file, 'utf8'));
assert.equal(context.nonce, nonce); assert.equal(context.origin, FIXTURE_ORIGIN);
assert.ok(Number.isInteger(context.pid) && context.pid > 0);
globalThis.fetch = createFixtureFetch(context);
delete process.env.BLACKICE_ACCESS_QA_CONTEXT; delete process.env.BLACKICE_ACCESS_QA_NONCE;
const helperURL = new URL('../../scripts/remote-access-cli.mjs', import.meta.url);
process.argv = [process.execPath, fileURLToPath(helperURL), ...process.argv.slice(2)];
await import(helperURL);
