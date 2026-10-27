import { randomUUID } from 'node:crypto';

const desktopReceipt = receipt => ({ ...receipt.result, requestId: receipt.requestId, phase: receipt.phase,
  launchReceipt: receipt, ...(receipt.current ? { current: receipt.current } : {}),
  ...(receipt.error ? { attached: false, embedded: false, reason: receipt.reason + ' ' + receipt.error.message } : {}) });

/** Human and agent launch requests share discovery, fresh surface observation,
 * actual attachment and durable receipts. Renderer bounds are never retained
 * across activation; the manager obtains fresh trusted geometry before attach.
 */
export function createNativeAppsIPCHandler({ host, manager, catalog, pins, trustedSender, chooseExecutable, onResult } = {}) {
  if (!host || !manager || typeof trustedSender !== 'function') throw Error('Native application IPC requires its shared window manager.');
  return async (event, request) => {
    if (!trustedSender(event) || !request || typeof request !== 'object' || Array.isArray(request)) throw Error('Native application request must come from BLACKICE.');
    const { action, windowId, bounds, executable, args, appId, appIds, refresh, requestId, recover } = request;
    if (typeof action !== 'string') throw Error('Choose a native application action.');
    if (action === 'detach') throw Object.assign(Error('Applications cannot be detached from BLACKICE.'), {code:'NATIVE_DETACH_UNAVAILABLE'});
    let result;
    if (action === 'status') return host.status();
    if (action === 'close-app') return host.closeSelected();
    if (action === 'windows') return { ...host.availability(), windows: await host.windows() };
    if (action === 'apps') { if (refresh !== undefined && typeof refresh !== 'boolean') throw Error('Refresh must be a boolean.'); return host.apps({ refresh: refresh === true }); }
    if (action === 'icons') return catalog.iconsFor(appIds);
    if (action === 'pins') return pins.read();
    if (action === 'set-pins') return pins.write(appIds);
    if (action === 'receipt') {
      if (recover !== undefined && typeof recover !== 'boolean') throw Error('Loading recovery must be a boolean.');
      return desktopReceipt(await manager.perform({ action, requestId, ...(recover === true ? { recover: true } : {}) }, { scope: 'desktop-ui' }));
    }
    if (action === 'launch') {
      let input;
      if (appId !== undefined) input = { appId, ...(executable !== undefined ? { executable } : {}), ...(args !== undefined ? { args } : {}) };
      else if (executable) input = { executable, args };
      else {
        if (typeof chooseExecutable !== 'function') throw Error('Choose a Windows application.');
        const chosen = await chooseExecutable();
        if (chosen.canceled || !chosen.filePaths?.[0]) return { cancelled: true };
        input = { executable: chosen.filePaths[0], args };
      }
      const receipt = await manager.perform({ action: 'launch', ...input, requestId: requestId ?? randomUUID() }, { scope: 'desktop-ui' });
      result = desktopReceipt(receipt);
    } else if (['attach', 'focus'].includes(action)) {
      result = await manager.perform({ action, ...(action === 'attach' ? { windowId } : {}) }, { scope: 'desktop-ui' });
    } else if (action === 'position') return host.position(bounds);
    else if (action === 'show') return host.visibleState(true);
    else if (action === 'hide') return host.visibleState(false);
    else if (action === 'dialogs') return { dialogs: await host.dialogs() };
    else throw Error('Unsupported native application command.');
    try { await onResult?.({ action, result }); } catch { /* Diagnostics cannot change an application effect. */ }
    return result;
  };
}
