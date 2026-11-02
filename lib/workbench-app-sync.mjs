/**
 * Persistent host-side app inventory and repeatable Windows guest batch imports.
 * The host only exports its own installed package metadata; installations
 * execute in the separately paired guest, never on the host desktop.
 */
import {promises as fs} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {execFile as nodeExecFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {classifyUnmatchedHostName,normalizeInstalledAppName,parseWingetSearchResults,resolveWingetCandidate,mergeWingetManifest} from './workbench-app-recovery.mjs';
import {readHostInstalledPublishers,installedPublisher,parseWingetPublisher,publishersCompatible} from './workbench-app-publishers.mjs';

const execFile=promisify(nodeExecFile);
const fail=(message,code='WORKBENCH_APP_SYNC_INVALID',status=409)=>Object.assign(new Error(message),{code,status});
const idOk=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const newId=()=>randomBytes(16).toString('hex');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const WIN_PACKAGE=/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,179}$/;
const SOURCE_NAME=/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const MAX_BYTES=2*1024*1024;
const augmentedName=(snapshotId,sha)=>snapshotId+'.augmented-'+sha.slice(0,16)+'.json';
const clone=value=>structuredClone(value);
async function atomic(file,data){
  const temp=file+'.'+newId()+'.tmp';
  try{await fs.writeFile(temp,data,{flag:'wx'});await fs.rename(temp,file)}
  finally{await fs.rm(temp,{force:true}).catch(()=>{})}
}
async function jsonFile(file,{maximum=300000}={}){
  let size;
  try{size=(await fs.stat(file)).size}
  catch(e){if(e.code==='ENOENT')return null;throw e}
  if(size<1||size>maximum)throw fail('A saved application-sync record is damaged or oversized.','WORKBENCH_APP_SYNC_RECORD_INVALID');
  try{return JSON.parse(await fs.readFile(file,'utf8'))}
  catch{throw fail('A saved application-sync JSON record is unreadable.','WORKBENCH_APP_SYNC_RECORD_INVALID')}
}
export function parseWinGetManifest(manifest){
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||!Array.isArray(manifest.Sources)||
    manifest.Sources.length>32)throw fail('The Windows Package Manager manifest has no usable sources.','WORKBENCH_APP_SYNC_MANIFEST',400);
  const items=[],unique=new Set();
  for(const source of manifest.Sources){
    const name=source?.SourceDetails?.Name;
    if(typeof name!=='string'||!SOURCE_NAME.test(name)||!Array.isArray(source.Packages)||
      source.Packages.length>800)throw fail('Invalid package source in exported Windows inventory.','WORKBENCH_APP_SYNC_MANIFEST',400);
    for(const pkg of source.Packages){
      const id=pkg?.PackageIdentifier;
      if(typeof id!=='string'||!WIN_PACKAGE.test(id))throw fail('Invalid package identifier in Windows inventory.','WORKBENCH_APP_SYNC_MANIFEST',400);
      const key=name.toLowerCase()+'/'+id.toLowerCase();
      if(unique.has(key))continue;
      unique.add(key);items.push({id,source:name});
      if(items.length>1200)throw fail('Too many packages in the host Windows inventory.','WORKBENCH_APP_SYNC_MANIFEST',413);
    }
  }
  return items;
}
export class WorkbenchAppSync{
  constructor({sharedRoot,exporter=execFile,searcher=execFile,registryReader=readHostInstalledPublishers,clock=()=>Date.now()}={}){
    if(typeof sharedRoot!=='string'||!path.isAbsolute(sharedRoot))throw fail('Existing BLACKICE workspace needed for application synchronization.','WORKBENCH_APP_SYNC_ROOT',500);
    this.workspace=path.resolve(sharedRoot);
    this.directory=path.join(this.workspace,'.blackice-workbench','app-sync');
    this.manifests=path.join(this.directory,'manifests');
    this.runs=path.join(this.directory,'runs');
    this.recoveries=path.join(this.directory,'recoveries');
    this.exporter=exporter;this.searcher=searcher;this.registryReader=registryReader;
    this.clock=clock;this.ready=null;this.pending=null;this.discovery=null;
  }
  async init(){return this.ready||=(async()=>{
    await fs.mkdir(this.manifests,{recursive:true});
    await fs.mkdir(this.runs,{recursive:true});
    await fs.mkdir(this.recoveries,{recursive:true});
    return this;
  })()}
  async recovery(snapshotId,sourceHash){
    if(!idOk(snapshotId))throw fail('Select a saved app snapshot.','WORKBENCH_APP_RECOVERY_SNAPSHOT',400);
    const value=await jsonFile(path.join(this.recoveries,snapshotId+'.json'),{maximum:320000});
    if(!value)return null;
    if(value.version!==1||value.snapshotId!==snapshotId||
      (sourceHash&&value.sourceSha256!==sourceHash))
      throw fail('Unmatched app recovery belongs to different source bytes.','WORKBENCH_APP_RECOVERY_STALE');
    // Older exact-name-only matches could point to a completely different
    // publisher. Preserve their evidence but NEVER use their guest manifest.
    if(value.matcherVersion!==2)
      return {...value,status:'needs_recheck',added:[],importVariant:'original',
        importSha256:value.sourceSha256,importCount:undefined,
        reason:'Earlier catalog matches require publisher verification before installation.'};
    if(value.status==='completed'&&value.importVariant==='augmented'){
      const file=path.join(this.manifests,augmentedName(snapshotId,value.importSha256));
      const bytes=await fs.readFile(file).catch(()=>null);
      if(!bytes||bytes.length>MAX_BYTES||hash(bytes)!==value.importSha256)
        throw fail('Augmented guest import differs from the saved recovery proof.','WORKBENCH_APP_RECOVERY_CHANGED');
      if(parseWinGetManifest(JSON.parse(bytes.toString('utf8'))).length!==value.importCount)
        throw fail('The resolved import package count is inconsistent.','WORKBENCH_APP_RECOVERY_CHANGED');
    }
    return value;
  }
  async discover({snapshotId,refresh=false}={}){
    if(this.discovery)throw fail('App installer discovery is already in progress.','WORKBENCH_APP_RECOVERY_BUSY');
    const task=this.discoverCurrent({snapshotId,refresh});
    this.discovery=task;
    try{return await task}finally{if(this.discovery===task)this.discovery=null}
  }
  async discoverCurrent({snapshotId,refresh=false}={}){
    await this.init();
    if(process.platform!=='win32')throw fail('Installer lookup requires Windows.','WORKBENCH_APP_RECOVERY_WINDOWS',503);
    const current=snapshotId?await this.snapshot(snapshotId):await this.current();
    if(!current)throw fail('Rescan the host app list first.','WORKBENCH_APP_RECOVERY_SOURCE_REQUIRED');
    if(!refresh){
      const prior=await this.recovery(current.snapshotId,current.sha256);
      if(prior?.status==='completed')return prior;
    }
    const names=Array.isArray(current.unmatchedHostApps)?current.unmatchedHostApps:[];
    if(names.length>300)throw fail('Too many unmatched app entries in one inventory.','WORKBENCH_APP_RECOVERY_LIMIT',413);
    let publishers=[],publisherLookupError=null;
    try{publishers=await this.registryReader()}catch(e){publisherLookupError=String(e.message||e).slice(0,250)}
    const results=new Array(names.length),startedAt=new Date(this.clock()).toISOString();
    const stateFile=path.join(this.recoveries,current.snapshotId+'.json');
    let cursor=0,completed=0,queries=0;
    const save=async(status)=>{
      const decisions=results.filter(Boolean);
      await atomic(stateFile,JSON.stringify({version:1,status,snapshotId:current.snapshotId,
        sourceSha256:current.sha256,startedAt,updatedAt:new Date(this.clock()).toISOString(),
        completed:decisions.length,total:names.length,queryCount:queries,
        decisions,statusNote:status==='running'?'Catalog lookup ongoing; no guest installs have been started.':undefined}));
    };
    await save('running');
    let saving=Promise.resolve();
    const checkpoint=()=>{
      const next=saving.catch(()=>{}).then(()=>save('running'));
      saving=next;return next;
    };
    const worker=async()=>{
      while(true){
        const i=cursor++;
        if(i>=names.length)return;
        const name=names[i],type=classifyUnmatchedHostName(name);
        let result;
        if(!type.searchable){
          result=resolveWingetCandidate(name,[]);
        }else{
          const query=name.normalize('NFKC').replace(/\s*\([^)]*(?:x64|x86|en[-_]us|64.bit|32.bit)[^)]*\)/gi,'')
            .replace(/\s+64bit$/gi,'').replace(/\s+[-–]\s*en[-_]us$/gi,'').trim().slice(0,130);
          try{
            queries++;
            const found=await this.searcher('winget.exe',
              ['search','--name',query,'--source','winget','--count','12',
                '--accept-source-agreements','--disable-interactivity'],
              {windowsHide:true,timeout:15000,maxBuffer:200000,encoding:'utf8'});
            result=resolveWingetCandidate(name,parseWingetSearchResults(String(found.stdout||'')));
          }catch(e){
            const output=String(e.stdout||'');
            if(/No package found matching input criteria|No package found matching input/i.test(output))
              result=resolveWingetCandidate(name,[]);
            else result={name,normalizedName:normalizeInstalledAppName(name),
              classification:type.category,status:'search_error',reason:String(e.message||e).slice(0,400),
              candidates:[]};
          }
        }
        if(result.status==='resolved_exact'){
          const localPublisher=installedPublisher(name,publishers);
          result.installedPublisher=localPublisher;
          if(!localPublisher){
            result.status='ambiguous';
            result.reason='The host application publisher could not be established; identical names can identify unrelated products.';
            delete result.selected;
          }else{
            try{
              const shown=await this.searcher('winget.exe',
                ['show','--id',result.selected.id,'--exact','--source','winget',
                  '--accept-source-agreements','--disable-interactivity'],
                {windowsHide:true,timeout:15000,maxBuffer:200000,encoding:'utf8'});
              const catalogPublisher=parseWingetPublisher(String(shown.stdout||''));
              result.catalogPublisher=catalogPublisher;
              if(publishersCompatible(localPublisher,catalogPublisher)){
                result.publisherVerified=true;
                result.reason='One stable exact-name package with compatible installed and catalog publishers';
              }else{
                result.status='ambiguous';
                result.reason='An exact application name matched, but the installed and package publishers differ or are unverifiable.';
                delete result.selected;
              }
            }catch(error){
              result.status='search_error';
              result.reason='The exact-name package publisher could not be verified: '+String(error.message||error).slice(0,250);
              delete result.selected;
            }
          }
        }
        results[i]=result;completed++;
        // Saved partial progress is inspectable without suggesting that an
        // unfinished catalog search or a guest installation has completed.
        if(completed%6===0)await checkpoint();
      }
    };
    try{
      const outcomes=await Promise.allSettled(Array.from({length:3},worker));
      await saving;
      const rejected=outcomes.find(result=>result.status==='rejected');
      if(rejected)throw rejected.reason;
      const original=JSON.parse(await fs.readFile(path.join(this.manifests,current.snapshotId+'.json'),'utf8'));
      const merged=mergeWingetManifest(original,results);
      const bytes=Buffer.from(JSON.stringify(merged.manifest));
      if(bytes.length>MAX_BYTES)throw fail('Resolved guest import exceeds the supported capacity.','WORKBENCH_APP_RECOVERY_LIMIT',413);
      const importCount=parseWinGetManifest(merged.manifest).length;
      const augmented=merged.added.length>0;
      if(augmented){
        const filename=path.join(this.manifests,augmentedName(current.snapshotId,hash(bytes)));
        const prior=await fs.readFile(filename).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
        if(prior){if(hash(prior)!==hash(bytes))throw fail('An immutable imported manifest was changed.','WORKBENCH_APP_RECOVERY_CHANGED')}
        else await atomic(filename,bytes);
      }
      const counts=Object.fromEntries(['resolved_exact','ambiguous','not_found','not_applicable','search_error']
        .map(status=>[status,results.filter(item=>item.status===status).length]));
      const receipt={version:1,matcherVersion:2,status:'completed',snapshotId:current.snapshotId,
        sourceSha256:current.sha256,startedAt,completedAt:new Date(this.clock()).toISOString(),
        total:names.length,completed:names.length,queryCount:queries,counts,
        added:merged.added,importVariant:augmented?'augmented':'original',
        importSha256:augmented?hash(bytes):current.sha256,importCount,
        decisions:results};
      await atomic(stateFile,JSON.stringify(receipt));
      return receipt;
    }catch(error){
      await atomic(stateFile,JSON.stringify({version:1,status:'failed',
        snapshotId:current.snapshotId,sourceSha256:current.sha256,startedAt,
        updatedAt:new Date(this.clock()).toISOString(),completed,
        total:names.length,queryCount:queries,decisions:results.filter(Boolean),
        error:String(error.message||error).slice(0,500)}));
      throw error;
    }
  }
  async current(){
    const latest=await jsonFile(path.join(this.directory,'latest.json'));
    if(!latest)return null;
    if(!idOk(latest.snapshotId))throw fail('Latest Windows app snapshot ID is invalid.','WORKBENCH_APP_SYNC_RECORD_INVALID');
    return this.snapshot(latest.snapshotId);
  }
  async snapshot(snapshotId){
    if(!idOk(snapshotId))throw fail('Choose a saved Windows package inventory snapshot.','WORKBENCH_APP_SYNC_SNAPSHOT',400);
    const receipt=await jsonFile(path.join(this.manifests,snapshotId+'.receipt.json'));
    if(!receipt||receipt.snapshotId!==snapshotId||receipt.version!==1||
      !/^[a-f0-9]{64}$/.test(receipt.sha256))throw fail('Saved inventory snapshot was not found.','WORKBENCH_APP_SYNC_SNAPSHOT',404);
    const file=path.join(this.manifests,snapshotId+'.json');
    const bytes=await fs.readFile(file).catch(()=>null);
    if(!bytes||bytes.length>MAX_BYTES||hash(bytes)!==receipt.sha256)
      throw fail('Saved inventory has changed or failed its checksum.','WORKBENCH_APP_SYNC_SNAPSHOT_CHANGED',409);
    const packages=parseWinGetManifest(JSON.parse(bytes.toString('utf8')));
    if(receipt.packageCount!==packages.length)throw fail('Saved inventory package count disagrees with its checksum record.','WORKBENCH_APP_SYNC_SNAPSHOT_CHANGED');
    const recovery=await this.recovery(snapshotId,receipt.sha256);
    return {...clone(receipt),manifestRelativePath:'app-sync/manifests/'+snapshotId+'.json',packages,
      ...(recovery?{recovery:{status:recovery.status,counts:recovery.counts||{},
        resolvedCount:recovery.added?.length||0,importVariant:recovery.importVariant||'original',
        importCount:recovery.importCount||packages.length,queryCount:recovery.queryCount||0,
        error:recovery.error||null,completedAt:recovery.completedAt||null}}:{})};
  }
  async list({limit=20}={}){
    await this.init();
    const current=await this.current();
    const names=(await fs.readdir(this.runs)).filter(name=>/^[a-f0-9]{32}\.json$/.test(name)).slice(-100);
    const entries=[];
    for(const name of names){
      const value=await jsonFile(path.join(this.runs,name),{maximum:240000});
      if(value&&value.version===1&&value.runId===name.slice(0,-5))
        entries.push({runId:value.runId,status:value.status,createdAt:value.createdAt,
          finishedAt:value.finishedAt||null,snapshotId:value.snapshotId,
          totalPackages:value.totalPackages||0,counts:value.counts||{}});
    }
    entries.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    return {currentSnapshot:current?{snapshotId:current.snapshotId,packageCount:current.packageCount,
      createdAt:current.createdAt,warning:current.warning||null,
      unmatchedCount:current.unmatchedCount||0,unmatchedHostApps:current.unmatchedHostApps||[],
      recovery:current.recovery||null}:null,
      canExport:process.platform==='win32',runs:entries.slice(0,limit)};
  }
  async exportHost(){
    if(this.pending)throw fail('An installed-app inventory refresh is already running.','WORKBENCH_APP_SYNC_BUSY');
    const job=this.exportHostCurrent();
    this.pending=job;
    try{return await job}finally{if(this.pending===job)this.pending=null}
  }
  async exportHostCurrent(){
    await this.init();
    if(process.platform!=='win32')throw fail('Windows package export needs the host Windows installation.','WORKBENCH_APP_SYNC_WINDOWS',503);
    const snapshotId=newId(),staged=path.join(this.manifests,snapshotId+'.partial.json');
    let output='';
    try{
      // The native winget program is invoked without a shell. Do not execute
      // host-supplied installer commands or accept package-manager scripts.
      const result=await this.exporter('winget.exe',
        ['export','--output',staged,'--accept-source-agreements','--disable-interactivity'],
        {windowsHide:true,timeout:120000,maxBuffer:1024*1024,encoding:'utf8'});
      output=String(result.stdout||'')+'\n'+String(result.stderr||'');
      const bytes=await fs.readFile(staged);
      if(bytes.length<2||bytes.length>MAX_BYTES)throw fail('Windows inventory export was missing or too large.','WORKBENCH_APP_SYNC_EXPORT');
      let parsed;
      try{parsed=JSON.parse(bytes.toString('utf8'))}catch{throw fail('Windows Package Manager export returned invalid JSON.','WORKBENCH_APP_SYNC_EXPORT')}
      const packages=parseWinGetManifest(parsed);
      // Winget does not cover every installed program. Retain the unmatched
      // names as visible exceptions instead of silently claiming complete sync.
      const unmatchedHostApps=[...new Set(output.split(/\r?\n/).flatMap(line=>{
        const match=/Installed package is not available from any source:\s*(.+)$/i.exec(line.trim());
        return match?[match[1].trim().slice(0,220)]:[];
      }))].slice(0,300);
      const receipt={version:1,snapshotId,sha256:hash(bytes),packageCount:packages.length,
        unmatchedHostApps,unmatchedCount:unmatchedHostApps.length,
        createdAt:new Date(this.clock()).toISOString(),source:'winget export',
        ...(output.trim()?{warning:output.trim().slice(0,2000)}:{})};
      await fs.rename(staged,path.join(this.manifests,snapshotId+'.json'));
      await atomic(path.join(this.manifests,snapshotId+'.receipt.json'),JSON.stringify(receipt));
      await atomic(path.join(this.directory,'latest.json'),JSON.stringify({version:1,snapshotId}));
      return {...receipt,packages};
    }catch(e){
      // Never promote an incomplete export to the current manifest.
      if(e.code?.startsWith('WORKBENCH_APP_SYNC'))throw e;
      throw fail('Host Windows inventory export could not complete: '+String(e.message||e).slice(0,400),'WORKBENCH_APP_SYNC_EXPORT',503);
    }finally{await fs.rm(staged,{force:true}).catch(()=>{})}
  }
  async run(runId){
    if(!idOk(runId))throw fail('Choose an existing app-install batch ID.','WORKBENCH_APP_SYNC_RUN_ID',400);
    const result=await jsonFile(path.join(this.runs,runId+'.json'),{maximum:240000});
    if(!result||result.version!==1||result.runId!==runId)throw fail('App-install batch does not exist.','WORKBENCH_APP_SYNC_RUN_MISSING',404);
    return result;
  }
  async reserve({snapshotId}={}){
    await this.init();
    const receipt=snapshotId?await this.snapshot(snapshotId):await this.current();
    if(!receipt)throw fail('Refresh the host app inventory first.','WORKBENCH_APP_SYNC_NEEDS_EXPORT');
    const status=await this.list();
    if(status.runs.some(run=>['requested','queued','running'].includes(run.status)&&
      this.clock()-Date.parse(run.createdAt)<2*3600000))
      throw fail('An app batch is already active. Inspect it before starting another.','WORKBENCH_APP_SYNC_BUSY');
    const recovery=await this.recovery(receipt.snapshotId,receipt.sha256);
    const variant=recovery?.status==='completed'&&recovery.importVariant==='augmented'?'augmented':'original';
    const runId=newId(),record={version:1,runId,snapshotId:receipt.snapshotId,
      sourceSnapshotSha256:receipt.sha256,
      manifestSha256:variant==='augmented'?recovery.importSha256:receipt.sha256,
      importVariant:variant,autoResolved:variant==='augmented'?recovery.added:[],
      totalPackages:variant==='augmented'?recovery.importCount:receipt.packageCount,status:'requested',
      createdAt:new Date(this.clock()).toISOString(),counts:{}};
    await atomic(path.join(this.runs,runId+'.json'),JSON.stringify(record));
    return record;
  }
  async markDispatch(runId,dispatch){
    const record=await this.run(runId);
    if(record.status!=='requested')return record;
    const value={...record,dispatch,updatedAt:new Date(this.clock()).toISOString(),
      status:dispatch?.status==='completed'&&dispatch?.result?.scheduled===true?'queued':
        'dispatch_uncertain'};
    await atomic(path.join(this.runs,runId+'.json'),JSON.stringify(value));
    return value;
  }
}
