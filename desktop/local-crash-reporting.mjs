import path from 'node:path';
import { promises as fs } from 'node:fs';

/** Start Crashpad with no submission endpoint or network upload.
 * Minidumps can contain application memory and must stay in the user's own
 * profile. The reporter starts before Electron creates renderer processes.
 */
export async function initializeLocalCrashReporting({
  app, crashReporter, mkdir = fs.mkdir,
} = {}) {
  if (!app || !crashReporter) throw new Error('Electron crash reporting is unavailable.');
  const profile = app.getPath('userData');
  if (typeof profile !== 'string' || !path.isAbsolute(profile)) throw new Error('BLACKICE profile is unavailable.');
  const directory = path.join(profile, 'Crashpad');
  await mkdir(directory, { recursive: true });
  app.setPath('crashDumps', directory);
  crashReporter.start({
    productName: 'BLACKICE',
    uploadToServer: false,
    globalExtra: {
      source: 'BLACKICE',
      crashChannel: 'local-only',
    },
  });
  if (crashReporter.getUploadToServer?.() !== false)
    throw new Error('Crash reports are not confirmed local-only.');
  return { enabled: true, localOnly: true, directory };
}
