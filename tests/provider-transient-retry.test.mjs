import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const completed = text => ({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
const json = (response, body, status = 200, headers = {}) => {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};
class UnavailableCodex extends EventEmitter {
  calls = 0;
  status() { return { connected: false, authenticated: false, models: [] }; }
  async runAgent() { this.calls++; throw new Error('The explicit API fixture must not fall back.'); }
  async close() {}
}
async function harness(t, handler, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-http-retry-'));
  const requests = [], serverErrors = [], codex = new UnavailableCodex();
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      if (request.method === 'GET') return json(response, { data: [] });
      const record = { at: Date.now(), url: request.url, method: request.method, headers: request.headers, raw, body: JSON.parse(raw) };
      requests.push(record);
      await handler(record, response, requests.length);
    } catch (cause) {
      serverErrors.push(cause);
      if (!response.headersSent) json(response, { error: { message: cause.message } }, 500);
      else response.destroy();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = await new ProviderRuntime({
    codex, dataDir, idleTimeoutMs: 5000,
    modelLimitResolver: { enrich: async (_config, models) => models },
    ...options,
  }).init();
  t.after(async () => {
    await runtime.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    assert.deepEqual(serverErrors, []);
  });
  await runtime.saveProvider({
    id: 'fixture', type: 'compatible',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    models: ['fixture-model'], maxTokens: 128, maxSteps: 6,
  });
  return {
    runtime, codex, requests, dataDir,
    run: options => runtime.runAgent({
      cwd: dataDir, model: 'fixture::fixture-model',
      prompt: 'Read the supplied fixture and report its actual result.',
      ...options,
    }),
  };
}

for (const status of [502, 503, 504]) test('one explicit HTTP ' + status + ' retries the exact exchange and accepts one completion', async t => {
  const { run, requests, codex } = await harness(t, (_request, response, count) => {
    if (count === 1) return json(response, { error: { message: 'Temporary upstream service failure.' } }, status);
    json(response, completed('Recovered completion.'));
  });
  const events = [];
  const result = await run({ onEvent: event => events.push(event) });
  assert.equal(result.output, 'Recovered completion.');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].raw, requests[1].raw);
  assert.equal(requests[0].url, requests[1].url);
  assert.equal(requests[0].method, requests[1].method);
  assert.deepEqual(requests[0].headers, requests[1].headers);
  assert.equal(requests[1].body.model, 'fixture-model');
  assert.ok(requests[1].at - requests[0].at >= 450, 'the default retry waits approximately 500ms');
  assert.equal(events.filter(event => event.type === 'message' && event.phase === 'final_answer').length, 1);
  assert.equal(codex.calls, 0);
});

test('two service failures stop after the single retry and retain the final classification', async t => {
  const { run, requests, codex } = await harness(t, (_request, response, count) => {
    json(response, { error: { message: count === 1 ? 'First service failure.' : 'Final service failure.' } }, 503);
  });
  await assert.rejects(run(), cause => cause.code === 'PROVIDER_SERVICE'
    && cause.httpStatus === 503 && cause.failureScope === 'connection' && /Final service failure/.test(cause.message));
  assert.equal(requests.length, 2);
  assert.equal(codex.calls, 0);
});

test('a retry gets a fresh inactivity clock while keeping the same overall run', async t => {
  const { run, requests } = await harness(t, (_request, response, count) => {
    if (count === 1) return json(response, { error: { message: 'Temporary service failure.' } }, 502);
    json(response, completed('Recovered after backoff.'));
  }, { idleTimeoutMs: 200 });
  assert.equal((await run({ timeoutMs: 3000 })).output, 'Recovered after backoff.');
  assert.equal(requests.length, 2);
});

test('continuation recovery reuses the completed tool result without executing the tool twice', async t => {
  const callId = 'read-fixture-once';
  const tool = { type: 'function', name: 'fixture_read', description: 'Read the local fixture.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const { run, requests, dataDir } = await harness(t, (_request, response, count) => {
    if (count === 1) return json(response, { choices: [{ index: 0, finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: callId, type: 'function', function: { name: 'fixture_read', arguments: '{}' } }],
    } }] });
    if (count === 2) return json(response, { error: { message: 'Temporary continuation failure.' } }, 502);
    json(response, completed('The fixture contains verified data.'));
  });
  const filename = path.join(dataDir, 'fixture.txt');
  await writeFile(filename, 'verified data', 'utf8');
  let toolExecutions = 0;
  const result = await run({
    dynamicTools: [tool],
    onToolCall: async call => {
      assert.equal(call.name, 'fixture_read');
      toolExecutions++;
      return { success: true, contentItems: [{ type: 'inputText', text: await readFile(filename, 'utf8') }] };
    },
  });
  assert.equal(result.output, 'The fixture contains verified data.');
  assert.equal(toolExecutions, 1);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].raw, requests[2].raw);
  const resultMessage = requests[2].body.messages.at(-1);
  assert.equal(resultMessage.role, 'tool');
  assert.equal(resultMessage.tool_call_id, callId);
  assert.equal(resultMessage.content, 'verified data');
  assert.equal(requests[2].body.messages.filter(message => message.role === 'assistant' && message.tool_calls?.length).length, 1);
});

for (const status of [400, 401, 402, 403, 404, 408, 409, 429, 500, 501]) test('HTTP ' + status + ' is not a transient retry candidate', async t => {
  const { run, requests } = await harness(t, (_request, response) => {
    json(response, { error: { message: 'The request was rejected.' } }, status, { 'Retry-After': '0.05' });
  });
  await assert.rejects(run());
  assert.equal(requests.length, 1);
});

for (const [upstreamCode, expectedCode] of [
  ['invalid_api_key', 'PROVIDER_AUTH'],
  ['insufficient_quota', 'PROVIDER_QUOTA'],
  ['rate_limit_exceeded', 'PROVIDER_RATE_LIMIT'],
  ['context_length_exceeded', 'CONTEXT_OVERFLOW'],
  ['model_not_found', 'PROVIDER_MODEL'],
]) test('HTTP 503 wrapping ' + upstreamCode + ' is not retried', async t => {
  const { run, requests } = await harness(t, (_request, response) => {
    json(response, { error: { code: upstreamCode, message: 'Upstream request rejected.' } }, 503);
  });
  await assert.rejects(run(), { code: expectedCode });
  assert.equal(requests.length, 1);
});

test('cancellation during backoff prevents the retry and settles the active turn', async t => {
  const firstResponse = deferred(), controller = new AbortController();
  const { run, requests, runtime } = await harness(t, (_request, response) => {
    json(response, { error: { message: 'Temporary service failure.' } }, 503, { 'Retry-After': '1' });
    firstResponse.resolve();
  });
  const rejected = assert.rejects(run({ signal: controller.signal }), { code: 'ABORT_ERR' });
  await firstResponse.promise;
  await sleep(60);
  controller.abort();
  await rejected;
  assert.equal(requests.length, 1);
  assert.equal(runtime.active.size, 0);
});

test('the original overall deadline remains active during backoff', async t => {
  const { run, requests, runtime } = await harness(t, (_request, response) => {
    json(response, { error: { message: 'Temporary service failure.' } }, 503, { 'Retry-After': '1' });
  });
  await assert.rejects(run({ timeoutMs: 150 }), { code: 'PROVIDER_TIMEOUT' });
  assert.equal(requests.length, 1);
  assert.equal(runtime.active.size, 0);
});

test('a service error after accepted SSE text is surfaced without replay', async t => {
  const { run, requests } = await harness(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Partial observed text.' } }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ error: { code: 503, message: 'Service unavailable.' } }) + '\n\n');
  });
  const events = [];
  await assert.rejects(run({ onEvent: event => events.push(event) }), { code: 'PROVIDER_SERVICE' });
  assert.equal(requests.length, 1);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.delta).join(''), 'Partial observed text.');
  assert.ok(!events.some(event => event.type === 'message' && event.phase === 'final_answer'));
});

test('invalid JSON in a successful response is not retried', async t => {
  const { run, requests } = await harness(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"choices":');
  });
  await assert.rejects(run(), { code: 'PROVIDER_PROTOCOL' });
  assert.equal(requests.length, 1);
});

test('an uncertain network failure is not retried', async t => {
  const { run, requests } = await harness(t, (_request, response) => response.destroy());
  await assert.rejects(run(), { code: 'PROVIDER_NETWORK' });
  assert.equal(requests.length, 1);
});

test('a short Retry-After delta is honored', async t => {
  const { run, requests } = await harness(t, (_request, response, count) => {
    if (count === 1) return json(response, { error: { message: 'Temporary service failure.' } }, 503, { 'Retry-After': '0.08' });
    json(response, completed('Recovered.'));
  });
  await run();
  assert.equal(requests.length, 2);
  assert.ok(requests[1].at - requests[0].at >= 70);
});

test('a short Retry-After HTTP date is honored', async t => {
  let retryAt;
  const { run, requests } = await harness(t, (_request, response, count) => {
    if (count === 1) {
      const header = new Date(Date.now() + 1500).toUTCString();
      retryAt = Date.parse(header);
      return json(response, { error: { message: 'Temporary service failure.' } }, 503, { 'Retry-After': header });
    }
    json(response, completed('Recovered.'));
  });
  await run();
  assert.equal(requests.length, 2);
  assert.ok(requests[1].at >= retryAt - 10, 'the retry must not precede the server date');
});

test('a Retry-After beyond five seconds is surfaced rather than retried early', async t => {
  const { run, requests } = await harness(t, (_request, response) => {
    json(response, { error: { message: 'Try later.' } }, 503, { 'Retry-After': '6' });
  });
  await assert.rejects(run(), { code: 'PROVIDER_SERVICE', httpStatus: 503 });
  assert.equal(requests.length, 1);
});
