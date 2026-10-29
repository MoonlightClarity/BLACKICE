import { safeSvgPreview, SVG_PREVIEW_LIMIT } from './svg-preview.mjs';
import { isSettlingRun } from './conversation-model.mjs';

const ACTIVE = new Set(['queued', 'running', 'waiting']);
const brief = (value, limit = 170) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const fileName = value => brief(value).split(/[\\/]/).at(-1) || '';
const label = value => brief(value || '').replaceAll('_', ' ');
const neoErrorDetail = value => {
  if (typeof value !== 'string' || !value.trim()) return 'Browser action failed. Inspect its tool result.';
  const raw = value.replace(/^error:\s*/i, '');
  const jsonEcho = /\s+\{(?=(?:\\?")?error(?:\\?")?\s*:)/.exec(raw);
  const concise = jsonEcho ? raw.slice(0,jsonEcho.index) : raw;
  return brief(concise, 170) || 'Browser action failed. Inspect its tool result.';
};
const toolNames = { relay_workspace: 'Workspace', relay_browser: 'Browser', relay_desktop: 'Windows', relay_memory: 'Memory', relay_skills: 'Skills', relay_history: 'History', relay_identity: 'Identity', relay_connections: 'Connected tool', relay_task: 'Task plan', relay_files: 'Attached files' };
const actions = { list: 'List files', read: 'Read', write: 'Write file', search: 'Search', run: 'Run command', open: 'Open page', navigate: 'Navigate', snapshot: 'Inspect page', screenshot: 'Observe page', click: 'Activate control', fill: 'Fill field', select: 'Select', press: 'Browser key', upload: 'Upload file', downloads: 'Check downloads', windows: 'List windows', inspect: 'Inspect controls', invoke: 'Invoke control', set_value: 'Set value', get_text: 'Read text', toggle: 'Toggle control', expand: 'Expand control', collapse: 'Collapse control', plan: 'Save plan', review: 'Reassess plan', step: 'Update step', checkpoint: 'Save checkpoint', artifact: 'Check deliverable' };

export function selectObservedRun(snapshot = {}, selectedId = null, followedId = null) {
  const runs = snapshot.runs || [], current = snapshot.currentRun;
  if (selectedId) return current?.id === selectedId ? current : runs.find(run => run.id === selectedId) || null;
  const followed = followedId && (current?.id === followedId ? current : runs.find(run => run.id === followedId));
  return ACTIVE.has(current?.status) ? current : runs.find(run => ACTIVE.has(run.status)) || (isSettlingRun(current) ? current : null) || runs.find(isSettlingRun) || followed || null;
}
export function createObserveSelection() {
  let selectedId = null, followedId = null;
  return {
    get selectedId() { return selectedId; },
    choose(id) { selectedId = id || null; followedId = null; },
    enter({ preserveSelection = false } = {}) { if (!preserveSelection) selectedId = null; followedId = null; },
    model(snapshot, options = {}) {
      const view = observeModel(snapshot, { ...options, selectedId, followedId });
      if (!selectedId) followedId = view.run?.id || null;
      return view;
    }
  };
}
const externalUrl = value => {
  if(typeof value!=='string'||value.length>2048)return null;
  try{const parsed=new URL(value);return ['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password?parsed.href:null;}catch{return null;}
};
// Email destinations are receipt metadata, never result links or composer actions.
const emailDestinationRecipient = value => {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('mailto:')) return null;
  const address = value.slice(7), at = address.indexOf('@');
  if (at < 1 || at !== address.lastIndexOf('@')) return null;
  let local; try { local = decodeURIComponent(address.slice(0, at)); } catch { return null; }
  const domain = address.slice(at + 1);
  if (local.length > 64 || !/^[A-Za-z0-9!#$%&'*+\/=?^_\x60{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_\x60{|}~-]+)*$/.test(local) || domain.length > 253 || !domain.split('.').every(part => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))) return null;
  return value === `mailto:${encodeURIComponent(local)}@${domain.toLowerCase()}` ? `${local}@${domain}` : null;
};
// A canonical message reference is opaque receipt text, never a browser URL.
const emailMessageReference = receipt => {
  const value=receipt.url;
  if(receipt.referenceKind!=='email-message'||typeof value!=='string'||value.length>2048||!value.startsWith('mid:')||/[\s\u0000-\u001f\u007f/?#]/.test(value.slice(4)))return null;
  let decoded;try{decoded=decodeURIComponent(value.slice(4));}catch{return null;}
  const match=/^([^@]+)@(.+)$/.exec(decoded),dotAtom=/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  if(!match||!dotAtom.test(match[1])||!(dotAtom.test(match[2])||/^\[[\x21-\x5a\x5e-\x7e]*\]$/.test(match[2])))return null;
  const emailMessageId=`<${decoded}>`;
  return value===`mid:${encodeURIComponent(match[1])}@${encodeURIComponent(match[2])}`&&receipt.emailMessageId===emailMessageId?{referenceKind:'email-message',emailMessageId}:null;
};
const receiptText=(value,limit)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,limit):'';
const receiptIdentity=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)?value:null;
/** Saved milestones describe what an agent recorded, including unresolved blockers. */
export function observePlan(taskState,{stepIds}={}){
  const saved=Array.isArray(taskState?.steps)?taskState.steps:[],filter=Array.isArray(stepIds)?new Set(stepIds):null;
  const steps=saved.filter(step=>step&&typeof step==='object'&&(!filter||filter.has(step.id))).map((step,index)=>({
    id:receiptIdentity(step.id)||'saved-step-'+index,title:receiptText(step.title,300)||'Untitled step',status:['pending','active','blocked','done'].includes(step.status)?step.status:'unknown',doneWhen:receiptText(step.doneWhen,1000),evidence:receiptText(step.evidence,2000),blockedReason:receiptText(step.blockedReason,1000),note:receiptText(step.note,700)
  }));
  const done=steps.filter(step=>step.status==='done').length,blocked=steps.filter(step=>step.status==='blocked').length,active=steps.find(step=>step.status==='active'),next=steps.find(step=>step.status==='pending'),blocker=steps.find(step=>step.status==='blocked'),filtered=Boolean(filter)&&steps.length<saved.length;
  const summary=active?`Current: ${active.title}${blocked?` · ${blocked} blocked ${blocked===1?'step':'steps'}`:''}`:blocker?`Needs attention: ${blocker.title}`:next?`Next saved step: ${next.title}`:steps.length&&done===steps.length?`All ${filtered?'shown':'saved'} steps marked complete`:steps.length?'Some saved steps have an unknown status.':'';
  return{steps,done,blocked,summary,filtered};
}
/** Saved external outcomes are task-level agent reports, independent of run completion. */
export function observeExternalActions(run){
  const saved=run?.taskState,raw=Array.isArray(saved?.externalActions)?saved.externalActions:[],receipts=[];
  for(const [index,receipt]of raw.slice(0,8).entries()){
    if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))continue;
    const destinationRecipient=emailDestinationRecipient(receipt.destination);
    const status=['prepared','uncertain','confirmed'].includes(receipt.status)?receipt.status:'unknown',destination=destinationRecipient?receipt.destination:externalUrl(receipt.destination),messageReference=status==='confirmed'&&destinationRecipient?emailMessageReference(receipt):null,url=status==='confirmed'?(messageReference?receipt.url:externalUrl(receipt.url)):null;
    const source=status==='confirmed'?receipt.confirmedBy:status==='prepared'&&receipt.reconciledAt?receipt.reconciledBy:receipt.attemptedBy;
    const attempts=Number.isSafeInteger(receipt.attempts)&&receipt.attempts>=0?receipt.attempts:null,reconciled=status==='prepared'&&Boolean(receipt.reconciledAt),needsInspection=status==='uncertain'||status==='unknown'||status==='confirmed'&&!url;
    const recordedAt=[status==='confirmed'?receipt.confirmedAt:null,status==='prepared'?receipt.reconciledAt:null,receipt.attemptedAt,receipt.preparedAt].find(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)))||null;
    receipts.push({id:receiptIdentity(receipt.id)||'unidentified-'+index,status,label:({prepared:reconciled?'Absence checked':'Prepared',uncertain:'Needs inspection',confirmed:'Confirmed result',unknown:'Unknown outcome'})[status],destination,...(destinationRecipient?{destinationRecipient}:{}),url,...(messageReference||{}),attempts,attemptsMayBeIncomplete:receipt.attemptsMayBeIncomplete===true,needsInspection,reconciled,recordedAt,contentExcerpt:receiptText(receipt.contentExcerpt,160),evidence:receiptText(receipt.evidence,2000),absenceEvidence:receiptText(receipt.absenceEvidence,2000),attachmentSha256:typeof receipt.attachmentSha256==='string'&&/^[a-f0-9]{64}$/.test(receipt.attachmentSha256)?receipt.attachmentSha256:null,sourceRunId:receiptIdentity(source?.runId),sourceNodeId:receiptIdentity(source?.nodeId)});
  }
  const priority=item=>item.needsInspection?0:item.status==='prepared'?1:2;receipts.sort((one,two)=>priority(one)-priority(two));
  return{receipts,recoveryRequired:saved?.externalRecovery?.required===true,recoveryNote:receiptText(saved?.externalRecovery?.note,700),confirmed:receipts.filter(item=>item.status==='confirmed').length,needsInspection:receipts.filter(item=>item.needsInspection).length};
}
function resultStatus(item, stage) {
  if (item.success === false || item.error || item.timedOut || item.exitCode != null && Number(item.exitCode) !== 0 || ['failed', 'error'].includes(item.status)) return 'failed';
  if (item.status === 'cancelled' || item.status === 'interrupted') return 'cancelled';
  if (item.status === 'completed' || stage === 'completed') return 'completed';
  if (['inProgress', 'in_progress', 'running', 'started'].includes(item.status) || stage === 'started') return 'running';
  return 'recorded';
}
const object = value => { if (value && typeof value === 'object' && !Array.isArray(value)) return value; try { const parsed = typeof value === 'string' ? JSON.parse(value) : null; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } };
const commandText = (value, limit) => typeof value === 'string' ? value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit) : '';
/** Only real command receipts expose output. Other tool payloads stay out of Observe. */
function commandRecord(item, args, stage, native = false) {
  const texts = (item.contentItems || []).filter(content => content?.type === 'inputText' && typeof content.text === 'string').map(content => content.text);
  const receipt = native ? item : texts.map(object).find(value => ['exitCode', 'stdout', 'stderr', 'timedOut', 'error'].some(key => Object.hasOwn(value, key))) || {};
  const line = native ? item.command : args.command || receipt.command, cwd = receipt.cwd || args.cwd;
  const stdout = native ? item.aggregatedOutput : receipt.stdout, stderr = receipt.stderr;
  const error = receipt.error || (item.success === false && !Object.keys(receipt).length ? texts.join('\n') : null);
  const finished = stage === 'completed' || ['completed', 'failed', 'error', 'cancelled', 'interrupted'].includes(item.status);
  const command = {
    ...(typeof line === 'string' ? { line: commandText(line, 4000) } : {}),
    ...(typeof cwd === 'string' ? { cwd: commandText(cwd, 2000) } : {}),
    ...(Number.isInteger(receipt.exitCode) ? { exitCode: receipt.exitCode } : {}),
    ...(typeof stdout === 'string' ? { stdout: commandText(stdout, 12000) } : {}),
    ...(typeof stderr === 'string' ? { stderr: commandText(stderr, 6000) } : {}),
    ...(error ? { error: commandText(typeof error === 'string' ? error : error.message || JSON.stringify(error), 2000) } : {}),
    ...(receipt.timedOut === true ? { timedOut: true } : {}),
    ...(native ? { combinedOutput: true } : {}),
    finished,
    ...(receipt.truncated || typeof line === 'string' && line.length > 4000 || typeof stdout === 'string' && stdout.length > 12000 || typeof stderr === 'string' && stderr.length > 6000 ? { truncated: true } : {})
  };
  return { command, status: resultStatus({ ...item, ...receipt, success: item.success }, stage) };
}
function mergeActivity(previous, next) {
  return { ...previous, ...next, detail: next.detail || previous.detail, ...(previous.command || next.command ? { command: { ...previous.command, ...next.command } } : {}) };
}
export function normalizeObserveEvent(event, index = 0) {
  const data = event?.data || {}, item = data.item; let row;
  if (data.type === 'item' && item) {
    const status = resultStatus(item, data.stage);
    if (item.type === 'commandExecution') { const action = item.commandActions?.[0], record = commandRecord(item, {}, data.stage, true); row = { kind: 'workspace', icon: 'terminal', title: action?.type === 'read' ? 'Read file' : action?.type === 'search' ? 'Search workspace' : 'Run command', detail: brief(record.command.line) || fileName(action?.path || action?.name), ...record }; }
    if (item.type === 'fileChange') row = { kind: 'workspace', icon: 'file', title: 'File update', detail: (item.changes || []).map(change => fileName(change.path)).filter(Boolean).slice(0, 2).join(', '), status };
    if (item.type === 'webSearch') row = { kind: 'browser', icon: 'search', title: 'Web search', detail: brief(item.query || item.action?.query), status };
    if (['dynamicToolCall', 'mcpToolCall'].includes(item.type)) { const name = item.name || item.tool, args = object(item.arguments); row = { kind: name === 'relay_browser' ? 'browser' : name === 'relay_desktop' ? 'desktop' : 'tool', icon: name === 'relay_browser' ? 'grid' : name === 'relay_desktop' ? 'desktop' : 'tool', title: toolNames[name] || (item.type === 'mcpToolCall' ? 'Connected tool' : brief(name, 80) || 'Tool call'), detail: actions[args.action] || label(item.toolName || item.server || ''), status }; if (name === 'relay_workspace' && args.action === 'run') { const record = commandRecord(item, args, data.stage); row = { ...row, kind: 'workspace', icon: 'terminal', title: 'Run command', detail: brief(record.command.line), ...record }; } if (name === 'relay_task' && args.action === 'review') row = { ...row, kind: 'plan', icon: 'plan', reassessment: true, title: 'Reassess plan', detail: [label(args.review?.decision), brief(args.review?.summary)].filter(Boolean).join(' · ') }; }
    if (row) row.key = item.id ? `${event.nodeId || ''}:${item.id}` : null;
  }
  if (data.type === 'tool.result' && data.tool === 'relay_connections' && data.connectionId === 'browseros-neo') {
    const operation = typeof data.integration === 'string' && /^[a-z_]{1,50}$/i.test(data.integration) ? data.integration.replaceAll('_',' ') : 'tool';
    const failed = data.success === false || data.status === 'failed';
    const cause = failed ? neoErrorDetail(data.message) : '';
    row = {
      kind: 'browser', icon: 'grid', title: `BrowserOS Neo · ${operation}`,
      detail: failed ? cause : 'Browser action completed',
      status: failed ? 'failed' : 'completed',
      ...(typeof data.callId === 'string' && data.callId ? { key: `${event.nodeId || ''}:${data.callId}` } : {}),
    };
  }
  if (['workspace.action', 'browser.action', 'connection.action', 'desktop', 'knowledge'].includes(data.type)) {
    const kind = data.type.split('.')[0], title = actions[data.action] || label(data.action) || brief(data.message, 80) || 'Tool activity';
    row = { kind, icon: kind === 'browser' ? 'grid' : kind === 'desktop' ? 'desktop' : kind === 'workspace' ? 'folder' : 'tool', title, detail: fileName(data.path) || brief(data.toolName || data.title || ''), status: data.status ? resultStatus(data) : 'requested' };
  }
  if (data.type === 'browser.signin' && data.status === 'awaiting-user') {
    row = {kind:'browser',icon:'grid',title:data.reason === 'verification' ? 'Browser verification required' : data.reason === 'permission' ? 'Website permission required' : 'Browser sign-in required',detail:brief(data.hostname,100),status:'recorded'};
  }
  if (data.type === 'task.state') { const steps = data.state?.steps || []; row = { kind: 'plan', icon: 'plan', title: 'Task plan saved', detail: `${steps.filter(step => step.status === 'done').length} of ${steps.length} steps marked complete`, status: 'completed' }; }
  if (data.type === 'planning.reassessment' && ['current','continuing','required','stale','stalled'].includes(data.reviewStatus)) {
    const status = data.reviewStatus, nodeId = brief(data.workerId || event.nodeId, 120);
    row = { kind: 'plan', icon: 'plan', reassessment: true,
      nodeId, key: `review:${nodeId}:${data.review?.reviewedRevision ?? ''}:${Number(data.returnCount) || 0}:${status}`,
      title: status === 'current' ? 'Planning reviewed' : status === 'stalled' ? 'Planning review stalled' : status === 'continuing' ? 'Return to planning' : 'Planning review needed',
      detail: status === 'current' ? [label(data.review?.decision), brief(data.review?.summary)].filter(Boolean).join(' · ') : brief(data.reviewReason),
      status: status === 'current' ? 'completed' : status === 'stalled' ? 'failed' : status === 'continuing' ? 'running' : 'recorded' };
  }
  if (!row) return null;
  return { ...row, key: row.key || `event-${index}`, nodeId: row.nodeId || event.nodeId || null, at: typeof event.at === 'string' ? event.at : data.at || null, title: brief(row.title, 100), detail: brief(row.detail) };
}
export function observeTrace(run, { limit = 20, nodeId = null } = {}) {
  const result = [], byKey = new Map(); let index = 0;
  for (const event of (run?.events || []).slice(-5000)) {
    const row = normalizeObserveEvent(event, index++); if (!row || nodeId && row.nodeId !== nodeId) continue;
    const previous = byKey.get(row.key);
    if (previous) { Object.assign(previous, mergeActivity(previous, row)); result.splice(result.indexOf(previous), 1); result.push(previous); }
    else { result.push(row); byKey.set(row.key, row); }
  }
  return result.slice(-Math.max(1, Math.min(50, Number(limit) || 20)));
}
export function agentElapsed(state, now = Date.now()) {
  const start = Date.parse(state?.startedAt); if (!Number.isFinite(start)) return null;
  const end = Date.parse(state.finishedAt), active = ACTIVE.has(state.status);
  if (!Number.isFinite(end) && !active) return null;
  return Math.max(0, (Number.isFinite(end) ? end : now) - start);
}
export function observeAgents(run, { now = Date.now() } = {}) {
  if (!run) return [];
  return (run.workflow?.nodes || []).filter(node => node.type === 'agent' && run.nodes?.[node.id]).map(node => {
    const state = run.nodes[node.id], events = (run.events || []).filter(event => event.nodeId === node.id), tool = observeTrace(run, { nodeId: node.id, limit: 1 })[0];
    const actualModel = [...events].reverse().find(event => event.data?.type === 'thread' && event.data.model)?.data.model;
    const message = [...events].reverse().find(event => event.data?.type === 'message' && typeof event.data.text === 'string');
    const latest = tool && (!message || Date.parse(tool.at) >= Date.parse(message.at)) ? [tool.title, tool.detail].filter(Boolean).join(' · ') : brief(message?.data.text);
    return { id: node.id, name: brief(node.name || node.id, 100), status: state.status || 'unknown', settled: run.settled, model: brief(actualModel || state.model || (node.model && node.model !== 'default' ? node.model : ''), 100) || 'Model default', elapsedMs: agentElapsed(state, now), activity: brief(state.error?.message || state.error) || latest || (state.status === 'completed' ? brief(state.output) : ''), threadId: state.threadId || null };
  });
}
export function observeModel(snapshot = {}, { selectedId = null, followedId = null, now = Date.now() } = {}) {
  const run = selectObservedRun(snapshot, selectedId, followedId), agents = observeAgents(run, { now });
  return { run, agents, trace: observeTrace(run), active: ACTIVE.has(run?.status), activeAgents: agents.filter(agent => ['running', 'waiting'].includes(agent.status)).length, streamState: snapshot.streamState || 'snapshot', runs: [...(snapshot.runs || []), ...(snapshot.currentRun && !(snapshot.runs || []).some(item => item.id === snapshot.currentRun.id) ? [snapshot.currentRun] : [])].slice(0, 100).map(item => ({ id: item.id, name: brief(item.originalTask || item.input?.task || item.input || item.workflowName || 'Task', 65), status: item.status, settled: item.settled })) };
}

/** Only events received after entry are admitted. Snapshots never populate this live feed. */
export function createObserveFeed({ maxEntries = 40, maxChars = 240000 } = {}) {
  let runId = null, sequence = 0, editEpoch = 0, entries = [], latestEdit = null, serial = 0, pendingMessages = new Map(), seen = new Set();
  const bound = () => { while (entries.length > maxEntries || JSON.stringify(entries).length > maxChars) { const removed = entries.shift(); if (!removed) break; for (const [nodeId, key] of pendingMessages) if (key === removed.key) pendingMessages.delete(nodeId); } if (seen.size > 300) seen = new Set([...seen].slice(-150)); };
  const append = entry => { const previous = entries.findIndex(item => item.key === entry.key); if (previous >= 0) entry = mergeActivity(entries.splice(previous, 1)[0], entry); entries.push(entry); bound(); return true; };
  return {
    reset(id = null, baselineSequence = 0) { runId = id; sequence = Number(baselineSequence) || 0; editEpoch = 0; entries = []; latestEdit = null; serial = 0; pendingMessages.clear(); seen.clear(); },
    baseline(value) { sequence = Math.max(sequence, Number(value) || 0); },
    reconnectBaseline(value) { sequence = Math.max(0, Number(value) || 0); editEpoch++; },
    settle(nodeId = null) { for (const entry of entries) if (entry.kind === 'message' && (!nodeId || entry.nodeId === nodeId)) entry.streaming = false; if (nodeId) pendingMessages.delete(nodeId); else pendingMessages.clear(); },
    edit(payload) {
      const event = payload?.data?.type === 'run.edit' ? payload.data : payload;
      if (!runId || event?.runId !== runId || event.source !== 'filesystem' || !Number.isInteger(event.sequence) || event.sequence <= sequence || typeof event.path !== 'string') return false;
      sequence = event.sequence;
      const preview = !event.contentOmitted && event.diff && !event.diff.truncated && event.bytes?.after <= SVG_PREVIEW_LIMIT && ['created', 'modified'].includes(event.change) && /\.svg$/i.test(event.path) && event.preview?.type === 'svg' && safeSvgPreview(event.preview.text) ? { type: 'svg', text: event.preview.text } : null;
      latestEdit = { key: `edit:${editEpoch}:${sequence}`, kind: 'edit', at: event.at, path: brief(event.path, 1000), change: event.change, diff: event.diff, contentOmitted: event.contentOmitted, bytes: event.bytes, sequence, source: 'filesystem', ...(preview ? { preview } : {}) };
      return append(latestEdit);
    },
    event(event) {
      if (!runId || event?.runId !== runId || event.type !== 'agent.event') return false;
      const data = event.data || {}, nodeId = event.nodeId || '', at = event.at;
      if (['message', 'delta'].includes(data.type)) {
        const value = data.type === 'delta' ? data.delta : data.text; if (typeof value !== 'string' || !value.length || data.type === 'message' && !value.trim()) return false;
        const receipt = JSON.stringify([nodeId, at, data.type, data.itemId || data.id, value.length, value.slice(0, 120), value.slice(-120)]); if (seen.has(receipt)) return false; seen.add(receipt);
        let key = pendingMessages.get(nodeId); if (!key) { key = `message:${nodeId}:${++serial}`; pendingMessages.set(nodeId, key); }
        const before = entries.find(item => item.key === key), text = data.type === 'delta' ? `${before?.text || ''}${value}`.slice(-2400) : value.slice(0, 2400);
        if (data.type === 'message') pendingMessages.delete(nodeId);
        return append({ key, kind: 'message', nodeId, at, title: 'Agent update', text, streaming: data.type === 'delta' });
      }
      const row = normalizeObserveEvent(event, ++serial); if (!row || row.kind === 'plan' && !row.reassessment) return false;
      const receipt = JSON.stringify([row.key, row.at, row.status, row.title, row.detail]); if (seen.has(receipt)) return false; seen.add(receipt);
      return append({ ...row, kind: 'activity', key: row.key.startsWith('event-') ? `activity:${serial}` : row.key });
    },
    snapshot() { return { runId, sequence, entries: [...entries], latestEdit }; }
  };
}

export function observeLiveEntries(feed, { focus = 'auto', file = null } = {}) {
  const entries = feed.entries.filter(entry => !file || entry.kind !== 'edit' || entry.path === file);
  const pinned = focus === 'auto' ? (feed.latestEdit && (!file || feed.latestEdit.path === file) ? feed.latestEdit : [...entries].reverse().find(entry => entry.kind === 'edit')) || null : null;
  const candidates = entries.filter(entry => entry.key !== pinned?.key && (focus !== 'edits' || entry.kind === 'edit') && (focus !== 'activity' || entry.kind !== 'edit'));
  const visible = focus === 'auto' && pinned ? candidates.filter(entry => entry.kind !== 'edit').slice(-4) : candidates.slice(-5);
  const keys = new Set(visible.map(entry => entry.key));
  return { pinned, visible, earlier: candidates.filter(entry => !keys.has(entry.key)) };
}

/** A concrete interaction belongs to one observed document, never a guessed warning. */
export function observeBrowserInteraction(value, tabId) {
  if (!value || value.tabId !== tabId || !['javascript_dialog', 'file_chooser', 'http_auth'].includes(value.kind) || !['pending', 'blocked'].includes(value.status)) return null;
  if (value.kind === 'http_auth' && value.status !== 'blocked') return null;
  for (const [key, limit] of [['id', 256], ['documentId', 256], ['url', 20000]]) if (typeof value[key] !== 'string' || !value[key] || value[key].length > limit) return null;
  if (value.kind === 'javascript_dialog' && !['alert', 'confirm', 'prompt', 'beforeunload'].includes(value.dialogType)) return null;
  return { id: value.id, kind: value.kind, tabId, documentId: value.documentId, url: value.url, status: value.status, message: String(value.message || '').slice(0, 4096),
    ...(value.kind === 'javascript_dialog' ? { dialogType: value.dialogType, defaultPrompt: typeof value.defaultPrompt === 'string' ? value.defaultPrompt.slice(0, 4096) : '' } : {}),
    ...(value.kind === 'file_chooser' ? { multiple: value.multiple === true } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason.slice(0, 600) } : {}) };
}

/** Only the application's hidden Chromium pages belong to this work surface. */
export function observeBrowserModel(status = {}, selectedId = null) {
  const available = status.available === true && status.browsers?.relay?.available === true;
  const ids = new Set(), duplicates = new Set();
  const candidates = (Array.isArray(status.tabs) ? status.tabs : []).filter(tab => tab?.browser === 'relay' && tab.visible === false && typeof tab.tabId === 'string' && tab.tabId.length > 0 && tab.tabId.length <= 200);
  for (const tab of candidates) { if (ids.has(tab.tabId)) duplicates.add(tab.tabId); ids.add(tab.tabId); }
  const tabs = candidates.filter(tab => !duplicates.has(tab.tabId)).map(tab => ({ tabId: tab.tabId, title: String(tab.title || 'Untitled page').slice(0, 300), url: String(tab.url || '').slice(0, 20000), loading: tab.loading === true, pendingInteraction: observeBrowserInteraction(tab.pendingInteraction, tab.tabId), protection: tab.protection && typeof tab.protection === 'object' ? { available: tab.protection.available === true, enabled: tab.protection.enabled === true, siteExempt: tab.protection.siteExempt === true, origin: typeof tab.protection.origin === 'string' ? tab.protection.origin.slice(0, 4096) : null, blockedRequests: Number.isSafeInteger(tab.protection.blockedRequests) && tab.protection.blockedRequests >= 0 ? tab.protection.blockedRequests : 0 } : null }));
  const selected = tabs.find(tab => tab.tabId === selectedId) || (!selectedId ? tabs.find(tab => tab.tabId === status.activeTab) || tabs[0] : null) || null;
  const blocked = status.recovery?.required === true || status.acceptingActions === false;
  return { available, tabs, selected, blocked, busy: status.busy === true, reason: blocked ? String(status.recovery?.message || 'The contained browser is not accepting actions. Inspect its last result before continuing.').slice(0, 500) : !available ? 'The contained browser is available in the BLACKICE desktop app.' : selectedId && !selected ? 'That page is no longer a hidden BLACKICE tab. Choose another page or open a new one.' : '' };
}

/** Keep a human-selected page pinned; a closed page falls to its nearest surviving neighbour. */
export function observeBrowserNeighbor(previous = [], current = [], selectedId = null) {
  const ids = new Set(current.map(tab => tab.tabId));
  if (selectedId && ids.has(selectedId)) return selectedId;
  const index = previous.findIndex(tab => tab.tabId === selectedId);
  if (index >= 0) {
    for (let next = index + 1; next < previous.length; next++) if (ids.has(previous[next].tabId)) return previous[next].tabId;
    for (let next = index - 1; next >= 0; next--) if (ids.has(previous[next].tabId)) return previous[next].tabId;
  }
  return current[0]?.tabId || null;
}

export function observeBrowserTabKey(tabs = [], selectedId, key) {
  if (!tabs.length) return null;
  const index = Math.max(0, tabs.findIndex(tab => tab.tabId === selectedId));
  if (key === 'Home') return tabs[0].tabId;
  if (key === 'End') return tabs.at(-1).tabId;
  if (key === 'ArrowRight') return tabs[(index + 1) % tabs.length].tabId;
  if (key === 'ArrowLeft') return tabs[(index - 1 + tabs.length) % tabs.length].tabId;
  return null;
}

export function observeBrowserFrame(value, tabId) {
  if (value?.tabId !== tabId || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width > 8192 || value.height > 8192 || typeof value.imageUrl !== 'string' || value.imageUrl.length > 16 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.imageUrl)) return null;
  return { tabId, width: value.width, height: value.height, imageUrl: value.imageUrl, url: String(value.url || '').slice(0, 20000),
    ...(typeof value.documentId === 'string' && value.documentId.length > 0 && value.documentId.length <= 256 ? { documentId: value.documentId } : {}) };
}

export function observeBrowserDocument(value, tabId) {
  if (value?.tabId !== tabId || !Array.isArray(value.frames)) return null;
  const controls = [], seen = new Set(); let remaining = 24000;
  const frames = value.frames.slice(0, 30).map(frame => {
    for (const item of (Array.isArray(frame?.elements) ? frame.elements : [])) {
      if (controls.length >= 200 || typeof item?.ref !== 'string' || !item.ref || item.ref.length > 500 || seen.has(item.ref) || item.disabled === true) continue;
      seen.add(item.ref); controls.push({ ref: item.ref, name: String(item.name || item.role || 'Page control').slice(0, 300), role: String(item.role || '').slice(0, 40), type: String(item.type || '').slice(0, 40), ...(Array.isArray(item.options) ? { options: item.options.slice(0, 80).map(option => ({ value: String(option.value ?? '').slice(0, 1000), label: String(option.label || option.value || '').slice(0, 300) })) } : {}) });
    }
    const text = String(frame?.text || '').slice(0, remaining); remaining -= text.length; return text;
  });
  return { tabId, controls, text: frames.filter(Boolean).join('\n\n'),
    ...(typeof value.documentId === 'string' && value.documentId.length > 0 && value.documentId.length <= 256 ? { documentId: value.documentId } : {}) };
}

export function observeBrowserPoint(frame, point, bounds) {
  if (!frame || !bounds || ![bounds.left, bounds.top, bounds.width, bounds.height, point?.clientX, point?.clientY].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
  const x = (point.clientX - bounds.left) / bounds.width * frame.width, y = (point.clientY - bounds.top) / bounds.height * frame.height;
  return x >= 0 && y >= 0 && x < frame.width && y < frame.height ? { x: Math.floor(x), y: Math.floor(y) } : null;
}
