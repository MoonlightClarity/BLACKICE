import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDOM } from './fixture-planning-dom.mjs';
import { createClaudeConnectorSettings } from '../public/next/workspaces/settings-claude-connector.mjs';
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
    throw Error('Unmocked Claude settings action: ' + args.join(' '));
  };
  const panel = createClaudeConnectorSettings({ mount: dom.mount, api });
  t.after(() => panel.destroy());
  panel.enter();
  return { ...dom, panel, state, calls, writes: () => calls.filter(x => x[1] === 'POST') };
}

test('refresh account models displays the outbound catalog and clears it on failure', async t => {
  let failed = false;
  const f = mount(t, status(), async ([url]) => {
    if (url !== '/api/providers/claude-account/models') return;
    if (failed) throw Error('sign in again');
    return { models: [{ id: 'account-choice', name: 'Account Choice' }] };
  });
  await settle();
  const refresh = async () => { await f.$('[data-claude-action="models"]').dispatch('click', {}, true); await settle(); };
  assert.match(f.mount.textContent, /Whether it restricts this model lookup is unknown/);
  await refresh();
  assert.match(f.mount.textContent, /Account Choice/);
  failed = true;
  await refresh();
  assert.match(f.mount.textContent, /sign in again/);
  assert.doesNotMatch(f.mount.textContent, /Account Choice/);
});
