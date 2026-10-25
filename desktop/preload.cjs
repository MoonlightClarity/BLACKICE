const { contextBridge, ipcRenderer } = require('electron');

// Keep the native boundary small: no filesystem, shell, arbitrary channels or code execution.
const versionArg = process.argv.find(value => value.startsWith('--relay-version='));
contextBridge.exposeInMainWorld('relayDesktop', Object.freeze({
  platform: process.platform,
  version: versionArg?.slice('--relay-version='.length) || 'unknown',
  minimize: () => ipcRenderer.invoke('relay:minimize'),
  maximize: () => ipcRenderer.invoke('relay:maximize'),
  close: () => ipcRenderer.invoke('relay:close'),
  pickFolder: () => ipcRenderer.invoke('relay:pick-folder'),
  pickFiles: () => ipcRenderer.invoke('relay:pick-files'),
  openArtifact: reference => ipcRenderer.invoke('relay:open-artifact', reference),
  writeClipboard: text => {
    if (typeof text !== 'string' || !text.length || text.length > 4 * 1024 * 1024) return Promise.reject(new Error('Choose text within the clipboard size limit.'));
    return ipcRenderer.invoke('relay:write-clipboard', text);
  },
  detachDesktop: () => ipcRenderer.invoke('relay:detach-desktop'),
  nativeApps: request => ipcRenderer.invoke('relay:native-apps', request),
  browserSurface: request => ipcRenderer.invoke('relay:browser-surface', request),
  onBrowserShortcut: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, action) => { if (['address', 'new-tab', 'close-tab', 'reload', 'back', 'forward', 'next-tab', 'previous-tab'].includes(action)) callback(action); };
    ipcRenderer.on('relay:browser-shortcut', listener);
    return () => ipcRenderer.removeListener('relay:browser-shortcut', listener);
  },
  backupProfile: () => ipcRenderer.invoke('relay:backup-profile'),
  restoreProfile: () => ipcRenderer.invoke('relay:restore-profile'),
}));
