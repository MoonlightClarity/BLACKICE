import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const fail=(message,code='WORKBENCH_NATIVE_CONTROL')=>Object.assign(Error(message),{code});
const actions=new Set(['take','cede','wake','shutdown','start','openBlackice','clipboard','fit']);
const validEvent=value=>value&&typeof value==='object'&&!Array.isArray(value)&&value.event==='nativeControl'&&actions.has(value.action)&&
  Number.isSafeInteger(value.sequence)&&value.sequence>0&&/^\d{1,20}$/.test(value.windowHwnd||'')&&['agent','user'].includes(value.inputOwner)&&
  Object.keys(value).every(key=>['event','sequence','action','enabled','windowHwnd','inputOwner'].includes(key))&&
  (['clipboard','fit'].includes(value.action)?typeof value.enabled==='boolean':!('enabled' in value));
const checkedPreferences=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['clipboardEnabled','resolutionEnabled'].includes(key))||
    typeof value.clipboardEnabled!=='boolean'||typeof value.resolutionEnabled!=='boolean')
    throw fail('Workbench preferences must contain only the two Boolean settings.','WORKBENCH_NATIVE_PREFERENCES');
  return {clipboardEnabled:value.clipboardEnabled,resolutionEnabled:value.resolutionEnabled};
};
export function createWorkbenchControlPreferences(file){
  if(typeof file!=='string'||!path.isAbsolute(file)||/[\x00-\x1f]/.test(file))throw fail('A profile preference path is required.','WORKBENCH_NATIVE_PREFERENCES');
  let tail=Promise.resolve();
  const serialized=operation=>{const work=tail.catch(()=>{}).then(operation);tail=work.catch(()=>{});return work};
  return {
    load:()=>serialized(async()=>{
      try{
        const info=await fs.lstat(file);
        if(!info.isFile()||info.isSymbolicLink()||info.size>2048)throw Error('invalid');
        const bytes=await fs.readFile(file);if(bytes.length>2048)throw Error('invalid');
        const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
        if(!value||value.version!==1||Object.keys(value).some(key=>!['version','clipboardEnabled','resolutionEnabled'].includes(key)))throw Error('invalid');
        return checkedPreferences({clipboardEnabled:value.clipboardEnabled,resolutionEnabled:value.resolutionEnabled});
      }catch(error){
        if(error.code==='ENOENT')return {clipboardEnabled:true,resolutionEnabled:true};
        throw fail('Saved Workbench preferences could not be verified. Original bytes were preserved.','WORKBENCH_NATIVE_PREFERENCES');
      }
    }),
    save:value=>{
      const checked=checkedPreferences(value);
      return serialized(async()=>{
        const temporary=file+'.'+randomUUID()+'.tmp';
        try{
          try{const current=await fs.lstat(file);if(!current.isFile()||current.isSymbolicLink())throw Error('invalid')}
          catch(error){if(error.code!=='ENOENT')throw error}
          await fs.mkdir(path.dirname(file),{recursive:true});
          await fs.writeFile(temporary,JSON.stringify({version:1,...checked})+'\n',{flag:'wx',mode:0o600});
          await fs.rename(temporary,file);return {...checked};
        }catch{throw fail('Workbench preferences could not be saved.','WORKBENCH_NATIVE_PREFERENCES');}
        finally{await fs.unlink(temporary).catch(()=>{})}
      });
    },
  };
}

/** Trusted native-window intents only. No renderer, HTTP or arbitrary action
 * dispatch is exposed here. Authoritative receipts stay inside the main app. */
export class WorkbenchNativeControls {
  constructor({getWorkbench,getNativeStatus,configureNativeControls,getPreferences,setPreferences,applyFeatures,openBlackice,afterStart=async()=>{},clock=Date.now}={}){
    if([getWorkbench,getNativeStatus,configureNativeControls,getPreferences,setPreferences,applyFeatures,openBlackice,afterStart].some(fn=>typeof fn!=='function'))
      throw TypeError('Native Workbench controls require scoped main-process adapters.');
    Object.assign(this,{getWorkbench,getNativeStatus,configureNativeControls,getPreferences,setPreferences,applyFeatures,openBlackice,afterStart,clock});
    this.busy=false;this.message='';this.closed=false;this.lastConfig=null;this.seen=new Set();this.tail=Promise.resolve();this.powerState='unknown';
    this.powerFlight=null;this.nextPowerAt=0;this.powerRevision=0;this.lastNative=null;this.confirmedOffRoot=null;
  }
  async userReceipt(workbench,assertCurrent){
    const before=workbench.consoleControl.status();
    if(before.owner!=='user')throw fail('Take control before changing this Workbench setting.');
    return workbench.consoleControl.serialize(()=>{assertCurrent();return workbench.consoleControl.localUserReceipt(before.revision)});
  }
  assertReceipt(workbench,receipt){
    if(!receipt||!['agent','user'].includes(receipt.owner))throw fail('The control receipt was not confirmed.');
    workbench.consoleControl.assert(receipt.owner==='user'?receipt.controlToken:undefined,receipt.revision);
  }
  async refresh(native){
    if(this.closed||native?.controls?.available!==true)return;
    this.lastNative=native;
    const workbench=this.getWorkbench(),prefs=this.getPreferences();
    const reported=workbench?.lastProbe?.vmState;
    if(native.connected===true&&this.confirmedOffRoot!==native.workbenchWindowHwnd)this.powerState='running';
    else if(reported==='Off'||this.confirmedOffRoot===native.workbenchWindowHwnd)this.powerState='off';
    else if(reported==='Running'&&this.powerState==='unknown')this.powerState='running';
    if(native.connected!==true&&!this.powerFlight&&this.clock()>=this.nextPowerAt&&typeof workbench?.status==='function'){
      this.nextPowerAt=this.clock()+2000;const revision=this.powerRevision;
      this.powerFlight=Promise.resolve().then(()=>workbench.status({fresh:true})).then(state=>{
        if(this.closed||revision!==this.powerRevision||this.lastNative?.connected===true)return;
        this.powerState=state?.guest?.state==='Off'?'off':state?.guest?.running===true?'running':'unknown';
        this.confirmedOffRoot=this.powerState==='off'?this.lastNative?.workbenchWindowHwnd:null;
        this.lastConfig=null;
      }).catch(()=>{if(!this.closed&&revision===this.powerRevision)this.powerState='unknown'}).finally(()=>{
        this.powerFlight=null;if(!this.closed)void this.refresh(this.lastNative).catch(()=>{});
      });
    }
    const value={enabled:true,busy:this.busy,message:this.message.slice(0,160),clipboardEnabled:prefs.clipboardEnabled===true,
      fitEnabled:prefs.resolutionEnabled===true,powerState:this.powerState};
    const key=String(native.workbenchWindowHwnd)+'|'+JSON.stringify(value);
    if(key===this.lastConfig&&Object.entries(value).every(([field,expected])=>native.controls[field]===expected))return;
    await this.configureNativeControls(value);this.lastConfig=key;
  }
  perform(event,{assertCurrent,assertInstance=assertCurrent}={}){
    if(!validEvent(event)||typeof assertCurrent!=='function'||typeof assertInstance!=='function')return Promise.reject(fail('Unverified native control intent.'));
    const key=event.windowHwnd+':'+event.sequence;
    if(this.seen.has(key))return Promise.reject(fail('This native control intent was already handled.'));
    this.seen.add(key);if(this.seen.size>128)this.seen.delete(this.seen.values().next().value);
    const operation=this.tail.catch(()=>{}).then(()=>this.execute(event,{assertCurrent,assertInstance}));
    this.tail=operation.catch(()=>{});return operation;
  }
  async execute(event,{assertCurrent,assertInstance}){
    if(this.closed)throw fail('Native controls are closed.');
    const workbench=this.getWorkbench();if(!workbench?.consoleControl)throw fail('Workbench is unavailable.');
    assertCurrent();if(workbench.consoleControl.status().owner!==event.inputOwner)throw fail('The control owner changed before this native intent.');
    this.busy=true;this.message=event.action==='shutdown'?'Shutting down…':event.action==='start'?'Starting VM…':'';
    this.lastConfig=null;
    let receipt;
    try{
      await this.refresh(await this.getNativeStatus());
      assertCurrent();
      if(event.action==='take'){
        receipt=await workbench.takeGuestConsoleControl();
        assertInstance();
        if(receipt.owner!=='user'||typeof receipt.controlToken!=='string')throw fail('The user-control receipt was not confirmed.');
        this.assertReceipt(workbench,receipt);
        await this.applyFeatures(receipt);this.message='You control this VM';
      }else if(event.action==='cede'){
        const held=await this.userReceipt(workbench,assertCurrent);assertCurrent();
        receipt=await workbench.cedeGuestConsoleControl(held.controlToken);assertInstance();
        if(receipt.owner!=='agent')throw fail('The agent-control receipt was not confirmed.');
        this.assertReceipt(workbench,receipt);await this.applyFeatures(receipt);this.message='Agent controls this VM';
      }else if(event.action==='wake'){
        const control=workbench.consoleControl.status();
        const held=control.owner==='user'?await this.userReceipt(workbench,assertCurrent):null;
        assertCurrent();receipt=await workbench.guestNativeConsoleWake(held?.controlToken);
        this.message='Display wake requested';
      }else if(event.action==='shutdown'){
        ++this.powerRevision;
        assertCurrent();receipt=await workbench.stop();
        this.powerState=receipt?.guest?.state==='Off'?'off':'unknown';this.confirmedOffRoot=this.powerState==='off'?event.windowHwnd:null;
        this.message=this.powerState==='off'?'VM is off':'Graceful shutdown requested';
      }else if(event.action==='start'){
        ++this.powerRevision;
        assertCurrent();receipt=await workbench.start();
        if(receipt?.guest?.running!==true)throw fail('The VM has not confirmed that it is running.');
        this.powerState='running';this.confirmedOffRoot=null;assertInstance();await this.afterStart(receipt);this.message='VM started';
      }else if(event.action==='openBlackice'){
        assertCurrent();await this.openBlackice();this.message='BLACKICE opened';
      }else{
        const held=workbench.consoleControl.status().owner==='user'?await this.userReceipt(workbench,assertCurrent):null;
        if(event.enabled&&!held)throw fail('Take control to enable clipboard sharing or automatic sizing.');
        assertCurrent();const prefs={...this.getPreferences(),[event.action==='clipboard'?'clipboardEnabled':'resolutionEnabled']:event.enabled};
        await this.setPreferences(prefs);assertCurrent();await this.applyFeatures(held||workbench.consoleControl.status());
        this.message=event.action==='clipboard'?(event.enabled?'Text clipboard sharing on':'Text clipboard sharing off'):
          (event.enabled?'Fit VM resolution to window':'Automatic guest sizing off');
      }
      return {action:event.action,completed:true};
    }catch(error){
      this.message=error?.code==='WORKBENCH_CONTROL_HELD_BY_USER'?'Control changed; try again':
        event.action==='shutdown'?'Shutdown could not be confirmed':event.action==='start'?'Start could not be confirmed':
        event.action==='wake'?'Display wake could not be confirmed':'The control action could not be confirmed';
      throw error;
    }finally{
      this.busy=false;this.lastConfig=null;
      try{await this.refresh(await this.getNativeStatus())}catch{}
    }
  }
  close(){this.closed=true;this.busy=false;}
}
