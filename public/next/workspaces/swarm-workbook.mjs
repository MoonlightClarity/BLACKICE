// Presentation only. Filing never changes work status or establishes proof.
export const organizationOf = data => data?.organization || {revision:0,folders:[],projectFolders:{},itemFolders:{}};
export function folderPath(org,id){const names=[],seen=new Set();while(id&&!seen.has(id)){seen.add(id);const f=org.folders.find(x=>x.id===id);if(!f)break;names.unshift(f.name);id=f.parentId;}return names.join(' / ')||'Unfiled';}
export function inFolder(org,id,selected){if(selected===':all')return true;if(selected===':unfiled')return id==null;const seen=new Set();while(id&&!seen.has(id)){if(id===selected)return true;seen.add(id);id=org.folders.find(f=>f.id===id)?.parentId;}return false;}
export const taskFolder=(org,project,item)=>Object.hasOwn(org.itemFolders,project.id+'/'+item.id)?org.itemFolders[project.id+'/'+item.id]:(org.projectFolders[project.id]||null);
export function workbookRows(data,{folder=':all',projectId=null,phase='all',query='',lifecycle='active'}={}){
 const org=organizationOf(data),search=query.trim().toLocaleLowerCase();
 return (data?.projects||[]).filter(p=>(p.lifecycle||'active')===lifecycle&&(!projectId||p.id===projectId))
 .flatMap(project=>project.items.filter(item=>inFolder(org,taskFolder(org,project,item),folder)
 &&(phase==='all'||item.phase===phase)&&(!search||[item.title,item.scope,project.name,project.workers.find(w=>w.id===item.ownerId)?.label].join(' ').toLocaleLowerCase().includes(search)))
 .map(item=>({project,item,folderId:taskFolder(org,project,item)})));
}
export function evidenceSummary(item){
 if(item.unresolvedFailures?.length)return {label:'Failed evidence',state:'contradicted'};
 const entries=item.applicableEvidence||[];
 if(item.staleEvidence?.length&&!entries.length)return {label:'Stale evidence',state:'stale'};
 if(!entries.length)return {label:'Unknown',state:'unknown'};
 for(const epistemic of ['observed','derived','inferred'])if(entries.some(e=>e.epistemic===epistemic))
 return {label:epistemic==='observed'?'Observed (reported)':epistemic[0].toUpperCase()+epistemic.slice(1),state:epistemic};
 return {label:'Unknown',state:'unknown'};
}
export function runtimeSummary(item){
 const launch=item.nativeLaunch;
 if(!launch)return 'No launch recorded';
 if(launch.applicable===false)return 'Previous launch stale';
 if(launch.state==='settled')return 'Runtime '+(launch.result?.status||'unknown');
 if(launch.state==='provider_attempted')return 'Dispatch authorized';
 return 'Launch reserved';
}
