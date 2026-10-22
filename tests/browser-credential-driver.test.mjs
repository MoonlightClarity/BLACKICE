import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { BrowserRouter } from '../desktop/browser-router.mjs';

// The production renderer function and driver method run here; only Electron
// and the DOM boundary are fixtures. Native acceptance covers actual Chromium.
const sourceURL = new URL('../desktop/browser-driver.mjs', import.meta.url);
const fixtureKey = '__credential_driver_' + randomUUID().replaceAll('-', '');
let source = await readFile(sourceURL, 'utf8');
source = source.replace("import { BrowserWindow, session } from 'electron';", `const {BrowserWindow,session}=globalThis[${JSON.stringify(fixtureKey)}];`).replace(/from '(\.\.?\/[^']+)'/g, (_all, relative) => `from '${new URL(relative, sourceURL).href}'`);
globalThis[fixtureKey] = { BrowserWindow: class {}, session: {} };
let ElectronBrowserDriver;
try { ({ ElectronBrowserDriver } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))); } finally { delete globalThis[fixtureKey]; }
const origin = 'https://credentials.example.test', url = origin + '/signup';
const secret = { credentialId: 'credential_owned', revision: 2, origin, username: 'owned@example.test', password: 'Only-in-the-host-fixture-47!' };

function fixture() {
  const writes = [], events = [], evaluations = [];
  const context = vm.createContext({ origin, location: { origin, href: url }, writes, events });
  vm.runInContext(`
    window=globalThis; top=window; parent=window;
    document={}; document.defaultView=window;
    getComputedStyle=el=>({display:el.hidden?'none':'block',visibility:'visible',opacity:'1'});
    class FixtureEvent { constructor(type,options={}) { this.type=type; Object.assign(this,options); } }
    Event=FixtureEvent; InputEvent=FixtureEvent;
    HTMLInputElement=class {
      constructor(type,id){this.type=type;this.id=id;this.tagName='INPUT';this.ownerDocument=document;this.isConnected=true;this.disabled=false;this.readOnly=false;this.hidden=false;this._value='';}
      get value(){return this._value;} set value(value){writes.push({id:this.id,value});this._value=value;}
      closest(){return this.inert?{}:null;} getBoundingClientRect(){return {width:this.hidden?0:100,height:24};}
      checkVisibility(){return !this.hidden;} matches(){return this.disabled;}
      getAttribute(name){return name==='aria-disabled'&&this.ariaDisabled?'true':null;}
      dispatchEvent(event){events.push({id:this.id,type:event.type,data:event.data,allValues:[password.value,confirmation.value,username.value]});if(this.throwOnEvent)throw Error(this.value);return true;}
    };
    password=new HTMLInputElement('password','password');confirmation=new HTMLInputElement('password','confirmation');username=new HTMLInputElement('email','username');
    __fixture={document,elements:new Map([['password-ref',password],['confirmation-ref',confirmation],['username-ref',username]])};
  `, context);
  const frame = { url, executeJavaScript: async code => { evaluations.push(code); return vm.runInContext(code, context); } };
  const tab = { id: 'owned-tab', revision: 3, refs: new Map(['password-ref', 'confirmation-ref', 'username-ref'].map(ref => [ref, frame])), suspendedWork: new Set(), window: { isDestroyed: () => false, webContents: { getURL: () => context.top.location.href } } };
  const driver = Object.create(ElectronBrowserDriver.prototype);
  Object.assign(driver, { key: '__fixture', tabs: new Map([[tab.id, tab]]), activeTab: tab.id, closed: false, activate: async () => {}, ensureContained: async () => {}, pageWork: async (_tab, promise) => promise });
  const args = { browser: 'relay', origin, credentialId: secret.credentialId, revision: secret.revision, tabId: tab.id, expectedUrl: url, expectedDocumentId: `${tab.id}:${tab.revision}`, passwordRef: 'password-ref', confirmationRef: 'confirmation-ref', usernameRef: 'username-ref' };
  return { driver, tab, frame, context, args, writes, events, evaluations };
}

test('the actual host-only driver validates without a secret and fills all observed fields without submitting or echoing it', async () => {
  const f = fixture(), commit = await f.driver.prepareCredentialFill(f.args);
  assert.equal(f.writes.length, 0); assert.equal(f.events.length, 0);
  assert.ok(f.evaluations.every(value => !value.includes(secret.password)), 'Pre-decryption validation must not receive a password.');
  const result = await commit(secret);
  assert.deepEqual(result, { filled: true, submissionRequested: false });
  assert.deepEqual(f.writes.map(value => value.id), ['password', 'confirmation', 'username']);
  assert.equal(f.context.password.value, secret.password); assert.equal(f.context.confirmation.value, secret.password); assert.equal(f.context.username.value, secret.username);
  assert.equal(f.events.length, 6); assert.ok(f.events.every(value => ['input', 'change'].includes(value.type)));
  assert.ok(f.events.filter(value => value.type === 'input').every(value => value.data === null));
  assert.ok(f.events.every(value => value.allValues[0] === secret.password && value.allValues[1] === secret.password && value.allValues[2] === secret.username), 'No site event runs before all initial assignments.');
  assert.doesNotMatch(JSON.stringify(result), /Only-in-the-host/);
  await assert.rejects(commit(secret), { code: 'BROWSER_CREDENTIAL_TARGET_CHANGED' }); assert.equal(f.writes.length, 3);
});

test('actual password type, visibility, editability and snapshot identity are mandatory before any secret is requested', async () => {
  for (const mutate of [
    f => { f.context.password.type = 'text'; }, f => { f.context.confirmation.hidden = true; },
    f => { f.context.password.readOnly = true; }, f => { f.context.password.disabled = true; },
    f => { f.context.password.inert = true; }, f => { f.context.password.ariaDisabled = true; },
    f => { f.context.username.type = 'hidden'; }, f => { f.context.password.isConnected = false; },
    f => { f.context.__fixture.document = {}; }, f => { f.context.__fixture.elements.delete('password-ref'); },
    f => { f.context.__fixture.elements.set('confirmation-ref', f.context.password); },
    f => { f.tab.purpose = 'chat-mode'; }, f => { f.tab.pendingInteraction = { kind: 'javascript_dialog' }; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.driver.prepareCredentialFill(f.args), { code: 'BROWSER_CREDENTIAL_TARGET_CHANGED' });
    assert.equal(f.writes.length, 0); assert.equal(f.events.length, 0);
  }
});

test('opaque-filled password values remain masked after a show-password toggle and a same-document snapshot revision', async () => {
  const f = fixture(); await (await f.driver.prepareCredentialFill(f.args))(secret);
  vm.runInContext(`document.documentElement={children:[password,confirmation,username]};document.title='Owned fixture';document.getElementById=()=>null;for(const el of document.documentElement.children){el.children=[];el.childNodes=[];el.getAttribute=name=>name==='aria-label'?el.id:null;}password.type='text';confirmation.type='text';`, f.context);
  const snapshotSource = source.slice(source.indexOf('function pageSnapshot('), source.indexOf('\nasync function smoothPageScroll('));
  const result = vm.runInContext(`(${snapshotSource})("__fixture","revised-prefix","")`, f.context);
  assert.equal(result.elements.length, 3);
  assert.ok(result.elements.filter(element => ['password', 'confirmation'].includes(element.name)).every(element => !Object.hasOwn(element, 'value')));
  assert.equal(result.elements.find(element => element.name === 'username').value, secret.username);
  assert.ok(!JSON.stringify(result).includes(secret.password));
  const found = vm.runInContext(`(${snapshotSource})("__fixture","revised-again",${JSON.stringify(secret.password)})`, f.context);
  assert.equal(found.elements.length, 0, 'Query matching must not expose a protected password either.');
});

test('agent screenshots are blocked after protected filling even when a site reveals then hides the password; human previews remain available', async () => {
  const f = fixture(); let captures = 0, encodings = 0;
  f.driver.capture = async () => { captures++; return { image: { getSize: () => ({ width: 1280, height: 900 }), toDataURL: () => { encodings++; return 'data:image/png;base64,owned-preview'; } } }; };
  await (await f.driver.prepareCredentialFill(f.args))(secret);
  for (const type of ['text', 'password', 'text']) {
    f.context.password.type = type;
    await assert.rejects(f.driver.perform({ action: 'screenshot', tabId: f.tab.id }), { code: 'BROWSER_CREDENTIAL_CAPTURE_BLOCKED' });
  }
  assert.equal(captures, 0); assert.equal(encodings, 0);
  const human = await f.driver.perform({ action: 'screenshot', tabId: f.tab.id }, { source: 'user' });
  assert.equal(human.imageUrl, 'data:image/png;base64,owned-preview'); assert.equal(captures, 1); assert.equal(encodings, 1);
});

test('a secret commit during an in-flight agent capture prevents pixels from being encoded or returned', async () => {
  const f = fixture(), commit = await f.driver.prepareCredentialFill(f.args); let encodings = 0, captures = 0;
  f.driver.capture = async () => {
    captures++; await commit(secret); f.context.password.type = 'text'; f.context.password.type = 'password';
    return { image: { getSize: () => ({ width: 1280, height: 900 }), toDataURL: () => { encodings++; return 'never-return-this'; } } };
  };
  await assert.rejects(f.driver.perform({ action: 'screenshot', tabId: f.tab.id }), { code: 'BROWSER_CREDENTIAL_CAPTURE_BLOCKED' });
  assert.equal(captures, 1); assert.equal(encodings, 0); assert.equal(f.tab.credentialCaptureBlocked, true);
});

test('frame, top-page and document guards cannot be weakened by a caller or stale observed ref', async () => {
  for (const mutate of [
    f => { f.frame.url = 'https://other.example.test/'; },
    f => { f.tab.refs.set('confirmation-ref', { ...f.frame }); },
    f => { f.context.location.origin = 'https://other.example.test'; },
    f => { f.context.location.href = origin + '/different'; },
    f => { f.tab.revision++; },
    f => { f.args.expectedUrl = 'https://other.example.test/signup'; },
    f => { f.args.browser = 'firefox'; },
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(f.driver.prepareCredentialFill(f.args)); assert.equal(f.writes.length, 0);
  }
  const f = fixture(); await assert.rejects(f.driver.prepareCredentialFill(f.args, { source: 'user' })); assert.equal(f.writes.length, 0);
});

test('same-origin nested frames require a visible same-origin ancestor chain', async () => {
  const f = fixture();
  vm.runInContext(`top={origin,location:{origin,href:${JSON.stringify(url)}}};top.top=top;parent=top;frameElement={isConnected:true,ownerDocument:{defaultView:top},closest:()=>null,getBoundingClientRect:()=>({width:300,height:200}),checkVisibility:()=>true};top.getComputedStyle=getComputedStyle;`, f.context);
  f.frame.url = f.context.location.href = origin + '/frame';
  const commit = await f.driver.prepareCredentialFill(f.args); await commit(secret); assert.equal(f.writes.length, 3);
  for (const mutate of [
    g => { g.context.top.origin = 'https://other.example.test'; },
    g => { g.context.frameElement.isConnected = false; },
    g => { g.context.frameElement.checkVisibility = () => false; },
  ]) {
    const g = fixture(); vm.runInContext(`top={origin,location:{origin,href:${JSON.stringify(url)}}};top.top=top;parent=top;frameElement={isConnected:true,ownerDocument:{defaultView:top},closest:()=>null,getBoundingClientRect:()=>({width:300,height:200}),checkVisibility:()=>true};top.getComputedStyle=getComputedStyle;`, g.context);
    mutate(g); await assert.rejects(g.driver.prepareCredentialFill(g.args)); assert.equal(g.writes.length, 0);
  }
});

test('the secret commit revalidates after a vault wait and after its asynchronous containment check', async () => {
  for (const mutate of [
    f => { f.context.password.type = 'text'; }, f => { f.context.confirmation.hidden = true; },
    f => { f.tab.revision++; }, f => { f.frame.url = origin + '/replaced'; },
    f => { f.tab.refs.clear(); }, f => { f.tab.purpose = 'chat-mode'; },
    f => { f.context.__fixture.document = {}; },
  ]) {
    const f = fixture(), commit = await f.driver.prepareCredentialFill(f.args); f.driver.ensureContained = async () => mutate(f);
    await assert.rejects(commit(secret), { code: 'BROWSER_CREDENTIAL_FILL_UNCONFIRMED' }); assert.equal(f.writes.length, 0);
  }
});

test('secret metadata mismatch and a site exception yield generic receipts without revealing secret text', async () => {
  for (const altered of [{ ...secret, revision: 1 }, { ...secret, origin: 'https://other.example.test' }, { ...secret, credentialId: 'credential_other' }, { ...secret, username: '' }]) {
    const f = fixture(), commit = await f.driver.prepareCredentialFill(f.args);
    await assert.rejects(commit(altered), error => error.code === 'BROWSER_CREDENTIAL_FILL_UNCONFIRMED' && !error.message.includes(secret.password)); assert.equal(f.writes.length, 0);
  }
  const f = fixture(), commit = await f.driver.prepareCredentialFill(f.args); f.context.password.throwOnEvent = true;
  await assert.rejects(commit(secret), error => error.code === 'BROWSER_CREDENTIAL_FILL_UNCONFIRMED' && !error.message.includes(secret.password));
  assert.equal(f.writes.length, 3, 'An uncertain site-event outcome must not invite automatic replay.');
});

test('router secret handoff stays in the same contained driver and is invalidated by closure or owner changes', async () => {
  let commits = 0, tabId = 'owned-tab';
  const independent = { status: () => ({ available: true, tabs: [{ tabId, url }], activeTab: tabId }), prepareCredentialFill: async args => { assert.equal(args.tabId, 'owned-tab'); return async () => { commits++; return { filled: true }; }; } };
  const router = new BrowserRouter({ independent, firefox: { status: () => ({ available: true, tabs: [{ tabId: 'firefox-tab', url }], activeTab: 'firefox-tab' }) } });
  const args = fixture().args;
  await assert.rejects(router.prepareCredentialFill({ ...args, browser: 'firefox', tabId: 'firefox:firefox-tab' }));
  const commit = await router.prepareCredentialFill(args); tabId = 'replacement'; await assert.rejects(commit(secret)); assert.equal(commits, 0);
  tabId = 'owned-tab'; const second = await router.prepareCredentialFill(args); router.closed = true; await assert.rejects(second(secret)); assert.equal(commits, 0);
});
