import { text } from '../core/dom.mjs';

/** Ownership is independent of where a tab happens to be displayed. */
export function browserTabKind(tab) {
  if (tab?.ownershipKind === 'user' || tab?.ownershipKind === 'ai') return tab.ownershipKind;
  return tab?.owner?.taskId ? 'ai' : 'user';
}
export function browserTabConversation(tab) {
  return browserTabKind(tab) === 'ai' && typeof tab?.conversationId === 'string' && tab.conversationId
    ? tab.conversationId : null;
}
export function browserOwnershipTabs(tabs, view) {
  return (Array.isArray(tabs) ? tabs : []).filter(tab => {
    if (browserTabKind(tab) !== (view?.kind || 'user')) return false;
    if (view?.kind !== 'ai' || !view.filter || view.filter === 'all') return true;
    const id = browserTabConversation(tab);
    return view.filter === 'unassigned' ? !id : view.filter === 'conversation:' + id;
  });
}
export function browserConversationCatalog(status) {
  const entries = new Map(), authoritative = Array.isArray(status?.conversations);
  for (const item of Array.isArray(status?.conversations) ? status.conversations : []) {
    if (!item || typeof item.id !== 'string' || !item.id || item.state === 'deleted') continue;
    entries.set(item.id, {id:item.id, title:String(item.title || 'Untitled conversation'), tabCount:0,
      contextIds:[item.id,item.taskId,item.latestRunId].filter(value => typeof value === 'string' && value)});
  }
  for (const tab of Array.isArray(status?.tabs) ? status.tabs : []) {
    const id = browserTabConversation(tab);
    if (!id) continue;
    // An existing catalog is authoritative: an old tab must never resurrect a
    // deleted conversation as a move destination. Its own label stays visible.
    if (authoritative && !entries.has(id)) continue;
    if (!entries.has(id)) entries.set(id, {id, title:String(tab.conversationTitle || 'Conversation'), tabCount:0});
    entries.get(id).tabCount++;
  }
  return [...entries.values()];
}
export function browserTabOwnerLabel(tab) {
  if (browserTabKind(tab) === 'user') return 'Personal';
  return tab?.conversationTitle || (browserTabConversation(tab) ? 'Conversation' : 'Unassigned AI tab');
}
export function browserOwnershipRequest(tab, destination, conversations) {
  if (!tab?.tabId || !tab.url || !tab.documentId) throw Error('Refresh this tab before moving it.');
  const identity = {tabId:tab.tabId, expectedUrl:tab.url, expectedDocumentId:tab.documentId};
  if (destination === 'user') return {...identity, destination:'user'};
  if (!destination.startsWith('conversation:')) throw Error('Choose a conversation for this tab.');
  const conversationId = destination.slice('conversation:'.length);
  if (!conversations.some(item => item.id === conversationId)) throw Error('That conversation is no longer available.');
  return {...identity, destination:'conversation', conversationId};
}
export function browserOwnershipMarkup() {
  return [
    '<div class="next-browser-ownership" aria-label="Tab ownership">',
    '<div class="next-browser-scopes" role="group" aria-label="Tab owner">',
    '<button type="button" id="next-browser-personal" aria-pressed="true" title="Your own tabs, outside conversations">Personal</button>',
    '<button type="button" id="next-browser-ai" aria-pressed="false" title="Tabs assigned to AI conversations">AI tabs</button>',
    '</div>',
    '<label class="next-browser-conversation-label" id="next-browser-conversation-label" hidden>',
    '<span>Conversation</span><select id="next-browser-conversation" class="next-field" aria-label="Filter AI tabs by conversation"></select></label>',
    '<span id="next-browser-owner-hint" class="next-browser-owner-hint"></span>',
    '<select id="next-browser-move" class="next-field next-browser-move" aria-label="Move selected tab" disabled><option value="">Move tab to…</option></select>',
    '</div>',
  ].join('');
}

/** The native and captured views use the same filter and the same ownership
 * mutation. A move keeps the selected tab and follows its destination. */
export function createBrowserOwnershipControls({mount, api, getTab, isBusy = () => false,
  onViewChange = () => {}, onMoveStart = () => {}, onMoveStatus = () => {},
  onMoveEnd = () => {}, notice = () => {}}) {
  const document = mount.ownerDocument, window = document.defaultView || globalThis.window;
  const $ = id => mount.querySelector('#' + id);
  const ui = {personal:$('next-browser-personal'), ai:$('next-browser-ai'),
    conversation:$('next-browser-conversation'), label:$('next-browser-conversation-label'),
    hint:$('next-browser-owner-hint'), move:$('next-browser-move')};
  let status = {tabs:[]}, conversations = [], view = null, moving = null, destroyed = false, hasStatus = false;
  let lastContext, followContext = null, conversationKey = '', moveKey = '';
  const selections = new Map();
  const selectionKey = () => view?.kind === 'ai' ? 'ai:' + (view.filter || 'all') : 'user';
  function rememberSelection(tabId) {
    if (!view) return;
    if (!tabId) { selections.delete(selectionKey()); return; }
    const tab = status.tabs?.find(item => item.tabId === tabId);
    if (tab && browserOwnershipTabs([tab],view).length) selections.set(selectionKey(),tabId);
  }
  const context = () => {
    try { return window?.localStorage?.getItem('blackice.next.selected') || null; } catch { return null; }
  };
  function chooseInitial() {
    const followed = followContext && conversations.find(item => item.id === followContext || item.contextIds?.includes(followContext));
    if (followed) {
      rememberSelection(getTab()?.tabId);
      view = {kind:'ai', filter:'conversation:' + followed.id}; followContext = null;
    }
    if (view || !hasStatus) return;
    const selected = (status.tabs || []).find(tab => tab.tabId === status.activeTab) || status.tabs?.[0];
    const id = browserTabConversation(selected);
    view = browserTabKind(selected) === 'ai' ? {kind:'ai', filter:id ? 'conversation:' + id : 'unassigned'} : {kind:'user', filter:'all'};
  }
  function enter() {
    const current = context();
    if (current !== lastContext) {
      if (current) followContext = current;
      else if (lastContext !== undefined) { rememberSelection(getTab()?.tabId); view = {kind:'user', filter:'all'}; }
      lastContext = current;
    }
  }
  const option = (parent, value, label, disabled = false) => {
    const item = text(parent, label, 'option'); item.value = value; item.disabled = disabled; return item;
  };
  function render() {
    if (destroyed) return;
    chooseInitial();
    const currentView = view || {kind:'user', filter:'all'};
    const tabs = Array.isArray(status.tabs) ? status.tabs : [];
    const personal = tabs.filter(tab => browserTabKind(tab) === 'user').length, ai = tabs.length - personal;
    const unassigned = tabs.filter(tab => browserTabKind(tab) === 'ai' && !browserTabConversation(tab)).length;
    const disabled = Boolean(moving) || isBusy();
    ui.personal.textContent = 'Personal (' + personal + ')'; ui.ai.textContent = 'AI tabs (' + ai + ')';
    ui.personal.setAttribute('aria-pressed', String(currentView.kind === 'user'));
    ui.ai.setAttribute('aria-pressed', String(currentView.kind === 'ai'));
    ui.personal.disabled = disabled; ui.ai.disabled = disabled;
    ui.label.hidden = currentView.kind !== 'ai'; ui.conversation.disabled = disabled;
    const options = [['all', 'All conversations (' + ai + ')']];
    if (unassigned || currentView.filter === 'unassigned') options.push(['unassigned', 'Unassigned (' + unassigned + ')']);
    for (const item of conversations) options.push(['conversation:' + item.id, item.title + ' (' + item.tabCount + ')']);
    if (currentView.filter?.startsWith('conversation:') && !options.some(([value]) => value === currentView.filter))
      options.push([currentView.filter, 'Conversation unavailable (' + browserOwnershipTabs(tabs,currentView).length + ')']);
    const key = JSON.stringify(options);
    if (key !== conversationKey) {
      conversationKey = key; ui.conversation.replaceChildren();
      for (const [value, label] of options) option(ui.conversation, value, label);
    }
    ui.conversation.value = currentView.filter || 'all';
    const chosen = conversations.find(item => 'conversation:' + item.id === currentView.filter);
    ui.hint.textContent = currentView.kind === 'user' ? 'Your tabs · no conversation'
      : chosen ? chosen.title : currentView.filter === 'unassigned' ? 'AI tabs without a conversation' : 'All AI conversations';
    ui.hint.title = ui.hint.textContent;
    const tab = getTab(), owned = browserTabConversation(tab);
    const destinations = [['user', 'Personal · keep for myself', browserTabKind(tab) === 'user']];
    for (const item of conversations) destinations.push(['conversation:' + item.id, item.title, owned === item.id]);
    const nextMoveKey = JSON.stringify([tab?.tabId, destinations]);
    if (moveKey !== nextMoveKey) {
      moveKey = nextMoveKey; ui.move.replaceChildren(); option(ui.move, '', 'Move tab to…');
      for (const [value, label, unavailable] of destinations) option(ui.move, value, label, unavailable);
    }
    ui.move.disabled = disabled || !tab || !tab.documentId;
    ui.move.title = tab ? 'Move this tab to Personal or another conversation' : 'Select a tab to move';
    if (!moving) ui.move.value = '';
  }
  function change(next, {notify = true} = {}) {
    rememberSelection(getTab()?.tabId);
    view = next; followContext = null;
    render(); if (notify) onViewChange();
  }
  function setView(next) {
    if (moving || isBusy()) { render(); return; }
    change(next);
  }
  ui.personal.addEventListener('click', () => setView({kind:'user', filter:view?.filter || 'all'}));
  ui.ai.addEventListener('click', () => setView({kind:'ai', filter:view?.filter || 'all'}));
  ui.conversation.addEventListener('change', () => setView({kind:'ai', filter:ui.conversation.value || 'all'}));
  ui.move.addEventListener('change', async () => {
    const destination = ui.move.value; ui.move.value = '';
    if (!destination || moving || isBusy() || destroyed) return;
    const tab = getTab(); let request;
    try { request = browserOwnershipRequest(tab, destination, conversations); }
    catch (error) { notice(error.message, true); return; }
    if (request.destination === 'user' && browserTabKind(tab) === 'user'
      || request.conversationId && request.conversationId === browserTabConversation(tab)) return;
    moving = {tabId:tab.tabId}; onMoveStart(); render();
    try {
      const data = await api('/api/browser/ownership', 'POST', request, {deadlineMs:20000});
      if (destroyed) return;
      if (!Array.isArray(data?.tabs) || !data.tabs.some(item => item.tabId === tab.tabId))
        throw Error('The move could not be confirmed. Refresh the tabs to check its destination.');
      change(request.destination === 'user' ? {kind:'user', filter:'all'}
        : {kind:'ai', filter:'conversation:' + request.conversationId}, {notify:false});
      onMoveStatus(data, {preferred:tab.tabId});
      const title = request.destination === 'user' ? 'Personal' : conversations.find(item => item.id === request.conversationId)?.title || 'conversation';
      const count = data.ownershipReceipt?.movedTabIds?.length || 1;
      notice((count > 1 ? count + ' linked tabs moved to ' : 'Tab moved to ') + title + '.');
    } catch (error) { if (!destroyed) notice(error.message, true); }
    finally { moving = null; if (!destroyed) { onMoveEnd(); render(); } }
  });
  return {
    enter, render, rememberSelection,
    selection() { return selections.get(selectionKey()) || null; },
    update(data) { status = data || {tabs:[]}; hasStatus = true; conversations = browserConversationCatalog(status); chooseInitial(); render(); },
    visible(tabs) {
      const visible = browserOwnershipTabs(tabs, view);
      // A status event can arrive before the move response. Hold that page in
      // place until its destination is confirmed instead of flashing away.
      const pending = moving && tabs.find(tab => tab.tabId === moving.tabId);
      if (pending && !visible.includes(pending)) visible.push(pending);
      return visible;
    },
    personal({notify = false} = {}) { change({kind:'user', filter:'all'}, {notify}); },
    openConversation(id) {
      if (typeof id !== 'string' || !id) return;
      change({kind:'ai', filter:'conversation:' + id});
    },
    emptyLabel() {
      if (view?.kind !== 'ai') return 'No Personal tabs yet';
      if (view.filter === 'all') return 'No AI tabs yet';
      if (view.filter === 'unassigned') return 'No unassigned AI tabs';
      return 'No tabs in this conversation';
    },
    get view() { return {...view}; },
    destroy() { destroyed = true; },
  };
}
