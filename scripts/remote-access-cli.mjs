// Works with the installed BLACKICE executable in ELECTRON_RUN_AS_NODE=1 mode;
// no separately installed Node runtime or changes to the running profile.
import { runRemoteAccessCLI } from '../lib/remote-access-cli.mjs';

process.exitCode = await runRemoteAccessCLI(process.argv.slice(2), {
  ...(process.versions.electron ? { expectedExecutable: process.execPath } : {}),
});
