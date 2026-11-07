import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDOM } from './fixture-planning-dom.mjs';
import { createGeminiConnectorSettings } from '../public/next/workspaces/settings-gemini-connector.mjs';
import { readFile } from 'node:fs/promises';

const settle = () => new Promise(resolve => setImmediate(resolve));
const google = { id: 'google-grant', kind: 'mcp', label: 'Google', clientId: 'google-client', scopes: ['read', 'files:read', 'browser:write'], createdAt: '2026-11-07T18:00:00Z', expiresAt: '2026-12-07T18:00:00Z', lastUsedAt: '2026-11-07T18:15:00Z' };
const chatgpt = { id: 'chatgpt-grant', kind: 'chatgpt', label: 'ChatGPT', clientId: 'chatgpt-client', scopes: ['read', 'files:read', 'files:write', 'browser:read', 'browser:write', 'commands:run', 'planning:write'] };
const status = () => ({ available: true, enabled: true, endpoint: 'https://blackice.example/mcp/chatgpt', toolCatalog: { toolCount: 36 }, oauth: { healthy: true, grants: [chatgpt, google], requests: [] } });

function mount(t, snapshot = status(), custom = null) {
  const dom = planningDOM(t), calls = [];
  dom.mount.replaceChildren = function(...items) { for (const item of [...this.children]) item.remove(); this.textContent = ''; this.append(...items); };
  const state = { current: snapshot };
  const api = async (...args) => {
    calls.push(args);
    if (custom) { const override = await custom(args, state); if (override !== undefined) return override; }
    if (args[0] === '/api/chatgpt-connector') return structuredClone(state.current);
    throw Error('Unmocked Gemini settings action: ' + args.join(' '));
  };
  const panel = createGeminiConnectorSettings({ mount: dom.mount, api });
  t.after(() => panel.destroy());
  panel.enter();
  return { ...dom, panel, state, calls, writes: () => calls.filter(x => x[1] === 'POST') };
}

test('Gemini connector is a client-specific panel that leaves ChatGPT grant intact and fetches read-only status', async t => {
  const f = mount(t);
  await settle();
  assert.match(f.mount.textContent, /Google: Connected/);
  assert.match(f.mount.textContent, /ChatGPT: 1 separate active grant/);
  assert.match(f.mount.textContent, /Server tools available: 36/);
  assert.match(f.mount.textContent, /google-grant/);
  assert.doesNotMatch(f.mount.textContent, /chatgpt-grant/);
  assert.deepEqual(f.writes(), []);
  const cancel = f.$('[data-gemini-action="disconnect"]');
  await cancel.dispatch('click', {}, true);
  assert.ok(f.$('[data-gemini-action="confirm-disconnect"]'));
  assert.deepEqual(f.writes(), [], 'first click never revokes a grant');
  await f.$('[data-gemini-action="disconnect"]').dispatch('click', {}, true);
  assert.equal(f.$('[data-gemini-action="confirm-disconnect"]'), null, 'cancelled confirmation leaves the grant alone');
  assert.deepEqual(f.writes(), []);
});

test('Gemini-only disconnect checks latest client identity and never revokes ChatGPT', async t => {
  const f = mount(t, status(), async ([url,method,body], state) => {
    if (url === '/api/chatgpt-connector/revoke') {
      assert.equal(method,'POST');
      assert.deepEqual(body, { id: 'google-grant' });
      state.current.oauth.grants = [chatgpt];
      return structuredClone(state.current);
    }
  });
  await settle();
  await f.$('[data-gemini-action="disconnect"]').dispatch('click', {}, true);
  await f.$('[data-gemini-action="confirm-disconnect"]').dispatch('click', {}, true);
  await settle();
  assert.equal(f.writes().length, 1);
  assert.match(f.mount.textContent, /ChatGPT: 1 separate active grant/);
  assert.match(f.mount.textContent, /Google: Not connected/);
});

test('Pending Google authorization shows only Google request and submits only selected scopes', async t => {
  const input = status();
  input.oauth.requests = [
    { id:'chatgpt-request', clientLabel:'ChatGPT', scopes:['read','commands:run'], displayCode:'CHAT1111' },
    { id:'google-request', clientLabel:'Google', scopes:['read','files:read','commands:run'], displayCode:'GOOG2222' },
  ];
  input.oauth.grants = [chatgpt];
  const f = mount(t, input, async ([url, method, body], state) => {
    if(url==='/api/chatgpt-connector/approve-access'){
      assert.deepEqual(body,{id:'google-request',scopes:['read','files:read']});
      state.current.oauth.requests = state.current.oauth.requests.filter(x => x.id !== 'google-request');
      return structuredClone(state.current);
    }
  });
  await settle();
  assert.match(f.mount.textContent,/GOOG2222/);
  assert.doesNotMatch(f.mount.textContent,/CHAT1111/);
  const command = f.$('[data-gemini-scope="commands:run"]');
  command.checked = false;
  await command.closest('form').dispatch('submit',{},true);
  await settle();
  assert.deepEqual(f.writes()[0], ['/api/chatgpt-connector/approve-access','POST',{id:'google-request',scopes:['read','files:read']}]);
  assert.match(f.mount.textContent,/ChatGPT: 1 separate active grant/);
});

test('Gemini connector setup opens only BLACKICE contained browser and never changes OAuth grants', async t => {
  const f = mount(t,status(),async ([url,method,body]) => {
    if(url==='/api/browser/action'){
      assert.equal(method,'POST');
      assert.deepEqual(body,{action:'open',browser:'relay',url:'https://gemini.google.com/customize/connectors'});
      return {tabId:'new-gemini-tab'};
    }
  });
  await settle();
  await f.$('[data-gemini-action="open"]').dispatch('click',{},true);
  await settle();
  assert.equal(f.writes().length,1);
  assert.match(f.mount.textContent,/Gemini connectors opened in BLACKICE Browser/);
  assert.match(f.mount.textContent,/ChatGPT: 1 separate active grant/);
});

test('Settings navigation and static-file registration include independent Gemini section', async () => {
  const settings = await readFile(new URL('../public/next/workspaces/settings.mjs',import.meta.url),'utf8');
  const server = await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  assert.match(settings,/\['connector','ChatGPT connector'\],\['gemini','Gemini connector'\]/);
  assert.match(settings,/gemini:\(\)=>import\('\.\/settings-gemini-connector\.mjs'\)/);
  assert.match(server,/'workspaces\/settings-gemini-connector\.mjs'/);
});
