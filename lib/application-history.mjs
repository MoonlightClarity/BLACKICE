import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 409, actionDispatched: false, ...details });
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const compact = value => normalize(value).replaceAll(' ', '');
const MAX_SOURCE = 16 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024, MAX_JOURNAL = 8 * 1024 * 1024;
const sourceName = name => /(?:job.?search|job_search|application)/i.test(name) && /\.(?:jsonl?|csv|md|txt)$/i.test(name);
const outcomes = /\b(?:applied|submitted|application received|application has been received|already applied|already submitted|duplicate|uncertain|submission pending)\b/i;
const hasOutcome = value => outcomes.test(String(value).replaceAll('_', ' '));
const noOutcome = /\b(?:not[ _-]+(?:yet[ _-]+)?(?:applied|submitted)|no[ _-]+(?:application|submission)(?:[ _-]+(?:was[ _-]+)?(?:sent|submitted))?|unsubmitted|draft)\b/i;

/** Recognized public ATS requisition identities only. Never merge an employer's distinct IDs. */
export function applicationTarget(value) {
  let url; try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase(), parts = url.pathname.split('/').filter(Boolean);
  let provider, employer, requisition;
  if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(host) && parts[0] === 'embed' && parts[1] === 'job_app' && /^[a-zA-Z0-9_-]+$/.test(url.searchParams.get('for') || '') && /^\d+$/.test(url.searchParams.get('token') || '')) {
    employer = url.searchParams.get('for'); requisition = url.searchParams.get('token'); provider = 'greenhouse';
  } else if (host === 'jobs.ashbyhq.com' && parts.length >= 2 && /^[a-f\d-]{36}$/i.test(parts[1])) {
    [employer, requisition] = parts; provider = 'ashby';
  } else if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(host) && parts.length >= 2 && /^[a-f\d-]{36}$/i.test(parts[1])) {
    [employer, requisition] = parts; provider = host === 'jobs.lever.co' ? 'lever' : 'lever-eu';
  } else if (['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'].includes(host)
      && parts[1] === 'jobs' && /^\d+$/.test(parts[2] || '')) {
    employer = parts[0]; requisition = parts[2]; provider = host.includes('.eu.') ? 'greenhouse-eu' : 'greenhouse';
  } else if (/(?:^|\.)icims\.com$/.test(host) && parts[0] === 'jobs' && /^\d+$/.test(parts[1] || '')) {
    employer = host.split('.')[0].replace(/^careers-/, ''); requisition = parts[1]; provider = 'icims:' + host;
  } else if (host === 'apply.workable.com' && parts[1] === 'j' && /^[a-z\d]+$/i.test(parts[2] || '')) {
    employer = parts[0]; requisition = parts[2]; provider = 'workable';
  }
  if (!provider || !employer || !requisition) return null;
  return { key: [provider, employer.toLowerCase(), requisition.toLowerCase()].join(':'), employer, url: url.origin + url.pathname.replace(/\/$/, '') };
}

export function applicationSubmissionKind(label) {
  const value = normalize(label);
  if (/^(?:(?:submit|send|complete)(?: my| your| this)? application|apply(?: now)?)$/.test(value)) return 'final';
  if (/^(?:next|continue|back|previous|save(?: draft| and continue| and exit)?|sign in|log in|login|register|create account|review(?: application)?)$/.test(value)) return 'intermediate';
  return 'unknown';
}

export function applicationDescriptorTarget(descriptor) {
  if (!['commit', 'opaque'].includes(descriptor?.effect) || descriptor.effect === 'commit' && descriptor.applicationPage?.submission === 'intermediate') return null;
  const page = descriptor.applicationPage;
  const candidates = [page?.url, descriptor.commit?.destinationKey?.replace(/^destination:/, '')].map(applicationTarget).filter(Boolean);
  if (!candidates.length) return null;
  if (new Set(candidates.map(row => row.key)).size !== 1)
    throw fail('APPLICATION_HISTORY_TARGET_AMBIGUOUS', 'The observed page and form identify different requisitions. Inspect the actual target; no submission was dispatched.');
  return { ...candidates[0], title: typeof page?.title === 'string' ? page.title : '' };
}

function csvRows(raw) {
  const rows = [], row = []; let cell = '', quoted = false;
  for (let index = 0; index < raw.length; index++) {
    const c = raw[index];
    if (c === '"') {
      if (quoted && raw[index + 1] === '"') { cell += '"'; index++; }
      else if (quoted || !cell) quoted = !quoted;
      else throw new Error('Invalid CSV quoting');
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      if (c === '\r' && raw[index + 1] === '\n') index++;
      row.push(cell); cell = '';
      if (c !== ',') { if (row.some(Boolean)) rows.push(row.splice(0)); else row.length = 0; }
    } else cell += c;
  }
  if (quoted) throw new Error('Incomplete CSV record');
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  const header = rows.shift() || [];
  if (new Set(header.map(value => value.toLowerCase())).size !== header.length) throw new Error('Duplicate CSV header');
  return rows.map(values => {
    if (values.length !== header.length) throw new Error('Incomplete CSV row');
    return Object.fromEntries(header.map((name, index) => [name, values[index]]));
  });
}

function records(raw, extension) {
  if (extension === '.csv') return csvRows(raw);
  if (extension === '.jsonl') return raw.replace(/(?<=})\\r\\n(?=\s*\{)|^\\r\\n(?=\s*\{)/gm, '\n').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (extension === '.json') return [JSON.parse(raw)];
  return null;
}

const historicalKey = value => typeof value === 'string' && /^(?:ashby|lever(?:-eu)?|greenhouse(?:-eu)?|icims:[^:]+|workable):[^:]+:[^:]+$/.test(value) ? value.toLowerCase() : null;

function collect(value, result, depth = 0, inherited = {}) {
  if (depth > 30 || result.length > 100000) throw new Error('History structure exceeds supported bounds');
  if (Array.isArray(value)) { for (const row of value) collect(row, result, depth + 1, inherited); return; }
  if (!value || typeof value !== 'object') return;
  const scalar = Object.fromEntries(Object.entries(value).filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item)));
  if (Object.keys(scalar).length) result.push({ ...inherited, ...scalar });
  const identities = Object.fromEntries(Object.entries(scalar).filter(([name, item]) => /^(?:key|url|joburl|job_url)$/i.test(name) && (historicalKey(item) || applicationTarget(item))));
  for (const item of Object.values(value)) if (item && typeof item === 'object') collect(item, result, depth + 1, { ...inherited, ...identities });
}

function urlsIn(text) {
  return [...String(text).matchAll(/https?:\/\/[^\s<>"'\]\[)]+/g)].map(match => applicationTarget(match[0].replace(/[.,;]+$/, ''))).filter(Boolean);
}

function targetRole(target) {
  const employer = compact(target.employer);
  const parts = target.title.split(/\s+(?:[|–—-]|at|@)\s+/).map(value => normalize(value))
    .filter(value => value && compact(value) !== employer && !/^(?:jobs?|careers?|application|apply|apply now|job application)$/.test(value));
  return parts.find(value => value.split(' ').length >= 2 && value.length >= 8) || '';
}

function narrativeMatch(text, target) {
  // Imported prose is a review signal, never host-confirmed external evidence.
  const role = targetRole(target);
  if (!role) return false;
  return text.split(/(?:[.!?](?:\s|$)|\r?\n)/).some(sentence => {
    const normalized = normalize(sentence);
    return compact(sentence).includes(compact(target.employer)) && normalized.includes(role) && hasOutcome(sentence) && !noOutcome.test(sentence);
  });
}

function inspectRecord(record, target) {
  const fields = Object.entries(record).map(([name, value]) => [name.toLowerCase(), value]);
  if (new Set(fields.map(([name]) => name)).size !== fields.length) throw new Error('Ambiguous history field names');
  record = Object.fromEntries(fields);
  const status = [record.status, record.result, record.disposition].filter(Boolean).join(' ');
  const proof = [record.evidence, record.confirmation, record.receipt].filter(value => typeof value === 'string').join(' ');
  const directUrls = Object.entries(record).filter(([name, value]) => /url|link|receipt/i.test(name) && typeof value === 'string').flatMap(([, value]) => urlsIn(value));
  const explicitKeys = [record.key, record.requisitionkey].map(historicalKey).filter(Boolean);
  const prior = (!noOutcome.test(status) && hasOutcome(status)) || (!noOutcome.test(proof) && hasOutcome(proof));
  if (prior && (directUrls.some(row => row.key === target.key) || explicitKeys.includes(target.key))) return 'reported-prior-requisition';
  // A different explicit requisition must not become a fuzzy employer/title duplicate.
  if (directUrls.length || explicitKeys.length) return null;
  const employer = record.employer || record.company || record.organization;
  const role = record.role || record.title || record.position;
  if (prior && employer && role && compact(employer) === compact(target.employer) && normalize(role) === targetRole(target)) return 'reported-company-role';
  return Object.values(record).some(value => typeof value === 'string' && narrativeMatch(value, target)) ? 'narrative-company-role' : null;
}

async function boundedRead(file, limit) {
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > limit) throw new Error('Unsafe or oversized history source');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) throw new Error('History source changed');
    const bytes = Buffer.alloc(entry.size + 1); let total = 0;
    while (total < bytes.length) { const chunk = await handle.read(bytes, total, bytes.length - total, total); if (!chunk.bytesRead) break; total += chunk.bytesRead; }
    const after = await handle.stat();
    if (total !== entry.size || after.size !== entry.size || after.mtimeMs !== opened.mtimeMs) throw new Error('History source changed');
    const content = bytes.subarray(0, total);
    const encoding = content[0] === 0xff && content[1] === 0xfe ? 'utf-16le' : content[0] === 0xfe && content[1] === 0xff ? 'utf-16be' : 'utf-8';
    return new TextDecoder(encoding, { fatal: true }).decode(content);
  } finally { await handle.close(); }
}

/** Reads every supported top-level ledger date. No write, email inference, or external verification. */
export async function inspectApplicationHistory(cwd, target) {
  const sources = [], errors = [], matches = [];
  let entries; try { entries = await fs.readdir(cwd, { withFileTypes: true }); } catch { return { sources, errors: ['workspace-unreadable'], matches }; }
  const files = entries.filter(entry => sourceName(entry.name));
  if (files.length > 512) return { sources, errors: ['source-count-limit'], matches };
  let total = 0;
  for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const raw = await boundedRead(path.join(cwd, entry.name), MAX_SOURCE); total += Buffer.byteLength(raw);
      if (total > MAX_TOTAL) throw new Error('History total limit');
      const parsed = records(raw, path.extname(entry.name).toLowerCase()), flattened = [];
      if (parsed) collect(parsed, flattened);
      if (parsed) for (let index = 0; index < flattened.length; index++) {
        const reason = inspectRecord(flattened[index], target);
        if (reason) matches.push({ source: entry.name, record: index + 1, reason });
      }
      else for (const [index, line] of raw.split(/\r?\n/).entries()) {
        if (!hasOutcome(line) || noOutcome.test(line)) continue;
        const identities = urlsIn(line);
        if (identities.some(row => row.key === target.key)) matches.push({ source: entry.name, line: index + 1, reason: 'reported-prior-requisition' });
        else if (!identities.length && narrativeMatch(line, target)) matches.push({ source: entry.name, line: index + 1, reason: 'narrative-company-role' });
      }
      sources.push(entry.name);
    } catch { errors.push(entry.name); }
  }
  // Honor previously claimed or uncertain helper attempts, including other runs.
  try {
    const raw = await boundedRead(path.join(cwd, '.application-registry', 'claims.json'), MAX_SOURCE), claims = JSON.parse(raw);
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('Invalid claims');
    for (const [key, claim] of Object.entries(claims)) {
      if (!claim || typeof claim !== 'object' || typeof claim.status !== 'string') throw new Error('Invalid claim');
      if (key === target.key || applicationTarget(claim.url)?.key === target.key)
        matches.push({ source: '.application-registry/claims.json', reason: 'existing-claim-or-outcome' });
    }
  } catch (error) { if (error.code !== 'ENOENT') errors.push('.application-registry/claims.json'); }
  return { sources, errors, matches: matches.slice(0, 40) };
}

/** Independent native submission guard. Root-scoped lock and durable UNKNOWN before input; no saved plan or task context is required. */
export function createApplicationHistoryGate({ store, cwd, taskId }) {
  let rootPromise;
  const root = () => rootPromise ||= (async () => {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('APPLICATION_HISTORY_UNAVAILABLE', 'The application history workspace is unavailable. No submission was dispatched.');
    return fs.realpath(cwd);
  })();
  async function transaction(callback) {
    const directory = await root(), id = 'application-history-' + hash(process.platform === 'win32' ? directory.toLowerCase() : directory).slice(0, 32);
    return store.enqueue(id, async () => {
      const file = store.file(id) + '.claims';
      let journal = { version: 1, root: directory, records: [] };
      try { journal = JSON.parse(await boundedRead(file, MAX_JOURNAL)); } catch (error) { if (error.code !== 'ENOENT') throw fail('APPLICATION_HISTORY_UNAVAILABLE', 'The retained application claim journal cannot be read. Preserve it and reconcile; no submission was dispatched.'); }
      if (journal.version !== 1 || journal.root !== directory || !Array.isArray(journal.records) || journal.records.length > 10000 ||
          journal.records.some(row => !row || typeof row.operationId !== 'string' || typeof row.taskId !== 'string' || typeof row.key !== 'string' ||
            !['unknown', 'confirmed', 'absent'].includes(row.state) || typeof row.effectKey !== 'string'))
        throw fail('APPLICATION_HISTORY_UNAVAILABLE', 'The retained application claim journal is invalid. Preserve it and reconcile; no submission was dispatched.');
      const save = async () => {
        const data = JSON.stringify(journal);
        if (Buffer.byteLength(data) > MAX_JOURNAL || journal.records.length > 10000) throw fail('APPLICATION_HISTORY_UNAVAILABLE', 'The application claim journal is full. Preserve it; no submission was dispatched.');
        const assertOwner = async () => {
          const owner = JSON.parse(await fs.readFile(store.file(id) + '.lock', 'utf8'));
          if (owner.pid !== process.pid || owner.token !== store.lockOwners.get(id)) throw fail('APPLICATION_HISTORY_UNAVAILABLE', 'The application claim lock changed. No submission was dispatched.');
        };
        const temporary = file + '.' + randomUUID() + '.tmp'; let handle;
        try {
          await assertOwner(); handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null;
          await assertOwner(); await fs.rename(temporary, file);
        } finally { await handle?.close().catch(() => {}); await fs.rm(temporary, { force: true }).catch(() => {}); }
      };
      return callback({ directory, journal, save });
    });
  }
  async function check({ descriptor, operationId, reserve = false }) {
    const target = applicationDescriptorTarget(descriptor);
    if (!target) return null;
    if (descriptor.effect === 'commit' && descriptor.applicationPage?.submission !== 'final') throw fail('APPLICATION_HISTORY_SUBMISSION_UNCLASSIFIED', 'The observed POST control is not a recognized final application or intermediate control. Inspect its purpose before submission; no input was dispatched.');
    if (descriptor.effect === 'opaque') throw fail('APPLICATION_HISTORY_UNINSPECTED', 'This recognized application page needs an inspected form control before input that may submit. No input was dispatched.');
    return transaction(async ({ directory, journal, save }) => {
      const prior = journal.records.find(row => row.key === target.key && row.state !== 'absent');
      if (prior) throw fail('APPLICATION_HISTORY_RESERVED', 'This requisition has a prior confirmed or uncertain native attempt (' + prior.taskId + '). Inspect its retained outcome; do not submit again.', { priorOperationId: prior.operationId });
      const history = await inspectApplicationHistory(directory, target);
      if (history.matches.length) {
        const match = history.matches[0];
        throw fail('APPLICATION_HISTORY_PRIOR', 'Available history reports a prior application or unresolved attempt for this requisition or company and role. Review ' + match.source + (match.line ? ':' + match.line : '') + ' before another submission. Imported history is not new external confirmation.');
      }
      if (history.errors.length) throw fail('APPLICATION_HISTORY_INCOMPLETE', 'Application history could not be checked completely: ' + history.errors.slice(0, 4).join(', ') + '. No submission was dispatched.');
      if (reserve) {
        if (typeof operationId !== 'string' || !operationId || typeof descriptor.commit?.effectKey !== 'string') throw fail('APPLICATION_HISTORY_INVALID', 'A host operation identity is required before submission.');
        journal.records.push({ key: target.key, url: target.url, taskId, operationId, effectKey: descriptor.commit.effectKey, state: 'unknown', at: new Date().toISOString() });
        await save();
      }
      return { covered: true, key: target.key, checkedSources: history.sources.length, coverage: 'Recognized ATS identity and available local history only; not lifetime-history proof.' };
    });
  }
  async function reconcile(operations, { notDispatchedOperationId = null } = {}) {
    if (!operations.some(row => applicationTarget(row.commit?.pageUrl) || applicationTarget(row.commit?.destinationKey?.replace(/^destination:/, '')))) return;
    await transaction(async ({ journal, save }) => {
      let changed = false;
      for (const record of journal.records.filter(row => row.taskId === taskId && row.state === 'unknown')) {
        const operation = operations.find(row => row.operationId === record.operationId && row.commit?.effectKey === record.effectKey);
        // Call only with canonical host journal rows after evidence validation.
        if (operation && (operation.deliveryState === 'cancelled-before-dispatch' || operation.operationId === notDispatchedOperationId ||
            ['confirmed', 'absent'].includes(operation.effectState) && operation.reconciliationEvidenceIds?.length)) {
          record.state = operation.deliveryState === 'cancelled-before-dispatch' || operation.operationId === notDispatchedOperationId ? 'absent' : operation.effectState;
          record.reconciledAt = new Date().toISOString(); changed = true;
        }
      }
      if (changed) await save();
    });
  }
  return { check, reconcile };
}
