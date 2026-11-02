/**
 * Find previously downloaded Windows 11 installation media before asking the
 * user to obtain another multi-gigabyte image. Never downloads or modifies
 * media, and never treats the installed host OS as a guest installation image.
 */
import {promises as fs} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {inspectWorkbenchMedia} from './workbench-provisioning.mjs';

export function workbenchMediaSearchFolders({home=homedir(),dataDir,oneDrive=process.env.OneDrive}={}){
  const dirs=[path.join(home,'Downloads'),path.join(home,'Desktop'),
    path.join(home,'Documents'),path.join(home,'OneDrive','Downloads'),
    ...(oneDrive?[path.join(oneDrive,'Downloads'),path.join(oneDrive,'Desktop')]:[]),
    ...(dataDir?[path.join(dataDir,'workbench-media')]:[])];
  const seen=new Set();
  return dirs.filter(dir=>{const key=path.resolve(dir).toLowerCase();if(seen.has(key))return false;seen.add(key);return true});
}

export async function discoverWorkbenchMedia({directories=workbenchMediaSearchFolders(),
  readdir=fs.readdir,stat=fs.stat,inspect=inspectWorkbenchMedia}={}){
  const candidates=[],seen=new Set(),pending=directories.map(dir=>({dir,depth:0}));
  let visited=0;
  while(pending.length&&visited<20&&candidates.length<20){
    const {dir,depth}=pending.shift();visited++;
    let entries;
    try{entries=(await readdir(dir,{withFileTypes:true})).slice(0,1500)}catch{continue}
    for(const item of entries){
      if(item.isDirectory()&&depth===0&&/(?:iso|windows|installation|media)/i.test(item.name))
        pending.push({dir:path.join(dir,item.name),depth:1});
      // Microsoft's Media Creation Tool commonly saves `Windows.iso`, while
      // the direct-download page uses `Win11_<release>_<language>_x64.iso`.
      // Restrict discovery to recognizable Windows names; a generic Linux ISO
      // must not silently become the VM's only suggested installation image.
      if(!item.isFile()||!/^(?:windows11|windows|win11)(?:[_. -].*)?\.iso$/i.test(item.name))continue;
      const absolute=path.join(dir,item.name),key=path.resolve(absolute).toLowerCase();
      if(seen.has(key))continue;seen.add(key);
      try{
        const media=await inspect(absolute),info=await stat(absolute);
        candidates.push({path:absolute,size:media.size,modifiedAt:info.mtime.toISOString(),
          validation:'ISO9660 header and file size; origin and Windows edition not authenticated'});
      }catch{/* Keep invalid, unreadable or incomplete files out of one-click choices. */}
      if(candidates.length>=20)break;
    }
  }
  candidates.sort((a,b)=>Date.parse(b.modifiedAt)-Date.parse(a.modifiedAt));
  return {candidates,checkedFolders:visited,source:'existing-local-media'};
}
