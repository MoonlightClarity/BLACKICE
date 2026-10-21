import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const MAX_BYTES = 25 * 1024 * 1024;
const fail = (message, code = 'CHATGPT_FILE_IMPORT_FAILED') => Object.assign(new Error(message), { code });
const aborted = () => Object.assign(fail('File import was cancelled.', 'ABORT_ERR'), { name: 'AbortError' });
const check = signal => { if (signal?.aborted) throw aborted(); };

// Pin the DNS result used by the socket. A public URL must never become a route
// to loopback, the private network, link-local metadata, or an IPv4 tunnel.
export function publicFileAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6 || address.includes('%') || address.includes('.')) return false;
  const lower = address.toLowerCase(), first = parseInt(lower.split(':')[0], 16);
  return (first & 0xe000) === 0x2000 && !/^2002:/.test(lower) && !/^2001:(?:0*:|0*db8:)/.test(lower);
}

export function validateChatGPTDownloadURL(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('Attach the file again to obtain a current download URL.', 'CHATGPT_FILE_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || !url.hostname || value.length > 16000) throw fail('Use a temporary HTTPS download URL without credentials, fragments or a custom port.', 'CHATGPT_FILE_URL_INVALID');
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw fail('File download URLs must use a public hostname.', 'CHATGPT_FILE_URL_INVALID');
  return url;
}

export async function downloadChatGPTFile(urlValue, { signal: parentSignal, resolve = lookup, request = https.request, timeoutMs = 30000 } = {}) {
  const url = validateChatGPTDownloadURL(urlValue);
  check(parentSignal);
  const controller = new AbortController(), signal = controller.signal;
  const cancelParent = () => controller.abort(aborted());
  const deadline = setTimeout(() => controller.abort(fail('The file download timed out. No imported file was saved.', 'CHATGPT_FILE_DOWNLOAD_TIMEOUT')), timeoutMs);
  parentSignal?.addEventListener('abort', cancelParent, { once: true });
  try {
  // DNS may not support AbortSignal. Stop awaiting it at the same deadline as
  // the download, and never start a socket if its late answer arrives.
  const answers = await new Promise((accept, reject) => {
    const stop = () => reject(signal.reason || aborted());
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) return stop();
    Promise.resolve().then(() => resolve(url.hostname, { all: true, verbatim: true })).then(accept, () => reject(fail('The file hostname could not be resolved.', 'CHATGPT_FILE_DOWNLOAD_FAILED'))).finally(() => signal.removeEventListener('abort', stop));
  });
  if (signal.aborted) throw signal.reason || aborted();
  if (!answers.length || answers.some(answer => !publicFileAddress(answer.address))) throw fail('The file download address is not a public internet address.', 'CHATGPT_FILE_ADDRESS_BLOCKED');
  const selected = answers[0];
  return await new Promise((resolveResult, reject) => {
    let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; signal.removeEventListener('abort', cancel); error ? reject(error) : resolveResult(result); };
    const req = request(url, { method: 'GET', headers: { Accept: 'application/octet-stream', 'User-Agent': 'BLACKICE-file-import' }, agent: false,
      lookup: (_hostname, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
    }, response => {
      if (response.statusCode !== 200) { response.resume(); finish(fail(response.statusCode >= 300 && response.statusCode < 400 ? 'The file URL redirected. Attach the file again; redirects are not followed.' : 'The file URL expired or did not return a complete file. Attach the file again.', 'CHATGPT_FILE_DOWNLOAD_REJECTED')); req.destroy(); return; }
      const declared = response.headers['content-length'];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) { finish(fail('The file exceeds the 25 MiB import limit.', 'CHATGPT_FILE_TOO_LARGE')); response.destroy(); return; }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) { finish(fail('The file exceeds the 25 MiB import limit.', 'CHATGPT_FILE_TOO_LARGE')); response.destroy(); req.destroy(); } else chunks.push(chunk); });
      response.once('error', () => finish(fail('The file download was interrupted. No imported file was saved.', 'CHATGPT_FILE_DOWNLOAD_INTERRUPTED')));
      response.once('aborted', () => finish(fail('The file download was interrupted. No imported file was saved.', 'CHATGPT_FILE_DOWNLOAD_INTERRUPTED')));
      response.once('end', () => {
        if (declared !== undefined && Number(declared) !== bytes) return finish(fail('The file download was incomplete. No imported file was saved.', 'CHATGPT_FILE_DOWNLOAD_INTERRUPTED'));
        finish(null, Buffer.concat(chunks));
      });
    });
    const cancel = () => { finish(signal.reason || aborted()); req.destroy(); };
    req.once('error', () => finish(fail('The file download could not be completed. Attach the file again.', 'CHATGPT_FILE_DOWNLOAD_FAILED')));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel(); else req.end();
  });
  } finally { clearTimeout(deadline); parentSignal?.removeEventListener('abort', cancelParent); }
}

/** A host-registered direct action; the signed URL never enters the durable ledger. */
export function chatGPTFileImportTool({ directory, download = downloadChatGPTFile } = {}) {
  if (!path.isAbsolute(directory || '')) throw Error('File imports need an owned absolute directory.');
  const fileSchema = { type: 'object', properties: {
    download_url: { type: 'string', minLength: 1, maxLength: 16000 }, file_id: { type: 'string', minLength: 1, maxLength: 200 },
    mime_type: { type: 'string', maxLength: 200 }, file_name: { type: 'string', maxLength: 240 },
  }, required: ['download_url', 'file_id'], additionalProperties: false };
  return {
    definition: {
      name: 'blackice_import_file', scope: 'files:write',
      description: 'Import a file explicitly attached or selected in ChatGPT into BLACKICE’s private import area (up to 25 MiB). Returns an exact saved path and SHA-256 after completion. The file is not uploaded to a website or executed. Reuse requestId to retrieve the same action; expired links require reattaching the file and a fresh request.',
      inputSchema: { type: 'object', properties: { requestId: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$' }, file: fileSchema }, required: ['requestId', 'file'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { 'openai/fileParams': ['file'] },
    },
    durableArguments: args => ({ requestId: args.requestId, sourceOrigin: validateChatGPTDownloadURL(args.file.download_url).origin, file: { file_id: args.file.file_id, ...(args.file.file_name ? { file_name: args.file.file_name } : {}), ...(args.file.mime_type ? { mime_type: args.file.mime_type } : {}) } }),
    async execute(args, { signal, jobId } = {}) {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(jobId || '')) throw fail('The import requires an owned action identifier.');
      validateChatGPTDownloadURL(args.file.download_url);
      check(signal);
      const bytes = await download(args.file.download_url, { signal });
      check(signal);
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw fail('The file exceeds the 25 MiB import limit.', 'CHATGPT_FILE_TOO_LARGE');
      // The workspace already exists; refuse a linked ancestor before creating
      // an import directory or writing any downloaded bytes.
      const parent = path.dirname(directory), realParent = await fs.realpath(parent);
      if (path.relative(realParent, parent) !== '') throw fail('The file import directory moved or is linked. Review it in BLACKICE.', 'CHATGPT_FILE_DIRECTORY_CHANGED');
      await fs.mkdir(directory, { recursive: true });
      const info = await fs.lstat(directory);
      const realDirectory = await fs.realpath(directory), samePath = process.platform === 'win32' ? realDirectory.toLowerCase() === path.resolve(directory).toLowerCase() : realDirectory === path.resolve(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath) throw fail('The file import directory moved or is linked. Review it in BLACKICE.', 'CHATGPT_FILE_DIRECTORY_CHANGED');
      const suppliedName = args.file.file_name || args.file.file_id;
      const fileName = path.basename(suppliedName.replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 180) || 'attachment';
      const selected = path.join(directory, `${jobId}-${fileName}`), temporary = path.join(directory, `.import-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        check(signal);
        // link() is an atomic no-overwrite admission. Each durable job gets one path.
        await fs.link(temporary, selected);
      } catch (error) {
        if (error.code === 'EEXIST') throw fail('This import already has a saved file. Read its action result before starting another import.', 'CHATGPT_FILE_ALREADY_SAVED');
        throw error;
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ path: selected, fileName, fileId: args.file.file_id, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), imported: true, uploadedToWebsite: false }) }] };
    },
  };
}
