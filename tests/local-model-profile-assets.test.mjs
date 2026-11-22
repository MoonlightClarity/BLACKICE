import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';

// No test can contact a real asset server, including an accidental default fetch.
const originalFetch = globalThis.fetch;
let unapprovedFetches = 0;
globalThis.fetch = () => { unapprovedFetches++; throw new Error('Real network forbidden in fixture gate'); };
after(() => { globalThis.fetch = originalFetch; assert.equal(unapprovedFetches, 0); });
const {prepareLocalModelProfileAssets, verifyLocalModelProfileAssetFile} = await import('../lib/local-model-profile-assets.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MODEL = Buffer.from('GGUF\0model: \ud83d\ude80 e\u0301\u200d\0', 'utf8');
const PROJECTOR = Buffer.from([0x47, 0x47, 0x55, 0x46, 0, 255, 128, 7, 4]);
const exists = filename => fs.lstat(filename).then(() => true, cause => cause.code === 'ENOENT' ? false : Promise.reject(cause));

function manifest(entries = [{id:'model', fileName:'model.gguf', bytes:MODEL}, {id:'projector', fileName:'projector.gguf', bytes:PROJECTOR}]) {
  return {profileId:'minicpm-fixture', version:'test-v1', assets:entries.map(({id, fileName, bytes}) => ({id, fileName,
    url:'https://fixtures.invalid/pinned-revision/' + fileName, sizeBytes:bytes.length, sha256:hash(bytes)}))};
}
const oneManifest = () => manifest([{id:'model', fileName:'model.gguf', bytes:MODEL}]);
function byteResponse(bytes, chunkSize = 3) {
  let offset = 0;
  return new Response(new ReadableStream({pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    const next = Math.min(offset + chunkSize, bytes.length);
    controller.enqueue(new Uint8Array(bytes.subarray(offset, next))); offset = next;
  }}, {highWaterMark:0}), {status:200});
}
function transport(handler = url => byteResponse(url.includes('projector') ? PROJECTOR : MODEL)) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    assert.equal(new URL(url).protocol, 'https:');
    assert.equal(options.redirect, 'manual');
    return handler(url, options, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-lpa1-'));
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  return {directory, modelsDirectory:path.join(directory, 'models')};
}
async function rejected(promise, suffix) {
  let caught;
  try { await promise; } catch (cause) { caught = cause; }
  assert.ok(caught, 'operation must reject');
  if (suffix) assert.equal(caught.code, 'LOCAL_PROFILE_ASSET_' + suffix);
  assert.equal(caught.receipt.schema, 'blackice.local-model-profile-assets.v1');
  assert.ok(['failed', 'cancelled'].includes(caught.receipt.status));
  return caught;
}
async function noTemporary(directory) {
  if (!await exists(directory)) return;
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.part')), []);
}

test('import performs no network activity', () => assert.equal(unapprovedFetches, 0));

test('streams, verifies and exclusively publishes both exact binary assets', async t => {
  const f = await fixture(t), pinned = manifest(), fetchImpl = transport();
  const receipt = await prepareLocalModelProfileAssets({...f, manifest:pinned, fetchImpl});
  assert.equal(receipt.status, 'ready'); assert.equal(receipt.stage, 'ready');
  assert.equal(receipt.profileId, pinned.profileId); assert.equal(receipt.version, pinned.version);
  assert.equal(fetchImpl.calls.length, 2);
  for (const [index, bytes] of [MODEL, PROJECTOR].entries()) {
    const item = receipt.assets[index];
    assert.equal(item.status, 'published'); assert.equal(item.path, path.join(f.modelsDirectory, pinned.assets[index].fileName));
    assert.deepEqual(item.expected, {sizeBytes:bytes.length, sha256:hash(bytes)});
    assert.deepEqual(item.observed, item.expected); assert.equal(item.receivedBytes, bytes.length);
    assert.deepEqual(await fs.readFile(item.path), bytes);
  }
  await noTemporary(f.modelsDirectory);
});

test('matching existing files are verified and reused without a request', async t => {
  const f = await fixture(t); await fs.mkdir(f.modelsDirectory);
  await fs.writeFile(path.join(f.modelsDirectory, 'model.gguf'), MODEL);
  await fs.writeFile(path.join(f.modelsDirectory, 'projector.gguf'), PROJECTOR);
  const fetchImpl = transport(() => assert.fail('verified reuse must not download'));
  const receipt = await prepareLocalModelProfileAssets({...f, manifest:manifest(), fetchImpl});
  assert.equal(fetchImpl.calls.length, 0);
  for (const item of receipt.assets) { assert.equal(item.status, 'reused'); assert.deepEqual(item.observed, item.expected); assert.equal(item.receivedBytes, 0); }
});

test('manifest values are snapshotted before an asynchronous transport can mutate the caller object', async t => {
  const f = await fixture(t), pinned = manifest();
  const fetchImpl = transport((url, options, count) => {
    if (count === 1) { pinned.assets[1].fileName = 'changed.gguf'; pinned.assets[1].sha256 = '0'.repeat(64); pinned.version = 'changed'; }
    return byteResponse(url.includes('projector') ? PROJECTOR : MODEL);
  });
  const result = await prepareLocalModelProfileAssets({...f, manifest:pinned, fetchImpl});
  assert.equal(result.version, 'test-v1');
  assert.equal(path.basename(result.assets[1].path), 'projector.gguf');
  assert.deepEqual(await fs.readFile(result.assets[1].path), PROJECTOR);
  assert.equal(await exists(path.join(f.modelsDirectory, 'changed.gguf')), false);
});

test('all existing targets are checked before downloading; a later size conflict is untouched', async t => {
  const f = await fixture(t); await fs.mkdir(f.modelsDirectory);
  const target = path.join(f.modelsDirectory, 'projector.gguf'), foreign = Buffer.from('existing user file');
  await fs.writeFile(target, foreign);
  const fetchImpl = transport(() => assert.fail('preflight conflict must prevent download'));
  const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:manifest(), fetchImpl}), 'CONFLICT');
  assert.equal(fetchImpl.calls.length, 0); assert.deepEqual(await fs.readFile(target), foreign);
  assert.equal(cause.receipt.assets[0].status, 'not-started'); assert.equal(cause.receipt.assets[1].status, 'failed');
  assert.deepEqual(cause.receipt.assets[1].observed, {sizeBytes:foreign.length, sha256:null});
  assert.equal(await exists(path.join(f.modelsDirectory, 'model.gguf')), false);
  await noTemporary(f.modelsDirectory);
});

test('a same-size existing hash mismatch is reported and never overwritten', async t => {
  const f = await fixture(t); await fs.mkdir(f.modelsDirectory);
  const target = path.join(f.modelsDirectory, 'model.gguf'), foreign = Buffer.alloc(MODEL.length, 9);
  await fs.writeFile(target, foreign);
  const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl:transport()}), 'CONFLICT');
  assert.deepEqual(cause.receipt.assets[0].observed, {sizeBytes:foreign.length, sha256:hash(foreign)});
  assert.deepEqual(await fs.readFile(target), foreign);
});

test('an existing directory target is rejected without a request', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.modelsDirectory, 'model.gguf'), {recursive:true});
  const fetchImpl = transport();
  await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl}), 'CONFLICT');
  assert.equal(fetchImpl.calls.length, 0); assert.equal((await fs.stat(path.join(f.modelsDirectory, 'model.gguf'))).isDirectory(), true);
});

test('invalid manifests reject before creating a destination or making requests', async t => {
  const cases = [
    ['empty assets', value => { value.assets = []; }],
    ['duplicate ID', value => { value.assets[1].id = 'MODEL'; }],
    ['case-colliding filename', value => { value.assets[1].fileName = 'MODEL.GGUF'; }],
    ['traversal', value => { value.assets[0].fileName = '../model.gguf'; }],
    ['Windows separator', value => { value.assets[0].fileName = 'sub\\model.gguf'; }],
    ['reserved name', value => { value.assets[0].fileName = 'CON.gguf'; }],
    ['trailing dot', value => { value.assets[0].fileName = 'model.'; }],
    ['zero size', value => { value.assets[0].sizeBytes = 0; }],
    ['unsafe size', value => { value.assets[0].sizeBytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['invalid digest', value => { value.assets[0].sha256 = 'not-a-digest'; }],
    ['HTTP source', value => { value.assets[0].url = 'http://fixtures.invalid/model.gguf'; }],
    ['credentialed source', value => { value.assets[0].url = 'https://secret@fixtures.invalid/model.gguf'; }],
  ];
  for (const [name, change] of cases) await t.test(name, async t => {
    const f = await fixture(t), pinned = manifest(), fetchImpl = transport(); change(pinned);
    await rejected(prepareLocalModelProfileAssets({...f, manifest:pinned, fetchImpl}));
    assert.equal(await exists(f.modelsDirectory), false); assert.equal(fetchImpl.calls.length, 0);
  });
});

test('destination and transport validation occur before preparation', async t => {
  const f = await fixture(t);
  await rejected(prepareLocalModelProfileAssets({modelsDirectory:'relative-models', manifest:oneManifest(), fetchImpl:transport()}), 'DESTINATION');
  await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl:null}), 'TRANSPORT');
  assert.equal(await exists(f.modelsDirectory), false);
  await fs.writeFile(f.modelsDirectory, 'foreign');
  await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl:transport()}), 'DESTINATION');
  assert.equal(await fs.readFile(f.modelsDirectory, 'utf8'), 'foreign');
});

test('a linked destination directory is rejected without touching its target', async t => {
  const f = await fixture(t), real = path.join(f.directory, 'real-models'); await fs.mkdir(real);
  await fs.symlink(real, f.modelsDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  const fetchImpl = transport();
  await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl}), 'DESTINATION');
  assert.equal(fetchImpl.calls.length, 0); assert.deepEqual(await fs.readdir(real), []);
});

test('HTTP failure discards its body and retains no temporary file or response content', async t => {
  const f = await fixture(t), secret = 'unrelated-private-response'; let discarded = 0;
  const body = new ReadableStream({cancel() { discarded++; }});
  const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl:transport(() => new Response(body, {status:403, statusText:secret}))}), 'HTTP');
  assert.equal(discarded, 1); assert.equal(JSON.stringify(cause.receipt).includes(secret), false);
  assert.equal(await exists(path.join(f.modelsDirectory, 'model.gguf')), false); await noTemporary(f.modelsDirectory);
});

test('HTTPS redirects may reach a signed CDN URL without leaking that URL into the receipt', async t => {
  const f = await fixture(t), signed = 'https://cdn.fixtures.invalid/file?signature=private-fixture-token';
  const fetchImpl = transport((url, options, count) => count === 1 ? new Response(null, {status:302, headers:{location:signed}}) : byteResponse(MODEL));
  const receipt = await prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl});
  assert.equal(fetchImpl.calls.length, 2); assert.equal(fetchImpl.calls[1].url, signed);
  assert.equal(JSON.stringify(receipt).includes('private-fixture-token'), false);
  assert.deepEqual(await fs.readFile(receipt.assets[0].path), MODEL);
});

test('redirect failures are bounded and validated before the next request', async t => {
  for (const [name, location, expected, requests] of [
    ['missing location', null, 'REDIRECT', 1],
    ['HTTP downgrade', 'http://cdn.fixtures.invalid/file', 'URL', 1],
    ['credentials', 'https://user:secret@cdn.fixtures.invalid/file', 'URL', 1],
    ['loop', 'https://fixtures.invalid/loop', 'REDIRECT', 6],
  ]) await t.test(name, async t => {
    const f = await fixture(t), fetchImpl = transport(() => new Response(null, {status:302, headers:location ? {location} : {}}));
    await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl}), expected);
    assert.equal(fetchImpl.calls.length, requests); await noTemporary(f.modelsDirectory);
  });
});

test('short, oversized and wrong-hash streams never publish', async t => {
  const cases = [
    ['short', MODEL.subarray(0, MODEL.length - 1), 'SIZE'],
    ['oversized', Buffer.concat([MODEL, Buffer.from([1])]), 'SIZE'],
    ['wrong hash', Buffer.alloc(MODEL.length, 0x41), 'INTEGRITY'],
  ];
  for (const [name, bytes, code] of cases) await t.test(name, async t => {
    const f = await fixture(t);
    const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl:transport(() => byteResponse(bytes, 64))}), code);
    assert.equal(cause.receipt.assets[0].status, 'failed'); assert.equal(cause.receipt.assets[0].receivedBytes, bytes.length);
    if (name === 'oversized') assert.equal(cause.receipt.assets[0].observed, null);
    else assert.deepEqual(cause.receipt.assets[0].observed, {sizeBytes:bytes.length, sha256:hash(bytes)});
    assert.equal(await exists(path.join(f.modelsDirectory, 'model.gguf')), false); await noTemporary(f.modelsDirectory);
  });
});

test('stream errors and non-byte chunks clean temporary files', async t => {
  for (const name of ['error', 'non-byte']) await t.test(name, async t => {
    const f = await fixture(t), body = new ReadableStream({pull(controller) {
      if (name === 'error') controller.error(new Error('private-transport-detail'));
      else controller.enqueue('not bytes');
    }}, {highWaterMark:0});
    const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl:transport(() => new Response(body))}), 'STREAM');
    assert.equal(JSON.stringify(cause.receipt).includes('private-transport-detail'), false);
    await noTemporary(f.modelsDirectory); assert.equal(await exists(path.join(f.modelsDirectory, 'model.gguf')), false);
  });
});

test('pre-cancelled preparation performs no filesystem or transport work', async t => {
  const f = await fixture(t), controller = new AbortController(), fetchImpl = transport(); controller.abort();
  const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:manifest(), signal:controller.signal, fetchImpl}), 'CANCELLED');
  assert.equal(cause.receipt.status, 'cancelled'); assert.equal(fetchImpl.calls.length, 0); assert.equal(await exists(f.modelsDirectory), false);
  assert.equal(cause.receipt.assets.every(item => item.status === 'not-started'), true);
});

test('midstream cancellation reaches the pending reader and cleans its partial file', async t => {
  const f = await fixture(t), controller = new AbortController(); let pulls = 0, cancels = 0;
  const body = new ReadableStream({pull(stream) {
    if (++pulls === 1) stream.enqueue(new Uint8Array(MODEL.subarray(0, 2)));
    else controller.abort('fixture cancellation');
  }, cancel() { cancels++; }}, {highWaterMark:0});
  const fetchImpl = transport((url, options) => { assert.equal(options.signal, controller.signal); return new Response(body); });
  const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), signal:controller.signal, fetchImpl}), 'CANCELLED');
  assert.equal(cause.receipt.assets[0].receivedBytes, 2); assert.equal(cancels, 1); assert.equal(cause.receipt.assets[0].status, 'cancelled');
  await noTemporary(f.modelsDirectory); assert.equal(await exists(path.join(f.modelsDirectory, 'model.gguf')), false);
});

test('transport cancellation is normalized without retaining its private error', async t => {
  const f = await fixture(t), controller = new AbortController();
  const fetchImpl = transport(() => { controller.abort(); throw new Error('private transport abort'); });
  const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), signal:controller.signal, fetchImpl}), 'CANCELLED');
  assert.equal(JSON.stringify(cause.receipt).includes('private transport abort'), false); await noTemporary(f.modelsDirectory);
});

test('a later HTTP failure preserves the earlier verified published asset and truthful partial stages', async t => {
  const f = await fixture(t), fetchImpl = transport((url, options, count) => count === 1 ? byteResponse(MODEL) : new Response(null, {status:503}));
  const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:manifest(), fetchImpl}), 'HTTP');
  assert.equal(cause.receipt.assets[0].status, 'published'); assert.deepEqual(cause.receipt.assets[0].observed, cause.receipt.assets[0].expected);
  assert.equal(cause.receipt.assets[1].status, 'failed'); assert.equal(cause.receipt.assets[1].observed, null);
  assert.equal(cause.receipt.error.assetId, 'projector');
  assert.deepEqual(await fs.readFile(path.join(f.modelsDirectory, 'model.gguf')), MODEL);
  assert.equal(await exists(path.join(f.modelsDirectory, 'projector.gguf')), false); await noTemporary(f.modelsDirectory);
});

test('a later cancellation leaves the first published asset ready for a retry', async t => {
  const f = await fixture(t), controller = new AbortController();
  const fetchImpl = transport((url, options, count) => { if (count === 1) return byteResponse(MODEL); controller.abort(); throw new Error('aborted'); });
  const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:manifest(), signal:controller.signal, fetchImpl}), 'CANCELLED');
  assert.equal(cause.receipt.assets[0].status, 'published'); assert.equal(cause.receipt.assets[1].status, 'cancelled');
  await noTemporary(f.modelsDirectory);
  const retryTransport = transport(url => { assert.ok(url.includes('projector')); return byteResponse(PROJECTOR); });
  const retried = await prepareLocalModelProfileAssets({...f, manifest:manifest(), fetchImpl:retryTransport});
  assert.deepEqual(retried.assets.map(item => item.status), ['reused', 'published']); assert.equal(retryTransport.calls.length, 1);
});

test('a concurrent exact target is verified and reused after exclusive publication loses the race', async t => {
  const f = await fixture(t), target = path.join(f.modelsDirectory, 'model.gguf');
  const fetchImpl = transport(async () => { await fs.writeFile(target, MODEL, {flag:'wx'}); return byteResponse(MODEL); });
  const receipt = await prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl});
  assert.equal(receipt.assets[0].status, 'reused'); assert.deepEqual(receipt.assets[0].observed, receipt.assets[0].expected);
  assert.deepEqual(await fs.readFile(target), MODEL); await noTemporary(f.modelsDirectory);
});

test('a concurrent conflicting target is preserved and never replaced', async t => {
  const f = await fixture(t), target = path.join(f.modelsDirectory, 'model.gguf'), foreign = Buffer.alloc(MODEL.length, 0x66);
  const fetchImpl = transport(async () => { await fs.writeFile(target, foreign, {flag:'wx'}); return byteResponse(MODEL); });
  const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl}), 'CONFLICT');
  assert.equal(cause.receipt.error.stage, 'publish'); assert.deepEqual(await fs.readFile(target), foreign);
  await noTemporary(f.modelsDirectory);
});

test('unsupported exclusive publication fails closed without a rename fallback', async t => {
  const f = await fixture(t), originalLink = fs.link, originalRename = fs.rename; let links = 0, renames = 0;
  fs.link = async () => { links++; throw Object.assign(new Error('fixture filesystem cannot link'), {code:'ENOTSUP'}); };
  fs.rename = async () => { renames++; assert.fail('unsafe rename fallback'); };
  try {
    const cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl:transport()}), 'PUBLISH');
    assert.equal(cause.receipt.error.filesystemCode, 'ENOTSUP'); assert.equal(cause.receipt.assets[0].observed, null);
    assert.equal(await exists(path.join(f.modelsDirectory, 'model.gguf')), false); await noTemporary(f.modelsDirectory);
  } finally { fs.link = originalLink; fs.rename = originalRename; }
  assert.equal(links, 1); assert.equal(renames, 0);
});

test('a cleanup failure reports the completed target and remaining owned temporary file honestly', async t => {
  const f = await fixture(t), originalUnlink = fs.unlink;
  fs.unlink = async filename => { if (filename.endsWith('.part')) throw Object.assign(new Error('fixture busy temporary'), {code:'EBUSY'}); return originalUnlink(filename); };
  let cause;
  try { cause = await rejected(prepareLocalModelProfileAssets({...f, manifest:oneManifest(), fetchImpl:transport()})); }
  finally { fs.unlink = originalUnlink; }
  assert.equal(cause.receipt.assets[0].status, 'published');
  assert.equal(cause.receipt.error.stage, 'cleanup');
  assert.equal(cause.receipt.cleanup.temporaryFilesRemaining.length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.modelsDirectory, 'model.gguf')), MODEL);
  for (const filename of cause.receipt.cleanup.temporaryFilesRemaining) await fs.unlink(filename);
  await noTemporary(f.modelsDirectory);
});

test('read-only verifier accepts a renamed external asset without creating the managed directory', async t => {
  const f = await fixture(t), external = path.join(f.directory, 'external'); await fs.mkdir(external);
  const filePath = path.join(external, 'renamed-model.bin'); await fs.writeFile(filePath, MODEL);
  const before = await fs.stat(filePath), verified = await verifyLocalModelProfileAssetFile({asset:oneManifest().assets[0], filePath});
  assert.equal(verified.status, 'verified'); assert.equal(verified.path, filePath);
  assert.deepEqual(verified.observed, {sizeBytes:MODEL.length, sha256:hash(MODEL)});
  assert.equal(await exists(f.modelsDirectory), false); assert.deepEqual(await fs.readdir(external), ['renamed-model.bin']);
  const after = await fs.stat(filePath); assert.equal(after.mtimeMs, before.mtimeMs); assert.deepEqual(await fs.readFile(filePath), MODEL);
});

test('read-only missing verification does not create the file or its directory', async t => {
  const f = await fixture(t), filePath = path.join(f.directory, 'missing', 'model.gguf');
  await assert.rejects(verifyLocalModelProfileAssetFile({asset:oneManifest().assets[0], filePath}), cause => {
    assert.equal(cause.code, 'LOCAL_PROFILE_ASSET_NOT_FOUND'); assert.equal(cause.status, 404);
    assert.equal(cause.verification.observed, null); return true;
  });
  assert.equal(await exists(path.dirname(filePath)), false);
});

test('read-only size and hash conflicts preserve the actual external bytes', async t => {
  for (const [name, bytes] of [['size', Buffer.from('wrong')], ['hash', Buffer.alloc(MODEL.length, 8)]]) await t.test(name, async t => {
    const f = await fixture(t), filePath = path.join(f.directory, 'existing.gguf'); await fs.writeFile(filePath, bytes);
    await assert.rejects(verifyLocalModelProfileAssetFile({asset:oneManifest().assets[0], filePath}), cause => {
      assert.equal(cause.code, 'LOCAL_PROFILE_ASSET_CONFLICT'); assert.equal(cause.verification.status, 'failed');
      assert.equal(cause.verification.observed.sizeBytes, bytes.length); return true;
    });
    assert.deepEqual(await fs.readFile(filePath), bytes); assert.equal(await exists(f.modelsDirectory), false);
  });
});

test('read-only verification rejects unsafe targets and observes cancellation without mutation', async t => {
  const f = await fixture(t), asset = oneManifest().assets[0], controller = new AbortController();
  await assert.rejects(verifyLocalModelProfileAssetFile({asset, filePath:f.directory}), {code:'LOCAL_PROFILE_ASSET_CONFLICT'});
  await assert.rejects(verifyLocalModelProfileAssetFile({asset, filePath:'relative.gguf'}), {code:'LOCAL_PROFILE_ASSET_DESTINATION'});
  const filePath = path.join(f.directory, 'model.gguf'); await fs.writeFile(filePath, MODEL); controller.abort();
  await assert.rejects(verifyLocalModelProfileAssetFile({asset, filePath, signal:controller.signal}), cause => {
    assert.equal(cause.code, 'LOCAL_PROFILE_ASSET_CANCELLED'); assert.equal(cause.verification.status, 'cancelled'); return true;
  });
  assert.deepEqual(await fs.readFile(filePath), MODEL); assert.deepEqual(await fs.readdir(f.directory), ['model.gguf']);
});
