import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT=fileURLToPath(new URL('./installed-apps.ps1',import.meta.url));
const key=entry=>entry.kind+':'+String(entry.kind==='shortcut'?entry.sourcePath:entry.aumid).toLowerCase();
const appId=entry=>'app_'+createHash('sha256').update(key(entry)).digest('hex').slice(0,32);
const cancelled=signal=>{if(signal?.aborted)throw Object.assign(Error('Application catalog operation cancelled.'),{name:'AbortError',code:'ABORT_ERR'});};
export function runInstalledAppsScript(action,input,{signal,spawnImpl=spawn,timeoutMs=30000}={}) {
  cancelled(signal);
  return new Promise((resolve,reject)=>{
    const child=spawnImpl('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Sta','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',SCRIPT,'-Action',action],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{try{child.kill();}catch{}finish(Object.assign(Error(action==='Launch'?'The Windows activation receipt is unavailable; inspect existing windows before retrying.':'Windows application discovery timed out.'),{code:'APP_CATALOG_TIMEOUT'}));},timeoutMs);
    child.stdout.on('data',chunk=>{stdout+=String(chunk);if(stdout.length>8*1024*1024){try{child.kill();}catch{}finish(Error('Windows application catalog response exceeded its limit.'));}});
    child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-2000);});
    child.on('error',error=>finish(error));
    child.on('close',code=>{if(code!==0)return finish(Error(stderr||'Windows application discovery or activation failed.'));try{finish(null,JSON.parse(stdout.replace(/^\uFEFF/,'')));}catch{finish(Error('Windows returned an unreadable application catalog receipt.'));}});
    child.stdin.on('error',error=>finish(error));child.stdin.end(input?JSON.stringify(input):'');
    // Launch is not killed on cancellation: Windows may already have accepted
    // activation. Preserve its eventual receipt instead of replaying an effect.
  });
}

export class InstalledAppCatalog {
  constructor({platform=process.platform,runner=runInstalledAppsScript,getIcon,ttlMs=60000,iconTimeoutMs=15000,now=()=>Date.now()}={}) {
    this.platform=platform;this.runner=runner;this.getIcon=getIcon;this.ttlMs=ttlMs;this.iconTimeoutMs=iconTimeoutMs;this.now=now;this.entries=new Map();this.icons=new Map();this.iconPending=new Map();this.generation=0;this.refreshedAt=null;this.loadedAt=0;this.pending=null;
  }
  async refresh({signal}={}) {
    if(this.platform!=='win32')throw Error('Installed application discovery requires Windows.');
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      cancelled(signal);const result=await this.runner('Discover',undefined,{signal});cancelled(signal);
      const entries=new Map(),seen=new Set(),rows=Array.isArray(result?.entries)?result.entries:[];
      // Merge observed identical commands, preferring a folder-aware shortcut.
      // Arguments remain exact text; distinct profiles/commands are preserved.
      const command=row=>String(row.targetPath||'').toLowerCase()+'\n'+String(row.arguments||'');
      const ordered=[...rows].sort((a,b)=>(a.kind==='shortcut'?0:1)-(b.kind==='shortcut'?0:1)||(a.folder?0:1)-(b.folder?0:1)||String(a.sourcePath||a.aumid).localeCompare(String(b.sourcePath||b.aumid)));
      const shortcutTargets=new Set(ordered.filter(row=>row.kind==='shortcut'&&row.targetPath).map(command));
      const shortcutCommands=new Set();
      for(const row of ordered){
        if(!row||!['shortcut','appsfolder'].includes(row.kind)||typeof row.name!=='string'||!row.name.trim()||(row.kind==='shortcut'?!path.win32.isAbsolute(row.sourcePath||'')||!/\.lnk$/i.test(row.sourcePath):typeof row.aumid!=='string'||!row.aumid))continue;
        if(row.kind==='appsfolder'&&row.targetPath&&shortcutTargets.has(command(row)))continue;
        if(row.kind==='shortcut'&&row.targetPath){const identity=command(row)+'\n'+String(row.workingDirectory||'').toLowerCase();if(shortcutCommands.has(identity))continue;shortcutCommands.add(identity);}
        const identity=key(row);if(seen.has(identity))continue;seen.add(identity);
        const entry={...row,id:appId(row),name:row.name.trim(),folder:typeof row.folder==='string'?row.folder:''};entries.set(entry.id,entry);
      }
      this.entries=entries;this.generation++;this.icons.clear();this.iconPending.clear();this.loadedAt=this.now();this.refreshedAt=new Date(this.loadedAt).toISOString();
    })().finally(()=>{this.pending=null;});return this.pending;
  }
  async list({refresh=false,query='',signal}={}) {
    if(refresh||!this.refreshedAt||this.now()-this.loadedAt>=this.ttlMs)await this.refresh({signal});
    const needle=String(query).trim().toLocaleLowerCase();return {apps:[...this.entries.values()].filter(entry=>!needle||(entry.name+' '+entry.folder).toLocaleLowerCase().includes(needle)).sort((a,b)=>a.name.localeCompare(b.name)||a.folder.localeCompare(b.folder)||a.id.localeCompare(b.id)).map(entry=>({id:entry.id,name:entry.name,folder:entry.folder,...(this.icons.has(entry.id)?{icon:this.icons.get(entry.id)}:{})})),refreshedAt:this.refreshedAt};
  }
  async resolve(id,{signal}={}) {if(typeof id!=='string'||!/^app_[a-f0-9]{32}$/.test(id))throw Error('Choose an installed application from apps.');await this.list({signal});const entry=this.entries.get(id);if(!entry)throw Error('The installed application entry is stale. Refresh apps and choose it again.');return structuredClone(entry);}
  async iconsFor(ids,{signal}={}) {
    if(!Array.isArray(ids)||ids.length>128||ids.some(id=>typeof id!=='string'||!/^app_[a-f0-9]{32}$/.test(id)))throw Error('Choose observed application IDs for icons.');
    await this.list({signal});cancelled(signal);
    const unique=[...new Set(ids)],generation=this.generation;
    const entries=unique.filter(id=>this.entries.has(id)&&!this.icons.has(id)&&!this.iconPending.has(id)).map(id=>structuredClone(this.entries.get(id)));
    if(entries.length){
      let timer;
      const operation=Promise.race([
        this.getIcon?Promise.all(entries.map(async entry=>[entry.id,await this.getIcon(entry)])).then(pairs=>({icons:Object.fromEntries(pairs)})):this.runner('Icons',{entries},{signal,timeoutMs:this.iconTimeoutMs}),
        new Promise(resolve=>{timer=setTimeout(()=>resolve({icons:{}}),this.iconTimeoutMs);}),
      ]).then(result=>{
        if(this.generation!==generation)return;
        for(const entry of entries){const icon=result?.icons?.[entry.id];if(typeof icon==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(icon)&&icon.length<300000)this.icons.set(entry.id,icon);}
      }).catch(()=>{}).finally(()=>{clearTimeout(timer);if(this.generation===generation)for(const entry of entries)this.iconPending.delete(entry.id);});
      for(const entry of entries)this.iconPending.set(entry.id,operation);
    }
    await Promise.all([...new Set(unique.map(id=>this.iconPending.get(id)).filter(Boolean))]);
    return {icons:Object.fromEntries(unique.filter(id=>this.icons.has(id)).map(id=>[id,this.icons.get(id)])),missingIds:unique.filter(id=>!this.icons.has(id))};
  }
  async launch(id,{signal}={}) {const entry=await this.resolve(id,{signal});cancelled(signal);const result=await this.runner('Launch',{entry},{signal});return {...result,appId:id,name:entry.name,identity:{kind:entry.kind,...(entry.aumid?{aumid:entry.aumid}:{}),targetPath:entry.targetPath||''}};}
}
