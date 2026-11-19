import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readSpreadsheet } from './spreadsheet-documents.mjs';

const abort = () => Object.assign(new Error('XLSX read cancelled.'), { name: 'AbortError' });
const issue = (code, message) => Object.assign(new Error(message), { code });
const entry = new URL('./spreadsheet-reader-worker.mjs', import.meta.url);
const bootstrap = new URL('data:text/javascript,' + encodeURIComponent('await import(' + JSON.stringify(entry.href) + ');'));
const TIMEOUT = 10000;
const MAX_ACTIVE = 2;
let active = 0;

export async function readSpreadsheetInWorker(source, { signal, sheet, startRow, rowCount, startColumn, columnCount } = {}) {
  if (signal?.aborted) throw abort();
  if (active >= MAX_ACTIVE) throw issue('XLSX_BUSY', 'XLSX inspection is busy. Wait for an active document read before retrying.');
  // Transfer an exact private copy; the caller retains original bytes for the source receipt.
  const bytes = Uint8Array.from(source);
  let worker;
  try {
    worker = new Worker(bootstrap, {
      workerData: { kind: 'blackice-xlsx-read', bytes, options: { sheet, startRow, rowCount, startColumn, columnCount } },
      transferList: [bytes.buffer], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
  } catch {
    throw issue('XLSX_PROCESSING_FAILED', 'The isolated XLSX reader could not start.');
  }
  active++;
  worker.stdout.resume();
  worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let reply, failure;
    const stop = error => {
      failure ??= error;
      worker.terminate().catch(() => {});
    };
    const onAbort = () => stop(abort());
    const timer = setTimeout(() => stop(issue('XLSX_TIMEOUT', 'XLSX processing exceeded 10 seconds. Try a smaller workbook.')), TIMEOUT);
    worker.once('message', message => { reply = message; });
    worker.once('error', error => {
      failure ??= error.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? issue('XLSX_LIMIT_EXCEEDED', 'The workbook exceeded its processing memory limit.')
        : issue('XLSX_PROCESSING_FAILED', 'The isolated XLSX reader could not process the workbook.');
    });
    worker.once('exit', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      active--;
      if (failure) reject(failure);
      else if (code !== 0 || !reply) reject(issue('XLSX_PROCESSING_FAILED', 'The isolated XLSX reader stopped without a complete result.'));
      else if (reply.error) reject(issue(reply.error.code, reply.error.message));
      else resolve(reply.result);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

if (!isMainThread && parentPort && workerData?.kind === 'blackice-xlsx-read') {
  try {
    parentPort.postMessage({ result: readSpreadsheet(Buffer.from(workerData.bytes.buffer, workerData.bytes.byteOffset, workerData.bytes.byteLength), workerData.options) });
  } catch (error) {
    parentPort.postMessage({ error: { message: String(error.message), code: error.code || 'XLSX_PROCESSING_FAILED' } });
  }
}
