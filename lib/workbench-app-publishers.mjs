/**
 * Read-only Windows uninstall registry metadata to disambiguate packages.
 * Registry enumeration never calls Win32_Product (which can trigger MSI
 * self-repair) and never reads an installer/uninstaller command line.
 */
import {execFile as exec} from 'node:child_process';
import {promisify} from 'node:util';
import {normalizeInstalledAppName} from './workbench-app-recovery.mjs';

const run=promisify(exec);
const script=[
  "$ErrorActionPreference='Stop'",
  "$paths=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
  "$rows=@(foreach($p in $paths){Get-ItemProperty -Path $p -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -and $_.Publisher}|ForEach-Object{[ordered]@{name=[string]$_.DisplayName;publisher=[string]$_.Publisher;version=[string]$_.DisplayVersion}}})",
  "@{entries=$rows}|ConvertTo-Json -Compress -Depth 3"
].join('\n');
const STOP=new Set(['software','solutions','solution','company','inc','incorporated','llc','ltd','limited','corporation','corp','technologies','technology','group','products','product','co','international','the','and','systems','system','global','computer','computers']);
function tokens(name){
  if(typeof name!=='string')return new Set();
  return new Set(name.toLowerCase().normalize('NFKC').replace(/[®™©]/g,'').split(/[^a-z0-9]+/g)
    .filter(value=>value.length>=4&&!STOP.has(value)));
}
export function publishersCompatible(installedPublisher,catalogPublisher){
  const left=tokens(installedPublisher),right=tokens(catalogPublisher);
  if(!left.size||!right.size)return false;
  return [...left].some(word=>right.has(word));
}
export function parseWingetPublisher(stdout){
  if(typeof stdout!=='string'||stdout.length>100000)return null;
  const line=stdout.split(/\r?\n/).find(text=>/^\s*Publisher\s*:/i.test(text));
  const found=line&&/^\s*Publisher\s*:\s*(.+)\s*$/i.exec(line);
  return found?found[1].trim().slice(0,200):null;
}
export function installedPublisher(name,entries){
  const target=normalizeInstalledAppName(name);
  if(!target)return null;
  const found=(entries||[]).filter(item=>normalizeInstalledAppName(item?.name)===target&&
    typeof item?.publisher==='string'&&item.publisher.trim());
  const unique=[...new Set(found.map(item=>item.publisher.trim()))];
  return unique.length===1?unique[0]:null;
}
export async function readHostInstalledPublishers({platform=process.platform,runner=run}={}){
  if(platform!=='win32')return [];
  const {stdout}=await runner('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',script],
    {windowsHide:true,timeout:15000,maxBuffer:500000,encoding:'utf8'});
  let result;
  try{result=JSON.parse(String(stdout).trim().replace(/^\uFEFF/,''))}
  catch{throw new Error('Windows installed-app publisher registry returned unreadable JSON.')}
  const rows=Array.isArray(result?.entries)?result.entries:[];
  return rows.slice(0,2000).filter(item=>item&&typeof item.name==='string'&&item.name.length<=250&&
    typeof item.publisher==='string'&&item.publisher.length<=200)
    .map(item=>({name:item.name,publisher:item.publisher,version:String(item.version||'').slice(0,80)}));
}
