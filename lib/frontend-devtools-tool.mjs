import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DIRECT_JOB_LIMITS } from './direct-execution-jobs.mjs';

async function persistArtifact(directory, bytes, extension, mimeType) {
  await fs.mkdir(directory, { recursive: true });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const destination = path.join(directory, sha256 + extension);
  const receipt = { path: destination, sha256, bytes: bytes.length, mimeType };
  const existingMatches = async () => {
    try {
      const existing = await fs.readFile(destination);
      if (!existing.equals(bytes)) throw Object.assign(new Error('An existing frontend artifact has different contents: ' + destination), { code: 'FRONTEND_ARTIFACT_CONFLICT' });
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  if (await existingMatches()) return receipt;
  const temporary = path.join(directory, '.' + sha256 + '.' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    try { await fs.rename(temporary, destination); }
    catch (error) {
      // Windows may refuse rename when another completed writer has already
      // installed this content-addressed artifact. Reuse only the exact bytes.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code) || !await existingMatches()) throw error;
    }
    return receipt;
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

/** Development access to the real BLACKICE window and Electron main process. */
export function frontendDevtoolsTool({ frontend, artifactDirectory } = {}) {
  if (typeof frontend?.execute !== 'function') throw new TypeError('Frontend development needs its desktop-owned adapter.');
  if (artifactDirectory !== undefined && (typeof artifactDirectory !== 'string' || !artifactDirectory.trim())) throw new TypeError('artifactDirectory must be a directory path.');
  const directory = artifactDirectory === undefined ? null : path.resolve(artifactDirectory);
  async function preserveResult(result, args) {
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) <= DIRECT_JOB_LIMITS.resultBytes) return result;
    if (!directory) throw Object.assign(new Error('An artifactDirectory is required to preserve this oversized frontend result. The native command already completed; do not repeat it to recover the result.'), { code: 'FRONTEND_ARTIFACT_DIRECTORY_REQUIRED' });
    // Preserve the exact complete result before replacing its transport-sized
    // envelope. Profiler.stop results cannot be reconstructed by repeating stop.
    const artifact = await persistArtifact(directory, Buffer.from(encoded), '.json', 'application/json');
    const imageArtifacts = [], imageArtifactErrors = [];
    for (const [index, item] of result.contentItems.entries()) {
      if (item.type !== 'inputImage') continue;
      const png = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.imageUrl || '');
      if (!png) continue;
      try { imageArtifacts.push({ contentItemIndex: index, ...await persistArtifact(directory, Buffer.from(png[1], 'base64'), '.png', 'image/png') }); }
      catch (error) { imageArtifactErrors.push({ contentItemIndex: index, message: String(error.message || error), code: error.code }); }
    }
    const receipt = {
      action: args.action, target: args.target || 'frontend',
      method: args.method || (['evaluate', 'snapshot'].includes(args.action) ? 'Runtime.evaluate' : args.action === 'screenshot' ? 'webContents.capturePage' : null),
      success: result.success, inline: false,
      artifact: { ...artifact, format: 'blackice-direct-tool-result-v1', complete: true },
      ...(imageArtifacts.length ? { imageArtifacts } : {}),
      ...(imageArtifactErrors.length ? { imageArtifactErrors, note: 'The complete JSON artifact still includes every original imageUrl.' } : {}),
    };
    return { success: result.success, contentItems: [{ type: 'inputText', text: JSON.stringify(receipt) }] };
  }
  return {
    definition: {
      name: 'blackice_frontend',
      description: 'Inspect and operate BLACKICE itself for development. Capture the actual app window, inspect its DOM, evaluate JavaScript, or send raw DevTools Protocol commands. The frontend target is the real app renderer; the main target profiles or inspects the Electron main process. Existing commands:run authority applies. No additional confirmation or command allowlist is imposed. Debugger sessions persist across calls for profiling and tracing. Oversized complete results are saved as local artifacts with path, SHA-256 and byte count in the durable receipt. No model is started.',
      scope: 'commands:run', requiredScopes: ['commands:run'], mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$', description: 'Stable ID for this exact development action. Reuse identical arguments to recover its saved result.' },
          action: { enum: ['state', 'snapshot', 'screenshot', 'evaluate', 'cdp', 'events'] },
          target: { enum: ['frontend', 'main'], description: 'Frontend is the actual BLACKICE window. Main is the Electron host process.' },
          expression: { type: 'string', description: 'JavaScript for evaluate. Async expressions are supported.' },
          method: { type: 'string', description: 'Raw DevTools Protocol method for cdp, such as Profiler.start or Input.dispatchMouseEvent.' },
          params: { type: 'object', additionalProperties: true, description: 'Raw protocol parameters, or Runtime.evaluate options.' },
          sessionId: { type: 'string', description: 'Optional frontend CDP subtarget session ID.' },
          rect: { type: 'object', properties: { x: {type:'number'}, y: {type:'number'}, width: {type:'number'}, height: {type:'number'} }, required: ['x', 'y', 'width', 'height'], additionalProperties: false },
          after: { type: 'integer', minimum: 0, description: 'Read protocol events after this cursor.' },
          limit: { type: 'integer', minimum: 0, description: 'Maximum protocol events to return.' },
          clear: { type: 'boolean', description: 'Clear returned buffered protocol events.' },
          eventLimit: { type: 'integer', minimum: 1, description: 'Set the retained event capacity; overflow is reported.' },
          eventByteLimit: { type: 'integer', minimum: 1, description: 'Set retained protocol-event bytes; overflow is reported.' },
          snapshotOptions: { type: 'object', properties: { textLimit: {type:'integer',minimum:0}, controlLimit: {type:'integer',minimum:0} }, additionalProperties: true },
        },
        required: ['requestId', 'action'], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    timeoutMs: null,
    async execute(args, { signal } = {}) {
      let result;
      try {
        const receipt = await frontend.execute(args, { signal });
        const { imageUrl, ...value } = receipt;
        const contentItems = [{ type: 'inputText', text: JSON.stringify(value) }];
        if (imageUrl) contentItems.push({ type: 'inputImage', imageUrl });
        result = { success: !Boolean(value.exceptionDetails || value.result?.exceptionDetails), contentItems };
      } catch (error) {
        result = { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ action: args.action, target: args.target || 'frontend', error: { name: error?.name || 'Error', message: String(error?.message || error), ...(error?.code !== undefined ? { code: error.code } : {}), ...(error?.data !== undefined ? { data: error.data } : {}), ...(error?.commandDispatched !== undefined ? { commandDispatched: error.commandDispatched } : {}), ...(error?.executionMayContinue !== undefined ? { executionMayContinue: error.executionMayContinue } : {}), ...(error?.method !== undefined ? { method: error.method } : {}) } }) }] };
      }
      return preserveResult(result, args);
    },
  };
}
