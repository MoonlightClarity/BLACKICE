const browserIconPaths={
 back:'M15 5 8 12l7 7',forward:'m9 5 7 7-7 7',reload:'M20 7v5h-5 M19 12a7 7 0 1 0-2 5',
 go:'M4 12h16m-6-6 6 6-6 6',plus:'M12 5v14M5 12h14',close:'m6 6 12 12M18 6 6 18',
 key:'M15 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM11 13l-7 7H2v-3l7-7',
 tools:'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6',
 download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
 closeAll:'M7 3h14v14M3 7h14v14H3ZM7 11l6 6m0-6-6 6',
 folder:'M3 6h7l2 3h9v11H3ZM12 12v6m-3-3h6',
 move:'M3 7h7l2 3h9v10H3ZM12 3v10m-3-3 3 3 3-3',
 pin:'M8 3h8l-1 6 4 4v2H5v-2l4-4ZM12 15v6',
 unpin:'M4 4l16 16M8 3h8l-1 6 4 4v2h-3M8 9l-3 4v2h6m1 2v4',
 read:'M4 3h16v18H4ZM8 7h8M8 11h8M8 15h5',
 camera:'M3 7h5l2-3h4l2 3h5v14H3ZM16 13a4 4 0 1 0-8 0 4 4 0 0 0 8 0'
};
/** Fixed local SVG paths only. Labels stay on the control, never inside SVG markup. */
export function browserIconButton(button,icon,label,tooltip=label){
 if(!button)return;
 const path=browserIconPaths[icon];if(!path)throw Error('Unknown browser icon');
 if(button.dataset.browserIcon!==icon){button.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="'+path+'"></path></svg>';button.dataset.browserIcon=icon;}
 button.classList.add('next-browser-icon-button');button.setAttribute('aria-label',label);button.title=tooltip;
}
/** Folders organize all tabs. An explicit in-use mark is independent of task ownership. */
export const browserTabUsageLabel=tab=>tab?.inUse?'In use':'';
export function browserUsageMarkup(){return '<div class="next-browser-usage" role="group" aria-label="Tab usage"><button id="next-browser-in-use" type="button" aria-pressed="false" disabled>Mark in use</button></div>';}
export function createBrowserUsageControls({mount,api,getTab,isBusy=()=>false,onMoveStart=()=>{},onMoveStatus=()=>{},onMoveEnd=()=>{},notice=()=>{}}){
 const button=mount.querySelector('#next-browser-in-use');let marking=false,destroyed=false,selection=null;
 function render(){const tab=getTab();button.disabled=marking||isBusy()||!tab;browserIconButton(button,tab?.inUse?'unpin':'pin',tab?.inUse?'Release in-use mark':'Mark in use',tab?.inUse?'Release in-use mark; this tab can then be cleaned up':'Mark in use; protect this tab from automatic cleanup');button.setAttribute('aria-pressed',String(Boolean(tab?.inUse)));}
 button.addEventListener('click',async()=>{const tab=getTab();if(!tab||marking||isBusy()||destroyed)return;const id=tab.tabId,inUse=!tab.inUse;
  marking=true;onMoveStart();render();try{const data=await api('/api/browser/action','POST',{browser:'relay',action:'tab_mark',tabId:id,inUse});if(destroyed)return;if(!Array.isArray(data?.tabs)||!data.tabs.some(t=>t.tabId===id&&Boolean(t.inUse)===inUse))throw Error('The in-use change was not confirmed. Refresh before retrying.');onMoveStatus(data,{preferred:id});}
  catch(e){if(!destroyed)notice(e.message,true);}finally{marking=false;if(!destroyed){onMoveEnd();render();}}
 });
 return{render,enter:render,update:render,visible:tabs=>tabs||[],rememberSelection:id=>{selection=id;},selection:()=>selection,emptyLabel:()=> 'No tabs yet',get view(){return {kind:'all',filter:'all'};},destroy(){destroyed=true;}};
}
