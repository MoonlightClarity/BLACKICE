import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeHandle } from './native-app-host.mjs';

const SCRIPT=fileURLToPath(new URL('./workbench-vmconnect-bridge.ps1',import.meta.url));
const validBounds=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||
      Object.keys(value).some(k=>!['x','y','width','height'].includes(k))||
      ![value.x,value.y,value.width,value.height].every(Number.isFinite))
    throw Error('Choose visible Workbench viewport bounds.');
  const b=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,Math.round(v)]));
  if(b.x<0||b.y<0||b.width<100||b.height<90||b.width>16384||b.height>16384)
    throw Error('Workbench viewport is outside supported bounds.');
  return b;
};

/** Embedded Microsoft VMConnect uses the original Hyper-V console protocol.
 * This is not a PowerShell screenshot loop or an external VMConnect popup.
 */
export class WorkbenchVMConnectHost {
  constructor({spawnImpl=spawn,getWindow,vmName='BLACKICE-Workbench',timeoutMs=18000}={}){
    this.spawnImpl=spawnImpl;this.getWindow=getWindow;this.vmName=vmName;this.timeoutMs=timeoutMs;
    this.worker=null;this.pending=null;this.buffer='';this.queue=Promise.resolve();
    this.seq=0;this.active=false;this.attached=false;this.closed=false;this.uncertain=false;
    this.bounds=null;this.last=null;
  }
  workerReady(){
    if(this.closed)throw Error('VMConnect host has closed.');
    if(this.uncertain)throw Error('A prior VMConnect launch is uncertain; inspect existing viewer before retrying.');
    if(this.worker)return;
    const worker=this.spawnImpl('powershell.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-Mta','-WindowStyle','Hidden',
      '-ExecutionPolicy','Bypass','-File',SCRIPT,'-Stream'
    ],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    this.worker=worker;this.buffer='';
    const fail=error=>{
      if(this.worker!==worker)return;
      this.worker=null;
      if(this.attached||this.pending?.action==='attach')this.uncertain=true;
      this.pending?.reject(error);
      this.pending=null;
    };
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data',chunk=>{
      if(this.worker!==worker)return;
      this.buffer+=chunk;
      if(this.buffer.length>200000)return fail(Error('VMConnect controller reply overflow.'));
      let end;
      while((end=this.buffer.indexOf('\n'))>=0){
        const line=this.buffer.slice(0,end).trim().replace(/^\uFEFF/,'');
        this.buffer=this.buffer.slice(end+1);
        if(!line||!this.pending)continue;
        let data;
        try{data=JSON.parse(line)}catch{return fail(Error('VMConnect controller reply malformed.'))}
        if(data.requestId!==this.pending.id)continue;
        const item=this.pending;this.pending=null;clearTimeout(item.timer);
        if(data.ok!==true)item.reject(Error(String(data.error||'Native VMConnect operation failed.')));
        else item.resolve(data.result);
      }
    });
    worker.stderr?.on('data',data=>{this.lastError=String(data).slice(-800)});
    worker.once('error',fail);
    worker.once('exit',code=>fail(Error('Native VMConnect controller exited ('+code+'). '+(this.lastError||''))));
  }
  execute(action,request={}){
    return new Promise((resolve,reject)=>{
      try{this.workerReady()}catch(error){reject(error);return}
      const id=++this.seq;
      const timer=setTimeout(()=>{
        if(this.pending?.id!==id)return;
        this.pending=null;
        if(action==='attach'||this.attached)this.uncertain=true;
        reject(Error('VMConnect controller timeout; inspect existing child before retrying.'));
      },action==='attach'?20000:this.timeoutMs);
      this.pending={id,action,resolve,reject,timer};
      try{this.worker.stdin.write(JSON.stringify({requestId:id,action,...request})+'\n')}
      catch(error){clearTimeout(timer);this.pending=null;reject(error)}
    });
  }
  dispatch(action,request={}) {
    const op=this.queue.catch(()=>{}).then(()=>this.execute(action,request));
    this.queue=op.catch(()=>{});
    return op;
  }
  async perform(request,host) {
    if(!request||typeof request!=='object'||Array.isArray(request))throw Error('Choose native VM action.');
    const rules={attach:['action','bounds','vmId'],bounds:['action','bounds'],
      visible:['action','visible'],input:['action','enabled'],status:['action'],close:['action']};
    const keys=rules[request.action];
    if(!keys||Object.keys(request).some(k=>!keys.includes(k)))throw Error('Unsupported VMConnect request.');
    if(request.action==='status'&&!this.worker)return this.last||{connected:false,viewerClosed:true};
    if(request.action==='close')return this.close();
    if(request.action==='attach'){
      if(!host||host.isDestroyed())throw Error('BLACKICE window closed.');
      const bounds=validBounds(request.bounds);
      const dims=host.getContentSize();
      if(bounds.x+bounds.width>dims[0]+2||bounds.y+bounds.height>dims[1]+2)
        throw Error('Native guest viewport exceeds the BLACKICE content.');
      if(typeof request.vmId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(request.vmId))
        throw Error('Hyper-V did not supply the target VM identifier.');
      const result=await this.dispatch('attach',{parent:nativeHandle(host),vmName:this.vmName,vmId:request.vmId,...bounds});
      if(result?.connected!==true)throw Error('The native VMConnect viewer was not attached.');
      this.attached=true;this.bounds=bounds;
      // Renderer reloads keep this native helper alive but hide the child.
      // Reattach must re-show the SAME VMConnect HWND rather than leaving
      // a confirmed-but-invisible viewer or launching a second process.
      const visible=result.shown===true?result:await this.dispatch('visible',{visible:true});
      if(visible?.connected!==true||visible.shown!==true)
        throw Error('The native Hyper-V viewer did not become visible.');
      this.last=visible;this.active=true;return visible;
    }
    if(!this.attached)throw Error('Native VMConnect viewer has not been attached.');
    const requestData=request.action==='bounds'?validBounds(request.bounds)
      :request.action==='visible'?{visible:request.visible===true}
      :request.action==='input'?{enabled:request.enabled===true}:{};
    const result=await this.dispatch(request.action,requestData);
    this.last=result;
    if(request.action==='visible')this.active=request.visible===true;
    if(request.action==='bounds')this.bounds=requestData;
    return result;
  }
  async hide(){
    if(!this.worker||!this.attached)return;
    try{await this.dispatch('visible',{visible:false});this.active=false}catch{}
  }
  async close(){
    if(this.closed)return this.last||{viewerClosed:true};
    const worker=this.worker;
    if(worker){
      try{this.last=await this.dispatch('close')}catch(error){
        if(this.uncertain)throw error;
      }
      try{worker.stdin.end()}catch{}
      worker.kill();
    }
    this.worker=null;this.attached=false;this.active=false;this.closed=true;
    return this.last||{viewerClosed:true};
  }
}