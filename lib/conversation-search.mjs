import { conversationTurn } from '../public/conversation-model.mjs';

const text = value => typeof value === 'string' ? value : '';
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'CONVERSATION_SEARCH_INVALID' });
const stamp = value => Date.parse(value || '') || 0;
// Fold accents, compatibility characters and the common multi-character/case
// variants without interpreting a query as a regular expression.
const fold = value => text(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
const compact = value => text(value).replace(/\s+/gu, ' ').trim();
const normalize = value => compact(fold(value));
const field = (kind, value, extra = {}) => ({ kind, text: text(value), normalized: normalize(value), ...extra });

export function conversationSearchOptions({ q = '', state = 'all', limit = 40, offset = 0 } = {}) {
  if (typeof q !== 'string' || q.length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(q)) throw invalid('Search with up to 200 characters.');
  if (!['all', 'active', 'archived', 'deleted'].includes(state)) throw invalid('Choose all, active, archived or deleted conversations.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('Choose a search limit from 1 to 100.');
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('Choose a nonnegative search offset.');
  const query = q.trim(), phrase = normalize(query);
  return { query, state, limit, offset, phrase, words: [...new Set(phrase.split(' ').filter(Boolean))] };
}

/** Only text which can appear in the chat, plus registered deliverable names.
 * Never retain the run, workflow instructions, task notes, tools or provider data
 * in this index. The engine keeps held planning answers outside saved snapshots.
 */
export function createConversationSearchDocument(run) {
  const turn = conversationTurn(run), fields = [];
  if (turn.userText) fields.push(field('message', turn.userText, { input: true }));
  for (const message of turn.messages) fields.push(field('message', message.text, {
    // Direction IDs in old transcripts contain their entire text. A turn is a
    // sufficient navigation target when that generated ID would bloat a result.
    ...(typeof message.id === 'string' && message.id.length <= 500 ? { messageId: message.id } : {}),
  }));
  const taskState = run.taskState, taskId = text(taskState?.taskId || run.taskId || run.id);
  const files = Array.isArray(taskState?.artifacts) ? {
    taskId, revision: Number.isSafeInteger(taskState.revision) ? taskState.revision : 0,
    updatedAt: text(taskState.updatedAt), fields: taskState.artifacts.filter(artifact => artifact && typeof artifact.id === 'string').map(artifact => {
      const title = text(artifact.title).trim(), name = text(artifact.fileName).trim();
      return field('file', title && name && title !== name ? `${title} · ${name}` : name || title);
    }).filter(value => value.normalized),
  } : null;
  return { runId: run.id, parentRunId: run.parentRunId, retry: Boolean(run.retryOf), createdAt: run.createdAt,
    userText: turn.userText, fields: fields.filter(value => value.normalized), files };
}

const compare = (a, b) => {
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
};

// The preview stays readable around the hit while preserving the original case
// and Unicode characters. Normalized offsets cannot index the original string:
// a ligature or an accented character can expand or disappear during folding.
function sourceOffset(source, normalizedOffset) {
  let offset = 0, normalized = 0;
  // Skip whole chunks using the native normalizer. Walking a long message one
  // code point at a time for every result would make late matches expensive.
  while (offset < source.length) {
    let end = Math.min(source.length, offset + 1024);
    if (end < source.length && /[\uDC00-\uDFFF]/.test(source[end])) end--;
    const length = fold(source.slice(offset, end)).length;
    if (normalized + length > normalizedOffset) break;
    normalized += length; offset = end;
  }
  for (const character of source.slice(offset)) {
    const length = fold(character).length;
    if (normalized + length > normalizedOffset) return offset;
    normalized += length; offset += character.length;
  }
  return source.length;
}
function safeSlice(source, start, end) {
  if (start > 0 && /[\uDC00-\uDFFF]/.test(source[start] || '')) start++;
  if (end < source.length && /[\uDC00-\uDFFF]/.test(source[end] || '')) end--;
  return source.slice(start, end);
}
export function conversationMatchPreview(value, words = [], phrase = '', max = 200) {
  const source = compact(value);
  if (source.length <= max) return source;
  const normalized = fold(source), phraseAt = phrase ? normalized.indexOf(phrase) : -1;
  const positions = words.map(word => ({ at: normalized.indexOf(word), length: word.length })).filter(hit => hit.at >= 0).sort((a, b) => a.at - b.at);
  const hit = phraseAt >= 0 ? { at: phraseAt, length: phrase.length } : positions[0] || { at: 0, length: 0 };
  const hitStart = sourceOffset(source, hit.at), hitEnd = sourceOffset(source, hit.at + hit.length);
  const width = max - 2, context = Math.min(55, Math.max(0, Math.floor((width - (hitEnd - hitStart)) / 2)));
  let start = Math.max(0, hitStart - context);
  if (start + width >= source.length) start = Math.max(0, source.length - width);
  const end = Math.min(source.length, start + width);
  return `${start ? '…' : ''}${safeSlice(source, start, end).trim()}${end < source.length ? '…' : ''}`;
}

/** Search committed, pre-projected turns in memory. Organization comes from the
 * current catalog so renames, Archive and Trash cannot leave stale index states.
 * All query words must occur in the conversation; the preview chooses the most
 * specific passage, even when words span messages or turns.
 */
export function searchConversationDocuments({ summaries, documents, rootIdFor, options }) {
  const { query, state, limit, offset, words, phrase } = options, groups = new Map();
  for (const summary of summaries) if (state === 'all' ? ['active', 'archived'].includes(summary.state) : summary.state === state) groups.set(summary.rootId, { summary, turns: [] });
  for (const document of documents.values()) groups.get(rootIdFor(document.runId))?.turns.push(document);
  const results = [];
  for (const { summary, turns } of groups.values()) {
    const found = new Set(), files = new Map(); let best;
    const consider = (value, runId, createdAt, order = 0) => {
      const matches = words.filter(word => value.normalized.includes(word));
      for (const word of matches) found.add(word);
      if (words.length && !matches.length) return;
      const complete = matches.length === words.length;
      // When words span the title and transcript, show the matching content
      // passage. A partial title alone cannot explain why this result matches.
      if (value.kind === 'title' && !complete) return;
      const exact = value.normalized === phrase, starts = phrase && value.normalized.startsWith(phrase), includes = phrase && value.normalized.includes(phrase);
      const titleRank = value.kind === 'title' && complete ? exact ? 4 : starts ? 3 : includes ? 2 : 1 : 0;
      const rank = [Number(complete), titleRank, matches.length, exact ? 3 : starts ? 2 : includes ? 1 : 0, value.kind === 'file' ? 1 : 0, stamp(createdAt), order];
      if (!best || compare(rank, best.rank) > 0) best = { value, runId, rank };
    };
    const titleRunId = documents.has(summary.rootId) ? summary.rootId : turns.slice().sort((a, b) => stamp(a.createdAt) - stamp(b.createdAt) || a.runId.localeCompare(b.runId))[0]?.runId || summary.latestRunId;
    consider(field('title', summary.title), titleRunId, summary.updatedAt);
    for (const document of turns) {
      const parent = documents.get(document.parentRunId);
      document.fields.forEach((value, index) => {
        if (!(value.input && document.retry && parent?.userText === document.userText)) consider(value, document.runId, document.createdAt, index);
      });
      if (document.files) {
        const previous = files.get(document.files.taskId);
        const rank = [document.files.revision, stamp(document.files.updatedAt), stamp(document.createdAt)];
        if (!previous || compare(rank, previous.rank) > 0) files.set(document.files.taskId, { document, rank });
      }
    }
    for (const { document } of files.values()) for (const value of document.files.fields) consider(value, document.runId, document.createdAt);
    if (found.size !== words.length || !best) continue;
    results.push({ summary, best });
  }
  results.sort((a, b) => -compare(a.best.rank.slice(0, 5), b.best.rank.slice(0, 5)) || stamp(b.summary.updatedAt) - stamp(a.summary.updatedAt) || a.summary.rootId.localeCompare(b.summary.rootId));
  return {
    query, state, total: results.length, offset, limit, hasMore: offset + limit < results.length,
    conversations: results.slice(offset, offset + limit).map(({ summary, best }) => ({ ...summary, match: {
      runId: best.runId, kind: best.value.kind, text: conversationMatchPreview(best.value.text, words, phrase),
      ...(best.value.messageId ? { messageId: best.value.messageId } : {}),
    } })),
  };
}
