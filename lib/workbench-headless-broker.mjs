/**
 * Windows Workbench headless control transport.
 *
 * No child_process, PowerShell, elevation or host desktop operations. The only
 * transport is a local Windows named pipe owned by a preauthorized, isolated
 * broker. A missing broker leaves the original guest and its data untouched.
 */
import net from 'node:net';
import {randomUUID} from 'node:crypto';

export const WORKBENCH_BROKER_PIPE_NAME='BLACKICE-Workbench-v1';
export const workbenchBrokerPipePath=name=>'\\\\.\\pipe\\'+name;
const validOp=new Set(['ping','status','provision','start','stop','key','frame','type','click']);
const keyNames=new Set(['ENTER','TAB','SPACE','ESCAPE','UP','DOWN','LEFT','RIGHT','BACKSPACE','F10','F12']);
const error=(message,code='WORKBENCH_BROKER_UNAVAILABLE',status=503)=>Object.assign(new Error(message),{code,status});
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const ownKeys=(value,expected)=>isObject(value)&&Object.keys(value).every(k=>expected.includes(k));
export function validateWorkbenchBrokerCommand(action,args={}){
  if(!validOp.has(action)||!isObject(args))throw error('Unsupported Workbench broker operation.','WORKBENCH_BROKER_ARGUMENTS',400);
  const expected=action==='start'?['minimumMiB','startupMiB','maximumMiB','cpuCount']:
    action==='key'?['key']:action==='type'?['text']:action==='click'?['x','y','button']:
    action==='provision'?['isoPath','vmRoot','minimumMiB','startupMiB','maximumMiB','cpuCount']:[];
  if(!ownKeys(args,expected))throw error('Unsupported Workbench broker parameter.','WORKBENCH_BROKER_ARGUMENTS',400);
  if(action==='key'&&(!keyNames.has(args.key)||Object.keys(args).length!==1))
    throw error('Choose a supported guest-only keyboard key.','WORKBENCH_BROKER_ARGUMENTS',400);
  if(action==='type'&&(typeof args.text!=='string'||args.text.length<1||args.text.length>200||/[\x00-\x1f\x7f]/.test(args.text)||Object.keys(args).length!==1))
    throw error('Guest-only text must be 1–200 printable characters without control keys.','WORKBENCH_BROKER_ARGUMENTS',400);
  if(action==='click'&&(!Number.isInteger(args.x)||!Number.isInteger(args.y)||![1,2,3].includes(args.button)||
    args.x<0||args.x>=800||args.y<0||args.y>=600||Object.keys(args).length!==3))
    throw error('Guest-only click must be within the verified 800×600 frame.','WORKBENCH_BROKER_ARGUMENTS',400);
  if(action==='start'||action==='provision'){
    for(const name of ['minimumMiB','startupMiB','maximumMiB','cpuCount'])
      if(!Number.isSafeInteger(args[name]))throw error('Guest resource allocation must use bounded integers.','WORKBENCH_BROKER_ARGUMENTS',400);
    if(args.minimumMiB<2048||args.startupMiB<4096||args.startupMiB<args.minimumMiB||
      args.maximumMiB<args.startupMiB||args.maximumMiB>131072||args.cpuCount<1||args.cpuCount>64)
      throw error('Guest resource allocation outside the supported range.','WORKBENCH_BROKER_ARGUMENTS',400);
  }
  if(action==='provision'){
    if(![args.isoPath,args.vmRoot].every(v=>typeof v==='string'&&v.length>3&&v.length<=3000&&/^[a-z]:\\/i.test(v)&&!v.includes('\0')))
      throw error('Guest ISO and disk root must be exact Windows absolute paths.','WORKBENCH_BROKER_ARGUMENTS',400);
  }
  return args;
}
export function readWorkbenchBrokerReceipt(raw,expectedId,{action}){
  if(typeof raw!=='string'||raw.length>1400000)throw error('Invalid Workbench broker response size.','WORKBENCH_BROKER_PROTOCOL');
  let value;try{value=JSON.parse(raw)}catch{throw error('Workbench broker sent invalid JSON.','WORKBENCH_BROKER_PROTOCOL')}
  if(!isObject(value)||value.v!==1||value.id!==expectedId||typeof value.ok!=='boolean')
    throw error('Workbench broker response identity or version mismatch.','WORKBENCH_BROKER_PROTOCOL');
  if(!value.ok)throw error(typeof value.message==='string'?value.message.slice(0,350):'Workbench broker operation was rejected.',
    /^WORKBENCH_[A-Z_]{3,64}$/.test(value.code||'')?value.code:'WORKBENCH_BROKER_REJECTED',409);
  if(!isObject(value.result))throw error('Workbench broker response lacks a result object.','WORKBENCH_BROKER_PROTOCOL');
  if(action==='frame'){
    if(typeof value.result.jpeg!=='string'||value.result.jpeg.length>1200000||!/^\/9j\//.test(value.result.jpeg))
      throw error('Workbench broker returned an invalid guest JPEG.','WORKBENCH_BROKER_PROTOCOL');
  }
  return value.result;
}
export class WorkbenchHeadlessBroker{
  constructor({pipeName=WORKBENCH_BROKER_PIPE_NAME,connect=net.createConnection}={}){
    if(!/^BLACKICE-Workbench-v1(?:-test-[a-z0-9]{6,20})?$/.test(pipeName))
      throw error('Invalid Workbench broker pipe identity.','WORKBENCH_BROKER_ARGUMENTS',400);
    this.path=workbenchBrokerPipePath(pipeName);
    this.connect=connect;
  }
  call(action,args={},timeoutMs=3500){
    const input=validateWorkbenchBrokerCommand(action,args),id=randomUUID();
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<200||timeoutMs>30000)
      throw error('Unsupported Workbench broker deadline.','WORKBENCH_BROKER_ARGUMENTS',400);
    const line=JSON.stringify({v:1,id,op:action,args:input})+'\n';
    if(Buffer.byteLength(line)>10000)throw error('Workbench broker message is too large.','WORKBENCH_BROKER_ARGUMENTS',400);
    return new Promise((resolve,reject)=>{
      let finished=false,connected=false,submitted=false,buffer='';
      const socket=this.connect(this.path);
      const finish=(failure,result)=>{
        if(finished)return;finished=true;
        socket.destroy();if(failure)reject(failure);else resolve(result);
      };
      socket.setTimeout(timeoutMs,()=>{
        finish(error(submitted
          ?'Headless guest operation timed out after dispatch. Inspect the VM state; do not retry blindly.'
          :'The preauthorized headless Workbench broker did not respond.',
          submitted&&action!=='status'&&action!=='ping'?'WORKBENCH_BROKER_UNCERTAIN':'WORKBENCH_BROKER_UNAVAILABLE'));
      });
      socket.on('connect',()=>{connected=true;submitted=true;socket.write(line)});
      socket.on('data',chunk=>{
        buffer+=chunk.toString('utf8');
        if(buffer.length>1400000)return finish(error('Headless Workbench response exceeded limit.','WORKBENCH_BROKER_PROTOCOL'));
        const n=buffer.indexOf('\n');
        if(n>=0){let value;try{value=readWorkbenchBrokerReceipt(buffer.slice(0,n).trim(),id,{action})}
          catch(cause){return finish(cause)}
          finish(null,value);
        }
      });
      socket.on('error',cause=>{
        if(!connected&&['ENOENT','EACCES','ECONNREFUSED'].includes(cause.code))
          return finish(error('No preauthorized, headless Hyper-V broker is available. No elevation was attempted.','WORKBENCH_BROKER_UNAVAILABLE'));
        finish(error('The headless Workbench broker connection failed: '+String(cause.message||cause).slice(0,140),
          submitted&&action!=='status'&&action!=='ping'?'WORKBENCH_BROKER_UNCERTAIN':'WORKBENCH_BROKER_UNAVAILABLE'));
      });
      socket.on('end',()=>finish(error('Workbench broker closed without a verified receipt.',
        submitted&&action!=='status'&&action!=='ping'?'WORKBENCH_BROKER_UNCERTAIN':'WORKBENCH_BROKER_PROTOCOL')));
    });
  }
  async status(){
    let r;
    try{r=await this.call('status',{},2500)}
    catch(e){return {available:false,reason:e.message,code:e.code}}
    const trusted=r?.broker==='BLACKICE-Workbench'&&r?.sessionIsolated===true&&r?.identitySid==='S-1-5-18'&&
      r?.vmQueryAuthorized===true&&typeof r.vmExists==='boolean'&&
      ['NotInstalled','Off','Running','Paused','Saved','Starting','Stopping','Unknown'].includes(r.vmState);
    return trusted?{...r,available:true}:{available:false,
      reason:typeof r?.reason==='string'?r.reason.slice(0,300):'The broker is not in isolated Session 0 with authorized Hyper-V access.',
      code:'WORKBENCH_BROKER_UNAUTHORIZED'};
  }
  async provision(data){return this.call('provision',data,30000)}
  async start(data){return this.call('start',data,20000)}
  async stop(){return this.call('stop',{},20000)}
  async key(key){return this.call('key',{key},10000)}
  async type(text){return this.call('type',{text},12000)}
  async click(x,y,button=1){return this.call('click',{x,y,button},12000)}
  async frame(){
    const result=await this.call('frame',{},18000);
    const bytes=Buffer.from(result.jpeg,'base64');
    if(bytes.length<100||bytes.length>900000||bytes[0]!==0xff||bytes[1]!==0xd8||bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)
      throw error('Guest-only image was not a valid bounded JPEG.','WORKBENCH_BROKER_PROTOCOL');
    return {bytes,contentType:'image/jpeg',width:result.width,height:result.height};
  }
}
