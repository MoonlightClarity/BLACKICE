const identity=value=>typeof value==='string'&&value.length>0&&value.length<=240?value:null;

/** Project the observed folder/parent metadata without inventing browser pages. */
export function browserTreeModel(status={}){
 const tabs=new Map(),duplicates=new Set();
 for(const tab of Array.isArray(status.tabs)?status.tabs:[]){const id=identity(tab?.tabId);if(!id)continue;if(tabs.has(id))duplicates.add(id);else tabs.set(id,{...tab,tabId:id,children:[]});}
 for(const id of duplicates)tabs.delete(id);
 const folders=new Map();
 for(const folder of Array.isArray(status.folders)?status.folders:[]){const id=identity(folder?.id);if(id&&!folders.has(id))folders.set(id,{...folder,id,name:String(folder.name||'Untitled folder').slice(0,200),kind:folder.kind==='task'?'task':'user',roots:[],count:0,live:0,saved:0});}
 const ungrouped={id:null,name:'Other pages',kind:'user',roots:[],count:0,live:0,saved:0};
 const groupFor=tab=>folders.get(tab.folderId)||ungrouped,parents=new Map();
 for(const tab of tabs.values()){
  const parent=tabs.get(tab.parentTabId);
  parents.set(tab.tabId,parent&&parent!==tab&&groupFor(parent)===groupFor(tab)?parent.tabId:null);
 }
 // Corrupt or older metadata must not hide pages or create a rendering loop.
 for(const id of parents.keys()){
  const path=new Set([id]);let parent=parents.get(id);
  while(parent){if(path.has(parent)){parents.set(id,null);break;}path.add(parent);parent=parents.get(parent);}
 }
 for(const tab of tabs.values()){
  const folder=groupFor(tab),parent=tabs.get(parents.get(tab.tabId));
  tab.parentTabId=parent?.tabId||null;
  (parent?parent.children:folder.roots).push(tab);folder.count++;folder[tab.suspended===true?'saved':'live']++;
 }
 const groups=[...folders.values(),...(ungrouped.count?[ungrouped]:[])];
 return{folders:groups,count:tabs.size,live:[...tabs.values()].filter(tab=>tab.suspended!==true).length,saved:[...tabs.values()].filter(tab=>tab.suspended===true).length};
}

export function browserFolderDOMId(folderId,prefix='browser-folder'){
 return prefix+'-'+Array.from(String(folderId??'ungrouped'),character=>character.codePointAt(0).toString(16)).join('-');
}

export function browserCapacityLabel(status={}){
 const capacity=status.capacity;
 if(!capacity||![capacity.live,capacity.maxLive,capacity.saved].every(value=>Number.isSafeInteger(value)&&value>=0))return '';
 return `${capacity.live} of ${capacity.maxLive} live · ${capacity.saved} retained`;
}

export function browserPersistenceMessage(status={}){
 const persistence=status.persistence||status.browsers?.relay?.persistence;
 if(persistence?.healthy!==false)return '';
 const reason=typeof persistence.error==='string'&&persistence.error.trim()?persistence.error.slice(0,600):'Browser folders and pages could not be saved.';
 return `${reason} Changes may not survive a restart.`;
}

/** A suspension receipt must agree with the observed state of its exact page. */
export function browserSuspensionOutcome(status,tabId){
 const receipt=status?.receipt?.tabId===tabId?status.receipt:null;
 if(receipt?.suspended===false)return{suspended:false,message:'Page stayed live. '+(typeof receipt.reason==='string'&&receipt.reason.trim()?receipt.reason.slice(0,600):'The browser could not suspend it.')};
 const tab=status?.tabs?.find(tab=>tab.tabId===tabId);
 if(tab?.suspended===true)return{suspended:true,message:'Page suspended. It remains in its folder; select or refresh it to load it again.'};
 return{suspended:false,message:'Suspension could not be confirmed. Inspect the current page before trying again.'};
}

export function browserParentChoices(status,tabId,folderId){
 const tabs=Array.isArray(status?.tabs)?status.tabs:[],excluded=new Set([tabId]),current=tabs.find(tab=>tab.tabId===tabId);
 const sameOwner=tab=>current?.owner?tab.owner?.taskId===current.owner.taskId&&tab.owner?.nodeId===current.owner.nodeId:!tab.owner;
 let changed=true;while(changed){changed=false;for(const tab of tabs)if(excluded.has(tab.parentTabId)&&!excluded.has(tab.tabId)){excluded.add(tab.tabId);changed=true;}}
 return tabs.filter(tab=>identity(tab.tabId)&&tab.folderId===folderId&&!excluded.has(tab.tabId)&&sameOwner(tab));
}
