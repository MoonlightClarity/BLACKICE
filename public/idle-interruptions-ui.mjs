const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const verified = value => value?.ready === true && Array.isArray(value.checks) && value.checks.length > 0 && value.checks.every(check => check.ok === true);

/** An explicit action changes Windows settings; opening setup only reads them. */
export function mountIdleInterruptions({ mount, api, intervalMs = 60_000 } = {}) {
  if (!mount || typeof api !== 'function') throw Error('Idle settings need a setup mount and API.');
  const document = mount.ownerDocument || globalThis.document;
  mount.innerHTML = `<section class="idle-interruptions" aria-labelledby="idle-interruptions-heading"><div class="idle-interruptions-heading"><h4 id="idle-interruptions-heading">Prevent idle interruptions</h4><span data-idle-state role="status" aria-live="polite" aria-atomic="true">Checking…</span></div><p class="connector-note">Keep this computer available for unattended work by turning off automatic sleep, screen-off and idle locking.</p><div class="connector-actions"><button type="button" id="idle-interruptions-enable" data-idle-enable disabled>Checking…</button><button type="button" id="idle-interruptions-refresh" data-idle-refresh disabled>Check status</button></div><p class="connector-note" data-idle-detail></p><p class="connector-error" data-idle-error role="alert" hidden></p><details data-idle-checks><summary>Windows settings checked</summary><ul class="connector-checks" data-idle-check-list></ul><p class="connector-note" data-idle-checked-at></p></details><details class="idle-interruptions-manual"><summary>Change these settings manually</summary><p class="connector-note">In Windows Settings, review <strong>System → Power &amp; battery</strong>, <strong>Accounts → Sign-in options</strong>, and <strong>Personalization → Lock screen → Screen saver</strong>. Set available sleep, screen-off and idle-lock options to Never or off. Laptop lid settings are under <strong>Control Panel → Power Options</strong>.</p><p class="connector-note">Settings managed by your organization may need its administrator. You can still lock this computer yourself.</p></details></section>`;
  const find = selector => mount.querySelector(selector);
  const ui = { state: find('[data-idle-state]'), enable: find('[data-idle-enable]'), refresh: find('[data-idle-refresh]'), detail: find('[data-idle-detail]'), error: find('[data-idle-error]'), checks: find('[data-idle-checks]'), list: find('[data-idle-check-list]'), checkedAt: find('[data-idle-checked-at]') };
  let current = null, fetching = false, checking = false, applying = false, needsCheck = false, error = '', destroyed = false, checksMarkup = '', revision = 0;

  function render() {
    if (destroyed) return;
    const ready = verified(current), busy = applying || current?.busy === true;
    const failed = !ready && current?.lastResult?.outcome === 'failed';
    const label = busy ? 'Applying…' : checking ? 'Checking…' : error || failed ? 'Needs attention' : ready ? 'On' : current?.state === 'managed' ? 'Managed by Windows' : current?.state === 'partial' ? 'Partly enabled' : current?.available === false ? 'Unavailable here' : 'Not verified';
    ui.state.textContent = label;
    ui.state.dataset.tone = busy || checking ? 'working' : error || failed ? 'error' : ready ? 'success' : 'waiting';
    ui.enable.textContent = busy ? 'Applying…' : checking ? 'Checking…' : ready && !error ? 'On' : 'Prevent idle interruptions';
    ui.enable.disabled = busy || checking || needsCheck || ready || current?.canEnable !== true;
    ui.enable.setAttribute('aria-busy', String(busy));
    ui.refresh.disabled = applying;
    ui.refresh.setAttribute('aria-disabled', String(checking || applying));
    ui.refresh.setAttribute('aria-busy', String(checking));
    ui.error.hidden = !error;
    ui.error.textContent = error;
    const prompt = !busy && !ready && current?.canEnable === true && current?.windowsPromptMayAppear === true ? ' Windows may ask for administrator approval.' : '';
    ui.detail.textContent = (busy ? 'Waiting for Windows to finish. Complete its administrator prompt if one appears.' : ready ? current.detail || 'Idle interruptions are off.' : current?.lastResult?.message || current?.detail || (checking ? 'Reading the current Windows settings.' : 'Check status to read the current Windows settings.')) + prompt;
    const checks = Array.isArray(current?.checks) ? current.checks : [];
    const markup = checks.map(check => `<li data-idle-check="${escape(check.key)}" data-ok="${check.ok === true}"><strong>${check.ok === true ? 'On' : check.managed === true ? 'Managed' : check.ok === false ? 'Needs attention' : 'Not verified'} · ${escape(check.label)}</strong>${check.detail ? `<span>${escape(check.detail)}</span>` : ''}</li>`).join('');
    if (markup !== checksMarkup) { ui.list.innerHTML = markup; checksMarkup = markup; }
    ui.checks.hidden = checks.length === 0;
    ui.checkedAt.textContent = current?.checkedAt ? 'Last checked: ' + current.checkedAt : '';
  }

  async function refresh(explicit = false) {
    if (destroyed || fetching || applying || !explicit && (!mount.isConnected || document?.visibilityState === 'hidden')) return;
    const readRevision = revision;
    fetching = true; checking = explicit || current === null; if (explicit) error = ''; render();
    try { const value = await api('/api/desktop/idle-interruptions'); if (!destroyed && readRevision === revision) { current = value; error = ''; needsCheck = false; } }
    catch (cause) { if (!destroyed && readRevision === revision) error = cause.message || 'Windows settings could not be checked.'; }
    finally { fetching = false; checking = false; render(); }
  }

  async function enable() {
    if (destroyed || checking || applying || needsCheck || current?.busy === true || current?.canEnable !== true || verified(current)) return;
    revision++;
    applying = true; error = ''; render();
    try { const value = await api('/api/desktop/idle-interruptions/enable', 'POST', {}); if (!destroyed) current = value; }
    catch (cause) { if (!destroyed) { needsCheck = true; error = (cause.message || 'Windows changes could not be confirmed.') + ' Check status before trying again.'; } }
    finally { applying = false; render(); }
  }

  const clickEnable = () => { void enable(); }, clickRefresh = () => { void refresh(true); };
  ui.enable.addEventListener('click', clickEnable); ui.refresh.addEventListener('click', clickRefresh);
  render(); void refresh(true);
  const timer = setInterval(() => { void refresh(); }, intervalMs); timer.unref?.();
  return { refresh,
    destroy() { if (destroyed) return; destroyed = true; clearInterval(timer); ui.enable.removeEventListener('click', clickEnable); ui.refresh.removeEventListener('click', clickRefresh); mount.innerHTML = ''; },
  };
}
