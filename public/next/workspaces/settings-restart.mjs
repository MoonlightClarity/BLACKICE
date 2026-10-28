const KEY = 'blackice.next.force-restart';
const VALID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const effectMessage = effects => {
  if (!effects || typeof effects !== 'object' || Array.isArray(effects)) return '';
  const parts = [], sessions = Array.isArray(effects.privateSessions) ? effects.privateSessions : [];
  const countSessions = outcome => sessions.filter(value => value?.outcome === outcome).length;
  const closed = countSessions('confirmed'), requested = countSessions('requested'), uncertain = countSessions('uncertain');
  if (closed) parts.push(`${closed} private session${closed === 1 ? '' : 's'} confirmed closed`);
  if (requested) parts.push(`cleanup requested for ${requested} private session${requested === 1 ? '' : 's'}, but process exit is unconfirmed`);
  if (uncertain) parts.push(`cleanup outcome unknown for ${uncertain} private session${uncertain === 1 ? '' : 's'}`);
  const browser = effects.browser;
  const readCount = (kind, outcome) => Number.isSafeInteger(browser?.[kind]?.[outcome]) && browser[kind][outcome] > 0 ? browser[kind][outcome] : 0;
  const stopped = readCount('loads', 'stopped'), dismissed = readCount('interactions', 'dismissed');
  const cancelled = readCount('downloads', 'cancelled'), completed = readCount('downloads', 'completed'), interrupted = readCount('downloads', 'interrupted');
  if (stopped) parts.push(`${stopped} browser load${stopped === 1 ? '' : 's'} stopped`);
  if (dismissed) parts.push(`${dismissed} browser interaction${dismissed === 1 ? '' : 's'} dismissed`);
  if (cancelled) parts.push(`${cancelled} download${cancelled === 1 ? '' : 's'} cancelled`);
  if (completed) parts.push(`${completed} download${completed === 1 ? '' : 's'} completed before cancellation`);
  if (interrupted) parts.push(`${interrupted} download${interrupted === 1 ? '' : 's'} interrupted`);
  const browserUncertain = ['loads', 'interactions', 'downloads'].reduce((total, kind) => total + readCount(kind, 'uncertain'), 0);
  if (browserUncertain) parts.push(`${browserUncertain} browser action${browserUncertain === 1 ? '' : 's'} with unconfirmed outcome${browserUncertain === 1 ? '' : 's'}`);
  return parts.length ? ` Recorded effects: ${parts.join('; ')}.` : '';
};
const message = receipt => {
  const main = receipt.status === 'completed' ? 'BLACKICE reopened after the restart.'
    : receipt.status === 'scheduled' || receipt.status === 'restarting' ? 'Restart scheduled. BLACKICE will reopen when the handoff completes.'
    : receipt.error?.message || `Restart ${receipt.status}. BLACKICE did not confirm a completed restart.`;
  return main + effectMessage(receipt.forceEffects);
};

// Keep the same ID through a lost response. Checking a receipt does not start
// another restart and a completed/failed request is never silently replayed.
export function createForceRestart({ api, storage, makeId = () => `ui-force-${crypto.randomUUID()}`, onChange = () => {} }) {
  let record = null, busy = false;
  try { const saved = JSON.parse(storage?.getItem(KEY) || 'null'); if (saved && VALID.test(saved.requestId) && typeof saved.status === 'string') record = saved; } catch {}
  const save = () => { try { if (record) storage?.setItem(KEY, JSON.stringify(record)); } catch {} };
  const state = () => ({ busy, record: record ? { ...record } : null, canStart: !busy && (!record || TERMINAL.has(record.status)), canCheck: !busy && Boolean(record) });
  const notify = () => onChange(state());
  const inspect = (value, requestId) => {
    const receipt = value?.receipt;
    if (value?.protocol !== 1 || value.acknowledged !== true || receipt?.requestId !== requestId || receipt.force !== true || !['scheduled', 'restarting', 'completed', 'failed', 'cancelled', 'interrupted'].includes(receipt.status)) throw new Error('The restart receipt could not be verified. Check this request before trying another.');
    record = { requestId, status: receipt.status, message: message(receipt) }; save();
  };
  async function run(action) {
    if (busy || action === 'start' && record && !TERMINAL.has(record.status) || action === 'check' && !record) return;
    if (action === 'start') {
      let requestId;
      try { requestId = makeId(); if (!VALID.test(requestId)) throw new Error('Invalid restart request ID.'); }
      catch { onChange({ ...state(), error: 'A restart request ID could not be created.' }); return state(); }
      record = { requestId, status: 'unknown', message: 'Requesting restart…' }; save();
    }
    const requestId = record.requestId; busy = true; notify();
    try { inspect(await api(action === 'start' ? '/api/desktop/restart' : '/api/desktop/restart/status', 'POST', action === 'start' ? { requestId, force: true } : { requestId }), requestId); }
    catch (error) { record = { requestId, status: 'unknown', message: `${error?.message || 'Restart status is unavailable.'} Check this request before trying another.` }; save(); }
    finally { busy = false; notify(); }
    return state();
  }
  return { state, start: () => run('start'), check: () => run('check') };
}
