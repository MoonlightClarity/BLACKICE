// Only label the visible workspace as selected. Cross-workspace views such as
// reusable workflows are not owned by whichever main tab first linked to them.
// Keep the tab row keyboard-reachable even when no top-level tab is selected.
export function updateWorkspaceTabs(tabs, workspace) {
  const items=Array.from(tabs);
  const selectedIndex=items.findIndex(tab=>tab.dataset.space===workspace);
  for(const [index,tab] of items.entries()){
    const selected=index===selectedIndex;
    tab.setAttribute('aria-selected',String(selected));
    tab.tabIndex=selected||(selectedIndex<0&&index===0)?0:-1;
  }
}
