import {renderMarkdown} from './editor-model.mjs';
import {buildWorkflowMapModel,renderWorkflowMap,handleWorkflowMapAction,readWorkflowMapView,restoreWorkflowMapView} from './workflow-map.mjs';
import { createObserveSelection, createObserveFeed, observeLiveEntries, observeExternalActions, observePlan, observeBrowserModel, observeBrowserNeighbor, observeBrowserTabKey, observeBrowserFrame, observeBrowserDocument, observeBrowserPoint, observeBrowserInteraction } from './observe-model.mjs';
import { safeSvgPreview, SVG_PREVIEW_LIMIT } from './svg-preview.mjs';
import { initApplicationSessionUI, installApplicationSessionStyles } from './application-session-ui.mjs';
import { isSettlingRun } from './conversation-model.mjs';
import {browserTreeModel,browserFolderDOMId,browserCapacityLabel,browserPersistenceMessage,browserSuspensionOutcome} from './browser-tree-model.mjs';
import { normalizeBrowserAddress } from './browser-address.mjs';
const escapeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const svgPaths = { eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>', agent: '<rect x="4" y="6" width="16" height="14" rx="4"/><path d="M12 2v4M8 12h.01M16 12h.01M9 16h6"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', desktop: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>', grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', plan: '<path d="M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01"/>', terminal: '<path d="m4 7 5 5-5 5m8 0h8"/>', tool: '<path d="m14 6 4 4M3 21l8-8m-1-8a6 6 0 0 0 9 8l-5-5 1-4a6 6 0 0 0-5 1Z"/>', file: '<path d="M14 2H6v20h14V8Zm0 0v6h6M8 13h8m-8 4h6"/>', folder: '<path d="M3 6h7l2 2h9v12H3Z"/>', search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>', stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>', message: '<path d="M4 4h16v12H9l-5 4Z"/>' };
const svg = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgPaths[name] || svgPaths.tool}</svg>`;
export const observeDuration = value => value == null ? '—' : value < 1000 ? '< 1s' : value < 60000 ? `${Math.floor(value / 1000)}s` : value < 3600000 ? `${Math.floor(value / 60000)}m ${Math.floor(value % 60000 / 1000)}s` : `${Math.floor(value / 3600000)}h ${Math.floor(value % 3600000 / 60000)}m`;
const statusLabel = value => ({ queued: 'Queued', running: 'Working', waiting: 'Waiting', completed: 'Complete', failed: 'Failed', cancelled: 'Stopped', interrupted:'Interrupted', skipped: 'Skipped', requested: 'Requested', recorded: 'Recorded' }[value] || 'Unknown');
const settledStatusLabel = item => item.status === 'cancelled' ? item.settled === true ? 'Stopped' : item.settled === false ? 'Stopping…' : 'Stop requested' : statusLabel(item.status);
export function renderObserveAgents(agents, { escape = escapeText, icon = svg } = {}) {
  return agents.map(agent => `<article class="observe-agent ${escape(agent.status)}" data-observe-agent="${escape(agent.id)}"><div class="observe-agent-heading"><span class="observe-agent-icon">${icon('agent', 18)}</span><h3>${escape(agent.name)}</h3><span class="observe-state"><i></i>${settledStatusLabel(agent)}</span></div><div class="observe-agent-meta"><span title="${escape(agent.model)}">${escape(agent.model)}</span><span>${icon('clock', 12)}<time data-observe-duration="${escape(agent.id)}">${observeDuration(agent.elapsedMs)}</time></span></div><p class="observe-agent-activity${agent.activity ? '' : ' muted'}">${escape(agent.activity || 'No activity recorded yet.')}</p></article>`).join('');
}
export function renderObserveTrace(trace, { escape = escapeText, icon = svg, agentNames = {} } = {}) {
  return trace.map(row => `<li class="observe-event ${escape(row.status)}"><span class="observe-event-icon">${icon(row.icon, 14)}</span><div class="observe-event-copy"><strong>${escape(row.title)}</strong>${row.detail ? `<span>${escape(row.detail)}</span>` : ''}<small>${escape(agentNames[row.nodeId] || '')}</small></div><div class="observe-event-meta"><span>${statusLabel(row.status)}</span><time>${Number.isFinite(Date.parse(row.at)) ? escape(new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })) : '—'}</time></div></li>`).join('');
}
export function installObserveStyles() { if (typeof document === 'undefined' || document.getElementById('relay-observe-styles')) return; const link = document.createElement('link'); link.id = 'relay-observe-styles'; link.rel = 'stylesheet'; link.href = '/observe.css'; document.head.append(link); }
const clock = at => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
export function renderObserveDiff(entry, { escape = escapeText, icon = svg } = {}) {
  const diff = entry.diff, title = ({ created: 'Created', modified: 'Updated', deleted: 'Deleted' }[entry.change] || 'Changed');
  const omission = ({ 'binary-file': 'Binary file; content is not displayed.', 'large-file': 'Large file; content exceeds the live preview limit.', 'baseline-limit': 'Content exceeds the workspace baseline limit.', 'sensitive-file': 'Sensitive file; content is not displayed.' }[entry.contentOmitted] || 'File metadata changed.');
  const image = entry.source === 'filesystem' && !entry.contentOmitted && diff && !diff.truncated && entry.bytes?.after <= SVG_PREVIEW_LIMIT && ['created', 'modified'].includes(entry.change) && /\.svg$/i.test(entry.path) && entry.preview?.type === 'svg' ? safeSvgPreview(entry.preview.text) : null;
  const source = diff?.hunks?.length ? `<div class="observe-diff" data-observe-live-control="${escape(entry.key+':diff')}" role="region" aria-label="Observed changes to ${escape(entry.path)}" tabindex="0">${diff.hunks.map(hunk => `<div class="observe-diff-hunk">@@ ${Number(hunk.oldStart) || 1} → ${Number(hunk.newStart) || 1} @@</div>${hunk.lines.map(line => `<div class="observe-diff-line ${['add', 'remove', 'context'].includes(line.kind) ? line.kind : 'context'}"><span class="observe-line-number">${line.oldLine == null ? '' : Number(line.oldLine)}</span><span class="observe-line-number">${line.newLine == null ? '' : Number(line.newLine)}</span><span class="observe-line-sign">${line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span><code>${escape(line.text)}</code></div>`).join('')}`).join('')}</div>` : `<p class="observe-edit-note">${diff ? 'File bytes changed; no text line changes.' : escape(omission)}</p>`;
  const content = image ? `<figure class="observe-svg-preview"><img src="${escape(image)}" alt="Live preview of ${escape(entry.path)}" decoding="async" referrerpolicy="no-referrer"></figure><details class="observe-source-changes" data-observe-source="${escape(entry.key)}"><summary data-observe-live-control="${escape(entry.key+':source')}">Source changes</summary>${source}</details>` : source;
  return `<article class="observe-edit" data-observe-entry="${escape(entry.key)}"><header><div class="observe-edit-path">${icon('file', 16)}<strong>${escape(entry.path)}</strong></div><span>${title}</span>${diff ? `<span class="observe-diff-count"><b>+${Number(diff.added) || 0}</b><b>−${Number(diff.removed) || 0}</b></span>` : ''}<time>${escape(clock(entry.at))}</time></header>${content}<footer><span>Observed on disk</span>${diff?.truncated ? '<span>Preview shortened</span>' : ''}</footer></article>`;
}
export function renderObserveCommand(entry, { escape = escapeText, open = false } = {}) {
  const command = entry.command;
  if (!command) return '';
  const result = command.timedOut ? 'Timed out' : Number.isInteger(command.exitCode) ? `Exit ${command.exitCode}` : command.error ? 'Failed' : entry.status === 'cancelled' ? 'Interrupted' : command.finished ? 'Result received' : 'Running';
  const output = command.stdout || command.stderr || command.error;
  return `<div class="observe-command">${command.line ? `<pre class="observe-command-line"><code>${escape(command.line)}</code></pre>` : '<p>Command text was not included in this receipt.</p>'}${command.cwd ? `<p class="observe-command-folder"><span>Folder</span><code>${escape(command.cwd)}</code></p>` : ''}${command.finished || output ? `<details class="observe-command-output" data-observe-output="${escape(entry.key)}"${open ? ' open' : ''}><summary data-observe-live-control="${escape(entry.key+':output')}">Command output · ${escape(result)}</summary>${command.stdout ? `<div><strong>${command.combinedOutput ? 'Output' : 'Standard output'}</strong><pre>${escape(command.stdout)}</pre></div>` : ''}${command.stderr ? `<div><strong>Standard error</strong><pre>${escape(command.stderr)}</pre></div>` : ''}${command.error ? `<div class="observe-command-error"><strong>Error</strong><pre>${escape(command.error)}</pre></div>` : ''}${!output ? '<p>No output was captured.</p>' : ''}${command.truncated ? '<p class="observe-command-note">Output preview shortened.</p>' : ''}</details>` : '<p class="observe-command-note">Output appears when the command finishes.</p>'}</div>`;
}
export function renderObserveFeed(entries, { escape = escapeText, icon = svg, agentNames = {}, openOutputs = new Set() } = {}) {
  return entries.map(entry => entry.kind === 'edit' ? renderObserveDiff(entry, { escape, icon }) : `<article data-observe-entry="${escape(entry.key)}" class="observe-update ${entry.kind === 'message' ? 'message' : entry.command ? `command ${escape(entry.status)}` : ''}"><div class="observe-update-heading"><strong>${escape(agentNames[entry.nodeId] || (entry.kind === 'message' ? 'Agent' : entry.title))}</strong><span>${entry.kind === 'message' ? entry.streaming ? 'Writing' : 'Update' : statusLabel(entry.status)}</span><time>${escape(clock(entry.at))}</time></div>${entry.kind === 'message' ? `<div class="observe-message-body">${renderMarkdown(entry.text)}</div>` : entry.command ? renderObserveCommand(entry, { escape, open: openOutputs.has(entry.key) }) : `<p><strong>${escape(entry.title)}</strong>${entry.detail ? ` · ${escape(entry.detail)}` : ''}</p>`}</article>`).join('');
}
export function renderObservePlan(model,{escape=escapeText,openSteps=new Set()}={}){
  const labels={pending:'Not started',active:'Current',blocked:'Blocked',done:'Marked complete',unknown:'Unknown status'},markers={pending:'·',active:'›',blocked:'!',done:'✓',unknown:'?'};
  return model.steps.map(step=>{
    const proof=Boolean(step.doneWhen||step.evidence||step.note),detail=proof?`<details class="observe-step-proof" data-observe-plan-step="${escape(step.id)}"${openSteps.has(step.id)?' open':''}><summary data-observe-plan-control="${escape(step.id)}">Criteria &amp; evidence</summary><dl>${step.doneWhen?`<div><dt>Done when</dt><dd>${escape(step.doneWhen)}</dd></div>`:''}${step.evidence?`<div><dt>Saved evidence</dt><dd>${escape(step.evidence)}</dd></div>`:''}${step.note?`<div><dt>Note</dt><dd>${escape(step.note)}</dd></div>`:''}</dl></details>`:'';
    return `<li class="${step.status}" data-observe-saved-step="${escape(step.id)}"><span class="observe-step-marker" aria-hidden="true">${markers[step.status]}</span><div class="observe-step-copy"><div class="observe-step-heading"><strong>${escape(step.title)}</strong><span>${labels[step.status]}</span></div>${step.status==='blocked'?`<p class="observe-step-blocker">${escape(step.blockedReason||'No blocker reason was saved. Inspect the conversation for context.')}</p>`:''}${detail}</div></li>`;
  }).join('');
}
export function renderObserveExternalActions(model,{escape=escapeText,openReceipts=new Set(),canOpenConversation=false}={}){
  if(!model.receipts.length&&!model.recoveryRequired)return '';
  const prepared=model.receipts.filter(item=>item.status==='prepared').length,counts=[model.needsInspection?`${model.needsInspection} need inspection`:null,model.confirmed?`${model.confirmed} confirmed`:null,prepared?`${prepared} prepared`:null].filter(Boolean).join(' · ')||'Inspection required';
  return `<header class="observe-external-heading"><div><h2>External actions</h2><p>Saved task receipts · shared across turns</p></div><span>${escape(counts)}</span></header>${model.recoveryRequired?`<div class="observe-external-recovery"><strong>Recovered task state</strong><p>${escape(model.recoveryNote||'Newer outcomes may be missing. Inspect and reconcile the destination before another send.')}</p></div>`:''}<div class="observe-external-list">${model.receipts.map(receipt=>{
    const guidance=receipt.status==='uncertain'?'A send may already have succeeded. Inspect the destination before retrying.':receipt.status==='confirmed'?receipt.url?'This result is recorded as confirmed. Continue remaining work without sending it again.':'Confirmation has no usable result link. Inspect the saved destination.':receipt.status==='prepared'?receipt.reconciled?'The previous outcome was checked as absent. No new attempt is recorded.':'No send attempt is recorded for this prepared action.':'The saved outcome is not recognized. Inspect the destination before retrying.';
    const attempts=receipt.attempts===null?'Attempt count unavailable':`${receipt.attempts} saved ${receipt.attempts===1?'attempt':'attempts'}${receipt.attemptsMayBeIncomplete?' · count may be incomplete':''}`;
    const link=(url,label,kind)=>url?`<a href="${escape(url)}" title="${escape(url)}" target="_blank" rel="noopener noreferrer" data-observe-receipt-control="${escape(receipt.id+':'+kind)}">${label} · ${escape(new URL(url).hostname)} ↗</a>`:'';
    return `<article class="observe-external-receipt ${receipt.needsInspection?'needs-inspection':escape(receipt.status)}" data-observe-external="${escape(receipt.id)}"><div class="observe-external-status"><strong>${escape(receipt.label)}</strong><span>${escape(attempts)}</span></div><p class="observe-external-guidance">${escape(guidance)}</p>${receipt.contentExcerpt?`<p class="observe-external-excerpt">${escape(receipt.contentExcerpt)}</p>`:''}<div class="observe-external-links">${link(receipt.url,'Open confirmed result','result')}${link(receipt.destination,receipt.needsInspection?'Inspect destination':'View destination','destination')}${canOpenConversation&&receipt.sourceRunId?`<button type="button" class="button" data-observe-action="receipt-conversation" data-receipt-id="${escape(receipt.id)}" data-observe-receipt-control="${escape(receipt.id+':conversation')}">View receipt conversation</button>`:''}</div><details class="observe-external-evidence" data-observe-receipt="${escape(receipt.id)}"${openReceipts.has(receipt.id)?' open':''}><summary data-observe-receipt-control="${escape(receipt.id+':evidence')}">Saved evidence</summary><dl><div><dt>Receipt</dt><dd>${escape(receipt.id)}</dd></div>${receipt.recordedAt?`<div><dt>Recorded</dt><dd><time datetime="${escape(receipt.recordedAt)}">${escape(new Date(receipt.recordedAt).toLocaleString())}</time></dd></div>`:''}${receipt.evidence?`<div><dt>Confirmation evidence</dt><dd>${escape(receipt.evidence)}</dd></div>`:''}${receipt.absenceEvidence?`<div><dt>Observed absence</dt><dd>${escape(receipt.absenceEvidence)}</dd></div>`:''}${!receipt.evidence&&!receipt.absenceEvidence?'<div><dt>Outcome evidence</dt><dd>No confirmation or absence evidence is recorded.</dd></div>':''}${receipt.attachmentSha256?`<div><dt>Attachment SHA-256</dt><dd><code>${escape(receipt.attachmentSha256)}</code></dd></div>`:''}</dl></details></article>`;
  }).join('')}</div><p class="observe-external-note">Receipts are agent reports. Open the result or destination to check the website itself.</p>`;
}
const browserTabDOMId = id => 'observe-contained-tab-' + Array.from(id, char => char.codePointAt(0).toString(16)).join('-');
export function renderObserveBrowserTree(state,{escape=escapeText}={}){
 if(!Array.isArray(state.status?.folders))return '';
 const view=observeBrowserModel(state.status,state.selectedId),pages=new Map(view.tabs.map(tab=>[tab.tabId,tab]));
 const tree=browserTreeModel({...state.status,tabs:(state.status.tabs||[]).filter(tab=>pages.has(tab.tabId)).map(tab=>({...tab,title:pages.get(tab.tabId).title}))});
 const selected=view.selected?.tabId,locked=state.busy&&!['refresh','inspect'].includes(state.action),closed=state.busy||state.protectionBusy||!view.available||view.blocked;
 const branch=nodes=>`<ul class="observe-browser-tree-branch">${nodes.map(tab=>`<li><div class="observe-browser-tree-page${tab.tabId===selected?' selected':''}"><button type="button" data-observe-browser="tree-tab" data-tab-id="${escape(tab.tabId)}"${tab.tabId===selected?' aria-current="page"':''} title="${escape(browserDisplayURL(tab.url))}"${locked?' disabled':''}><span>${escape(tab.title)}</span>${tab.suspended?'<small>Saved</small>':''}</button>${tab.suspended?'':`<button type="button" class="observe-browser-tree-suspend" data-observe-browser="tree-suspend" data-tab-id="${escape(tab.tabId)}" aria-label="Suspend ${escape(tab.title)}" title="Release this page’s memory and keep it in its folder"${closed?' disabled':''}>Suspend</button>`}<button type="button" class="observe-browser-tree-close" data-observe-browser="tree-close" data-tab-id="${escape(tab.tabId)}" aria-label="Close ${escape(tab.title)}"${closed?' disabled':''}>×</button></div>${tab.children.length?branch(tab.children):''}</li>`).join('')}</ul>`;
 const capacity=browserCapacityLabel(state.status),folderState=state.folderState||new Map(),persistence=browserPersistenceMessage(state.status);
 const groups=tree.folders.map((folder,index)=>{const key=folder.id??'',selectedHere=state.status.tabs?.some(tab=>tab.tabId===selected&&tab.folderId===folder.id),open=folderState.has(key)?folderState.get(key):selectedHere||index===0;return `<details class="observe-browser-folder" data-observe-folder="${escape(key)}"${open?' open':''}><summary id="${browserFolderDOMId(key,'observe-folder')}"><span>${escape(folder.name)}</span>${folder.kind==='task'?'<small>Task</small>':''}<span class="observe-browser-folder-count">${folder.live} live · ${folder.saved} saved</span></summary>${folder.count?branch(folder.roots):'<p>No pages in this folder.</p>'}</details>`;}).join('');
 return `${persistence?`<p class="observe-browser-save-error" role="alert">${escape(persistence)}</p>`:''}<details id="observe-browser-tree" class="observe-browser-tree"${state.treeOpen!==false?' open':''}><summary id="observe-browser-tree-toggle"><strong>Folders &amp; pages</strong>${capacity?`<span>${escape(capacity)}</span>`:''}</summary><div class="observe-browser-tree-content">${groups||'<p>No saved pages yet.</p>'}</div></details>`;
}
export function renderObserveBrowserTabs(state, { escape = escapeText } = {}) {
  const model = observeBrowserModel(state.status, state.selectedId), locked = state.busy && !['refresh', 'inspect'].includes(state.action), unavailable = !model.available || model.blocked;
  return `<div class="observe-browser-tabbar"><div id="observe-browser-tabs" role="tablist" aria-label="Contained browser tabs">${model.tabs.map(tab => `<div class="observe-browser-tab-item${model.selected?.tabId === tab.tabId ? ' selected' : ''}" role="presentation"><button type="button" id="${browserTabDOMId(tab.tabId)}" class="observe-browser-tab" role="tab" data-observe-browser="tab" data-tab-id="${escape(tab.tabId)}" aria-controls="observe-browser-page" aria-selected="${model.selected?.tabId === tab.tabId}" tabindex="${model.selected?.tabId === tab.tabId ? '0' : '-1'}" aria-label="${escape(tab.title)}${tab.loading ? ' · Loading' : ''}" title="${escape(tab.title + (tab.url ? '\n' + browserDisplayURL(tab.url) : ''))}"${locked ? ' disabled' : ''}><span class="observe-browser-tab-marker${tab.loading ? ' loading' : ''}" aria-hidden="true">${tab.loading ? '◌' : '·'}</span><span class="observe-browser-tab-title">${escape(tab.title)}</span></button><button type="button" class="observe-browser-tab-close" data-observe-browser="close" data-tab-id="${escape(tab.tabId)}" aria-label="Close ${escape(tab.title)}" title="Close tab" tabindex="${model.selected?.tabId === tab.tabId ? '0' : '-1'}"${state.busy || unavailable ? ' disabled' : ''}>×</button></div>`).join('')}${!model.tabs.length ? '<span class="observe-browser-no-tabs">No open pages</span>' : ''}</div><button type="button" class="button observe-browser-new-tab" data-observe-browser="new" title="Open the address below in a new tab"${state.busy || unavailable ? ' disabled' : ''}><span aria-hidden="true">＋</span> New tab</button></div>`;
}
export function renderObserveProtection(state, { escape = escapeText } = {}) {
  const global = state.status?.protection || {}, selected = observeBrowserModel(state.status, state.selectedId).selected, site = selected?.protection || {};
  const busy = state.protectionBusy || state.busy, available = global.available === true, enabled = global.enabled === true, ready = global.ready === true;
  let origin = null; try { const value = new URL(site.origin); if (['https:', 'http:'].includes(value.protocol) && value.origin === site.origin) origin = value.origin; } catch {}
  const siteReady = available && enabled && ready && site.available === true && origin;
  const summary = !available ? 'Unavailable' : !enabled ? 'Off' : !ready ? 'Starting' : site.siteExempt ? 'Off for this site' : site.enabled ? 'Blocking' : selected ? 'Waiting for page' : 'On';
  const blocked = Number.isSafeInteger(site.blockedRequests) && site.blockedRequests >= 0 ? site.blockedRequests : null;
  const button = (action, label, disabled, more = '') => `<button type="button" class="button" data-observe-browser="${action}"${disabled ? ' disabled' : ''}${more}>${label}</button>`;
  return `<div id="observe-browser-protection" class="observe-browser-protection"><div class="observe-browser-protection-row"><span id="observe-browser-protection-status" role="status" aria-live="polite">Ads &amp; trackers · <strong>${escape(summary)}</strong>${blocked !== null && site.enabled ? ` <small>· ${blocked} blocked</small>` : ''}</span>${selected ? button('protection-site', site.siteExempt ? 'Block on this site' : 'Allow on this site', busy || !siteReady, ` id="observe-browser-site-protection" aria-pressed="${site.enabled === true}" title="${escape(origin ? `Only ${origin}` : 'Available after an HTTP or HTTPS page loads')}"`) : ''}<details id="observe-browser-protection-settings"${state.protectionOpen ? ' open' : ''}><summary>Protection settings</summary><div class="observe-browser-protection-settings"><p>Ads and trackers are blocked inside this browser. Allow a site here if its page needs an exception.</p><div class="observe-browser-protection-actions">${button('protection-global', enabled ? 'Turn protection off' : 'Turn protection on', busy || !available, ' id="observe-browser-global-protection"')}${button('protection-refresh', global.refreshing ? 'Updating rules…' : 'Update filter rules', busy || !available || global.refreshing, ' id="observe-browser-refresh-protection"')}</div><p class="observe-browser-protection-meta">${escape(global.engine || 'Browser protection')}${Number.isSafeInteger(global.filterCount) ? ` · ${global.filterCount.toLocaleString()} filters` : ''}${global.updatedAt ? ` · Updated ${escape(String(global.updatedAt).slice(0, 10))}` : ''}</p>${global.error ? `<p class="observe-browser-protection-error" role="alert">${escape(String(global.error).slice(0, 600))}</p>` : ''}</div></details></div><p class="observe-browser-protection-message${state.protectionError ? ' error' : ''}" role="status" aria-live="polite">${escape(state.protectionBusy ? 'Updating browser protection…' : state.protectionError || state.protectionNotice || '')}</p></div>`;
}

const browserDisplayURL = value => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return 'Contained page';
    const label = url.origin + (url.pathname === '/' ? '' : url.pathname);
    return label.length > 120 ? label.slice(0, 119) + '…' : label;
  } catch { return 'Contained page'; }
};
const browserInputHint = active => active
  ? 'Typing goes to this page · Tab moves between fields · Escape releases the keyboard'
  : 'Click a field below and type · You can also paste';
const sameBrowserInputFrame = (left, right) => left === right || Boolean(left?.documentId && right?.documentId && ['tabId', 'url', 'documentId', 'width', 'height'].every(key => left[key] === right[key]));

export function renderObserveBrowserInteraction(state, { escape = escapeText } = {}) {
  const model = observeBrowserModel(state.status, state.selectedId), interaction = model.selected?.pendingInteraction;
  if (!interaction) return '';
  const blocked = interaction.status === 'blocked', files = interaction.kind === 'file_chooser', prompt = !blocked && interaction.dialogType === 'prompt';
  const disabled = state.busy || state.protectionBusy || state.pickingFiles || !model.available || model.blocked;
  const button = (decision, label, off = disabled) => `<button type="button" class="button" data-observe-browser="interaction" data-interaction-id="${escape(interaction.id)}" data-decision="${decision}"${off ? ' disabled' : ''}>${label}</button>`;
  const title = blocked ? 'Page action needs attention' : files ? 'Choose files for this page' : 'This page opened a dialog';
  const detail = blocked ? 'The browser could not keep this request open. Acknowledging it clears this notice; it does not repeat the page action.' : files ? 'Only files you choose will be sent to this page.' : 'Choose how to answer the page before continuing.';
  const controls = blocked ? button('acknowledge', 'Acknowledge') : files ? button('upload', interaction.multiple ? 'Choose files…' : 'Choose a file…', disabled || !state.canPickBrowserFiles) + button('dismiss', 'Cancel upload') : button('accept', interaction.dialogType === 'alert' ? 'OK' : 'Accept') + button('dismiss', 'Dismiss');
  return `<section id="observe-browser-interaction" class="observe-browser-interaction" aria-labelledby="observe-browser-interaction-title"><h3 id="observe-browser-interaction-title">${title}</h3><p>${escape(interaction.message || detail)}</p>${interaction.message ? `<p class="observe-browser-interaction-help">${escape(detail)}</p>` : ''}${blocked && interaction.reason ? `<p class="observe-browser-interaction-help">${escape(interaction.reason)}</p>` : ''}${prompt ? `<label for="observe-browser-dialog-text">Response to the page</label><input id="observe-browser-dialog-text" type="text" autocomplete="off" maxlength="4096" data-interaction-id="${escape(interaction.id)}" value="${escape(state.interactionDraft || '')}"${disabled ? ' disabled' : ''}>` : ''}${files && !blocked && !state.canPickBrowserFiles ? '<p class="observe-browser-interaction-help">Choose files from the BLACKICE desktop app.</p>' : ''}<div class="observe-browser-interaction-actions">${controls}</div>${state.interactionError ? `<p class="observe-browser-interaction-error" role="alert">${escape(state.interactionError)}</p>` : ''}</section>`;
}

export function renderObserveBrowser(state, { escape = escapeText } = {}) {
  const model = observeBrowserModel(state.status, state.selectedId), reading = state.busy && ['refresh', 'inspect'].includes(state.action);
  const disabled = state.busy || state.protectionBusy || !model.available || model.blocked, pageDisabled = disabled || !model.selected || Boolean(model.selected.pendingInteraction);
  const pointerDisabled = state.protectionBusy || state.busy && !reading || !model.available || model.blocked || !model.selected || Boolean(model.selected.pendingInteraction) || state.stale;
  const frame = state.frame, control = state.document?.controls.find(item => item.ref === state.ref), fields = control?.options, writable = control?.role === 'textbox' || ['text','password','email','search','url','number','tel'].includes(control?.type), suspended=state.status?.tabs?.find(tab=>tab.tabId===model.selected?.tabId)?.suspended===true;
  const button = (action, label, off = pageDisabled || (state.stale || state.controlsStale) && ['key','fill','control'].includes(action)) => `<button type="button" class="button" data-observe-browser="${action}"${off ? ' disabled' : ''}>${label}</button>`;
  const heading = `<header class="observe-browser-heading"><div><h2>${state.focusPage ? state.chatGPTConversation ? 'ChatGPT in BLACKICE' : 'Website sign-in' : 'Contained browser'}</h2><p>${state.focusPage ? state.chatGPTConversation ? 'Use your ChatGPT conversation here. Manage BLACKICE tool access in Connection settings.' : 'Sign in on the page below. Your session stays in BLACKICE.' : 'Websites stay inside BLACKICE · separate saved sign-ins'}</p></div><div class="observe-browser-heading-actions">${state.focusPage ? (state.chatGPTConversation && state.canOpenConnectionSettings ? button('connection-settings', 'Connection settings', false) : '') + button('back', 'Back') + button('refresh', 'Refresh', state.busy) : button('watch', state.watching ? 'Pause preview' : 'Resume preview', state.busy)}</div></header>`;
  const tools = `${renderObserveBrowserTree(state,{escape})}${renderObserveBrowserTabs(state, { escape })}<div class="observe-browser-toolbar"><button type="button" id="observe-browser-follow" class="button observe-browser-follow" data-observe-browser="follow" aria-pressed="${state.followAgent !== false}" title="Follow the page used most recently by the agent. Choosing a tab pins that page instead."${state.busy && !['refresh','inspect'].includes(state.action) ? ' disabled' : ''}>${state.followAgent !== false ? 'Following active page' : 'Follow active page'}</button>${state.focusPage ? button('watch', state.watching ? 'Pause preview' : 'Resume preview', state.busy) : button('refresh', 'Refresh view', state.busy)}${button('inspect', 'Read page controls')}${state.focusPage ? '' : button('back', 'Back')}${button('forward', 'Forward')}</div><form id="observe-browser-address-form" class="observe-browser-address"><label class="observe-sr-only" for="observe-browser-url">Website address</label><input id="observe-browser-url" type="text" inputmode="url" required placeholder="https://…" value="${escape(state.address || '')}" autocomplete="off" spellcheck="false"><button class="button" type="submit"${disabled ? ' disabled' : ''}>${model.selected ? 'Go' : 'Open page'}</button></form>${renderObserveProtection(state, { escape })}`;
  const message = state.busy ? state.pending || 'Updating page…' : state.error || model.reason || state.inputNotice || state.notice || (state.focusPage ? 'Your page is ready for input.' : state.watching ? 'Preview refreshes while Activity is visible.' : 'Preview paused. Refresh explicitly to inspect the current page.');
  const status = `<p id="observe-browser-status" class="observe-browser-status${state.error ? ' error' : ''}" role="status" aria-live="polite">${escape(message)}</p>`;
  const title = model.selected ? `<div class="observe-browser-page-title"><strong>${escape(model.selected.title)}</strong><span>${escape(browserDisplayURL(model.selected.url))}</span></div>` : '';
  const stage = `<div id="observe-browser-page" class="observe-browser-stage" role="tabpanel"${model.selected && !state.focusPage ? ` aria-labelledby="${browserTabDOMId(model.selected.tabId)}"` : ' aria-label="Contained page"'}>${frame ? `<p id="observe-browser-input-help" class="observe-browser-input-help" data-active="${state.inputActive === true}" role="status" aria-live="polite">${browserInputHint(state.inputActive)}</p><button type="button" class="observe-browser-frame" data-observe-browser="point" aria-label="Website page. Click a field and type. Press Escape to release the keyboard." aria-describedby="observe-browser-input-help"${pointerDisabled ? ' disabled' : ''}><img id="observe-browser-image" src="${escape(frame.imageUrl)}" width="${frame.width}" height="${frame.height}" alt="Captured contained browser page. Click a field to enter text." draggable="false"></button><textarea id="observe-browser-input" class="observe-browser-input" tabindex="-1" aria-label="Keyboard input for the contained page" aria-describedby="observe-browser-input-help" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true"></textarea><p class="observe-browser-stamp">${state.stale ? state.watching ? 'Earlier frame · updating automatically' : 'Earlier frame · refresh before interacting' : `Captured ${escape(clock(state.capturedAt))} · page input stays in this browser`}</p>` : `<div class="observe-browser-placeholder"><strong>${suspended ? 'Page is suspended' : model.selected ? 'Loading the page…' : 'Open a website here'}</strong><p>${suspended ? 'Refresh or select this page to load it again.' : model.selected ? 'The page will appear here when its view is ready.' : 'The agent and you can work in contained tabs without opening a desktop browser.'}</p></div>`}</div>`;
  const manual = `<div class="observe-browser-page-actions">${button('up', 'Scroll up')}${button('down', 'Scroll down')}<label class="observe-sr-only" for="observe-browser-key">Page key</label><select id="observe-browser-key"${pageDisabled ? ' disabled' : ''}>${['Enter','Tab','Escape','Backspace','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Space'].map(key => `<option${state.key === key ? ' selected' : ''}>${key}</option>`).join('')}</select>${button('key', 'Send key')}</div><details id="observe-browser-controls" class="observe-browser-controls"${state.controlsOpen ? ' open' : ''}><summary>Page controls &amp; text${state.document ? ` · ${state.document.controls.length} observed controls` : ''}</summary>${state.document ? `<label>Observed control<select id="observe-browser-ref"${pageDisabled ? ' disabled' : ''}>${state.document.controls.map(item => `<option value="${escape(item.ref)}"${state.ref === item.ref ? ' selected' : ''}>${escape(item.name)}${item.type ? ` · ${escape(item.type)}` : ''}</option>`).join('')}</select></label><div class="observe-browser-field">${fields ? `<label class="observe-sr-only" for="observe-browser-value">Option value</label><select id="observe-browser-value">${fields.map(option => `<option value="${escape(option.value)}"${state.fieldValue === option.value ? ' selected' : ''}>${escape(option.label)}</option>`).join('')}</select>` : `<label class="observe-sr-only" for="observe-browser-text">Text for selected field</label><input id="observe-browser-text" type="${control?.type === 'password' ? 'password' : 'text'}" autocomplete="off" placeholder="Text for selected field" value="${escape(state.text || '')}">`}${button('fill', fields ? 'Select option' : 'Set field', pageDisabled || state.stale || state.controlsStale || !control || !fields && !writable)}${button('control', 'Click control', pageDisabled || state.stale || state.controlsStale || !control)}</div><pre class="observe-browser-page-text" tabindex="0">${escape(state.document.text || 'No page text was returned.')}</pre>` : '<p>Read page controls to inspect current text and fill fields by their observed labels.</p>'}</details>`;
  const interaction = renderObserveBrowserInteraction(state, { escape });
  return state.focusPage
    ? `${heading}${title}${interaction}${stage}${status}<details id="observe-browser-tools" class="observe-browser-tools"${state.browserToolsOpen ? ' open' : ''}><summary>Browser tools and other tabs</summary>${tools}${manual}</details>`
    : `${heading}<p class="observe-browser-limit">Websites and their sign-ins stay in this contained browser.</p>${tools}${status}${title}${interaction}${stage}${manual}`;
}

/** A page-local work surface. It never calls native browser or window routes. */
export function initObserveBrowser({ mount, api, isVisible = () => true, now = Date.now, onFocusPageChange = () => {}, onOpenConnectionSettings, pickBrowserFiles }) {
  const $ = selector => mount.querySelector(selector), drafts = new Map();
  const state = { folderState:new Map(),treeOpen:true,status: {}, selectedId: null, displayedId: null, displayedUrl: '', followAgent: true, protectionBusy: false, protectionOpen: false, protectionError: '', protectionNotice: '', frame: null, document: null, ref: null, address: '', addressDirty: false, text: '', fieldValue: '', key: 'Enter', controlsOpen: false, controlsStale: true, watching: true, busy: false, stale: true, error: '', notice: '', inputNotice: '', nextAt: 0, progressUntil: 0, readFailures: 0, active: false, generation: 0, controller: null, mutationPending: false };
  let protectionController = null, inputSession = null, inputRefresh = null, inputRefreshDue = false, rendering = false, renderDeferred = false, renderedFrame = null, pointerGesture = null, pointerRelease = null, popupRequest = null, popupParents = [];
  state.canPickBrowserFiles = typeof pickBrowserFiles === 'function';
  state.canOpenConnectionSettings = typeof onOpenConnectionSettings === 'function';
  const visible = () => state.active && mount.isConnected !== false && isVisible();
  const model = () => observeBrowserModel(state.status, state.selectedId);
  const actionNode = (action, tabId) => [...mount.querySelectorAll('[data-observe-browser]')].find(item => item.dataset.observeBrowser === action && (!tabId || item.dataset.tabId === tabId));
  const inputMatches = session => session && state.frame?.tabId === session.tabId && state.frame.url === session.url && state.frame.documentId === session.documentId && model().selected?.tabId === session.tabId && !model().selected.pendingInteraction;
  function watchPopup(tabId, item) {
    if (item.action !== 'click' && !(item.action === 'press' && ['Enter', 'Space'].includes(item.key)) && !(item.action === 'interaction' && item.decision === 'accept')) return null;
    // Arm at dispatch, after any in-flight status read. Existing children and
    // popups belonging to another page must not take over a pinned preview.
    popupRequest = { parentId: tabId, knownIds: new Set(model().tabs.map(tab => tab.tabId)), generation: state.generation, pending: true, expiresAt: now() + 10000 };
    return popupRequest;
  }
  function settlePopup(request) {
    if (request && popupRequest === request) { request.pending = false; request.expiresAt = now() + 10000; }
  }
  function inputFeedback() {
    const help = $('#observe-browser-input-help');
    if (help) { help.textContent = browserInputHint(state.inputActive); help.setAttribute?.('data-active', String(state.inputActive === true)); }
  }
  function stopInput({ notice = '', focus = false } = {}) {
    clearTimeout(inputRefresh); inputRefresh = null; inputRefreshDue = false;
    const session = inputSession; inputSession = null; state.inputActive = false;
    if (session) { session.queue.length = 0; session.controller.abort(); }
    const input = $('#observe-browser-input'); if (input) input.value = '';
    if (notice) state.notice = notice;
    if (focus) actionNode('point')?.focus?.({ preventScroll: true });
    inputFeedback();
  }
  function captureInput() {
    if (!state.frame?.documentId || !state.frame.url || state.stale || model().selected?.pendingInteraction || !visible()) return null;
    if (inputSession && !inputMatches(inputSession)) stopInput();
    if (!inputSession) inputSession = { tabId: state.frame.tabId, url: state.frame.url, documentId: state.frame.documentId, queue: [], controller: new AbortController(), running: null, composing: false };
    state.followAgent = false; state.selectedId = inputSession.tabId; state.inputActive = true; state.inputNotice = '';
    $('#observe-browser-input')?.focus?.({ preventScroll: true });
    inputFeedback();
    return inputSession;
  }
  function refreshAfterInput(session) {
    // Keep one preview deadline while more input arrives. Resetting a trailing
    // debounce for every character leaves a continuously typed field visually
    // frozen. Captures remain serialized with page input and capped at 4 Hz.
    if (inputSession !== session || !visible()) return;
    if (inputRefreshDue) {
      if (!session.composing && !session.running && !session.queue.length && !state.busy && !state.protectionBusy) void work();
      return;
    }
    if (inputRefresh !== null) return;
    inputRefresh = setTimeout(() => {
      // A key receipt may still be in flight at this deadline. Keep the due
      // preview so its completion does not add another full 250 ms delay.
      inputRefresh = null; inputRefreshDue = true; refreshAfterInput(session);
    }, 250);
  }
  function recoverInput({ uncertain = false } = {}) {
    // Recovery is read-only. Never carry a click, submission or text across a
    // document boundary, including navigation that finishes after its receipt.
    stopInput(); state.stale = true; state.controlsStale = true; state.nextAt = 0;
    state.progressUntil = now() + 10000;
    state.inputNotice = uncertain
      ? 'Page input could not be confirmed. Some input may have reached the page. Inspect the current field before typing again.'
      : 'The page changed. Click its next field to continue.';
    render(); queueMicrotask(() => { if (visible()) void work(); });
  }
  function pumpInput() {
    const session = inputSession;
    if (!session || session.running || !session.queue.length || state.busy || state.protectionBusy || !visible()) return session?.running;
    session.running = (async () => {
      try {
        while (inputSession === session && session.queue.length && visible() && !state.busy && !state.protectionBusy) {
          if (!inputMatches(session) || state.stale) throw Error('The contained page changed before queued input could be applied.');
          const item = session.queue.shift();
          state.progressUntil = now() + 10000;
          const popup = watchPopup(session.tabId, item);
          let result;
          try { result = await api('/api/browser/action', { method: 'POST', body: { ...item, browser: 'relay', tabId: session.tabId, expectedUrl: session.url, expectedDocumentId: session.documentId }, signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(10000)]) }); }
          finally { settlePopup(popup); }
          if (inputSession !== session || !visible()) return;
          if (result?.tabId !== session.tabId) throw Error('The contained page changed while input was being applied.');
          if (observeBrowserInteraction(result.pendingInteraction, session.tabId)) {
            applyStatus({ ...state.status, tabs: state.status.tabs.map(tab => tab.tabId === session.tabId ? { ...tab, pendingInteraction: result.pendingInteraction } : tab) });
            state.nextAt = 0; render(); return;
          }
          if (result.url !== session.url || result.documentId !== session.documentId) {
            recoverInput(); return;
          }
          if (item.action === 'click') adoptDocument(result, session.tabId);
          state.controlsStale = true;
        }
      } catch (error) {
        if (inputSession === session && visible()) recoverInput({ uncertain: true });
      } finally {
        session.running = null;
        if (inputSession === session && visible()) {
          if (session.queue.length && !state.busy && !state.protectionBusy) queueMicrotask(pumpInput);
          else refreshAfterInput(session);
        }
      }
    })();
    return session.running;
  }
  function queueInput(item) {
    const session = inputSession;
    if (!session || !visible() || !inputMatches(session)) return false;
    if (item.action === 'type' && (typeof item.text !== 'string' || !item.text || item.text.length > 16384 || item.text.includes('\u0000'))) {
      stopInput({ notice: 'Paste up to 16,384 characters at a time. Click the page field to resume typing.' }); render(); return false;
    }
    const queuedChars = session.queue.reduce((sum, item) => sum + (item.text?.length || 0), 0);
    if (session.queue.length >= 128 || queuedChars + (item.text?.length || 0) > 32768) {
      stopInput({ notice: 'The page could not keep up with input. Inspect its field, then click it to resume.' }); render(); return false;
    }
    const last = session.queue.at(-1);
    if (item.action === 'type' && last?.action === 'type' && last.text.length + item.text.length <= 16384) last.text += item.text;
    else session.queue.push(item);
    void pumpInput(); return true;
  }
  function remember() {
    const address = $('#observe-browser-url'); if (address && address.value !== state.rendered?.address) { state.address = address.value; state.addressDirty = true; }
    if ($('#observe-browser-text') && $('#observe-browser-text').value !== state.rendered?.text) state.text = $('#observe-browser-text').value;
    if ($('#observe-browser-value') && $('#observe-browser-value').value !== state.rendered?.fieldValue) state.fieldValue = $('#observe-browser-value').value;
    if ($('#observe-browser-key') && $('#observe-browser-key').value !== state.rendered?.key) state.key = $('#observe-browser-key').value;
    if ($('#observe-browser-controls')) state.controlsOpen = $('#observe-browser-controls').open;
    if ($('#observe-browser-protection-settings')) state.protectionOpen = $('#observe-browser-protection-settings').open;
    if ($('#observe-browser-tools')) state.browserToolsOpen = $('#observe-browser-tools').open;
    if ($('#observe-browser-tree')) state.treeOpen = $('#observe-browser-tree').open;
    for(const folder of mount.querySelectorAll('[data-observe-folder]'))state.folderState.set(folder.dataset.observeFolder,folder.open===true);
    const prompt = $('#observe-browser-dialog-text'); if (prompt && prompt.dataset.interactionId === state.interactionId) state.interactionDraft = prompt.value;
    // Once consumed, these values belong to their current tab. A following
    // render must not read them back over a newly selected tab's restored draft.
    state.rendered = { address: address?.value ?? state.rendered?.address, text: $('#observe-browser-text')?.value ?? state.rendered?.text, fieldValue: $('#observe-browser-value')?.value ?? state.rendered?.fieldValue, key: $('#observe-browser-key')?.value ?? state.rendered?.key };
  }
  function keepDraft() {
    if (!state.displayedId) return;
    drafts.set(state.displayedId, { url: state.displayedUrl, address: state.address, addressDirty: state.addressDirty, text: state.text, fieldValue: state.fieldValue, key: state.key, ref: state.ref, document: state.document, controlsOpen: state.controlsOpen, textScroll: $('.observe-browser-page-text')?.scrollTop || 0 });
  }
  function focusSnapshot(node) { return node ? { id: node.id, action: node.dataset?.observeBrowser, tabId: node.dataset?.tabId, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection } : null; }
  function focusControl(focus) {
    if (!focus) return;
    if (focus.id === 'observe-browser-input' && !inputSession) return;
    let replacement = focus.id ? $('#' + focus.id) : actionNode(focus.action, focus.tabId);
    if(!replacement&&focus.action==='tree-suspend')replacement=actionNode('tree-tab',focus.tabId);
    if (!replacement && focus.tabId) replacement = actionNode('tab', model().selected?.tabId) || $('#observe-browser-url');
    replacement?.focus?.({ preventScroll: true });
    if (Number.isInteger(focus.start)) try { replacement?.setSelectionRange?.(focus.start, focus.end, focus.direction); } catch {}
  }
  function render() {
    // A native click spans pointerdown, pointerup and click. Even removing and
    // reinserting the same node during that interval can discard the click.
    mount.setAttribute?.('aria-busy', String(state.busy));
    if (inputSession?.composing || pointerGesture) { renderDeferred = true; return; }
    renderDeferred = false; rendering = true;
    remember();
    const doc = mount.ownerDocument || (typeof document === 'undefined' ? null : document), focused = doc?.activeElement;
    const focus = mount.contains?.(focused) ? focusSnapshot(focused) : !focused || focused === doc?.body || focused.isConnected === false ? state.protectionFocus || state.pendingFocus : null;
    const strip = $('#observe-browser-tabs'), stripScroll = strip?.scrollLeft || 0, scroll = mount.scrollTop, pageTextScroll = $('.observe-browser-page-text')?.scrollTop || 0;
    const treeScroll=$('.observe-browser-tree-content')?.scrollTop||0;
    // Keep the same native address/field nodes through preview polling. A changed
    // control type or option list is replaced, with its authored value restored.
    const fields = ['observe-browser-url', 'observe-browser-text', 'observe-browser-value', 'observe-browser-key', 'observe-browser-input', 'observe-browser-dialog-text'].map(id => $('#' + id)).filter(Boolean);
    const oldFrame = actionNode('point'), sameFrame = renderedFrame && renderedFrame === state.frame;
    const markup = renderObserveBrowser(state);
    mount.innerHTML = markup; mount.setAttribute?.('aria-busy', String(state.busy));
    mount.classList?.toggle?.('observe-browser-focused', state.focusPage === true);
    for (const old of fields) {
      const next = $('#' + old.id);
      if (!next?.replaceWith || old.tagName !== next.tagName || old.type !== next.type || old.tagName === 'SELECT' && old.innerHTML !== next.innerHTML) continue;
      if (old.id === 'observe-browser-dialog-text' && old.dataset.interactionId !== next.dataset.interactionId) continue;
      const value = next.value; old.disabled = next.disabled; if (old.id !== 'observe-browser-input' && old.value !== value) old.value = value; next.replaceWith(old);
    }
    const nextFrame = actionNode('point');
    if (sameFrame && oldFrame && nextFrame?.replaceWith) { oldFrame.disabled = nextFrame.disabled; nextFrame.replaceWith(oldFrame); }
    renderedFrame = state.frame;
    const nextStrip = $('#observe-browser-tabs');
    if (strip && nextStrip?.replaceWith && strip.innerHTML === nextStrip.innerHTML) nextStrip.replaceWith(strip);
    if ($('#observe-browser-tabs')) $('#observe-browser-tabs').scrollLeft = stripScroll;
    mount.scrollTop = scroll;
    if($('.observe-browser-tree-content'))$('.observe-browser-tree-content').scrollTop=treeScroll;
    if ($('.observe-browser-page-text')) $('.observe-browser-page-text').scrollTop = state.restoreTextScroll ?? pageTextScroll;
    state.restoreTextScroll = undefined;
    state.rendered = { address: state.address, text: state.text, fieldValue: state.fieldValue, key: state.key };
    focusControl(focus);
    rendering = false;
  }
  function revealTab(id) {
    const strip = $('#observe-browser-tabs'), tab = actionNode('tab', id); if (!strip || !tab) return;
    const area = strip.getBoundingClientRect?.(), item = tab.closest?.('.observe-browser-tab-item')?.getBoundingClientRect?.() || tab.getBoundingClientRect?.();
    if (area && item) { if (item.left < area.left) strip.scrollLeft -= area.left - item.left; else if (item.right > area.right) strip.scrollLeft += item.right - area.right; }
  }
  function applyStatus(value) {
    const previousTabs = model().tabs, previousId = model().selected?.tabId, nextTabs = observeBrowserModel(value).tabs, live = new Set(nextTabs.map(tab => tab.tabId));
    let popupParentId = null, popupReturnedFrom = null;
    if (popupRequest && (popupRequest.generation !== state.generation || popupRequest.parentId !== previousId || !popupRequest.pending && now() > popupRequest.expiresAt)) popupRequest = null;
    const children = popupRequest ? (Array.isArray(value.tabs) ? value.tabs : []).filter(tab => live.has(tab?.tabId) && tab.parentTabId === popupRequest.parentId && !popupRequest.knownIds.has(tab.tabId) && tab.suspended !== true) : [];
    const popup = children.find(tab => tab.tabId === value.activeTab) || (children.length === 1 ? children[0] : null);
    if (popup) {
      popupParentId = popupRequest.parentId; popupParents.push(popupParentId); popupRequest = null;
      state.requiredTabId = null; state.followAgent = false; state.selectedId = popup.tabId; state.revealSelected = true;
    } else if (!state.followAgent) {
      const parent = !live.has(previousId) && popupParents.findLast(id => live.has(id));
      if (parent) {
        popupReturnedFrom = previousId; popupParents = popupParents.slice(0, popupParents.lastIndexOf(parent));
        state.requiredTabId = null; state.selectedId = parent; state.revealSelected = true;
      } else state.selectedId = observeBrowserNeighbor(previousTabs, nextTabs, state.selectedId);
    }
    else state.selectedId = null;
    if (popupRequest && !live.has(popupRequest.parentId)) popupRequest = null;
    if (!live.has(previousId) && !popupParentId && !popupReturnedFrom) popupParents = [];
    const next = observeBrowserModel(value, state.selectedId), selected = next.selected;
    if (inputSession && (selected?.tabId !== inputSession.tabId || selected?.url !== inputSession.url)) stopInput({ notice: 'The page changed. Click its field to resume keyboard input.' });
    const interaction = selected?.pendingInteraction;
    if (interaction?.id !== state.interactionId) { state.interactionId = interaction?.id; state.interactionDraft = interaction?.defaultPrompt || ''; state.interactionError = ''; }
    if (interaction) { stopInput(); state.stale = true; state.controlsStale = true; }
    if (selected?.tabId !== state.displayedId) {
      state.inputNotice = '';
      const waitingAddress = !state.displayedId && state.addressDirty ? { address: state.address, addressDirty: true } : null;
      keepDraft(); const saved = drafts.get(selected?.tabId) || waitingAddress, samePage = saved?.url === selected?.url;
      Object.assign(state, { frame: null, document: samePage ? saved?.document || null : null, ref: samePage ? saved?.ref || null : null, stale: true, controlsStale: true, address: saved?.addressDirty ? saved.address : selected?.url || '', addressDirty: Boolean(saved?.addressDirty), text: samePage ? saved?.text || '' : '', fieldValue: samePage ? saved?.fieldValue || '' : '', key: saved?.key || 'Enter', controlsOpen: Boolean(saved?.controlsOpen), restoreTextScroll: saved?.textScroll || 0 });
    } else if (selected?.url !== state.displayedUrl || state.frame && state.frame.tabId !== selected?.tabId) {
      state.frame = null; state.document = null; state.ref = null; state.stale = true; state.controlsStale = true;
    }
    state.status = value; state.displayedId = selected?.tabId || null; state.displayedUrl = selected?.url || '';
    if (!state.addressDirty) state.address = selected?.url || '';
    for (const id of drafts.keys()) if (!live.has(id)) drafts.delete(id);
    return { ...next, popupParentId, popupReturnedFrom };
  }
  function adoptDocument(value, tabId) {
    const observed = observeBrowserDocument(value, tabId); if (!observed) return;
    state.document = observed; state.controlsStale = false;
    if (!observed.controls.some(item => item.ref === state.ref)) { state.ref = observed.controls[0]?.ref || null; state.fieldValue = observed.controls[0]?.options?.[0]?.value || ''; state.text = ''; }
  }
  function cancelRead() {
    if (!state.busy) return true;
    if (!['refresh', 'inspect'].includes(state.action)) return false;
    state.generation++; state.controller?.abort(); state.controller = null; state.busy = false; state.pendingFocus = null; state.stale = true; return true;
  }
  async function selectTab(id, { focus = true, follow = false } = {}) {
    if (!visible() || !cancelRead()) return;
    stopInput(); popupRequest = null; popupParents = [];
    if (state.focusPage) { state.focusPage = false; state.chatGPTConversation = false; onFocusPageChange(false); }
    remember(); if (id && !model().tabs.some(tab => tab.tabId === id)) return;
    state.requiredTabId = null; state.followAgent = follow; state.selectedId = follow ? null : id;
    applyStatus(state.status); state.error = ''; state.nextAt = 0; render();
    if (focus) { actionNode('tab', model().selected?.tabId)?.focus?.({ preventScroll: true }); revealTab(model().selected?.tabId); }
    await work();
  }
  async function work(action = 'refresh', extra = {}) {
    if (!visible() || state.busy || state.protectionBusy || inputSession?.running || inputSession?.queue.length) return; remember();
    if (action === 'refresh') { clearTimeout(inputRefresh); inputRefresh = null; inputRefreshDue = false; }
    const origin = typeof document === 'undefined' ? null : document.activeElement;
    state.pendingFocus = mount.contains?.(origin) ? focusSnapshot(origin) : null;
    const initial = model().selected?.tabId, explicitTarget = extra.tabId || (action === 'refresh' ? state.requiredTabId : null), { tabId: ignored, ...parameters } = extra;
    const generation = state.generation, controller = new AbortController(), current = () => visible() && generation === state.generation && state.controller === controller;
    state.controller = controller; const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]), request = async (path, method = 'GET', body) => { if (!current()) throw Error('Contained view closed.'); return api(path, { method, ...(body ? { body } : {}), signal }); };
    const mutation = !['refresh', 'inspect'].includes(action); let dispatched = false, waiting = false;
    if (mutation) state.progressUntil = now() + 10000;
    state.busy = true; state.action = action; state.error = ''; state.notice = ''; state.pending = action === 'close' ? 'Closing the contained tab…' : action === 'suspend' ? 'Suspending the contained page…' : mutation ? 'Applying page input inside BLACKICE…' : action === 'inspect' ? 'Reading contained page controls…' : 'Refreshing contained browser…'; render();
    try {
      const initialStatus = await request('/api/browser/status?view=contained'); if (!current()) return;
      if (action === 'refresh' && explicitTarget) {
        state.followAgent = false; state.selectedId = explicitTarget;
        if (!observeBrowserModel(initialStatus).tabs.some(tab => tab.tabId === explicitTarget)) { state.status = initialStatus; throw Error('The requested contained tab is no longer available. Open it again before viewing.'); }
      }
      let view = applyStatus(initialStatus);
      if (!view.available || view.blocked) throw Error(view.reason);
      if (view.busy) { waiting = true; state.notice = 'The contained browser is busy. The view will refresh after the current page action settles.'; return; }
      if (view.selected?.pendingInteraction && ['refresh', 'inspect'].includes(action)) { waiting = true; state.readFailures = 0; return; }
      if (view.selected?.pendingInteraction && !['interaction', 'upload', 'close', 'open', 'suspend'].includes(action)) throw Error('Answer the page dialog or file request before using its controls.');
      let tabId = view.selected?.tabId;
      if (action !== 'refresh') {
        const target = ['close','suspend'].includes(action) ? explicitTarget || initial : initial;
        if (action !== 'open' && (!target || !view.tabs.some(tab => tab.tabId === target))) throw Error('That page is no longer a hidden BLACKICE tab. Choose another page before interacting.');
        if (!['open', 'close', 'suspend'].includes(action) && target !== tabId) throw Error('The active page changed. Inspect the selected page before repeating the action.');
        if (['fill', 'select'].includes(action) && (state.controlsStale || state.stale)) throw Error('Read the current page controls before setting this field.');
        const body = { ...parameters, action: action === 'inspect' ? 'snapshot' : action, browser: 'relay', ...(action === 'open' ? {} : { tabId: target }) };
        const popup = watchPopup(target, body);
        dispatched = mutation; state.mutationPending = mutation; let result;
        try { result = await request('/api/browser/action', 'POST', body); }
        finally { settlePopup(popup); }
        if (!current()) return;
        if (action === 'open') {
          if (typeof result.tabId !== 'string') throw Error('The contained browser did not return its new page identity.');
          if (state.address === parameters.url) { state.addressDirty = false; state.address = state.displayedUrl; }
          state.requiredTabId = null; state.followAgent = false; state.selectedId = tabId = result.tabId;
        }
        if (action === 'close' && target === state.displayedId) { state.requiredTabId = null; state.followAgent = false; state.selectedId = target; }
        if (mutation&&action!=='suspend') state.stale = true;
        if (action === 'navigate' && state.address === parameters.url) state.addressDirty = false;
        const updatedStatus = await request('/api/browser/status?view=contained'); if (!current()) return; view = applyStatus(updatedStatus);
        if (!view.available || view.blocked || !['close','suspend'].includes(action) && view.selected?.tabId !== tabId && view.popupParentId !== tabId && view.popupReturnedFrom !== tabId) throw Error('The page is no longer available in the contained browser. Inspect the tabs before continuing.');
        if(action==='suspend'){
          const outcome=browserSuspensionOutcome({...updatedStatus,...(result?.receipt?{receipt:result.receipt}:{})},target);
          state.notice=outcome.message;
          if(outcome.suspended&&target===view.selected?.tabId){
            stopInput();state.watching=false;state.followAgent=false;state.selectedId=target;state.requiredTabId=null;
            state.inputNotice='';state.frame=null;state.document=null;state.ref=null;state.stale=true;state.controlsStale=true;
            state.notice+=' Preview paused.';
          }
          state.readFailures=0;return;
        }
        tabId = view.selected?.tabId;
        if (view.selected?.pendingInteraction) { waiting = true; state.readFailures = 0; return; }
        if (action !== 'close') adoptDocument(result, tabId);
      }
      if (tabId) {
        const result = await request('/api/browser/action', 'POST', { action: 'screenshot', browser: 'relay', tabId }); if (!current()) return;
        const frame = observeBrowserFrame(result, tabId); if (!frame) throw Error('The contained browser returned no valid page frame.');
        if(state.status.tabs.some(tab=>tab.tabId===tabId&&tab.suspended===true)){
          const resumedStatus=await request('/api/browser/status?view=contained');if(!current())return;view=applyStatus(resumedStatus);
          if(view.selected?.tabId!==tabId)throw Error('The selected page changed while it was loading. Inspect the current tab before continuing.');
        }
        if (frame.url && frame.url !== view.selected.url) {
          state.document = null; state.ref = null; state.controlsStale = true; state.displayedUrl = frame.url; state.status = { ...state.status, tabs: state.status.tabs.map(tab => tab.tabId === tabId ? { ...tab, url: frame.url } : tab) }; if (!state.addressDirty) state.address = frame.url;
        }
        state.frame = frame; state.capturedAt = new Date(now()).toISOString(); state.stale = false;
        if (inputSession && !inputMatches(inputSession)) stopInput({ notice: 'The page changed. Click its field to resume keyboard input.' });
      } else { state.frame = null; state.document = null; state.ref = null; }
      state.readFailures = 0;
    } catch (error) {
      if(current()&&action==='suspend'&&dispatched){
        // A failed save or response can follow a completed suspension. Read
        // status only, and never wake that page automatically to check it.
        if((explicitTarget||initial)===initial){stopInput();state.watching=false;state.followAgent=false;state.selectedId=initial;}
        try{const observed=await request('/api/browser/status?view=contained');if(current())applyStatus(observed);}catch{}
      }
      if (current()) {
        state.error = String(error.message || 'The contained page could not be updated.').slice(0, 600);
        if (dispatched) state.inputNotice = 'The page action may have completed. Inspect the current page before repeating it.';
        state.error += dispatched ? ' ' + state.inputNotice : state.watching ? ' The preview will retry automatically.' : '';
        state.stale = true; state.controlsStale = true; state.readFailures++;
      }
    } finally {
      if (current()) {
        state.busy = false; state.action = ''; state.pending = ''; state.controller = null; state.mutationPending = false;
        const retryDelay = state.readFailures ? Math.min(5000, 1000 * 2 ** Math.min(state.readFailures - 1, 3)) : waiting || state.focusPage || model().selected?.loading || now() < state.progressUntil ? 1000 : 5000;
        state.nextAt = now() + retryDelay;
        if (state.error && inputSession) stopInput(); render(); if (action === 'close' || action === 'open' || state.revealSelected) revealTab(model().selected?.tabId); state.revealSelected = false; state.pendingFocus = null; void pumpInput();
      }
      else if (generation === state.generation && state.controller === controller) { state.controller = null; state.busy = false; state.stale = true; state.nextAt = 0; state.pendingFocus = null; if (dispatched) { state.inputNotice = 'The view became hidden while a page action was pending. Inspect the page before repeating it.'; } state.mutationPending = false; }
    }
  }
  async function protection(action) {
    if (!visible() || state.protectionBusy || state.busy) return;
    remember(); const currentSite = model().selected, global = state.status.protection || {}; let body;
    if (action === 'protection-site') {
      const site = currentSite?.protection; if (!site?.available || !global.enabled || !global.ready || !site.origin) return;
      body = { action: 'site', tabId: currentSite.tabId, origin: site.origin, enabled: site.siteExempt === true };
    } else if (action === 'protection-global') body = { action: 'global', enabled: !global.enabled };
    else body = { action: 'refresh' };
    const generation = state.generation, controller = new AbortController(); protectionController = controller;
    const owns = () => visible() && generation === state.generation && protectionController === controller;
    const active = typeof document === 'undefined' ? null : document.activeElement; state.protectionFocus = mount.contains?.(active) ? focusSnapshot(active) : null;
    state.protectionBusy = true; state.protectionError = ''; state.protectionNotice = ''; render();
    try {
      const value = await api('/api/browser/protection', { method: 'POST', body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
      if (!owns()) return;
      if (!value || typeof value.available !== 'boolean' || typeof value.enabled !== 'boolean' || !Array.isArray(value.tabs)) throw Error('Protection returned an invalid status. Refresh Activity before repeating the change.');
      const byId = new Map(value.tabs.map(tab => [tab.tabId, tab]));
      state.status = { ...state.status, protection: value, tabs: state.status.tabs.map(tab => {
        const incoming = byId.get(tab.tabId); let origin; try { origin = new URL(tab.url).origin; } catch {}
        return incoming && incoming.origin === origin ? { ...tab, protection: incoming } : tab;
      }) };
      state.protectionNotice = body.action === 'site' ? `${body.enabled ? 'Protection enabled' : 'Protection disabled'} for ${body.origin}.` : body.action === 'global' ? `Browser protection ${value.enabled ? 'enabled' : 'disabled'}.` : value.refreshing ? 'Filter update started.' : 'Filter rules updated.';
    } catch (error) { if (owns()) state.protectionError = String(error.message || 'Browser protection could not be updated.').slice(0, 600) + ' Refresh Activity to inspect its current state before trying again.'; }
    finally { if (owns()) { state.protectionBusy = false; protectionController = null; state.nextAt = 0; render(); state.protectionFocus = null; } }
  }
  async function answerInteraction(button) {
    const interaction = model().selected?.pendingInteraction;
    if (!interaction || interaction.id !== button.dataset.interactionId || state.busy || state.protectionBusy || state.pickingFiles) return;
    const decision = button.dataset.decision;
    if (interaction.status === 'blocked' ? decision !== 'acknowledge' : interaction.kind === 'file_chooser' ? !['upload', 'dismiss'].includes(decision) : !['accept', 'dismiss'].includes(decision)) return;
    stopInput(); state.interactionError = '';
    const guard = { expectedUrl: interaction.url, expectedDocumentId: interaction.documentId };
    if (decision === 'upload') {
      if (!state.canPickBrowserFiles) return;
      const generation = state.generation; state.pickingFiles = true; render();
      const stillOwned = () => { const current = model().selected?.pendingInteraction; return visible() && generation === state.generation && current && ['id', 'tabId', 'url', 'documentId'].every(key => current[key] === interaction[key]); };
      try {
        const picked = await pickBrowserFiles({ multiple: interaction.multiple });
        if (!stillOwned()) return;
        const paths = Array.isArray(picked) ? picked : picked?.filePaths || (typeof picked?.path === 'string' ? [picked.path] : []);
        if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string' || !value || value.length > 32768 || value.includes('\u0000'))) throw Error('The file picker did not return valid selected files.');
        if (!paths.length) return;
        if (!interaction.multiple && paths.length !== 1) throw Error('This page accepts one file. Choose one file to continue.');
        state.pickingFiles = false;
        await work('upload', { chooserId: interaction.id, paths, ...guard });
      } catch (error) { if (stillOwned()) state.interactionError = String(error.message || 'The selected files could not be used.').slice(0, 600); }
      finally { if (generation === state.generation) { state.pickingFiles = false; if (visible()) render(); } }
      return;
    }
    await work('interaction', { interactionId: interaction.id, decision, ...guard, ...(decision === 'accept' && interaction.dialogType === 'prompt' ? { promptText: String(state.interactionDraft || '').slice(0, 4096) } : {}) });
  }
  const click = async event => {
    const button = event.target.closest?.('[data-observe-browser]'); if (!button || !mount.contains(button) || !visible() || button.disabled) return;
    remember(); const action = button.dataset.observeBrowser;
    if (action === 'connection-settings') {
      if (!state.chatGPTConversation || !state.canOpenConnectionSettings) return;
      stopInput();
      try { await onOpenConnectionSettings(); } catch (error) { if (visible()) { state.error = error.message || 'Connection settings could not be opened.'; render(); } }
      return;
    }
    if (action === 'tab') return selectTab(button.dataset.tabId);
    if (action === 'tree-tab') return selectTab(button.dataset.tabId,{focus:false});
    if (action === 'follow') return selectTab(state.followAgent ? model().selected?.tabId : null, { follow: !state.followAgent, focus: false });
    if (action === 'interaction') return answerInteraction(button);
    if (action.startsWith('protection-')) return protection(action);
    if (action === 'point') {
      if (state.stale || state.protectionBusy || state.busy && !['refresh', 'inspect'].includes(state.action)) return;
      const displayedFrame = pointerGesture?.frame || state.frame;
      if (!sameBrowserInputFrame(displayedFrame, state.frame)) return;
      const point = observeBrowserPoint(displayedFrame, event, $('#observe-browser-image')?.getBoundingClientRect?.());
      if (point) {
        const session = captureInput();
        if (session) {
          // Pointer actions are barriers in the same queue as typed text. New
          // keystrokes cannot overtake the click that chose their target field.
          queueInput({ action: 'click', ...point }); return session.running;
        }
        await work('click', point);
      }
      return;
    }
    if (state.busy || state.protectionBusy) return;
    if (action === 'watch') { state.watching = !state.watching; state.nextAt = 0; render(); if (state.watching) await work(); return; }
    if (action === 'new') { await openURL(true); return; }
    if (action === 'close'||action==='tree-close') return work('close', { tabId: button.dataset.tabId });
    if (action === 'tree-suspend') return work('suspend', { tabId: button.dataset.tabId });
    if (action === 'up' || action === 'down') { await work('scroll', { direction: action, amount: 650 }); return; }
    if (action === 'key') { await work('press', { key: state.key, ...(!state.controlsStale && state.ref ? { ref: state.ref } : {}) }); return; }
    if (action === 'control' || action === 'fill') {
      const control = state.document?.controls.find(item => item.ref === state.ref); if (!control || state.stale || state.controlsStale) return;
      const text = state.text; await work(action === 'control' ? 'click' : control.options ? 'select' : 'fill', { ref: control.ref, ...(action === 'fill' ? control.options ? { value: state.fieldValue } : { text } : {}) });
      if (!state.error && action === 'fill' && state.text === text) { state.text = ''; if ($('#observe-browser-text')) $('#observe-browser-text').value = ''; } return;
    }
    await work(action);
  };
  async function openURL(newTab = false) {
    if (!visible() || state.busy || state.protectionBusy) return;
    remember(); let url;
    try { url = normalizeBrowserAddress(state.address); }
    catch (error) { state.error = error.message; render(); $('#observe-browser-url')?.focus?.({ preventScroll: true }); return; }
    state.address = url; const address = $('#observe-browser-url'); if (address) address.value = url;
    await work(newTab || !model().selected ? 'open' : 'navigate', { url });
  }
  const submit = event => { if (event.target.id !== 'observe-browser-address-form') return; event.preventDefault(); return openURL(); };
  const change = event => {
    if (!visible()) return; remember();
    if (event.target.id === 'observe-browser-ref') { state.ref = event.target.value; state.text = ''; state.fieldValue = state.document?.controls.find(item => item.ref === state.ref)?.options?.[0]?.value || ''; if ($('#observe-browser-text')) $('#observe-browser-text').value = ''; render(); }
  };
  const keydown = event => {
    if (event.target.id === 'observe-browser-input') {
      if (!inputSession || !visible()) return;
      if (event.isComposing || event.keyCode === 229 || inputSession.composing) { event.stopPropagation?.(); return; }
      inputSession.skipComposition = null;
      const modified = event.ctrlKey || event.metaKey, key = event.key;
      if (modified && ['k', 'm'].includes(String(key).toLowerCase())) return;
      if (event.ctrlKey && event.altKey && key === 'Escape') return;
      if (key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); stopInput({ focus: true }); render(); return; }
      // Paste is delivered by its literal-text event. Copy/cut and unrelated
      // application shortcuts never access the host clipboard through this API.
      if (modified && ['c', 'x', 'v'].includes(String(key).toLowerCase())) return;
      const navigation = ['Enter', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
      if (navigation.includes(key) || modified && key?.toLowerCase() === 'a') {
        event.preventDefault(); event.stopPropagation?.();
        queueInput({ action: 'press', key: modified && key.toLowerCase() === 'a' ? 'A' : key, modifiers: [['ctrlKey', 'Control'], ['metaKey', 'Meta'], ['altKey', 'Alt'], ['shiftKey', 'Shift']].filter(([flag]) => event[flag]).map(([, modifier]) => modifier) }); return;
      }
      if (!modified && !event.altKey || event.getModifierState?.('AltGraph')) event.stopPropagation?.();
      return;
    }
    const preview = event.target.closest?.('[data-observe-browser="point"]');
    if (preview && mount.contains(preview) && !preview.disabled && visible() && ['Enter', ' '].includes(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopPropagation?.(); captureInput(); return;
    }
    const tab = event.target.closest?.('[data-observe-browser="tab"]'); if (!tab || !mount.contains(tab) || !visible() || event.altKey || event.ctrlKey || event.metaKey) return;
    const id = observeBrowserTabKey(model().tabs, tab.dataset.tabId, event.key);
    if (id) { event.preventDefault(); return selectTab(id); }
    if (event.key === 'Delete' && !state.busy) { event.preventDefault(); return work('close', { tabId: tab.dataset.tabId }); }
  };
  const ownsInput = event => event.target.id === 'observe-browser-input' && inputSession && visible() && (mount.ownerDocument || globalThis.document)?.activeElement === event.target;
  const commitInputText = (target, text) => {
    target.value = '';
    if (inputSession.skipComposition && text === inputSession.skipComposition) { inputSession.skipComposition = null; return; }
    inputSession.skipComposition = null;
    if (text) queueInput({ action: 'type', text });
  };
  const input = event => {
    if (event.target.id !== 'observe-browser-input') return;
    if (!ownsInput(event)) { event.target.value = ''; return; }
    if (event.isComposing || inputSession.composing) return;
    commitInputText(event.target, event.target.value || event.data || '');
  };
  const beforeinput = event => {
    if (!ownsInput(event) || event.isComposing || inputSession.composing) return;
    // preventScroll only covers focus. A native edit can separately reveal the
    // proxy's caret and scroll its ancestors before the input event clears it.
    // Keep IME edits native; intercept ordinary cancelable text before editing.
    if (event.cancelable && typeof event.data === 'string' && ['insertText', 'insertReplacementText', 'insertFromComposition'].includes(event.inputType)) {
      event.preventDefault(); event.stopPropagation?.(); commitInputText(event.target, event.data); return;
    }
    const key = { deleteContentBackward: 'Backspace', deleteContentForward: 'Delete', insertLineBreak: 'Enter', insertParagraph: 'Enter' }[event.inputType];
    if (key) { event.preventDefault(); event.stopPropagation?.(); queueInput({ action: 'press', key, modifiers: [] }); }
  };
  const paste = event => {
    if (!ownsInput(event)) return;
    event.preventDefault(); event.stopPropagation?.();
    const text = event.clipboardData?.getData('text/plain'); event.target.value = '';
    if (text) queueInput({ action: 'type', text });
  };
  const compositionstart = event => { if (ownsInput(event)) { inputSession.composing = true; inputSession.skipComposition = null; } };
  const compositionend = event => {
    if (!ownsInput(event)) { if (event.target.id === 'observe-browser-input') event.target.value = ''; return; }
    const session = inputSession, text = event.data || event.target.value || '';
    session.composing = false; session.skipComposition = text; event.target.value = '';
    if (text) queueInput({ action: 'type', text });
    if (renderDeferred) render();
    if (inputRefreshDue) refreshAfterInput(session);
  };
  const focusout = event => {
    if (event.target.id === 'observe-browser-input' && !rendering) stopInput();
  };
  const pointerdown = event => {
    const control = event.target.closest?.('[data-observe-browser="point"], [data-observe-browser="interaction"], #observe-browser-tools > summary, #observe-browser-protection-settings > summary, #observe-browser-url');
    if (!control || control.disabled || !mount.contains(control) || !visible() || event.isPrimary === false || event.button !== undefined && event.button !== 0) return;
    clearTimeout(pointerRelease); pointerRelease = null;
    pointerGesture = { frame: state.frame, pointerId: event.pointerId };
    // Local controls must retain native focus and activation. Only a page or
    // interaction click keeps the hidden keyboard capture focused while held.
    if (inputSession && ['point', 'interaction'].includes(control.dataset.observeBrowser)) event.preventDefault();
  };
  function finishPointer({ redraw = true } = {}) {
    clearTimeout(pointerRelease); pointerRelease = null; pointerGesture = null;
    if (redraw && renderDeferred && visible()) render();
  }
  const pointerup = event => {
    if (!pointerGesture || event.pointerId !== undefined && pointerGesture.pointerId !== undefined && event.pointerId !== pointerGesture.pointerId) return;
    clearTimeout(pointerRelease);
    // Native click dispatch follows pointerup synchronously. Retain its hit
    // target until that dispatch finishes, including release outside the pane.
    pointerRelease = setTimeout(() => finishPointer(), 0);
  };
  const pointercancel = () => finishPointer();
  const windowBlur = () => { stopInput(); finishPointer(); };
  const ownerWindow = mount.ownerDocument?.defaultView || (typeof window === 'undefined' ? null : window);
  const listeners = { click, submit, change, keydown, input, beforeinput, paste, compositionstart, compositionend, focusout, pointerdown };
  for (const [type, listener] of Object.entries(listeners)) mount.addEventListener(type, listener);
  ownerWindow?.addEventListener?.('blur', windowBlur);
  ownerWindow?.addEventListener?.('pointerup', pointerup);
  ownerWindow?.addEventListener?.('pointercancel', pointercancel);
  render();
  return {
    async enter({ tabId, focusPage = false, chatGPTConversation = false } = {}) {
      popupRequest = null; popupParents = [];
      state.active = true; state.nextAt = 0; state.requiredTabId = typeof tabId === 'string' && tabId ? tabId : null; state.focusPage = focusPage === true; state.chatGPTConversation = state.focusPage && Boolean(state.requiredTabId) && chatGPTConversation === true; state.browserToolsOpen = false; if (state.focusPage) state.watching = true; onFocusPageChange(state.focusPage);
      if (!cancelRead()) return;
      const generation = state.generation, doc = mount.ownerDocument || globalThis.document, entryFocus = doc?.activeElement;
      await work('refresh', typeof tabId === 'string' && tabId ? { tabId } : {});
      if (generation === state.generation && visible() && state.focusPage) {
        const focused = doc?.activeElement, ownsFocus = focused === entryFocus || !focused || focused === doc?.body || focused.isConnected === false;
        if (ownsFocus && (!mount.contains?.(focused) || focused?.dataset?.observeBrowser === 'point')) { mount.scrollTop = 0; actionNode('point')?.focus?.({ preventScroll: true }); }
      }
    },
    update() {
      if (!visible()) { stopInput(); if (state.active && state.controller) { remember(); keepDraft(); state.generation++; state.controller.abort(); state.controller = null; state.busy = false; state.stale = true; state.nextAt = 0; state.pendingFocus = null; if (state.mutationPending) { state.inputNotice = 'The view became hidden while a page action was pending. Inspect the page before repeating it.'; } state.mutationPending = false; } return; }
      if (inputSession?.running || inputSession?.queue.length || inputSession?.composing) return;
      if (!state.stale && now() - Date.parse(state.capturedAt) > 10000) { state.stale = true; render(); } if (state.watching && !state.busy && now() >= state.nextAt) void work();
    },
    leave() { stopInput(); popupRequest = null; popupParents = []; finishPointer({ redraw: false }); remember(); keepDraft(); state.active = false; state.generation++; state.controller?.abort(); state.controller = null; protectionController?.abort(); protectionController = null; state.protectionBusy = false; state.protectionFocus = null; state.pickingFiles = false; state.interactionId = null; state.interactionDraft = ''; state.interactionError = ''; state.busy = false; state.frame = null; renderedFrame = null; state.document = null; for (const saved of drafts.values()) saved.document = null; state.stale = true; state.controlsStale = true; state.pendingFocus = null; state.rendered = null; state.error = ''; state.mutationPending = false; mount.innerHTML = ''; },
    destroy() { this.leave(); drafts.clear(); for (const [type, listener] of Object.entries(listeners)) mount.removeEventListener(type, listener); ownerWindow?.removeEventListener?.('blur', windowBlur); ownerWindow?.removeEventListener?.('pointerup', pointerup); ownerWindow?.removeEventListener?.('pointercancel', pointercancel); }
  };
}

const observeSurfaces = {
  browser: { label: 'Browser', panel: 'observe-browser', description: 'Websites stay inside BLACKICE. Switching surfaces keeps your pages open.' },
  applications: { label: 'Applications', panel: 'observe-application-sessions', description: 'Private application sessions stay running when you switch surfaces.' },
  workflow: { label: 'Workflow', panel: 'observe-workspace-workflow', description: 'Inspect the task workflow, saved steps, updates, and external action receipts.' }
};
export function renderObserveSurfaceNavigation({ surface = 'browser', available = true } = {}) {
  const selected = Object.hasOwn(observeSurfaces, surface) && (available || surface === 'workflow') ? surface : 'workflow';
  return `<div class="observe-surface-navigation"><div class="observe-surface-tabs" role="tablist" aria-label="Activity work surface">${Object.entries(observeSurfaces).filter(([id]) => available || id === 'workflow').map(([id, item]) => `<button type="button" id="observe-surface-${id}" class="observe-surface-tab" role="tab" data-observe-surface="${id}" aria-controls="${item.panel}" aria-selected="${selected === id}" tabindex="${selected === id ? '0' : '-1'}">${item.label}</button>`).join('')}</div><p id="observe-surface-description">${observeSurfaces[selected].description}</p></div>`;
}

export function initObserveUI({ mount, getSnapshot, api, subscribe, onOpenRun, onStop, onBrowser, onChatGPTSettings, onDesktop, onEditSteps, onOpenWorkflow, pickBrowserFiles, requestFrame, cancelFrame, escape = escapeText, icon = svg }) {
  installObserveStyles(); installApplicationSessionStyles(); const $ = query => mount.querySelector(query), selection = createObserveSelection(), feed = createObserveFeed();
  const state = { entered: false, surface: api ? 'browser' : 'workflow', surfaceChosen:false, surfaceScroll: {}, followLive:true, displayedPinned:null, programmaticScrollTop:null, selecting: false, selectionVersion: 0, stopRequests: new Map(), runId: null, close: null, generation: 0, timer: null, ready: false, reconnecting: false, hasGap: false, ended: false, presentation: {}, focus: null, error: '', optionsSignature: '', agentSignature: '', pinnedSignature: '', feedSignature: '', planSignature: '', externalSignature:'',graphSignature:'', graphSelected:null, openOutputs: new Set(),openReceipts:new Set(),openPlanSteps:new Set() };
  mount.classList.add('observe-workspace');
  mount.innerHTML = `<header class="observe-header"><div class="observe-title"><h1>Activity</h1><span id="observe-stream" class="observe-stream"></span><span id="observe-viewing" class="observe-viewing-label"></span></div><div class="observe-toolbar"><label class="observe-run-picker"><span class="observe-sr-only">Task to inspect</span><select id="observe-run" aria-label="Task to inspect"></select></label><button type="button" class="button" data-observe-action="conversation">View conversation</button><button type="button" class="button observe-stop" data-observe-action="stop">Stop task</button></div></header>${renderObserveSurfaceNavigation({surface:state.surface,available:Boolean(api)})}<div class="observe-scroll"><p id="observe-error" class="observe-error" role="status" hidden></p><section id="observe-browser" class="observe-browser" role="tabpanel" aria-labelledby="observe-surface-browser" aria-describedby="observe-surface-description"${api ? '' : ' hidden'}></section><section id="observe-application-sessions" class="application-session" role="tabpanel" aria-labelledby="observe-surface-applications" aria-describedby="observe-surface-description" hidden></section><section id="observe-workspace-workflow" role="tabpanel" aria-labelledby="observe-surface-workflow" aria-describedby="observe-surface-description"${api ? ' hidden' : ''}><div id="observe-empty" class="observe-empty"><h2>No task selected</h2><p>Start a task in Chat, or choose a saved task above to inspect its workflow and receipts.</p></div><main id="observe-content" class="observe-live-layout" hidden><div class="observe-now"><div><p class="observe-eyebrow" id="observe-task-name"></p><h2 id="observe-live-title">Live work</h2><p id="observe-now-text">Waiting for the next update.</p></div><div class="observe-live-controls"><button type="button" id="observe-follow-live" class="button observe-follow-live" data-observe-action="follow-live" aria-pressed="true">Following live</button><details class="observe-options"><summary>Show</summary><label>Live feed<select id="observe-focus"><option value="auto">All updates</option><option value="edits">File edits</option><option value="activity">Agent activity</option></select></label>${onBrowser ? '<button type="button" class="button" data-observe-action="browser">Open browser</button>' : ''}</details></div></div><section id="observe-external" class="observe-external" aria-label="Saved external action receipts" hidden></section><div id="observe-workflow"></div><div id="observe-agents" class="observe-agent-strip"></div><details id="observe-plan" class="observe-plan" hidden><summary>Saved steps<span id="observe-plan-count"></span></summary><div id="observe-current-step" class="observe-current-step"></div><ol id="observe-plan-list"></ol><p class="observe-plan-note">Saved steps and evidence are agent reports.</p>${onEditSteps ? '<button type="button" class="button" data-observe-action="edit-steps">Edit steps</button>' : ''}</details><div id="observe-pinned" class="observe-pinned"></div><div id="observe-feed" class="observe-live-feed" aria-live="off"></div><p id="observe-feed-empty" class="observe-feed-empty">New edits and updates appear here while you watch.</p><details id="observe-older" class="observe-older" hidden><summary id="observe-older-label">Earlier updates</summary><div id="observe-older-feed"></div></details><p class="observe-session-note" id="observe-session-note">Watching starts here. File watching stops when you leave Observe.</p></main></section></div>`;
  const containedBrowser = api && $('#observe-browser') ? initObserveBrowser({ mount: $('#observe-browser'), api, pickBrowserFiles, onOpenConnectionSettings: onChatGPTSettings, isVisible: () => state.entered && !mount.hidden && state.surface === 'browser', onFocusPageChange(value) { state.focusPage = value; mount.classList?.toggle?.('observe-page-focus', value && state.surface === 'browser'); } }) : null;
  const applicationSessions = api && $('#observe-application-sessions') ? initApplicationSessionUI({ mount: $('#observe-application-sessions'), api, isVisible: () => state.entered && !mount.hidden && state.surface === 'applications' }) : null;
  const ownerWindow = mount.ownerDocument?.defaultView || globalThis;
  requestFrame ||= ownerWindow.requestAnimationFrame?.bind(ownerWindow) || (callback => setTimeout(callback, 16));
  cancelFrame ||= ownerWindow.cancelAnimationFrame?.bind(ownerWindow) || clearTimeout;
  let pendingUpdate = null;
  function cancelUpdate() {
    const pending = pendingUpdate; pendingUpdate = null;
    if (pending) cancelFrame(pending.handle);
  }
  function scheduleUpdate() {
    if (pendingUpdate || !state.entered || mount.hidden) return;
    const pending = {}; pendingUpdate = pending;
    pending.handle = requestFrame(() => {
      // Cancellation also invalidates callbacks already delivered by a frame
      // source, so leaving/reopening cannot render an old observation.
      if (pendingUpdate !== pending) return;
      pendingUpdate = null;
      if (!state.entered || mount.hidden) return;
      try { update(); }
      catch (error) {
        if (globalThis.blackiceUIResilience?.report) globalThis.blackiceUIResilience.report(error);
        else throw error;
      }
    });
    pending.handle?.unref?.();
  }
  function applySurface() {
    mount.classList?.toggle?.('observe-page-focus', state.focusPage === true && state.surface === 'browser');
    for (const [id, item] of Object.entries(observeSurfaces)) {
      const selected = state.surface === id, panel = $('#' + item.panel), tab = $('#observe-surface-' + id);
      if (panel) panel.hidden = !selected;
      tab?.setAttribute?.('aria-selected', String(selected)); if (tab) tab.tabIndex = selected ? 0 : -1;
    }
    const description = $('#observe-surface-description'); if (description) description.textContent = observeSurfaces[state.surface].description;
  }
  function selectSurface(surface, { focus = false } = {}) {
    if (!Object.hasOwn(observeSurfaces, surface) || !api && surface !== 'workflow') return false;
    state.surfaceChosen=true;
    if (surface === state.surface) { if (focus) $('#observe-surface-' + surface)?.focus?.({ preventScroll: true }); return true; }
    const scroll = $('.observe-scroll'), previous = state.surface;
    state.surfaceScroll[previous] = scroll?.scrollTop || 0; state.surface = surface; applySurface();
    // Hiding a view cancels only its observation. Its page or private app stays open.
    if (previous === 'browser') containedBrowser?.update(); else if (previous === 'applications') applicationSessions?.update();
    else if (state.runId && !state.ended) { closeSubscription(); state.hasGap = true; state.reconnecting = false; feed.settle(); }
    if (scroll) setScroll(state.surfaceScroll[surface] || 0);
    if (focus) $('#observe-surface-' + surface)?.focus?.({ preventScroll: true });
    if (state.entered && !mount.hidden) { if (surface === 'browser') containedBrowser?.enter(); else if (surface === 'applications') applicationSessions?.enter(); else { const run = selection.model(getSnapshot()).run; if (run?.id === state.runId) watchRun(run); } update(); }
    return true;
  }
  function closeSubscription() { state.generation++; const close = state.close; state.close = null; state.ready = false; try { close?.(); } catch {} }
  function leave() {
    cancelUpdate();
    containedBrowser?.leave(); applicationSessions?.leave();
    state.entered = false; state.selectionVersion++; state.selecting = false; clearInterval(state.timer); state.timer = null; closeSubscription(); state.runId = null; state.ended = false; state.reconnecting = false; state.hasGap = false; state.presentation = {}; state.focus = null; state.followLive=true;state.displayedPinned=null;state.programmaticScrollTop=null;feed.reset(); state.openOutputs.clear();
    state.feedSignature = ''; state.pinnedSignature = ''; state.agentSignature = ''; state.planSignature = ''; state.externalSignature='';state.openReceipts.clear();state.openPlanSteps.clear();if($('#observe-external')){$('#observe-external').innerHTML='';$('#observe-external').hidden=true;}state.graphSignature='';state.graphSelected=null;if($('#observe-workflow'))$('#observe-workflow').innerHTML=''; $('#observe-pinned').innerHTML = ''; $('#observe-feed').innerHTML = ''; $('#observe-older-feed').innerHTML = ''; $('#observe-agents').innerHTML = ''; $('#observe-plan-list').innerHTML = ''; $('#observe-current-step').textContent = ''; $('#observe-now-text').textContent = ''; $('#observe-task-name').textContent = ''; $('#observe-content').hidden = true;
  }
  function attach(run) {
    closeSubscription(); state.graphSignature='';state.graphSelected=null;state.externalSignature='';state.openReceipts.clear();state.openPlanSteps.clear(); state.runId = run?.id || null; state.ended = false; state.reconnecting = false; state.hasGap = false; state.error = ''; state.presentation = run?.observePresentation || {}; state.focus = null;state.followLive=true;state.displayedPinned=null;state.programmaticScrollTop=null;feed.reset(state.runId); state.openOutputs.clear(); state.feedSignature = ''; state.pinnedSignature = ''; state.agentSignature = ''; state.planSignature = '';
    watchRun(run);
  }
  function watchRun(run) {
    if (!run || !['queued', 'running', 'waiting'].includes(run.status)) { state.ended = Boolean(run); return; }
    if (state.surface !== 'workflow') return;
    closeSubscription();
    if (!subscribe) { state.error = 'Live file watching is unavailable. Agent updates will still appear here.'; return; }
    const generation = state.generation, current = () => state.entered && !mount.hidden && state.surface === 'workflow' && generation === state.generation && state.runId === run.id;
    try {
      const close = subscribe(run.id, {
        onReady(value = {}) { if (!current()) return; state.ready = true; state.reconnecting = false; state.error = ''; if (value.reconnected || state.hasGap) { state.hasGap = true; feed.reconnectBaseline(value.sequence); } else feed.baseline(value.sequence); if (value.presentation) state.presentation = value.presentation; if (value.coverage?.limited) state.error = 'Workspace scan limit reached. Only observed files can show a live diff.'; scheduleUpdate(); },
        onEdit(value) { if (current() && state.ready && feed.edit(value)) scheduleUpdate(); },
        onPresentation(value) { if (!current()) return; state.presentation = value?.presentation || value || {}; state.focus = null; scheduleUpdate(); },
        onStopped() { if (!current()) return; state.ended = true; feed.settle(); closeSubscription(); scheduleUpdate(); },
        onError(error, { reconnecting = false } = {}) { if (!current()) return; state.ready = false; state.reconnecting = reconnecting; state.error = String(typeof error === 'string' ? error : error?.message || 'Live file watching disconnected.').slice(0, 250); scheduleUpdate(); }
      });
      if (typeof close === 'function') { if (current()) state.close = close; else close(); }
    } catch (error) { state.error = String(error.message || 'Could not start live watching.').slice(0, 250); }
  }
  function handleEvent(event) {
    if (!state.entered || mount.hidden || !state.runId || event?.runId !== state.runId) return;
    const data = event.data || event;
    if (event.type === 'observe.presentation' || data.type === 'observe.presentation') { state.presentation = data.presentation || data || {}; state.focus = null; scheduleUpdate(); return; }
    if (event.type === 'run.edit' || data.type === 'run.edit') { if (state.ready && feed.edit(event)) scheduleUpdate(); return; }
    if (event.type === 'node.updated' && ['completed', 'failed', 'cancelled'].includes(data.status)) { feed.settle(event.nodeId); scheduleUpdate(); return; }
    if (feed.event(event)) scheduleUpdate();
  }
  function renderRunGraph(run){
    const host=$('#observe-workflow');if(!host)return;
    if(!run){host.innerHTML='';return;}
    const model=buildWorkflowMapModel({kind:'run',run}),selected=model.nodes.find(node=>node.id===state.graphSelected),signature=JSON.stringify([model,state.graphSelected]);
    if(signature===state.graphSignature)return;state.graphSignature=signature;
    const view=readWorkflowMapView(host),focused=typeof document==='undefined'?null:document.activeElement,focusData=host.contains?.(focused)?focused?.dataset:null;
    const focusKey=focusData&&['workflowNode','workflowAction','observeAction','workflowScroll'].find(key=>Object.hasOwn(focusData,key)),focusValue=focusKey?focusData[focusKey]:null,focusNodeId=focusData?.nodeId;
    host.innerHTML=renderWorkflowMap({kind:'run',run,selectedId:state.graphSelected,instanceId:'observe-flow-'+run.id})+(selected?'<div class="workflow-map-detail"><div><strong>'+escape(selected.label)+'</strong><span>'+escape(selected.statusLabel)+'</span></div><p>'+escape(selected.detail||'No output or receipt recorded for this step yet.')+'</p>'+(onOpenWorkflow?'<button type="button" class="button" data-observe-action="workflow" data-node-id="'+escape(selected.parentId||selected.id)+'">Inspect step in Workflows</button>':'')+'</div>':onOpenWorkflow?'<button type="button" class="button observe-workflow-open" data-observe-action="workflow">Open in Workflows</button>':'');
    restoreWorkflowMapView(host,view);
    if(focusKey){const attribute='data-'+focusKey.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());for(const control of host.querySelectorAll('['+attribute+']'))if(control.dataset[focusKey]===focusValue&&(focusKey!=='observeAction'||control.dataset.nodeId===focusNodeId)){control.focus({preventScroll:true});break;}}
  }
  function renderExternalActions(run){
    const host=$('#observe-external');if(!host)return;const model=observeExternalActions(run),signature=JSON.stringify(model);
    if(signature===state.externalSignature)return;state.externalSignature=signature;
    const focused=typeof document==='undefined'?null:document.activeElement,focusKey=host.contains?.(focused)?focused?.dataset?.observeReceiptControl:null;
    const retained=new Set(model.receipts.map(receipt=>receipt.id));for(const id of state.openReceipts)if(!retained.has(id))state.openReceipts.delete(id);
    host.innerHTML=renderObserveExternalActions(model,{escape,openReceipts:state.openReceipts,canOpenConversation:Boolean(onOpenRun)});host.hidden=!model.receipts.length&&!model.recoveryRequired;
    if(focusKey)for(const control of host.querySelectorAll?.('[data-observe-receipt-control]')||[])if(control.dataset.observeReceiptControl===focusKey){control.focus({preventScroll:true});break;}
  }
  function renderSavedPlan(run,presentation){
    const model=observePlan(run?.taskState,{stepIds:presentation.stepIds}),host=$('#observe-plan-list'),signature=JSON.stringify(model);$('#observe-plan').hidden=!model.steps.length;$('#observe-plan').classList.toggle('has-blocked',Boolean(model.blocked));
    if(signature===state.planSignature)return;state.planSignature=signature;
    const focused=typeof document==='undefined'?null:document.activeElement,focusKey=host.contains?.(focused)?focused?.dataset?.observePlanControl:null;
    const retained=new Set(model.steps.map(step=>step.id));for(const id of state.openPlanSteps)if(!retained.has(id))state.openPlanSteps.delete(id);
    $('#observe-plan-count').textContent=`${model.done} / ${model.steps.length}${model.filtered?' shown':''}${model.blocked?` · ${model.blocked} blocked`:''}`;$('#observe-current-step').textContent=model.summary;host.innerHTML=renderObservePlan(model,{escape,openSteps:state.openPlanSteps});
    if(focusKey)for(const control of host.querySelectorAll?.('[data-observe-plan-control]')||[])if(control.dataset.observePlanControl===focusKey){control.focus({preventScroll:true});break;}
  }
  const liveHosts=()=>['#observe-pinned','#observe-feed','#observe-older-feed'].map($).filter(Boolean);
  const liveNodes=selector=>liveHosts().flatMap(host=>[...host.querySelectorAll?.(selector)||[]]);
  function setScroll(top){const scroll=$('.observe-scroll');if(!scroll)return;scroll.scrollTop=top;state.programmaticScrollTop=scroll.scrollTop;}
  function updateFollowing(){const control=$('#observe-follow-live');if(!control)return;control.textContent=state.followLive?'Following live':'Follow live';control.setAttribute?.('aria-pressed',String(state.followLive));control.setAttribute?.('data-follow-live',String(state.followLive));control.title=state.followLive?'Hold your place while task updates continue.':'Jump to the latest file edit or update.';}
  function holdLiveView(){if(!state.entered||state.surface!=='workflow'||!state.followLive)return;state.followLive=false;updateFollowing();}
  function rememberLiveView(){
    const scroll=$('.observe-scroll'),active=typeof document==='undefined'?null:document.activeElement,ownsFocus=liveHosts().some(host=>host.contains?.(active));
    const focusedEntry=ownsFocus?active?.closest?.('[data-observe-entry]'):null,entries=liveNodes('[data-observe-entry]'),edge=scroll?.getBoundingClientRect?.().top;
    const anchor=focusedEntry||entries.find(entry=>{const rect=entry.getBoundingClientRect?.();return rect&&rect.bottom>edge;});
    const links=focusedEntry?[...focusedEntry.querySelectorAll('a[href]')]:[];
    return{top:scroll?.scrollTop||0,anchor:anchor?{key:anchor.dataset.observeEntry,top:anchor.getBoundingClientRect?.().top}:null,focus:ownsFocus?{control:active?.dataset?.observeLiveControl,entry:focusedEntry?.dataset.observeEntry,link:links.indexOf(active)}:null,open:liveNodes('[data-observe-source]').filter(node=>node.open).map(node=>node.dataset.observeSource),regions:liveNodes('[data-observe-live-control]').map(node=>({key:node.dataset.observeLiveControl,left:node.scrollLeft,top:node.scrollTop}))};
  }
  function restoreLiveView(saved,{pinnedChanged=false,feedChanged=false,pinned=null}={}){
    for(const node of liveNodes('[data-observe-source]'))if(saved.open.includes(node.dataset.observeSource))node.open=true;
    for(const region of saved.regions){const node=liveNodes('[data-observe-live-control]').find(node=>node.dataset.observeLiveControl===region.key);if(node){if(Number.isFinite(region.left))node.scrollLeft=region.left;if(Number.isFinite(region.top))node.scrollTop=region.top;}}
    if(saved.focus){let replacement;if(saved.focus.control)replacement=liveNodes('[data-observe-live-control]').find(node=>node.dataset.observeLiveControl===saved.focus.control);else if(saved.focus.link>=0){const entry=liveNodes('[data-observe-entry]').find(node=>node.dataset.observeEntry===saved.focus.entry);replacement=entry?.querySelectorAll('a[href]')[saved.focus.link];}replacement?.focus?.({preventScroll:true});}
    const scroll=$('.observe-scroll');if(!scroll||state.surface!=='workflow')return;
    if(state.followLive&&!saved.focus&&pinnedChanged&&pinned){const rect=$('#observe-pinned')?.getBoundingClientRect?.(),outer=scroll.getBoundingClientRect?.();setScroll(rect&&outer?scroll.scrollTop+rect.top-outer.top-16:0);return;}
    if(state.followLive&&!saved.focus&&feedChanged&&!pinned){setScroll(scroll.scrollHeight);return;}
    const anchor=saved.anchor&&liveNodes('[data-observe-entry]').find(node=>node.dataset.observeEntry===saved.anchor.key),top=anchor?.getBoundingClientRect?.().top;
    setScroll(Number.isFinite(top)&&Number.isFinite(saved.anchor?.top)?scroll.scrollTop+top-saved.anchor.top:saved.top);
  }
  function update() {
    // Navigation and the app-level frame flush remain immediate, consuming any
    // queued display work without delaying or dropping its ingested receipts.
    cancelUpdate();
    if (mount.hidden) { if (state.entered) leave(); return; } if (!state.entered) return;
    if (state.surface === 'browser') containedBrowser?.update(); else if (state.surface === 'applications') applicationSessions?.update();
    const view = selection.model(getSnapshot()); if (view.run?.id !== state.runId) attach(view.run);
    for (const run of [...(getSnapshot().runs || []), view.run].filter(Boolean)) if (run.settled === true) state.stopRequests.delete(run.id);
    const stopRequest = view.active ? state.stopRequests.get(view.run.id) : null, settling = isSettlingRun(view.run), stopping = view.run?.status === 'cancelled' && view.run.settled !== true;
    const inspection=rememberLiveView();
    const presentation = state.presentation, liveFeed = feed.snapshot(), entries = liveFeed.entries, focus = state.focus || presentation.focus || 'auto';
    const current=observeLiveEntries(liveFeed,{focus,file:presentation.file}),pinned=!state.followLive&&state.displayedPinned&&focus==='auto'?state.displayedPinned:current.pinned;
    const held=pinned&&pinned.key!==current.pinned?.key,visible=(held&&current.pinned?[current.pinned,...current.visible]:current.visible).filter(entry=>entry.key!==pinned?.key),earlier=current.earlier.filter(entry=>entry.key!==pinned?.key);state.displayedPinned=pinned;
    const optionsSignature = JSON.stringify(view.runs); if (state.optionsSignature !== optionsSignature) { state.optionsSignature = optionsSignature; $('#observe-run').innerHTML = `<option value="">Follow active task</option>${view.runs.map(run => `<option value="${escape(run.id)}">${escape(run.name)} · ${isSettlingRun(run) && run.status !== 'cancelled' ? 'Finishing…' : settledStatusLabel(run)}</option>`).join('')}`; }
    $('#observe-run').value = selection.selectedId || ''; $('#observe-run').disabled = !view.runs.length;
    const stream=$('#observe-stream');stream.textContent=stopping?'Task stopping…':settling?'Task finishing…':stopRequest?.phase==='requesting'?'Requesting Stop…':stopRequest?.phase==='requested'?'Stop requested · waiting for active work':stopRequest?.phase==='failed'?'Stop not confirmed · task may still be running':view.run?({running:'Task running',queued:'Task queued',waiting:'Task waiting',completed:'Task complete',failed:'Task failed',cancelled:'Task stopped',interrupted:'Task interrupted'}[view.run.status]||'Task '+statusLabel(view.run.status)):'No task selected';stream.classList.toggle('connected',view.active);
    const viewing=$('#observe-viewing'),watching=state.surface==='workflow'&&view.active?(state.ready?'Live edits connected':state.reconnecting?'Reconnecting live edits…':state.error?'Live edits unavailable':'Starting live edits'):'';if(viewing)viewing.textContent=['Viewing '+observeSurfaces[state.surface].label,watching].filter(Boolean).join(' · ');updateFollowing();
    const stop = $('[data-observe-action="stop"]'); stop.hidden = !onStop || !view.active && !stopping; stop.disabled = !view.active || Boolean(stopRequest && stopRequest.phase !== 'failed'); stop.textContent = stopping || stopRequest?.phase === 'requested' ? 'Stopping…' : stopRequest?.phase === 'requesting' ? 'Requesting…' : stopRequest?.phase === 'failed' ? 'Retry stop' : 'Stop task';
    $('[data-observe-action="conversation"]').disabled=!view.run||!onOpenRun;
    $('#observe-empty').hidden = Boolean(view.run); $('#observe-content').hidden = !view.run;
    $('#observe-task-name').textContent = view.runs.find(run => run.id === view.run?.id)?.name || 'Current task'; $('#observe-live-title').textContent = presentation.title || (view.active?'Live work':'Saved task');
    const latest = entries.at(-1); $('#observe-now-text').textContent = latest?.kind === 'edit' ? `${latest.change === 'created' ? 'Created' : latest.change === 'deleted' ? 'Deleted' : 'Updated'} ${latest.path}` : latest?.kind === 'message' ? latest.text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*#]/g, '').replace(/\s+/g, ' ').slice(0, 160) : latest ? [latest.title, latest.detail].filter(Boolean).join(' · ') : view.active ? 'Waiting for the next update.' : 'No live updates captured in this view.';
    $('#observe-focus').value = focus;
    renderExternalActions(view.run);renderRunGraph(view.run);
    const agents = presentation.showAgents === false ? [] : view.agents;
    const agentSignature = JSON.stringify(agents.map(({ activity, elapsedMs, ...agent }) => agent)); if (state.agentSignature !== agentSignature) { state.agentSignature = agentSignature; $('#observe-agents').innerHTML = agents.map(agent => `<details class="observe-agent-brief ${escape(agent.status)}"><summary><span class="observe-state-dot"></span><strong>${escape(agent.name)}</strong><span>${settledStatusLabel(agent)}</span><time data-observe-duration="${escape(agent.id)}">${observeDuration(agent.elapsedMs)}</time></summary><p>${escape(agent.model)}</p></details>`).join(''); }
    for (const element of mount.querySelectorAll('[data-observe-duration]')) element.textContent = observeDuration(agents.find(agent => agent.id === element.dataset.observeDuration)?.elapsedMs);
    const agentNames = Object.fromEntries(view.agents.map(agent => [agent.id, agent.name])), pinnedSignature = JSON.stringify(pinned), feedSignature = JSON.stringify([visible, earlier, agentNames]);
    const pinnedChanged=state.pinnedSignature!==pinnedSignature,feedChanged=state.feedSignature!==feedSignature;
    if(pinnedChanged){state.pinnedSignature=pinnedSignature;$('#observe-pinned').innerHTML=pinned?renderObserveDiff(pinned,{escape,icon}):'';}
    if(feedChanged){state.feedSignature=feedSignature;$('#observe-feed').innerHTML=renderObserveFeed(visible,{escape,icon,agentNames,openOutputs:state.openOutputs});$('#observe-older-feed').innerHTML=renderObserveFeed(earlier,{escape,icon,agentNames,openOutputs:state.openOutputs});const retained=new Set(entries.map(entry=>entry.key));for(const key of state.openOutputs)if(!retained.has(key))state.openOutputs.delete(key);$('#observe-older').hidden=!earlier.length;$('#observe-older-label').textContent=`${earlier.length} earlier updates`;}
    $('#observe-feed-empty').hidden = Boolean(pinned || visible.length);$('#observe-feed-empty').textContent=!view.active||state.ended?'No live updates were captured in this view. Inspect the saved workflow, steps, or conversation.':state.reconnecting?'The live connection is recovering. Updates from the gap may be missing.':state.error&&!state.ready?'Live file edits are unavailable. Saved evidence and new agent activity can still appear here.':'New edits and updates appear here while you watch.';
    renderSavedPlan(view.run,presentation);
    $('#observe-session-note').textContent = stopping || settling || stopRequest?.phase === 'requested' ? 'Waiting for active work to finish. Saved progress stays with the task.' : state.ended || !view.active ? 'Live watching has stopped. Leaving Observe clears this view.' : state.hasGap ? 'Reconnected. Edits made while disconnected may be missing. File watching stops when you leave Observe.' : 'Watching starts here. File watching stops when you leave Observe.';
    const stopError = stopRequest?.phase === 'failed' ? `Stop was not confirmed. Try Stop again. ${stopRequest.error}` : '', errorText = [stopError, state.error].filter(Boolean).join(' ');
    $('#observe-error').hidden = !errorText || state.surface !== 'workflow'; $('#observe-error').textContent = errorText;
    restoreLiveView(inspection,{pinnedChanged,feedChanged:feedChanged&&visible.length>0,pinned});
  }
  const change = async event => {
    if (event.target.id === 'observe-focus') { state.focus = event.target.value;state.displayedPinned=null;update(); }
    if (event.target.id !== 'observe-run') return;
    selection.choose(event.target.value); selectSurface('workflow'); state.error = ''; const view = selection.model(getSnapshot()), version = ++state.selectionVersion; state.selecting = true;
    try { if (view.run?.id) await onOpenRun?.(view.run.id, 'observe'); }
    catch (error) { if (version === state.selectionVersion) state.error = String(error.message || 'Could not open this task.').slice(0, 250); }
    finally { if (version === state.selectionVersion) { state.selecting = false; update(); } }
  };
  const click = async event => {
    const surface = event.target.closest?.('[data-observe-surface]'); if (surface && mount.contains(surface)) { selectSurface(surface.dataset.observeSurface); return; }
    const toolbar=event.target.closest?.('[data-workflow-action]');if(toolbar&&mount.contains(toolbar)){handleWorkflowMapAction(toolbar);return;}
    const node=event.target.closest?.('[data-workflow-node]');if(node&&mount.contains(node)){state.graphSelected=node.dataset.workflowNode;state.graphSignature='';renderRunGraph(selection.model(getSnapshot()).run);return;}
    const button = event.target.closest?.('[data-observe-action]'); if (!button || button.disabled || !mount.contains(button)) return;
    if(button.dataset.observeAction==='follow-live'){state.followLive=!state.followLive;if(state.followLive){state.displayedPinned=null;state.pinnedSignature='';state.feedSignature='';}update();return;}
    const view = selection.model(getSnapshot()); state.error = '';
    if (button.dataset.observeAction === 'stop') {
      if (!view.active || !onStop || ['requesting', 'requested'].includes(state.stopRequests.get(view.run.id)?.phase)) return;
      const request = { phase: 'requesting' }; state.stopRequests.set(view.run.id, request); update();
      try { await onStop(view.run.id, { throwOnError: true }); if (state.stopRequests.get(view.run.id) === request) request.phase = 'requested'; }
      catch (error) { if (state.stopRequests.get(view.run.id) === request) { request.phase = 'failed'; request.error = String(error?.message || 'The Stop request failed.').slice(0, 250); } }
      update(); return;
    }
    if(button.dataset.observeAction==='receipt-conversation'){
      const receipt=observeExternalActions(view.run).receipts.find(value=>value.id===button.dataset.receiptId);
      if(!receipt?.sourceRunId)return;
      const version=state.selectionVersion,runId=state.runId,current=()=>state.entered&&state.selectionVersion===version&&state.runId===runId;
      try{await onOpenRun?.(receipt.sourceRunId,'mission');}catch(error){if(current())state.error=String(error.message||'Could not open the receipt conversation.').slice(0,250);}if(current())update();return;
    }
    try { if(button.dataset.observeAction==='workflow')await onOpenWorkflow?.(view.run?.id,button.dataset.nodeId); if (button.dataset.observeAction === 'conversation') await onOpenRun?.(view.run?.id, 'mission'); if (button.dataset.observeAction === 'browser') await onBrowser?.(); if (button.dataset.observeAction === 'desktop') await onDesktop?.(); if (button.dataset.observeAction === 'edit-steps') await onEditSteps?.(view.run); }
    catch (error) { state.error = String(error.message || 'The action could not be completed.').slice(0, 250); } update();
  };
  const keydown = event => {
    const tab = event.target.closest?.('[data-observe-surface]'); if (!tab || !mount.contains(tab) || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const ids = Object.keys(observeSurfaces).filter(id => api || id === 'workflow'), index = ids.indexOf(tab.dataset.observeSurface); if (index < 0) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    selectSurface(ids[next], { focus: true });
  };
  const toggle = event => {if(!state.entered)return;const step=event.target?.dataset?.observePlanStep;if(step){if(event.target.open)state.openPlanSteps.add(step);else state.openPlanSteps.delete(step);return;}const receipt=event.target?.dataset?.observeReceipt;if(receipt){if(event.target.open)state.openReceipts.add(receipt);else state.openReceipts.delete(receipt);return;}const key = event.target?.dataset?.observeOutput; if (key) { if (event.target.open) state.openOutputs.add(key); else state.openOutputs.delete(key); } };
  const inspect=event=>{if(event.target?.closest?.('[data-observe-action="follow-live"]'))return;if(event.target?.closest?.('#observe-content'))holdLiveView();};
  const scrollChanged=event=>{if(event.target!==$('.observe-scroll'))return;const top=event.target.scrollTop;if(state.programmaticScrollTop!==null&&Math.abs(top-state.programmaticScrollTop)<2){state.programmaticScrollTop=null;return;}state.programmaticScrollTop=null;holdLiveView();};
  mount.addEventListener('focusin',inspect);mount.addEventListener('wheel',inspect,{passive:true});mount.addEventListener('scroll',scrollChanged,true);
  mount.addEventListener('change', change); mount.addEventListener('click', click); mount.addEventListener('keydown', keydown); mount.addEventListener('toggle', toggle, true);
  return { update, handleEvent, leave, selectSurface, enter({ tabId, focusPage = false, chatGPTConversation = false } = {}) {
    const selecting = state.selecting, exactTab = typeof tabId === 'string' && Boolean(tabId);
    leave(); selection.enter({ preserveSelection: selecting });
    if (exactTab && api) { state.surface = 'browser'; state.surfaceChosen = true; }
    else if (!state.surfaceChosen) state.surface = selection.model(getSnapshot()).run ? 'workflow' : api ? 'browser' : 'workflow';
    state.entered = true; state.error = ''; state.focusPage = exactTab && focusPage === true; applySurface();
    if (state.focusPage) { state.surfaceScroll.browser = 0; setScroll(0); }
    const entering = state.surface === 'browser' ? containedBrowser?.enter({ ...(exactTab ? { tabId } : {}), focusPage: state.focusPage, chatGPTConversation }) : state.surface === 'applications' ? applicationSessions?.enter() : undefined;
    state.timer = setInterval(() => { if (mount.isConnected) update(); else leave(); }, 1000); state.timer.unref?.(); update();
    // Ordinary Activity entry has always rendered and subscribed synchronously.
    // Only the sign-in handoff needs to await the owned page's first capture.
    if (!state.focusPage) return entering;
    const selectionVersion = state.selectionVersion;
    return Promise.resolve(entering).then(() => { if (state.entered && selectionVersion === state.selectionVersion && state.focusPage && state.surface === 'browser') setScroll(0); });
  }, destroy() { leave(); state.stopRequests.clear(); containedBrowser?.destroy(); applicationSessions?.destroy(); mount.removeEventListener('change', change); mount.removeEventListener('click', click); mount.removeEventListener('keydown', keydown); mount.removeEventListener('toggle', toggle, true);mount.removeEventListener('focusin',inspect);mount.removeEventListener('wheel',inspect);mount.removeEventListener('scroll',scrollChanged,true); } };
}

