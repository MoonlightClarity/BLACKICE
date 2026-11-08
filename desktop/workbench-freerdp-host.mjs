import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {nativeHandle} from './native-app-host.mjs';
import {nativeConnectionDiagnostics,nativeCleanupReceipt} from '../lib/workbench-native-diagnostics.mjs';

const fail=(message,code='WORKBENCH_NATIVE_PROTOCOL')=>Object.assign(Error(message),{code});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const decimal=value=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value);
const controlActions=['take','cede','wake','shutdown','start','openBlackice','clipboard','fit'];
const controlFields=['enabled','busy','message','clipboardEnabled','fitEnabled','powerState'];
export function validateNativeControlEvent(value){
  if(!object(value)||Object.keys(value).some(key=>!['event','sequence','action','enabled','windowHwnd','inputOwner'].includes(key))||
    value.event!=='nativeControl'||!Number.isSafeInteger(value.sequence)||value.sequence<1||!controlActions.includes(value.action)||
    !decimal(value.windowHwnd)||!['agent','user'].includes(value.inputOwner)||
    (['clipboard','fit'].includes(value.action)?typeof value.enabled!=='boolean':Object.hasOwn(value,'enabled')))
    throw fail('The native control event was invalid.');
  return {...value};
}
export function validateNativeControls(value){
  if(!object(value)||Object.keys(value).length!==controlFields.length||Object.keys(value).some(key=>!controlFields.includes(key))||
    !['enabled','busy','clipboardEnabled','fitEnabled'].every(key=>typeof value[key]==='boolean')||
    typeof value.message!=='string'||value.message.length>160||value.message.includes('\0')||!['running','off','unknown'].includes(value.powerState))
    throw fail('Choose valid native Workbench controls.');
  return {...value};
}
const ready=result=>result.connected===true&&result.certificateVerified===true&&result.selectedProtocol===2&&
  Number.isSafeInteger(result.decodedFrames)&&result.decodedFrames>0&&
  [result.surface?.width,result.surface?.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096);
const rectangle=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).some(k=>!['x','y','width','height'].includes(k)))throw fail('Choose guest viewport bounds.');
  const {x,y,width,height}=value;
  if(![x,y,width,height].every(Number.isSafeInteger)||x<0||y<0||width<160||height<120||
    width>4096||height>4096)throw fail('Guest viewport bounds are outside supported limits.');
  return {x,y,width,height};
};

/** Development controller for the child-first renderer. The Workbench UI stays
 * gated until actual guest pixels, input and foreground acceptance pass.
 * One verified helper, one session, serialized commands, no automatic retries.
 */
export class WorkbenchFreeRDPHost {
  constructor({helperPath,helperSha256,runtimeDirectory,spawnImpl=spawn,readFileImpl=readFile,
    timeoutMs=18000,closeTimeoutMs=3000,env=process.env,scaleFactor=()=>1,contentScaleFactor=()=>1,detachedWindow=false,onControl=()=>{}}={}){
    if(!path.isAbsolute(helperPath||'')||!path.isAbsolute(runtimeDirectory||'')||
      !/^[a-f0-9]{64}$/i.test(helperSha256||''))throw fail('A verified native runtime build is required.','WORKBENCH_NATIVE_BUILD');
    if(typeof scaleFactor!=='function'||typeof contentScaleFactor!=='function'||typeof onControl!=='function')throw fail('Native callbacks are required.');
    Object.assign(this,{helperPath,helperSha256:helperSha256.toLowerCase(),runtimeDirectory,
      spawnImpl,readFileImpl,timeoutMs,closeTimeoutMs,env,scaleFactor,contentScaleFactor,detachedWindow:detachedWindow===true,onControl});
    this.worker=null;this.starting=null;this.pending=null;this.buffer='';this.sequence=0;this.queue=Promise.resolve();
    this.prepared=false;this.closed=false;this.closing=null;this.uncertain=false;this.last={displayReady:false};
    this.controlSequence=0;this.processLifecycle=null;
  }
  start(){
    if(this.starting)return this.starting;
    const operation=this.startWorker();
    const tracked=operation.finally(()=>{if(this.starting===tracked)this.starting=null;});
    this.starting=tracked;return tracked;
  }
  async startWorker(){
    if(this.closed)throw fail('The native guest viewer is closed.');
    if(this.uncertain)throw fail('Inspect the existing native viewer before continuing.','WORKBENCH_NATIVE_UNCERTAIN');
    if(this.worker)return;
    const bytes=await this.readFileImpl(this.helperPath);
    if(this.closed)throw fail('The native guest viewer closed while the build was verified.');
    if(this.uncertain)throw fail('Inspect the existing native viewer before continuing.','WORKBENCH_NATIVE_UNCERTAIN');
    if(createHash('sha256').update(bytes).digest('hex')!==this.helperSha256)
      throw fail('Native helper bytes differ from the verified build.','WORKBENCH_NATIVE_BUILD');
    const systemRoot=this.env.SystemRoot||'C:\\Windows';
    const worker=this.spawnImpl(this.helperPath,[this.detachedWindow?'--stream-detached':'--stream'],{cwd:this.runtimeDirectory,
      windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...this.env,
        WINPR_NATIVE_SSPI:'1',
        OPENSSL_CONF:path.join(path.dirname(this.runtimeDirectory),'etc','ssl','openssl.cnf'),
        OPENSSL_MODULES:path.join(path.dirname(this.runtimeDirectory),'lib','ossl-modules'),
        PATH:[this.runtimeDirectory,path.win32.join(systemRoot,'System32'),systemRoot].join(';')}});
    this.worker=worker;
    let resolveExit;
    const lifecycle={exited:false,started:true,forced:false,exitCode:null,signal:null,worker,exit:new Promise(resolve=>{resolveExit=resolve})};
    this.processLifecycle=lifecycle;
    const broken=error=>{
      if(this.worker!==worker)return;
      this.worker=null;this.uncertain=true;this.last={...this.last,displayReady:false};
      if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}
      if(!lifecycle.exited){lifecycle.forced=true;try{worker.kill()}catch{}}
    };
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data',chunk=>{
      if(this.worker!==worker)return;
      this.buffer+=chunk;
      if(this.buffer.length>1024*1024)return broken(fail('Native reply exceeded its limit.'));
      let end;
      while((end=this.buffer.indexOf('\n'))>=0){
        const line=this.buffer.slice(0,end).trim().replace(/^\uFEFF/,'');this.buffer=this.buffer.slice(end+1);
        if(!line)continue;
        let reply;try{reply=JSON.parse(line)}catch{return broken(fail('Malformed native reply.'))}
        if(reply?.event==='nativeControl'){
          let event;try{event=validateNativeControlEvent(reply)}catch{continue}
          if(event.sequence<=this.controlSequence)continue;this.controlSequence=event.sequence;
          // Never await a toolbar action in the reply parser: its handler may
          // itself need a fresh status receipt from this same native pipe.
          queueMicrotask(()=>{if(this.worker===worker&&!this.closed&&!this.uncertain){
            try{Promise.resolve(this.onControl(event)).catch(()=>{})}catch{}
          }});continue;
        }
        if(!this.pending||reply.requestId!==this.pending.id)continue;
        const pending=this.pending;this.pending=null;clearTimeout(pending.timer);
        if(typeof reply.ok!=='boolean'){
          this.uncertain=true;this.last={...this.last,displayReady:false};pending.reject(fail('Malformed native acknowledgement.','WORKBENCH_NATIVE_UNCERTAIN'));
        }else if(reply.ok===false){
          const error=fail(String(reply.error||'Native operation failed.').slice(0,500),
            /^[A-Z0-9_]{1,80}$/.test(reply.code||'')?reply.code:'WORKBENCH_NATIVE_FAILED');
          error.nativeAcknowledged=true;
          const diagnostics=nativeConnectionDiagnostics(reply.result);
          if(diagnostics)error.nativeDiagnostics=diagnostics;
          pending.reject(error);
        }
        else if(!reply.result||typeof reply.result!=='object'||Array.isArray(reply.result)){
          this.uncertain=true;this.last={...this.last,displayReady:false};pending.reject(fail('Native result was not an object.','WORKBENCH_NATIVE_UNCERTAIN'));
        }
        else pending.resolve(reply.result);
      }
    });
    // Drain diagnostic output without treating a native library log as a receipt.
    worker.stderr?.on('data',()=>{});
    worker.stdin.on?.('error',()=>broken(fail('Native request pipe closed.')));
    worker.once('error',()=>{if(!worker.pid)lifecycle.started=false;broken(fail('Native helper could not start.'));});
    const exited=(code,signal)=>{
      if(lifecycle.exited)return;
      lifecycle.exited=true;lifecycle.exitCode=code;lifecycle.signal=signal;resolveExit();
      if(this.closed){this.uncertain=false;this.last={...this.last,uncertain:false,cleanup:this.cleanupReceipt()};}
      broken(fail('Native helper exited; inspect before reconnecting.','WORKBENCH_NATIVE_UNCERTAIN'));
    };
    worker.once('exit',exited);
    worker.once('close',(code,signal)=>{if(!lifecycle.started)exited(code,signal);});
  }
  dispatch(action,args={},deadline=this.timeoutMs){
    const operation=this.queue.catch(()=>{}).then(async()=>{
      await this.start();
      return new Promise((resolve,reject)=>{
        const id='native-'+(++this.sequence);
        const timer=setTimeout(()=>{
          if(this.pending?.id!==id)return;
          this.pending=null;this.uncertain=true;this.last={...this.last,displayReady:false};
          reject(fail('Native operation timed out; no retry was sent.','WORKBENCH_NATIVE_UNCERTAIN'));
        },deadline);
        this.pending={id,resolve,reject,timer};
        try{this.worker.stdin.write(JSON.stringify({requestId:id,action,...args})+'\n')}
        catch{clearTimeout(timer);this.pending=null;this.uncertain=true;this.last={...this.last,displayReady:false};reject(fail('Native request delivery is uncertain.','WORKBENCH_NATIVE_UNCERTAIN'));}
      });
    });
    this.queue=operation.catch(()=>{});return operation;
  }
  bounds(value,host){
    if(!host||host.isDestroyed())throw fail('The BLACKICE window is closed.');
    const bounds=rectangle(value),[width,height]=host.getContentSize();
    let contentFactor;try{contentFactor=this.contentScaleFactor(host)}catch{throw fail('The content viewport scale is unavailable.')}
    if(typeof contentFactor!=='number'||!Number.isFinite(contentFactor)||contentFactor<0.25||contentFactor>16)
      throw fail('The content viewport scale is outside supported limits.');
    // DOM rectangles use CSS pixels; Electron content dimensions use DIP.
    // Zoom converts CSS to DIP before containment is checked. Display scale
    // additionally converts those coordinates to physical child-window pixels.
    if(![width,height].every(n=>Number.isFinite(n)&&n>0)||
      (bounds.x+bounds.width)*contentFactor>width||(bounds.y+bounds.height)*contentFactor>height)
      throw fail('The guest viewport exceeds the BLACKICE content.');
    let factor;try{factor=this.scaleFactor(host)}catch{throw fail('The native viewport scale is unavailable.')}
    if(typeof factor!=='number'||!Number.isFinite(factor)||factor<0.25||factor>16)
      throw fail('The native viewport scale is outside supported limits.');
    const physical=Object.fromEntries(Object.entries(bounds).map(([key,n])=>[key,Math.round(n*factor)]));
    if(!Object.values(physical).every(Number.isSafeInteger)||physical.width<1||physical.height<1||
      physical.width>4096||physical.height>4096||physical.x>32767||physical.y>32767)
      throw fail('The physical guest viewport is outside supported limits.');
    return physical;
  }
  async prepare(value,host){
    if(!host||host.isDestroyed())throw fail('The BLACKICE launcher window is closed.');
    const result=await this.dispatch('prepare',{parent:nativeHandle(host),...(this.detachedWindow?{}:this.bounds(value,host))});
    if(result.prepared!==true)throw fail('The native child viewport was not prepared.');
    if(this.detachedWindow&&(result.detached!==true||!/^\d+$/.test(result.workbenchWindowHwnd||'')))throw fail('The separate Workbench window was not prepared.');
    this.prepared=true;this.last={...result,displayReady:false};return this.last;
  }
  async connect({vmId,certificateSha256,timeoutMs=10000}={}){
    if(!this.prepared)throw fail('Prepare the native child before connecting.');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(vmId||'')||
      !/^[0-9a-f]{64}$/i.test(certificateSha256||'')||!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)
      throw fail('A discovered VM, trusted host certificate and bounded timeout are required.');
    const result=await this.dispatch('connect',{vmId,host:'127.0.0.1',port:2179,
      certificateSha256:certificateSha256.toLowerCase(),timeoutMs},timeoutMs+5000);
    this.last={...result,displayReady:ready(result)};
    return this.last;
  }
  async position(value,host){
    if(!this.prepared)throw fail('Prepare the native child before resizing.');
    if(this.detachedWindow)return {...await this.status(),boundsIgnored:true};
    return this.dispatch('bounds',this.bounds(value,host));
  }
  async visible(visible,{expectedWindowCloseRevision}={}){
    if(typeof visible!=='boolean'||!this.prepared)throw fail('Prepare the native child before changing visibility.');
    return this.dispatch('visible',{visible,...(this.detachedWindow&&visible&&Number.isSafeInteger(expectedWindowCloseRevision)?{expectedWindowCloseRevision}:{})});
  }
  async inputOwner(owner){
    try{
      if(!this.prepared||!['agent','user'].includes(owner))throw fail('Choose the current Workbench input owner.');
      // The caller must use the existing server control receipt. A successful
      // native envelope must acknowledge this exact owner before server commit.
      const result=await this.dispatch('input',{enabled:owner==='user'});
      if(result.inputOwner!==owner)throw fail('Native input ownership acknowledgement did not match.');
      this.last={...this.last,...result,displayReady:ready(result)};return result;
    }catch(cause){
      this.last={...this.last,displayReady:false};this.uncertain=true;
      try{await this.close()}catch{}
      const error=fail('Native input ownership could not be verified. Reconnect the viewer.','WORKBENCH_NATIVE_OWNERSHIP');
      error.cause=cause;throw error;
    }
  }
  async agentInput(input){
    if(!this.last.displayReady||this.last.inputOwner==='user')throw fail('The agent must own a verified guest display.');
    if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Choose guest input fields.');
    const allowed=input.kind==='mouse'?['kind','x','y','flags']:input.kind==='key'?['kind','scanCode','flags']:[];
    if(!allowed.length||Object.keys(input).some(k=>!allowed.includes(k))||
      !Number.isSafeInteger(input.flags)||input.flags<0||input.flags>65535)throw fail('Invalid native guest input.');
    if(input.kind==='mouse'&&(!Number.isSafeInteger(input.x)||!Number.isSafeInteger(input.y)||
      input.x<0||input.y<0||input.x>=this.last.surface?.width||input.y>=this.last.surface?.height||
      !this.last.surface?.width||!this.last.surface?.height))throw fail('Guest pointer is outside the decoded display.');
    if(input.kind==='key'&&(!Number.isSafeInteger(input.scanCode)||input.scanCode<0||input.scanCode>255||
      (input.flags&~0x8100)!==0))throw fail('Choose a supported guest keyboard event.');
    return this.dispatch('input',input);
  }
  async wakeDisplay(owner){
    if(!this.prepared||!this.last.displayReady||!['agent','user'].includes(owner)||this.last.inputOwner!==owner)
      throw fail('Display wake requires the unchanged current native input owner.','WORKBENCH_NATIVE_WAKE_REJECTED');
    const result=await this.dispatch('wake',{expectedOwner:owner});
    if(result.inputOwner!==owner||result.wake?.requested!==true||result.wake?.queued!==true||result.wake?.desktopAwakeConfirmed!==false){
      this.uncertain=true;this.last={...this.last,displayReady:false};
      throw fail('Display wake delivery could not be verified. No retry was sent.','WORKBENCH_NATIVE_WAKE_UNCERTAIN');
    }
    this.last={...result,displayReady:ready(result)};return this.last;
  }
  async capture(destination){
    if(!this.last.displayReady||!path.isAbsolute(destination||'')||!destination.toLowerCase().endsWith('.bmp'))
      throw fail('A verified decoded display and new absolute BMP destination are required.');
    const receipt=await this.dispatch('capture',{path:destination});
    if(receipt.path!==destination||!Number.isSafeInteger(receipt.bytes)||receipt.bytes<54||receipt.bytes>67108918||
      !/^[a-f0-9]{64}$/.test(receipt.sha256||''))throw fail('Native capture receipt was invalid.');
    const bytes=await this.readFileImpl(destination);
    if(bytes.length!==receipt.bytes||bytes[0]!==0x42||bytes[1]!==0x4d||
      createHash('sha256').update(bytes).digest('hex')!==receipt.sha256)
      throw fail('Native capture bytes did not match the decoded-surface receipt.');
    return {...receipt,bytes};
  }
  async sample(points){
    const {width,height}=this.last.surface??{};
    if(!this.last.displayReady||![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096)||
      !Array.isArray(points)||!points.length||points.length>64||
      points.some(p=>!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['x','y'].includes(k))||
        !Number.isSafeInteger(p.x)||!Number.isSafeInteger(p.y)||p.x<0||p.y<0||
        p.x>=width||p.y>=height))
      throw fail('Sample up to 64 points inside the verified guest display.');
    const requested=points.map(({x,y})=>({x,y}));
    const result=await this.dispatch('sample',{points:requested});
    if(Object.keys(result).some(k=>!['sequence','frameAtMonotonicMs','width','height','points'].includes(k))||
      !Number.isSafeInteger(result.sequence)||result.sequence<1||
      !Number.isSafeInteger(result.frameAtMonotonicMs)||result.frameAtMonotonicMs<0||
      result.width!==width||result.height!==height||!Array.isArray(result.points)||result.points.length!==requested.length||
      result.points.some((p,index)=>!p||typeof p!=='object'||Array.isArray(p)||
        Object.keys(p).some(k=>!['x','y','r','g','b'].includes(k))||p.x!==requested[index].x||p.y!==requested[index].y||
        !['r','g','b'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0&&p[k]<=255)))
      throw fail('Native pixel sample did not match the requested decoded surface.');
    return result;
  }
  async configureClipboard(enabled){
    if(typeof enabled!=='boolean'||!this.prepared||this.uncertain)throw fail('The native clipboard session is unavailable.');
    const result=await this.dispatch('clipboard',{enabled});
    this.last={...result,displayReady:ready(result),uncertain:false};return this.last;
  }
  async configureControls(value){
    const requested=validateNativeControls(value);
    if(!this.prepared||this.uncertain||this.closed)throw fail('The native Workbench controls are unavailable.');
    const result=await this.dispatch('controls',requested),controls=result.controls;
    if(!object(controls)||Object.keys(controls).some(key=>!['available','eventSequence',...controlFields].includes(key))||
      controls.available!==true||!Number.isSafeInteger(controls.eventSequence)||controls.eventSequence<0||
      controlFields.some(key=>controls[key]!==requested[key])){
      this.uncertain=true;this.last={...this.last,displayReady:false};
      throw fail('Native Workbench control settings were not acknowledged.','WORKBENCH_NATIVE_CONTROLS');
    }
    this.last={...result,displayReady:ready(result),uncertain:false};return this.last;
  }
  async completeClipboardPaste({pasteId,epoch,paste}={}){
    if(!Number.isSafeInteger(pasteId)||pasteId<1||pasteId>0x7fffffff||!Number.isSafeInteger(epoch)||epoch<0||epoch>0x7fffffff||
      typeof paste!=='boolean'||!this.prepared||this.uncertain)throw fail('The native clipboard intent is invalid.');
    const result=await this.dispatch('clipboard',{pasteId,epoch,paste});
    this.last={...result,displayReady:ready(result),uncertain:false};return this.last;
  }
  async status(){
    if(this.uncertain||!this.worker)return {...this.last,displayReady:false,uncertain:this.uncertain,closed:this.closed,cached:true,...(this.processLifecycle?{cleanup:this.cleanupReceipt()}:{} )};
    const result=await this.dispatch('status');
    this.last={...result,displayReady:ready(result),uncertain:false};
    return this.last;
  }
  close(){
    if(!this.closing)this.closing=this.closeWorker();
    return this.closing;
  }
  cleanupReceipt(){
    const life=this.processLifecycle;
    return nativeCleanupReceipt(life?{confirmed:life.exited,exited:life.exited,started:life.started,forced:life.forced,exitCode:life.exitCode,signal:life.signal}:
      {confirmed:true,exited:true,started:false,forced:false,exitCode:null,signal:null});
  }
  async closeWorker(){
    const life=this.processLifecycle,worker=this.worker||life?.worker;
    if(this.closed)return {...this.last,cleanup:this.cleanupReceipt()};
    const deadline=Date.now()+this.closeTimeoutMs;
    let timer;
    try{
      if(worker&&!life?.exited&&!this.uncertain){
        // The native close reply is an acknowledgement, not proof that the
        // helper process has exited. Give the acknowledged shutdown the rest
        // of its bounded deadline before falling back to forced termination.
        await Promise.race([this.dispatch('close').catch(()=>{}),life.exit,new Promise(resolve=>{
          timer=setTimeout(resolve,Math.max(1,Math.floor(this.closeTimeoutMs/2)));
        })]);
        clearTimeout(timer);
        if(life&&!life.exited)await Promise.race([life.exit,new Promise(resolve=>{
          timer=setTimeout(resolve,Math.max(1,deadline-Date.now()));
        })]);
      }
    }
    finally{
      clearTimeout(timer);
      this.closed=true;this.prepared=false;this.worker=null;
      if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(fail('Native viewer closed.'));this.pending=null;}
      try{worker?.stdin.end()}catch{}
      if(worker&&!life?.exited){if(life)life.forced=true;try{worker.kill()}catch{}}
      if(life&&!life.exited){let wait;await Promise.race([life.exit,new Promise(resolve=>{wait=setTimeout(resolve,Math.max(1,deadline-Date.now()));})]);clearTimeout(wait);}
      const cleanup=this.cleanupReceipt();this.uncertain=cleanup.confirmed!==true;
      this.last={closed:true,displayReady:false,uncertain:this.uncertain,cleanup};
    }
    return this.last;
  }
}
