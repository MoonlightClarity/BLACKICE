import { normalizeBrowserAddress } from '../public/browser-address.mjs';

// One command contract is used at transport admission and by the workspace.
// A document guard is a supported optional constraint on every page command,
// rather than a different capability depending on which transport sent it.
const page = (input = false) => ({ target: 'tab', document: true, input });
export const BROWSER_COMMANDS = Object.freeze(Object.fromEntries(Object.entries({
  tabs: { target: 'none' }, open: { target: 'none' }, navigate: page(),
  snapshot: page(), read: page(), click: page(true), hover: page(true),
  fill: page(true), type: page(true), select: page(true), press: page(true),
  scroll: page(), wait: page(), screenshot: page(), upload: page(true),
  interaction: page(), downloads: { target: 'none' }, back: page(),
  forward: page(), reload: page(), close: page(),
  folder_create: { target: 'none' }, folder_rename: { target: 'none' },
  folder_close: { target: 'none' }, tab_move: { target: 'tab' },
  suspend: { target: 'tab' }, protection: { target: 'optional' },
}).map(([action, command]) => [action, Object.freeze(command)])));
export const BROWSER_ACTIONS = Object.freeze(Object.keys(BROWSER_COMMANDS));
export const browserHasDocumentGuard = args => args?.expectedDocumentId !== undefined || args?.expectedUrl !== undefined;
export const browserCommandUsesInput = action => typeof action === 'string' && Object.hasOwn(BROWSER_COMMANDS, action) && BROWSER_COMMANDS[action].input === true;
export const browserWheelScroll = args => args?.action === 'scroll' && ['x', 'y', 'deltaX', 'deltaY'].some(key => Object.hasOwn(args, key));

export function validateBrowserCommand(value, { explicitTarget = false, code = 'BROWSER_VALIDATION' } = {}) {
  const invalid = message => { throw Object.assign(new Error(message), { code, actionDispatched: false, stage: 'validation' }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Browser tool arguments must be an object.');
  const args = { ...value }, command = typeof args.action === 'string' && Object.hasOwn(BROWSER_COMMANDS, args.action) ? BROWSER_COMMANDS[args.action] : null;
  if (args.action === 'reuse_session') invalid('Session transfer was removed because it can invalidate the source sign-in. Connect directly to the existing browser instead.');
  if (!command) invalid('Choose a supported browser action.');
  if (['source', 'purpose', 'owner'].some(key => Object.hasOwn(args, key))) invalid('Browser source, ownership and tab purpose belong to the host, not tool arguments.');
  const only = fields => { if (Object.keys(args).some(key => !fields.includes(key))) invalid('Use only the fields for this specific browser action.'); };
  const identity = ['action', 'browser', 'tabId'];
  const organization = { folder_create: ['name'], folder_rename: ['folderId', 'name'], folder_close: ['folderId'], tab_move: ['tabId', 'folderId', 'parentTabId'], suspend: ['tabId'] };
  if (args.action === 'protection') {
    const operation = args.operation || 'status';
    if (!['status', 'global', 'site', 'refresh'].includes(operation)) invalid('Choose a supported browser filtering operation.');
    only(['action', 'browser', 'operation', ...(operation === 'site' ? ['tabId', 'origin', 'enabled'] : operation === 'global' ? ['enabled'] : [])]);
    if (['global', 'site'].includes(operation) && typeof args.enabled !== 'boolean' || operation === 'site' && (!args.tabId || !args.origin)) invalid('Supply the filtering preference and the observed tab/origin for a site change.');
  } else if (Object.hasOwn(organization, args.action)) {
    only(['action', 'browser', ...organization[args.action]]);
    if (['folder_create', 'folder_rename'].includes(args.action) && (typeof args.name !== 'string' || !args.name.trim()) || ['folder_rename', 'folder_close'].includes(args.action) && !args.folderId) invalid('Supply the observed folder and name required for this organization action.');
  } else if (args.action === 'interaction') {
    only([...identity, 'interactionId', 'decision', 'promptText', 'expectedUrl', 'expectedDocumentId']);
    if (args.browser !== 'relay' || typeof args.tabId !== 'string' || !args.tabId || typeof args.interactionId !== 'string' || !/^browser_input_[a-f0-9-]{36}$/.test(args.interactionId) || !['accept', 'dismiss', 'acknowledge'].includes(args.decision) || args.promptText !== undefined && (typeof args.promptText !== 'string' || args.promptText.length > 4096 || args.decision !== 'accept')) invalid('Use the exact observed dialog, page and decision.');
  } else if (['name', 'interactionId', 'decision', 'promptText', 'operation', 'enabled', 'origin'].some(key => Object.hasOwn(args, key))) invalid('Use only the fields for this specific browser action.');

  if (explicitTarget && command.target === 'tab' && !args.tabId) invalid('Select an explicitly observed contained browser tab.');
  if (['open', 'navigate'].includes(args.action)) {
    if (!args.url) invalid('Supply the website address for this browser action.');
    try { args.url = normalizeBrowserAddress(args.url); } catch (error) { invalid(error.message); }
  }
  const pointer = ['click', 'hover'].includes(args.action), coordinates = pointer && !args.ref;
  if (coordinates && !(Number.isFinite(args.x) && Number.isFinite(args.y)) || ['fill', 'select'].includes(args.action) && !args.ref || args.action === 'upload' && Boolean(args.ref) === Boolean(args.chooserId) || args.action === 'press' && !args.key) invalid('Supply the observed target and required fields for this browser action.');
  const wheel = browserWheelScroll(args);
  if (wheel && (args.ref !== undefined || args.direction !== undefined || args.amount !== undefined || ![args.x, args.y, args.deltaX, args.deltaY].every(Number.isFinite) || args.x < 0 || args.y < 0 || !args.deltaX && !args.deltaY || args.browser !== 'relay' || typeof args.tabId !== 'string' || !args.tabId)) invalid('Scroll the observed contained page with its pointer position and finite horizontal and vertical pixel deltas.');
  if (['fill', 'type'].includes(args.action) && typeof args.text !== 'string' || args.action === 'select' && typeof args.value !== 'string') invalid('Supply text or a selection value for this input action.');
  if (typeof args.text === 'string' && args.text.length > 50000) invalid('Text is too long.');
  if (args.action === 'type' && (!args.text.length || args.text.length > 16384 || typeof args.tabId !== 'string' || !args.tabId || args.browser !== 'relay')) invalid('Type 1–16384 characters into an explicitly selected contained browser tab.');
  if (args.chooserId !== undefined && (args.action !== 'upload' || args.browser !== 'relay' || typeof args.tabId !== 'string' || !args.tabId || typeof args.chooserId !== 'string' || !/^browser_input_[a-f0-9-]{36}$/.test(args.chooserId) || args.ref !== undefined)) invalid('Use a pending contained file chooser with its exact document and URL.');

  const guardRequired = coordinates || wheel || args.action === 'type' || args.action === 'interaction' || args.chooserId !== undefined;
  if (guardRequired || browserHasDocumentGuard(args)) {
    if (!command.document || typeof args.expectedDocumentId !== 'string' || !args.expectedDocumentId || args.expectedDocumentId.length > 200 || typeof args.expectedUrl !== 'string' || !args.expectedUrl || args.expectedUrl.length > 20000) invalid('Supply both the current observed document identity and URL for this page action.');
    try { normalizeBrowserAddress(args.expectedUrl); } catch (error) { invalid(error.message); }
  }
  if (args.modifiers !== undefined && (args.action !== 'press' || !Array.isArray(args.modifiers) || args.modifiers.length > 4 || new Set(args.modifiers).size !== args.modifiers.length || args.modifiers.some(item => !['Alt', 'Control', 'Meta', 'Shift'].includes(item)))) invalid('Use supported modifiers with a page key.');
  return args;
}
