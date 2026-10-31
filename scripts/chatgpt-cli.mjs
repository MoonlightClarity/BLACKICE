import { runChatGPTCLI } from '../lib/chatgpt-cli.mjs';

process.exitCode = await runChatGPTCLI(process.argv.slice(2), {
  ...(process.versions.electron ? { expectedExecutable: process.execPath } : {}),
});
