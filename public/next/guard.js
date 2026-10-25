(() => {
  'use strict';
  let started = false;
  const show = error => {
    if (started) return;
    const alert = document.getElementById('next-fatal');
    const detail = document.getElementById('next-fatal-detail');
    if (!alert || !detail) return;
    detail.textContent = error ? String(error.message || error.reason?.message || error).slice(0, 240) : 'The frontend did not finish initialization. Your saved work is unaffected.';
    alert.hidden = false;
  };
  const timer = setTimeout(() => show(), 8000);
  window.blackiceNextGuard = {
    ready() { started = true; clearTimeout(timer); document.getElementById('next-fatal')?.setAttribute('hidden', ''); },
    fail(error) { show(error); },
  };
  window.addEventListener('error', event => show(event.error || event.message));
  window.addEventListener('unhandledrejection', event => show(event.reason));
  document.getElementById('next-fatal-retry')?.addEventListener('click', () => location.reload());
})();