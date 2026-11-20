/** Open the native GGUF picker using saved settings, not a renderer-supplied path. */
export async function pickLocalModelFile(manager, showOpenDialog) {
  if (!manager) throw new Error('The Local Models folder is unavailable.');
  const snapshot = manager.llamaConfig();
  let directory = await manager.llamaDirectoryStatus(snapshot);
  if (!directory?.available && snapshot.settings.modelsDirectory)
    directory = await manager.llamaDirectoryStatus({ ...snapshot, settings: { ...snapshot.settings, modelsDirectory: '' } });
  if (!directory?.available) throw new Error(directory?.error || 'The Local Models folder is unavailable.');

  const result = await showOpenDialog({
    title: 'Choose a GGUF model file',
    defaultPath: directory.path,
    properties: ['openFile'],
    filters: [{ name: 'GGUF models', extensions: ['gguf'] }],
  });
  return result.canceled ? [] : result.filePaths;
}
