import { createHash } from 'node:crypto';
const fail = (message = 'The reviewed browser target changed. Inspect the page before requesting a new review.') =>
  Object.assign(new Error(message), { code: 'BROWSER_RECOVERY_CHANGED', actionDispatched: false });
function stable(value, depth = 0) {
  if (depth > 20) throw fail('Browser recovery details exceed their bound.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => stable(item, depth + 1));
  if (!value || typeof value !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw fail();
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key], depth + 1)]));
}
const serialized = value => {const text = JSON.stringify(stable(value)); if (text.length > 100000) throw fail('Browser recovery details exceed their bound.'); return text;};
export const browserRecoveryDigest = value => createHash('sha256').update(serialized(value)).digest('hex');
const controlActions = new Set(['click', 'fill', 'select', 'press']);
const pageActions = new Set(['navigate', 'reload', 'close']);
const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 20000;
export function createBrowserRecoveryBinding(call, target, observation) {
  if (call?.name !== 'relay_browser' || !target || target.browser && target.browser !== 'relay') throw fail('Only contained native browser actions can be reviewed.');
  const action = target.action;
  if (!controlActions.has(action) && !pageActions.has(action) && action !== 'open') throw fail('This browser action has no exact recovery binding.');
  if (['open', 'navigate'].includes(action)) {
    let url; try { url = new URL(target.url); } catch { throw fail(); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw fail('Recovery navigation requires an ordinary HTTP(S) destination.');
  }
  const originalArgs = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
  const argumentsDigest = browserRecoveryDigest(originalArgs);
  let page = null, control = null;
  if (action !== 'open') {
    if (!observation?.current || observation.tabId !== target.tabId || !validText(observation.documentId) || !validText(observation.url)) throw fail('The exact current browser document is unavailable.');
    page = {tabId: observation.tabId, documentId: observation.documentId, url: observation.url};
  }
  if (controlActions.has(action)) {
    const item = observation?.control;
    if (!validText(target.ref) || item?.ref !== target.ref || !item.recovery || item.recovery.version !== 1 || !validText(item.recovery.nodeId)
      || !/^[a-f0-9]{64}$/.test(item.recovery.stateDigest || '') || item.recovery.private === true) throw fail('A fresh, non-credential native control is required for this recovery action.');
    control = stable(item);
  }
  return {version:1, adapter:'relay_browser', action, argumentsDigest, arguments:stable(target), page, control};
}
export function assertBrowserRecoveryBinding(expected, call, target, observation) {
  if (!expected || expected.version !== 1 || expected.adapter !== 'relay_browser') throw fail();
  const current = createBrowserRecoveryBinding(call, target, observation);
  if (serialized(current) !== serialized(expected)) throw fail();
  return current;
}
