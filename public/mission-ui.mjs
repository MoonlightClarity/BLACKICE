import { missionModels, latestMissionActivity, missionDesktopPreference, missionMilestones } from './mission-model.mjs';
import { renderMarkdown, runMetrics } from './editor-model.mjs';
import { renderContextStatus, renderContextFields, readContextFields } from './context-ui.mjs';
import { STARTER_PROMPTS, starterPrompt, welcomeReadiness, workingFolderLabel, runtimeConnectionFeedback } from './composer-helpers.mjs';
import { reasoningChoices, reasoningSupport, reasoningLabel, reasoningSelectionSupported } from './reasoning-model.mjs';
import { initAttachmentsUI } from './attachments-ui.mjs';
import { mergeMissionDrafts } from './draft-store.mjs';
import { initConversationMenu } from './conversation-menu.mjs';
import { initModelPicker } from './model-picker.mjs';
import { isChatModeModel, CHAT_MODE_RETIRED_MESSAGE, recordedResponseRoutes } from './model-routes.mjs';
import {modelToolCapability,renderToolIssues} from './tool-outcomes-model.mjs';
import { taskTitle } from './task-title.mjs';
import { sidebarConversations, sidebarGroups, renderSidebarGroups } from './sidebar-model.mjs';
import { createConversationSearch, searchedSidebarConversations, searchMatchLabel } from './conversation-search.mjs';
import { createConversationAttention, atConversationEnd, captureConversationScroll, restoreConversationScroll } from './conversation-attention.mjs';
import { renderTaskState, renderTaskFiles, bindTaskStateEvents } from './task-state-ui.mjs';
import { initTaskPlanUI } from './task-plan-ui.mjs';
import { taskPlanView, savedPlanNotes } from './task-plan-model.mjs';
import { PLANNING_MODES, PLANNING_MODE_OPTIONS, planningModeDescription, planningEffortIntent } from './planning-mode.mjs';
import { isActiveRun, isSettlingRun, conversationRecovery, createRegisteredArtifactResolver, conversationId, conversationRuns, conversationSidebarItems, selectedConversationModel, selectedConversationContext, selectedConversationEffort, selectedConversationPlanDetail, selectedConversationPlanningMode, conversationPlanningConfig, conversationReasoningChoice, conversationPlanDetails, conversationEfforts, restoreConversationDrafts, searchConversations, mergeConversationRuns, conversationTurn, conversationAgents, runUserText, shouldSendConversationKey } from './conversation-model.mjs';

export function initMissionUI({ mount, getSnapshot, onStart, onQueue, onStopAll, onCapture, onInbox, onArtifact, api, pickFiles, onOpenRun, onContinue, onRetry, onStop, onDirect, onStudio, onSchedule, onRepeatTask, onSwarm, onConnections, onProjects, onOpenPlanning, onRunLimits, onPrompts, onSavePrompt, onAgent, onLearning, onCompact, onFeedback, onBrowser, onKnowledge, onDesktop, onWorkspace, onOpenBrowserOS, onObserve, onCopy, pickFolder, escape, icon, toast }) {
  const $ = selector => mount.querySelector(selector), NEW = 'new';
  const attention = createConversationAttention(), readingPositions = new Map(), planViews = new Map(), stopRequests = new Map();
  const composerRequests = new Map(), composerErrors = new Map(), queueReceipts = new Map();
  if (!document.getElementById('relay-conversation-styles')) { const link = document.createElement('link'); link.id = 'relay-conversation-styles'; link.rel = 'stylesheet'; link.href = '/conversation.css'; document.head.append(link); }
  if (!document.getElementById('relay-model-picker-styles')) { const link = document.createElement('link'); link.id = 'relay-model-picker-styles'; link.rel = 'stylesheet'; link.href = '/model-picker.css'; document.head.append(link); }
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('relay.mission.draft') || '{}') || {}; } catch {}
  const restored = restoreConversationDrafts(saved);
  const state = { prefs: restored.prefs, drafts: restored.drafts, contextErrors: {}, search: '', key: NEW, runId: null, observedRunId: null, forceNew: false, cache: [], summaries: { active: [], archived: [], deleted: [] }, historyState: 'active', summaryVersion: 0, summaryError: '', summaryRetrying: false, managing: false, historyLoaded: new Set(), historyPending: new Set(), historyError: '', truncated: false, loading: false, selecting: false, renaming: false, pendingFiles: false, feedback: {}, modelsSignature: '', viewKey: null, sidebarSignature: '', selectedAgent: null, autoScroll: true,
    // Controls reflect the selected draft. Transport work keeps its original owner
    // when the user reads another conversation or opens the New chat draft.
    get sending() { return composerRequests.get(this.key)?.kind === 'send'; },
    get capturing() { return composerRequests.get(this.key)?.kind === 'capture'; },
    get error() { return composerErrors.get(this.key) || ''; },
    set error(value) { if (value) composerErrors.set(this.key, value); else composerErrors.delete(this.key); },
    get lastQueued() { return queueReceipts.get(this.key) || null; },
    set lastQueued(value) { if (value) queueReceipts.set(this.key, value); else queueReceipts.delete(this.key); },
  };
  if (!state.drafts || typeof state.drafts !== 'object' || Array.isArray(state.drafts)) state.drafts = {};
  state.drafts[NEW] ||= { task: '', attachmentIds: [] };
  try { state.forceNew = localStorage.getItem('relay.mission.newTask') === 'true' || Boolean(state.drafts[NEW].task?.trim()); } catch {}
  const draft = () => { if (!state.drafts[state.key] || typeof state.drafts[state.key] !== 'object' || Array.isArray(state.drafts[state.key])) state.drafts[state.key] = { task: '', attachmentIds: [] }; const value = state.drafts[state.key]; if (typeof value.task !== 'string') value.task = ''; if (!Array.isArray(value.attachmentIds)) value.attachmentIds = []; return value; };
  const allRuns = snapshot => mergeConversationRuns(state.cache, snapshot.runs, snapshot.currentRun ? [snapshot.currentRun] : []);
  const activeRun = snapshot => isActiveRun(snapshot.currentRun) ? snapshot.currentRun : snapshot.runs.find(isActiveRun);
  const family = snapshot => { if (state.forceNew || !state.runId) return []; const runs = allRuns(snapshot), selected = runs.find(run => run.id === state.runId); return selected ? conversationRuns(runs, selected) : []; };
  const latest = snapshot => family(snapshot).at(-1) || null;
  function stopNotice(run) {
    if (run?.status === 'cancelled' && run.settled !== true) return { phase: 'stopping', text: 'Stopping… Waiting for active work to finish. Your draft is kept.' };
    if (isSettlingRun(run)) return { phase: 'settling', text: run.status === 'failed' ? 'The response failed. Waiting for active work to finish before you can retry.' : 'Finishing… Waiting for active work to finish before you can reply.' };
    const request = isActiveRun(run) && stopRequests.get(run.id);
    if (!request) return null;
    if (request.phase === 'failed') return { phase: 'failed', text: 'Stop was not confirmed. The task may still be running. Try Stop again.', error: request.error };
    return { phase: request.phase, text: request.phase === 'requesting' ? 'Requesting Stop… The task may still be running.' : 'Stop requested. Waiting for active work to finish. Your draft is kept.' };
  }
  async function stopResponse(run) {
    if (!run || !isActiveRun(run) || typeof onStop !== 'function' || ['requesting', 'requested'].includes(stopRequests.get(run.id)?.phase)) return;
    const request = { phase: 'requesting' };
    stopRequests.set(run.id, request); update();
    try {
      await onStop(run.id, { throwOnError: true });
      if (stopRequests.get(run.id) === request) request.phase = 'requested';
    } catch (error) {
      if (stopRequests.get(run.id) === request) { request.phase = 'failed'; request.error = String(error?.message || 'The Stop request could not be completed.'); }
    } finally { update(); }
  }
  const elapsed = ms => ms == null ? '' : ms < 1000 ? '<1s' : ms < 60000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60000)}m`;
  const draftSnapshot = () => ({ ...state.prefs, task: draft().task, attachmentIds: draft().attachmentIds, conversationDrafts: state.drafts });
  let draftBaseline = structuredClone(draftSnapshot());
  const readStoredDrafts = () => { const value = JSON.parse(localStorage.getItem('relay.mission.draft') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; };
  function persist(options) { try { const current = draftSnapshot(), merged = mergeMissionDrafts(readStoredDrafts(), draftBaseline, current, options); localStorage.setItem('relay.mission.draft', JSON.stringify(merged)); draftBaseline = structuredClone(current); $('#mission-draft-state').textContent = ''; } catch { $('#mission-draft-state').textContent = 'Draft kept in this window'; } }
  function restoreStoredDraft(key) {
    try {
      const stored = readStoredDrafts(), merged = mergeMissionDrafts(stored, draftBaseline, draftSnapshot()), value = merged.conversationDrafts[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) state.drafts[key] = value;
      if (stored.conversationDrafts?.[key]) draftBaseline.conversationDrafts[key] = structuredClone(stored.conversationDrafts[key]);
      else delete draftBaseline.conversationDrafts[key];
    } catch {}
  }
  function remember() { try { localStorage.setItem('relay.mission.newTask', String(state.forceNew)); if (state.runId) localStorage.setItem('relay.mission.returnRun', state.runId); } catch {} }
  const ownsRequestView = request => !destroyed && !state.selecting && state.key === request.key;
  function consumeRequestDraft(request, { attachments = true, preferences = false } = {}) {
    // Reconcile this origin before consuming it, including edits made in another
    // window while its request was pending or this window read another chat.
    restoreStoredDraft(request.key);
    const original = state.drafts[request.key];
    if (!original) return;
    if (request.receiptId && original.pendingSend?.requestId === request.receiptId) delete original.pendingSend;
    if (original.task === request.submitted.task) original.task = '';
    if (attachments) original.attachmentIds = (original.attachmentIds || []).filter(id => !request.config.attachmentIds.includes(id));
    if (preferences && request.key === NEW) for (const field of ['model', 'context', 'effort', 'planDetail', 'planningMode']) {
      if (JSON.stringify(original[field]) === JSON.stringify(request.submitted[field])) delete original[field];
    }
  }
  mount.classList.add('conversation-workspace');
  try { if (localStorage.getItem('relay.ui.sidebar.collapsed') !== 'false') mount.classList.add('sidebar-collapsed'); } catch { mount.classList.add('sidebar-collapsed'); }
  mount.innerHTML = `
    <header class="conversation-header">
      <button class="conversation-header-button conversation-new-top" data-mission-action="new-task" title="New chat" aria-label="New chat">${icon('plus', 17)}<span>New chat</span></button>
      <button id="conversation-sidebar-toggle" class="conversation-header-button" data-mission-action="sidebar" aria-label="Toggle conversation list" aria-controls="conversation-sidebar" aria-expanded="false" title="Toggle conversations">${icon('layers', 15)}<span>Chats</span></button>
      <button id="conversation-rename-title" class="conversation-title-action" type="button" data-mission-action="rename-conversation" aria-label="Rename chat" title="Rename chat" hidden><span id="conversation-title" class="conversation-title"></span><svg class="conversation-title-edit" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="m10.5 2.5 3 3M3 10l-.5 3.5L6 13l7-7a2.1 2.1 0 0 0-3-3Z"/></svg></button>
      <button id="conversation-plan-toggle" class="conversation-header-button" type="button" data-mission-action="toggle-plan" aria-controls="mission-plan" aria-expanded="true" title="Hide task plan" hidden>${icon('plan', 15)}<span>Plan</span></button>
      <details id="conversation-actions" class="conversation-actions" hidden><summary>Conversation ${icon('down', 11)}</summary><div id="conversation-action-list" class="conversation-action-list"></div></details>
      <button id="conversation-active-button" class="conversation-header-button conversation-active-button" data-mission-action="working-chats" hidden></button>
      <button id="conversation-queue-button" class="conversation-header-button conversation-queue-button" data-mission-action="inbox" hidden></button>
    </header>
    <form id="conversation-rename" class="conversation-rename" hidden><label for="conversation-name">Chat name</label><input id="conversation-name" maxlength="120" required autocomplete="off" aria-describedby="conversation-rename-error"><button id="conversation-rename-save" type="submit">Save</button><button id="conversation-rename-cancel" type="button" data-mission-action="cancel-rename">Cancel</button><span id="conversation-rename-error" role="alert" hidden></span></form>
    <div class="conversation-shell">
      <button id="conversation-sidebar-scrim" class="conversation-sidebar-scrim" type="button" data-mission-action="close-sidebar" aria-label="Close conversation list" tabindex="-1" hidden></button>
      <aside id="conversation-sidebar" class="conversation-sidebar" aria-label="Conversations">
        <label class="conversation-history-filter"><span class="sr-only">Conversations</span><select id="conversation-history-state" aria-label="Conversation history"><option value="active">Chats</option><option value="unread">Unread</option><option value="working">Working</option><option value="archived">Archived</option><option value="deleted">Trash</option></select></label>
        <button id="conversation-stop-all" class="conversation-stop-all" data-mission-action="stop-all" hidden>Stop all chats</button>
        <label class="conversation-search">${icon('search', 13)}<input id="conversation-search" type="search" placeholder="Search chats" aria-label="Search chat messages and file names" autocomplete="off" maxlength="200"></label>
        <p id="conversation-sidebar-error" class="conversation-sidebar-error" role="alert" hidden><span id="conversation-sidebar-error-text"></span> <button id="conversation-sidebar-retry" class="conversation-header-button" type="button" data-mission-action="retry-chats">Retry</button></p><div id="conversation-search-meta" class="conversation-search-meta" hidden><span id="conversation-search-status" role="status" aria-live="polite"></span><button id="conversation-search-retry" type="button" data-mission-action="retry-search" hidden>Retry search</button></div>
        <div id="conversation-list" class="conversation-list"></div><button id="conversation-search-more" class="conversation-search-more" type="button" data-mission-action="more-search" hidden>More results</button>
      </aside>
      <div id="conversation-task-layout" class="conversation-task-layout plan-empty" data-plan-view="plan">
        <div id="conversation-plan-tabs" class="conversation-plan-tabs" role="tablist" aria-label="Task workspace" hidden>
          <button type="button" id="conversation-plan-tab" role="tab" data-mission-action="plan-view" data-view="plan" data-plan-view="plan" aria-controls="mission-plan" aria-selected="true">${icon('plan', 15)}<span>Plan</span></button>
          <button type="button" id="conversation-dialogue-tab" role="tab" data-mission-action="plan-view" data-view="conversation" data-plan-view="conversation" aria-controls="conversation-dialogue" aria-selected="false" tabindex="-1">${icon('text', 15)}<span>Conversation</span><i id="conversation-tab-attention" aria-label="New response" hidden></i></button>
        </div>
        <aside id="mission-plan" tabindex="-1" aria-label="Task plan"></aside>
      <main id="conversation-dialogue" class="conversation-main">
        <div id="conversation-return" class="conversation-return" hidden></div>
        <div id="conversation-match-notice" class="conversation-match-notice" role="status" hidden><span id="conversation-match-label"></span><button type="button" data-mission-action="clear-match" aria-label="Dismiss search match">${icon('close', 13)}</button></div>
        <div class="conversation-reading">
        <div id="conversation-scroll" class="conversation-scroll" tabindex="-1"><div id="conversation-timeline" class="conversation-timeline"></div></div>
        <button id="conversation-jump" class="conversation-jump" data-mission-action="latest" hidden>${icon('down', 13)}Latest</button>
        </div>
        <div id="conversation-history-notice" class="conversation-history-notice" hidden></div>
        <section id="conversation-browser-signin" class="conversation-browser-signin" role="status" hidden></section>
        <section class="conversation-compose">
          <div id="conversation-composer-agent" class="conversation-composer-agent" hidden></div>
          <div id="conversation-compose-status" class="conversation-compose-status" hidden><span id="conversation-connection-progress" class="connection-progress-spinner" aria-hidden="true" hidden></span><span id="conversation-composer-status" class="conversation-composer-status" role="status" aria-live="polite" aria-atomic="true"></span><button id="conversation-status-action" type="button" hidden></button></div>
          <form id="mission-form" class="conversation-composer">
            <label for="mission-task" class="sr-only">Task or message</label>
            <textarea id="mission-task" name="message" rows="2" maxlength="50000" required placeholder="Ask a question or assign a task…" aria-describedby="conversation-submit-hint" title="Ask a question or assign a task · drop files or paste a screenshot"></textarea>
            <div id="mission-attachments"></div>
            <div class="conversation-compose-settings" role="group" aria-label="Response settings">
              <label class="conversation-model-choice"><span>Model</span><select id="mission-model" aria-label="Model for next message"></select></label>
              <label class="conversation-planning-choice"><span>Planning</span><select id="mission-planning-mode" aria-label="Planning for next response" aria-describedby="mission-planning-note">${PLANNING_MODE_OPTIONS.map(option => `<option value="${option.value}"${option.value === 'auto' ? ' selected' : ''}>${option.label}</option>`).join('')}</select><span id="mission-planning-note" class="sr-only"></span></label>
               <button id="conversation-folder-chip" class="conversation-folder-chip" type="button" data-mission-action="workspace" title="Change working folder in Settings">Working folder</button>
            </div>
            <div class="conversation-compose-bar">
              <button id="mission-capture-button" class="conversation-attach-button" type="button" data-mission-action="capture" aria-label="Save message for later" title="Save this message to the task inbox">${icon('inbox', 15)}<span>Save for later</span></button>
              <button id="conversation-attach" class="conversation-attach-button" type="button" data-mission-action="attach" title="Attach files" aria-label="Attach files">${icon('paperclip', 15)}<span>Attach</span></button>
              <div class="conversation-send-actions">
              <button id="conversation-stop" class="conversation-stop" type="button" data-mission-action="stop" aria-label="Stop current response" title="Stop" hidden>${icon('stop', 13)}<span>Stop</span></button>
              <button id="mission-start-button" class="conversation-send" type="submit" aria-label="Send message" title="Send · Enter (Shift+Enter for a new line)">${icon('up', 16)}<span class="conversation-send-label">Send</span></button>
              </div>
            </div>
          </form>
          <div class="conversation-compose-footer"><span id="conversation-submit-hint"><kbd>Enter</kbd> to send <span aria-hidden="true">·</span> <kbd>Shift + Enter</kbd> for a new line</span><span id="mission-draft-state" class="conversation-draft-state"></span></div>
          <p id="mission-error" class="conversation-error" role="alert"></p>
        </section>
      </main>
      </div>
    </div>`;
  let desktopPlanCollapsed = true;
  try { desktopPlanCollapsed = localStorage.getItem('relay.ui.plan.collapsed') !== 'false'; } catch {}
  let attachmentUI, conversationMenu, taskPlanUI, historyRefreshTimer = null, historyRefreshFlight = null, historyRefreshRequested = false, historyWaiters = [], destroyed = false, promptUndo = null, promptDraftVersion = 0, taskSelectionPending = false, planVisible = false, planEnlarged = false, planView = 'conversation', planKey = '', workbenchIntent = 0;
  const modelPicker = initModelPicker({ select: $('#mission-model'), onConnect: onConnections });
  if (onPrompts) $('#mission-capture-button').insertAdjacentHTML('afterend', `<button type="button" id="mission-outline" class="conversation-attach-button" data-mission-action="prompts" title="Prompt templates">${icon('text', 13)}<span>Prompts</span></button><button type="button" id="mission-outline-undo" class="conversation-outline-undo" data-mission-action="undo-prompt" title="Restore the previous draft" hidden>Undo draft</button>`);
  $('.conversation-model-choice').insertAdjacentHTML('afterend', '<details id="mission-context" class="conversation-context-choice"><summary title="Reasoning settings"><span class="conversation-setting-label">Reasoning</span><span class="conversation-setting-value">Default</span></summary><div class="conversation-context-panel"><label class="field"><span class="field-label">Reasoning level</span><select id="mission-effort" aria-label="Reasoning for next response"></select><span id="mission-effort-note" class="field-help"></span></label><details class="conversation-context-advanced"><summary>Advanced context capacity</summary><div id="mission-context-fields"></div></details><p class="conversation-context-help">BLACKICE handles routine context compaction automatically.</p><button type="button" data-mission-action="reset-context">Use saved chat context</button><p id="mission-context-error" role="alert" hidden></p></div></details>');
  $('#mission-form').insertAdjacentHTML('afterend', '<p id="mission-reasoning-warning" class="conversation-error" role="status" hidden></p>');
  $('#mission-form').insertAdjacentHTML('beforebegin', '<div id="conversation-state-banner" class="conversation-state-banner" hidden></div><div id="conversation-queue-receipt" class="conversation-queue-receipt" role="status" hidden></div>');
  function autoSize() { const textarea = $('#mission-task'); textarea.style.height = 'auto'; textarea.style.height = `${Math.min(180, Math.max(54, textarea.scrollHeight))}px`; }
  const narrowSidebar = () => window.innerWidth < 980;
  const narrowPlan = () => window.innerWidth < 1180;
  const chatSearch = createConversationSearch({ api, onChange: () => { state.sidebarSignature = ''; renderSidebar(getSnapshot()); } });
  const searchScope = () => state.historyState === 'deleted' ? 'deleted' : state.historyState === 'archived' ? 'archived' : state.historyState === 'working' ? 'active' : 'all';
  const conversationIsVisible = () => !planEnlarged && (!planVisible || !narrowPlan() || planView === 'conversation');
  function workbenchSnapshot(snapshot) {
    const run = latest(snapshot), nodes = Object.values(run?.nodes || {}), planning = nodes.find(node => node.planning?.status === 'recorded')?.planning || nodes.find(node => node.planning?.status === 'preparing')?.planning || nodes.find(node => node.planning)?.planning;
    const taskState = run?.taskState;
    const off = planning?.status === 'off' || planning?.mode === 'off' || run?.planningMode === 'off';
    const hasSavedPlan = Boolean(taskState?.steps?.length || savedPlanNotes(taskState).length);
    return { run, taskState, planning, defaultView: 'conversation', visible: Boolean(run && (off ? hasSavedPlan : taskState?.planVersion === 1 || planning && planning.status !== 'legacy')) };
  }
  function renderTaskWorkbench(snapshot) {
    const { run, taskState, planning, visible, defaultView } = workbenchSnapshot(snapshot), layout = $('#conversation-task-layout'), tabs = $('#conversation-plan-tabs'), plan = $('#mission-plan'), dialogue = $('#conversation-dialogue');
    const key = run?.taskId || taskState?.taskId || run?.id || NEW;
    if (planEnlarged && (key !== planKey || !visible)) taskPlanUI?.setEnlarged(false, { focusControl: false });
    planKey = key; planVisible = visible; planView = planEnlarged ? 'plan' : planViews.get(key) || defaultView;
    layout.classList.toggle('plan-empty', !visible); layout.dataset.planView = planView; layout.dataset.planEnlarged = String(planEnlarged);
    const narrow = narrowPlan(), hidePlan = !visible || !planEnlarged && (narrow ? planView !== 'plan' : desktopPlanCollapsed), hideDialogue = visible && (planEnlarged || narrow && planView !== 'conversation');
    layout.classList.toggle('plan-collapsed', visible && !narrow && desktopPlanCollapsed && !planEnlarged);
    const planToggle = $('#conversation-plan-toggle');
    planToggle.hidden = !visible || narrow; planToggle.setAttribute('aria-expanded', String(!hidePlan));
    planToggle.title = hidePlan ? 'Show task plan' : 'Hide task plan'; planToggle.setAttribute('aria-label', planToggle.title);
    tabs.hidden = !visible || !narrow; plan.hidden = hidePlan; dialogue.hidden = hideDialogue; plan.inert = hidePlan; dialogue.inert = hideDialogue;
    plan.setAttribute('aria-hidden', String(hidePlan)); dialogue.setAttribute('aria-hidden', String(hideDialogue));
    for (const [pane, tab, name] of [[plan, $('#conversation-plan-tab'), 'plan'], [dialogue, $('#conversation-dialogue-tab'), 'conversation']]) {
      tab.setAttribute('aria-selected', String(planView === name)); tab.tabIndex = planView === name ? 0 : -1;
      if (visible && narrow) { pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', tab.id); }
      else { pane.removeAttribute('role'); pane.removeAttribute('aria-labelledby'); }
    }
    const editable = Boolean(run && selectedState() === 'active' && !state.sending && !state.capturing && !state.selecting && !state.managing && !state.historyError), saved = taskPlanView(taskState, { runStatus: run?.status });
    taskPlanUI?.update({ taskState, runId: run?.id, runStatus: run?.status, settled: run?.settled === true, goal: run ? runUserText(run) : '', planningMode: planning?.mode || run?.planningMode || 'auto', planningAvailable: planning?.status !== 'unavailable', planningStatus: planning?.status, planningMessage: planning?.message, canGuide: editable, canSaveMethod: editable && taskState?.plan?.origin === 'agent', canContinue: editable && (Boolean(saved.focus) || Boolean(taskState?.checkpoint?.nextAction)) && planning?.status !== 'unavailable', canRepeat: editable && Boolean(onRepeatTask) });
    const focused = document.activeElement;
    if (visible && (hidePlan && plan.contains(focused) || hideDialogue && dialogue.contains(focused))) $(narrow ? planView === 'plan' ? '#conversation-plan-tab' : '#conversation-dialogue-tab' : '#conversation-plan-toggle').focus({ preventScroll: true });
    $('#conversation-tab-attention').hidden = !visible || !run || !attention.unread(conversationId(run, allRuns(snapshot)));
  }
  function setWorkbenchView(value, { focusTab = false, focusComposer = false } = {}) {
    if (!['plan', 'conversation'].includes(value)) return;
    workbenchIntent++;
    if (conversationIsVisible() && state.viewKey) readingPositions.set(state.viewKey, captureConversationScroll($('#conversation-scroll'), $('#conversation-timeline'), state.autoScroll));
    if (value === 'conversation') taskPlanUI?.setEnlarged(false, { focusControl: false });
    if (value === 'plan' && !narrowPlan() && desktopPlanCollapsed) { desktopPlanCollapsed = false; try { localStorage.setItem('relay.ui.plan.collapsed', 'false'); } catch {} }
    planViews.set(planKey, value); planView = value; renderTaskWorkbench(getSnapshot());
    if (conversationIsVisible()) {
      const position = readingPositions.get(state.viewKey);
      if (state.autoScroll) scrollLatest(true); else restoreConversationScroll($('#conversation-scroll'), $('#conversation-timeline'), position);
      renderSidebar(getSnapshot());
    }
    if (focusComposer) $('#mission-task').focus({ preventScroll: true });
    else if (focusTab) $(value === 'plan' ? '#conversation-plan-tab' : '#conversation-dialogue-tab').focus({ preventScroll: true });
  }
  function renderSidebarVisibility() {
    const narrow = narrowSidebar(), expanded = narrow ? mount.classList.contains('sidebar-open') : !mount.classList.contains('sidebar-collapsed');
    const toggle = $('#conversation-sidebar-toggle'), sidebar = $('#conversation-sidebar');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? 'Hide conversation list' : 'Show conversation list');
    toggle.title = expanded ? 'Hide conversations' : 'Show conversations';
    sidebar.inert = !expanded;
    sidebar.setAttribute('aria-hidden', String(!expanded));
    $('#conversation-sidebar-scrim').hidden = !narrow || !expanded;
  }
  function setSidebarOpen(expanded) {
    if (narrowSidebar()) mount.classList.toggle('sidebar-open', expanded);
    else {
      mount.classList.toggle('sidebar-collapsed', !expanded);
      try { localStorage.setItem('relay.ui.sidebar.collapsed', String(!expanded)); } catch {}
    }
    renderSidebarVisibility();
  }
  function closeMobileSidebar({ restoreFocus = false } = {}) {
    if (!narrowSidebar() || !mount.classList.contains('sidebar-open')) return;
    const focusInside = $('#conversation-sidebar').contains(document.activeElement);
    mount.classList.remove('sidebar-open');
    renderSidebarVisibility();
    if (restoreFocus) $('#conversation-sidebar-toggle').focus({ preventScroll: true });
    else if (focusInside) $('#mission-task').focus({ preventScroll: true });
  }
  const resizeSidebar = () => {
    if (!narrowSidebar()) mount.classList.remove('sidebar-open');
    renderSidebarVisibility(); renderTaskWorkbench(getSnapshot());
  };
  window.addEventListener('resize', resizeSidebar);
  function switchDraft(key) { if (state.key === key) return; promptDraftVersion++; restoreStoredDraft(key); state.key = key; $('#mission-task').value = draft().task || ''; state.selectedAgent = draft().agentId || null; attachmentUI?.reset({ cancelPending: false }); attachmentUI?.refresh(); autoSize(); }
  attachmentUI = initAttachmentsUI({ mount: $('#mission-attachments'), api, getDraftKey: () => state.key, getIds: (key = state.key) => state.drafts[key]?.attachmentIds || [], setIds: (ids, key = state.key) => { const value = state.drafts[key]; if (!value) return; delete value.pendingSend; value.attachmentIds = ids; persist(); }, canEdit: () => !state.sending && !state.capturing && !state.selecting, onPendingChange: pending => { state.pendingFiles = pending; renderComposer(getSnapshot()); }, pickFiles, escape, icon, toast });
  function resizePlan(enlarged) {
    if (enlarged && conversationIsVisible() && state.viewKey) readingPositions.set(state.viewKey, captureConversationScroll($('#conversation-scroll'), $('#conversation-timeline'), state.autoScroll));
    planEnlarged = enlarged; renderTaskWorkbench(getSnapshot());
    if (!enlarged && conversationIsVisible()) {
      if (state.autoScroll) scrollLatest(true); else restoreConversationScroll($('#conversation-scroll'), $('#conversation-timeline'), readingPositions.get(state.viewKey));
    }
    renderSidebar(getSnapshot());
  }
  taskPlanUI = initTaskPlanUI({ mount: $('#mission-plan'), onArtifact, onOpenPlanning, onEnlargedChange: resizePlan, onDraftDirection: draftPlanDirection, onContinue: value => prepareNextAction(latest(getSnapshot()), value), onRepeat: value => repeatSavedTask(latest(getSnapshot()), value), onError: error => toast(error.message, true) });
  bindTaskStateEvents(mount, { onArtifact, onError: error => toast(error.message, true) });
  // Catalog events can arrive for every saved run. Keep one request in flight and
  // invalidate it as soon as a newer event arrives, rather than merging stale buckets.
  function refreshHistory({ immediate = false } = {}) {
    if (destroyed) return Promise.resolve(false);
    state.summaryVersion++; historyRefreshRequested = true;
    const completion = new Promise(resolve => historyWaiters.push(resolve));
    if (immediate && historyRefreshTimer) { clearTimeout(historyRefreshTimer); historyRefreshTimer = null; }
    if (!historyRefreshFlight && !historyRefreshTimer) {
      if (immediate) void runHistoryRefresh();
      else historyRefreshTimer = setTimeout(() => { historyRefreshTimer = null; void runHistoryRefresh(); }, 80);
    }
    return completion;
  }
  async function runHistoryRefresh() {
    if (destroyed || historyRefreshFlight || !historyRefreshRequested) return;
    historyRefreshRequested = false;
    const version = state.summaryVersion, buckets = ['active', 'archived', 'deleted'];
    historyRefreshFlight = Promise.allSettled(buckets.map(bucket => api(`/api/conversations?state=${bucket}`)));
    const results = await historyRefreshFlight;
    if (!destroyed && version === state.summaryVersion) {
      const failure = results.find(result => result.status === 'rejected');
      if (!failure) {
        state.summaries = Object.fromEntries(results.map((result, index) => { const data = result.value; return [buckets[index], (Array.isArray(data) ? data : data.conversations || data.items || []).map(entry => ({ ...entry, state: buckets[index] }))]; }));
        const items = attentionItems(getSnapshot()); attention.observe(items, { catalogIds: items.map(item => item.id) });
        const catalogSignature = JSON.stringify(buckets.map(bucket => state.summaries[bucket].map(item => [item.taskId || item.rootId || item.id, item.updatedAt, item.state, item.title])));
        if (state.searchCatalogSignature !== catalogSignature) { state.searchCatalogSignature = catalogSignature; if (state.search.trim()) void chatSearch.refresh(); }
      }
      state.summaryError = failure ? failure.reason?.message || 'History could not load.' : '';
      const snapshot = getSnapshot(); renderConversationTitle(snapshot); renderSidebar(snapshot); renderComposer(snapshot); renderConversationActions(snapshot);
    }
    historyRefreshFlight = null;
    if (destroyed) return;
    if (historyRefreshRequested) { historyRefreshTimer = setTimeout(() => { historyRefreshTimer = null; void runHistoryRefresh(); }, 80); }
    else { const waiters = historyWaiters; historyWaiters = []; for (const resolve of waiters) resolve(!state.summaryError); }
  }
  const loadSummaries = () => refreshHistory({ immediate: true });
  async function retryHistory() {
    if (destroyed || state.summaryRetrying || !state.summaryError) return;
    state.summaryRetrying = true; renderSidebarRecovery();
    try {
      // Join any event-triggered refresh instead of invalidating it with a click.
      await (historyRefreshFlight || historyRefreshTimer || historyRefreshRequested ? new Promise(resolve => historyWaiters.push(resolve)) : loadSummaries());
    } finally { state.summaryRetrying = false; if (!destroyed) renderSidebarRecovery(); }
  }
  function selectedState() { if (state.forceNew) return 'active'; for (const bucket of ['deleted', 'archived']) if (state.summaries[bucket].some(entry => (entry.taskId || entry.rootId || entry.id) === state.key || (entry.runId || entry.latestRunId || entry.id) === state.runId)) return bucket; return 'active'; }
  function renderConversationActions(snapshot) {
    const control = $('#conversation-actions'), run = latest(snapshot), bucket = selectedState(), titleButton = $('#conversation-rename-title'); control.hidden = !run; titleButton.hidden = !run; titleButton.disabled = bucket === 'deleted'; titleButton.title = bucket === 'deleted' ? 'Chat in Trash' : 'Rename chat'; titleButton.setAttribute('aria-label', `${bucket === 'deleted' ? 'Chat title' : 'Rename chat'}: ${$('#conversation-title').textContent}`);
    if (!run) { control.open = false; if (!state.renameTarget) $('#conversation-rename').hidden = true; return; }
    const disabled = state.managing, working = family(snapshot).some(isActiveRun), signature = JSON.stringify([run.id, bucket, disabled, working, mount.classList.contains('show-context-diagnostics')]);
    if (control.dataset.signature === signature) return; control.dataset.signature = signature;
    control.querySelector('summary').innerHTML = `<span class="sr-only">${bucket === 'deleted' ? 'Trash actions' : bucket === 'archived' ? 'Archived chat actions' : 'Chat actions'}</span>${icon('more', 17)}`;
    control.querySelector('summary').title = 'Chat actions';
    $('#conversation-action-list').innerHTML = `${bucket === 'active' ? `<button data-mission-action="rename-conversation">Rename</button><button data-mission-action="chat-context">Reasoning &amp; capacity</button><button data-mission-action="context-diagnostics">${mount.classList.contains('show-context-diagnostics')?'Hide context diagnostics':'Show context diagnostics'}</button><button data-mission-action="archive-conversation"${disabled ? ' disabled' : ''}>Archive</button>` : `${bucket === 'archived' ? '<button data-mission-action="rename-conversation">Rename</button>' : ''}<button data-mission-action="restore-conversation"${disabled ? ' disabled' : ''}>Restore conversation</button>`}<a href="/api/conversations/${encodeURIComponent(run.id)}/export?format=markdown" download>Export Markdown</a><a href="/api/conversations/${encodeURIComponent(run.id)}/export?format=json" download>Export JSON</a>${bucket !== 'deleted' ? `<button class="conversation-delete" data-mission-action="delete-conversation"${disabled || working ? ' disabled' : ''}${working ? ' title="Stop this chat before deleting it."' : ''}>Move to Trash</button>` : ''}`;
  }
  function renameFocus(target) {
    const row = [...$('#conversation-list').querySelectorAll('.conversation-list-item')].find(item => item.dataset.conversationId === target?.id);
    const title = $('#conversation-rename-title'), input = $('#mission-task');
    const candidates = [target?.trigger, row, !title.hidden && title, input].filter(Boolean);
    const next = candidates.find(element => element.isConnected !== false && !element.disabled && !element.closest?.('[hidden],[inert]') && (!element.getClientRects || element.getClientRects().length));
    next?.focus({ preventScroll: true });
  }
  function closeRename({ restoreFocus = true } = {}) {
    const target = state.renameTarget, form = $('#conversation-rename'), owned = form.contains(document.activeElement);
    state.renameTarget = null; form.hidden = true;
    if (restoreFocus && owned) renameFocus(target);
  }
  function beginRename(requestedTarget, trigger) {
    if (destroyed || state.renaming) return false;
    const run = latest(getSnapshot()), target = requestedTarget || (run && conversationTarget(conversationId(run, allRuns(getSnapshot()))));
    const current = target && conversationTarget(target.id);
    if (!current || !['active', 'archived'].includes(current.state)) return false;
    const row = [...$('#conversation-list').querySelectorAll('.conversation-list-item')].find(item => item.dataset.conversationId === current.id);
    state.renameTarget = { ...current, trigger: trigger || row };
    $('#conversation-actions').open = false; closeMobileSidebar();
    const form = $('#conversation-rename'), input = $('#conversation-name'); form.hidden = false; form.setAttribute('aria-busy', 'false'); form.setAttribute('aria-label', `Rename ${current.title}`);
    input.value = current.title; input.readOnly = false; $('#conversation-rename-save').disabled = false; $('#conversation-rename-save').textContent = 'Save'; $('#conversation-rename-cancel').textContent = 'Cancel';
    $('#conversation-rename-error').hidden = true; $('#conversation-rename-error').textContent = '';
    input.focus({ preventScroll: true }); input.select(); return true;
  }
  async function saveRename() {
    const target = state.renameTarget, input = $('#conversation-name'), title = input.value.trim();
    if (destroyed || state.renaming || !target) return;
    const errorView = $('#conversation-rename-error');
    if (!title) { errorView.textContent = 'Enter a chat name.'; errorView.hidden = false; input.focus({ preventScroll: true }); return; }
    state.renaming = true; input.readOnly = true; $('#conversation-rename-save').disabled = true; $('#conversation-rename-save').textContent = 'Saving…'; $('#conversation-rename-cancel').textContent = 'Close'; $('#conversation-rename').setAttribute('aria-busy', 'true'); errorView.hidden = true;
    try {
      const receipt = await api(`/api/conversations/${encodeURIComponent(target.runId)}/rename`, 'POST', { title });
      if (destroyed) return;
      for (const bucket of ['active', 'archived', 'deleted']) state.summaries[bucket] = state.summaries[bucket].map(item => (item.taskId || item.rootId || item.id) === target.id ? { ...item, title: receipt.title || title } : item);
      state.sidebarSignature = '';
      if (state.renameTarget === target) closeRename();
      renderConversationTitle(getSnapshot()); renderSidebar(getSnapshot());
      await loadSummaries();
    } catch (error) {
      if (!destroyed && state.renameTarget === target) { errorView.textContent = error.message || 'The chat could not be renamed. Try again.'; errorView.hidden = false; }
      else if (!destroyed) toast(`Could not rename “${target.title}”. ${error.message || ''}`, true);
    } finally {
      state.renaming = false;
      if (!destroyed && state.renameTarget === target) { input.readOnly = false; $('#conversation-rename-save').disabled = false; $('#conversation-rename-save').textContent = 'Save'; $('#conversation-rename-cancel').textContent = 'Cancel'; $('#conversation-rename').setAttribute('aria-busy', 'false'); }
    }
  }
  function conversationTarget(id, runId) {
    const runs = allRuns(getSnapshot()), entry = ['active', 'archived', 'deleted'].flatMap(bucket => conversationSidebarItems({ summaries: state.summaries, runs, state: bucket })).find(item => item.id === id);
    if (!entry || runId && entry.runId !== runId) return null;
    const working = isActiveRun(entry) || runs.some(run => conversationId(run, runs) === id && isActiveRun(run));
    return { ...entry, working };
  }
  async function manageConversation(action, requestedTarget, { fromPlan = false } = {}) {
    if (destroyed || state.managing) return false;
    const snapshot = getSnapshot(), run = latest(snapshot), target = requestedTarget || (run && conversationTarget(conversationId(run, allRuns(snapshot))));
    if (!target) return false;
    const entry = conversationTarget(target.id, target.runId), allowed = entry && (action === 'archive' ? entry.state === 'active' : action === 'restore' ? entry.state !== 'active' : action === 'delete' && entry.state !== 'deleted');
    if (!entry || entry.state !== target.state || !allowed) { toast('This chat changed. Open its menu again.', true); return false; }
    if (entry.working && action === 'delete') { toast('Stop this chat before deleting it.', true); return false; }
    const id = entry.id, bucket = action === 'restore' ? 'active' : action === 'archive' ? 'archived' : 'deleted';
    state.managing = true; if (!state.forceNew && state.key === id) state.error = ''; $('#conversation-actions').open = false; renderConversationActions(snapshot); renderComposer(snapshot);
    try {
      await api(`/api/conversations/${encodeURIComponent(entry.runId)}/${action}`, 'POST', {}); if (destroyed) return false;
      for (const name of ['active', 'archived', 'deleted']) state.summaries[name] = state.summaries[name].filter(item => (item.taskId || item.rootId || item.id) !== id);
      state.summaries[bucket].push({ ...entry, id: entry.runId, rootId: id, taskId: id, state: bucket });
      if (action === 'restore' && !state.forceNew && state.key === id) state.historyState = 'active';
      toast(fromPlan ? action === 'restore' ? 'Plan restored to Active plans.' : action === 'archive' ? 'Plan archived and removed from Active plans. You can find it in Archive.' : 'Plan moved to Trash. You can restore it there.' : action === 'restore' ? 'Conversation restored.' : action === 'archive' ? 'Conversation archived.' : 'Moved to Trash. You can restore it.'); update(); await loadSummaries(); return true;
    }
    catch (error) { if (destroyed) return false; if (!requestedTarget && !state.forceNew && state.key === id) state.error = error.message; else toast(error.message, true); return false; }
    finally { state.managing = false; if (!destroyed) update(); }
  }
  async function managePlan(action, taskId, runId) {
    if (!['archive', 'delete', 'restore'].includes(action) || !taskId || !runId) return false;
    let target = conversationTarget(taskId, runId);
    if (!target) { await loadSummaries(); target = conversationTarget(taskId, runId); }
    if (!target) { toast('The saved chat for this plan is no longer available. Refresh Planning before trying again.', true); return false; }
    return manageConversation(action, target, { fromPlan: true });
  }
  async function loadHistory(id, force = false) {
    if (!id || !force && (state.historyLoaded.has(id) || state.historyPending.has(id))) return;
    state.historyPending.add(id); state.loading = true; renderHistoryNotice(); renderComposer(getSnapshot());
    try { const data = await api(`/api/conversations/${encodeURIComponent(id)}`); state.cache = mergeConversationRuns(state.cache, data.runs || []); for (const run of data.runs || []) state.historyLoaded.add(run.id); state.historyLoaded.add(id); if (state.runId === id || family(getSnapshot()).some(run => run.id === id)) { state.historyError = ''; state.truncated = data.truncated === true; } }
    catch (error) { if (state.runId === id) state.historyError = error.message; }
    finally { state.historyPending.delete(id); state.loading = state.historyPending.size > 0; update(); }
  }
  function renderHistoryNotice() { const element = $('#conversation-history-notice'); element.hidden = !(state.loading || state.historyError || state.truncated); element.innerHTML = state.historyError ? `${escape(state.historyError)} <button data-mission-action="reload-history">Try again</button>` : state.loading ? 'Loading conversation…' : 'Some older turns are unavailable.'; }
  function attentionItems(snapshot) {
    const runs = allRuns(snapshot), byId = new Map(runs.map(run => [run.id, run]));
    return ['active', 'archived', 'deleted'].flatMap(historyState => sidebarConversations({ summaries: state.summaries, runs, historyState })).map(item => {
      const run = byId.get(item.runId);
      return run ? { ...item, createdAt: run.createdAt, settled: run.settled } : item;
    });
  }
  function markVisibleResponse() {
    if (destroyed || !conversationIsVisible() || state.forceNew || state.selecting || state.searchOpening || state.historyError || state.historyPending.has(state.runId) || !state.historyLoaded.has(state.runId) || document.visibilityState === 'hidden' || document.hasFocus?.() === false || document.getElementById('modal-root')?.childElementCount || mount.hidden || mount.getClientRects && !mount.getClientRects().length || !atConversationEnd($('#conversation-scroll'))) return false;
    const run = latest(getSnapshot());
    return run ? attention.markSeen({ ...run, id: conversationId(run, allRuns(getSnapshot())), runId: run.id }) : false;
  }
  function renderSidebarRecovery() {
    const notice = $('#conversation-sidebar-error'), retry = $('#conversation-sidebar-retry'), visible = Boolean(state.summaryError || state.summaryRetrying);
    if (!visible && document.activeElement === retry) $('#conversation-search').focus({ preventScroll: true });
    notice.hidden = !visible; notice.setAttribute('aria-busy', String(state.summaryRetrying));
    $('#conversation-sidebar-error-text').textContent = state.summaryError || (state.summaryRetrying ? 'Refreshing chats…' : '');
    // Keep the busy button focusable; retryHistory prevents duplicate activation.
    retry.setAttribute('aria-disabled', String(state.summaryRetrying)); retry.textContent = state.summaryRetrying ? 'Retrying…' : 'Retry';
  }
  function renderSearchStatus(result, count) {
    const active = Boolean(state.search.trim()), meta = $('#conversation-search-meta'), status = $('#conversation-search-status'), retry = $('#conversation-search-retry'), more = $('#conversation-search-more');
    $('#conversation-sidebar').dataset.searching = String(active); meta.hidden = !active;
    const pending = ['waiting', 'loading', 'loading-more'].includes(result.status), narrowed = ['working', 'unread'].includes(state.historyState);
    let text = '';
    if (active) text = result.status === 'error' ? `Message search unavailable. ${result.error}`
      : pending ? result.status === 'loading-more' ? 'Loading more matches…' : 'Searching messages and file names…'
      : result.status === 'ready' ? `${narrowed ? count : result.total} ${narrowed ? 'matches in this view' : result.total === 1 ? 'matching chat' : 'matching chats'}${result.hasMore ? ` · ${result.conversations.length} loaded` : ''}${result.truncated ? ' · Some saved history is unavailable.' : ''}` : '';
    if (status.textContent !== text) status.textContent = text;
    if (active && result.status !== 'error' && document.activeElement === retry) $('#conversation-search').focus({ preventScroll: true });
    retry.hidden = !active || result.status !== 'error';
    const moreVisible = active && (result.hasMore || result.status === 'loading-more');
    if (!moreVisible && document.activeElement === more) $('#conversation-search').focus({ preventScroll: true });
    more.hidden = !moreVisible; more.setAttribute('aria-disabled', String(pending || result.status === 'error'));
    more.textContent = result.status === 'loading-more' ? 'Loading…' : 'More results';
    $('#conversation-list').setAttribute('aria-busy', String(active && pending));
  }
  function renderSidebar(snapshot) {
    attention.observe(attentionItems(snapshot)); markVisibleResponse();
    const visibleRun = latest(snapshot); $('#conversation-tab-attention').hidden = !planVisible || !visibleRun || !attention.unread(conversationId(visibleRun, allRuns(snapshot)));
    $('#conversation-history-state').value = state.historyState; renderSidebarRecovery();
    const field = $('#conversation-search'), scope = searchScope(), phrase = state.search.trim();
    field.placeholder = scope === 'deleted' ? 'Search Trash' : scope === 'archived' ? 'Search archived chats' : 'Search all chats';
    field.setAttribute('aria-label', scope === 'deleted' ? 'Search messages and file names in Trash' : scope === 'archived' ? 'Search archived messages and file names' : 'Search chat messages and file names');
    const catalog = ['active', 'archived', 'deleted'].flatMap(historyState => sidebarConversations({ summaries: state.summaries, runs: allRuns(snapshot), historyState, isUnread: id => attention.unread(id) }));
    const result = chatSearch.get(), hasResults = phrase && result.query === phrase && result.scope === scope && (result.status === 'ready' || result.conversations.length > 0);
    const fallback = sidebarConversations({ summaries: state.summaries, runs: allRuns(snapshot), historyState: state.historyState, query: state.search, isUnread: id => attention.unread(id) }).filter(item => scope !== 'archived' || item.state === 'archived');
    const list = hasResults ? searchedSidebarConversations(result.conversations, catalog, { historyState: state.historyState, isUnread: id => attention.unread(id) }) : fallback;
    renderSearchStatus(result, list.length);
    const groups = phrase ? [{ label: 'Search results', items: list }] : sidebarGroups(list);
    const signature = JSON.stringify([state.forceNew, state.key, state.historyState, state.search, result.status, groups.map(group => [group.label, group.items.map(item => [item.id, item.runId, item.title, item.status, item.settled, item.state, item.unread, item.match])])]);
    if (signature === state.sidebarSignature) return; state.sidebarSignature = signature;
    conversationMenu?.close();
    const container = $('#conversation-list'), scrollTop = container.scrollTop, focused = container.contains(document.activeElement) ? document.activeElement : null, focusId = focused?.dataset?.conversationId, focusMore = Boolean(focused?.dataset?.chatMore);
    const empty = phrase ? ['waiting', 'loading'].includes(result.status) ? 'Looking through saved chats…' : result.status === 'error' ? 'Matching chat titles will still appear here.' : 'No matching chats. Try another word or a file name.' : state.historyState === 'deleted' ? 'Trash is empty.' : state.historyState === 'archived' ? 'No archived conversations.' : state.historyState === 'working' ? 'No chats are working.' : state.historyState === 'unread' ? 'You’re caught up.' : 'Your conversations appear here.';
    container.innerHTML = list.length ? renderSidebarGroups(groups, { selectedId: state.forceNew ? null : state.key, escape }) : `<p class="conversation-sidebar-empty">${empty}</p>`;
    container.scrollTop = scrollTop;
    if (focusId) { const controls = [...container.querySelectorAll('[data-conversation-id]')], next = controls.find(item => item.dataset.conversationId === focusId && Boolean(item.dataset.chatMore) === focusMore) || controls.find(item => item.dataset.missionAction === 'open-run'); (next || field).focus({ preventScroll: true }); }
  }
  function messageHTML(message, run) { const node = run.workflow?.nodes?.find(node => node.id === message.nodeId), team = run.workflow?.nodes?.filter(node => node.type === 'agent').length > 1; return `<div class="conversation-message-author">${message.role === 'user' ? 'You' : team && node?.name ? escape(node.name) : 'BLACKICE'}${message.direction ? `<span>${message.delivery === 'queued' ? 'Queued direction' : 'Direction'}</span>` : ''}</div><div class="${message.role === 'user' ? 'conversation-user-text' : 'output-document conversation-message-text'}">${message.role === 'user' ? escape(message.text) : renderMarkdown(message.text, {resolveArtifact:createRegisteredArtifactResolver(run)})}</div>`; }
  function renderTurn(section, turn) {
    let complete = true;
    const run = turn.run, active = isActiveRun(run), metrics = runMetrics(run), user = section.querySelector('.conversation-user-slot'), userSignature = JSON.stringify([turn.userText, turn.retry, run.attachmentIds]);
    if (user.dataset.signature !== userSignature) { user.innerHTML = `${turn.retry ? '<div class="conversation-retry-note">Retrying remaining work</div>' : ''}${turn.userText ? `<article class="conversation-message user"><div class="conversation-message-author">You</div><div class="conversation-user-text">${escape(turn.userText)}</div>${run.attachmentIds?.length ? `<small class="conversation-attached-count">${icon('text', 11)}${run.attachmentIds.length} attached ${run.attachmentIds.length === 1 ? 'file' : 'files'}</small>` : ''}</article>` : ''}`; user.dataset.signature = userSignature; }
    const routes = recordedResponseRoutes(run), routeSlot = section.querySelector('.conversation-route-slot'), routeSignature = JSON.stringify(routes);
    if (routeSlot && routeSlot.dataset.signature !== routeSignature) { routeSlot.hidden = routes.length === 0; routeSlot.innerHTML = routes.map(route => `<div class="conversation-response-route" data-response-route="${escape(route.model)}" aria-label="Recorded response route: ${escape(route.label)}. Retired" title="Recorded route for ${escape(route.agents.map(agent => agent.name).join(', '))}"><span>${escape(route.label)}</span><span class="conversation-route-experimental">Retired</span></div>`).join(''); routeSlot.dataset.signature = routeSignature; }
    const responses = section.querySelector('.conversation-responses'), seen = new Set();
    for (const message of turn.messages) { seen.add(message.id); let article = [...responses.children].find(element => element.dataset.messageId === message.id); if (!article) { article = document.createElement('article'); article.className = `conversation-message ${message.role === 'user' ? 'user direction' : 'assistant'}`; article.dataset.messageId = message.id; responses.append(article); } const signature = JSON.stringify([message.text, message.phase, message.delivery, run.taskState?.revision]), selection = window.getSelection(); if (article.dataset.signature !== signature) { if (selection && !selection.isCollapsed && selection.containsNode(article, true)) { complete = false; taskSelectionPending = true; } else { article.innerHTML = messageHTML(message, run); article.dataset.signature = signature; } } }
    for (const element of [...responses.children]) if (!seen.has(element.dataset.messageId)) element.remove();
    const work = section.querySelector('.conversation-work-slot'), canAct = run.id === latest(getSnapshot())?.id && selectedState() === 'active', workSignature = JSON.stringify([run.taskState?.revision, run.taskState?.taskId, run.status, run.settled, canAct]);
    const selection = window.getSelection(), readingWork = selection && !selection.isCollapsed && selection.containsNode(work, true);
    if (work.dataset.signature !== workSignature && readingWork) { taskSelectionPending = true; complete = false; }
    if (work.dataset.signature !== workSignature && !readingWork) {
      const opened = new Set([...work.querySelectorAll('[data-task-detail]')].filter(detail => detail.open).map(detail => detail.dataset.taskDetail));
      const focused = work.contains(document.activeElement) ? document.activeElement : null, focusDetail = focused?.closest?.('[data-task-detail]')?.dataset.taskDetail, focusAction = focused?.dataset?.taskFocus;
      work.innerHTML = run.taskState?.planVersion === 1 ? '' : renderTaskState(run.taskState, { icon, includeArtifacts: false, runId: run.id, runStatus: run.status, settled: run.settled === true, canContinue: canAct, canRepeat: canAct && Boolean(onRepeatTask) });
      for (const detail of work.querySelectorAll('[data-task-detail]')) if (opened.has(detail.dataset.taskDetail)) detail.open = true;
      if (focused) { const nextFocus = focusAction ? [...work.querySelectorAll('[data-task-focus]')].find(control => control.dataset.taskFocus === focusAction) : [...work.querySelectorAll('[data-task-detail]')].find(detail => detail.dataset.taskDetail === focusDetail)?.querySelector('summary'); (nextFocus || $('#mission-task')).focus({ preventScroll: true }); }
      work.dataset.signature = workSignature;
    }
    const toolIssues=section.querySelector('.conversation-tool-issues-slot'),toolIssuesMarkup=renderToolIssues(run);if(toolIssues&&toolIssues.innerHTML!==toolIssuesMarkup)toolIssues.innerHTML=toolIssuesMarkup;
    const files = section.querySelector('.conversation-files-slot'), filesSignature = JSON.stringify([run.taskState?.revision, run.taskState?.taskId, run.taskState?.artifacts]);
    if (files.dataset.signature !== filesSignature) { files.innerHTML = renderTaskFiles(run.taskState, { icon }); files.dataset.signature = filesSignature; }
    const notice = stopNotice(run), failure = run.status === 'failed' ? String(run.error?.message || run.error || 'The response stopped after an error.') : '', status = section.querySelector('.conversation-turn-status'), statusText = notice ? `${failure ? `${failure} ` : ''}${notice.text}` : active ? latestMissionActivity(run) || (run.status === 'queued' ? 'Starting…' : 'Working…') : failure || (run.status === 'cancelled' ? 'Stopped' : ''), recovery = conversationRecovery(run), statusSignature = JSON.stringify([statusText, active, run.settled, recovery, notice?.phase]);
    if (status.dataset.signature !== statusSignature) { status.classList.toggle('error', run.status === 'failed' || notice?.phase === 'failed'); status.innerHTML = statusText ? `${icon(active || isSettlingRun(run) ? 'clock' : run.status === 'failed' ? 'info' : 'stop', 12)}<span>${escape(statusText)}</span>${recovery ? `<button type="button" data-mission-action="${recovery.action}">${escape(recovery.label)}</button>` : ''}` : ''; status.dataset.signature = statusSignature; }
    const controls = section.querySelector('.conversation-turn-controls'), settled = run.settled === true, signature = JSON.stringify([run.id, run.status, settled, run.canRetry, state.feedback[run.id], metrics.totalTokens, metrics.hasUsage]);
    if (controls.dataset.signature !== signature) { const output = turn.messages.some(message => message.role === 'assistant'); controls.innerHTML = `${!active && output ? `<button data-mission-action="copy" data-id="${escape(run.id)}" title="Copy response" aria-label="Copy response">${icon('copy', 13)}</button>` : ''}${!active && settled ? `<button data-mission-action="feedback-good" data-id="${escape(run.id)}" title="Useful" aria-label="Useful response"${state.feedback[run.id] === 'good' ? ' disabled' : ''}>${icon('check', 13)}</button><button data-mission-action="feedback-bad" data-id="${escape(run.id)}" title="Needs work" aria-label="Response needs work"${state.feedback[run.id] === 'bad' ? ' disabled' : ''}>${icon('info', 13)}</button>` : ''}${['failed', 'cancelled'].includes(run.status) ? `<button class="conversation-retry" data-mission-action="retry" data-id="${escape(run.id)}"${!settled || run.canRetry === false ? ' disabled' : ''}>${icon('refresh', 12)}Retry</button>` : ''}<button data-mission-action="run-studio" data-id="${escape(run.id)}" title="Activity" aria-label="Open response activity">${icon('terminal', 13)}</button>${!active ? `<span class="conversation-turn-metrics" title="${metrics.hasUsage ? `${metrics.totalTokens.toLocaleString()} total tokens across this response’s model calls` : ''}">${elapsed(metrics.durationMs)}</span>` : ''}`; controls.dataset.signature = signature; }
    const slot = section.querySelector('.conversation-context-slot'), agent = Object.entries(run.nodes || {}).find(([id, node]) => run.workflow?.nodes?.find(item => item.id === id)?.type === 'agent' && node.contextStatus) || Object.entries(run.nodes || {}).find(([, node]) => node.capabilitiesNote || node.continuity), contextSignature = JSON.stringify([agent?.[0], agent?.[1].threadId, agent?.[1].contextStatus, agent?.[1].codexHistory, agent?.[1].continuity, agent?.[1].resolvedEffort, agent?.[1].capabilitiesNote, settled, active]);
    if (slot.dataset.signature !== contextSignature) { const opened = slot.querySelector('details')?.open; slot.innerHTML = agent ? `${agent[1].contextStatus || agent[1].continuity ? `<details class="conversation-context"${opened ? ' open' : ''}><summary>${icon('context', 12)}Context${icon('down', 10)}</summary>${renderContextStatus(agent[1].contextStatus, { threadId: agent[1].threadId, canCompact: agent[1].codexHistory !== 'relay' && settled && !active, continuity:agent[1].continuity,effort:agent[1].resolvedEffort })}</details>` : ''}${agent[1].capabilitiesNote ? `<p class="conversation-capabilities-note">${escape(agent[1].capabilitiesNote)}</p>` : ''}` : ''; slot.dataset.signature = contextSignature; }
    return complete;
  }
  function scrollLatest(force = false) { if (conversationIsVisible() && (force || state.autoScroll)) { $('#conversation-scroll').scrollTop = $('#conversation-scroll').scrollHeight; state.autoScroll = true; $('#conversation-jump').hidden = true; if (state.viewKey) readingPositions.set(state.viewKey, { following: true, top: $('#conversation-scroll').scrollTop }); } }
  function renderConversationTitle(snapshot) {
    const runs = family(snapshot); if (!runs.length) return;
    const key = conversationId(runs[0], runs), summary = ['active','archived','deleted'].flatMap(bucket => state.summaries[bucket]).find(entry => (entry.taskId || entry.rootId || entry.id) === key);
    const title = summary?.rootTitle || summary?.title || taskTitle(runUserText(runs[0]), { max: 140, fallback: runs[0].workflowName || 'Conversation' });
    $('#conversation-title').textContent = title.length > 90 ? title.slice(0,87) + '…' : title; $('#conversation-title').title = title;
  }
  function renderTimeline(snapshot) {
    const runs = family(snapshot);
    if (!runs.length && state.runId && !state.forceNew) { $('#conversation-title').textContent = 'Loading conversation…'; return; }
    const key = state.forceNew ? NEW : runs.length ? conversationId(runs[0], runs) : NEW;
    if (state.viewKey !== key) clearSearchMatch();
    const changing = state.viewKey !== key, view = $('#conversation-scroll'), reading = conversationIsVisible(), previousPosition = reading ? captureConversationScroll(view, $('#conversation-timeline'), state.autoScroll) : readingPositions.get(state.viewKey);
    if (changing) { if (state.viewKey && reading) readingPositions.set(state.viewKey, previousPosition); state.viewKey = key; $('#conversation-timeline').innerHTML = ''; state.autoScroll = readingPositions.get(key)?.following ?? true; switchDraft(key); }
    const timeline = $('#conversation-timeline');
    if (!runs.length) {
      if (!timeline.querySelector('.conversation-empty')) timeline.innerHTML = `
        <div class="conversation-empty conversation-welcome blackice-workbench-welcome">
          <div class="blackice-welcome-hero">
            <div class="blackice-welcome-copy"><h1>What would you like to work on?</h1><p>Ask a question, or describe the outcome you need.</p></div>
          </div>
          <div id="conversation-welcome-status" class="conversation-welcome-status" data-state="loading">
            <div class="conversation-welcome-state-copy" role="status"><strong id="conversation-welcome-state">Checking your model…</strong><p id="conversation-welcome-detail"></p></div>
            <button id="conversation-welcome-action" type="button" hidden></button>
          </div>
          <details class="conversation-examples"><summary>Examples</summary><div class="conversation-starters" aria-label="Start with a draft">${STARTER_PROMPTS.map(item => `<button class="starter-card starter-${escape(item.tint)}" type="button" data-mission-action="starter" data-starter="${escape(item.id)}" title="${escape(item.detail)}"><span class="starter-icon">${icon(item.icon, 15)}</span><span class="starter-copy"><strong>${escape(item.label)}</strong></span>${icon('chevron', 11)}</button>`).join('')}</div></details>
        </div>`;
      $('#conversation-title').textContent = ''; $('#conversation-title').title = ''; return;
    }
    timeline.querySelector('.conversation-empty')?.remove(); renderConversationTitle(snapshot); const seen = new Set(), latestTaskStates = new Map(); for (const run of runs) if (run.taskState) latestTaskStates.set(run.taskState.taskId || run.taskId || run.id, run.id);
    const sections = new Map([...timeline.children].map(section => [section.dataset.runId, section]));
    runs.forEach((run, index) => {
      seen.add(run.id);
      let section = sections.get(run.id);
      if (!section) {
        section = document.createElement('section'); section.className = 'conversation-turn'; section.dataset.runId = run.id;
        section.innerHTML = '<div class="conversation-user-slot"></div><div class="conversation-route-slot" hidden></div><div class="conversation-responses"></div><div class="conversation-turn-status" role="status"></div><div class="conversation-tool-issues-slot"></div><div class="conversation-files-slot"></div><div class="conversation-work-slot"></div><div class="conversation-turn-controls"></div><div class="conversation-context-slot"></div>';
        timeline.append(section); sections.set(run.id, section);
      }
      if (timeline.children[index] !== section) timeline.insertBefore(section, timeline.children[index] || null);
      try {
        const sharedOlderState = Boolean(run.taskState && latestTaskStates.get(run.taskState.taskId || run.taskId || run.id) !== run.id);
        section.querySelector('.conversation-work-slot').hidden = sharedOlderState || run.taskState?.planVersion === 1;
        section.querySelector('.conversation-files-slot').hidden = sharedOlderState;
        const signature = JSON.stringify([run.updatedAt, run.status, run.settled, stopRequests.get(run.id), run.canRetry, run.events?.length, run.events?.at(-1)?.at, run.output?.length, run.taskState?.revision, selectedState(), runs.at(-1)?.id, state.feedback[run.id], Object.entries(run.nodes || {}).map(([id, node]) => [id, node.status, node.resolvedModel, node.threadId, node.output?.length, node.output?.slice(-80), node.usage?.totalTokens, node.contextStatus?.actualInputTokens, node.contextStatus?.estimatedInputTokens, node.contextStatus?.compactionCount, node.capabilitiesNote,node.toolSummary,node.toolCapability,node.capabilityIssues])]);
        if (section.dataset.runSignature !== signature) {
          // A failed or selection-deferred render must be retried with the same saved state.
          if (renderTurn(section, conversationTurn(run, runs))) section.dataset.runSignature = signature;
          section.querySelector('.conversation-render-error')?.remove();
        }
      } catch {
        let notice = section.querySelector('.conversation-render-error');
        if (!notice) {
          notice = document.createElement('p'); notice.className = 'conversation-render-error error-text'; notice.setAttribute('role', 'status'); section.append(notice);
        }
        notice.textContent = 'Part of this response could not be displayed. Saved work is kept; updates will try again.';
      }
    });
    for (const section of [...timeline.children]) if (!seen.has(section.dataset.runId)) section.remove();
    const position = changing ? readingPositions.get(key) : previousPosition;
    if (reading) { if (state.autoScroll) scrollLatest(); else restoreConversationScroll(view, timeline, position); }
    $('#conversation-jump').hidden = state.autoScroll;
  }
  function renderWelcome(snapshot, mode, model, settingsError) {
    if (mode.run || !state.forceNew && state.runId) return;
    const panel = $('#conversation-welcome-status'); if (!panel) return;
    const readiness = welcomeReadiness({ statusLoaded: snapshot.statusLoaded, streamState: snapshot.streamState, status: snapshot.status, selectedModel: $('#mission-model').value, model, cwd: state.prefs.cwd || snapshot.status.cwd, settingsError });
    panel.dataset.state = readiness.state; panel.hidden = readiness.state === 'ready';
    panel.dataset.connecting = String(['loading', 'connecting', 'reconnecting'].includes(readiness.state));
    $('#conversation-welcome-state').textContent = readiness.title;
    $('#conversation-welcome-detail').textContent = readiness.detail;
    const action = $('#conversation-welcome-action');
    action.hidden = !readiness.action;
    action.textContent = readiness.label;
    action.disabled = state.sending || state.capturing || state.selecting;
    if (readiness.action) action.dataset.missionAction = readiness.action;
    else delete action.dataset.missionAction;
  }
  function composerMode(snapshot) {
    const run = latest(snapshot), occupying = allRuns(snapshot).filter(item => isActiveRun(item) || isSettlingRun(item)), active = occupying.find(item => item.id !== run?.id) || activeRun(snapshot), live = run && isActiveRun(run), execution = snapshot.status.execution || {}, unlimited = execution.unlimited === true || Object.hasOwn(execution, 'capacity') && execution.capacity === null, capacity = unlimited ? Infinity : Number(execution.capacity) || 1, occupied = Math.max(occupying.length, Number(execution.activeCount ?? execution.count) || 0), agents = run ? conversationAgents(run, live ? 'steer' : 'continue') : [], agent = agents.find(node => node.id === state.selectedAgent) || agents[0];
    const working = occupying.filter(isActiveRun).length, stopping = occupying.filter(item => isSettlingRun(item) && item.status === 'cancelled').length, finishing = occupying.length - working - stopping;
    return { run, active, live, agents, agent, working, stopping, finishing, occupied: occupying.length, capacity, mode: live ? 'steer' : run ? 'continue' : 'start', blocked: !live && Number.isFinite(capacity) && occupied >= capacity };
  }
  const shouldQueue = mode => typeof onQueue === 'function' && mode.mode === 'start' && (mode.blocked || draft().pendingSend?.mode === 'queue');
  const hasPendingReceipt = () => ['start', 'continue', 'queue'].includes(draft().pendingSend?.mode) && typeof draft().pendingSend?.requestId === 'string';
  const effectiveContext = mode => selectedConversationContext(draft(), state.prefs, mode.agent, mode.run) || getSnapshot().status?.runtimeSettings?.defaultContext;
  const reasoningChoice = mode => conversationReasoningChoice({ draft: draft(), preferences: state.prefs, run: mode.run, agent: mode.agent, status: getSnapshot().status });
  const effectiveEffort = mode => reasoningChoice(mode).effort;
  const effectivePlanDetail = mode => selectedConversationPlanDetail(draft(), state.prefs, mode.run);
  const effectivePlanningMode = mode => selectedConversationPlanningMode(draft(), state.prefs, mode.run);
  function renderContextSummary(effort, context, routeManaged = false) {
    const requested = context?.preset === '900k' ? 900000 : context?.preset === 'custom' && Number.isFinite(context.windowTokens) ? context.windowTokens : 0;
    const windowLabel = requested > 0 ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(requested).toLowerCase() : '';
    const label = [effort !== 'default' ? reasoningLabel(effort) : '', windowLabel].filter(Boolean).join(' · ') || 'Reasoning';
    const summary = $('#mission-context').querySelector('summary');
    const value = routeManaged ? 'Model default' : label === 'Reasoning' ? 'Default' : label;
    if (summary.dataset.value !== value) { summary.dataset.value = value; summary.innerHTML = `<span class="conversation-setting-label">Reasoning</span><span class="conversation-setting-value">${escape(value)}</span>`; }
    const description = routeManaged ? 'This model does not expose reasoning selection.' : `Reasoning settings${label === 'Reasoning' ? '' : `: ${label}`}${requested > 0 ? ` · ${requested.toLocaleString('en-US')} tokens requested` : ''}`;
    summary.title = description; summary.setAttribute('aria-label', description);
  }
  function renderComposerContext(snapshot, mode, actualModel) {
    const choice = reasoningChoice(mode), effort = choice.effort, automatic = choice.source === 'maximal-model-catalog', selectedEffort = automatic ? 'default' : effort;
    const routeManaged = !reasoningSelectionSupported(snapshot.status, actualModel);
    const support = reasoningSupport(snapshot.status, actualModel, effort), reasoning = { ...support, effort, selectedEffort, automatic, unsupported: !support.available, choices: reasoningChoices(snapshot.status, actualModel, selectedEffort) }, select = $('#mission-effort');
    renderContextSummary(effort, effectiveContext(mode), routeManaged);
    const reasoningSignature = JSON.stringify([reasoning, state.key, mode.agent?.id]);
    if (select.dataset.signature !== reasoningSignature) { select.dataset.signature = reasoningSignature; select.innerHTML = reasoning.choices.map(option => `<option value="${escape(option.value)}"${option.value === reasoning.selectedEffort ? ' selected' : ''}>${escape(option.value === 'default' && automatic ? `Automatic · ${reasoningLabel(effort)} (Maximal)` : option.label)}${option.available ? '' : ' · unavailable'}</option>`).join(''); }
    select.disabled = state.sending || state.capturing || routeManaged;
    const planning = $('#mission-planning-mode'), planningMode = effectivePlanningMode(mode), planningNote = planningModeDescription(planningMode) + (mode.run ? ' Applies to your next response; saved notes are kept.' : '');
    if (planning.value !== planningMode) planning.value = planningMode;
    planning.disabled = state.sending || state.capturing || state.selecting || selectedState() !== 'active';
    planning.title = planningNote; $('#mission-planning-note').textContent = planningNote;
    $('#mission-effort-note').textContent = routeManaged ? 'This model does not expose reasoning selection.' : automatic ? `Maximal selects ${reasoningLabel(effort)} from this model’s reported reasoning levels. Choose an explicit level to override it.` : effort === 'default' ? 'Uses the model’s own default.' : reasoning.verified ? 'Options reported by this model.' : 'Provider support is unverified; the exact choice is sent.';
    const toolCapability=modelToolCapability(snapshot.status,actualModel);
    const warning = $('#mission-reasoning-warning'), warningText = reasoning.unsupported ? reasoning.error : state.contextErrors[state.key] || (toolCapability.available===false?toolCapability.message:''); warning.hidden = !warningText; warning.textContent = warningText ? `${warningText}${toolCapability.available===false?' Choose a tool-capable model to perform actions.':' Open Reasoning to change it.'}` : '';
    const contextError = $('#mission-context-error'); contextError.hidden = !state.contextErrors[state.key]; contextError.textContent = state.contextErrors[state.key] || '';
    $('[data-mission-action="reset-context"]').textContent = mode.run ? 'Use saved chat context' : 'Use default context';
    const container = $('#mission-context-fields'), nativeCodex = (actualModel === 'default' ? snapshot.status.defaultModel || '' : actualModel).includes('::') === false;
    const signature = JSON.stringify([state.key, mode.agent?.id, effectiveContext(mode), nativeCodex]);
    // A stream update must never replace an input being edited. Context edits are
    // recorded before rendering; switching chats deliberately installs its fields.
    if (container.dataset.signature !== signature && (container.dataset.owner !== state.key || !document.activeElement || !container.contains(document.activeElement))) {
      container.dataset.signature = signature; container.dataset.owner = state.key;
      container.innerHTML = renderContextFields(effectiveContext(mode) || {}, { prefix: 'mission-chat-context', title: 'Context window', nativeCodex });
    }
    for (const input of container.querySelectorAll('[data-context-option]')) input.disabled = state.sending || state.capturing || nativeCodex && input.dataset.contextOption === 'autoCompact';
    return reasoning;
  }
  function renderComposer(snapshot) {
    if (!$('#mission-start-button')) return;
    const mode = composerMode(snapshot), notice = stopNotice(mode.run), queueing = shouldQueue(mode), recovering = hasPendingReceipt(), actualModel = selectedConversationModel(draft(), state.prefs, mode.agent || mode.run?.workflow?.nodes?.find(node => node.type === 'agent')), models = missionModels(snapshot.status, actualModel), modelSignature = JSON.stringify([models, actualModel, Boolean(mode.run)]), bucket = selectedState();
    if (state.modelsSignature !== modelSignature) { state.modelsSignature = modelSignature; $('#mission-model').innerHTML = models.map(model => `<option value="${escape(model.value)}"${model.value === actualModel ? ' selected' : ''}>${escape(model.label)}${model.available ? '' : ' · offline'}</option>`).join(''); if (!models.some(model => model.value === actualModel)) $('#mission-model').insertAdjacentHTML('beforeend', `<option value="${escape(actualModel)}" selected>${escape(actualModel)} · not connected</option>`); $('#mission-model').insertAdjacentHTML('beforeend', '<option value="__connections__">Connect a provider…</option>'); }
    $('#mission-model').disabled = state.sending || state.capturing; $('#mission-model').title = `${models.find(model => model.value === actualModel)?.label || actualModel}${mode.live ? ' · applies to your next reply' : ''}`;
    modelPicker.update({ models, status: snapshot.status, selected: actualModel });
    const connection = runtimeConnectionFeedback({ statusLoaded: snapshot.statusLoaded, status: snapshot.status, model: actualModel });
    const reasoning = renderComposerContext(snapshot, mode, actualModel);
    $('#mission-task').readOnly = state.sending || state.capturing || state.selecting || Boolean(!state.forceNew && state.runId && !mode.run);
    const activeFolder = workingFolderLabel(mode.run?.cwd || state.prefs.cwd || snapshot.status?.cwd), folderChip = $('#conversation-folder-chip');
    if (folderChip) { folderChip.textContent = activeFolder.name; folderChip.title = activeFolder.missing ? 'Choose a working folder' : `Working folder: ${activeFolder.path}${mode.run ? ' · Fixed for this conversation' : ' · Change folder'}`; folderChip.setAttribute('aria-label', activeFolder.missing ? 'Choose working folder' : `Working folder: ${activeFolder.name}${mode.run ? ', fixed for this conversation' : ', choose a different folder'}`); folderChip.disabled = Boolean(mode.run) || state.sending || state.capturing || state.selecting || !onWorkspace; }
    const attachButton = $('#conversation-attach'); if (attachButton) attachButton.disabled = state.sending || state.capturing || state.pendingFiles || state.selecting || bucket !== 'active';
    const starters = $('#conversation-timeline .conversation-starters'); if (starters) starters.hidden = Boolean(draft().task.trim());
    const ready = mode.live || models.find(model => model.value === actualModel)?.available, send = $('#mission-start-button'); send.disabled = Boolean(connection?.busy && !ready) || state.sending || state.capturing || state.pendingFiles || state.managing || state.selecting || Boolean(mode.live && notice && notice.phase !== 'failed') || !mode.live && !recovering && (reasoning.unsupported || Boolean(state.contextErrors[state.key])) || Boolean(!state.forceNew && state.runId && (!mode.run || state.historyError)) || (!state.forceNew && state.historyPending.has(state.runId)) || !snapshot.statusLoaded || bucket !== 'active' || !recovering && (mode.blocked && !queueing || mode.mode === 'continue' && (!mode.agent || mode.run.settled !== true) || mode.mode === 'steer' && !mode.agent);
    const connects = !ready && !recovering, retiredRoute = isChatModeModel(actualModel, snapshot.status), sendLabel = state.capturing ? 'Saving task…' : state.sending ? queueing ? 'Queueing…' : 'Sending…' : state.pendingFiles ? 'Saving files…' : recovering ? 'Recover send' : connection?.busy && !ready ? 'Connecting…' : connects ? retiredRoute ? 'Choose model' : 'Connect model' : queueing ? 'Queue task' : mode.mode === 'steer' ? 'Send direction' : 'Send';
    send.classList.toggle('queues-task', queueing && !recovering && !connects);
    send.dataset.mode = state.sending || state.capturing ? 'sending' : recovering ? 'recover' : connects ? 'connect' : queueing ? 'queue' : mode.mode;
    const sendMarkup = `${icon(state.sending || state.pendingFiles || state.capturing || queueing && !connects ? 'clock' : connects ? 'link' : 'up', 16)}<span class="conversation-send-label">${escape(sendLabel)}</span>`;
    if (send.innerHTML !== sendMarkup) send.innerHTML = sendMarkup;
    send.type = connects ? 'button' : 'submit';
    if (connects) send.dataset.missionAction = 'connections'; else delete send.dataset.missionAction;
    send.title = state.pendingFiles ? 'Waiting for attached files' : recovering ? `${draft().pendingSend.mode === 'queue' ? 'Recover queued task' : 'Recover submitted message'} · Enter` : connects ? retiredRoute ? 'Choose a supported model' : 'Connect a model' : queueing ? 'Queue task · Enter' : mode.blocked ? 'Another conversation is running' : mode.mode === 'steer' ? 'Send direction · Enter' : 'Send · Enter (Shift+Enter for a new line)';
    send.setAttribute('aria-label', send.title);
    renderWelcome(snapshot, mode, models.find(model => model.value === actualModel), reasoning.unsupported ? reasoning.error : state.contextErrors[state.key]);
    const stop = $('#conversation-stop'), stopLabel = notice?.phase === 'requesting' ? 'Requesting…' : notice?.phase === 'requested' || notice?.phase === 'stopping' ? 'Stopping…' : notice?.phase === 'failed' ? 'Retry stop' : 'Stop';
    stop.hidden = !mode.live && notice?.phase !== 'stopping'; stop.disabled = !mode.live || Boolean(notice && notice.phase !== 'failed');
    stop.title = notice?.phase === 'failed' ? 'Retry stopping this response' : notice?.phase === 'requesting' ? 'Sending the Stop request' : notice ? 'Waiting for active work to finish' : 'Stop current response'; stop.setAttribute('aria-label', stop.title);
    const stopMarkup = `${icon('stop', 13)}<span>${escape(stopLabel)}</span>`; if (stop.innerHTML !== stopMarkup) stop.innerHTML = stopMarkup;
    $('#mission-task').placeholder = mode.mode === 'steer' ? 'Message your working agent…' : 'Ask a question or assign a task…';
    const recovery = mode.run && bucket === 'active' ? conversationRecovery(mode.run) : null;
    const statusText = state.selecting || (!state.forceNew && state.historyPending.has(state.runId)) ? 'Loading conversation…' : snapshot.streamState === 'reconnecting' ? notice ? `Reconnecting — ${notice.text}` : 'Reconnecting — your draft is kept.' : notice ? notice.text : state.pendingFiles ? 'Saving attached files…' : recovering && !state.sending ? 'Your last send can be recovered. Use Recover send to check its receipt.' : state.sending ? queueing ? 'Adding your task to the queue…' : 'Sending your message…' : state.capturing ? 'Saving this task for later…' : queueing ? 'All chat slots are busy. Your task will run when a slot opens.' : mode.blocked ? 'All chat slots are busy.' : mode.live ? (draft().attachmentIds.length ? 'New files will follow this response.' : '') : connection ? `${connection.title} ${connection.detail}` : !snapshot.statusLoaded ? 'Connecting to BLACKICE…' : !ready ? retiredRoute ? CHAT_MODE_RETIRED_MESSAGE : 'Connect a model to send your message.' : recovery ? 'This response needs attention. Your conversation and draft are kept.' : '';
    if ($('#conversation-composer-status').textContent !== statusText) $('#conversation-composer-status').textContent = statusText;
    const connecting = Boolean(connection?.busy && !mode.live && !notice && !state.sending && !state.capturing);
    $('#conversation-connection-progress').hidden = !connecting;
    const statusRow = $('#conversation-compose-status'), statusAction = $('#conversation-status-action');
    statusRow.hidden = !statusText;
    statusRow.dataset.state = snapshot.streamState === 'reconnecting' ? 'reconnecting' : connecting ? 'connecting' : notice?.phase === 'failed' || recovery || connects ? 'attention' : notice || mode.live || state.sending || state.capturing || state.pendingFiles ? 'working' : 'idle';
    const recoveryAction = !state.sending && !state.capturing && !state.selecting && !mode.live && !recovering ? recovery || (connects && snapshot.statusLoaded && !connection?.busy ? { action: 'connections', label: 'Open Models' } : null) : null;
    statusAction.hidden = !recoveryAction;
    statusAction.textContent = recoveryAction?.label || '';
    if (recoveryAction) statusAction.dataset.missionAction = recoveryAction.action; else delete statusAction.dataset.missionAction;
    $('#mission-capture-button').disabled = state.sending || state.capturing || state.pendingFiles;
    if (onPrompts) { $('#mission-outline').disabled = state.sending || state.capturing || state.selecting || bucket !== 'active'; $('#mission-outline-undo').hidden = !promptUndo || promptUndo.key !== state.key || promptUndo.after !== draft().task; }
    const blocker = !state.forceNew && bucket === 'active' ? mode.run?.browserSignIn : null, card = $('#conversation-browser-signin');
    const blockerSignature = JSON.stringify([blocker?.origin,blocker?.reason,blocker?.status,blocker?.browser,mode.live,state.selecting]);
    card.hidden = blocker?.status !== 'awaiting-user';
    if (!card.hidden && card.dataset.signature !== blockerSignature) {
      card.dataset.signature = blockerSignature;
      const label = blocker.reason === 'verification' ? 'Verification required' : blocker.reason === 'permission' ? 'Website permission needed' : 'Sign-in required';
      const contained=blocker.browser==='relay';
      card.innerHTML = `<span class="conversation-browser-signin-copy"><strong>${label}</strong><small>${escape(blocker.hostname)} · ${contained?'Sign in using the contained BLACKICE browser in Observe. The task waits for your follow-up.':'The agent reported a blocker. BrowserOS stays in the background until you choose to open it.'}</small></span><div class="conversation-browser-signin-actions"><button type="button" data-mission-action="${contained?'browser-signin-observe':'browser-signin-open'}">${contained?'Sign in inside Observe':'Open BrowserOS'}</button><button type="button" data-mission-action="browser-signin-resume"${mode.live || state.selecting ? ' disabled' : ''}>Prepare to resume</button></div>`;
    }
    const banner = $('#conversation-state-banner'), bannerSignature = JSON.stringify([bucket, state.managing]); banner.hidden = bucket === 'active'; if (banner.dataset.signature !== bannerSignature) { banner.dataset.signature = bannerSignature; banner.innerHTML = bucket === 'active' ? '' : `<span>${bucket === 'deleted' ? 'In Trash' : 'Archived'}</span><button type="button" data-mission-action="restore-conversation"${state.managing ? ' disabled' : ''}>Restore to reply</button>`; }
    const chooser = $('#conversation-composer-agent'), signature = JSON.stringify([mode.agents.map(node => [node.id, node.name]), mode.agent?.id]); chooser.hidden = mode.agents.length < 2; if (chooser.dataset.signature !== signature) { chooser.dataset.signature = signature; chooser.innerHTML = mode.agents.length > 1 ? `<label>Reply to <select id="conversation-agent" aria-label="Agent for this reply">${mode.agents.map(node => `<option value="${escape(node.id)}"${node.id === mode.agent?.id ? ' selected' : ''}>${escape(node.name)}</option>`).join('')}</select></label>` : ''; }
    const anchor = $('#conversation-return'); anchor.hidden = !mode.blocked || !mode.active; const anchorSignature = mode.blocked && mode.active ? mode.active.id : ''; if (anchor.dataset.signature !== anchorSignature) { anchor.dataset.signature = anchorSignature; anchor.innerHTML = mode.blocked && mode.active ? `<span>${icon('clock', 12)}All chat slots are busy</span><button data-mission-action="open-run" data-id="${escape(mode.active.id)}">Return ${icon('chevron', 11)}</button>` : ''; }
    const activityLabel = [mode.working ? `${mode.working} working` : '', mode.stopping ? `${mode.stopping} stopping` : '', mode.finishing ? `${mode.finishing} finishing` : ''].filter(Boolean).join(' · ');
    const stopAll = $('#conversation-stop-all'); stopAll.hidden = state.historyState !== 'working' || !mode.working || typeof onStopAll !== 'function'; const activeButton = $('#conversation-active-button'); activeButton.hidden = !mode.occupied; activeButton.innerHTML = `${icon('agent', 13)}<span>${activityLabel}</span>`; activeButton.setAttribute('aria-label', `Show chats: ${activityLabel}`);
    const queued = Number(snapshot.status.inbox?.scheduled) || 0, queuedActive = Number(snapshot.status.inbox?.active) || 0, queueButton = $('#conversation-queue-button'); queueButton.hidden = !queued && !queuedActive; queueButton.innerHTML = `${icon('inbox', 13)}<span>${queued ? `${queued} queued` : 'Task running'}</span>`; queueButton.setAttribute('aria-label', queued ? `${queued} queued ${queued === 1 ? 'task' : 'tasks'}` : 'Open running tasks');
    const receipt = $('#conversation-queue-receipt'); receipt.hidden = !state.lastQueued; receipt.innerHTML = state.lastQueued ? `<span>Task queued.</span><button type="button" data-mission-action="open-queued" data-id="${escape(state.lastQueued.id)}">Open task</button><button type="button" data-mission-action="dismiss-queued" aria-label="Dismiss queued task receipt">${icon('close', 11)}</button>` : '';
    attachmentUI?.refreshEditability();
    $('#mission-error').textContent = [notice?.error, state.error].filter(Boolean).join(' ');
    renderTaskWorkbench(snapshot);
  }
  function update() {
    if (destroyed) return;
    const snapshot = getSnapshot(), current = snapshot.currentRun; if (!state.prefs.cwd && snapshot.status.cwd) state.prefs.cwd = snapshot.status.cwd;
    for (const run of allRuns(snapshot)) if (run.settled === true) stopRequests.delete(run.id);
    if (state.prefs.desktopConfigured !== true) state.prefs.desktop = missionDesktopPreference(state.prefs, snapshot.desktop);
    if (current?.id !== state.observedRunId) { state.observedRunId = current?.id || null; if (current && !state.forceNew && !state.runId) { state.runId = current.id; remember(); } }
    if (!state.forceNew && !state.runId) state.runId = activeRun(snapshot)?.id || snapshot.currentRun?.id || snapshot.runs[0]?.id || null;
    const runs = family(snapshot); if (runs.length) switchDraft(conversationId(runs[0], runs)); else if (state.forceNew) switchDraft(NEW);
    renderSidebarVisibility(); renderTimeline(snapshot); renderComposer(snapshot); renderSidebar(snapshot); renderConversationActions(snapshot); renderHistoryNotice(); if (!state.forceNew && state.runId && !state.historyLoaded.has(state.runId) && !state.historyPending.has(state.runId) && !state.historyError) loadHistory(state.runId);
  }
  function configForMessage({ newWorkflow = false } = {}) {
    const snapshot = getSnapshot(), mode = composerMode(snapshot), node = mode.agent;
    const model = selectedConversationModel(draft(), state.prefs, node), effort = !reasoningSelectionSupported(snapshot.status, model) ? 'default' : conversationEfforts.includes(draft().effort) ? draft().effort : newWorkflow ? planningEffortIntent(node, mode.run?.nodes?.[node?.id]) : undefined;
    return { task: draft().task.trim(), model, ...(effort === undefined ? {} : { effort }), ...conversationPlanningConfig(draft(), state.prefs, mode.run), cwd: mode.run?.cwd || state.prefs.cwd, desktop: mode.run ? Boolean(node?.desktop) : missionDesktopPreference(state.prefs, snapshot.desktop), context: effectiveContext(mode), attachmentIds: [...new Set([...(mode.run?.attachmentIds || []), ...draft().attachmentIds])] };
  }
  async function selectRun(id) {
    if (state.selecting) return;
    closeRename({ restoreFocus: false });
    const previous = { runId: state.runId, forceNew: state.forceNew, historyError: state.historyError, truncated: state.truncated };
    state.selecting = true; state.forceNew = false; state.runId = id; state.historyError = ''; state.truncated = false;
    closeMobileSidebar(); renderComposer(getSnapshot());
    try { await onOpenRun(id); remember(); update(); await loadHistory(id); }
    catch (error) { Object.assign(state, previous); remember(); throw error; }
    finally { state.selecting = false; update(); }
  }
  function clearSearchMatch() {
    $('#conversation-match-notice').hidden = true;
    for (const element of mount.querySelectorAll('.conversation-search-target')) {
      element.classList.remove('conversation-search-target');
      if (element.dataset.searchTabstop) { element.removeAttribute('tabindex'); delete element.dataset.searchTabstop; }
    }
  }
  async function openSearchResult(result, query = state.search) {
    const match = result?.match;
    if (!match?.runId || state.selecting || destroyed) return false;
    state.searchOpening = true;
    let interrupted = false;
    const interrupt = () => { interrupted = true; }, events = ['pointerdown', 'keydown', 'input', 'wheel'];
    try {
      // Closing the mobile sidebar can move focus synchronously. Capture the
      // resulting focus, then let any newer interaction own the eventual view.
      const selection = selectRun(match.runId), initialFocus = document.activeElement, initialWorkbench = workbenchIntent;
      for (const type of events) document.addEventListener(type, interrupt, { capture: true, passive: true });
      await selection;
      const focused = document.activeElement;
      const sameRow = initialFocus?.dataset?.conversationId && focused?.dataset?.conversationId === initialFocus.dataset.conversationId && focused?.dataset?.missionAction === initialFocus.dataset.missionAction;
      const automaticTab = ['conversation-plan-tab', 'conversation-dialogue-tab'].includes(focused?.id);
      const retiredOrigin = initialFocus && (initialFocus.isConnected === false || initialFocus.closest?.('[hidden],[inert]') || initialFocus.getClientRects && !initialFocus.getClientRects().length);
      const releasedFocus = focused === document.body && retiredOrigin;
      if (destroyed || interrupted || workbenchIntent !== initialWorkbench || focused !== initialFocus && !sameRow && !automaticTab && !releasedFocus || state.forceNew || state.runId !== match.runId || state.historyError || mount.hidden || document.getElementById('modal-root')?.childElementCount) return false;
      setWorkbenchView('conversation'); clearSearchMatch();
      const section = [...$('#conversation-timeline').children].find(element => element.dataset.runId === match.runId);
      if (!section) return false;
      const message = match.messageId && [...section.querySelectorAll('[data-message-id]')].find(element => element.dataset.messageId === match.messageId);
      const files = match.kind === 'file' && section.querySelector('.conversation-files-slot');
      const target = message || files && !files.hidden && files || section;
      if (!target.hasAttribute('tabindex')) { target.tabIndex = -1; target.dataset.searchTabstop = 'true'; }
      target.classList.add('conversation-search-target');
      $('#conversation-match-label').textContent = `${searchMatchLabel(match)} match${query?.trim() ? ` for “${query.trim().slice(0, 80)}”` : ''}`;
      $('#conversation-match-notice').hidden = false;
      const view = $('#conversation-scroll'); state.autoScroll = false;
      view.scrollTop = Math.max(0, view.scrollTop + target.getBoundingClientRect().top - view.getBoundingClientRect().top - 12);
      readingPositions.set(state.viewKey, captureConversationScroll(view, $('#conversation-timeline'), false));
      $('#conversation-jump').hidden = atConversationEnd(view); target.focus({ preventScroll: true });
      return true;
    } finally { for (const type of events) document.removeEventListener(type, interrupt, true); state.searchOpening = false; if (!destroyed) renderSidebar(getSnapshot()); }
  }
  function findChats(query = '') {
    state.historyState = 'active'; state.search = String(query).slice(0, 200); $('#conversation-search').value = state.search;
    setSidebarOpen(true); void chatSearch.search(state.search, { scope: 'all', immediate: true });
    renderSidebar(getSnapshot()); $('#conversation-search').focus({ preventScroll: true });
  }
  async function alignRun(run) { if (run && getSnapshot().currentRun?.id !== run.id) await onOpenRun(run.id); }
  function mayDraftForRun(run, requestedRunId = run?.id) { return Boolean(run && run.id === requestedRunId && run.id === latest(getSnapshot())?.id && selectedState() === 'active' && !state.sending && !state.capturing && !state.selecting && !state.managing && !state.historyError); }
  function draftPlanDirection({ step, taskState, runId }) {
    const run = latest(getSnapshot());
    if (!mayDraftForRun(run, runId) || run.taskState?.taskId !== taskState?.taskId) throw new Error('This task changed. Open the step in the current outline before adding a direction.');
    const currentStep = run.taskState.steps.find(item => item.id === step?.id);
    if (!currentStep) throw new Error('This step changed. Inspect the current outline before adding a direction.');
    const capture = capturePromptDraft(), context = `About step “${currentStep.title}” (${currentStep.id}) in the saved task outline.${currentStep.doneWhen ? `\nDone when: ${currentStep.doneWhen}` : ''}\n\nMy direction: `;
    const result = applyPromptDraft(capture, [capture.task, context].filter(Boolean).join('\n\n'));
    if (!result.applied) throw new Error(result.error);
    setWorkbenchView('conversation', { focusComposer: true });
    const input = $('#mission-task'); input.setSelectionRange?.(input.value.length, input.value.length);
    return result;
  }
  function prepareNextAction(run, { runId = run?.id } = {}) {
    if (!mayDraftForRun(run, runId) || run.settled !== true || isActiveRun(run)) return false;
    const milestones = missionMilestones(run.taskState), saved = run.taskState?.planVersion === 1 ? taskPlanView(run.taskState, { runStatus: run.status }) : null;
    const complete = saved?.complete ?? milestones.complete, current = saved?.focus || milestones.current;
    const next = saved?.unresolvedBranches && saved.progress.total > 0 && saved.progress.done === saved.progress.total ? 'Review the remaining alternatives and record why unused paths are skipped.' : milestones.nextAction || current?.title;
    if (complete || !next) return false;
    if (draft().task.trim()) { setWorkbenchView('conversation', { focusComposer: true }); toast('Your draft is kept. Send or clear it before drafting the next action.'); return false; }
    const capture = capturePromptDraft(), ownershipError = promptOwnership(capture); if (ownershipError) throw new Error(ownershipError);
    const text = `${saved ? 'Continue the saved task from its current outline.' : 'Continue the saved task from its current milestones.'}\n\nNext action: ${next}${current?.blockedReason ? `\nBlocker: ${current.blockedReason}` : ''}${current?.doneWhen ? `\nDone when: ${current.doneWhen}` : ''}\n\nVerify the result and update the saved ${saved ? 'outline' : 'milestones'} with what actually happened.`;
    promptDraftVersion++; promptUndo = null; if (onPrompts) $('#mission-outline-undo').hidden = true; delete draft().pendingSend; draft().task = text; $('#mission-task').value = text; persist(); renderComposer(getSnapshot()); autoSize(); setWorkbenchView('conversation', { focusComposer: true }); return true;
  }
  async function repeatSavedTask(run, { runId = run?.id } = {}) {
    if (!onRepeatTask || !mayDraftForRun(run, runId) || run.settled !== true || run.status !== 'completed' || isActiveRun(run)) return false;
    const complete = run.taskState?.planVersion === 1 ? taskPlanView(run.taskState, { runStatus: run.status }).complete : missionMilestones(run.taskState).complete;
    if (!complete) return false;
    const config = configForMessage(); await onRepeatTask({ ...config, runId: run.id, taskId: run.taskState?.taskId || run.taskId || run.id, task: runUserText(run) }); return true;
  }
  function setContext(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose valid context settings.'); delete draft().pendingSend; draft().context = structuredClone(value); delete state.contextErrors[state.key]; persist(); renderComposer(getSnapshot()); }
  function setReasoning(value) { if (!conversationEfforts.includes(value)) throw new Error('Choose a valid reasoning level.'); delete draft().pendingSend; draft().effort = value; persist(); renderComposer(getSnapshot()); }
  function setPlanDetail(value, { asDefault = false } = {}) { if (!conversationPlanDetails.includes(value)) throw new Error('Choose Compact, Balanced, or Detailed planning.'); if (state.sending || state.capturing || state.selecting || selectedState() !== 'active') return; delete draft().pendingSend; draft().planDetail = value; if (asDefault) state.prefs.planDetail = value; persist(); renderComposer(getSnapshot()); }
  function setPlanningMode(value, { asDefault = false } = {}) { if (!PLANNING_MODES.includes(value)) throw new Error('Choose Maximal, On, Auto, or Off planning.'); if (state.sending || state.capturing || state.selecting || selectedState() !== 'active') return; delete draft().pendingSend; draft().planningMode = value; if (asDefault) state.prefs.planningMode = value; persist(); renderComposer(getSnapshot()); }
  function readComposerContext(event) {
    if (!event.target.dataset?.contextOption || !event.target.closest('[data-context-fields]')) return false;
    if (state.sending || state.capturing) return true;
    delete draft().pendingSend;
    try { const value = readContextFields($('#mission-context-fields'), 'mission-chat-context'); if (value) { draft().context = value; delete state.contextErrors[state.key]; persist(); } }
    catch (error) { state.contextErrors[state.key] = error.message; }
    renderComposer(getSnapshot()); return true;
  }
  mount.addEventListener('input', readComposerContext);
  mount.addEventListener('change', event => { if (readComposerContext(event)) return; if (event.target.id === 'mission-effort') setReasoning(event.target.value); if (event.target.id === 'mission-planning-mode') setPlanningMode(event.target.value); });
  mount.addEventListener('input', event => {
    if (event.target.id === 'conversation-search') { state.search = event.target.value; if (!state.search.trim()) clearSearchMatch(); void chatSearch.search(state.search, { scope: searchScope() }); renderSidebar(getSnapshot()); return; }
    if (event.target.id === 'mission-task') {
      const refreshReceipt = Boolean(draft().pendingSend || state.lastQueued);
      promptDraftVersion++; promptUndo = null; if (onPrompts) $('#mission-outline-undo').hidden = true;
      if (!state.runId && state.key === NEW) { state.forceNew = true; remember(); }
      delete draft().pendingSend; state.lastQueued = null; draft().task = event.target.value; autoSize(); persist();
      const starters = $('#conversation-timeline .conversation-starters'); if (starters) starters.hidden = Boolean(draft().task.trim());
      if (refreshReceipt) renderComposer(getSnapshot());
    }
  });
  mount.addEventListener('change', event => { if (event.target.id === 'mission-model') { if (event.target.value === '__connections__') { state.modelsSignature = ''; renderComposer(getSnapshot()); onConnections(); return; } draft().model = event.target.value; delete draft().pendingSend; state.error = ''; persist(); update(); } if (event.target.id === 'conversation-history-state') { state.historyState = event.target.value; void chatSearch.search(state.search, { scope: searchScope(), immediate: true }); renderSidebar(getSnapshot()); renderComposer(getSnapshot()); loadSummaries(); } if (event.target.id === 'conversation-agent') { delete draft().pendingSend; state.selectedAgent = event.target.value; draft().agentId = event.target.value; persist(); update(); } });
  mount.addEventListener('submit', async event => {
    if (event.target.id === 'conversation-rename') { event.preventDefault(); await saveRename(); return; }
    if (event.target.id !== 'mission-form') return; event.preventDefault(); const snapshot = getSnapshot(), mode = composerMode(snapshot), queueing = shouldQueue(mode), recovering = hasPendingReceipt(), config = configForMessage(), draftKey = state.key;
    if (['requesting', 'requested'].includes(stopRequests.get(mode.run?.id)?.phase)) return;
    if (state.sending || state.capturing || state.selecting || Boolean(!state.forceNew && state.runId && (!mode.run || state.historyError)) || (!state.forceNew && state.historyPending.has(state.runId)) || !snapshot.statusLoaded || state.pendingFiles || state.managing || selectedState() !== 'active' || !recovering && mode.blocked && !queueing || !config.task) return;
    if (!draft().pendingSend && mode.mode !== 'steer' && (!reasoningSupport(snapshot.status, config.model, effectiveEffort(mode)).available || state.contextErrors[state.key])) { $('#mission-context').open = true; renderComposer(snapshot); return; }
    if (!recovering && mode.mode !== 'steer' && !missionModels(snapshot.status, config.model).find(model => model.value === config.model)?.available) { try { onConnections(); } catch (error) { state.error = error.message; update(); } return; }
    if (!config.cwd) { state.error = 'Choose a working folder in Settings.'; update(); onWorkspace?.(); return; }
    if (!recovering && (!queueing && mode.mode !== 'start' && !mode.agent || mode.mode === 'continue' && mode.run.settled !== true)) return;
    if (config.attachmentIds.length > 10) { state.error = 'A conversation can have up to 10 attached files.'; update(); return; }
    const pending = draft().pendingSend || { requestId: crypto.randomUUID(), mode: queueing ? 'queue' : mode.mode, runId: mode.run?.id, nodeId: mode.agent?.id, config: { ...config, ...(queueing && config.model === 'default' ? { model: snapshot.status.defaultModel } : {}) } };
    if (pending.mode !== 'steer') draft().pendingSend = pending; persist();
    const request = { kind: 'send', key: draftKey, submitted: structuredClone(draft()), config: pending.config, receiptId: pending.requestId };
    composerRequests.set(draftKey, request); composerErrors.delete(draftKey); renderComposer(snapshot);
    try {
      let next;
      if (pending.mode === 'queue') { const item = await onQueue({ ...pending.config, enqueueKey: pending.requestId }); queueReceipts.set(draftKey, item); if (ownsRequestView(request)) toast('Task queued.'); }
      else if (pending.mode === 'start') next = await onStart({ ...pending.config, requestId: pending.requestId });
      else if (pending.mode === 'continue') next = await onContinue({ runId: pending.runId, nodeId: pending.nodeId, message: pending.config.task, attachmentIds: pending.config.attachmentIds, model: pending.config.model, ...(pending.config.effort === undefined ? {} : { effort: pending.config.effort }), planningMode: pending.config.planningMode, ...(pending.config.planDetail === undefined ? {} : { planDetail: pending.config.planDetail }), context: pending.config.context, requestId: pending.requestId });
      else { const receipt = await api(`/api/runs/${encodeURIComponent(pending.runId)}/steer`, 'POST', { nodeId: pending.nodeId, message: pending.config.task }); if (receipt.accepted !== true) throw new Error('The agent did not accept that message.'); if (ownsRequestView(request)) toast(receipt.delivery === 'queued' ? 'Direction queued for the next model response.' : 'Direction delivered.'); }
      const selected = ownsRequestView(request);
      consumeRequestDraft(request, { attachments: pending.mode !== 'steer', preferences: ['start', 'queue'].includes(pending.mode) });
      if (next) { state.cache = mergeConversationRuns(state.cache, [next]); if (selected) { state.forceNew = false; state.runId = next.id; remember(); } }
      if (selected) { $('#mission-task').value = draft().task || ''; if (pending.mode !== 'steer') attachmentUI.reset(); state.autoScroll = true; }
      persist({ preserveNewerDrafts: true }); update(); if (selected) { autoSize(); scrollLatest(true); } loadSummaries();
    } catch (error) { composerErrors.set(draftKey, error.message); update(); }
    finally { if (composerRequests.get(draftKey) === request) composerRequests.delete(draftKey); if (!destroyed) renderComposer(getSnapshot()); }
  });
  conversationMenu = initConversationMenu({ mount, resolveTarget: conversationTarget, onAction: (action, target) => action === 'rename' ? beginRename(target) : manageConversation(action, target), onError: error => toast(error.message, true), fallbackFocus: () => $('#conversation-list').querySelector('.conversation-list-item') || $('#mission-task') });
  mount.addEventListener('click', async event => {
    const compact = event.target.closest('[data-action="compact-context"]'); if (compact) { event.stopPropagation(); const run = allRuns(getSnapshot()).find(run => Object.values(run.nodes || {}).some(node => node.threadId === compact.dataset.threadId)), node = Object.entries(run?.nodes || {}).find(([, node]) => node.threadId === compact.dataset.threadId); if (run && node) { compact.disabled = true; try { await onCompact(run.id, node[0]); } finally { if (compact.isConnected) compact.disabled = false; } } return; }
    const button = event.target.closest('[data-mission-action]'); if (!button || button.disabled) return; const action = button.dataset.missionAction, snapshot = getSnapshot(), run = button.dataset.id ? allRuns(snapshot).find(run => run.id === button.dataset.id) : latest(snapshot);
    try {
      if (action === 'rename-conversation') beginRename(null, button);
      if (action === 'cancel-rename') closeRename();
      if (action === 'chat-context') { setWorkbenchView('conversation'); $('#conversation-actions').open = false; $('#mission-context').open = true; $('#mission-effort').focus({ preventScroll: true }); }
      if (action === 'toggle-plan') {
        if (planVisible && !narrowPlan()) {
          workbenchIntent++;
          taskPlanUI?.setEnlarged(false, { focusControl: false });
          desktopPlanCollapsed = !desktopPlanCollapsed;
          try { localStorage.setItem('relay.ui.plan.collapsed', String(desktopPlanCollapsed)); } catch {}
          renderTaskWorkbench(getSnapshot()); $('#conversation-plan-toggle').focus({ preventScroll: true });
          if (state.autoScroll) scrollLatest(true);
        }
        return;
      }
      if (action === 'plan-view') { setWorkbenchView(button.dataset.view, { focusTab: true }); return; }
      if (action === 'context-diagnostics') { $('#conversation-actions').open = false; mount.classList.toggle('show-context-diagnostics'); renderConversationActions(snapshot); }
      if (action === 'reset-context') { delete draft().context; delete draft().pendingSend; delete state.contextErrors[state.key]; $('#mission-context-fields').dataset.signature = ''; persist(); renderComposer(snapshot); }
      if (action === 'sidebar') { const expanded = narrowSidebar() ? mount.classList.contains('sidebar-open') : !mount.classList.contains('sidebar-collapsed'); setSidebarOpen(!expanded); if (!expanded && narrowSidebar()) $('#conversation-search').focus({ preventScroll: true }); }
      if (action === 'close-sidebar') closeMobileSidebar({ restoreFocus: true });
      if (action === 'working-chats') { state.historyState = 'working'; setSidebarOpen(true); renderSidebar(snapshot); renderComposer(snapshot); }
      if (action === 'latest') { scrollLatest(true); renderSidebar(snapshot); }
      if (action === 'message-options' || action === 'workspace') { onWorkspace?.(); return; }
      if (action === 'projects') { onProjects?.({goal:$('#mission-task')?.value||''}); return; }
      if (action === 'planning') { onOpenPlanning?.(); return; }
      if (action === 'archive-conversation' || action === 'restore-conversation' || action === 'delete-conversation') return await manageConversation(action.split('-')[0]);
      if (action === 'new-task') { if (state.selecting) return; closeMobileSidebar(); if (state.forceNew && state.key === NEW) { $('#mission-task').focus({preventScroll:true}); return; } closeRename({ restoreFocus: false }); state.forceNew = true; state.runId = null; state.historyState = 'active'; state.historyError = ''; state.truncated = false; state.drafts[NEW] ||= { task: '', attachmentIds: [] }; switchDraft(NEW); $('#mission-task').value = draft().task || ''; persist(); remember(); update(); autoSize(); $('#mission-task').focus({ preventScroll: true }); }
      if (action === 'open-run') { const found = button.dataset.searchRunId && chatSearch.get().conversations.find(item => item.match.runId === button.dataset.searchRunId && (!button.dataset.searchMessageId || item.match.messageId === button.dataset.searchMessageId)); if (found) await openSearchResult(found); else { clearSearchMatch(); await selectRun(button.dataset.id); } }
      if (action === 'retry-search') await chatSearch.retry();
      if (action === 'more-search') await chatSearch.more();
      if (action === 'clear-match') { clearSearchMatch(); $('#conversation-scroll').focus({ preventScroll: true }); } if (action === 'reload-history') { state.historyError = ''; await loadHistory(state.runId, true); }
      if (action === 'retry-chats') return await retryHistory();
      if (action === 'open-queued') onInbox({ selectedId: button.dataset.id }); if (action === 'dismiss-queued') { state.lastQueued = null; renderComposer(getSnapshot()); }
      if (action === 'schedule-task') { onSchedule?.(); } if (action === 'create-swarm') { onSwarm?.(); }
      if (action === 'browser-signin-open'||action === 'browser-signin-observe') {
        const mode=composerMode(getSnapshot()),blocker=!state.forceNew&&selectedState()==='active'?mode.run?.browserSignIn:null;
        if(!blocker||blocker.status!=='awaiting-user')return;
        if(blocker.browser==='relay'){
          if(!onObserve){toast('Open Observe to sign in inside the contained BLACKICE browser.',true);return;}
          button.disabled=true;try{await onObserve(mode.run.id);}finally{if(button.isConnected)button.disabled=false;}
          return;
        }
        if(action==='browser-signin-observe')return;
        if (!onOpenBrowserOS) { toast('Opening BrowserOS is available in the Windows app.', true); return; }
        button.disabled = true;
        try { const result = await onOpenBrowserOS(); if (!result?.shown) toast(result?.reason || 'BrowserOS is starting. Open it again if no window appears.', true); }
        finally { if (button.isConnected) button.disabled = false; }
        return;
      }
      if (action === 'browser-signin-resume') {
        const blocker = !state.forceNew && selectedState() === 'active' ? composerMode(getSnapshot()).run?.browserSignIn : null;
        if (!blocker || blocker.status !== 'awaiting-user' || state.sending || state.selecting || state.capturing || composerMode(getSnapshot()).live) return;
        if (draft().task.trim()) { toast('Your unsent message is preserved. Send or clear it before resuming this task.'); $('#mission-task').focus({preventScroll:true}); return; }
        const text = `I have handled the sign-in or verification for ${blocker.hostname} in ${blocker.browser==='relay'?'the contained BLACKICE browser in Observe':'BrowserOS Neo'}. Reinspect the website to confirm access. Before continuing the original task, check whether any intended public action already happened so nothing is duplicated. Continue only the remaining authorized work, and verify the actual result.`;
        const applied=applyPromptDraft(capturePromptDraft(),text); if (!applied.applied) toast(applied.error,true);
        return;
      }
      if (action === 'starter') { const template = starterPrompt(button.dataset.starter); if (!template || state.sending || state.capturing || state.selecting || selectedState() !== 'active') return; if (draft().task.trim()) { $('#mission-task').focus({preventScroll:true}); toast('Your draft is still here. Clear it before choosing another starter.'); return; } const result = applyPromptDraft(capturePromptDraft(), template); if (!result.applied) toast(result.error, true); return; }
      if (action === 'continue-milestone' || action === 'repeat-task') { if (action === 'repeat-task') await repeatSavedTask(run); else prepareNextAction(run); return; }
      if (action === 'prompts') { onPrompts?.(); } if (action === 'save-prompt') { onSavePrompt?.(); } if (action === 'undo-prompt') { const result = undoPromptDraft(promptUndo); if (!result.undone) toast(result.error, true); }
      if (action === 'studio') onStudio(); if (action === 'run-studio') onStudio(button.dataset.id); if (action === 'inbox') onInbox(); if (action === 'agent') onAgent(); if (action === 'learning') onLearning(); if (action === 'connections') { onConnections(); } if (action === 'run-limits') onRunLimits?.(); if (action === 'browser') onBrowser(); if (action === 'knowledge') onKnowledge(); if (action === 'desktop') onDesktop();
      if (action === 'attach') $('#mission-attachments .attachments-add').click();
      if (action === 'stop-all' && onStopAll) { button.disabled = true; try { await onStopAll(); } finally { if(button.isConnected)button.disabled = false; } } if (action === 'stop') await stopResponse(run); if (action === 'direct') { await alignRun(run); onDirect(button.dataset.nodeId); }
      if (action === 'retry') { if (selectedState() !== 'active') throw new Error('Restore this conversation before retrying.'); button.disabled = true; try { const key = state.key, next = await onRetry(run?.id); if (next) { state.cache = mergeConversationRuns(state.cache, [next]); if (state.key === key && !state.forceNew) { state.runId = next.id; remember(); } } update(); } finally { if (button.isConnected) button.disabled = false; } }
      if (action === 'copy' && run) await onCopy(conversationTurn(run).messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n\n'));
      if (action === 'feedback-good' || action === 'feedback-bad') { button.disabled = true; try { await onFeedback(run.id, action === 'feedback-good' ? 'good' : 'bad'); state.feedback[run.id] = action === 'feedback-good' ? 'good' : 'bad'; update(); } catch (error) { button.disabled = false; throw error; } }
      if (action === 'pick-folder' && pickFolder) { if (composerMode(snapshot).run || state.sending || state.capturing || state.selecting || selectedState() !== 'active') return; const ownerKey = state.key; const result = await pickFolder(state.prefs.cwd), value = typeof result === 'string' ? result : result?.path || result?.filePaths?.[0]; if (value && ownerKey === state.key && !state.sending && !state.capturing && !state.selecting && selectedState() === 'active' && !composerMode(getSnapshot()).run) { delete draft().pendingSend; state.prefs.cwd = value; persist(); update(); } }
      if (action === 'capture') {
        const config = configForMessage({ newWorkflow: true }), mode = composerMode(getSnapshot()), key = state.key;
        if (!config.task || state.pendingFiles || state.capturing || state.sending || state.selecting) return;
        if (!reasoningSupport(snapshot.status, config.model, effectiveEffort(mode)).available || state.contextErrors[state.key]) { $('#mission-context').open = true; renderComposer(snapshot); return; }
        if (!config.cwd) throw new Error('Choose a working folder.');
        const request = { kind: 'capture', key, submitted: structuredClone(draft()), config, receiptId: draft().pendingSend?.requestId };
        composerRequests.set(key, request); composerErrors.delete(key); renderComposer(snapshot);
        try {
          const item = await onCapture(config);
          consumeRequestDraft(request, { preferences: true });
          persist({ preserveNewerDrafts: true });
          if (ownsRequestView(request)) { $('#mission-task').value = draft().task || ''; attachmentUI.reset(); autoSize(); onInbox({ selectedId: item.id }); }
        } catch (error) { composerErrors.set(key, error.message); if (ownsRequestView(request)) toast(error.message, true); }
        finally { if (composerRequests.get(key) === request) composerRequests.delete(key); if (!destroyed) renderComposer(getSnapshot()); }
      }
    } catch (error) { toast(error.message, true); }
  });
  $('#conversation-scroll').addEventListener('scroll', () => { if (!conversationIsVisible()) return; const view = $('#conversation-scroll'); state.autoScroll = view.scrollHeight - view.scrollTop - view.clientHeight < 90; if (state.viewKey) readingPositions.set(state.viewKey, captureConversationScroll(view, $('#conversation-timeline'), state.autoScroll)); $('#conversation-jump').hidden = state.autoScroll || !family(getSnapshot()).length; if (markVisibleResponse()) renderSidebar(getSnapshot()); }, { passive: true });
  const refreshAttention = () => { if (!destroyed) { attention.refresh(); renderSidebar(getSnapshot()); } };
  const refreshSelectedMilestones = () => { if (!destroyed && taskSelectionPending) { taskSelectionPending = false; update(); } };
  document.addEventListener('selectionchange', refreshSelectedMilestones);
  document.addEventListener('visibilitychange', refreshAttention); document.addEventListener('focusin', refreshAttention); window.addEventListener('focus', refreshAttention); window.addEventListener('storage', refreshAttention);
  for (const id of ['mission-context', 'conversation-actions']) $(`#${id}`).addEventListener('toggle', () => { if (!$(`#${id}`).open) return; for (const other of ['mission-context', 'conversation-actions']) if (other !== id) $(`#${other}`).open = false; });
  mount.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if (planVisible && narrowPlan() && ['conversation-plan-tab', 'conversation-dialogue-tab'].includes(event.target.id) && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); const value = event.key === 'Home' ? 'plan' : event.key === 'End' ? 'conversation' : event.target.id === 'conversation-plan-tab' ? 'conversation' : 'plan'; setWorkbenchView(value, { focusTab: true }); return;
    }
    if (event.key === 'Escape' && !$('#conversation-rename').hidden) { event.preventDefault(); event.stopPropagation(); closeRename(); return; }
    if (event.target.id === 'mission-task' && shouldSendConversationKey(event)) { event.preventDefault(); event.stopPropagation(); if (!event.target.readOnly) $('#mission-form').requestSubmit(); return; }
    if (event.key === 'Escape' && ($('#conversation-actions').open || $('#mission-context').open)) { event.preventDefault(); event.stopPropagation(); const opened = ['conversation-actions', 'mission-context'].map(id => $(`#${id}`)).find(panel => panel.open); $('#conversation-actions').open = false; $('#mission-context').open = false; opened.querySelector('summary').focus({ preventScroll: true }); return; }
    if (event.key === 'Escape' && narrowSidebar() && mount.classList.contains('sidebar-open')) { event.preventDefault(); event.stopPropagation(); closeMobileSidebar({ restoreFocus: true }); }
  });
  function sharedDraftTask(key) { try { const stored = readStoredDrafts(); return { available: true, task: typeof stored.conversationDrafts?.[key]?.task === 'string' ? stored.conversationDrafts[key].task : key === NEW && typeof stored.task === 'string' ? stored.task : '' }; } catch { return { available: false }; } }
  function capturePromptDraft() { const shared = sharedDraftTask(state.key); return { key: state.key, task: draft().task, version: promptDraftVersion, sharedTask: shared.task, sharedAvailable: shared.available }; }
  function promptOwnership(capture) {
    if (!capture || destroyed || capture.key !== state.key || capture.task !== draft().task || capture.version !== promptDraftVersion) return 'This chat or its draft changed. Review the current message before changing it.';
    if (state.sending || state.capturing || state.selecting || state.managing || selectedState() !== 'active') return 'Wait for this chat action to finish before changing its draft.';
    const shared = sharedDraftTask(capture.key);
    if (capture.sharedAvailable && (!shared.available || shared.task !== capture.sharedTask || capture.sharedTask !== capture.task)) return 'This draft changed in another BLACKICE window. Your message has been kept.';
    return '';
  }
  function applyPromptDraft(capture, text) {
    const error = promptOwnership(capture); if (error) return { applied: false, error };
    if (typeof text !== 'string' || !text.trim() || text.length > 50000) return { applied: false, error: 'Use a message between 1 and 50,000 characters.' };
    const before = draft().task; promptDraftVersion++; delete draft().pendingSend; draft().task = text; $('#mission-task').value = text;
    if (state.key === NEW) { state.forceNew = true; remember(); }
    persist(); promptUndo = { key: state.key, before, after: text, capture: capturePromptDraft() }; update(); autoSize(); setWorkbenchView('conversation', { focusComposer: true });
    return { applied: true, undo: promptUndo };
  }
  function undoPromptDraft(token) {
    if (!token || token !== promptUndo) return { undone: false, error: 'This outline change is no longer available to undo.' };
    const error = promptOwnership(token.capture); if (error) return { undone: false, error };
    promptDraftVersion++; delete draft().pendingSend; draft().task = token.before; $('#mission-task').value = token.before; promptUndo = null; persist(); update(); autoSize(); setWorkbenchView('conversation', { focusComposer: true }); return { undone: true };
  }
  $('#mission-task').value = draft().task || ''; autoSize(); update(); loadSummaries();
  return { update, refreshHistory, openSearchResult, findChats, capturePromptDraft, applyPromptDraft, undoPromptDraft, getSelection: () => ({ key: state.key, runId: state.runId, forceNew: state.forceNew }), searchChats: (query = '', limit = 20) => searchConversations({ summaries: state.summaries, runs: allRuns(getSnapshot()), query, limit }), openConversation: selectRun, managePlan, setContext, setReasoning, setPlanDetail, setPlanningMode, getWorkbench: () => ({ visible: planVisible, collapsed: planVisible && !narrowPlan() && desktopPlanCollapsed, view: planView, taskId: planKey, selection: taskPlanUI.getSelection() }), showPlan: () => setWorkbenchView('plan'), setWorkspace(cwd) { if (typeof cwd !== 'string') return; delete draft().pendingSend; state.prefs.cwd = cwd; persist(); update(); }, prefill(text, { replace = false } = {}) { const filled = typeof text === 'string' && Boolean(text.trim()) && (replace === true || !draft().task.trim()); if (filled) { draft().task = text; $('#mission-task').value = text; persist(); update(); autoSize(); } setWorkbenchView('conversation', { focusComposer: true }); return filled; }, focus: () => setWorkbenchView('conversation', { focusComposer: true }), submitFocused() { $('#mission-form').requestSubmit(); }, getRequestDraft: () => configForMessage({ newWorkflow: true }), getDraft: () => ({ ...state.prefs, model: selectedConversationModel(draft(), state.prefs, composerMode(getSnapshot()).agent), effort: effectiveEffort(composerMode(getSnapshot())), planDetail: effectivePlanDetail(composerMode(getSnapshot())), planningMode: effectivePlanningMode(composerMode(getSnapshot())), context: effectiveContext(composerMode(getSnapshot())), task: draft().task, attachmentIds: [...draft().attachmentIds] }), destroy() { destroyed = true; chatSearch.destroy(); document.removeEventListener('selectionchange', refreshSelectedMilestones); document.removeEventListener('visibilitychange', refreshAttention); document.removeEventListener('focusin', refreshAttention); window.removeEventListener('focus', refreshAttention); window.removeEventListener('storage', refreshAttention); window.removeEventListener('resize', resizeSidebar); conversationMenu.destroy(); modelPicker.destroy(); taskPlanUI.destroy(); planViews.clear(); stopRequests.clear(); composerRequests.clear(); composerErrors.clear(); queueReceipts.clear(); state.summaryVersion++; if (historyRefreshTimer) clearTimeout(historyRefreshTimer); historyRefreshTimer = null; for (const resolve of historyWaiters) resolve(false); historyWaiters = []; } };
}

