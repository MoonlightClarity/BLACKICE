import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const failure = (message, code = 'LLAMA_CPP_ERROR') => Object.assign(new Error(message), { code });
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const boundedInteger = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max;

/** Executes a bundled llama.cpp CLI directly. Does not require Ollama or LM Studio. */
export class LlamaCppBackend {
  constructor({ binaryPath, spawnImpl = spawn, accessImpl = access } = {}) {
    // The binary must ship beside BLACKICE (or be explicitly selected for development).
    const binaryName = process.platform === 'win32' ? 'llama-cli.exe' : 'llama-cli';
    this.binaryPath = binaryPath || path.join(process.resourcesPath || path.resolve('.'),
      'native-inference', 'llama.cpp', binaryName);
    this.spawnImpl = spawnImpl;
    this.accessImpl = accessImpl;
  }

  async available() {
    try { await this.accessImpl(this.binaryPath); return true; } catch { return false; }
  }

  async generate({ modelPath, prompt, maxTokens = 128, contextSize = 2048, signal, onText } = {}) {
    if (!nonempty(modelPath) || !path.isAbsolute(modelPath) || !/\.gguf$/i.test(modelPath))
      throw failure('Choose an absolute path to an existing GGUF model.', 'LLAMA_CPP_MODEL_PATH');
    if (typeof prompt !== 'string' || !prompt.length) throw failure('Provide a nonempty text prompt.');
    if (!boundedInteger(maxTokens, 65536) || !boundedInteger(contextSize, 262144))
      throw failure('Token and context limits must be positive integers within supported bounds.');
    if (!await this.available()) throw failure('The llama.cpp executable is not bundled or configured.', 'LLAMA_CPP_NOT_INSTALLED');
    try { if (!(await stat(modelPath)).isFile()) throw failure('GGUF model is not a file.', 'LLAMA_CPP_MODEL_PATH'); }
    catch (error) {
      if (error.code === 'ENOENT') throw failure('GGUF model file does not exist.', 'LLAMA_CPP_MODEL_PATH');
      throw error;
    }
    signal?.throwIfAborted();
    // Avoid putting prompts on the operating-system command line.
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'blackice-llama-prompt-'));
    const promptFile = path.join(temporary, 'prompt.txt');
    await writeFile(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });
    const args = ['--offline', '--model', modelPath, '--file', promptFile, '--n-predict', String(maxTokens),
      '--ctx-size', String(contextSize), '--temp', '0', '--simple-io', '--single-turn',
      '--no-display-prompt', '--no-conversation', '--no-show-timings', '--log-disable'];
    try {
      return await new Promise((resolve, reject) => {
        let processHandle, done = false, stopped = false, transcript = '', outstanding = Promise.resolve();
        let err = '', aborted = Boolean(signal?.aborted);
        const abort = () => { aborted = true; processHandle?.kill(); };
        const finish = (cause, result) => {
          if (done) return;
          done = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort);
          cause ? reject(cause) : resolve(result);
        };
        try { processHandle = this.spawnImpl(this.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }); }
        catch (error) { reject(error); return; }
        const timeout = setTimeout(() => {
          stopped = true;
          processHandle.kill();
        }, 10 * 60 * 1000);
        signal?.addEventListener('abort', abort, { once: true });
        if (aborted) abort();
        processHandle.stdout?.on('data', bytes => {
          const piece = String(bytes);
          transcript += piece;
          if (transcript.length > 12 * 1024 * 1024) { stopped = true; processHandle.kill(); return; }
          if (onText) outstanding = outstanding.then(() => onText(piece)).catch(error => {
            err = error?.message || 'Stream consumer rejected output.';
            stopped = true; processHandle.kill();
          });
        });
        processHandle.stderr?.on('data', bytes => { err = (err + String(bytes)).slice(-2048); });
        processHandle.once('error', error => finish(failure('Could not start bundled llama.cpp: ' + error.message, 'LLAMA_CPP_SPAWN_FAILED')));
        processHandle.once('close', code => {
          void outstanding.then(() => finish(aborted ? failure('Generation cancelled.', 'ABORT_ERR')
            : stopped ? failure(err || 'Generation exceeded its execution limit.', 'LLAMA_CPP_STOPPED')
              : code !== 0 ? failure('llama.cpp exited with code ' + code + ': ' + err.slice(-600), 'LLAMA_CPP_EXIT_FAILED')
                : null, { backend: 'llama.cpp', text: transcript, completed: code === 0 }));
        });
      });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
