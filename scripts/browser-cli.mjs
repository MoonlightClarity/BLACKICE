import { runBrowserCLI } from '../lib/browser-cli.mjs';

process.exitCode = await runBrowserCLI(process.argv.slice(2), {
  ...(process.versions.electron ? { expectedExecutable: process.execPath } : {}),
});
