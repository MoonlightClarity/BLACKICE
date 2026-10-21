/* Keep recovery independent of app imports, widgets, and the local server. */
(() => {
  'use strict';
  let ready = false, dismissed = false;
  const panel = document.getElementById('gui-recovery');
  const title = document.getElementById('gui-recovery-title');
  const detail = document.getElementById('gui-recovery-detail');
  const reload = document.getElementById('gui-reload');
  const dismiss = document.getElementById('gui-dismiss');
  if (!panel || !title || !detail || !reload || !dismiss) return;
  const show = () => {
    if (dismissed) return;
    title.textContent = ready ? 'Part of the interface could not update.' : 'BLACKICE could not open its workspace.';
    detail.textContent = ready
      ? 'You can keep working. If this continues, copy any unsaved text before reloading the interface. Tasks may still be running.'
      : 'Reload the interface to try again. Tasks may still be running; check their status before sending a request again.';
    reload.hidden = false;
    dismiss.hidden = !ready;
    panel.hidden = false;
  };
  const startupTimer = setTimeout(show, 45000);
  globalThis.blackiceUIResilience = {
    report() { show(); },
    ready() { ready = true; clearTimeout(startupTimer); panel.hidden = true; },
  };
  reload.addEventListener('click', () => { reload.disabled = true; location.reload(); });
  dismiss.addEventListener('click', () => { dismissed = true; panel.hidden = true; });
  window.addEventListener('error', event => {
    // Missing scripts prevent boot. Images and optional styles do not.
    if (event.target === window || event.target?.tagName === 'SCRIPT') show();
  }, true);
  window.addEventListener('unhandledrejection', show);
})();
