import {randomUUID} from 'node:crypto';
const problem=message=>Object.assign(new Error(message),{code:'BROWSER_COLLECTION_INVALID'});
export function restoreBrowserCollections(value){
 const map=new Map();
 for(const item of Array.isArray(value)?value:[])if(item&&typeof item.id==='string'&&item.id.length<=200&&typeof item.name==='string'&&item.name.trim())map.set(item.id,{id:item.id,name:item.name.slice(0,200),parentId:typeof item.parentId==='string'?item.parentId:null});
 for(const item of map.values()){
  const seen=new Set([item.id]);let id=item.parentId;
  while(id){if(!map.has(id)||seen.has(id)){item.parentId=null;break;}seen.add(id);id=map.get(id).parentId;}
 }
 return map;
}
export function organizeBrowserCollection(collections,tabs,args){
 const parent=args.parentCollectionId||null;
 if(parent&&!collections.has(parent))throw problem('Choose an existing parent folder.');
 if(args.action==='collection_create'){
  if(typeof args.name!=='string'||!args.name.trim()||args.name.length>200)throw problem('Enter a folder name of up to 200 characters.');
  const folder={id:'collection_'+randomUUID(),name:args.name.trim(),parentId:parent};collections.set(folder.id,folder);return folder;
 }
 if(args.action==='tab_collect'){
  const tab=tabs.get(args.tabId);if(!tab)throw problem('Choose an existing tab.');
  if(args.collectionId&&!collections.has(args.collectionId))throw problem('Choose an existing folder.');
  tab.collectionId=args.collectionId||null;return;
 }
 const folder=collections.get(args.collectionId);if(!folder)throw problem('Choose an existing folder.');
 if(args.action==='collection_rename'){
  if(typeof args.name!=='string'||!args.name.trim()||args.name.length>200)throw problem('Enter a folder name of up to 200 characters.');
  if(Object.hasOwn(args,'parentCollectionId')){for(let id=parent;id;id=collections.get(id)?.parentId)if(id===folder.id)throw problem('A folder cannot contain itself.');folder.parentId=parent;}
  folder.name=args.name.trim();
 }else if(args.action==='collection_move'){
  for(let id=parent;id;id=collections.get(id)?.parentId)if(id===folder.id)throw problem('A folder cannot contain itself.');
  folder.parentId=parent;
 }else if(args.action==='collection_remove'){
  for(const child of collections.values())if(child.parentId===folder.id)child.parentId=folder.parentId;
  for(const tab of tabs.values())if(tab.collectionId===folder.id)tab.collectionId=folder.parentId;
  collections.delete(folder.id);
 }else throw problem('Unknown folder action.');
}
