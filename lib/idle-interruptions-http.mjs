const ROOT = '/api/desktop/idle-interruptions';

// Called after the harness's host, same-origin and session-cookie checks.
// This is intentionally not a model tool or remotely forwarded management API.
export async function handleIdleInterruptionsHttp({ req, res, pathname, manager, body, json, fileMutations, isClosing = () => false }) {
  if (pathname !== ROOT && !pathname.startsWith(`${ROOT}/`)) return false;
  if (req.headers['x-blackice-remote'] === '1') { json(res, 403, { error: 'Manage Windows interruption settings from BLACKICE on this computer.', code: 'IDLE_INTERRUPTION_LOCAL_ONLY' }); return true; }
  if (req.url.includes('?')) { json(res, 400, { error: 'Interruption setup does not accept URL parameters.', code: 'IDLE_INTERRUPTION_INVALID' }); return true; }
  if (pathname === ROOT && req.method === 'GET') {
    json(res, 200, typeof manager?.snapshot === 'function' ? await manager.snapshot({ refresh: true }) : { available: false, ready: false, state: 'unavailable', canEnable: false, busy: false, checkedAt: null, checks: [], detail: 'Open BLACKICE desktop on Windows to prevent idle interruptions.', windowsPromptMayAppear: false });
    return true;
  }
  if (pathname !== `${ROOT}/enable` || req.method !== 'POST') { json(res, 404, { error: 'Unknown interruption setup action.', code: 'IDLE_INTERRUPTION_ACTION' }); return true; }
  const value = await body(req, 1024);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) { json(res, 400, { error: 'Use the interruption setup button in BLACKICE.', code: 'IDLE_INTERRUPTION_INVALID' }); return true; }
  if (isClosing()) { json(res, 503, { error: 'BLACKICE is closing for maintenance.', code: 'IDLE_INTERRUPTION_CLOSING' }); return true; }
  if (typeof manager?.enable !== 'function') { json(res, 409, { error: 'Windows interruption setup is unavailable.', code: 'IDLE_INTERRUPTION_UNAVAILABLE' }); return true; }
  const pending = manager.enable(); fileMutations.add(pending);
  try { json(res, 200, await pending); }
  catch (error) { json(res, error?.status === 503 ? 503 : 409, { error: String(error?.code || '').startsWith('IDLE_INTERRUPTION_') ? error.message : 'Windows interruption setup could not be completed. Check status again.', code: String(error?.code || '').startsWith('IDLE_INTERRUPTION_') ? error.code : 'IDLE_INTERRUPTION_FAILED' }); }
  finally { fileMutations.delete(pending); }
  return true;
}
