// Filing metadata does not change requirements, proof applicability, or execution.
export const organizationActions = ['create_folder','edit_folder','remove_folder','file_project','file_item'];
export const organizationView = state => structuredClone(state.organization || {revision:0,folders:[],projectFolders:{},itemFolders:{}});
const fail = (message,code='SWARM_INVALID',status=400,extra={}) => {throw Object.assign(new Error(message),{code,status,...extra});};
const ident = value => typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const known = (org,value) => value===null || ident(value)&&org.folders.some(f=>f.id===value);
const owns = (folder,actor) => actor.kind==='human'||folder.createdBy?.kind===actor.kind&&folder.createdBy?.id===actor.id;
const assign = (map,key,value) => Object.defineProperty(map,key,{value,writable:true,enumerable:true,configurable:true});
export function organizeSwarm(state,request,actor) {
 const org=organizationView(state),v=request.value;let change={};
 if(!v||typeof v!=='object'||Array.isArray(v))fail('Folder value must be an object.');
 if(!Number.isSafeInteger(request.expectedOrganizationRevision)||request.expectedOrganizationRevision!==org.revision)
   fail('Swarm folders changed; refresh before saving.','SWARM_REVISION_CONFLICT',409,{currentRevision:org.revision});
 const keys={create_folder:['id','name','parentId'],edit_folder:['id','name','parentId'],remove_folder:['id'],file_project:['folderId'],file_item:['folderId']};
 if(!keys[request.action]||Object.keys(v).some(k=>!keys[request.action].includes(k)))fail('Unsupported folder fields.');
 const folderId=value=>{if(!known(org,value))fail('Folder not found.','SWARM_NOT_FOUND',404);return value;};
 if(['create_folder','edit_folder'].includes(request.action)){
   if(!ident(v.id))fail('A stable folder ID is required.');
   const old=org.folders.find(f=>f.id===v.id);
   if(request.action==='create_folder'&&old)fail('Folder already exists.','SWARM_CONFLICT',409);
   if(request.action==='edit_folder'&&!old)fail('Folder not found.','SWARM_NOT_FOUND',404);

   const name=v.name===undefined?old?.name:v.name;
   if(typeof name!=='string'||!name.trim()||name.length>160||name.includes('\0'))fail('Folder name must be nonempty text under 160 characters.');
   const parentId=folderId(v.parentId===undefined?(old?.parentId||null):v.parentId);
   const visited=new Set();
   for(let current=parentId;current;current=org.folders.find(f=>f.id===current)?.parentId){
     if(current===v.id||visited.has(current))fail('A folder cannot contain itself or an ancestor.');
     visited.add(current);
   }
   change={before:old?structuredClone(old):null,after:{id:v.id,name:name.trim(),parentId}};
   if(old)Object.assign(old,{name:name.trim(),parentId});
   else org.folders.push({id:v.id,name:name.trim(),parentId,createdBy:structuredClone(actor)});
 } else if(request.action==='remove_folder'){
   if(!ident(v.id))fail('A stable folder ID is required.');
   const f=org.folders.find(f=>f.id===v.id);if(!f)fail('Folder not found.','SWARM_NOT_FOUND',404);

   change={removed:structuredClone(f),children:org.folders.filter(x=>x.parentId===f.id).map(x=>x.id),projects:Object.keys(org.projectFolders).filter(k=>org.projectFolders[k]===f.id),items:Object.keys(org.itemFolders).filter(k=>org.itemFolders[k]===f.id)};
   org.folders=org.folders.filter(x=>x.id!==f.id);
   for(const child of org.folders)if(child.parentId===f.id)child.parentId=f.parentId;
   for(const map of [org.projectFolders,org.itemFolders])for(const key of Object.keys(map))
     if(map[key]===f.id)assign(map,key,f.parentId);
 } else {
   if(!ident(request.projectId))fail('A project ID is required.');
   const project=state.projects.find(p=>p.id===request.projectId);
   if(!project)fail('Project not found.','SWARM_NOT_FOUND',404);
   const target=folderId(v.folderId);
   if(request.action==='file_project'){change={projectId:project.id,previouslyFiled:Object.hasOwn(org.projectFolders,project.id),before:org.projectFolders[project.id]??null,after:target};assign(org.projectFolders,project.id,target);}
   else {
     if(!ident(request.itemId)||!project.items.some(i=>i.id===request.itemId))fail('Task not found.','SWARM_NOT_FOUND',404);
     const key=project.id+'/'+request.itemId;change={projectId:project.id,itemId:request.itemId,previouslyFiled:Object.hasOwn(org.itemFolders,key),before:org.itemFolders[key]??null,after:target};
     assign(org.itemFolders,key,target);
   }
 }
 org.revision++;state.organization=org;
 return {folderId:v.id||v.folderId||null,organizationOnly:true,change};
}
export function scopedOrganization(state,projects,actor){
 const org=organizationView(state),ids=new Set(projects.map(p=>p.id)),used=new Set();
 const projectFolders=Object.fromEntries(Object.entries(org.projectFolders).filter(([id])=>ids.has(id)));
 const itemFolders=Object.fromEntries(Object.entries(org.itemFolders).filter(([id])=>ids.has(id.split('/')[0])));
 for(const f of [...Object.values(projectFolders),...Object.values(itemFolders)])if(f)used.add(f);
 for(const f of org.folders)if(owns(f,actor))used.add(f.id);
 for(const id of [...used]){let f=org.folders.find(x=>x.id===id);const seen=new Set();while(f?.parentId&&!seen.has(f.parentId)){seen.add(f.parentId);used.add(f.parentId);f=org.folders.find(x=>x.id===f.parentId);}}
 return {...org,folders:org.folders.filter(f=>used.has(f.id)),projectFolders,itemFolders};
}
