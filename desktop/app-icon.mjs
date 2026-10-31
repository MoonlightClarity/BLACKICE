import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function resolveDesktopIcon(desktopDirectory) {
  const iconPath = path.join(desktopDirectory, 'icon.ico');
  // A packaged launcher can virtualize AppData. The Windows shell needs the
  // physical asset path because Explorer does not share that virtualization.
  return fs.realpath(iconPath).catch(() => iconPath);
}

export async function repairDesktopShortcut({ shell, appData, executable, iconPath, appUserModelId }) {
  if (process.platform !== 'win32') return false;
  const shortcutPath = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'BLACKICE.lnk');
  let shortcut;
  try { shortcut = shell.readShortcutLink(shortcutPath); }
  catch { return false; }
  const [target, currentExecutable] = await Promise.all([
    fs.realpath(shortcut.target).catch(() => null),
    fs.realpath(executable).catch(() => null),
  ]);
  // Only repair this installation's existing shortcut; preserve its launch
  // arguments and working directory, and never take over another installation.
  if (!target || !currentExecutable || target.toLowerCase() !== currentExecutable.toLowerCase()) return false;
  if (shortcut.icon === iconPath && shortcut.iconIndex === 0 && shortcut.appUserModelId === appUserModelId) return false;
  if (!shell.writeShortcutLink(shortcutPath, 'update', { icon: iconPath, iconIndex: 0, appUserModelId })) {
    throw new Error('The Windows shortcut icon could not be saved.');
  }
  return true;
}
