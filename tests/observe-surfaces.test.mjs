import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../public/api-client.mjs';
import { initObserveUI, renderObserveSurfaceNavigation } from '../public/observe-ui.mjs';

const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const decode = value => String(value).replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, decode(value)]));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let step = 0; step < 4; step++) await new Promise(resolve => setImmediate(resolve)); };
const browserStatus = () => ({ available: true, acceptingActions: true, physicalInput: false, browsers: { relay: { available: true } }, activeTab: 'contained-page', tabs: [{ tabId: 'contained-page', browser: 'relay', visible: false, title: 'A contained page', url: 'https://example.test/work' }] });
const appStatus = () => ({ available: true, isolation: 'hidden-desktop', foregroundPolicy: 'isolated-desktop', physicalInput: false, supportedApps: [{ appId: 'notepad-classic', name: 'Notepad', available: true }], sessions: [{ id: 'private-notepad', appId: 'notepad-classic', applicationName: 'Notepad', name: 'Running private notes', state: 'running', isolated: true, controlsAvailable: true }], activeSessionId: 'private-notepad', documents: [], documentStorage: { healthy: true } });
const appObservation = () => ({ sessionId: 'private-notepad', observedAt: new Date().toISOString(), text: 'Actual private editor text', controls: [{ ref: 'editor-ref', role: 'textbox', name: 'Private editor', enabled: true, writable: true }] });
const activeRun = () => ({ id: 'real-task', workflowName: 'Actual task workflow', status: 'running', workflow: { nodes: [{ id: 'agent', type: 'agent', name: 'Research' }] }, nodes: { agent: { status: 'running' } }, taskState: { steps: [{ id: 'finish', title: 'Finish the actual task', status: 'pending' }] } });

// This small DOM adapter mounts the actual parent and both actual pane controllers.
// It performs no browser, Electron, Windows, or application launch.
function fixture(t, { handle, run = null, apiEnabled = true, stop, onChatGPTSettings } = {}) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousNow = Date.now;
  let now = previousNow(); Date.now = () => now;
  const doc = { body: {}, activeElement: null, getElementById: () => ({}) }; globalThis.document = doc;
  const matches = (node, selector) => { const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector); return selector.startsWith('#') ? node.id === selector.slice(1) : selector.startsWith('.') ? node.className?.split(' ').includes(selector.slice(1)) : attr ? Object.hasOwn(node.attrs, attr[1]) && (attr[2] === undefined || node.attrs[attr[1]] === attr[2]) : false; };
  function nodeFor(attrs = {}, parentHost = null) {
    let html = '', children = [];
    const listeners = new Map(), node = { attrs, id: attrs.id || '', className: attrs.class || '', value: attrs.value || '', hidden: false, disabled: false, open: false, textContent: '', isConnected: true, parentHost, listeners, dataset: Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])), scrollTop: 0, scrollHeight: 100, clientHeight: 100,
      classList: { add() {}, toggle() {} }, setAttribute(key, value) { node.attrs[key] = value; }, focus() { doc.activeElement = node; }, setSelectionRange(start, end) { node.selectionStart = start; node.selectionEnd = end; }, addEventListener: (kind, listener) => listeners.set(kind, listener), removeEventListener: kind => listeners.delete(kind),
      contains(target) { for (let current = target; current; current = current.parentHost) if (current === node) return true; return false; },
      closest(selector) { for (let current = node; current; current = current.parentHost) if (matches(current, selector)) return current; return null; },
      querySelectorAll(selector) { return children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); }, querySelector(selector) { return node.querySelectorAll(selector)[0] || null; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 450 }) };
    Object.defineProperty(node, 'innerHTML', { get: () => html, set(value) {
      html = value; children = [];
      for (const [tag, kind] of value.matchAll(/<([a-z][a-z0-9]*)\b[^>]*>/g)) {
        const attrs = attributes(tag), child = nodeFor(attrs, node); child.tagName = kind.toUpperCase(); child.hidden = /\shidden(?:\s|>)/.test(tag); child.disabled = /\sdisabled(?:\s|>)/.test(tag); child.open = /\sopen(?:\s|>)/.test(tag); child.tabIndex = Number(attrs.tabindex || 0);
        if (kind === 'select') { const body = new RegExp('<select\\b[^>]*id="' + child.id + '"[^>]*>([\\s\\S]*?)</select>').exec(value)?.[1] || '', options = [...body.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map(([, attrs, label]) => ({ value: attributes(attrs).value ?? decode(label), selected: /\bselected\b/.test(attrs) })); child.value = (options.find(item => item.selected) || options[0])?.value || ''; }
        if (kind === 'textarea') child.value = decode(new RegExp('<textarea\\b[^>]*id="' + child.id + '"[^>]*>([\\s\\S]*?)</textarea>').exec(value)?.[1] || '');
        children.push(child);
      }
    } });
    return node;
  }
  const mount = nodeFor(), calls = [], watches = [], snapshot = { runs: run ? [run] : [], currentRun: run }, opened = [];
  const api = createApiClient({ fetcher: async (route, options) => {
    const call = { route, body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal }; calls.push(call);
    assert.ok(['/api/browser/status?view=contained', '/api/browser/action', '/api/application-sessions/status', '/api/application-sessions/action'].includes(route), 'panes must not call desktop, Neo, show, or physical-input routes');
    const custom = await handle?.(call); if (custom !== undefined) return Response.json(custom);
    if (route === '/api/browser/status?view=contained') return Response.json(browserStatus());
    if (route === '/api/application-sessions/status') return Response.json(appStatus());
    if (route === '/api/browser/action') return Response.json(call.body.action === 'screenshot' ? { tabId: 'contained-page', imageUrl, width: 1280, height: 900 } : { tabId: 'contained-page', frames: [{ text: 'Observed page', elements: [{ ref: 'browser-field', role: 'textbox', name: 'Browser message' }] }] });
    return Response.json(call.body.action === 'screenshot' ? { sessionId: 'private-notepad', imageUrl, width: 1280, height: 900, capturedAt: new Date(now).toISOString() } : appObservation());
  } });
  const ui = initObserveUI({ mount, getSnapshot: () => snapshot, api: apiEnabled ? api : undefined, onOpenRun: (...args) => opened.push(args), onStop: stop, onChatGPTSettings, subscribe(id, handlers) { const watch = { id, handlers, closed: false }; watches.push(watch); return () => { watch.closed = true; }; } });
  t.after(() => { ui.destroy(); Date.now = previousNow; if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document; });
  const element = id => mount.querySelector('#' + id), pane = id => element(id === 'browser' ? 'observe-browser' : id === 'applications' ? 'observe-application-sessions' : 'observe-workspace-workflow');
  return { ui, mount, calls, watches, snapshot, opened, element, pane, advance(ms) { now += ms; }, async enter() { ui.enter(); await flush(); }, async select(id) { const target = element('observe-surface-' + id); assert.ok(target); await mount.listeners.get('click')({ target }); await flush(); }, async key(id, key) { let prevented = false; await mount.listeners.get('keydown')({ target: element('observe-surface-' + id), key, preventDefault() { prevented = true; } }); await flush(); return prevented; }, focused: () => doc.activeElement,
    async appAction(action) { const host = pane('applications'), target = host.querySelectorAll('[data-application-session]').find(item => item.dataset.applicationSession === action); assert.ok(target, 'rendered application action exists: ' + action); return host.listeners.get('click')({ target }); },
    async browserAction(action) { const host = pane('browser'), target = host.querySelectorAll('[data-observe-browser]').find(item => item.dataset.observeBrowser === action); assert.ok(target); return host.listeners.get('click')({ target }); } };
}

test('surface navigation exposes an explicit keyboard tab pattern and hides unavailable panes', () => {
  const html = renderObserveSurfaceNavigation({ surface: 'applications' });
  assert.match(html, /role="tablist" aria-label="Activity work surface"/);
  assert.match(html, /id="observe-surface-applications"[^>]+aria-controls="observe-application-sessions" aria-selected="true" tabindex="0"/);
  assert.match(html, /id="observe-surface-browser"[^>]+aria-selected="false" tabindex="-1"/);
  const offline = renderObserveSurfaceNavigation({ available: false }); assert.doesNotMatch(offline, />Browser<|>Applications</); assert.match(offline, />Workflow</);
  assert.doesNotMatch(renderObserveSurfaceNavigation({ surface: '<script>unknown</script>' }), /<script>/);
});

test('ordinary Activity entry renders the current task and subscribes synchronously', t => {
  const f = fixture(t, { run: activeRun(), apiEnabled: false });
  assert.equal(f.ui.enter(), undefined);
  assert.equal(f.watches.length, 1);
  assert.equal(f.watches[0].id, 'real-task');
  assert.equal(f.pane('workflow').hidden, false);
  assert.match(f.element('observe-agents').innerHTML, /Research/);
});

test('Observe shows a pending Stop, retries failure, and waits for settlement before reporting Task stopped', async t => {
  const run = { ...activeRun(), settled: false }, calls = [];
  let rejectStop; const pending = new Promise((resolve, reject) => { rejectStop = reject; });
  const f = fixture(t, { run, apiEnabled: false, stop: async (id, options) => {
    calls.push({ id, options });
    if (calls.length === 1) return pending;
    run.status = 'cancelled'; run.nodes.agent.status = 'cancelled'; return run;
  } });
  await f.enter(); const stop = f.mount.querySelector('[data-observe-action="stop"]'), click = () => f.mount.listeners.get('click')({ target: stop });
  const requesting = click(); await flush();
  assert.equal(stop.disabled, true); assert.equal(stop.hidden, false); assert.match(f.element('observe-stream').textContent, /Requesting Stop/);
  await click(); assert.equal(calls.length, 1); assert.equal(calls[0].options.throwOnError, true);
  rejectStop(new Error('The server connection was lost.')); await requesting;
  assert.equal(stop.disabled, false); assert.equal(stop.textContent, 'Retry stop'); assert.match(f.element('observe-error').textContent, /Stop was not confirmed.*Try Stop again.*connection was lost/);
  assert.match(f.element('observe-stream').textContent, /may still be running/); assert.equal(run.status, 'running');
  await click();
  assert.equal(calls.length, 2); assert.equal(stop.disabled, true); assert.equal(stop.hidden, false); assert.equal(stop.textContent, 'Stopping…');
  assert.equal(f.element('observe-stream').textContent, 'Task stopping…'); assert.match(f.element('observe-session-note').textContent, /Waiting for active work/);
  assert.match(f.element('observe-agents').innerHTML, /Stopping/); assert.doesNotMatch(f.element('observe-agents').innerHTML, />Stopped</); assert.equal(f.element('observe-error').hidden, true);
  run.settled = true; f.ui.update();
  assert.equal(f.element('observe-stream').textContent, 'Task stopped'); assert.equal(stop.hidden, true); assert.match(f.element('observe-agents').innerHTML, />Stopped</);
});

test('Observe cancellation locks and late errors stay with the task that requested Stop', async t => {
  const a = { ...activeRun(), id: 'observe-stop-a', settled: false }, b = { ...activeRun(), id: 'observe-stop-b', settled: false };
  let rejectStop; const pending = new Promise((resolve, reject) => { rejectStop = reject; });
  const f = fixture(t, { run: a, apiEnabled: false, stop: () => pending }); f.snapshot.runs.push(b); await f.enter();
  const stop = f.mount.querySelector('[data-observe-action="stop"]'), requesting = f.mount.listeners.get('click')({ target: stop }); await flush();
  const selector = f.element('observe-run'); selector.value = b.id; await f.mount.listeners.get('change')({ target: selector });
  assert.equal(stop.disabled, false); assert.equal(selector.value, b.id);
  rejectStop(new Error('Task A Stop request failed.')); await requesting;
  assert.equal(f.element('observe-error').hidden, true); assert.doesNotMatch(f.element('observe-stream').textContent, /Stop/);
  selector.value = a.id; await f.mount.listeners.get('change')({ target: selector });
  assert.equal(stop.disabled, false); assert.equal(stop.textContent, 'Retry stop'); assert.match(f.element('observe-error').textContent, /Task A Stop request failed/);
});

test('only the selected surface is visible and polling, and surface changes perform no app or page mutations', async t => {
  const f = fixture(t); await f.enter(); assert.equal(f.pane('browser').hidden, false); assert.equal(f.pane('applications').hidden, true); assert.equal(f.pane('workflow').hidden, true);
  assert.deepEqual(f.calls.map(call => [call.route, call.body?.action]), [['/api/browser/status?view=contained', undefined], ['/api/browser/action', 'screenshot']]);
  await f.select('applications'); assert.equal(f.pane('browser').hidden, true); assert.equal(f.pane('applications').hidden, false); assert.match(f.pane('applications').innerHTML, /Actual private editor text/);
  const browserCalls = f.calls.filter(call => call.route.startsWith('/api/browser')).length; f.advance(6000); f.ui.update(); await flush(); assert.equal(f.calls.filter(call => call.route.startsWith('/api/browser')).length, browserCalls);
  await f.select('workflow'); assert.equal(f.pane('workflow').hidden, false); assert.equal(f.pane('applications').hidden, true); const count = f.calls.length; f.advance(6000); f.ui.update(); await flush(); assert.equal(f.calls.length, count);
  assert.ok(f.calls.filter(call => call.body).every(call => ['inspect', 'screenshot'].includes(call.body.action)), 'view switching cannot start, close, edit, navigate, or show an application or page');
});

test('browser and application drafts plus each surface scroll position survive switching', async t => {
  const f = fixture(t); await f.enter(); f.element('observe-browser-url').value = 'https://draft.test/unfinished'; await f.browserAction('inspect'); f.element('observe-browser-text').value = 'Unsent browser field'; f.mount.querySelector('.observe-scroll').scrollTop = 95;
  await f.select('applications'); f.element('application-session-name').value = 'Unstarted session draft'; f.element('application-session-text').value = 'Unapplied private editor draft'; f.element('application-session-save-title').value = 'Unsaved version title'; f.mount.querySelector('.observe-scroll').scrollTop = 145;
  await f.select('browser'); assert.equal(f.element('observe-browser-url').value, 'https://draft.test/unfinished'); assert.equal(f.element('observe-browser-text').value, 'Unsent browser field'); assert.equal(f.mount.querySelector('.observe-scroll').scrollTop, 95);
  await f.select('applications'); assert.equal(f.element('application-session-name').value, 'Unstarted session draft'); assert.equal(f.element('application-session-text').value, 'Unapplied private editor draft'); assert.equal(f.element('application-session-save-title').value, 'Unsaved version title'); assert.equal(f.mount.querySelector('.observe-scroll').scrollTop, 145);
  assert.equal(f.calls.filter(call => call.body && ['create', 'control', 'close', 'open', 'fill'].includes(call.body.action)).length, 0);
});

test('switching away aborts a pending browser observation and a late response cannot strand its busy state', async t => {
  const gate = deferred(); let held = true;
  const f = fixture(t, { handle: call => held && call.route === '/api/browser/status?view=contained' ? gate.promise : undefined }); f.ui.enter(); await flush(); const pending = f.calls[0];
  f.element('observe-browser-url').value = 'https://draft.test/while-loading'; await f.select('applications'); assert.equal(pending.signal.aborted, true); const browserHTML = f.pane('browser').innerHTML;
  gate.resolve(browserStatus()); await flush(); assert.equal(f.pane('browser').innerHTML, browserHTML); assert.equal(f.calls.filter(call => call.route === '/api/browser/action').length, 0);
  held = false; await f.select('browser'); assert.match(f.pane('browser').innerHTML, /Captured contained browser page/); assert.equal(f.element('observe-browser-url').value, 'https://draft.test/while-loading'); assert.equal(f.pane('browser').attrs['aria-busy'], 'false');
});

test('an accepted native edit is never replayed or closed when the view switches while its receipt is pending', async t => {
  const gate = deferred(), f = fixture(t, { handle: call => call.body?.action === 'control' ? gate.promise : undefined }); await f.enter(); await f.select('applications'); f.element('application-session-text').value = 'Exactly one accepted edit';
  const accepted = f.appAction('set-value'); await flush(); const mutation = f.calls.find(call => call.body?.action === 'control'); assert.ok(mutation);
  await f.select('browser'); assert.equal(mutation.signal.aborted, true, 'only the HTTP observation is cancelled by changing panes'); gate.resolve(appObservation()); await accepted; await flush();
  await f.select('applications'); assert.equal(f.calls.filter(call => call.body?.action === 'control').length, 1); assert.equal(f.calls.filter(call => call.body?.action === 'create' || call.body?.action === 'close').length, 0); assert.equal(f.element('application-session-text').value, 'Exactly one accepted edit');
});

test('workflow observation pauses while hidden and returns with captured evidence and an explicit gap', async t => {
  const f = fixture(t, { run: activeRun() }); await f.enter(); assert.equal(f.pane('workflow').hidden, false, 'a current task opens its actual workflow'); assert.equal(f.watches.length, 1); const first = f.watches[0]; first.handlers.onReady({ sequence: 0 });
  f.ui.handleEvent({ type: 'agent.event', runId: 'real-task', nodeId: 'agent', at: new Date().toISOString(), data: { type: 'message', text: 'Captured execution evidence' } }); f.ui.update(); assert.match(f.element('observe-feed').innerHTML, /Captured execution evidence/); assert.match(f.element('observe-workflow').innerHTML, /Actual task workflow/);
  await f.select('applications'); assert.equal(first.closed, true); first.handlers.onEdit({ runId: 'real-task', source: 'filesystem', sequence: 1, path: 'stale-callback.txt', change: 'created' }); assert.doesNotMatch(f.element('observe-pinned').innerHTML, /stale-callback/);
  await f.select('workflow'); assert.equal(f.watches.length, 2); f.watches[1].handlers.onReady({ sequence: 4 }); f.ui.update(); assert.match(f.element('observe-feed').innerHTML, /Captured execution evidence/); assert.match(f.element('observe-session-note').textContent, /Edits made while disconnected may be missing/);
});

test('arrow, Home, and End keys activate and focus tabs without launching surfaces', async t => {
  const f = fixture(t); await f.enter(); assert.equal(await f.key('browser', 'ArrowRight'), true); assert.equal(f.focused().id, 'observe-surface-applications'); assert.equal(f.element('observe-surface-applications').attrs['aria-selected'], 'true');
  await f.key('applications', 'End'); assert.equal(f.focused().id, 'observe-surface-workflow'); await f.key('workflow', 'Home'); assert.equal(f.focused().id, 'observe-surface-browser'); await f.key('browser', 'ArrowLeft'); assert.equal(f.focused().id, 'observe-surface-workflow');
  assert.equal(await f.key('workflow', 'Enter'), false); assert.ok(f.calls.filter(call => call.body).every(call => ['inspect', 'screenshot'].includes(call.body.action)));
});

test('choosing a saved task reveals Workflow and full Activity leave still releases private preview buffers', async t => {
  const f = fixture(t, { run: { ...activeRun(), status: 'completed' } }); await f.enter(); await f.select('applications'); const picker = f.element('observe-run'); picker.value = 'real-task'; await f.mount.listeners.get('change')({ target: picker });
  assert.equal(f.pane('workflow').hidden, false); assert.deepEqual(f.opened, [['real-task', 'observe']]); assert.match(f.element('observe-workflow').innerHTML, /Actual task workflow/);
  await f.select('applications'); f.ui.leave(); assert.equal(f.pane('applications').innerHTML, ''); assert.equal(f.pane('browser').innerHTML, ''); const count = f.calls.length; f.advance(20000); f.ui.update(); await flush(); assert.equal(f.calls.length, count); assert.ok(!f.calls.some(call => call.body?.action === 'close'));
});


test('Activity starts with the current task, labels viewing separately, and remembers explicit surfaces',async t=>{
  const f=fixture(t,{run:activeRun()});await f.enter();assert.equal(f.pane('workflow').hidden,false);assert.equal(f.watches.length,1);assert.equal(f.calls.length,0,'task inspection does not begin unrelated browser or app observations');
  assert.equal(f.element('observe-stream').textContent,'Task running');assert.match(f.element('observe-viewing').textContent,/Viewing Workflow/);
  await f.select('browser');assert.equal(f.element('observe-stream').textContent,'Task running');assert.equal(f.element('observe-viewing').textContent,'Viewing Browser');
  f.ui.leave();await f.enter();assert.equal(f.pane('browser').hidden,false,'the selected surface survives leaving and returning');assert.equal(f.watches.length,1);
});

test('holding live view preserves an inspected file while new edits continue and follow reveals the latest',async t=>{
  const f=fixture(t,{run:activeRun()});await f.enter();const watcher=f.watches[0];watcher.handlers.onReady({sequence:0});
  const edit=(sequence,path)=>({runId:'real-task',source:'filesystem',sequence,path,change:'created',bytes:{after:12},diff:{added:1,removed:0,hunks:[{oldStart:1,newStart:1,lines:[{kind:'add',oldLine:null,newLine:1,text:path}]}]}});
  watcher.handlers.onEdit(edit(1,'reading-first.txt'));f.ui.update();const scroll=f.mount.querySelector('.observe-scroll');scroll.scrollHeight=1800;scroll.clientHeight=500;scroll.scrollTop=280;
  await f.mount.listeners.get('scroll')({target:scroll});assert.equal(f.element('observe-follow-live').attrs['aria-pressed'],'false');
  watcher.handlers.onEdit(edit(2,'latest-second.txt'));f.ui.update();assert.match(f.element('observe-pinned').innerHTML,/reading-first/);assert.doesNotMatch(f.element('observe-pinned').innerHTML,/latest-second/);assert.match(f.element('observe-feed').innerHTML,/latest-second/);assert.equal(scroll.scrollTop,280);assert.equal(watcher.closed,false,'holding a view never stops task observation');
  await f.mount.listeners.get('click')({target:f.element('observe-follow-live')});assert.equal(f.element('observe-follow-live').attrs['aria-pressed'],'true');assert.match(f.element('observe-pinned').innerHTML,/latest-second/);
  f.ui.leave();assert.equal(f.element('observe-pinned').innerHTML,'');
});

test('live command updates keep the focused output disclosure and its open state',async t=>{
  const f=fixture(t,{run:activeRun()});await f.enter();f.watches[0].handlers.onReady({sequence:0});
  const event={type:'agent.event',runId:'real-task',nodeId:'agent',data:{type:'item',stage:'completed',item:{type:'commandExecution',id:'command-1',command:'node verify.mjs',aggregatedOutput:'Initial result',status:'completed',exitCode:0}}};
  f.ui.handleEvent(event);
  f.ui.update();
  const host=f.element('observe-feed'),control=host.querySelectorAll('[data-observe-live-control]').find(node=>node.dataset.observeLiveControl.endsWith(':output'));
  assert.ok(control,'actual command receipt exposes a focusable output summary');control.focus();
  const details=host.querySelectorAll('[data-observe-output]')[0];details.open=true;await f.mount.listeners.get('toggle')({target:details});
  f.ui.handleEvent({...event,at:'2026-10-18T12:00:01Z',data:{...event.data,item:{...event.data.item,aggregatedOutput:'Updated result'}}});
  f.ui.update();
  assert.equal(f.focused().dataset.observeLiveControl,control.dataset.observeLiveControl);assert.notStrictEqual(f.focused(),control);assert.equal(host.querySelectorAll('[data-observe-output]')[0].open,true);
});

test('an explicit sign-in tab enters Browser even when a task previously selected Workflow', async t => {
  const exact = 'owned-sign-in', calls = [], f = fixture(t, { run: activeRun(), handle(call) { calls.push(call); if (call.route === '/api/browser/status?view=contained') { const status = browserStatus(); status.tabs.push({ tabId: exact, browser: 'relay', visible: false, title: 'ChatGPT', url: 'https://chatgpt.com/' }); return status; } if (call.route === '/api/browser/action' && call.body.action === 'screenshot') return { tabId: call.body.tabId, imageUrl, width: 1280, height: 900 }; } });
  await f.enter(); assert.equal(f.pane('workflow').hidden, false); assert.equal(calls.length, 0);
  const scroll = f.mount.querySelector('.observe-scroll'); scroll.scrollTop = 950;
  await f.ui.enter({ tabId: exact, focusPage: true }); await flush(); assert.equal(f.pane('browser').hidden, false); assert.equal(f.pane('workflow').hidden, true); assert.deepEqual(calls.filter(call => call.body?.action === 'screenshot').map(call => call.body.tabId), [exact]);
  assert.match(f.pane('browser').innerHTML, /Website sign-in/); assert.equal(f.element('observe-browser-tools').open, false);
  assert.equal(scroll.scrollTop, 0); assert.equal(f.focused().dataset.observeBrowser, 'point');
});

test('Activity carries the explicit conversation context and its local settings return into the pinned browser pane', async t => {
  let settings = 0;
  const f = fixture(t, { onChatGPTSettings() { settings++; } });
  await f.ui.enter({ tabId: 'contained-page', focusPage: true, chatGPTConversation: true }); await flush();
  assert.match(f.pane('browser').innerHTML, /ChatGPT in BLACKICE/);
  assert.doesNotMatch(f.pane('browser').innerHTML, /Website sign-in/);
  assert.equal(f.element('observe-browser-tools').open, false);
  const before = f.calls.length; await f.browserAction('connection-settings');
  assert.equal(settings, 1); assert.equal(f.calls.length, before);
});

test('Activity keeps workflow inspection optional while recovery, status and Stop stay outside it', async t => {
  const run = activeRun(); run.taskState.externalRecovery = { required: true, note: 'Inspect the saved receipt before retrying.' };
  const f = fixture(t, { run, apiEnabled: false, stop: async () => {} }); await f.enter();
  const inspector = f.element('observe-inspector'), markup = f.mount.innerHTML, start = markup.indexOf('<details id="observe-inspector"'), end = markup.indexOf('</details>', start), content = markup.slice(start, end);
  assert.equal(inspector.open, false);
  assert.match(content, /<summary>Workflow and workers<\/summary>/);
  assert.match(content, /id="observe-workflow"/); assert.match(content, /id="observe-agents"/);
  for (const id of ['observe-stream', 'observe-external', 'observe-pinned', 'observe-feed']) {
    assert.ok(markup.indexOf('id="' + id + '"') >= 0 && markup.indexOf('id="' + id + '"') < start, id + ' stays in the primary view');
  }
  assert.ok(markup.indexOf('data-observe-action="stop"') < start);
  assert.equal(f.element('observe-external').hidden, false);
  assert.match(f.element('observe-external').innerHTML, /Inspect the saved receipt before retrying/);
  assert.equal(f.mount.querySelector('[data-observe-action="stop"]').hidden, false);
  inspector.open = true; inspector.focus();
  f.ui.handleEvent({ type: 'agent.event', runId: run.id, nodeId: 'agent', at: new Date().toISOString(), data: { type: 'message', text: 'The latest meaningful result.' } }); f.ui.update();
  assert.strictEqual(f.element('observe-inspector'), inspector); assert.equal(inspector.open, true); assert.strictEqual(f.focused(), inspector);
  assert.match(f.element('observe-feed').innerHTML, /The latest meaningful result/);
  inspector.open = false; f.ui.update();
  assert.equal(inspector.open, false); assert.equal(f.element('observe-external').hidden, false);
});
