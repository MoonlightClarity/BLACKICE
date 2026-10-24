import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {ApplicationSessions,sanitizeApplicationDiagnostics} from './application-sessions.mjs';
import {ApplicationDocumentStore} from './application-documents.mjs';
import {applicationCompatibility} from './application-compatibility.mjs';
import {applicationControls,applicationTextReceipt,performApplicationDocumentAction} from './application-document-actions.mjs';

const fail=(message,status=400,code='APPLICATION_WORKSPACE')=>Object.assign(new Error(message),{status,code});
const terminal=new Set(['closed','failed','interrupted']);
const copy=value=>structuredClone(value);
const stamp=()=>new Date().toISOString();
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,label,max=160)=>{if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw fail(`${label} must be nonempty text of at most ${max} characters.`);return value.trim();};

/** Admission is deliberately a finite compatibility catalog, not an arbitrary launcher. */
export async function applicationCatalog({platform=process.platform,release=os.release(),env=process.env,stat=fs.stat}={}) {
  if(platform!=='win32')return[];
  const system=env.SystemRoot||env.WINDIR||'C:\\Windows';
  if(!path.win32.isAbsolute(system))return[];
  const build=Number(String(release).split('.').at(-1));
  const entries=[
    {appId:'notepad-classic',name:'Notepad',description:'Classic Windows Notepad in a private desktop session.',executable:path.win32.join(system,'System32','notepad.exe'),args:[],compatible:build>=10240&&build<22000,reason:'This Windows version may route Notepad through a packaged app. It is not admitted by this compatibility catalog.'},
  ];
  for(const item of entries){let installed=false;try{installed=(await stat(item.executable)).isFile();}catch{}item.available=item.compatible&&installed;if(!installed)item.reason='This application is not installed in the expected Windows folder.';if(item.available)delete item.reason;delete item.compatible;}
  return entries;
}

/** Shared human/agent session registry. History survives; application processes never auto-relaunch. */
export class ApplicationWorkspace extends EventEmitter {
  constructor({dataDir,runtime=new ApplicationSessions(),documents=new ApplicationDocumentStore({dataDir}),catalog,platform=process.platform,catalogOptions={},maxSessions=3}={}){
    super();this.runtime=runtime;this.documents=documents;this.platform=platform;this.catalogInput=catalog;this.catalogOptions=catalogOptions;this.dataDir=dataDir;this.file=path.join(dataDir,'application-sessions.json');this.maxSessions=maxSessions;this.records=[];this.bindings=new Map();this.controls=new Map();this.tail=Promise.resolve();this.closed=false;this.storageError=null;
  }
  async init(){
    await this.documents.init();
    this.catalog=this.catalogInput?copy(this.catalogInput):await applicationCatalog({platform:this.platform,...this.catalogOptions});
    await fs.mkdir(this.dataDir,{recursive:true});
    try{const info=await fs.stat(this.file);if(!info.isFile()||info.size>256*1024)throw Error('Invalid history size.');const value=JSON.parse(await fs.readFile(this.file,'utf8'));if(value.version!==1||!Array.isArray(value.sessions)||value.sessions.length>100)throw Error('Invalid history.');
      const ids=new Set();this.records=value.sessions.map(record=>{if(!object(record)||!/^app_[a-f0-9-]{36}$/.test(record.id)||ids.has(record.id)||typeof record.appId!=='string'||typeof record.name!=='string'||!['starting','running','needs_attention','closed','failed','interrupted'].includes(record.state))throw Error('Invalid session receipt.');ids.add(record.id);return{...record,...(!terminal.has(record.state)?{state:'interrupted',finishedAt:stamp(),reason:'BLACKICE restarted. This application was not relaunched; start a new session explicitly.'}:{})};});
      if(value.sessions.some(record=>!terminal.has(record.state)))await this.save();
    }catch(error){if(error.code!=='ENOENT'){this.historyUnreadable=true;this.storageError='Application session history could not be read. The existing file was preserved.';}}
    return this;
  }
  public(record){return{id:record.id,appId:record.appId,name:record.name,applicationName:record.applicationName,state:record.state,isolated:record.isolated===true,createdAt:record.createdAt,finishedAt:record.finishedAt||null,reason:record.reason||null,busy:record.busy===true,controlsAvailable:record.state==='running',...(record.lastAction?{lastAction:record.lastAction}:{}),...(record.lastSavedDocument?{lastSavedDocument:copy(record.lastSavedDocument)}:{}),...(record.lastRestore?{lastRestore:copy(record.lastRestore)}:{}),...(record.windows?{windows:copy(record.windows)}:{}),...(record.diagnostics?{diagnostics:sanitizeApplicationDiagnostics(record.diagnostics)}:{})};}
  sync(){
    const list=this.runtime.list?.()||[];
    for(const record of this.records){const id=this.bindings.get(record.id),live=id&&list.find(item=>item.id===id);if(!live)continue;if(['closed','failed','interrupted'].includes(live.state)&&!terminal.has(record.state)){record.state=live.state;record.finishedAt=stamp();record.reason=live.reason||live.error||live.lastError||'The application helper stopped. Inspect the session before starting another.';}if(Array.isArray(live.windows))record.windows=live.windows;if(live.diagnostics)record.diagnostics=sanitizeApplicationDiagnostics(live.diagnostics);}
  }
  status(){this.sync();const sessions=this.records.map(record=>this.public(record));return{available:this.platform==='win32'&&!this.closed&&!this.storageError,isolation:'hidden-desktop',foregroundPolicy:'isolated-desktop',physicalInput:false,compatibility:applicationCompatibility(),documents:this.documents.list(),documentStorage:this.documents.status(),supportedApps:(this.catalog||[]).map(({executable,args,...item})=>item),sessions,activeSessionId:[...sessions].reverse().find(item=>!terminal.has(item.state))?.id||null,maxSessions:this.maxSessions,reason:this.storageError|| (this.platform!=='win32'?'Private application desktops require Windows.':this.closed?'The application workspace is closed.':null),limitations:['Only listed compatible classic apps are admitted; packaged, elevated and singleton apps may require a separate Windows session or VM.','These sessions share this account and its files. They are not a file or network sandbox.','Ending a session stops its owned app processes and discards unsaved app state. Sessions do not relaunch after restart.']};}
  mutation(operation){const pending=this.tail.then(()=>{if(this.closed)throw fail('The application workspace is closed.',409);return operation();});this.tail=pending.catch(()=>{});return pending;}
  async save(){
    const kept=this.records.filter(item=>!terminal.has(item.state)),history=this.records.filter(item=>terminal.has(item.state)).slice(-50);
    this.records=[...history,...kept].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    const bytes=JSON.stringify({version:1,sessions:this.records.map(record=>{const {busy,windows,...saved}=record;return saved;})});
    if(Buffer.byteLength(bytes)>256*1024)throw fail('Application session history reached its storage limit.',507);
    const temporary=this.file+'.'+randomUUID()+'.tmp';let handle;
    try{
      handle=await fs.open(temporary,'wx');await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
      await fs.rename(temporary,this.file);
      if(process.platform!=='win32'){const directory=await fs.open(this.dataDir,'r');try{await directory.sync();}finally{await directory.close();}}
    }finally{await handle?.close();await fs.rm(temporary,{force:true});}
  }
  find(id){const record=this.records.find(item=>item.id===id);if(!record)throw fail('Application session not found.',404);return record;}
  async record(record){try{await this.save();}catch(error){this.storageError='Application session history could not be saved. Existing sessions remain inspectable; do not repeat a launch.';throw fail(this.storageError+(record?' Session: '+record.id:''),500,'APPLICATION_HISTORY_FAILED');}this.emit('updated',this.status());}
  create(value,{signal}={}){return this.mutation(async()=>{
    if(!object(value)||Object.keys(value).some(key=>!['appId','name'].includes(key)))throw fail('Choose an application from the compatibility catalog; executable paths and custom arguments are not accepted.');
    if(this.storageError||this.platform!=='win32')throw fail(this.status().reason||'Private application sessions are unavailable.',503);
    if(signal?.aborted)throw fail('Application launch was cancelled.',409);
    this.sync();if(this.records.filter(item=>!terminal.has(item.state)).length>=this.maxSessions)throw fail('End an existing application session before opening another.',409);
    const app=this.catalog.find(item=>item.appId===value.appId&&item.available!==false);if(!app)throw fail('This application is not in the available compatibility catalog.',409);
    const record={id:'app_'+randomUUID(),appId:app.appId,name:value.name===undefined?app.name:text(value.name,'Session name',100),applicationName:app.name,state:'starting',isolated:false,createdAt:stamp()};this.records.push(record);await this.record(record);
    try{const live=await this.runtime.create({executable:app.executable,args:app.args||[],label:record.name},{signal});if(!live?.id||live.isolated!==true){if(live?.id)await this.runtime.close(live.id);throw fail('The application helper did not verify its private desktop.');}this.bindings.set(record.id,live.id);record.state=live.state==='running'?'running':'needs_attention';record.isolated=true;record.windows=live.windows||[];record.reason=live.reason||null;await this.record(record);return this.public(record);}
    catch(error){if(!this.bindings.has(record.id)){record.state='failed';record.finishedAt=stamp();record.reason=String(error.message||'Application launch failed.').slice(0,1000);if(error.diagnostics)record.diagnostics=sanitizeApplicationDiagnostics(error.diagnostics);await this.record(record);}throw error;}
  });}
  perform(value,{signal}={}){return this.mutation(async()=>{
    if(object(value)&&['save_text','restore_document'].includes(value.action))return performApplicationDocumentAction(this,value,{signal});
    if(!object(value)||Object.keys(value).some(key=>!['sessionId','action','ref','operation','text','windowId','expectedTextSha256'].includes(key)))throw fail('Choose a supported application session action.');
    const fields={inspect:['windowId'],screenshot:['windowId'],get_text:['ref'],control:['ref','operation','text','expectedTextSha256']}[value.action];
    if(!fields||Object.keys(value).some(key=>!['sessionId','action',...fields].includes(key)))throw fail('Use only the observed fields advertised for this session action.');
    const record=this.find(value.sessionId),privateId=this.bindings.get(record.id);this.sync();if(!privateId||record.state!=='running')throw fail(record.reason||'This session is no longer running. Applications are never relaunched automatically.',409);
    if(value.action==='get_text'&&value.ref===undefined){
      const editors=(this.controls.get(record.id)||[]).filter(item=>item.enabled&&item.readable&&item.writable);
      if(editors.length!==1)throw fail('Inspect first and choose a readable control ref; the session does not have exactly one observed editor.',409);
      value={...value,ref:editors[0].ref};
    }
    const actions={inspect:'inspect',screenshot:'screenshot',get_text:'get_text'};
    let action=actions[value.action];if(value.action==='control'&&['invoke','set_value'].includes(value.operation))action=value.operation;
    if(!action)throw fail('Use inspect, screenshot, get_text, or control with an observed invoke/set_value ref.');
    if(['invoke','set_value','get_text'].includes(action))text(value.ref,'Observed control reference',200);
    if(['invoke','set_value','get_text'].includes(action)){
      const observed=this.controls.get(record.id)?.find(item=>item.ref===value.ref);
      if(!observed||!observed.enabled||!(action==='get_text'?observed.readable:action==='set_value'?observed.writable:observed.invokable))throw fail('This control action is not admitted. Inspect this private session and use its supported text editor controls.',409);
    }
    if(action==='set_value'&&(typeof value.text!=='string'||value.text.length>10000||value.text.includes('\0')))throw fail('Field text must contain at most 10000 characters.');
    if(value.expectedTextSha256!==undefined&&(action!=='set_value'||!/^[a-f0-9]{64}$/.test(value.expectedTextSha256)))throw fail('Use the exact editor hash from inspection for this text change.');
    record.busy=true;this.emit('updated',this.status());
    try{
      if(action==='set_value'&&value.expectedTextSha256!==undefined){
        const current=await this.runtime.perform({sessionId:privateId,action:'get_text',ref:value.ref,maxCharacters:12000},{signal});
        if(typeof current.text!=='string'||applicationTextReceipt(current.text,value.ref).sha256!==value.expectedTextSha256)throw fail('The editor changed while this draft was being written. Read the current editor and merge your draft before applying it. No text was replaced.',409,'APPLICATION_TEXT_CONFLICT');
      }
      let windowId=value.windowId;
      if(action==='inspect'){
        const live=await this.runtime.perform({sessionId:privateId,action:'windows'},{signal});record.windows=live.windows||[];
        if(!windowId)windowId=record.windows[0]?.id;
        if(!windowId)throw fail('This application has no remaining private windows. Start a new session explicitly if needed.',409);
      }
      const result=await this.runtime.perform({sessionId:privateId,action,...(value.ref?{ref:value.ref}:{}),...(windowId?{windowId}:{}),...(action==='set_value'?{value:value.text}:action==='get_text'?{maxCharacters:12000}:{})},{signal});
      record.lastAction={action:value.action,operation:value.operation||null,at:stamp(),status:'completed'};
      const response={...result,sessionId:record.id};
      if(action==='inspect'){
        response.windows=copy(record.windows);response.observedAt=stamp();
        response.controls=applicationControls(result.elements);
        for(const editor of response.controls.filter(item=>item.writable&&item.readable&&(typeof item.value!=='string'||item.value.length>=2000))){
          const current=await this.runtime.perform({sessionId:privateId,action:'get_text',ref:editor.ref,maxCharacters:12000},{signal});editor.value=current.text;
        }
        this.controls.set(record.id,response.controls);
        response.text=response.controls.filter(item=>item.readable&&item.writable&&['Edit','Document'].includes(item.role)&&typeof item.value==='string').map(item=>item.value).join('\n').slice(0,12000);
        const editors=response.controls.filter(item=>item.enabled&&item.writable&&item.readable&&typeof item.value==='string');
        if(editors.length===1){response.editor=applicationTextReceipt(editors[0].value,editors[0].ref);response.editorText=editors[0].value;response.editorTextSha256=response.editor.sha256;}
        delete response.elements;
      }
      if(result.image?.data){const {mimeType,data,width,height}=result.image;response.imageUrl=`data:${mimeType};base64,${data}`;response.width=width;response.height=height;delete response.image;response.capturedAt=stamp();}
      return response;
    }
    catch(error){record.lastAction={action:value.action,operation:value.operation||null,at:stamp(),status:'failed'};this.sync();throw error;}
    finally{record.busy=false;await this.record(record);}
  });}
  async readDocument(value){if(!object(value)||Object.keys(value).some(key=>key!=='documentId'))throw fail('Choose a saved document by its documentId only.');const document=await this.documents.read(value.documentId);return{document,text:document.text};}
  end(id){return this.mutation(async()=>{const record=this.find(id),privateId=this.bindings.get(id);if(privateId){const result=await this.runtime.close(privateId);if(result?.diagnostics)record.diagnostics=sanitizeApplicationDiagnostics(result.diagnostics);}this.bindings.delete(id);record.state='closed';record.finishedAt=stamp();const d=record.diagnostics,confirmed=d?.closed===true&&d.allObservedProcessesExited===true&&d.jobActiveProcesses===0&&d.diagnosticsIncomplete!==true&&!d.processListTruncated&&!d.windowsTruncated;record.reason=confirmed?'Session ended. All observed application processes exited.':privateId?'Session ended. Application cleanup was requested; unsaved app state is not retained.':'Session closed. No additional application cleanup was performed. See startup and cleanup details.';await this.record(record);return this.public(record);});}
  async close(){if(this.closePromise)return this.closePromise;this.closed=true;return this.closePromise=(async()=>{await this.tail;await this.runtime.closeAll();for(const record of this.records)if(!terminal.has(record.state)){record.state='interrupted';record.finishedAt=stamp();record.reason='BLACKICE closed and requested application cleanup. No automatic relaunch.';}if(!this.historyUnreadable)await this.save();await this.documents.close();})();}
}
