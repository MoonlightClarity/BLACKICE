import { safeNativeImageItem } from '../../lib/native-image-artifacts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { captureEvent, createCapture, captureExpression, questionCandidate, sanitize } from './capture.mjs';
const run = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
function event(data, runId = run) { return { type: 'agent.event', runId, nodeId: 'agent', at: '2026-11-21T00:00:00Z', data }; }
function tool(elements) { return event({ type: 'item', stage: 'completed', item: { type: 'dynamicToolCall', id: 'call1', tool: 'relay_browser', success: true,
  arguments: { action: 'snapshot', tabId: 'tab1' }, contentItems: [{ type: 'text', text: JSON.stringify({ url: 'https://employer.test/apply?pid=1',
    title: 'Application', frames: [{ elements, text: 'Work authorization and privacy policy' }] }) }] } }); }

test('preserves all 125 controls and initial attachment metadata beyond old 80 limit', () => {
  const controls = Array.from({ length: 125 }, (_, i) => ({ ref: 'r' + i, role: 'textbox', tag: 'input', name: 'Field ' + i, value: i ? '' : 'actual name' }));
  controls[121] = { ref: 'r121', role: 'button', name: 'Preview file: existing.pdf' };
  const c = createCapture(); c.bind(run); c.ingest(tool(controls));
  const p = c.snapshot().events[0].data.item.contentItems[0].text;
  assert.equal(p.frames[0].elements.length, 125);
  assert.equal(p.frames[0].elements[121].name, 'Preview file: existing.pdf');
  assert.deepEqual(p.frames[0].elements[0].value, { redacted: true, secret: false, present: true, length: 11 });
  assert.equal(c.summary().firstFormObservations[0].fileControls[0].ref, 'r121');
  assert.equal(c.summary().firstFormObservations[0].populatedValueCount, 1);
  assert.equal(c.limitationEvents, 0);
});
test('retains legal authorization prose while redacting secrets and argument values', () => {
  const out = sanitize({ text: 'Do you have work authorization? Review the privacy policy.', password: 'secret', headers: { Authorization: 'Bearer tok' },
    control: { name: 'One-time code', type: 'text', value: '123456' }, note: 'password=abc123 Bearer xyz123' });
  assert.match(out.text, /work authorization/);
  assert.equal(out.password.present, true); assert.equal(out.control.value.secret, true);
  assert.doesNotMatch(JSON.stringify(out), /abc123|xyz123|123456|Bearer tok/);
  const args = captureEvent(event({ type: 'item', stage: 'completed', item: { type: 'dynamicToolCall', arguments: { action: 'fill', text: 'Dylan', ref: 'r1' } } })).data.item.arguments;
  assert.deepEqual(args.text, { redacted: true, secret: false, present: true, length: 5 }); assert.equal(args.ref, 'r1');
});
test('omits private reasoning events and private object keys', () => {
  assert.equal(captureEvent(event({ type: 'reasoning', text: 'private chain' })), null);
  assert.equal(captureEvent(event({ type: 'message', phase: 'analysis', text: 'private chain' })), null);
  assert.equal(captureEvent(event({ type: 'item', stage: 'completed', item: { type: 'agentMessage', phase: 'analysis', text: 'private chain' } })), null);
  const item = captureEvent(event({ type: 'item', stage: 'completed', item: { type: 'dynamicToolCall', analysis: 'private chain', arguments: { action: 'read' } } }));
  assert.doesNotMatch(JSON.stringify(item), /private chain/);
});
test('bind filters buffered unrelated runs and rejects rebinding', () => {
  const c = createCapture();
  c.ingest(event({ type: 'message', itemId: 'a', text: 'one' }));
  c.ingest(event({ type: 'message', itemId: 'b', text: 'two' }, other));
  assert.throws(() => c.snapshot(), /Bind/);
  c.bind(run);
  c.ingest(event({ type: 'message', itemId: 'c', text: 'three' }, other));
  assert.equal(c.snapshot().events.length, 1);
  assert.throws(() => c.bind(other), /already bound/);
  assert.throws(() => c.bind('not-a-run'), /UUID/);
});
test('retains duplicate events but summary explicitly deduplicates public messages', () => {
  const c = createCapture(); c.bind(run);
  const m = event({ type: 'message', itemId: 'a', phase: 'final_answer', text: 'Please confirm the answer.' });
  c.ingest(m); c.ingest(m);
  assert.equal(c.snapshot().events.length, 2);
  assert.equal(c.summary().uniquePublicMessageCount, 1);
  assert.equal(c.summary().questionCandidates.length, 1);
  assert.equal(questionCandidate('Read https://example.test/apply?pid=1'), false);
  assert.equal(questionCandidate('Can you provide the answer?'), true);
});
test('overflow retains initial evidence and visibly stops without a success verdict', () => {
  const c = createCapture({ maxEvents: 1 }); c.bind(run);
  c.ingest(event({ type: 'message', itemId: 'a', text: 'initial' }));
  c.ingest(event({ type: 'message', itemId: 'b', text: 'later' }));
  assert.equal(c.active, false); assert.equal(c.dropped, 1); assert.equal(c.stopReason, 'capacity-limit');
  assert.equal(c.snapshot().events[0].data.text, 'initial');
  assert.equal(c.snapshot().captureComplete, false);
  assert.match(c.summary().scoring, /manual evidence review/);
  assert.equal(Object.hasOwn(c.summary(), 'success'), false);
});
test('oversized strings and depth limits are visible, not silently accepted as complete evidence', () => {
  const c = createCapture(); c.bind(run);
  c.ingest(event({ type: 'message', itemId: 'a', text: 'x'.repeat(200001) }));
  assert.equal(c.limitationEvents, 1); assert.equal(c.snapshot().captureComplete, false);
  assert.equal(c.snapshot().events[0].captureLimitations.omittedCharacters, 1);
  const nested = {}; let cursor = nested;
  for (let i = 0; i < 35; i++) cursor = cursor.next = {};
  const limits = {}; sanitize(nested, 'output', 0, limits); assert.ok(limits.depthOmissions > 0);
});
test('healthy active evidence is not represented as a completed capture', () => {
  const c = createCapture(); c.bind(run);
  c.ingest(event({ type: 'message', itemId: 'a', text: 'Observed.' }));
  assert.equal(c.snapshot().captureHealthy, true); assert.equal(c.snapshot().captureComplete, false);
  c.finish('observer-finished'); assert.equal(c.snapshot().captureComplete, true);
});
function bootstrapFixture({ constructorError = false } = {}) {
  let subscription, constructions = 0, nextTimer = 0;
  const timers = new Map();
  class EventSource {
    constructor(url) {
      assert.equal(url, '/api/events'); constructions++;
      if (constructorError) throw Error('fixture connection failure');
      subscription = this; this.closed = false;
    }
    close() { this.closed = true; }
  }
  const sandbox = { window: {}, EventSource, TextEncoder, structuredClone,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  const context = vm.createContext(sandbox);
  return { start: () => vm.runInContext(captureExpression(), context), timers,
    get subscription() { return subscription; }, get constructions() { return constructions; },
    get capture() { return sandbox.window.__blackiceJobSearchEvidence; } };
}

test('generated bootstrap waits for explicit stream open, records UTC readiness, and reuses the pending subscription', async () => {
  const f = bootstrapFixture(), pending = f.start();
  let resolved = false; pending.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false); assert.equal(f.capture.readiness, 'connecting'); assert.equal(f.capture.openedAtUTC, null);
  assert.deepEqual([...f.timers.values()].map(t => t.ms).sort((a, b) => a - b), [10000, 2700000]);
  const repeated = f.start(); assert.equal(f.constructions, 1);
  f.subscription.onopen();
  const initial = await pending, duplicate = await repeated;
  assert.equal(initial.readiness, 'ready'); assert.equal(initial.maxEvents, 3000); assert.equal(initial.openTimeoutMs, 10000);
  assert.match(initial.openedAtUTC, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(duplicate.alreadyActive, true); assert.equal(duplicate.openedAtUTC, initial.openedAtUTC);
  assert.deepEqual([...f.timers.values()].map(t => t.ms), [2700000]);
  const c = f.capture; c.bind(run);
  f.subscription.onmessage({ data: JSON.stringify(event({ type: 'message', itemId: 'a', phase: 'commentary', text: 'Working.' })) });
  assert.equal(c.snapshot().openedAtUTC, initial.openedAtUTC); assert.equal(c.summary().readiness, 'ready');
  assert.equal(c.snapshot().events.length, 1);
  f.subscription.onerror(); assert.equal(c.summary().errors, 1);
  const final = c.stop();
  assert.equal(final.active, false); assert.equal(final.captureComplete, false); assert.equal(f.subscription.closed, true);
  assert.equal(f.timers.size, 0);
});

test('stream-open timeout rejects readiness and closes without fabricating complete evidence', async () => {
  const f = bootstrapFixture(), pending = f.start();
  const rejected = assert.rejects(pending, error => error.code === 'stream-open-timeout');
  [...f.timers.values()].find(timer => timer.ms === 10000).fn();
  await rejected;
  f.subscription.onopen();
  assert.equal(f.capture.readiness, 'failed'); assert.equal(f.capture.openedAtUTC, null);
  assert.equal(f.capture.stopReason, 'stream-open-timeout'); assert.equal(f.subscription.closed, true); assert.equal(f.timers.size, 0);
  f.capture.bind(run); const evidence = f.capture.snapshot();
  assert.equal(evidence.captureHealthy, false); assert.equal(evidence.captureComplete, false); assert.equal(evidence.events.length, 0);
  assert.equal(evidence.readinessError.code, 'stream-open-timeout');
});

test('stream error before open rejects readiness immediately and preserves its failure receipt', async () => {
  const f = bootstrapFixture(), pending = f.start();
  const rejected = assert.rejects(pending, error => error.code === 'stream-open-error');
  f.subscription.onerror(); await rejected;
  f.capture.bind(run); const evidence = f.capture.snapshot();
  assert.equal(evidence.readiness, 'failed'); assert.equal(evidence.openedAtUTC, null);
  assert.equal(evidence.errors, 1); assert.equal(evidence.stopReason, 'stream-open-error');
  assert.equal(f.subscription.closed, true); assert.equal(f.timers.size, 0);
});

test('EventSource constructor failure rejects without leaving an active observer', async () => {
  const f = bootstrapFixture({ constructorError: true });
  await assert.rejects(f.start(), error => error.code === 'stream-open-error');
  assert.equal(f.capture.readiness, 'failed'); assert.equal(f.capture.active, false);
  assert.equal(f.capture.openedAtUTC, null); assert.equal(f.capture.errors, 1); assert.equal(f.timers.size, 0);
});

test('stopping before stream open rejects the waiting caller instead of reporting readiness', async () => {
  const f = bootstrapFixture(), pending = f.start();
  const rejected = assert.rejects(pending, error => error.code === 'stream-open-cancelled');
  f.capture.bind(run); const evidence = f.capture.stop(); await rejected;
  assert.equal(evidence.readiness, 'failed'); assert.equal(evidence.captureComplete, false);
  assert.equal(evidence.stopReason, 'stream-open-cancelled'); assert.equal(f.subscription.closed, true); assert.equal(f.timers.size, 0);
});

const answerURL = 'https://employer.test/application', answerRef = '1-0-7-11:native-document:30';
function answerObservation(options = {}) {
  const field = { ref:answerRef, tag:'textarea', type:'textarea', role:'textbox', name:'Describe a project you delivered', disabled:false, value:'', ...options.field };
  const page = { browser:'relay', tabId:options.tabId || 'tab-a', documentId:options.documentId || 'tab-a:9', url:options.url || answerURL,
    frames:[{frame:'7-11',elements:options.fields || [field]}], receipt:options.receipt };
  const e = event({type:'item',stage:'completed',item:{type:'dynamicToolCall',id:options.id || 'observation',tool:'relay_browser',success:true,
    arguments:{action:'snapshot',tabId:page.tabId},contentItems:[{type:'inputText',text:JSON.stringify(page)}]}},options.runId || run);
  e.nodeId = options.nodeId || 'agent';return e;
}
function answerAction(text, options = {}) {
  const e = answerObservation({id:'answer-call',field:{value:text.slice(0,300)},receipt:{filled:true,characters:text.length,input:'browser'},...options.returned});
  e.data.stage = options.stage || 'completed';e.data.item.success = options.success !== false;
  e.data.item.arguments = {action:'fill',browser:'relay',tabId:'tab-a',ref:answerRef,
    ...(options.expectations === false ? {} : {expectedDocumentId:'tab-a:9',expectedUrl:answerURL}),text,...options.args};
  if(options.stage === 'started')e.data.item.contentItems = [];
  return e;
}
function capturedAnswer(text, options = {}) {
  const c = createCapture();c.bind(run);
  if(options.prior !== false)c.ingest(answerObservation(options.prior));
  if(options.intervening)c.ingest(options.intervening);
  c.ingest(answerAction(text,options));
  return {c,audit:c.snapshot().events.at(-1).data.answerEvidence};
}

test('audited answer preserves a long actual-shaped fill with earlier field provenance and optional expectations',()=>{
  const text = 'I delivered a documented internal project and tracked its results. '.repeat(9);
  for(const expectations of [true,false]){
    const {c,audit}=capturedAnswer(text,{expectations});
    assert.equal(audit?.text,text);assert.equal(audit.redacted,false);
    assert.equal(audit.field.name,'Describe a project you delivered');assert.equal(audit.field.ref,answerRef);
    assert.equal(audit.observed.callId,'observation');assert.equal(audit.observed.documentId,'tab-a:9');assert.equal(audit.observed.frame,'7-11');
    assert.equal(audit.originalLength,text.length);assert.equal(audit.retainedLength,text.length);
    assert.equal(audit.textComplete,true);assert.match(audit.meaning,/not.*submitted/i);
    assert.equal(c.snapshot().schemaVersion,3);
    assert.equal(c.snapshot().events.at(-1).data.item.arguments.text.redacted,true);
  }
});

test('answer text stays redacted without unique current matching prior and successful native return',()=>{
  const text='do-not-release-unresolved-answer';
  const cases=[
    {prior:false},{prior:{runId:other}},{prior:{nodeId:'another-worker'}},{args:{tabId:'another-tab'}},
    {args:{ref:'unknown-ref'}},{args:{expectedDocumentId:'old-document'}},{args:{expectedUrl:'https://other.test/'}},
    {prior:{fields:[{ref:answerRef,tag:'textarea',type:'textarea',role:'textbox',name:'One'},{ref:answerRef,tag:'textarea',type:'textarea',role:'textbox',name:'Two'}]}},
    {prior:{field:{name:''}}},{success:false},{stage:'started'},
    {returned:{documentId:'same-url-new-document'}},{returned:{url:'https://other.test/'}},{returned:{tabId:'another-tab'}},
    {returned:{receipt:{filled:false,characters:text.length}}},{returned:{fields:[]}},
    {expectations:false,intervening:answerObservation({documentId:'new-document',field:{ref:'different-ref'}})},
    {args:{action:'type',ref:undefined},returned:{receipt:{typed:true,characters:text.length},fields:[]}},
  ];
  for(const options of cases){
    const {c,audit}=capturedAnswer(text,options);
    assert.doesNotMatch(JSON.stringify(c.snapshot()),/do-not-release-unresolved-answer/);
    if(options.stage!=='started'){assert.equal(audit?.redacted,true);assert.ok(audit.reason);}
  }
});

test('observed password OTP credential and autocomplete fields never disclose answer text',()=>{
  const fields=[
    {tag:'input',type:'password',name:'Account password'},
    {tag:'input',type:'text',name:'Verification code'},
    {tag:'input',type:'text',name:'API key'},
    {tag:'input',type:'text',name:'access_token'},
    {tag:'input',type:'text',name:'refresh_token'},
    {tag:'input',type:'text',name:'Code'},
    {tag:'input',type:'text',name:'Account secret'},
    {tag:'input',type:'text',name:'Security answer'},
    {tag:'input',type:'text',name:'Account field',autocomplete:'one-time-code'},
    {tag:'input',type:'text',name:'Account field',autocomplete:'current-password'},
  ];
  for(const field of fields){
    const {c,audit}=capturedAnswer('credential-value-must-stay-hidden',{prior:{field},returned:{field}});
    assert.equal(audit?.redacted,true);assert.equal(audit.secret,true);
    assert.doesNotMatch(JSON.stringify(c.snapshot()),/credential-value-must-stay-hidden/);
  }
});

test('answer cleanup preserves literal JSON and exposes token redaction and text truncation',()=>{
  const literal='{"experience":"analysis and research","years":3}';
  assert.equal(capturedAnswer(literal).audit?.text,literal);
  const masked=capturedAnswer('I used a test system. Bearer token-secret-123456').audit;
  assert.equal(masked?.redactionsApplied,true);assert.equal(masked.textComplete,false);
  assert.doesNotMatch(JSON.stringify(masked),/token-secret-123456/);
  const long=capturedAnswer('x'.repeat(200001));
  assert.equal(long.audit?.retainedLength,200000);assert.equal(long.audit.truncated,true);
  assert.equal(long.c.snapshot().captureComplete,false);assert.equal(long.c.limitationEvents,1);
});

test('answer evidence remains inside capture byte bounds and generated expression uses the same policy',async()=>{
  const f=bootstrapFixture(),pending=f.start();f.subscription.onopen();await pending;f.capture.bind(run);
  const text='Auditable public answer '.repeat(30);
  for(const e of [answerObservation(),answerAction(text,{expectations:false})])f.subscription.onmessage({data:JSON.stringify(e)});
  assert.equal(f.capture.snapshot().events.at(-1).data.answerEvidence?.text,text);
  const limited=createCapture({maxBytes:3000});limited.bind(run);limited.ingest(answerObservation());
  limited.ingest(answerAction('x'.repeat(6000)));
  assert.equal(limited.stopReason,'capacity-limit');assert.equal(limited.dropped,1);
  assert.equal(limited.snapshot().events.length,1);
});

test('duplicate completed broadcasts cannot supply their own earlier field observation',()=>{
  const c=createCapture();c.bind(run);
  const e=answerAction('duplicate-answer-must-stay-redacted');
  c.ingest(e);c.ingest(e);
  assert.equal(c.snapshot().events.length,2);
  assert.ok(c.snapshot().events.every(row=>row.data.answerEvidence?.redacted===true));
  assert.doesNotMatch(JSON.stringify(c.snapshot()),/duplicate-answer-must-stay-redacted/);
});

test('answer binding requires concrete run node and call identities',()=>{
  for(const key of ['nodeId','callId','observationCallId']){
    for(const missing of [undefined,'',0,{}]){
      const c=createCapture();c.bind(run);
      const observed=answerObservation(),called=answerAction('missing-identity-answer');
      if(key==='nodeId'){observed.nodeId=missing;called.nodeId=missing;}
      if(key==='callId')called.data.item.id=missing;
      if(key==='observationCallId')observed.data.item.id=missing;
      c.ingest(observed);c.ingest(called);
      assert.equal(c.snapshot().events.at(-1).data.answerEvidence?.redacted,true);
      assert.doesNotMatch(JSON.stringify(c.snapshot()),/missing-identity-answer/);
    }
  }
  const observed=answerObservation({runId:'invalid-run'}),called=answerAction('invalid-run-answer');
  called.runId='invalid-run';
  const kept=captureEvent(called,[captureEvent(observed)]);
  assert.equal(kept.data.answerEvidence?.redacted,true);
});

test('late duplicate cannot use a later observation as prior evidence',()=>{
  const c=createCapture(),called=answerAction('late-duplicate-answer');c.bind(run);
  c.ingest(called);
  const later=answerObservation({id:'later-observation'});later.at='2026-11-21T00:00:00.002Z';
  c.ingest(later);c.ingest(called);
  assert.equal(c.snapshot().events.at(-1).data.answerEvidence?.redacted,true);
  assert.doesNotMatch(JSON.stringify(c.snapshot()),/late-duplicate-answer/);
});


const nativeCommand={type:'commandExecution',id:'native-command',command:'node verify.mjs',cwd:'C:/fixture',
  status:'completed',exitCode:7,aggregatedOutput:'Actual test failure\n',durationMs:12};
const nativeFile={type:'fileChange',id:'native-file',status:'completed',
  changes:[{path:'report.txt',kind:'update',diff:'-old\n+actual revised output\n'}]};

test('H2 retains actual-shaped native command and file outcomes with exact run/node/call identity',()=>{
  const c=createCapture();c.bind(run);
  c.ingest(event({type:'item',stage:'completed',item:nativeCommand}));
  c.ingest({...event({type:'item',stage:'completed',item:nativeFile}),nodeId:'worker'});
  c.ingest(event({type:'item',stage:'completed',item:{...nativeCommand,id:'other-run'}},other));
  const records=c.snapshot().events;
  assert.equal(records.length,2);assert.deepEqual(records.map(e=>[e.runId,e.nodeId,e.data.item.id]),[[run,'agent','native-command'],[run,'worker','native-file']]);
  assert.deepEqual(records[0].data.item,nativeCommand);assert.deepEqual(records[1].data.item,nativeFile);
  assert.equal(records[0].data.stage,'completed');assert.equal(records[0].data.item.exitCode,7);
  assert.deepEqual(c.summary().lastCalls.map(x=>x.tool),['commandExecution','fileChange']);
  assert.equal(Object.hasOwn(c.summary(),'success'),false);
});

test('H2 retains normalized public image and collaboration records without inventing success',()=>{
  const c=createCapture();c.bind(run);
  const image=safeNativeImageItem({type:'imageGeneration',id:'image',status:'completed',savedPath:'C:/fixture/image.png',result:'private binary body'});
  const collaboration={type:'collabAgentToolCall',id:'collaboration',status:'failed',tool:'wait'};
  for(const item of [image,collaboration])c.ingest(event({type:'item',stage:'completed',item}));
  const records=c.snapshot().events;
  assert.equal(records.length,2);assert.deepEqual(records[0].data.item,image);assert.deepEqual(records[1].data.item,collaboration);
  assert.doesNotMatch(JSON.stringify(records),/private binary body/);
  assert.equal(Object.hasOwn(records[1].data.item,'success'),false);
});

test('H2 preserves secret and private-reasoning exclusions on native action fields',()=>{
  const c=createCapture();c.bind(run);
  c.ingest(event({type:'item',stage:'completed',item:{...nativeCommand,analysis:'private chain',
    credentials:{password:'secret-native-value'},aggregatedOutput:'password=secret-native-value Bearer secret-native-bearer'}}));
  c.ingest(event({type:'item',stage:'completed',item:{type:'reasoning',id:'private',summary:'private chain'}}));
  c.ingest(event({type:'item',stage:'completed',item:{type:'agentMessage',phase:'analysis',text:'private chain'}}));
  assert.equal(c.snapshot().events.length,1);
  const kept=c.snapshot().events[0].data.item;
  assert.equal(kept.credentials.secret,true);assert.equal(kept.credentials.present,true);
  assert.doesNotMatch(JSON.stringify(c.snapshot()),/private chain|secret-native-value|secret-native-bearer/);
});

test('H2 native output and event limits remain visible in capture completeness',()=>{
  const c=createCapture();c.bind(run);
  c.ingest(event({type:'item',stage:'completed',item:{...nativeCommand,aggregatedOutput:'x'.repeat(200001)}}));
  c.finish('observer-finished');
  assert.equal(c.snapshot().events.length,1);assert.equal(c.snapshot().captureHealthy,false);assert.equal(c.snapshot().captureComplete,false);
  assert.equal(c.snapshot().events[0].captureLimitations.omittedCharacters,1);
  const bounded=createCapture({maxEvents:1});bounded.bind(run);
  bounded.ingest(event({type:'item',stage:'completed',item:nativeCommand}));
  bounded.ingest(event({type:'item',stage:'completed',item:nativeFile}));
  assert.equal(bounded.dropped,1);assert.equal(bounded.stopReason,'capacity-limit');assert.equal(bounded.snapshot().events.length,1);
});

test('H2 unknown public native item retains only identity and explicit unsupported limitation',()=>{
  const c=createCapture();c.bind(run);
  c.ingest(event({type:'item',stage:'completed',item:{type:'futureNativeAction',id:'unknown',status:'completed',text:'unreviewed body',analysis:'private chain'}}));
  c.finish('observer-finished');
  const record=c.snapshot().events[0];
  assert.equal(record.data.type,'unsupported.item');assert.deepEqual(record.data.item,{type:'futureNativeAction',id:'unknown'});
  assert.equal(record.captureLimitations.unsupportedNativeItems,1);assert.equal(c.snapshot().captureComplete,false);
  assert.doesNotMatch(JSON.stringify(record),/unreviewed body|private chain/);
});

test('H2 generated observer identifies new policy and rejects an active older schema',async()=>{
  const f=bootstrapFixture(),pending=f.start();f.subscription.onopen();const ready=await pending;
  assert.equal(ready.schemaVersion,3);assert.equal(ready.redactionPolicy,'public-native-actions-v3');
  f.capture.schemaVersion=2;
  await assert.rejects(f.start(),/another capture schema/);
});
