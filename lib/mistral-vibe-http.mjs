const failure = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

/** Native account setup stays separate from saved API connections and inference. */
export function createMistralVibeHttp({ runtime, browser, defaultCwd, readBody, sendJSON, getStatus = () => runtime.status(), onStatus = () => {} }) {
  let loginRequest = null, loginTab = null;
  const provider = () => runtime.mistralVibeStatus?.() || null;
  const reply = (res, status, data) => { sendJSON(res, status, data); return true; };
  const openSignIn = async url => {
    let target;
    try { target = new URL(url); } catch { throw failure('Mistral Vibe Code did not return a valid sign-in address.', 'MISTRAL_VIBE_AUTH_URL'); }
    if (target.protocol !== 'https:' || target.username || target.password) throw failure('Mistral Vibe Code sign-in requires an HTTPS browser address.', 'MISTRAL_VIBE_AUTH_URL');
    const existing = loginTab && browser.status?.().tabs?.some(tab => (tab.tabId || tab.id) === loginTab.tabId);
    let opened;
    if (existing && loginTab.url === target.href) opened = await browser.perform({ action: 'tab_select', tabId: loginTab.tabId }, { source: 'user' });
    else if (existing) opened = await browser.perform({ action: 'navigate', tabId: loginTab.tabId, url: target.href }, { source: 'user' });
    else opened = await browser.perform({ action: 'open', url: target.href }, { source: 'user' });
    const tabId = opened?.tabId || opened?.tab?.tabId || opened?.tab?.id || (existing ? loginTab.tabId : null);
    loginTab = tabId ? { tabId, url: target.href } : null;
    return tabId;
  };
  return async function handleMistralVibeHttp(req, res, pathname) {
    const match = pathname.match(/^\/api\/subscriptions\/mistral-vibe(?:\/(refresh|login))?$/);
    if (!match) return false;
    const action = match[1];
    if (req.method === 'GET' && !action) return reply(res, 200, { provider: provider(), status: getStatus() });
    if (req.method !== 'POST' || !action) return reply(res, 405, { error: 'Use GET for account status or POST for an explicit sign-in or catalog refresh.' });
    const input = await readBody(req, 4096);
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) return reply(res, 400, { error: 'This native account action does not accept API keys, model choices, or connection settings.' });
    if (action === 'refresh') {
      if (typeof runtime.refreshMistralVibe !== 'function') return reply(res, 503, { error: 'Mistral Vibe Code is unavailable in this runtime.', code: 'MISTRAL_VIBE_UNAVAILABLE' });
      await runtime.refreshMistralVibe({ cwd: defaultCwd }); onStatus();
      return reply(res, 200, { provider: provider(), status: getStatus() });
    }
    if (typeof runtime.beginMistralVibeLogin !== 'function') return reply(res, 503, { error: 'Mistral Vibe Code sign-in is unavailable in this runtime.', code: 'MISTRAL_VIBE_UNAVAILABLE' });
    if (!loginRequest) {
      loginRequest = (async () => {
        const result = await runtime.beginMistralVibeLogin();
        const browserTabId = result?.url ? await openSignIn(result.url) : undefined;
        onStatus();
        return { provider: provider(), status: getStatus(), login: { state: result?.state || provider()?.loginState || 'waiting' }, ...(browserTabId ? { browserTabId } : {}) };
      })();
      loginRequest.finally(() => { loginRequest = null; }).catch(() => {});
    }
    return reply(res, 200, await loginRequest);
  };
}
