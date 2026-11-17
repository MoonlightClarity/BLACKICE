export const browserFoldersMarkup=()=>''; // Folder UI is owned by the bundled tab extension.
export function browserCollectionTree(collections,tabs){
 const map=new Map((collections||[]).map(f=>[f.id,{...f,children:[],tabs:[]}]));
 const roots=[],loose=[];for(const f of map.values()){let id=f.parentId,valid=map.has(id),seen=new Set([f.id]);while(id){if(seen.has(id)){valid=false;break;}seen.add(id);id=map.get(id)?.parentId;}(valid?map.get(f.parentId).children:roots).push(f);}
 for(const tab of tabs||[])(map.get(tab.collectionId)?.tabs||loose).push(tab);return {roots,loose};
}
export function createBrowserFolders({api,getTabs,getSelected,isBusy,refresh,notice}){
 let collections=[],host=null,pending=false,destroyed=false,revision=0;
 const allowed={collection_create:['name','parentCollectionId'],collection_rename:['collectionId','name','parentCollectionId'],collection_remove:['collectionId'],tab_collect:['tabId','collectionId']};
 async function request(){
  let value;try{value=JSON.parse(host.getAttribute('data-blackice-tab-request')||'null');}catch{return;}
  host.removeAttribute('data-blackice-tab-request');
  if(!value||!allowed[value.action]||Object.keys(value).some(k=>k!=='action'&&!allowed[value.action].includes(k))||pending||isBusy()||destroyed)return;
  // Only expose already rendered tabs. Existing driver admission retains ownership.
  if(value.action==='tab_collect'&&!getTabs().some(t=>t.tabId===value.tabId))return;
  pending=true;publish();
  try{await api('/api/browser/action','POST',{browser:'relay',...value});if(!destroyed)await refresh();}
  catch(error){if(!destroyed)notice(error.message,true);}
  finally{pending=false;if(!destroyed)publish();}
 }
 function publish(){if(host&&!destroyed)host.setAttribute('data-blackice-tab-model',JSON.stringify({version:1,revision:++revision,collections,tabs:getTabs().map(t=>({tabId:t.tabId,collectionId:t.collectionId||null})),selected:getSelected(),busy:pending||isBusy()}));}
 function captureFocus(strip){const id=strip.ownerDocument?.activeElement?.dataset?.tabId;return()=>{if(id)[...strip.querySelectorAll('[data-tab-id]')].find(n=>n.dataset.tabId===id)?.focus?.({preventScroll:true});};}
 return {captureFocus,groupTabs(strip){if(host!==strip){host?.removeEventListener('blackice-tab-action',request);host=strip;host.addEventListener('blackice-tab-action',request);}publish();},update(data){collections=Array.isArray(data.collections)?data.collections:[];publish();},render:publish,destroy(){destroyed=true;host?.removeEventListener('blackice-tab-action',request);host?.removeAttribute('data-blackice-tab-model');}};
}
