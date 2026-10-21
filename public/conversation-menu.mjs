/** A row menu never selects a chat: its target is captured separately from the composer. */
export function conversationMenuActions(target) {
  if (!target) return [];
  return [
    ...(['active', 'archived'].includes(target.state) ? [{ action: 'rename', label: 'Rename', disabled: false, title: 'Rename this chat (F2)', shortcut: 'F2' }] : []),
    ...(target.state === 'active' ? [{ action: 'archive', label: 'Archive', disabled: false }] : [{ action: 'restore', label: 'Restore', disabled: false }]),
    ...(target.state !== 'deleted' ? [{ action: 'delete', label: 'Delete', disabled: target.working === true, title: target.working ? 'Stop this chat before deleting it.' : 'Move this whole chat to Trash. You can restore it.' }] : []),
  ];
}

export function conversationMenuPosition({ x, y, width, height, viewportWidth, viewportHeight, margin = 8 }) {
  const bound = (value, size, viewport) => Math.max(margin, Math.min(Number.isFinite(value) ? value : margin, viewport - size - margin));
  return { left: bound(x, width, viewportWidth), top: bound(y, height, viewportHeight) };
}

export function initConversationMenu({ mount, resolveTarget, onAction, onError, fallbackFocus }) {
  const menu = document.createElement('div');
  menu.className = 'conversation-row-menu'; menu.hidden = true; menu.tabIndex = -1;
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Chat actions'); mount.append(menu);
  let opened = null, busy = false, disposed = false;
  const enabledItems = () => [...menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled);
  const ownsFocus = () => document.activeElement === menu || menu.contains(document.activeElement);
  function close({ restoreFocus = true } = {}) {
    if (!opened) return;
    const previous = opened, focused = ownsFocus(); opened = null; menu.hidden = true;
    previous.row.removeAttribute('aria-expanded');
    if (restoreFocus && focused && !disposed) {
      const next = previous.row.isConnected ? previous.row : fallbackFocus?.();
      next?.focus({ preventScroll: true });
    }
  }
  function open(row, point) {
    if (disposed || busy) return;
    const target = resolveTarget(row.dataset.conversationId, row.dataset.id); if (!target) { close(); return; }
    close({ restoreFocus: false });
    opened = { row, target: { ...target } }; row.setAttribute('aria-expanded', 'true'); menu.removeAttribute('aria-busy');
    menu.setAttribute('aria-label', `Actions for ${target.title || 'chat'}`);
    menu.innerHTML = conversationMenuActions(target).map(item => `<button type="button" role="menuitem" data-chat-action="${item.action}"${item.disabled ? ' disabled aria-disabled="true"' : ''}${item.title ? ` title="${item.title}"` : ''}${item.shortcut ? ` aria-keyshortcuts="${item.shortcut}"` : ''}>${item.label}</button>`).join('') + (target.working && target.state !== 'deleted' ? '<p class="conversation-row-menu-note" role="note">Stop this chat to delete it.</p>' : '');
    menu.hidden = false;
    const rect = menu.getBoundingClientRect(), position = conversationMenuPosition({ ...point, width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    menu.style.left = `${position.left}px`; menu.style.top = `${position.top}px`;
    (enabledItems()[0] || menu).focus({ preventScroll: true });
  }
  const rowForEvent = event => { const row = event.target.closest?.('[data-conversation-id]'); return row && mount.contains(row) ? row : null; };
  const onContextMenu = event => { const row = rowForEvent(event); if (!row) return; event.preventDefault(); event.stopPropagation(); open(row, { x: event.clientX, y: event.clientY }); };
  const onMoreClick = event => {
    const button = event.target.closest?.('[data-chat-more]'); if (!button || !mount.contains(button)) return;
    event.preventDefault(); event.stopPropagation();
    if (opened?.row === button) { close(); return; }
    const rect = button.getBoundingClientRect(); open(button, { x: rect.left, y: rect.bottom });
  };
  const onRowKey = async event => {
    if (disposed || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'F2') {
      if (busy || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const row = rowForEvent(event);
      if (!row || row !== document.activeElement) return;
      const target = resolveTarget(row.dataset.conversationId, row.dataset.id);
      if (!conversationMenuActions(target).some(item => item.action === 'rename' && !item.disabled)) return;
      event.preventDefault(); event.stopPropagation(); close({ restoreFocus: false });
      await performAction('rename', { ...target }); return;
    }
    if (!(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return;
    const row = rowForEvent(event); if (!row) return;
    event.preventDefault(); event.stopPropagation(); const rect = row.getBoundingClientRect(); open(row, { x: rect.left + 12, y: rect.bottom });
  };
  const onMenuKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); const items = enabledItems(); if (!items.length) return;
    const current = items.indexOf(document.activeElement), index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items[index].focus({ preventScroll: true });
  };
  async function performAction(action, target, { fromMenu = false } = {}) {
    if (disposed || busy || !conversationMenuActions(target).some(item => item.action === action && !item.disabled)) return;
    busy = true;
    if (fromMenu) {
      menu.setAttribute('aria-busy', 'true'); for (const item of menu.querySelectorAll('[role="menuitem"]')) { item.disabled = true; item.setAttribute('aria-disabled', 'true'); }
      menu.focus({ preventScroll: true });
    }
    try { await onAction(action, target); } catch (error) { if (!disposed) onError?.(error); }
    finally { busy = false; if (fromMenu) close(); }
  }
  const onMenuClick = async event => {
    const button = event.target.closest?.('[data-chat-action]'); if (!opened || !button || !menu.contains(button) || button.disabled || busy) return;
    event.preventDefault(); event.stopPropagation();
    await performAction(button.dataset.chatAction, opened.target, { fromMenu: true });
  };
  const onOutside = event => { if (opened && !menu.contains(event.target) && event.target.closest?.('[data-chat-more]') !== opened.row) close({ restoreFocus: false }); };
  const onDocumentKey = event => { if (opened && event.key === 'Escape' && !menu.contains(event.target)) { event.preventDefault(); event.stopPropagation(); close(); } };
  const onScroll = event => { if (opened && !menu.contains(event.target)) close(); };
  const onResize = () => close();
  mount.addEventListener('contextmenu', onContextMenu); mount.addEventListener('keydown', onRowKey); mount.addEventListener('click', onMoreClick);
  menu.addEventListener('keydown', onMenuKey); menu.addEventListener('click', onMenuClick);
  document.addEventListener('pointerdown', onOutside, true); document.addEventListener('keydown', onDocumentKey, true); document.addEventListener('scroll', onScroll, true); window.addEventListener('resize', onResize);
  return { close, destroy() {
    disposed = true; close({ restoreFocus: false }); menu.remove();
    mount.removeEventListener('contextmenu', onContextMenu); mount.removeEventListener('keydown', onRowKey); mount.removeEventListener('click', onMoreClick);
    menu.removeEventListener('keydown', onMenuKey); menu.removeEventListener('click', onMenuClick);
    document.removeEventListener('pointerdown', onOutside, true); document.removeEventListener('keydown', onDocumentKey, true); document.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onResize);
  } };
}
