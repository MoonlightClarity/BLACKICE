/** Folders organize all tabs. An explicit in-use mark is independent of task ownership. */
export const browserTabUsageLabel=tab=>tab?.inUse?'In use':'';
export function browserUsageMarkup(){return '<div class="next-browser-usage" aria-label="Tab usage"><span>All tabs</span><button id="next-browser-in-use" type="button" aria-pressed="false" disabled>Mark in use</button></div>';}
export function createBrowserUsageControls({mount,api,getTab,isBusy=()=>false,onMoveStart=()=>{},onMoveStatus=()=>{},onMoveEnd=()=>{},notice=()=>{}}){
 const button=mount.querySelector('#next-browser-in-use');let marking=false,destroyed=false,selection=null;
 function render(){const tab=getTab();button.disabled=marking||isBusy()||!tab;button.textContent=tab?.inUse?'Release in-use mark':'Mark in use';button.setAttribute('aria-pressed',String(Boolean(tab?.inUse)));button.title='Protect this tab from automatic cleanup until released';}
 button.addEventListener('click',async()=>{const tab=getTab();if(!tab||marking||isBusy()||destroyed)return;const id=tab.tabId,inUse=!tab.inUse;
  marking=true;onMoveStart();render();try{const data=await api('/api/browser/action','POST',{browser:'relay',action:'tab_mark',tabId:id,inUse});if(destroyed)return;if(!Array.isArray(data?.tabs)||!data.tabs.some(t=>t.tabId===id&&Boolean(t.inUse)===inUse))throw Error('The in-use change was not confirmed. Refresh before retrying.');onMoveStatus(data,{preferred:id});}
  catch(e){if(!destroyed)notice(e.message,true);}finally{marking=false;if(!destroyed){onMoveEnd();render();}}
 });
 return{render,enter:render,update:render,visible:tabs=>tabs||[],rememberSelection:id=>{selection=id;},selection:()=>selection,emptyLabel:()=> 'No tabs yet',get view(){return {kind:'all',filter:'all'};},destroy(){destroyed=true;}};
}
