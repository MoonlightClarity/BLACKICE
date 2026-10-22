/** Read-only QA evidence; installer write rules do not define the source inventory. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const EXCLUDED_NAMES = new Set(['node_modules', 'data', 'workspace', '.build', 'dist', '.git', '__pycache__']);
const MAXIMUM_FILES = 10000;
const MAXIMUM_FILE_BYTES = 64 * 1024 * 1024;
const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/** Hash ordinary source files, including workflows and future root documents, without writing anything. */
export async function captureSourceEvidence(directory) {
  const root = path.resolve(directory), rootInfo = await fs.lstat(root), files = [];
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Source evidence requires an ordinary candidate directory.');

  async function visit(relative) {
    const name = path.posix.basename(relative);
    if (EXCLUDED_NAMES.has(name) || name.includes('.currents-backup-')) return;
    const location = path.join(root, relative), info = await fs.lstat(location);
    if (info.isSymbolicLink()) throw new Error('Source evidence cannot follow links: ' + relative);
    if (info.isDirectory()) {
      for (const child of (await fs.readdir(location)).sort(lexical)) await visit(path.posix.join(relative, child));
      return;
    }
    if (!info.isFile()) throw new Error('Source evidence requires ordinary files: ' + relative);
    if (files.length >= MAXIMUM_FILES) throw new Error('Source evidence exceeds its file limit.');
    if (info.size > MAXIMUM_FILE_BYTES) throw new Error('Source evidence file exceeds its size limit: ' + relative);
    const bytes = await fs.readFile(location);
    if (bytes.length > MAXIMUM_FILE_BYTES) throw new Error('Source evidence file exceeds its size limit: ' + relative);
    files.push([relative, createHash('sha256').update(bytes).digest('hex')]);
  }

  for (const name of (await fs.readdir(root)).sort(lexical)) await visit(name);
  return Object.fromEntries(files.sort(([left], [right]) => lexical(left, right)));
}
