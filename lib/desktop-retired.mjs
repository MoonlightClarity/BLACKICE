import { EventEmitter } from 'node:events';
export const DESKTOP_RETIRED_MESSAGE = 'Live Windows desktop automation has been retired. Use the contained BLACKICE browser or a supported application integration; do not operate or foreground other desktop applications.';
export const desktopRetiredError = () => Object.assign(new Error(DESKTOP_RETIRED_MESSAGE), { code: 'DESKTOP_RETIRED', status: 410, actionDispatched: false });
/** Compatibility status only. Never creates a Windows session or reads user windows. */
export class RetiredDesktopController extends EventEmitter {
  status() { return { available: false, enabled: false, retired: true, mode: 'retired', actions: [], physicalInput: false, reason: DESKTOP_RETIRED_MESSAGE }; }
  setEnabled(enabled) { if (enabled) throw desktopRetiredError(); return this.status(); }
  async perform() { throw desktopRetiredError(); }
}
export function createRetiredDesktopToolHandler() {
  return async () => ({ success: false, code: 'DESKTOP_RETIRED', contentItems: [{ type: 'inputText', text: JSON.stringify({ ok: false, code: 'DESKTOP_RETIRED', error: DESKTOP_RETIRED_MESSAGE, actionDispatched: false }) }] });
}
