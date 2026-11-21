/**
 * H: read-only public event capture. No browser actions, model starts or success verdict.
 * Interface: --capture-expression; window.__blackiceJobSearchEvidence.bind/summary/snapshot/stop.
 * Limits are explicit; initial records are retained on overflow. Root owns admission/scoring.
 * Acceptance: node --test verification/jobsearch-repro/capture.test.mjs
 */
import { pathToFileURL } from 'node:url';

export function fieldPresence(value, secret = false) {
  const length = value == null ? 0 : typeof value === 'string' ? value.length : JSON.stringify(value).length;
  return { redacted: true, secret, present: length > 0, length };
}
export function cleanText(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted token]')
    .replace(/([?&](?:access_token|refresh_token|token|api_key|secret|password|auth|code)=)[^&#\s"']*/gi, '$1[redacted]')
    .replace(/\b(password|passphrase|passcode|api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1=[redacted]');
}
export function sanitize(value, mode = 'output', depth = 0, limits = {}) {
  if (depth > 28) { limits.depthOmissions = (limits.depthOmissions || 0) + 1; return '[capture depth limit]'; }
  if (typeof value === 'string') {
    if (value.length <= 2000000 && /^\s*[\[{]/.test(value)) {
      try { return sanitize(JSON.parse(value), mode, depth + 1, limits); } catch {}
    }
    const text = cleanText(value);
    if (text.length > 200000) { limits.omittedCharacters = (limits.omittedCharacters || 0) + text.length - 200000; return text.slice(0, 200000) + '\n[capture text limit]'; }
    return text;
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, mode, depth + 1, limits));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  const secretControl = /password|passcode|one.?time.?code|verification.?code|(?:^|\W)otp(?:$|\W)/i.test(
    [value.type, value.autocomplete, value.name, value.label].filter(x => typeof x === 'string').join(' '));
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:reasoning|thinking|analysis|encrypted|reasoningContent|reasoning_content)$/i.test(key)) continue;
    if (/^(?:credentials?|password|passwd|passphrase|passcode|secrets?|access_?token|refresh_?token|token|authorization|cookies?|headers?|otp|api_?key|client_?secret)$/i.test(key))
      out[key] = fieldPresence(item, true);
    else if (key === 'value' || key === 'values')
      out[key] = fieldPresence(item, secretControl);
    else if (mode === 'arguments' && /^(?:text|input|command|script|code|prompt|message|body|content)$/i.test(key))
      out[key] = fieldPresence(item, secretControl);
    else if (/^(?:imageUrl|image_url|dataUrl|data_url|base64|data)$/i.test(key) && typeof item === 'string' && (item.startsWith('data:') || item.length > 200000))
      out[key] = { omitted: 'binary', length: item.length };
    else out[key] = sanitize(item, mode, depth + 1, limits);
  }
  return out;
}
export function publicPhase(phase) { return phase == null || ['commentary', 'final', 'final_answer', 'answer'].includes(phase); }
export function questionCandidate(text) {
  const prose = String(text || '').replace(/https?:\/\/[^\s<>]+/g, '');
  return /\?|\b(?:please|kindly)\s+(?:confirm|provide|tell me|choose|clarify|approve)|\b(?:can|could|would|will)\s+you\b|\b(?:need|require)\s+(?:your|you to)\s+(?:approval|confirmation|input|permission|confirm|provide)/i.test(prose);
}

export function nativeAnswerPages(item) {
  if (!['dynamicToolCall','functionCall'].includes(item?.type) || (item.tool || item.name) !== 'relay_browser' || item.namespace) return [];
  return (item.contentItems || []).flatMap(part => {
    let page = part.text;
    if (typeof page === 'string') { try { page = JSON.parse(page); } catch { return []; } }
    return page?.browser === 'relay' && typeof page.tabId === 'string' ? [page] : [];
  });
}
export function answerEvidence(event, item, history, limits) {
  const raw = event.data.item;
  if (!['dynamicToolCall','functionCall'].includes(raw?.type) || (raw.tool || raw.name) !== 'relay_browser' || raw.namespace) return null;
  let args = raw.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  if (!args || !['fill','type'].includes(args.action)) return null;
  const present = value => typeof value === 'string' && value.trim().length > 0;
  const text = args.text, base = { source:'public-native-tool-arguments', callId:present(raw.id) ? cleanText(raw.id) : null, action:args.action, stage:event.data.stage,
    success:raw.success === true, originalLength:typeof text === 'string' ? text.length : 0, retainedLength:0,
    redacted:true, secret:false, text:fieldPresence(text), textComplete:false, redactionsApplied:false, truncated:false,
    meaning:'Requested text accepted by a native field action is not proof of the final submitted value.' };
  const reject = (reason, secret = false) => ({...base,reason,secret,text:fieldPresence(text,secret)});
  if (raw.success !== true || event.data.stage !== 'completed') return reject('unsuccessful-action');
  if (!present(event.runId) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(event.runId)
      || !present(event.nodeId) || !present(raw.id)) return reject('missing-action-identity');
  const actionTime = Date.parse(event.at);
  if (!Number.isFinite(actionTime)) return reject('missing-action-time');
  if (typeof text !== 'string' || !present(args.tabId) || !present(args.ref)
      || args.browser !== undefined && args.browser !== 'relay') return reject('unresolved-target');
  let prior = null;
  for (let index = history.length - 1; index >= 0; index--) {
    const earlier = history[index];
    if (earlier.runId !== event.runId || earlier.nodeId !== event.nodeId || earlier.data?.stage !== 'completed'
        || earlier.data.item?.success !== true || earlier.data.item.id === raw.id) continue;
    const earlierTime = Date.parse(earlier.at);
    if (Number.isFinite(earlierTime) && earlierTime > actionTime) continue;
    const pages = nativeAnswerPages(earlier.data.item).filter(page => page.tabId === args.tabId);
    if (pages.length) {
      if (!present(earlier.data.item.id) || !Number.isFinite(earlierTime)) return reject('missing-observation-identity');
      if (pages.length !== 1) return reject('ambiguous-observation'); prior = {event:earlier,page:pages[0]}; break;
    }
  }
  if (!prior || !present(prior.page.documentId) || !present(prior.page.url)) return reject('missing-current-observation');
  const observed = prior.page;
  if (Object.hasOwn(args,'expectedDocumentId') && args.expectedDocumentId !== observed.documentId
      || Object.hasOwn(args,'expectedUrl') && args.expectedUrl !== observed.url) return reject('expectation-mismatch');
  const results = nativeAnswerPages(item).filter(page => page.tabId === args.tabId);
  if (results.length !== 1 || results[0].documentId !== observed.documentId || results[0].url !== observed.url) return reject('result-identity-mismatch');
  const returned = results[0], receipt = returned.receipt;
  if (receipt?.[args.action === 'fill' ? 'filled' : 'typed'] !== true || receipt.characters !== text.length
      || returned.inputDispatched === false || returned.actionDispatched === false) return reject('entry-not-confirmed');
  const fields = page => (page.frames || []).flatMap(frame => (frame.elements || [])
    .filter(field => field.ref === args.ref).map(field => ({field,frame:frame.frame})));
  const before = fields(observed), after = fields(returned);
  if (before.length !== 1 || after.length !== 1) return reject('ambiguous-or-missing-field');
  const metadata = field => Object.fromEntries(['ref','tag','type','role','name','label','autocomplete','disabled']
    .filter(key => Object.hasOwn(field,key)).map(key => [key,field[key]]));
  const field = metadata(before[0].field), current = metadata(after[0].field);
  base.field = field;
  base.observed = {runId:event.runId,nodeId:event.nodeId,callId:prior.event.data.item.id,at:prior.event.at,
    tabId:observed.tabId,documentId:observed.documentId,url:observed.url,frame:before[0].frame};
  const secret = /password|passwd|passphrase|passcode|one[\s_-]*time[\s_-]*(?:code|password)|verification[\s_-]*code|security[\s_-]*(?:code|answer|question)|recovery[\s_-]*(?:code|key)|backup[\s_-]*code|api[\s_-]*key|private[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|client[\s_-]*secret|auth(?:entication|orization)?[\s_-]*(?:code|token|key)|(?:^|\W)(?:otp|pin|mfa|2fa|secret|token|credentials?)(?:$|\W)|(?:^|\W)(?:log[\s_-]*in|sign[\s_-]*in|access|sms|e[\s_-]*mail)[\s_-]*code(?:$|\W)/i;
  const codeLabel = /^\W*(?:required\W+)?(?:enter\W+(?:the\W+)?)?code\W*(?:required\W*)?$/i;
  if ([field,current].some(value => secret.test([value.type,value.name,value.label,value.autocomplete].filter(v => typeof v === 'string').join(' '))
      || [value.name,value.label].some(label => typeof label === 'string' && codeLabel.test(label))))
    return reject('secret-field',true);
  if (!['input','textarea'].includes(field.tag) || field.role !== 'textbox' || field.disabled !== false
      || !['text','textarea','search','email','url','tel','number'].includes(field.type) || !present(field.name)) return reject('unknown-field');
  if (JSON.stringify(field) !== JSON.stringify(current) || before[0].frame !== after[0].frame) return reject('changed-field');
  const cleaned = cleanText(text), retained = cleaned.slice(0,200000), truncated = cleaned.length > retained.length;
  if (truncated) limits.omittedAnswerCharacters = (limits.omittedAnswerCharacters || 0) + cleaned.length - retained.length;
  return {...base,text:retained,retainedLength:retained.length,redacted:false,reason:'matched-successful-field-action',
    redactionsApplied:cleaned !== text,truncated,textComplete:cleaned === text && !truncated};
}

export function captureEvent(event, history = []) {
  const d = event?.data, item = d?.item, limits = {};
  if (!d || typeof d !== 'object') return null;
  const message = d.type === 'message' ? d : item?.type === 'agentMessage' && d.stage === 'completed' ? item : null;
  let data;
  if (message) {
    if (!publicPhase(message.phase)) return null;
    data = { type: 'message', itemId: message.itemId || message.id, phase: message.phase,
      text: sanitize(String(message.text || ''), 'output', 0, limits), questionCandidate: questionCandidate(message.text) };
  } else if (d.type === 'item' && ['dynamicToolCall', 'webSearch', 'functionCall', 'mcpToolCall', 'commandExecution', 'fileChange', 'imageGeneration', 'imageView', 'collabAgentToolCall'].includes(item?.type)) {
    const copy = sanitize(item, 'output', 0, limits);
    if (item.arguments !== undefined) copy.arguments = sanitize(item.arguments, 'arguments', 0, limits);
    data = { type: 'item', stage: d.stage, item: copy };
    if (d.stage === 'completed') { const answer = answerEvidence(event, copy, history, limits); if (answer) data.answerEvidence = answer; }
  } else if (d.type === 'item' && !['reasoning', 'userMessage', 'agentMessage', 'contextCompaction'].includes(item?.type)) {
    // Unrecognized public item bodies are not evidence of a completed action.
    limits.unsupportedNativeItems = 1;
    data = { type: 'unsupported.item', stage: ['started', 'completed'].includes(d.stage) ? d.stage : null,
      item: { type: typeof item?.type === 'string' ? cleanText(item.type).slice(0, 200) : null,
        id: typeof item?.id === 'string' ? cleanText(item.id).slice(0, 200) : null } };
  } else if (['tool.result', 'skill_context_submitted', 'skill_context_accepted', 'instruction_context_submitted',
    'instruction_context_accepted', 'chat.execution-review', 'host.final-review', 'provider.final', 'browser.observation'].includes(d.type)) {
    data = sanitize(d, 'output', 0, limits);
  } else return null;
  return { type: event.type, runId: event.runId, nodeId: event.nodeId, at: event.at, data, captureLimitations: limits };
}
export function summarize(events) {
  const messages = new Map(), calls = [], forms = new Map();
  for (const event of events) {
    const d = event.data;
    if (d.type === 'message') messages.set(d.itemId || event.nodeId + ':' + event.at + ':' + d.text,
      { at: event.at, itemId: d.itemId, phase: d.phase, text: d.text, questionCandidate: d.questionCandidate });
    if (d.type !== 'item' || d.stage !== 'completed') continue;
    const item = d.item;
    const pages = (item.contentItems || []).filter(c => c.text?.frames).map(c => c.text);
    const pageSummaries = pages.map(p => {
      const elements = p.frames.flatMap(f => f.elements || []);
      const fields = elements.filter(e => e.tag === 'input' || ['textbox', 'combobox', 'radio', 'checkbox'].includes(e.role));
      const summary = { url: p.url, title: p.title, documentId: p.documentId, controlCount: elements.length,
        fieldCount: fields.length, populatedValueCount: fields.filter(e => e.value?.present === true).length,
        fileControls: elements.filter(e => /(?:delete|remove|preview).*(?:file|resume|résumé)|uploaded/i.test(e.name || '')),
        validation: p.frames.flatMap(f => f.validation || []) };
      if (fields.length && !forms.has(p.url)) forms.set(p.url, { at: event.at, callId: item.id, ...summary });
      return summary;
    });
    calls.push({ at: event.at, callId: item.id, tool: item.tool || item.name || item.type, args: item.arguments,
      success: item.success, pages: pageSummaries });
  }
  return { rawEventCount: events.length, uniquePublicMessageCount: messages.size, publicMessages: [...messages.values()],
    questionCandidates: [...messages.values()].filter(x => x.questionCandidate),
    firstFormObservations: [...forms.values()], completedToolCount: calls.length, lastCalls: calls.slice(-8),
    continuationCount: events.filter(e => e.data.type === 'host.final-review' && e.data.reviewDecision === 'continue').length,
    scoring: 'manual evidence review required; no automatic application-success verdict' };
}
export function createCapture(options = {}) {
  const state = { schemaVersion: 5, redactionPolicy: 'public-native-actions-v5', active: true, runId: null, startedAt: new Date().toISOString(), records: [], bytes: 0, dropped: 0,
    errors: 0, limitationEvents: 0, maxEvents: options.maxEvents ?? 3000, maxBytes: options.maxBytes ?? 16000000,
    source: 'authenticated-app-event-stream' };
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  state.finish = reason => { if (state.active) { state.active = false; state.endedAt = new Date().toISOString(); state.stopReason = reason; } };
  state.ingest = event => {
    if (!state.active || !event?.runId || state.runId && event.runId !== state.runId) return;
    const kept = captureEvent(event, state.records);
    if (!kept) return;
    const size = bytes(kept);
    if (state.records.length >= state.maxEvents || state.bytes + size > state.maxBytes) {
      state.dropped++; state.finish('capacity-limit'); return;
    }
    state.records.push(kept); state.bytes += size;
    if (Object.keys(kept.captureLimitations).length) state.limitationEvents++;
  };
  state.bind = id => {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id || '')) throw Error('Exact run UUID required.');
    if (state.runId && state.runId !== id) throw Error('Capture is already bound to another run.');
    state.runId = id; state.records = state.records.filter(e => e.runId === id);
    state.bytes = state.records.reduce((sum, e) => sum + bytes(e), 0);
    state.limitationEvents = state.records.filter(e => Object.keys(e.captureLimitations).length).length;
    return { active: state.active, boundRunId: id, captured: state.records.length, startedAt: state.startedAt };
  };
  const header = () => {
    if (!state.runId) throw Error('Bind exact admitted run before reading evidence.');
    return { schemaVersion: state.schemaVersion, redactionPolicy: state.redactionPolicy, runId: state.runId, source: state.source, active: state.active, startedAt: state.startedAt,
      readiness: state.readiness || 'unattached', openedAtUTC: state.openedAtUTC || null, readinessError: state.readinessError || null,
      endedAt: state.endedAt, stopReason: state.stopReason, bytes: state.bytes, maxBytes: state.maxBytes,
      maxEvents: state.maxEvents, dropped: state.dropped, errors: state.errors, limitationEvents: state.limitationEvents,
      captureHealthy: state.dropped === 0 && state.errors === 0 && state.limitationEvents === 0 && state.stopReason !== 'time-limit',
      captureComplete: !state.active && state.stopReason === 'observer-finished' && state.dropped === 0 && state.errors === 0 && state.limitationEvents === 0 };
  };
  state.snapshot = () => ({ ...header(), events: structuredClone(state.records) });
  state.summary = () => ({ ...header(), ...summarize(state.records) });
  return state;
}
export async function browserBootstrap() {
  const key = '__blackiceJobSearchEvidence';
  if (window[key]?.active) {
    if (window[key].schemaVersion !== 5) throw Error('Existing observer uses another capture schema; stop it before replacing it.');
    if (!window[key].ready) throw Error('Existing observer has no stream readiness receipt; stop it before replacing it.');
    return { ...(await window[key].ready), alreadyActive: true };
  }
  const state = createCapture();
  state.readiness = 'connecting'; state.openedAtUTC = null; state.openTimeoutMs = 10000;
  let source, timer, openTimer, resolveOpen, rejectOpen;
  state.ready = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  const close = reason => { state.finish(reason); source?.close(); clearTimeout(timer); clearTimeout(openTimer); };
  const failOpen = (code, message) => {
    if (state.readiness !== 'connecting') return;
    state.readiness = 'failed'; state.readinessError = { code, message }; state.errors++;
    close(code); rejectOpen(Object.assign(Error(message), { code }));
  };
  state.stop = () => {
    if (state.readiness === 'connecting') failOpen('stream-open-cancelled', 'Observer stopped before the app event stream opened.');
    else close('observer-finished');
    return state.snapshot();
  };
  window[key] = state;
  try {
    source = new EventSource('/api/events');
    timer = setTimeout(() => close('time-limit'), 45 * 60 * 1000);
    openTimer = setTimeout(() => failOpen('stream-open-timeout', 'The app event stream did not open within 10000 ms.'), state.openTimeoutMs);
    source.onopen = () => {
      if (!state.active || state.openedAtUTC) return;
      state.readiness = 'ready'; state.openedAtUTC = new Date().toISOString(); clearTimeout(openTimer);
      resolveOpen({ schemaVersion: state.schemaVersion, redactionPolicy: state.redactionPolicy, active: true, readiness: state.readiness, openedAtUTC: state.openedAtUTC,
        startedAt: state.startedAt, maxEvents: state.maxEvents, maxBytes: state.maxBytes, openTimeoutMs: state.openTimeoutMs,
        expiresInMs: 45 * 60 * 1000, bind: "window.__blackiceJobSearchEvidence.bind('EXACT_RUN_ID')",
        summary: 'window.__blackiceJobSearchEvidence.summary()', read: 'window.__blackiceJobSearchEvidence.snapshot()',
        stop: 'window.__blackiceJobSearchEvidence.stop()' });
    };
    source.onmessage = message => {
      try { state.ingest(JSON.parse(message.data)); } catch { state.errors++; }
      if (!state.active) close(state.stopReason);
    };
    source.onerror = () => {
      if (state.readiness === 'connecting') failOpen('stream-open-error', 'The app event stream failed before opening.');
      else if (state.active) state.errors++;
    };
  } catch { failOpen('stream-open-error', 'The app event stream could not be created.'); }
  return state.ready;
}
export function captureExpression() {
  return '(() => {\n' + [fieldPresence, cleanText, sanitize, publicPhase, questionCandidate, nativeAnswerPages, answerEvidence, captureEvent, summarize,
    createCapture, browserBootstrap].map(fn => fn.toString()).join('\n') + '\nreturn browserBootstrap();\n})()';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--capture-expression') throw Error('Use --capture-expression.');
  console.log(captureExpression());
}
