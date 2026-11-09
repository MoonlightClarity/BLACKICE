import {receiptBindingsForCriterion} from '../public/planning-contract-model.mjs';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toolResultEvent } from './tool-outcomes.mjs';
import { validNativeSubmissionObservation } from '../desktop/browser-submission-observation.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const check = signal => { if (signal?.aborted) throw signal.reason || Object.assign(new Error('Operation description cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' }); };
const parseArgs = call => { try { const value = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments; return object(value) ? value : {}; } catch { return {}; } };
const browserReads = new Set(['tabs', 'diagnostics', 'snapshot', 'read', 'screenshot', 'downloads', 'wait']);
const browserInteractions = new Set(['open', 'navigate', 'back', 'forward', 'reload', 'hover', 'fill', 'type', 'select', 'scroll', 'upload']);
const browserControls = new Set(['take_ownership', 'transfer_ownership', 'debug_reset', 'stop', 'close', 'folder_create', 'folder_rename', 'folder_close', 'tab_move', 'tab_select', 'suspend']);
const workspaceReads = new Set(['list', 'read', 'search', 'patch_history']);
const workspaceWrites = new Set(['write', 'patch']);
const attachmentReads = new Set(['list', 'read', 'search', 'image', 'read_bytes']);
const navigationKeys = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Escape']);

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}
function urlIdentity(value) {
  const url = normalizedUrl(value);
  if (!url) return null;
  // Preserve the exact normalized query in local task resource identities.
  return url.origin + url.pathname + url.search;
}
function pathApi(value) { return /^[a-z]:[\\/]|^\\\\/i.test(value || '') ? path.win32 : path; }
function normalizedPath(value) {
  const api = pathApi(value), resolved = api.normalize(value).replace(/\\/g, '/');
  return api === path.win32 ? resolved.toLowerCase() : resolved;
}
async function resolvedPath(value, signal) {
  check(signal);
  const api = pathApi(value);
  let cursor = value, rest = [];
  for (let i = 0; i < 100; i++) {
    try { const real = await fs.realpath(cursor); check(signal); return normalizedPath(api.resolve(real, ...rest)); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) return normalizedPath(value);
      const parent = api.dirname(cursor);
      if (parent === cursor) return normalizedPath(value);
      rest.unshift(api.basename(cursor)); cursor = parent;
    }
  }
  return normalizedPath(value);
}
function inside(base, target) { return target === base || target.startsWith(base.replace(/\/$/, '') + '/'); }
function addResource(resources, key, access, scopeOnly = false, scopeKeys = []) {
  if (!key) return;
  const previous = resources.find(item => item.key === key);
  const scopes = [...new Set(scopeKeys.filter(value => typeof value === 'string' && value !== key))];
  if (previous) {
    if (access === 'write' && previous.access !== 'write') { previous.access = 'write'; previous.scopeKeys = scopes; }
    else if (previous.access === access && scopes.length) previous.scopeKeys = [...new Set([...(previous.scopeKeys || []), ...scopes])];
    if (!scopeOnly) delete previous.scopeOnly;
  } else resources.push({ key, access, ...(scopeOnly ? { scopeOnly: true } : {}), ...(scopes.length ? { scopeKeys: scopes } : {}) });
}
function urlScopeKeys(value) {
  const url = normalizedUrl(value);
  if (!url) return [];
  const keys = ['origin:' + url.origin];
  const parts = url.pathname.split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index++) keys.push('url:' + url.origin + '/' + parts.slice(0, index).join('/') + (index ? '/' : ''));
  return [...new Set(keys)];
}
function addUrlResources(resources, value, access, destination = false) {
  const url = normalizedUrl(value), identity = urlIdentity(value);
  if (!url || !identity) return [];
  const scopes = urlScopeKeys(value);
  for (const key of scopes) addResource(resources, key, access, true);
  addResource(resources, 'url:' + identity, access, false, scopes);
  if (destination) addResource(resources, 'destination:' + identity, access, false, ['url:' + identity, ...scopes]);
  return ['url:' + identity, ...(destination ? ['destination:' + identity] : []), ...scopes];
}
function tabObservation(observation, args) {
  if (!object(observation)) return null;
  if (Array.isArray(observation.tabs)) {
    if (!text(args.tabId)) return null;
    return observation.tabs.find(tab => tab?.tabId === args.tabId && tab.browser !== 'firefox') || null;
  }
  if (args.tabId && observation.tabId !== args.tabId) return null;
  return text(observation.tabId) ? observation : null;
}
function formCommit(observation, args) {
  const control = observation?.control, form = control?.form;
  // This branch is available only to a fresh adapter observation, not call JSON.
  if (observation?.current !== true || control?.kind !== 'form-submit' || !object(form)
    || !text(observation.documentId) || form.documentId !== observation.documentId
    || form.method !== 'POST' || !text(form.enctype) || !text(form.target)
    || !text(form.id) || !sha(form.payloadDigest) || !Array.isArray(form.attachmentDigests)
    || form.attachmentDigests.some(value => !sha(value))
    || args.ref && control.ref !== args.ref
    || !['click', 'press'].includes(args.action)
    || args.action === 'press' && args.key !== 'Enter') return null;
  const destination = urlIdentity(form.action);
  if (!destination) return null;
  const documentKey = 'document:' + observation.documentId;
  const formKey = 'form:' + digest([documentKey, form.id]);
  const destinationKey = 'destination:' + destination;
  const payloadDigest = sha(form.payloadDigest), attachmentDigests = form.attachmentDigests.map(sha);
  const identityDigests = Array.isArray(form.identityDigests) ? form.identityDigests.filter(item => object(item) && text(item.name) && sha(item.digest)).map(item => ({ name: item.name, digest: sha(item.digest) })) : [];
  return { effectKey: digest([destinationKey, payloadDigest, attachmentDigests]), destinationKey, formKey, documentKey, payloadDigest, attachmentDigests, method: form.method, enctype: form.enctype, target: form.target, ...(sha(form.requestPayloadDigest) ? { requestPayloadDigest: sha(form.requestPayloadDigest) } : {}), ...(identityDigests.length ? { identityDigests } : {}) };
}

export const attachmentSetResourceKey = ids => ids.length ? 'attachments:' + digest([...new Set(ids)].sort()) : null;
export const attachmentResourceKey = value => sha(value) ? 'attachment:sha256:' + sha(value) : null;

/** Authoritative adapter semantics. Caller-supplied readOnly, labels and operation text never grant an effect class. */
export async function describeHostOperation(call, { cwd, browserObservation, workspaceObservation, attachmentObservation, attachments, signal } = {}) {
  check(signal);
  const args = parseArgs(call), name = text(call?.name) || text(call?.tool) || 'unknown', resources = [];
  let effect = 'opaque', commit, hostBinding;
  if (!call?.namespace && name === 'relay_workspace') {
    const savedPatchPath = args.action === 'undo_patch' && workspaceObservation?.patchId === args.patchId && text(workspaceObservation.path) && pathApi(workspaceObservation.path).isAbsolute(workspaceObservation.path) ? workspaceObservation.path : null;
    effect = workspaceReads.has(args.action) ? 'observe' : workspaceWrites.has(args.action) || savedPatchPath ? 'interact' : 'opaque';
    const access = effect === 'observe' ? 'read' : 'write';
    if (text(cwd) && pathApi(cwd).isAbsolute(cwd)) {
      const api = pathApi(cwd), base = await resolvedPath(args.cwd && text(args.cwd) ? api.resolve(cwd, args.cwd) : cwd, signal);
      // undo_patch's target belongs to its stored receipt, not a model path override.
      const suppliedPath = args.action === 'undo_patch' ? savedPatchPath : text(args.path);
      const target = suppliedPath ? await resolvedPath(api.resolve(base, suppliedPath), signal) : base;
      if (args.action !== 'undo_patch' || savedPatchPath) {
      if (inside(base, target)) addResource(resources, 'workspace:' + base, access, true);
      const targetScopes = inside(base, target) ? ['workspace:' + base] : [];
      let parent = pathApi(target).dirname(target).replace(/\\/g, '/');
      while (parent !== target && inside(base, parent)) {
        addResource(resources, 'path:' + parent, access, true); targetScopes.push('path:' + parent);
        const next = pathApi(parent).dirname(parent).replace(/\\/g, '/');
        if (next === parent) break;
        parent = next;
      }
      addResource(resources, 'path:' + target, access, false, targetScopes);
      }
      if (args.action === 'undo_patch' && text(args.patchId)) addResource(resources, 'patch:' + args.patchId, 'write', true);
    }
  } else if (!call?.namespace && name === 'relay_files' && attachmentReads.has(args.action)
      && /^attachments:[a-f0-9]{64}$/.test(attachmentObservation?.scopeKey || '')) {
    const { scopeKey, entry } = attachmentObservation;
    const key = args.action === 'list' ? scopeKey : entry && entry.id === args.attachmentId ? attachmentResourceKey(entry.sha256) : null;
    if (key) {
      effect = 'observe';
      addResource(resources, key, 'read', false, [scopeKey]);
    }
  } else if (!call?.namespace && name === 'relay_browser') {
    // Tab inventory describes the browser, even when a caller supplies a tab
    // hint. It neither observes that page's content nor inherits its scopes.
    const observed = args.action === 'tabs' ? null : tabObservation(browserObservation, args);
    // Explicit HTTP navigation reads a destination while still mutating the local tab.
    // It must remain available to reconcile an uncertain submission from history.
    const explicitGetNavigation = ['open', 'navigate'].includes(args.action) && Boolean(normalizedUrl(args.url));
    effect = explicitGetNavigation || browserReads.has(args.action) || args.action === 'protection' && (!args.operation || args.operation === 'status')
      ? 'observe' : browserInteractions.has(args.action) ? 'interact' : browserControls.has(args.action) ? 'control' : 'opaque';
    if (args.action === 'press' && navigationKeys.has(args.key) && !args.modifiers?.length) effect = 'interact';
    if (args.action === 'interaction' && ['dismiss', 'acknowledge'].includes(args.decision)) effect = 'interact';
    // Ref-free input has no inspected control; two missing refs are not a match.
    if (['click', 'press'].includes(args.action) && observed?.current === true && object(observed.control) && text(args.ref) && observed.control.ref === args.ref) {
      if (observed.control.kind === 'field') effect = 'interact';
      else if (observed.control.kind === 'link' && normalizedUrl(observed.control.href)) effect = 'interact';
      else if (observed.control.kind === 'form-navigation' && ['GET', 'HEAD'].includes(observed.control.form?.method)
        && observed.control.form?.documentId === observed.documentId && normalizedUrl(observed.control.form?.navigationUrl)) effect = 'interact';
    }
    if (observed?.current === true && observed.control?.ref === args.ref && observed.control?.form) {
      const value = observed.control.form;
      hostBinding = { documentId: observed.documentId, formId: value.id, kind: observed.control.kind, action: value.action,
        method: value.method, enctype: value.enctype, target: value.target, payloadDigest: value.payloadDigest };
    }
    commit = formCommit(observed, args);
    if (commit) effect = 'commit';
    const access = effect === 'observe' ? 'read' : 'write';
    const tabAccess = explicitGetNavigation ? 'write' : access;
    if (observed) {
      const navigationTarget = ['open', 'navigate'].includes(args.action) ? args.url
        : ['click', 'press'].includes(args.action) && observed.current === true && observed.control?.kind === 'link' ? observed.control.href
        : ['click', 'press'].includes(args.action) && observed.current === true && observed.control?.kind === 'form-navigation' ? observed.control.form?.navigationUrl : null;
      const targetScopes = navigationTarget ? addUrlResources(resources, navigationTarget, access, true)
        : addUrlResources(resources, observed.url, access);
      if (text(observed.tabId)) addResource(resources, 'tab:' + observed.tabId, tabAccess, false, targetScopes);
      if (text(observed.documentId)) addResource(resources, 'document:' + observed.documentId, tabAccess, false, targetScopes);
      if (navigationTarget) addUrlResources(resources, observed.url, 'read');
    }
    if (['open', 'navigate'].includes(args.action)) {
      const targetScopes = addUrlResources(resources, args.url, access, true);
      if (!observed && text(args.tabId)) addResource(resources, 'tab:' + args.tabId, tabAccess, false, targetScopes);
    }
    if (commit) {
      const targetScopes = addUrlResources(resources, observed.control.form.action, 'write', true);
      addResource(resources, commit.formKey, 'write', false, targetScopes);
    }
    // Upload digests are accepted only from the host attachment registry.
    if (args.action === 'upload' && Array.isArray(attachments)) for (const file of attachments) {
      if (object(file) && sha(file.sha256) && text(file.path) && Array.isArray(args.paths) && args.paths.includes(file.path))
        addResource(resources, attachmentResourceKey(file.sha256), 'read');
    }
    if (!observed && !['open', 'navigate'].includes(args.action)) addResource(resources, 'browser:relay', access);
  }
  if (!resources.length) addResource(resources, 'tool:' + (call?.namespace ? call.namespace + '/' : '') + name, effect === 'observe' ? 'read' : 'write');
  resources.sort((a, b) => a.key.localeCompare(b.key));
  check(signal);
  return { version: 1, effect, resources, operationKey: digest({ namespace: call?.namespace || null, name, args, effect, resources, ...(hostBinding ? { hostBinding } : {}), ...(commit ? { commit } : {}) }), ...(commit ? { commit } : {}) };
}

function operationalBody(result) {
  const ordinary = [];
  for (const item of result?.contentItems || []) if (item?.type === 'inputText' && typeof item.text === 'string') {
    try {
      const value = JSON.parse(item.text);
      if (object(value) && !String(value.type || '').startsWith('planning.')) return value;
    } catch { ordinary.push(item.text); }
  }
  return { text: ordinary.join('\n') };
}
function sourceEvidence(body, descriptor, call) {
  const args = parseArgs(call), kind = 'observation';
  const resource = descriptor.resources.find(item => !item.scopeOnly && item.key.startsWith(call?.name === 'relay_workspace' ? 'path:' : 'document:'))
    || descriptor.resources.find(item => !item.scopeOnly && item.key.startsWith('url:'))
    || descriptor.resources.find(item => !item.scopeOnly) || descriptor.resources[0];
  const contentDigest = digest(body);
  const browserProgress = call?.name === 'relay_browser' && text(body.url) ? digest({
    url: body.url, title: body.title,
    frames: Array.isArray(body.frames) ? body.frames.map(frame => ({ url: frame.url, text: frame.text, semanticRecords: frame.semanticRecords })) : undefined,
  }) : null;
  const attachmentVersion = call?.name === 'relay_files' && resource.key.startsWith('attachment:sha256:') ? sha(resource.key.slice('attachment:sha256:'.length)) : null;
  const sourceVersion = text(body.documentId) ? body.documentId : attachmentVersion || sha(body.sha256 || body.afterHash);
  const evidence = [{ kind, resourceKey: resource.key, digest: contentDigest,
    ...(sourceVersion ? { sourceVersion } : {}),
    validation: { adapter: call?.name || 'unknown', action: typeof args.action === 'string' ? args.action : 'call', success: true, domainConfirmation: false,
      ...(browserProgress ? { browserProgress } : {}) } }];
  const deliveredLines = typeof body.content === 'string' && body.content ? body.content.split('\n') : [];
  const deliveredRange = deliveredLines.length === body.endLine - body.startLine + 1 && deliveredLines.every((line, index) => line.startsWith(String(body.startLine + index) + ': '));
  if (!call?.namespace && call?.name === 'relay_workspace' && args.action === 'read' && sha(body.sha256) && deliveredRange
    && Number.isSafeInteger(body.startLine) && Number.isSafeInteger(body.endLine) && Number.isSafeInteger(body.totalLines)
    && body.startLine >= 1 && body.endLine >= body.startLine - 1 && body.endLine <= body.totalLines) {
    evidence.push({ kind: 'source-coverage', resourceKey: resource.key, sourceVersion: sha(body.sha256), digest: contentDigest,
      coverage: { unit: 'lines', start: body.startLine - 1, end: body.endLine, total: body.totalLines },
      validation: { adapter: 'relay_workspace', action: 'read', success: true } });
  }
  return evidence;
}


/** Stable key for a validated declarative binding; never an effect identity. */
export const browserReceiptBindingKey = binding => digest(binding);
function matchingObservedResource(key, observation) {
  if (typeof key !== 'string' || !observation?.current) return false;
  const url = normalizedUrl(observation.url), identity = urlIdentity(observation.url);
  return Boolean(url && (key === 'origin:' + url.origin || key === 'url:' + identity || key === 'destination:' + identity
    || key === 'document:' + observation.documentId || key === 'tab:' + observation.tabId));
}
function subjectOutcomeId(destinationKey, fields, issuerId) {
  const subjects = new Map();
  for (const field of fields) {
    if (!text(field?.name) || !sha(field?.digest) || subjects.has(field.name) && subjects.get(field.name) !== field.digest) return null;
    subjects.set(field.name, field.digest);
  }
  const identity = subjects.size ? { fields: [...subjects].sort(([left], [right]) => left.localeCompare(right)) } : { issuerId };
  return 'destination-outcome:' + digest([destinationKey, identity]);
}
function admittedCommitments(commitments) {
  return (Array.isArray(commitments) ? commitments : []).filter(item => ['dispatched', 'returned', 'interrupted'].includes(item?.deliveryState));
}
function currentNativeSubmissions(browserObservation, commitments) {
  if (browserObservation?.current !== true || !text(browserObservation.documentId)) return [];
  const admitted = admittedCommitments(commitments), records = [...(Array.isArray(browserObservation.submissionCorrelations) ? browserObservation.submissionCorrelations : [])];
  for (const item of admitted) for (const proof of item.evidence || []) if (proof?.kind === 'observation' && proof.validation?.source === 'native-form-navigation')
    records.push(proof.validation.correlation);
  const unique = new Map();
  for (const correlation of records) {
    if (!validNativeSubmissionObservation(correlation) || correlation.documentId !== browserObservation.documentId
      || correlation.frameId !== browserObservation.frameId || correlation.loaderId !== browserObservation.loaderId
      || correlation.responseUrl !== urlIdentity(browserObservation.url)) continue;
    const matches = admitted.filter(item => item.operationId === correlation.operationId && item.commit?.effectKey === correlation.effectKey
      && item.commit.destinationKey === correlation.destinationKey && item.commit.payloadDigest === correlation.payloadDigest
      && item.commit.requestPayloadDigest === correlation.requestPayloadDigest && item.commit.documentKey === 'document:' + correlation.sourceDocumentId);
    if (matches.length !== 1) continue;
    unique.set(digest(correlation), { correlation, commitment: matches[0] });
  }
  return [...unique.values()];
}
function nativeSubmissionEvidence(matches, browserObservation) {
  return matches.map(({ correlation }) => ({ kind: 'observation', resourceKey: correlation.destinationKey,
    sourceVersion: browserObservation.documentId, digest: digest(correlation),
    validation: { adapter: 'relay_browser', source: 'native-form-navigation', correlation } }));
}
function nativeTextReceiptEvidence({ browserObservation, criteria, matches, call, commitments }) {
  if (matches.length !== 1 || !Array.isArray(browserObservation?.receipts)) return [];
  const { correlation, commitment } = matches[0], candidates = [];
  for (const criterion of (Array.isArray(criteria) ? criteria : []).slice(0, 200)) for(const binding of receiptBindingsForCriterion(criterion)) {
    if (criterion?.kind !== 'external-confirmation' || binding?.version !== 1 || binding.format !== 'dom-text' || binding.history !== false
      || !matchingObservedResource(binding.resourceKey, browserObservation) || !Array.isArray(binding.outcomeFields)
      || !binding.outcomeFields.length || binding.outcomeFields.length > 20 || new Set(binding.outcomeFields).size !== binding.outcomeFields.length) continue;
    const key = browserReceiptBindingKey(binding), batches = browserObservation.receipts.filter(item => item?.bindingKey === key);
    if (batches.length !== 1 || batches[0].records?.length !== 1) continue;
    const record = batches[0].records[0], status = record?.status;
    if (record?.ambiguous || !text(status) || status.length > 200 || status !== status.replace(/\s+/g, ' ').trim()) continue;
    const confirmed = Array.isArray(binding.confirmedValues) && binding.confirmedValues.includes(status);
    const absent = Array.isArray(binding.absentValues) && binding.absentValues.includes(status);
    if (confirmed === absent || confirmed && (correlation.responseStatus < 200 || correlation.responseStatus >= 300)) continue;
    const fields = binding.outcomeFields.map(name => {
      const values = (commitment.commit.identityDigests || []).filter(item => item?.name === name && sha(item.digest));
      return values.length === 1 ? values[0] : null;
    });
    if (fields.some(value => !value)) continue;
    const outcomeId = subjectOutcomeId(correlation.destinationKey, fields);
    if (!outcomeId) continue;
    const priorFacts=(commitments||[]).flatMap(item=>item.evidence||[]).filter(proof=>proof?.validation?.source==='host-correlated-native-form-text'&&proof.validation.operationId===commitment.operationId&&proof.validation.requestId===correlation.requestId&&proof.validation.documentId===correlation.documentId);
    if(priorFacts.some(proof=>proof.confirmation?.outcomeId!==outcomeId||proof.confirmation?.status!==(confirmed?'confirmed':'absent'))){candidates.push({_receiptConflict:criterion.id});continue;}
    candidates.push({ _receiptCriterionId:criterion.id, kind: 'external-confirmation', resourceKey: criterion.resourceKey || binding.resourceKey,
      sourceVersion: browserObservation.documentId, digest: digest({ key, status, correlation, outcomeId }),
      confirmation: { outcomeId, effectKey: commitment.commit.effectKey, status: confirmed ? 'confirmed' : 'absent' },
      validation: { adapter: 'relay_browser', action: parseArgs(call).action || 'read', source: 'host-correlated-native-form-text',
        bindingDigest: key, receiptStatus: status, destinationKey: correlation.destinationKey, outcomeBasis: 'observed-form-identity',
        operationId: commitment.operationId, requestId: correlation.requestId, documentId: correlation.documentId } });
  }
  return candidates;
}

function observedRecordSourceDigest(source, format) {
  if (typeof source !== 'string' || !source || source.length > 16384) return null;
  try {
    const value = JSON.parse(source);
    if (!object(value) || value.version !== 1 || value.format !== format || !object(value.record)
      || Object.keys(value).sort().join(',') !== 'format,record,version') return null;
    if (format === 'dom' && (!object(value.record.attributes) || typeof value.record.text !== 'string'
      || Object.keys(value.record).sort().join(',') !== 'attributes,text'
      || Object.entries(value.record.attributes).some(([name, field]) => !name.startsWith('data-') || typeof field !== 'string'))) return null;
    let nodes = 0;
    const bounded = (item, depth = 0) => {
      if (++nodes > 2048 || depth > 12) return false;
      if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return true;
      if (typeof item === 'string') return item.length <= 8192;
      if (!item || typeof item !== 'object') return false;
      const keys = Object.keys(item);
      return keys.length <= 256 && keys.every(key => key.length <= 256 && bounded(item[key], depth + 1));
    };
    if (!bounded(value.record) || JSON.stringify(canonical(value)) !== source) return null;
    return digest(value);
  } catch { return null; }
}

function receiptEvidence({ browserObservation, criteria, commitments, baselineCommitments = [], descriptor, call }) {
  if (browserObservation?.current !== true || !text(browserObservation.documentId) || !Array.isArray(browserObservation.receipts)) return [];
  const candidates = [];
  for (const criterion of (Array.isArray(criteria) ? criteria : []).slice(0, 200)) for(const binding of receiptBindingsForCriterion(criterion)) {
    if (criterion?.kind !== 'external-confirmation' || !object(binding) || binding.version !== 1
      || !['dom', 'json'].includes(binding.format) || !matchingObservedResource(binding.resourceKey, browserObservation)) continue;
    const key = browserReceiptBindingKey(binding);
    const batches = browserObservation.receipts.filter(item => item?.bindingKey === key);
    if (batches.length !== 1 || !Array.isArray(batches[0].records) || batches[0].records.length > 100) continue;
    for (const observedRecord of batches[0].records) {
      if (!object(observedRecord)) continue;
      // Keep legacy extracted-record digests unchanged; source metadata is a separate fact.
      const { recordSource, ...record } = observedRecord;
      const recordSourceDigest = observedRecordSourceDigest(recordSource, binding.format);
      if (record.ambiguous === true || !text(record.status) || !text(record.outcomeId) || record.outcomeId.length > 2048) continue;
      const confirmed = Array.isArray(binding.confirmedValues) && binding.confirmedValues.includes(record.status);
      const absent = Array.isArray(binding.absentValues) && binding.absentValues.includes(record.status);
      if (confirmed === absent) continue;
      let destinationKey = null;
      try {
        const destination = binding.destination ? record.destination : browserObservation.url;
        if (text(destination)) {
          const absolute = new URL(destination, browserObservation.url).href;
          const normalized = urlIdentity(absolute);
          if (normalized) destinationKey = 'destination:' + normalized;
        }
      } catch { /* No destination identity means no effect alias. */ }
      const recordDigest = digest({ key, record, destinationKey });
      if (!destinationKey) continue;
      const identities = Array.isArray(binding.identity) ? binding.identity : [];
      const values = Array.isArray(record.identityValues) ? record.identityValues : [];
      const subjectFields = identities.map(identity => {
        const observed = values.filter(value => value?.name === identity.formField && value?.field === identity.field && typeof value.value === 'string');
        return observed.length === 1 ? { name: identity.formField, digest: digest(observed[0].value) } : null;
      });
      if (subjectFields.some(value => !value)) continue;
      const outcomeId = subjectOutcomeId(destinationKey, subjectFields, record.outcomeId);
      if (!outcomeId) continue;
      // Host-observed prospective form identities may establish a baseline without dispatch.
      // They never enter native submission correlation or count as new effects.
      const admitted = [...admittedCommitments(commitments), ...baselineCommitments.filter(item => item.baseline === true)];
      // A binding refinement cannot turn an old issuer record into a new effect.
      // Rehash its actual extracted bytes with each retained host binding key;
      // the predicate may change, but the original effect and meaning cannot.
      let retainedFactConflict = false;
      const meaning = confirmed ? 'confirmed' : 'absent';
      const markedPrior = Boolean(binding.prior && Array.isArray(binding.prior.values) && binding.prior.values.includes(record.prior));
      const retainedAliases = new Set(admitted.flatMap(item => (Array.isArray(item?.evidence) ? item.evidence : []).flatMap(proof => {
        const bindingDigest = sha(proof?.validation?.bindingDigest);
        if (proof?.kind !== 'external-confirmation' || !bindingDigest
          || proof.confirmation?.effectKey !== item?.commit?.effectKey || !sha(item?.commit?.effectKey)) return [];
        // Only two complete observed facts can distinguish successive receipts.
        // Missing metadata, the same fact, or a format change keeps the old guard.
        const savedSourceDigest = sha(proof.validation?.recordSourceDigest);
        if (recordSourceDigest && savedSourceDigest && proof.validation?.format === binding.format && recordSourceDigest !== savedSourceDigest) return [];
        if (proof.digest === digest({ key: bindingDigest, record, destinationKey })) {
          if (proof.confirmation.outcomeId !== outcomeId || proof.confirmation.status !== meaning || Boolean(proof.confirmation.prior) !== markedPrior) {
            retainedFactConflict = true; return [];
          }
          return [item.commit.effectKey];
        }
        // Changed identity ordering or extraction may prevent an exact digest
        // match. The same issuer fact is then ambiguous, never a fresh alias.
        if (bindingDigest !== key && proof.validation?.destinationKey === destinationKey
          && proof.validation?.rawOutcomeId === record.outcomeId && proof.validation?.receiptStatus === record.status) {
          const differentSubject = subjectFields.some(field => {
            const saved = (Array.isArray(item.commit.identityDigests) ? item.commit.identityDigests : []).filter(value => value?.name === field.name && sha(value.digest));
            return saved.length === 1 && sha(saved[0].digest) !== field.digest;
          });
          if (!differentSubject) retainedFactConflict = true;
        }
        return [];
      })));
      if (retainedFactConflict || retainedAliases.size > 1) {candidates.push({_receiptConflict:criterion.id});continue;}
      const matches = identities.length && destinationKey ? admitted.filter(item => {
        const commit = item?.commit;
        if (!text(item?.operationId) || !object(commit) || commit.destinationKey !== destinationKey || !sha(commit.effectKey) || !Array.isArray(commit.identityDigests)) return false;
        if (retainedAliases.size ? !retainedAliases.has(commit.effectKey) : item.effectState === 'absent') return false;
        return identities.every(identity => {
          const observed = values.filter(value => value?.name === identity.formField && value?.field === identity.field);
          const saved = commit.identityDigests.filter(value => value?.name === identity.formField && sha(value.digest));
          return observed.length === 1 && typeof observed[0].value === 'string' && saved.length === 1 && digest(observed[0].value) === sha(saved[0].digest);
        });
      }) : [];
      // Multiple admitted effects with the same incomplete identity cannot be guessed.
      const unique = new Map(matches.map(item => [item.commit.effectKey, item]));
      if (unique.size > 1) continue;
      const match = unique.size === 1 ? [...unique.values()][0] : null;
      if (!match && binding.history !== true) continue;
      if (absent && !match) continue; // An empty or unrelated history never proves absence.
      const prior = !match || match.baseline === true || binding.prior && Array.isArray(binding.prior.values) && binding.prior.values.includes(record.prior);
      const confirmation = { outcomeId, ...(match ? { effectKey: match.commit.effectKey } : {}),
        status: confirmed ? 'confirmed' : 'absent', ...(prior ? { prior: true } : {}) };
      const resourceKey = criterion.resourceKey || binding.resourceKey;
      const proof = { _receiptCriterionId:criterion.id, kind: 'external-confirmation', resourceKey, sourceVersion: browserObservation.documentId,
        digest: recordDigest, confirmation,
        validation: { adapter: 'relay_browser', action: parseArgs(call).action || 'read', documentId: browserObservation.documentId,
          bindingDigest: key, format: binding.format, source: 'observed-destination-record', receiptStatus: record.status,
          ...(recordSourceDigest ? { recordSourceDigest } : {}),
          rawOutcomeId: record.outcomeId, outcomeBasis: subjectFields.length ? 'observed-form-identity' : 'issuer-identity', ...(destinationKey ? { destinationKey } : {}) } };
      candidates.push(proof);
    }
  }
  return candidates;
}

function consistentReceiptEvidence(candidates){
  const rejected=new Set(candidates.filter(item=>item._receiptConflict).map(item=>item._receiptConflict)),groups=new Map();
  for(const item of candidates){if(item._receiptConflict||rejected.has(item._receiptCriterionId))continue;const key=item.confirmation?.effectKey||JSON.stringify([item.validation?.destinationKey,item.confirmation?.outcomeId]);const values=groups.get(key)||[];values.push(item);groups.set(key,values);}
  const output=[];
  for(const values of groups.values()){
    if(new Set(values.map(item=>JSON.stringify(item.confirmation))).size!==1)continue;
    const distinct=new Map();for(const item of values){const {_receiptCriterionId,...proof}=item;const key=JSON.stringify([proof.resourceKey,proof.confirmation]);if(!distinct.has(key))distinct.set(key,proof);}output.push(...distinct.values());
  }return output;
}

/** Tool completion is not business completion. No page prose or model claim creates a confirmation. */
export async function normalizeHostOperationResult(result, { call, descriptor, cwd, browserObservation, workspaceObservation, criteria, commitments, baselineCommitments = [], signal } = {}) {
  if (!descriptor) descriptor = await describeHostOperation(call, { cwd, browserObservation, workspaceObservation, signal });
  const body = operationalBody(result), event = toolResultEvent(call, result), observing = descriptor.effect === 'observe';
  const nativeAdapter = !call?.namespace && ['relay_browser', 'relay_workspace'].includes(call?.name);
  const explicitlyAbsent = nativeAdapter && (body.actionDispatched === false || body.inputDispatched === false);
  if (!event.success) return { effectState: observing ? 'not-applicable' : explicitlyAbsent ? 'absent' : 'unknown', evidence: [] };
  if (explicitlyAbsent && !observing) return { effectState: 'absent', evidence: [] };
  const evidence = sourceEvidence(body, descriptor, call);
  if (call?.name === 'relay_browser' && !call.namespace) {
    const matches = currentNativeSubmissions(browserObservation, commitments);
    // Incomplete extraction of a matching alternative cannot authorize first-match success.
    criteria=(criteria||[]).filter(criterion=>!criterion.receiptBindings||receiptBindingsForCriterion(criterion).every(binding=>{if(!matchingObservedResource(binding.resourceKey,browserObservation))return true;const batches=(browserObservation?.receipts||[]).filter(batch=>batch.bindingKey===browserReceiptBindingKey(binding));return batches.length===1&&!batches[0].unavailable&&!batches[0].overflow&&Array.isArray(batches[0].records)&&batches[0].records.length<=100;}));
    evidence.push(...nativeSubmissionEvidence(matches, browserObservation),
      ...consistentReceiptEvidence([...receiptEvidence({ browserObservation, criteria, commitments, baselineCommitments, descriptor, call }),
      ...nativeTextReceiptEvidence({ browserObservation, criteria, matches, call, commitments })]));
  }
  const ownConfirmation = descriptor.commit && evidence.find(item => item.confirmation?.effectKey === descriptor.commit.effectKey)?.confirmation;
  const frames = nativeAdapter && call.name === 'relay_browser' ? [body, ...(Array.isArray(body.frames) ? body.frames : [])] : [];
  const validation = frames.flatMap(frame => [
    ...(Array.isArray(frame.validation) ? frame.validation.map(item => ({ name: item?.name, message: item?.message })) : []),
    ...(Array.isArray(frame.semanticRecords) ? frame.semanticRecords.filter(item => ['alert', 'status'].includes(item?.attributes?.role)).map(item => ({ status: item.text })) : []),
  ]);
  const progressKey = descriptor.commit && (validation.length || ownConfirmation)
    ? digest({ destinationKey: descriptor.commit.destinationKey, payloadDigest: descriptor.commit.payloadDigest,
      attachmentDigests: descriptor.commit.attachmentDigests, validation, confirmation: ownConfirmation?.status || null }) : undefined;
  return { effectState: observing ? 'not-applicable' : descriptor.effect === 'commit' ? ownConfirmation?.status || 'unconfirmed' : 'confirmed',
    evidence, ...(progressKey ? { progressKey } : {}) };
}
