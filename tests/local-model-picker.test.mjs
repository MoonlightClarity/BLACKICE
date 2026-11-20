import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pickLocalModelFile } from '../desktop/local-model-picker.mjs';
import { LocalModelManager } from '../lib/local-model-manager.mjs';

test('native GGUF picker opens the saved folder, or the profile models directory, never the workspace', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'blackice-model-picker-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const manager = await new LocalModelManager({ dataDir }).init();
  const defaultModels = path.join(dataDir, 'models'), custom = path.join(dataDir, 'my weights');
  const file = path.join(custom, 'sample.gguf'), opened = [];
  const show = async options => {
    opened.push(options);
    return options.defaultPath === custom ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: ['ignored'] };
  };
  assert.deepEqual(await pickLocalModelFile(manager, show), []);
  assert.equal((await stat(defaultModels)).isDirectory(), true);
  assert.deepEqual(opened[0], { title: 'Choose a GGUF model file', defaultPath: defaultModels, properties: ['openFile'], filters: [{ name: 'GGUF models', extensions: ['gguf'] }] });
  await mkdir(custom);
  let before = manager.llamaConfig();
  await manager.configureLlama({ expectedRevision: before.revision, settings: { ...before.settings, modelsDirectory: custom } });
  assert.deepEqual(await pickLocalModelFile(manager, show), [file]);
  assert.equal(opened[1].defaultPath, custom);
  const missing = path.join(dataDir, 'missing'); before = manager.llamaConfig();
  await manager.configureLlama({ expectedRevision: before.revision, settings: { ...before.settings, modelsDirectory: missing } });
  assert.deepEqual(await pickLocalModelFile(manager, show), []);
  assert.equal(opened[2].defaultPath, defaultModels);
  await assert.rejects(stat(missing), { code: 'ENOENT' });
  assert.equal(manager.llamaConfig().settings.modelsDirectory, missing);
});
