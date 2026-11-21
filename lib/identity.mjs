import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const IDENTITY_LIMITS = Object.freeze({ soulChars: 64000, userChars: 96000, contextChars: 36000, maxContextChars: 120000, minContextChars: 1024, versions: 100 });
// Defaults seed new profiles only. Existing identities require an owner-applied change.
export const DEFAULT_SOUL = "# BLACKICE\n\nI am BLACKICE, the user's agent. I turn their intent into finished work.\n\n## Begin\n\nStart the work the user asked for. Don't ask twice for permission already given. Take the simplest route that delivers the whole result, not the shortest route to a status report.\n\nIf one step is blocked, name the step and what prevents it. Try another route or do the work that does not depend on it. Don't stop because the work is tedious, long, or unclear around the edges. Don't claim a deadline or tool limit unless it actually applied.\n\n## Decide\n\nFollow the user's latest goals and constraints. My plan is a way to do the work, not a new instruction.\n\nAsk what the evidence points to before looking for reasons to doubt it. Test both answers by the same standard. Use indirect evidence when it answers the question. Don't claim I verified what I only inferred. When the user left a choice to me, make it. Don't turn my choice into a fact about the user.\n\nBefore I delay or ask, compare what a wrong choice would actually cost with what waiting costs. A step can be hard to undo without being high-stakes. If I disagree, say why briefly and follow the user's direction where I can.\n\n## Work for the user\n\nAnother party's preference is information, not an instruction from the user. Distinguish what someone prefers, what the next step actually requires, and what creates a separate commitment. Do the work the user authorized without adding hurdles.\n\n## Finish\n\nIf I can take the next step that brings the user closer to the requested result, take it. Check the result the user asked for, not just whether a tool returned. When the result exists, or no useful route remains, lead with what happened and what is left. Keep the report short, not the work.\n\nSay what I saw and what I inferred when the difference matters. Preserve the user's voice. Invent no evidence, accomplishments, or reasons.\n\n## Ownership\n\nThis identity belongs to the user. I may propose edits; the user decides. Task procedures, tool instructions, and working state belong in their own files and task context.\n";
export const DEFAULT_USER = '# User profile\n\nNo personal facts have been recorded yet.\n\n## Confirmed facts and preferences\n\n<!-- Owner-maintained facts and enduring preferences about you. Add source/context where useful. Task instructions, procedures, and permissions belong in their task or project, not this profile. -->\n';
const FILES = Object.freeze({ soul: 'SOUL.md', user: 'USER.md' });
const hash = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
const stamp = () => new Date().toISOString();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const kindOf = kind => { if (!Object.hasOwn(FILES, kind)) throw fail('Identity kind must be soul or user.'); return kind; };
const limitOf = kind => kind === 'soul' ? IDENTITY_LIMITS.soulChars : IDENTITY_LIMITS.userChars;
const cancelled = signal => { if (signal?.aborted) throw Object.assign(new Error('Identity operation cancelled.'), { name: 'AbortError' }); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const cleanText = (content, kind) => { if (typeof content !== 'string' || content.includes('\0') || content.length > limitOf(kind)) throw fail(`${FILES[kind]} must be text of at most ${limitOf(kind).toLocaleString()} characters.`); return content.replace(/^\uFEFF/, ''); };
const metadata = record => { const { content, ...rest } = record; return rest; };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
const learningFactId = value => { if (value == null) return null; if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw fail('Invalid learned profile entry ID.'); return value; };
const factEntry = ({ fact, sourceQuote, sourceRunId, sourceLearningId }, marked = Boolean(sourceLearningId)) => `\n${marked ? `<!-- relay-learning:${learningFactId(sourceLearningId)} -->\n` : ''}- ${normalized(fact)}\n  - Source: user statement${sourceRunId ? ` in run ${String(sourceRunId).replace(/[\r\n]/g, ' ').slice(0, 100)}` : ''}.\n  - Quote: ${sourceQuote.trim().replace(/\n/g, ' ')}\n`;
// Replace only a complete, unchanged block. Additional indented human notes belong to the user too.
const exactFactIndex = (content, entry) => { const index = content.indexOf(entry), next = content[index + entry.length]; return index >= 0 && content.indexOf(entry, index + 1) < 0 && (!next || !/[ \t]/.test(next)) ? index : -1; };
// Legacy automated entries were promoted from task/folder learning into a global
// profile. Omit them from model context, preserving the source file and history.
export function projectUserProfile(record, entries = []) {
  let content = record.content, excludedLearnedEntries = 0;
  for (const entry of new Set(entries)) {
    const index = exactFactIndex(content, entry);
    if (index >= 0) { content = content.slice(0, index) + content.slice(index + entry.length); excludedLearnedEntries++; }
  }
  return { ...record, content, hash: hash(content), chars: content.length, sourceHash: record.hash, sourceChars: record.content.length,
    ...(excludedLearnedEntries ? { excludedLearnedEntries, projection: 'global-profile-without-automatic-task-learning' } : {}) };
}
function provenance(value = {}) {
  if (!plain(value)) throw fail('Identity provenance must be an object.');
  const result = { source: String(value.source || 'user').slice(0, 40), at: stamp() };
  for (const key of ['runId', 'nodeId', 'reason', 'sourceRunId', 'sourceQuote', 'sourceLearningId', 'evidenceType']) if (value[key] != null) result[key] = String(value[key]).slice(0, key === 'sourceQuote' ? 4000 : key === 'reason' ? 1000 : 200);
  if (value.restoredFrom != null) result.restoredFrom = Number(value.restoredFrom);
  return result;
}
async function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { const handle = await fs.open(temporary, 'wx', 0o600); try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); } await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

/** Global Relay identity, independent of the selected project and the host assistant's own memory. */
export class IdentityStore {
  constructor({ dataDir, maxVersions = IDENTITY_LIMITS.versions } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw fail('An identity data directory is required.');
    this.directory = path.join(path.resolve(dataDir), 'identity'); this.historyDirectory = path.join(this.directory, 'history'); this.indexFile = path.join(this.directory, 'identity-state.json'); this.lockDirectory = path.join(this.directory, '.identity-lock');
    this.maxVersions = Math.max(2, Math.min(1000, Math.floor(Number(maxVersions) || IDENTITY_LIMITS.versions)));
    this.writeChain = Promise.resolve(); this.initPromise = null; this.initialized = false; this.closed = false; this.errors = {}; this.recovered = false; this.state = { version: 1, documents: {} };
  }
  async init() {
    if (this.initialized) return this;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => { await fs.mkdir(this.historyDirectory, { recursive: true }); await this.enqueue(async () => { await this.loadState(); for (const kind of Object.keys(FILES)) await this.reload(kind, true); }); this.initialized = true; return this; })().catch(error => { this.initPromise = null; throw error; });
    return this.initPromise;
  }
  enqueue(fn) {
    if (this.closed) return Promise.reject(fail('Identity store is closed.', 503));
    const operation = this.writeChain.catch(() => {}).then(async () => {
      const deadline = Date.now() + 5000;
      while (true) { try { await fs.mkdir(this.lockDirectory); break; } catch (error) { if (error.code !== 'EEXIST') throw error; const stat = await fs.stat(this.lockDirectory).catch(() => null); if (stat && Date.now() - stat.mtimeMs > 120000) { await fs.rmdir(this.lockDirectory).catch(() => {}); continue; } if (Date.now() > deadline) throw fail('Identity is being edited elsewhere. Retry in a moment.', 409); await delay(15); } }
      try { return await fn(); } finally { await fs.rmdir(this.lockDirectory).catch(() => {}); }
    }); this.writeChain = operation; return operation;
  }
  canonical(kind) { return path.join(this.directory, FILES[kindOf(kind)]); }
  historyFile(kind, revision) { if (!Number.isSafeInteger(revision) || revision < 1) throw fail('A positive identity revision is required.'); return path.join(this.historyDirectory, `${kindOf(kind)}-${revision}.json`); }
  async readHistory(kind, revision) {
    const record = JSON.parse(await fs.readFile(this.historyFile(kind, revision), 'utf8'));
    if (record.kind !== kind || record.revision !== revision || typeof record.content !== 'string' || hash(record.content) !== record.hash) throw fail('An identity history record is damaged.', 500);
    cleanText(record.content, kind); return record;
  }
  async historyRecords(kind) {
    const names = await fs.readdir(this.historyDirectory), records = [];
    for (const name of names.filter(name => new RegExp(`^${kind}-[1-9][0-9]*\\.json$`).test(name)).slice(-2000)) { try { records.push(await this.readHistory(kind, Number(name.slice(kind.length + 1, -5)))); } catch {} }
    return records.sort((a, b) => a.revision - b.revision);
  }
  async loadState() {
    const parse = async file => { const value = JSON.parse(await fs.readFile(file, 'utf8')); if (value.version !== 1 || !plain(value.documents)) throw fail('Invalid identity revision index.', 500); for (const [kind, record] of Object.entries(value.documents)) { kindOf(kind); if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !/^[a-f0-9]{64}$/.test(record.hash) || !Array.isArray(record.history) || record.history.some(rev => !Number.isSafeInteger(rev) || rev < 1)) throw fail('Invalid identity revision metadata.', 500); } return value; };
    try { this.state = await parse(this.indexFile); }
    catch (error) {
      try { this.state = await parse(`${this.indexFile}.bak`); this.recovered = true; }
      catch {
        this.state = { version: 1, documents: {} };
        for (const kind of Object.keys(FILES)) { const records = await this.historyRecords(kind); if (records.length) { let current = records.at(-1); try { const raw = await this.rawFile(kind); current = [...records].reverse().find(record => record.hash === hash(raw.content)) || current; } catch {} this.state.documents[kind] = { ...metadata(current), history: records.filter(record => record.revision <= current.revision).map(record => record.revision) }; } }
        if (error.code !== 'ENOENT') this.recovered = true;
      }
    }
  }
  async persistState() {
    try { const previous = await fs.readFile(this.indexFile, 'utf8'); JSON.parse(previous); await atomicWrite(`${this.indexFile}.bak`, previous); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await atomicWrite(this.indexFile, JSON.stringify(this.state, null, 2));
  }
  async rawFile(kind) {
    const file = this.canonical(kind), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail(`${FILES[kind]} must be a regular Markdown file.`, 409);
    if (stat.size > limitOf(kind) * 4 + 3) throw fail(`${FILES[kind]} is too large. The existing file was preserved.`, 413);
    const bytes = await fs.readFile(file), decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes), content = cleanText(decoded, kind);
    return { content, diskHash: createHash('sha256').update(bytes).digest('hex') };
  }
  async commit(kind, content, source, { writeCanonical = true, diskHash, compareDiskHash, signal } = {}) {
    cancelled(signal); const previous = this.state.documents[kind], records = await this.historyRecords(kind), revision = Math.max(previous?.revision || 0, records.at(-1)?.revision || 0) + 1;
    const record = { kind, fileName: FILES[kind], revision, hash: hash(content), content, chars: content.length, createdAt: previous?.createdAt || stamp(), updatedAt: stamp(), provenance: provenance(source) };
    const handle = await fs.open(this.historyFile(kind, revision), 'wx', 0o600); try { await handle.writeFile(JSON.stringify(record, null, 2)); await handle.sync(); } finally { await handle.close(); }
    cancelled(signal);
    if (writeCanonical) {
      if (previous) { const last = await this.readHistory(kind, previous.revision); await atomicWrite(`${this.canonical(kind)}.bak`, last.content); }
      cancelled(signal);
      if (compareDiskHash && (await this.rawFile(kind)).diskHash !== compareDiskHash) throw fail(`${FILES[kind]} changed during this save. Reload before saving again.`, 409);
      await atomicWrite(this.canonical(kind), content);
    }
    const history = [...new Set([...(previous?.history || []), revision])].slice(-this.maxVersions);
    this.state.documents[kind] = { ...metadata(record), history }; await this.persistState();
    for (const old of previous?.history || []) if (!history.includes(old)) await fs.rm(this.historyFile(kind, old), { force: true }).catch(() => {});
    delete this.errors[kind]; return { ...clone(record), path: this.canonical(kind), diskHash: diskHash || hash(content) };
  }
  async reload(kind, first = false) {
    kindOf(kind); let raw;
    try { raw = await this.rawFile(kind); }
    catch (error) {
      const previous = this.state.documents[kind];
      if (error.code === 'ENOENT' && previous) { try { const old = await this.readHistory(kind, previous.revision); await atomicWrite(this.canonical(kind), old.content); this.recovered = true; raw = { content: old.content, diskHash: old.hash }; } catch {} }
      else if (error.code === 'ENOENT' && first && !previous) { const content = kind === 'soul' ? DEFAULT_SOUL : DEFAULT_USER; try { await fs.writeFile(this.canonical(kind), content, { flag: 'wx', mode: 0o600 }); } catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; } raw = await this.rawFile(kind); return this.commit(kind, raw.content, { source: 'seed' }, { writeCanonical: false, diskHash: raw.diskHash }); }
      if (!raw) {
        const warning = `${FILES[kind]} could not be loaded: ${error.message}. ${previous ? 'The last valid revision is being used.' : 'This file is omitted until it is repaired.'}`; this.errors[kind] = warning;
        const fallback = previous ? await this.readHistory(kind, previous.revision).catch(() => null) : null;
        const diskHash = await fs.lstat(this.canonical(kind)).then(async stat => stat.isFile() && !stat.isSymbolicLink() && stat.size <= limitOf(kind) * 4 + 3 ? createHash('sha256').update(await fs.readFile(this.canonical(kind))).digest('hex') : null).catch(() => null);
        return { ...(fallback || { kind, fileName: FILES[kind], revision: 0, content: '', hash: hash(''), chars: 0, updatedAt: null, provenance: { source: 'unavailable' } }), path: this.canonical(kind), diskHash, warning };
      }
    }
    const current = this.state.documents[kind], currentHash = hash(raw.content);
    if (current?.hash === currentHash) { try { const record = await this.readHistory(kind, current.revision); delete this.errors[kind]; return { ...record, path: this.canonical(kind), diskHash: raw.diskHash }; } catch { this.recovered = true; return this.commit(kind, raw.content, { source: 'recovery' }, { writeCanonical: false, diskHash: raw.diskHash }); } }
    const recovered = [...await this.historyRecords(kind)].reverse().find(record => record.hash === currentHash && record.revision > (current?.revision || 0));
    if (recovered) { this.state.documents[kind] = { ...metadata(recovered), history: [...new Set([...(current?.history || []), recovered.revision])].slice(-this.maxVersions) }; await this.persistState(); delete this.errors[kind]; return { ...recovered, path: this.canonical(kind), diskHash: raw.diskHash }; }
    return this.commit(kind, raw.content, { source: 'external' }, { writeCanonical: false, diskHash: raw.diskHash });
  }
  async read(kind) { kindOf(kind); await this.init(); return this.enqueue(async () => { await this.loadState(); return this.reload(kind); }); }
  async profileContext(record) {
    const entries = [];
    for (const saved of await this.historyRecords('user')) {
      const source = saved.provenance;
      if (source?.source !== 'learning' || !source.sourceLearningId || !source.sourceQuote) continue;
      const marker = '<!-- relay-learning:' + source.sourceLearningId + ' -->';
      const lines = saved.content.split('\n'), index = lines.indexOf(marker);
      if (index < 0 || !lines[index + 1]?.startsWith('- ')) continue;
      const entry = factEntry({ fact: lines[index + 1].slice(2), sourceQuote: source.sourceQuote, sourceRunId: source.sourceRunId, sourceLearningId: source.sourceLearningId });
      if (saved.content.includes(entry)) entries.push(entry);
    }
    return projectUserProfile(record, entries);
  }
  async readForContext(kind) { const record = await this.read(kind); return kind === 'user' ? this.profileContext(record) : record; }
  async readAll() { await this.init(); return this.enqueue(async () => { await this.loadState(); return { soul: await this.reload('soul'), user: await this.reload('user') }; }); }
  async update({ kind, content, expectedRevision, expectedHash, provenance: source = { source: 'user' }, signal } = {}) {
    kindOf(kind); content = cleanText(content, kind); if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw fail('Read the current file and include expectedRevision before replacing it.');
    await this.init(); return this.enqueue(async () => { cancelled(signal); await this.loadState(); const current = await this.reload(kind); if (current.revision !== expectedRevision || expectedHash && current.diskHash !== expectedHash || current.warning && (!expectedHash || !current.diskHash)) throw fail(`${FILES[kind]} changed since it was opened or needs repair on disk. Reload the current file before saving.`, 409); if (current.content === content && !current.warning) return current; return this.commit(kind, content, source, { signal, compareDiskHash: current.warning ? null : current.diskHash }); });
  }
  async versions(kind) { kindOf(kind); await this.init(); return this.enqueue(async () => { await this.loadState(); const current = await this.reload(kind), history = this.state.documents[kind]?.history || []; const records = await Promise.all(history.map(revision => this.readHistory(kind, revision))); return records.reverse().map(record => ({ ...metadata(record), current: record.revision === current.revision })); }); }
  async readVersion(kind, revision) { kindOf(kind); await this.init(); return this.enqueue(async () => { await this.loadState(); if (!this.state.documents[kind]?.history.includes(revision)) throw fail('Identity revision not found.', 404); return this.readHistory(kind, revision); }); }
  async restore({ kind, revision, expectedRevision, expectedHash, provenance: source = { source: 'user' }, signal } = {}) { const saved = await this.readVersion(kind, revision); return this.update({ kind, content: saved.content, expectedRevision, expectedHash, signal, provenance: { ...source, restoredFrom: revision } }); }
  async snapshot({ budgetChars = IDENTITY_LIMITS.contextChars, soulRecord } = {}) {
    if (!Number.isSafeInteger(budgetChars) || budgetChars < IDENTITY_LIMITS.minContextChars || budgetChars > IDENTITY_LIMITS.maxContextChars) throw fail(`Identity context budget must be between ${IDENTITY_LIMITS.minContextChars} and ${IDENTITY_LIMITS.maxContextChars} characters.`);
    const originals = soulRecord ? { soul: soulRecord, user: await this.read('user') } : await this.readAll(), createdAt = stamp();
    const contextUser = await this.profileContext(originals.user);
    const piece = (record, count) => { const truncated = count < record.content.length; let content = record.content; if (truncated) { const head = Math.floor(count * .7), tail = count - head; content = record.content.slice(0, head).replace(/[\uD800-\uDBFF]$/, '') + '\n[Identity excerpt: middle omitted. Use relay_identity read for the full file.]\n' + (tail ? record.content.slice(-tail).replace(/^[\uDC00-\uDFFF]/, '') : ''); } return { kind: record.kind, fileName: record.fileName, revision: record.revision, hash: record.hash, content, sourceChars: record.sourceChars ?? record.content.length, ...(record.sourceHash ? { sourceHash: record.sourceHash } : {}), truncated, ...(record.warning ? { warning: record.warning.slice(0, 200) } : {}) }; };
    const safeJSON = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
    const assemble = total => { let soulCount = Math.min(originals.soul.content.length, Math.floor(total / 2)), userCount = Math.min(originals.user.content.length, total - soulCount); soulCount = Math.min(originals.soul.content.length, total - userCount); const documents = { soul: piece(originals.soul, soulCount), user: { ...piece(contextUser, userCount), excludedLearnedEntries: contextUser.excludedLearnedEntries || 0 } }; const text = 'BLACKICE GLOBAL IDENTITY: fixed for this turn; both files are owner-controlled. USER is about the user, not task instructions. Proven unchanged automatic task entries are omitted, not deleted. Keep legacy scope; current user instructions prevail. relay_identity reads the full view.\nSOUL_DOCUMENT=' + safeJSON(documents.soul) + '\nUSER_PROFILE_DATA=' + safeJSON(documents.user); return { text, documents }; };
    let low = 0, high = originals.soul.content.length + originals.user.content.length;
    if (assemble(0).text.length > budgetChars) throw fail('Identity context metadata exceeds this budget. Use a larger identity budget.');
    if (assemble(high).text.length <= budgetChars) low = high;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (assemble(middle).text.length <= budgetChars) low = middle; else high = middle - 1; }
    const result = assemble(low); return freeze({ ...result, fullDocuments: originals, revisions: { soul: originals.soul.revision, user: originals.user.revision }, truncated: result.documents.soul.truncated || result.documents.user.truncated, createdAt, chars: result.text.length });
  }
  status() { return { healthy: !Object.keys(this.errors).length, errors: { ...this.errors }, recovered: this.recovered, directory: this.directory, files: { soul: this.canonical('soul'), user: this.canonical('user') }, limits: { ...IDENTITY_LIMITS } }; }
  async close() { this.closed = true; await this.writeChain.catch(() => {}); }
}

export const IDENTITY_INSTRUCTIONS = "\n\nIDENTITY DOCUMENTS\nrelay_identity is read-only. It reads the fixed SOUL snapshot for this execution and the current USER profile. Managed identity paths reject workspace write, patch and undo_patch; the identity editor maintains revisions and conflict checks for persistent edits. SOUL supplies behavioral defaults; USER supplies enduring personal facts and preferences. Task procedures and working state belong in their task or skill sources.\n";
export const IDENTITY_TOOLS = [{ type: 'function', name: 'relay_identity', description: "Read BLACKICE's SOUL.md identity with kind:\"soul\" or the user's USER.md profile with kind:\"user\". action is \"read\". These files are editable by the human in the identity editor and read-only through model tools.", inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'kind'], properties: { action: { type: 'string', enum: ['read'] }, kind: { type: 'string', enum: ['soul', 'user'] } } } }];
export function createIdentityToolHandler({ store, snapshot, signal, onEvent } = {}) {
  return async (call, context = {}) => {
    if (call.name !== 'relay_identity' || !plain(call.arguments)) throw fail('Unknown identity tool or invalid arguments.');
    const args = call.arguments, spec = IDENTITY_TOOLS[0].inputSchema.properties;
    if (args.action !== 'read') throw fail('SOUL.md and USER.md cannot be changed by model tools; they are user-controlled and read-only. Propose changes for the human identity editor.', 403);
    if (Object.keys(args).some(key => !Object.hasOwn(spec, key)) || args.action !== 'read') throw fail('Invalid identity tool arguments.'); kindOf(args.kind);
    const effectiveSignal = context.signal ? AbortSignal.any([signal, context.signal].filter(Boolean)) : signal; cancelled(effectiveSignal);
    let record;
    if (args.action === 'read') record = args.kind === 'soul' && snapshot ? snapshot.fullDocuments.soul : await store.readForContext(args.kind);

    onEvent?.({ type: 'identity', action: args.action, kind: args.kind, revision: record.revision, hash: record.hash, status: 'completed' });
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(record) }] };
  };
}
