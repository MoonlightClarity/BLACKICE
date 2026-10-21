import { conversationTurn } from '../public/conversation-model.mjs';

export const CONVERSATION_EXPORT_FORMAT = 'relay-conversation';
export const CONVERSATION_EXPORT_VERSION = 1;
const fail = message => Object.assign(new Error(message), { status: 400, code: 'CONVERSATION_EXPORT_INVALID' });
const text = value => typeof value === 'string' ? value : '';
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const status = value => ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'].includes(value) ? value : 'unknown';
const safeFilename = value => text(value).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 100) || 'Conversation';
const heading = value => text(value).replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#+!|]/g, '\\$&');

function modelMetadata(run, node) {
  const selected = text(run.nodes?.[node.id]?.resolvedModel)
    || text([...(run.events || [])].reverse().find(event => event.nodeId === node.id && event.data?.type === 'thread')?.data?.model)
    || text(node.model);
  const delimiter = selected.indexOf('::');
  return {
    nodeId: text(node.id), name: text(node.name) || 'Agent',
    provider: delimiter >= 0 ? selected.slice(0, delimiter) : ['default', 'codex', ''].includes(selected) ? null : 'codex',
    model: delimiter >= 0 ? selected.slice(delimiter + 2) : selected || null,
    status: status(run.nodes?.[node.id]?.status),
  };
}

/** An allowlisted transcript, not a provider session backup or executable workflow. */
export function createConversationExport(family, { attachmentManifest = [], exportedAt = new Date().toISOString() } = {}) {
  if (!plain(family) || !Array.isArray(family.runs) || !family.runs.length) throw fail('Choose a saved conversation to export.');
  if (!date(exportedAt)) throw fail('The export date is invalid.');
  const runs = [...family.runs].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  const attachmentIds = new Set(runs.flatMap(run => run.attachmentIds || []).filter(id => typeof id === 'string'));
  const attachments = [...attachmentIds].map(id => {
    const entry = attachmentManifest.find(item => item?.id === id);
    if (!entry || entry.available === false && !entry.name) return { id, available: false };
    return {
      id, name: text(entry.name), kind: ['text', 'image'].includes(entry.kind) ? entry.kind : null,
      mime: text(entry.mime || entry.mediaType) || null,
      size: Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : null,
      sha256: /^[a-f0-9]{64}$/i.test(entry.sha256 || '') ? entry.sha256 : null,
      available: entry.available !== false,
    };
  });
  return {
    format: CONVERSATION_EXPORT_FORMAT, version: CONVERSATION_EXPORT_VERSION, exportedAt,
    conversation: {
      id: text(family.rootId || family.taskId || runs[0].id), title: text(family.title) || text(runs[0].input).split('\n')[0] || 'Conversation',
      state: ['active', 'archived', 'deleted', 'unknown'].includes(family.state) ? family.state : 'active',
      createdAt: date(runs[0].createdAt), updatedAt: date(runs.at(-1).updatedAt || runs.at(-1).finishedAt || runs.at(-1).createdAt),
      snapshot: runs.some(run => ['queued', 'running', 'waiting'].includes(run.status) || run.settled === false),
      archiveIncomplete: family.truncated === true, resumable: false,
    },
    turns: runs.map(run => {
      const turn = conversationTurn(run, runs);
      const messages = [];
      if (turn.userText) messages.push({ role: 'user', text: turn.userText, at: date(run.createdAt) });
      for (const message of turn.messages) messages.push({
        role: message.role, text: message.text, at: date(message.at),
        ...(message.nodeId ? { nodeId: text(message.nodeId) } : {}),
        ...(message.direction ? { direction: true } : {}),
        ...(message.phase ? { phase: text(message.phase) } : {}),
      });
      return {
        id: text(run.id), parentId: text(run.parentRunId) || null, retry: Boolean(run.retryOf), status: status(run.status),
        createdAt: date(run.createdAt), finishedAt: date(run.finishedAt),
        models: (run.workflow?.nodes || []).filter(node => node.type === 'agent').map(node => modelMetadata(run, node)),
        messages, attachmentIds: [...new Set((run.attachmentIds || []).filter(id => typeof id === 'string'))],
        ...(typeof run.errorCode === 'string' ? { errorCode: run.errorCode } : {}),
      };
    }),
    attachments,
    included: { messageText: true, modelMetadata: true, attachmentManifest: true, attachmentContents: false, toolTraces: false, providerSessions: false, connectionSettings: false, systemPrompts: false, privateReasoning: false },
  };
}

/** Markdown preserves the actual message text, including user-authored code and links. */
export function renderConversationMarkdown(document) {
  const transcript = parseConversationExport(document);
  const lines = [`# ${heading(transcript.conversation.title)}`, '', `Exported: ${transcript.exportedAt}`, '', 'Provider-neutral transcript. Start a new agent to continue; saved provider sessions are not included.', ''];
  if (transcript.conversation.snapshot) lines.push('This is a snapshot of work that was still running.', '');
  if (transcript.conversation.archiveIncomplete) lines.push('The conversation archive reported a problem; this export may be incomplete.', '');
  for (const turn of transcript.turns) {
    lines.push(`## ${turn.retry ? 'Retry' : 'Turn'} · ${heading(turn.status)}`, '');
    if (turn.models.length) lines.push(`Models: ${turn.models.map(model => heading(`${model.name}: ${model.provider ? model.provider + ' / ' : ''}${model.model || 'unknown'}`)).join('; ')}`, '');
    for (const message of turn.messages) {
      const model = turn.models.find(item => item.nodeId === message.nodeId);
      const speaker = message.role === 'user' ? message.direction ? 'You · direction' : 'You' : model?.name || 'Assistant';
      lines.push(`### ${heading(speaker)}`, '', message.text, '');
    }
  }
  if (transcript.attachments.length) {
    lines.push('## Attachments', '', 'File contents are not included.', '');
    for (const entry of transcript.attachments) lines.push(`- ${heading(entry.name || entry.id)}${entry.size !== null && entry.size !== undefined ? ` (${entry.size} bytes)` : ''}${entry.available === false ? ' — unavailable' : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Parse an interchange transcript without accepting thread IDs, commands, or configuration. */
export function parseConversationExport(value) {
  let document = value;
  if (typeof document === 'string') { try { document = JSON.parse(document); } catch { throw fail('This file is not a Relay conversation export.'); } }
  if (!plain(document) || document.format !== CONVERSATION_EXPORT_FORMAT || document.version !== CONVERSATION_EXPORT_VERSION || !plain(document.conversation) || !Array.isArray(document.turns) || !Array.isArray(document.attachments) || !date(document.exportedAt)) throw fail('This file is not a supported Relay conversation export.');
  if (typeof document.conversation.title !== 'string' || typeof document.conversation.id !== 'string') throw fail('The exported conversation metadata is invalid.');
  const turns = document.turns.map(turn => {
    if (!plain(turn) || typeof turn.id !== 'string' || !Array.isArray(turn.messages) || !Array.isArray(turn.models) || !Array.isArray(turn.attachmentIds)) throw fail('The exported conversation contains an invalid turn.');
    const models = turn.models.map(model => {
      if (!plain(model) || typeof model.nodeId !== 'string' || typeof model.name !== 'string' || model.model !== null && typeof model.model !== 'string' || model.provider !== null && typeof model.provider !== 'string') throw fail('The exported model metadata is invalid.');
      return { nodeId: model.nodeId, name: model.name, provider: model.provider, model: model.model, status: status(model.status) };
    });
    const messages = turn.messages.map(message => {
      if (!plain(message) || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' || message.nodeId !== undefined && typeof message.nodeId !== 'string' || message.phase !== undefined && typeof message.phase !== 'string') throw fail('The export contains an invalid conversation message.');
      return { role: message.role, text: message.text, at: date(message.at), ...(message.nodeId ? { nodeId: message.nodeId } : {}), ...(message.direction === true ? { direction: true } : {}), ...(message.phase ? { phase: message.phase } : {}) };
    });
    if (turn.attachmentIds.some(id => typeof id !== 'string')) throw fail('The exported attachment references are invalid.');
    return { id: turn.id, parentId: text(turn.parentId) || null, retry: turn.retry === true, status: status(turn.status), createdAt: date(turn.createdAt), finishedAt: date(turn.finishedAt), models, messages, attachmentIds: [...new Set(turn.attachmentIds)], ...(typeof turn.errorCode === 'string' ? { errorCode: turn.errorCode } : {}) };
  });
  const attachments = document.attachments.map(entry => {
    if (!plain(entry) || typeof entry.id !== 'string') throw fail('The exported attachment manifest is invalid.');
    return { id: entry.id, ...(typeof entry.name === 'string' ? { name: entry.name } : {}), ...(entry.kind === 'text' || entry.kind === 'image' ? { kind: entry.kind } : {}), ...(typeof entry.mime === 'string' ? { mime: entry.mime } : {}), ...(Number.isSafeInteger(entry.size) && entry.size >= 0 ? { size: entry.size } : {}), ...(/^[a-f0-9]{64}$/i.test(entry.sha256 || '') ? { sha256: entry.sha256 } : {}), available: entry.available !== false };
  });
  return { format: CONVERSATION_EXPORT_FORMAT, version: CONVERSATION_EXPORT_VERSION, exportedAt: document.exportedAt,
    conversation: { id: document.conversation.id, title: document.conversation.title, state: ['active', 'archived', 'deleted', 'unknown'].includes(document.conversation.state) ? document.conversation.state : 'unknown', createdAt: date(document.conversation.createdAt), updatedAt: date(document.conversation.updatedAt), snapshot: document.conversation.snapshot === true, archiveIncomplete: document.conversation.archiveIncomplete === true, resumable: false },
    turns, attachments,
    included: { messageText: true, modelMetadata: true, attachmentManifest: true, attachmentContents: false, toolTraces: false, providerSessions: false, connectionSettings: false, systemPrompts: false, privateReasoning: false },
  };
}

export function serializeConversationExport(family, { format = 'json', ...options } = {}) {
  if (!['json', 'markdown'].includes(format)) throw fail('Choose JSON or Markdown for the conversation export.');
  const document = createConversationExport(family, options), markdown = format === 'markdown';
  return { filename: `${safeFilename(document.conversation.title)}.${markdown ? 'md' : 'json'}`, contentType: markdown ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8', body: markdown ? renderConversationMarkdown(document) : JSON.stringify(document, null, 2) + '\n' };
}
