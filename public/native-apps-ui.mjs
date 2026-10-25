const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const normalizeWindows = value => (Array.isArray(value) ? value : []).filter(item => item && typeof item.id === 'string' && typeof item.title === 'string' && /^\d+$/.test(item.id));

/** Actual native windows live above a matching rectangle in the Electron shell.
 * No application rendering, semantic-control catalog, or private desktop.
 */
export function initNativeAppsUI({ mount, desktop = globalThis.window?.relayDesktop, isVisible = () => true, scale = () => globalThis.window?.devicePixelRatio || 1 } = {}) {
  if (!mount) throw Error('Native Applications requires an Activity panel.');
  const send = desktop?.nativeApps;
  const $ = query => mount.querySelector(query);
  const state = { active: false, attached: false, visible: false, id: '', title: '', selected: '', windows: [], dialogs: [],
    busy: false, error: '', message: '', lastBounds: '', timer: null, positionPending: false };
  const doc = mount.ownerDocument || globalThis.document;
  if (doc && !doc.getElementById('blackice-native-app-styles')) {
    const link = doc.createElement('link');
    link.id = 'blackice-native-app-styles'; link.rel = 'stylesheet'; link.href = '/native-apps.css';
    doc.head.append(link);
  }
  mount.innerHTML = [
    '<div class="native-apps-layout">',
    '<header class="native-apps-header"><div><h2>Native applications</h2><p>Ordinary Windows processes · full application interface</p></div>',
    '<button type="button" data-native-app="refresh">Refresh windows</button></header>',
    '<div class="native-apps-toolbar"><label>Running windows <select id="native-app-picker" aria-label="Select a Windows application"></select></label>',
    '<button type="button" data-native-app="attach">Embed</button>',
    '<button type="button" data-native-app="launch">Open executable…</button>',
    '<button type="button" data-native-app="detach">Detach</button></div>',
    '<p id="native-app-notice" class="native-app-notice" role="status" aria-live="polite"></p>',
    '<div id="native-app-stage" class="native-app-stage" aria-label="Embedded native Windows application">',
    '<div id="native-app-placeholder" class="native-app-placeholder"><strong>Choose a running application.</strong>',
    '<p>Or open any installed executable. Applications keep their normal Windows account, menus, controls, and dialogs.</p>',
    '</div></div><footer class="native-app-footer"><span id="native-app-selected"></span><span id="native-app-dialogs"></span></footer></div>'
  ].join('');
  const stage = $('#native-app-stage'), picker = $('#native-app-picker');
  // Headless render fixtures and legacy clients may not construct the new panel.
  if (!stage || !picker) return { enter() {}, leave() {}, update() {}, destroy() {} };
  const view = doc?.defaultView || globalThis.window;
  const report = error => { state.error = String(error?.message || error || 'Native app operation failed.'); render(); };
  function render() {
    const choices = state.windows.map(item =>
      '<option value="' + escape(item.id) + '"' + (state.selected === item.id ? ' selected' : '') + '>' +
      escape(item.title) + ' · ' + escape(item.process || 'Application') + '</option>').join('');
    const signature = choices + '|' + state.selected;
    if (picker.dataset.signature !== signature) {
      picker.innerHTML = state.windows.length ? choices : '<option value="">No available windows</option>';
      picker.dataset.signature = signature;
      picker.value = state.windows.some(item => item.id === state.selected) ? state.selected : state.windows[0]?.id || '';
    }
    picker.disabled = !send || state.busy || !state.windows.length;
    for (const button of mount.querySelectorAll('[data-native-app]')) {
      const action = button.dataset.nativeApp;
      button.disabled = !send || state.busy || (action === 'attach' && !state.windows.length) || (action === 'detach' && !state.attached);
    }
    stage.dataset.embedded = String(state.attached);
    $('#native-app-placeholder').hidden = state.attached;
    const notice = $('#native-app-notice');
    notice.textContent = state.error || state.message || (!send
      ? 'Native application hosting requires the BLACKICE Windows desktop app.'
      : state.attached
        ? 'This is the real application. Windows handles mouse, keyboard, menus, and dialogs.'
        : 'No application-specific compatibility catalog. Existing Windows permission boundaries still apply.');
    notice.classList.toggle('error', !!state.error);
    $('#native-app-selected').textContent = state.attached ? 'Embedded: ' + (state.title || 'Application') : 'No embedded application';
    $('#native-app-dialogs').textContent = state.dialogs.length ? state.dialogs.length + ' application dialog(s)' : '';
  }
  function bounds() {
    const rect = stage.getBoundingClientRect?.();
    if (!rect) return null;
    const ratio = Math.max(.5, Math.min(4, Number(scale()) || 1));
    const screenWidth = (view?.innerWidth || 0) * ratio, screenHeight = (view?.innerHeight || 0) * ratio;
    const x = Math.max(0, Math.round(rect.left * ratio)), y = Math.max(0, Math.round(rect.top * ratio));
    const width = Math.min(Math.round(rect.width * ratio), Math.floor(screenWidth - x) - 2);
    const height = Math.min(Math.round(rect.height * ratio), Math.floor(screenHeight - y) - 2);
    if (rect.top < 0 || rect.left < 0 || rect.bottom > screenHeight / ratio + 2
        || rect.right > screenWidth / ratio + 2 || width < 80 || height < 60) return null;
    return { x, y, width, height };
  }
  async function syncPosition() {
    if (!send || !state.attached || !state.active || !isVisible()) return;
    const area = bounds();
    if (!area) {
      if (state.visible) { state.visible = false; await send({ action: 'hide' }); }
      return;
    }
    const key = JSON.stringify(area);
    if (key !== state.lastBounds) {
      state.lastBounds = key;
      await send({ action: 'position', bounds: area });
    }
    if (!state.visible) { await send({ action: 'show' }); state.visible = true; }
  }
  function schedulePosition() {
    if (!state.attached || !state.active || state.positionPending) return;
    state.positionPending = true;
    const requestFrame = view?.requestAnimationFrame?.bind(view) || (fn => setTimeout(fn, 16));
    requestFrame(() => { state.positionPending = false; void syncPosition().catch(report); });
  }
  async function refresh() {
    if (!send || state.busy) return;
    state.busy = true; state.error = ''; render();
    try {
      const [list, status] = await Promise.all([send({ action: 'windows' }), send({ action: 'status' })]);
      state.windows = normalizeWindows(list?.windows);
      state.attached = status?.attached === true;
      state.visible = status?.visible === true;
      state.id = status?.windowId || ''; state.title = status?.title || '';
      if (!state.windows.some(item => item.id === state.selected)) state.selected = state.windows[0]?.id || '';
      if (state.attached) { state.lastBounds = ''; await syncPosition(); }
    } catch (error) { state.error = error.message; }
    finally { state.busy = false; render(); }
  }
  async function action(name) {
    if (!send || state.busy) return;
    if (name === 'refresh') return refresh();
    state.busy = true; state.error = ''; state.message = ''; render();
    try {
      if (name === 'launch') {
        const result = await send({ action: 'launch' });
        state.message = result?.cancelled ? 'No application selected.' : 'Application started. Select its window after refreshing.';
      } else if (name === 'attach') {
        const area = bounds();
        if (!area) throw Error('The application panel must be entirely visible before embedding.');
        const id = picker.value;
        if (!id) throw Error('Choose an application window.');
        const result = await send({ action: 'attach', windowId: id, bounds: area });
        state.attached = result?.attached === true; state.visible = result?.visible === true;
        state.id = result?.windowId || id; state.title = result?.title || state.windows.find(item => item.id === id)?.title || '';
        state.lastBounds = JSON.stringify(area);
      } else if (name === 'detach') {
        await send({ action: 'detach' });
        state.attached = false; state.visible = false; state.id = ''; state.title = '';
        state.dialogs = []; state.lastBounds = '';
        state.message = 'The application has returned to Windows and remains running.';
      }
    } catch (error) { state.error = error.message; }
    finally { state.busy = false; render(); }
    if (name === 'launch') await refresh();
  }
  const click = event => {
    const button = event.target.closest?.('[data-native-app]');
    if (button && !button.disabled) void action(button.dataset.nativeApp);
  };
  const change = event => { if (event.target === picker) state.selected = picker.value; };
  const resize = () => schedulePosition();
  mount.addEventListener('click', click); mount.addEventListener('change', change);
  view?.addEventListener?.('resize', resize);
  view?.addEventListener?.('scroll', resize, true);
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  observer?.observe(stage);
  async function enter() {
    state.active = true;
    if (!send) { render(); return; }
    try {
      const status = await send({ action: 'status' });
      if (!state.active) return;
      state.attached = status?.attached === true; state.visible = status?.visible === true;
      state.id = status?.windowId || ''; state.title = status?.title || '';
      if (state.attached) { state.lastBounds = ''; await syncPosition(); }
    } catch (error) { report(error); }
    if (!state.active) return;
    await refresh();
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (!state.active || !isVisible() || !state.attached || state.busy) return;
      void send({ action: 'dialogs' }).then(value => {
        state.dialogs = normalizeWindows(value?.dialogs); render();
      }).catch(report);
      schedulePosition();
    }, 1600);
  }
  function leave() {
    state.active = false; clearInterval(state.timer); state.timer = null;
    if (state.attached && state.visible && send) {
      state.visible = false;
      void send({ action: 'hide' }).catch(report);
    }
  }
  function update() { if (state.active && isVisible()) schedulePosition(); }
  function destroy() {
    leave(); observer?.disconnect(); mount.removeEventListener('click', click);
    mount.removeEventListener('change', change);
    view?.removeEventListener?.('resize', resize);
    view?.removeEventListener?.('scroll', resize, true);
    mount.innerHTML = '';
  }
  render();
  return { enter, leave, update, destroy, getState: () => ({ ...state }) };
}
