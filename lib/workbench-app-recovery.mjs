/**
 * Evidence-based recovery of WinGet-unmatched installed Windows applications.
 * Performs read-only package catalog searches. Exact stable name matches can
 * join a future guest import; ambiguous/driver/service entries remain visible
 * and are never silently installed.
 */
const fail=(message,code='WORKBENCH_APP_RECOVERY_INVALID')=>Object.assign(new Error(message),{code});
const ansi=/\u001b\[[0-9;]*[A-Za-z]/g;
const LOCALE='(?:[a-z]{2,3}(?:[-_][a-z]{2,4})?)';
export function normalizeInstalledAppName(name){
  if(typeof name!=='string')return '';
  let value=name.normalize('NFKC').toLowerCase().replace(/[®™©]/g,'').trim();
  value=value.replace(/\s*\((?:x64|x86|arm64|64-bit|32-bit)(?:\s+en[-_]us|\s+[a-z]{2,3}[-_][a-z]{2,4})?\)/gi,'')
    .replace(/\s*\((?:en[-_]us|[a-z]{2}[-_][a-z]{2,4})\)/gi,'')
    .replace(/\s*[-–]\s*en[-_]us$/gi,'')
    .replace(/\s+(?:64bit|32bit|64-bit|32-bit|x64|x86)\b$/gi,'')
    .replace(/\s+/g,' ').trim();
  return value.replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}
export function classifyUnmatchedHostName(name){
  const normalized=normalizeInstalledAppName(name);
  if(!normalized)return {category:'unclassified',searchable:false,reason:'No product name'};
  if(/^(?:microsoft windows(?: |$)|windows (?:update|security|app compatibility)|security update for |update for microsoft windows)/i.test(name)||
    /\b(?:graphics driver|display driver|chipset driver|bios update|firmware|thunderbolt(?:tm)? control center|audio driver|bluetooth driver|intel\(r\) (?:graphics|chipset)|hp system information)\b/i.test(name))
    return {category:'os_or_hardware',searchable:false,reason:'Host OS or device-specific component; the guest has its own OS and hardware'};
  if(/\b(?:maintenance service|update service|uninstall service|anti[- ]?cheat|vanguard|kernel driver)\b/i.test(name))
    return {category:'service_or_driver',searchable:false,reason:'Companion service or low-level driver; reinstall the parent application if suitable'};
  if(/\b(?:redistributable|runtime|webview2|windows sdk|visual c\+\+|windows installer)\b/i.test(name))
    return {category:'runtime_dependency',searchable:false,reason:'Runtime dependency usually installed by its parent app or guest setup'};
  return {category:'application',searchable:true,reason:'Look up a matching package before requesting another installer'};
}
const PACKAGE_ID=/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,179}$/;
export function parseWingetSearchResults(stdout,{limit=15}={}){
  if(typeof stdout!=='string'||stdout.length>180000)return [];
  const lines=stdout.replace(ansi,'').split(/\r?\n/).map(line=>line.replace(/[\u0000-\u001f]/g,''));
  const headerIndex=lines.findIndex(line=>/^\s*Name\s{2,}Id\s{2,}Version(?:\s|$)/i.test(line));
  if(headerIndex<0)return [];
  const header=lines[headerIndex];
  const idColumn=header.indexOf('Id',header.indexOf('Name')+4);
  const versionColumn=header.indexOf('Version',idColumn+2);
  if(idColumn<4||versionColumn<=idColumn+2)return [];
  const divider=lines.findIndex((line,i)=>i>headerIndex&&i<=headerIndex+3&&
    /^[\s-]+$/.test(line)&&line.replace(/\s/g,'').length>=15);
  if(divider<0)return [];
  const entries=[];
  for(let i=divider+1;i<lines.length&&entries.length<limit;i++){
    const line=lines[i];
    if(!line.trim()||/^(<additional|No package|The following packages|More than)/i.test(line.trim()))break;
    if(line.length<versionColumn)continue;
    const name=line.slice(0,idColumn).trim(),id=line.slice(idColumn,versionColumn).trim();
    const version=line.slice(versionColumn).trim().split(/\s{2,}/)[0].trim();
    if(!name||name.length>200||!PACKAGE_ID.test(id)||!version||version.length>100)continue;
    if(!entries.some(entry=>entry.id.toLowerCase()===id.toLowerCase()))entries.push({name,id,version,source:'winget'});
  }
  return entries;
}
const variants=/\b(?:beta|alpha|preview|nightly|esr|portable|insider|canary|developer build|dev edition|msix|arm64|32 bit)\b/i;
export function resolveWingetCandidate(installedName,results){
  const classification=classifyUnmatchedHostName(installedName);
  const clean=normalizeInstalledAppName(installedName);
  if(!classification.searchable)return {name:installedName,normalizedName:clean,
    classification:classification.category,status:'not_applicable',reason:classification.reason,candidates:[]};
  const pool=Array.isArray(results)?results.filter(x=>x&&PACKAGE_ID.test(x.id||'')&&x.source==='winget').slice(0,20):[];
  const exact=pool.filter(x=>normalizeInstalledAppName(x.name)===clean);
  const stable=exact.filter(x=>!variants.test(x.name)&&!variants.test(x.id));
  if(stable.length===1)return {name:installedName,normalizedName:clean,
    classification:'application',status:'resolved_exact',
    selected:{id:stable[0].id,source:stable[0].source,name:stable[0].name,version:stable[0].version},
    reason:'One stable package matches the normalized installed application name',
    candidates:pool.slice(0,8)};
  return {name:installedName,normalizedName:clean,classification:'application',
    status:pool.length?'ambiguous':'not_found',
    reason:pool.length?'Candidate packages were found but no single stable exact-name match was proven':
      'No Windows Package Manager source match found',candidates:pool.slice(0,8)};
}
export function mergeWingetManifest(original,resolutions){
  const existing=structuredClone(original);
  if(!Array.isArray(existing.Sources))throw fail('WinGet manifest Sources missing.');
  const source=existing.Sources.find(row=>String(row?.SourceDetails?.Name||'').toLowerCase()==='winget');
  if(!source)throw fail('WinGet source not available in the host manifest.');
  const taken=new Set(existing.Sources.flatMap(row=>(row.Packages||[]).map(p=>
    String(row.SourceDetails?.Name).toLowerCase()+'/'+String(p.PackageIdentifier).toLowerCase())));
  const added=[];
  for(const r of resolutions||[]){
    if(r.status!=='resolved_exact'||r.selected?.source!=='winget'||!PACKAGE_ID.test(r.selected?.id||''))continue;
    const key='winget/'+r.selected.id.toLowerCase();
    if(taken.has(key))continue;
    taken.add(key);
    source.Packages.push({PackageIdentifier:r.selected.id});
    added.push({name:r.name,id:r.selected.id,source:'winget',resolution:'exact-name'});
  }
  return {manifest:existing,added};
}
