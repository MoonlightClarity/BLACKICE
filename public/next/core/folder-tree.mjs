/** Shared presentation of explicit user-owned folder trees. No inference or persistence. */
export function folderRows(folders) {
  const rows=[], visited=new Set(), byParent=new Map();
  for(const folder of folders) {
    const parent=folder.parentId??null;
    if(!byParent.has(parent))byParent.set(parent,[]);
    byParent.get(parent).push(folder);
  }
  function walk(parent,depth,names) {
    for(const folder of byParent.get(parent)||[]) {
      if(visited.has(folder.id))continue;
      visited.add(folder.id);
      const path=[...names,folder.name].join(' / ');
      rows.push({...folder,parentId:folder.parentId??null,depth,path});
      walk(folder.id,depth+1,[...names,folder.name]);
    }
  }
  walk(null,0,[]);
  return rows;
}
export function folderPath(folders,id) { return folderRows(folders).find(row=>row.id===id)?.path||''; }
export function descendants(folders,id) {
  const found=new Set([id]);
  for(let changed=true;changed;) {
    changed=false;
    for(const folder of folders)if(found.has(folder.parentId)&&!found.has(folder.id)){found.add(folder.id);changed=true;}
  }
  return found;
}
