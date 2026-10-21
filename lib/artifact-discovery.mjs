import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TASK_LIMITS } from './task-state.mjs';

const fail = (message, code) => Object.assign(new Error(message), { code });
const check = signal => { if (signal?.aborted) throw Object.assign(fail('File discovery cancelled.', 'ABORT_ERR'), { name: 'AbortError' }); };
const contained = (base, file) => { const relative = path.relative(base, file); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

function linkAt(source, start) {
  let brackets = 1, cursor = start + 1;
  for (; cursor < source.length && cursor - start < 4000; cursor++) {
    if (/[\r\n]/.test(source[cursor])) return null;
    if (source[cursor] === '\\') { cursor++; continue; }
    if (source[cursor] === '[' && ++brackets > 8) return null;
    if (source[cursor] === ']' && --brackets === 0) break;
  }
  if (brackets || source[cursor + 1] !== '(') return null;
  const label = source.slice(start + 1, cursor), begin = cursor + 2;
  if (source[begin] === '<') {
    const end = source.indexOf('>', begin + 1);
    return end < 0 || end - begin > 8000 || source[end + 1] !== ')' || /[\r\n]/.test(source.slice(begin, end)) ? null : { label, href: source.slice(begin + 1, end), end: end + 2 };
  }
  let parens = 1;
  for (cursor = begin; cursor < source.length && cursor - begin < 8000; cursor++) {
    if (/\s/.test(source[cursor])) return null;
    if (source[cursor] === '(' && ++parens > 8) return null;
    if (source[cursor] === ')' && --parens === 0) return { label, href: source.slice(begin, cursor), end: cursor + 1 };
  }
  return null;
}

/** Only explicit local Markdown links outside code. No folder scan or URL fetch. */
export function discoverableFileLinks(output, { limit = TASK_LIMITS.artifacts } = {}) {
  if (typeof output !== 'string') return { links: [], truncated: false };
  const links = [], seen = new Set(); let fence = null, inline = 0, truncated = false;
  for (const line of output.replaceAll('\r\n', '\n').split('\n')) {
    const marker = /^ {0,3}(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null; continue; }
    if (marker) { fence = marker[1]; inline = 0; continue; }
    if (/^(?: {4}|\t|\s*>)/.test(line)) continue;
    inline = 0;
    for (let index = 0; index < line.length; index++) {
      if (line[index] === '\\') { index++; continue; }
      if (line[index] === '`') { const run = /^`+/.exec(line.slice(index))[0].length; if (!inline) inline = run; else if (inline === run) inline = 0; index += run - 1; continue; }
      if (inline || line[index] !== '[') continue;
      const token = linkAt(line, index); if (!token) continue; index = token.end - 1;
      let href; try { href = decodeURIComponent(token.href); } catch { continue; }
      if (!href || /[\x00-\x1f\x7f]/.test(href) || href.startsWith('#') || /^\/\//.test(href) || /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) continue;
      href = href.replace(/^\/([a-z]:[\\/])/i, '$1');
      if (seen.has(href)) continue; seen.add(href);
      if (links.length >= limit) { truncated = true; continue; }
      const title = token.label.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
      links.push({ href, ...(title ? { title } : {}) });
    }
  }
  return { links, truncated };
}

/** Optional output convenience: a failed/missing link never changes task success. */
export async function discoverFinalArtifacts({ store, taskId, runId, nodeId, cwd, output, signal } = {}) {
  check(signal);
  const parsed = discoverableFileLinks(output);
  if (!parsed.links.length) return { state: null, receipt: null };
  const receipt = { version: 1, at: new Date().toISOString(), source: 'final-response-links', candidateCount: parsed.links.length, registered: [], refreshed: [], existing: [], skipped: [], truncated: parsed.truncated };
  let state = await store.get(taskId, { signal }), base;
  try { base = await fs.realpath(cwd); } catch (error) { receipt.skipped = parsed.links.map(link => ({ href: link.href, code: error.code || 'WORKSPACE_UNAVAILABLE', message: 'The working folder is unavailable.' })); return { state, receipt }; }
  const seen = new Set();
  for (const link of parsed.links) {
    check(signal);
    try {
      const selected = path.resolve(cwd, link.href);
      if (!contained(path.resolve(cwd), selected)) throw fail('This linked file is outside the working folder. Use relay_task to register it explicitly.', 'ARTIFACT_OUTSIDE_WORKSPACE');
      const canonical = await fs.realpath(selected);
      if (!contained(base, canonical)) throw fail('This linked file resolves outside the working folder. Use relay_task to register it explicitly.', 'ARTIFACT_OUTSIDE_WORKSPACE');
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (seen.has(key)) continue; seen.add(key);
      if (!(await fs.stat(canonical)).isFile()) throw fail('The link points to a folder rather than a file.', 'ARTIFACT_NOT_FILE');
      let saved = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        check(signal); state = await store.get(taskId, { signal });
        const existing = state.artifacts.find(artifact => (process.platform === 'win32' ? artifact.path.toLowerCase() : artifact.path) === key);
        if (existing) {
          try { await store.verifyArtifact(taskId, existing.id, { signal }); receipt.existing.push({ artifactId: existing.id, path: existing.path }); saved = true; break; }
          catch (error) { if (error.code !== 'ARTIFACT_CHANGED') throw error; }
        }
        try {
          const title = existing?.title || link.title;
          state = await store.addArtifact(taskId, { path: canonical, ...(title ? { title } : {}) }, { expectedRevision: state.revision, runId, nodeId, signal, source: 'runtime', withinWorkspace: true });
          const artifact = state.artifacts.find(item => (process.platform === 'win32' ? item.path.toLowerCase() : item.path) === key);
          if (existing) receipt.refreshed.push({ artifactId: artifact.id, path: artifact.path, previousSha256: existing.sha256, sha256: artifact.sha256 });
          else receipt.registered.push({ artifactId: artifact.id, path: artifact.path }); saved = true; break;
        } catch (error) { if (error.code !== 'TASK_STATE_CONFLICT' || attempt === 3) throw error; }
      }
      if (!saved) throw fail('The task kept changing while its linked file was being saved.', 'TASK_STATE_CONFLICT');
    } catch (error) {
      check(signal);
      receipt.skipped.push({ href: link.href, code: error.code || 'ARTIFACT_DISCOVERY_ERROR', message: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'The linked file does not exist.' : String(error.message || 'The linked file could not be registered.').slice(0, 500) });
    }
  }
  state = await store.get(taskId, { signal });
  return { state, receipt };
}
