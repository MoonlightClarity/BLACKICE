/**
 * Bidirectional Workbench guest bridge over the explicitly shared workspace.
 * The Windows guest runs a separate interactive agent. Host never sends GUI
 * input to its own desktop. Durable commands are not automatically retried.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import {validateWorkbenchClipboardText,validateWorkbenchClipboardSequence} from './workbench-clipboard.mjs';

const fail=(message,code='WORKBENCH_GUEST_INVALID',status=409)=>
  Object.assign(new Error(message),{code,status});
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');
const idPattern=/^[a-f0-9]{32}$/;
const checkedId=id=>{if(typeof id!=='string'||!idPattern.test(id))throw fail('Unknown guest command ID.','WORKBENCH_GUEST_ID',400);return id;};
const now=()=>Date.now();
const parseISO=s=>{const n=Date.parse(s);return Number.isFinite(n)?n:0};
const boundedJson=async(file,limit=32000,{metadataAttempts=1,sleep}={})=>{
  for(let attempt=0;attempt<metadataAttempts;attempt++){
    try{const s=await fs.stat(file);if(s.size>limit)return null;return JSON.parse(await fs.readFile(file,'utf8'))}
    catch(error){
      if(['ENOENT','EACCES','EPERM','EBUSY'].includes(error.code)&&attempt+1<metadataAttempts){await sleep(25);continue;}
      if(error.code==='ENOENT')return null;
      if(error instanceof SyntaxError)return null;
      throw error;
    }
  }
};
const CLIPBOARD_JSON_LIMIT=512*1024;
async function boundedClipboardJson(file){
  let handle;
  try{
    const before=await fs.lstat(file);
    if(!before.isFile()||before.isSymbolicLink()||before.size>CLIPBOARD_JSON_LIMIT)throw Error('invalid');
    handle=await fs.open(file,'r');const opened=await handle.stat();
    const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;
    if(!same(before,opened)||!opened.isFile())throw Error('invalid');
    const chunks=[],buffer=Buffer.alloc(32768);let length=0;
    for(;;){
      const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,CLIPBOARD_JSON_LIMIT+1-length),length);
      if(!bytesRead)break;length+=bytesRead;if(length>CLIPBOARD_JSON_LIMIT)throw Error('invalid');
      chunks.push(Buffer.from(buffer.subarray(0,bytesRead)));
    }
    const after=await fs.lstat(file);
    if(!same(opened,await handle.stat())||!same(opened,after)||after.isSymbolicLink())throw Error('invalid');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }catch(error){if(error.code==='ENOENT')return null;throw fail('Guest clipboard response exceeded its private protocol bounds.','WORKBENCH_CLIPBOARD_RESPONSE');}
  finally{await handle?.close().catch(()=>{});}
}
const acceptedActions=['probe','capture','launch','click','type','key','windows','batch_install','clipboard_state','clipboard_read','clipboard_write','display_info','display_resize'];
export function validateWorkbenchGuestAction(kind,args={}){
  if(!acceptedActions.includes(kind)||!args||typeof args!=='object'||Array.isArray(args))
    throw fail('Unsupported guest action.','WORKBENCH_GUEST_ACTION',400);
  const allowed={
    probe:['nonce'],capture:[],launch:['appPath','arguments','cwd'],click:['x','y'],
    type:['text'],key:['key'],windows:[],batch_install:['runId','snapshotId','manifestSha256'],
    clipboard_state:[],clipboard_read:[],clipboard_write:['text','expectedSequence'],
    display_info:['guestSessionId'],display_resize:['width','height','guestSessionId']
  }[kind];
  if(Object.keys(args).some(key=>!allowed.includes(key)))throw fail('Unexpected guest action parameter.','WORKBENCH_GUEST_ACTION',400);
  if(kind==='probe'&&!idPattern.test(args.nonce))throw fail('A unique host challenge is required.','WORKBENCH_GUEST_ACTION',400);
  if(kind==='launch'){
    if(typeof args.appPath!=='string'||!path.win32.isAbsolute(args.appPath)||args.appPath.includes('\0')||args.appPath.length>2048)
      throw fail('Choose an absolute native executable path inside the Windows guest.','WORKBENCH_GUEST_APP',400);
    if(args.arguments!==undefined&&(!Array.isArray(args.arguments)||args.arguments.length>24||
      args.arguments.some(x=>typeof x!=='string'||x.length>1000)))
      throw fail('Use at most 24 bounded native application arguments.','WORKBENCH_GUEST_APP',400);
    if(args.cwd!==undefined&&(!path.win32.isAbsolute(args.cwd)||args.cwd.includes('\0')||args.cwd.length>2048))
      throw fail('Guest working directory must be absolute.','WORKBENCH_GUEST_APP',400);
  }
  if(kind==='batch_install'&&(!idPattern.test(args.runId)||!idPattern.test(args.snapshotId)||
    typeof args.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(args.manifestSha256)))
    throw fail('A guest app-install batch needs an exact saved host manifest and unique run ID.','WORKBENCH_GUEST_BATCH',400);
  if(kind==='click'&&(!Number.isInteger(args.x)||args.x<0||args.x>16000||
    !Number.isInteger(args.y)||args.y<0||args.y>16000))throw fail('Guest click requires bounded screen coordinates.','WORKBENCH_GUEST_INPUT',400);
  if(kind==='type'&&(typeof args.text!=='string'||args.text.length>10000))
    throw fail('Guest typing supports up to 10000 characters.','WORKBENCH_GUEST_INPUT',400);
  if(kind==='key'&&!['ENTER','ESC','TAB','BACKSPACE','CTRL+A','ALT+TAB'].includes(args.key))
    throw fail('Choose a supported guest shortcut.','WORKBENCH_GUEST_INPUT',400);
  if(kind==='clipboard_write'){
    validateWorkbenchClipboardText(args.text);validateWorkbenchClipboardSequence(args.expectedSequence);
  }
  if(['display_info','display_resize'].includes(kind)&&(!Number.isInteger(args.guestSessionId)||args.guestSessionId<=0))
    throw fail('Display requests require the paired guest session.','WORKBENCH_GUEST_DISPLAY',400);
  if(kind==='display_resize'&&(!Number.isInteger(args.width)||!Number.isInteger(args.height)||
    args.width<320||args.width>4096||args.height<200||args.height>4096))
    throw fail('Choose bounded guest display dimensions.','WORKBENCH_GUEST_DISPLAY',400);
  return structuredClone(args);
}
async function atomic(file,content){
  const tmp=file+'.'+randomBytes(6).toString('hex')+'.tmp';
  try{await fs.writeFile(tmp,content,{flag:'wx'});await fs.rename(tmp,file)}
  finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class WorkbenchGuestBridge{
  constructor({sharedRoot,clock=now,sleep=delay}={}){
    if(typeof sharedRoot!=='string'||!path.isAbsolute(sharedRoot))
      throw fail('Use the actual BLACKICE workspace as the guest bridge root.','WORKBENCH_GUEST_ROOT',500);
    this.workspace=path.resolve(sharedRoot);
    this.root=path.join(this.workspace,'.blackice-workbench');
    this.clock=clock;this.sleep=sleep;this.ready=null;
  }
  async init(){
    return this.ready||=(async()=>{
      for(const f of ['requests','responses','frames'])
        await fs.mkdir(path.join(this.root,f),{recursive:true});
      return this;
    })();
  }
  async prepare({hostName,agentScript,setupScript,appBatchScript,videoScript,nativeVideoInstallScript,nativeVideoBinary,rdpPreflightScript,guestDisplayScript}={}){
    await this.init();
    if(typeof hostName!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(hostName))
      throw fail('The host machine name must be observed before preparing the guest agent.','WORKBENCH_GUEST_HOST_NAME');
    const scripts={ 'guest-agent.ps1':agentScript,'guest-setup.ps1':setupScript,
      ...(appBatchScript?{'guest-app-batch.ps1':appBatchScript}:{}),
      ...(videoScript?{'workbench-desktop-stream.ps1':videoScript}:{}),
      ...(nativeVideoInstallScript?{'install-native-video.ps1':nativeVideoInstallScript}:{}),
      ...(rdpPreflightScript?{'rdp-preflight.ps1':rdpPreflightScript}:{}),
      ...(guestDisplayScript?{'guest-display.ps1':guestDisplayScript}:{}) };
    for(const [name,content] of Object.entries(scripts)){
      if(typeof content!=='string'||content.length<500||content.length>50000)
        throw fail('Guest bootstrap script missing or unexpected size.','WORKBENCH_GUEST_BOOTSTRAP');
      await atomic(path.join(this.root,name),content);
    }
    if(nativeVideoBinary!==undefined){
      if(!Buffer.isBuffer(nativeVideoBinary)||nativeVideoBinary.length<200000||
         nativeVideoBinary.length>20000000||nativeVideoBinary[0]!==0x4d||nativeVideoBinary[1]!==0x5a)
        throw fail('Native guest video binary missing or invalid; run the pinned video build.','WORKBENCH_VIDEO_BUILD',500);
      await atomic(path.join(this.root,'workbench-guest-video.exe'),nativeVideoBinary);
    }
    await atomic(path.join(this.root,'host-info.json'),JSON.stringify({version:1,hostName,
      preparedAt:new Date(this.clock()).toISOString()}));
    return {prepared:true,shareRoot:this.workspace,agentScript:'.blackice-workbench\\guest-agent.ps1',
      setupScript:'.blackice-workbench\\guest-setup.ps1',hostName,
      nativeVideoPrepared:Boolean(nativeVideoBinary),nativeVideoSha256:nativeVideoBinary?digest(nativeVideoBinary):null};
  }
  async agentStatus(){
    // Guest PowerShell replacement can briefly remove or lock a metadata
    // pathname. Reread only these two files, at most six times (125ms waiting).
    // Never reuse identity, retry changed/malformed data, or replay an action.
    const metadata={metadataAttempts:6,sleep:this.sleep},[agent,pair]=await Promise.all([
      boundedJson(path.join(this.root,'agent-state.json'),32000,metadata),
      boundedJson(path.join(this.root,'pairing.json'),32000,metadata)
    ]);
    const last=await boundedJson(path.join(this.root,'latest-frame.json'));
    // A verified historical capture establishes that this interactive agent
    // supports display capture. Its age only affects whether the thumbnail is
    // still shown, not whether the paired guest needs setup again.
    let frameReady=Boolean(last?.requestId&&idPattern.test(last.requestId)&&
      last.agentId===agent?.agentId&&parseISO(last.at)>0);
    if(frameReady)try{await this.frame(last.requestId)}catch{frameReady=false}
    const frameFresh=frameReady&&this.clock()-parseISO(last.at)<300000;
    const freshness=agent?.heartbeatAt&&this.clock()-parseISO(agent.heartbeatAt);
    const online=agent?.version===1&&typeof agent.agentId==='string'&&
      freshness>=-5000&&freshness<20000&&agent.interactive===true;
    const paired=Boolean(online&&pair?.version===1&&pair.agentId===agent.agentId&&
      pair.guestSessionId===agent.sessionId&&this.clock()-parseISO(pair.verifiedAt)<24*3600_000);
    const privileges=agent?.privileges;
    const verifiedPrivileges=paired&&privileges&&typeof privileges==='object'&&!Array.isArray(privileges)&&
      Object.keys(privileges).length===2&&Object.hasOwn(privileges,'administratorToken')&&Object.hasOwn(privileges,'basis')&&
      typeof privileges.administratorToken==='boolean'&&privileges.basis==='interactive-guest-agent-token';
    return {online:Boolean(online),paired,guestName:agent?.guestName||null,
      guestSessionId:online?agent.sessionId:null,heartbeatAt:agent?.heartbeatAt||null,
      agentId:online?agent.agentId:null,
      capabilities:online&&Array.isArray(agent.capabilities)?agent.capabilities:[],
      ...(verifiedPrivileges?{privileges:{administratorToken:privileges.administratorToken,basis:privileges.basis}}:{}),
      sharedReadWriteVerified:paired,
      displayReady:paired&&frameReady,lastFrameId:paired&&frameFresh?last.requestId:null,
      expectedGuestRoot:agent?.guestRoot||null};
  }
  async readResult(requestId){
    checkedId(requestId);await this.init();
    const result=await boundedJson(path.join(this.root,'responses',requestId+'.json'));
    if(!result)return {requestId,status:'pending'};
    if(result.version!==1||result.requestId!==requestId||!['completed','failed'].includes(result.status))
      return {requestId,status:'unverified',error:'Guest response identity or shape is invalid.'};
    return {...result,verified:'host-observed-guest-response'};
  }
  async readClipboardResult(requestId,expectedKind){
    checkedId(requestId);
    if(!['clipboard_state','clipboard_read','clipboard_write'].includes(expectedKind))
      throw fail('An exact clipboard response kind is required.','WORKBENCH_CLIPBOARD_RESPONSE');
    let result;try{result=await boundedClipboardJson(path.join(this.root,'responses',requestId+'.json'))}
    catch{return {requestId,status:'unverified'}}
    if(!result)return {requestId,status:'pending'};
    if(result.version!==1||result.requestId!==requestId||result.kind!==expectedKind||!['completed','failed'].includes(result.status))
      return {requestId,status:'unverified'};
    return {...result,verified:'host-observed-guest-response'};
  }
  async request(kind,args={}, {timeoutMs=10000,requirePair=true,expectedAgent}={}){
    args=validateWorkbenchGuestAction(kind,args);
    const clipboard=['clipboard_state','clipboard_read','clipboard_write'].includes(kind);
    const bound=clipboard||['display_info','display_resize'].includes(kind);
    let pairedAgent;
    if(bound&&(!requirePair||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>10000))
      throw fail('Interactive requests require a paired guest and a bounded deadline.',clipboard?'WORKBENCH_CLIPBOARD_UNAVAILABLE':'WORKBENCH_GUEST_CAPABILITY');
    if(requirePair){
      const s=await this.agentStatus();
      if(!s.paired)throw fail('Interactive guest and bidirectional folder handshake are not verified.','WORKBENCH_GUEST_NOT_PAIRED');
      if(bound){
        if(!s.capabilities.includes(kind)||!s.agentId||!Number.isInteger(s.guestSessionId)||s.guestSessionId<=0||
          expectedAgent&&(expectedAgent.agentId!==s.agentId||expectedAgent.guestSessionId!==s.guestSessionId))
          throw fail('The paired guest capability changed.',clipboard?'WORKBENCH_CLIPBOARD_UNAVAILABLE':'WORKBENCH_GUEST_CAPABILITY');
        if(['display_info','display_resize'].includes(kind)&&args.guestSessionId!==s.guestSessionId)
          throw fail('The display request belongs to another guest session.','WORKBENCH_GUEST_CAPABILITY');
        pairedAgent=s;
      }
    }
    if(!Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>30000)
      throw fail('Guest action deadline is invalid.','WORKBENCH_GUEST_TIMEOUT',400);
    await this.init();
    const requestId=randomBytes(16).toString('hex');
    const request={version:1,requestId,kind,args,issuedAt:new Date(this.clock()).toISOString(),
      expiresAt:new Date(this.clock()+(bound?timeoutMs:60000)).toISOString(),
      ...(bound?{expectedAgentId:pairedAgent.agentId,expectedGuestSessionId:pairedAgent.guestSessionId}:{})};
    await atomic(path.join(this.root,'requests',requestId+'.json'),JSON.stringify(request));
    const until=this.clock()+timeoutMs;
    while(this.clock()<until){
      const result=clipboard?await this.readClipboardResult(requestId,kind):await this.readResult(requestId);
      if(result.status!=='pending'){
        if(bound){
          // Clipboard contents are transient transport data, never a durable
          // action-history record. Consume only the exact request/response.
          await Promise.all([fs.rm(path.join(this.root,'requests',requestId+'.json'),{force:true}),
            fs.rm(path.join(this.root,'responses',requestId+'.json'),{force:true}),
            ...(clipboard?[fs.rm(path.join(this.root,'clipboard-expiry',requestId+'.json'),{force:true})]:[])]);
          if(result.kind!==kind||result.agentId!==pairedAgent.agentId||result.guestSessionId!==pairedAgent.guestSessionId||
            !['completed','failed'].includes(result.status))
            throw fail('Guest response identity could not be verified.',clipboard?'WORKBENCH_CLIPBOARD_RESPONSE':'WORKBENCH_GUEST_RESPONSE');
        }
        if(kind==='capture'&&result.status==='completed'){
          const data=await this.frame(requestId);
          if(data.bytes.length)await atomic(path.join(this.root,'latest-frame.json'),
            JSON.stringify({version:1,requestId,agentId:result.agentId,at:new Date(this.clock()).toISOString()}));
        }
        return result;
      }
      await this.sleep(Math.min(bound?50:200,until-this.clock()));
    }
    if(bound){
      // Cancellation is durable and contains no text. An already executing
      // write can still be uncertain, so callers must never retry it blindly.
      await atomic(path.join(this.root,'requests',requestId+'.cancel.json'),JSON.stringify({version:1,requestId,
        expectedAgentId:pairedAgent.agentId,expectedGuestSessionId:pairedAgent.guestSessionId,cancelledAt:new Date(this.clock()).toISOString()}));
      await Promise.all([fs.rm(path.join(this.root,'requests',requestId+'.json'),{force:true}),
        fs.rm(path.join(this.root,'responses',requestId+'.json'),{force:true})]);
    }
    return {requestId,status:'pending',message:'Guest has not confirmed this action. Inspect the same request; never retry a native launch blindly.'};
  }
  async pair({timeoutMs=10000}={}){
    const state=await this.agentStatus();
    if(!state.online)throw fail('Guest interactive agent has not reported a fresh heartbeat.','WORKBENCH_GUEST_OFFLINE');
    const nonce=randomBytes(16).toString('hex');
    const r=await this.request('probe',{nonce},{requirePair:false,timeoutMs});
    if(r.status==='pending')return {status:'pending',requestId:r.requestId};
    if(r.status!=='completed'||r.result?.nonce!==nonce||r.agentId!==state.agentId||
      r.guestSessionId!==state.guestSessionId)
      throw fail('Guest did not demonstrate a round trip to the shared host workspace.','WORKBENCH_GUEST_PROBE_FAILED');
    const receipt={version:1,verifiedAt:new Date(this.clock()).toISOString(),
      agentId:state.agentId,guestSessionId:state.guestSessionId,requestId:r.requestId};
    await atomic(path.join(this.root,'pairing.json'),JSON.stringify(receipt));
    return {status:'paired',receipt,agent:await this.agentStatus()};
  }
  async frame(requestId){
    checkedId(requestId);
    const receipt=await this.readResult(requestId);
    if(receipt.status!=='completed'||receipt.kind!=='capture')
      throw fail('No verified guest capture for this request.','WORKBENCH_GUEST_FRAME_MISSING',404);
    const data=await fs.readFile(path.join(this.root,'frames',requestId+'.png')).catch(()=>null);
    if(!data||data.length<8||data.length>6*1024*1024||
      !data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
      receipt.result?.sha256!==digest(data))
      throw fail('Guest screen capture is missing or did not match its receipt.','WORKBENCH_GUEST_FRAME_UNVERIFIED',409);
    return {bytes:data,mime:'image/png',requestId,
      width:receipt.result.width,height:receipt.result.height};
  }
}
