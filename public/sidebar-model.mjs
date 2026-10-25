import { conversationId, conversationSidebarItems, isActiveRun, isSettlingRun } from './conversation-model.mjs';
import { searchMatchLabel } from './conversation-search.mjs';

const timestamp = value => Date.parse(value || '') || 0;
const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const localDay = value => { const date = new Date(value); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000; };

/** The sidebar uses the complete loaded catalog; searching never requires transcripts. */
export function sidebarConversations({ summaries = {}, runs = [], runSummaries = null, historyState = 'active', query = '', isUnread = () => false } = {}) {
  const phrase = normalize(query).trim(), words = phrase.split(/\s+/).filter(Boolean);
  const buckets = historyState === 'deleted' ? ['deleted'] : phrase || historyState === 'unread' ? ['active', 'archived'] : [historyState === 'working' ? 'active' : historyState];
  const updated = new Map();
  const remember = (id, at) => { const value = timestamp(at); if (value > (updated.get(id) || 0)) updated.set(id, value); };
  for (const bucket of ['active', 'archived', 'deleted']) for (const item of summaries[bucket] || []) remember(item.taskId || item.rootId || item.id, item.updatedAt || item.createdAt);
  const byId = new Map(runs.map(run => [run.id, run]));
  for (const run of runs) remember(conversationId(run, runs, byId), run.updatedAt || run.createdAt);
  return buckets.flatMap(state => conversationSidebarItems({ summaries, runs, runSummaries, state })).map(item => {
    const at = Math.max(timestamp(item.updatedAt || item.createdAt), updated.get(item.id) || 0);
    const title = normalize(item.title), searchable = normalize(`${item.title} ${item.preview || item.originalTask || ''}`);
    return { ...item, updatedAt: at ? new Date(at).toISOString() : '', unread: isUnread(item.id), match: words.every(word => searchable.includes(word)), score: title === phrase ? 4 : title.startsWith(phrase) ? 3 : title.includes(phrase) ? 2 : 1 };
  }).filter(item => item.match && (historyState !== 'unread' || item.unread) && (historyState !== 'working' || isActiveRun(item) || isSettlingRun(item)))
    .sort((a, b) => (phrase ? b.score - a.score : 0) || timestamp(b.updatedAt) - timestamp(a.updatedAt) || String(a.id).localeCompare(String(b.id)));
}

export function sidebarGroups(items, now = Date.now()) {
  const today = localDay(now), groups = new Map();
  for (const item of items) {
    const at = timestamp(item.updatedAt || item.createdAt), age = at ? today - localDay(at) : Infinity;
    const label = age <= 0 ? 'Today' : age === 1 ? 'Yesterday' : age < 7 ? 'Previous 7 days' : 'Older';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  return [...groups].map(([label, items]) => ({ label, items }));
}

export function sidebarStatus(item) {
  if (isSettlingRun(item)) return { label: item.status === 'cancelled' ? 'Stopping…' : 'Finishing…', kind: 'working' };
  if (item.status === 'queued') return { label: 'Queued', kind: 'working' };
  if (item.status === 'running') return { label: 'Working', kind: 'working' };
  if (item.status === 'waiting') return { label: 'Waiting', kind: 'waiting' };
  if (item.status === 'failed') return { label: 'Needs attention', kind: 'failed' };
  if (item.status === 'cancelled') return { label: item.settled === true ? 'Stopped' : 'Stop requested', kind: 'stopped' };
  return null;
}

export function renderSidebarGroups(groups, { selectedId, escape, bulkSelecting = false, bulkSelected = new Set() } = {}) {
  return groups.map(group => `<section class="conversation-sidebar-group" aria-label="${escape(group.label)}"><h2 class="conversation-sidebar-heading">${escape(group.label)}</h2>${group.items.map(item => {
    const selected = selectedId === item.id, marked = bulkSelected.has(item.id), status = sidebarStatus(item);
    const match = item.match && typeof item.match === 'object' ? item.match : null;
    const preview = match && match.kind !== 'title' ? `<span class="conversation-sidebar-preview"><span class="conversation-match-kind">${searchMatchLabel(match)}</span>${escape(match.text)}</span>` : '';
    const searchTarget = match ? ` data-search-run-id="${escape(match.runId)}"${match.messageId ? ` data-search-message-id="${escape(match.messageId)}"` : ''}` : '';
    const attention = item.unread ? item.status === 'failed' ? 'Unseen error' : item.status === 'cancelled' ? item.settled === true ? 'Unseen stopped response' : 'Stop requested' : 'New response' : '';
    const secondary = [status ? `<span class="conversation-sidebar-status ${status.kind}">${status.kind === 'working' ? '<i class="conversation-running-mark" aria-hidden="true"></i>' : ''}${status.kind === 'failed' ? '<span aria-hidden="true">!</span>' : ''}${status.label}</span>` : '', item.state === 'archived' ? '<span class="conversation-sidebar-archived">Archived</span>' : ''].filter(Boolean).join('');
    const checkbox = bulkSelecting ? `<input type="checkbox" class="conversation-bulk-checkbox" data-bulk-id="${escape(item.id)}" aria-label="Select ${escape(item.title)}"${marked ? ' checked' : ''}>` : '';
    const more = bulkSelecting ? '' : `<button type="button" class="conversation-list-more" data-chat-more="true" data-conversation-id="${escape(item.id)}" data-id="${escape(item.runId)}" aria-haspopup="menu" aria-label="More actions for ${escape(item.title)}" title="Chat actions"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="13" cy="8" r="1.25"/></svg></button>`;
    return `<div class="conversation-sidebar-row${selected ? ' selected' : ''}${attention ? ' unread' : ''}${bulkSelecting ? ' bulk-mode' : ''}${marked ? ' bulk-marked' : ''}">${checkbox}<button type="button" class="conversation-list-item${selected ? ' selected' : ''}" data-mission-action="${bulkSelecting ? 'bulk-toggle' : 'open-run'}"${searchTarget} data-conversation-id="${escape(item.id)}" data-id="${escape(item.runId)}"${bulkSelecting ? ` aria-pressed="${marked}"` : ' aria-haspopup="menu"'} title="${escape(item.title)}${attention ? ` · ${attention}` : ''}"${attention ? ` aria-label="${escape(item.title)} · ${attention}"` : ''}${selected ? ' aria-current="page"' : ''}><span class="conversation-sidebar-title">${attention ? '<span class="conversation-unread-mark" aria-hidden="true"></span>' : ''}${escape(item.title)}</span>${preview}${secondary ? `<span class="conversation-sidebar-meta">${secondary}</span>` : ''}</button>${more}</div>`;
  }).join('')}</section>`).join('');
}
