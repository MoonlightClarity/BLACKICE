import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The desktop entry point cannot be imported into node:test because it starts
// Electron. Bind the directional boundary to its real startup source instead.
test('desktop startup attaches the direct connection without enabling a reverse ChatGPT browser provider', async () => {
  const main = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /ElectronChatModeConnection|enableExperimentalWebMCP|chat-mode-driver|chatModeConnection/);
  assert.match(main, /createHarnessServer/); assert.match(main, /ElectronBrowserDriver/);
  assert.doesNotMatch(server, /new ChatModeRuntime|chatMode\.openSetup|chatMode\.refresh|chatMode\.drain/);
  assert.match(server, /new ChatGPTConnector/); assert.match(server, /new ChatGPTOAuth/);
  assert.match(server, /new DirectExecutionAPI/); assert.match(server, /new ChatGPTPlanningAPI/);
});
