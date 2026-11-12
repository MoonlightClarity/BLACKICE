#!/usr/bin/env node
// Opt-in, single-case compatible-API evaluation. No native runtime or live profile.
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ProviderRuntime } from '../lib/providers.mjs';
import { ADVOCACY_CASES, runAdvocacyCase } from './verify-luna-advocacy.mjs';

export const FREE_MODEL_ID = 'nvidia/nemotron-3.5-super-vl:free';
export const FREE_MODEL = 'eval-kilo-free::' + FREE_MODEL_ID;
export const FREE_EVALUATION_BUDGETS = Object.freeze({ providerMaxTokens: 32768, runTimeoutMs: 600000, caseTimeoutMs: 900000, maxSteps: 64 });
// Wire limits are observed from captured requests; the configured ceiling is not
// necessarily the effective output reserve for every kind of provider call.
export function observedFreeEvaluationBudgets(requests = []) {
  const values = withTools => [...new Set(requests.filter(request => request.method === 'POST'
    && Boolean(request.request?.tools?.length) === withTools).map(request => request.request?.max_tokens)
    .filter(Number.isSafeInteger))].sort((a, b) => a - b);
  return { ...FREE_EVALUATION_BUDGETS, observedWireMaxTokens: { withTools: values(true), withoutTools: values(false) } };
}
const BASE_URL = 'https://ai-gateway.kilo.ai/api/v1';
const CATALOG_URL = BASE_URL + '/models';
const COMPLETIONS_URL = BASE_URL + '/chat/completions';
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const zero = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number(value) === 0;

class NoNative extends EventEmitter {
  constructor(calls) { super(); this.calls = calls; }
  status() { return { connected: false, authenticated: false, models: [], isolatedHistory: true }; }
  async start() { this.calls.startCalls++; throw Error('Native startup is unavailable in this isolated API evaluation.'); }
  async runAgent() { this.calls.runCalls++; throw Error('Native model fallback is unavailable in this isolated API evaluation.'); }
  async close() {}
}

// root is an existing isolated directory. Creating api-profile refuses reuse;
// no provider configuration, key, or default is copied from the live app.
export async function createFreeEvaluationRuntime({ root, fetchImpl = globalThis.fetch }) {
  if (!path.isAbsolute(root)) throw Error('Use an absolute isolated output directory.');
  const dataDir = path.join(root, 'api-profile');
  await fs.mkdir(dataDir);
  const requests = [], pending = [], native = { startCalls: 0, runCalls: 0 };
  let catalogVerified = false, runtime;
  const guardedFetch = async (url, options = {}) => {
    const target = String(url), method = options.method || 'GET', headers = new Headers(options.headers);
    if (['authorization', 'api-key', 'x-api-key', 'cookie'].some(name => headers.has(name))) throw Error('Credentials are not permitted in this anonymous evaluation.');
    if (!(method === 'GET' && target === CATALOG_URL || method === 'POST' && target === COMPLETIONS_URL)) throw Error('Only the fixed Kilo catalog and inference endpoints are permitted.');
    const body = options.body ? JSON.parse(options.body) : null;
    if (method === 'POST' && (!catalogVerified || body?.model !== FREE_MODEL_ID)) throw Error('Inference requires the catalog-verified exact free model.');
    const receipt = { id: requests.length + 1, requestedAt: new Date().toISOString(), method, url: target, request: body, headerNames: [...headers.keys()] };
    requests.push(receipt);
    try {
      const response = await fetchImpl(target, { ...options, redirect: 'error' });
      receipt.response = { status: response.status, requestId: response.headers.get('x-request-id'), contentType: response.headers.get('content-type') };
      pending.push(response.clone().text().then(text => {
        receipt.responseBody = text;
        receipt.responseModelIds = [];
        const chunks = text.startsWith('data:') || text.includes('\ndata:') ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()) : [text];
        for (const chunk of chunks) {
          try { const value = JSON.parse(chunk); if (typeof value.model === 'string' && !receipt.responseModelIds.includes(value.model)) receipt.responseModelIds.push(value.model); } catch {}
        }
        receipt.finishedAt = new Date().toISOString();
      }).catch(error => { receipt.captureError = error.message; }));
      return response;
    } catch (error) { receipt.error = error.message; throw error; }
  };
  try {
    const response = await guardedFetch(CATALOG_URL, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error('The public model catalog returned HTTP ' + response.status + '.');
    const body = await response.json(), entry = body.data?.find(model => model.id === FREE_MODEL_ID);
    if (!entry || !zero(entry.pricing?.prompt) || !zero(entry.pricing?.completion)) throw Error('The current catalog must explicitly report zero input and output pricing for the fixed model.');
    const catalog = { url: CATALOG_URL, checkedAt: new Date().toISOString(), model: entry };
    catalogVerified = true;
    runtime = new ProviderRuntime({ codex: new NoNative(native), dataDir, fetchImpl: guardedFetch,
      modelLimitResolver: { enrich: async (_config, models) => models },
      runTimeoutMs: FREE_EVALUATION_BUDGETS.runTimeoutMs, idleTimeoutMs: 60000, requestTimeoutMs: 30000, maxSteps: FREE_EVALUATION_BUDGETS.maxSteps });
    // ProviderStore normally consults profile .env and inherited process values.
    // Disable that resolver on this new instance before init or provider setup.
    runtime.store.diskKey = () => ({ value: '', source: 'none', variable: null });
    await runtime.init();
    await runtime.saveProvider({ id: 'eval-kilo-free', preset: 'kilo_free', type: 'compatible', baseUrl: BASE_URL,
      models: [{ id: FREE_MODEL_ID, contextWindowTokens: entry.context_length,
        ...(Number.isSafeInteger(entry.top_provider?.max_completion_tokens) ? { maxOutputTokens: entry.top_provider.max_completion_tokens } : {}),
        supportsTools: entry.supported_parameters?.includes('tools') === true }],
      maxTokens: FREE_EVALUATION_BUDGETS.providerMaxTokens, maxSteps: FREE_EVALUATION_BUDGETS.maxSteps }, { preserveDefault: true });
    return { runtime, model: FREE_MODEL, modelId: FREE_MODEL_ID, budgets: FREE_EVALUATION_BUDGETS, catalog, requests, native, flush: () => Promise.all(pending) };
  } catch (error) {
    await runtime?.close();
    await Promise.all(pending);
    await fs.writeFile(path.join(root, 'setup-failure.json'), json({ error: error.message, budgets: FREE_EVALUATION_BUDGETS, native, requests }));
    throw error;
  }
}

async function main(args) {
  const options = {};
  if (!args.includes('--live')) throw Error('Explicitly opt in with --live --output-dir NEW_ABSOLUTE_DIRECTORY [--case CASE_ID].');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live') continue;
    if (!['--output-dir', '--case'].includes(args[i]) || !args[i + 1]) throw Error('Unknown or incomplete option: ' + args[i]);
    options[args[i].slice(2)] = args[++i];
  }
  const root = options['output-dir'], caseId = options.case || 'required-nationality-decline';
  if (!root || !path.isAbsolute(root)) throw Error('Supply a new absolute output directory.');
  const item = ADVOCACY_CASES.find(item => item.id === caseId);
  if (!item) throw Error('Unknown case: ' + caseId);
  await fs.mkdir(root);
  const report = { format: 1, transport: 'compatible-api', native: false, model: FREE_MODEL, modelId: FREE_MODEL_ID,
    effort: 'default', planningMode: 'ontology', budgets: FREE_EVALUATION_BUDGETS, case: caseId, startedAt: new Date().toISOString(), status: 'preparing' };
  let setup;
  try {
    setup = await createFreeEvaluationRuntime({ root });
    report.catalog = setup.catalog;
    report.sourceHashes = {};
    for (const file of ['package.json', 'lib/engine.mjs', 'lib/planning-sequence.mjs', 'lib/providers.mjs', 'lib/provider-output-schema.mjs', 'lib/provider-store.mjs', 'skills/planning/SKILL.md', 'scripts/verify-luna-advocacy.mjs', 'scripts/verify-free-advocacy.mjs']) {
      report.sourceHashes[file] = hash(await fs.readFile(new URL('../' + file, import.meta.url)));
    }
    report.status = 'running';
    await fs.writeFile(path.join(root, 'report.json'), json(report));
    console.log(json({ event: 'started', case: caseId, model: FREE_MODEL, transport: report.transport, budgets: FREE_EVALUATION_BUDGETS }).trim());
    const evidence = await runAdvocacyCase({ runtime: setup.runtime, root, item, planningMode: 'ontology', model: FREE_MODEL, effort: 'default', timeoutMs: FREE_EVALUATION_BUDGETS.caseTimeoutMs, runTimeoutMs: FREE_EVALUATION_BUDGETS.runTimeoutMs });
    await setup.flush();
    evidence.budgets = observedFreeEvaluationBudgets(setup.requests);
    const inference = setup.requests.filter(request => request.method === 'POST');
    evidence.apiReceiptIntegrity = inference.some(request => request.response?.status === 200 && request.request?.model === FREE_MODEL_ID && request.request.messages?.some(message => message.role === 'system' && message.content)) &&
      setup.requests.every(request => !request.captureError) && setup.native.startCalls === 0 && setup.native.runCalls === 0;
    await fs.writeFile(path.join(root, caseId + '.json'), json({ ...evidence, transport: 'compatible-api', native: false, modelId: FREE_MODEL_ID }));
    report.runId = evidence.runId; report.assessment = evidence.assessment; report.apiReceiptIntegrity = evidence.apiReceiptIntegrity; report.timedOut = evidence.timedOut;
    report.status = evidence.assessment.objective === 'pass' && evidence.apiReceiptIntegrity ? 'semantic_review_needed' : 'objective_failed';
    if (report.status === 'objective_failed') process.exitCode = 1;
  } catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
  finally {
    await setup?.runtime.close();
    await setup?.flush();
    if (setup) {
      report.budgets = observedFreeEvaluationBudgets(setup.requests);
      report.nativeCalls = setup.native;
      report.inferenceRequests = setup.requests.filter(request => request.method === 'POST').length;
      report.responseModelIds = [...new Set(setup.requests.flatMap(request => request.responseModelIds || []))];
      await fs.writeFile(path.join(root, 'api-requests.json'), json(setup.requests));
    }
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(root, 'report.json'), json(report));
    console.log(json({ event: 'report', status: report.status, path: path.join(root, 'report.json'), error: report.error }).trim());
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
}
