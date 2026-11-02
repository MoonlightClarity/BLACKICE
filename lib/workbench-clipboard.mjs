import {createHash} from 'node:crypto';

export const MAX_WORKBENCH_CLIPBOARD_CHARS=65536;
const fail=(message,code='WORKBENCH_CLIPBOARD_INVALID',status=409)=>Object.assign(Error(message),{code,status});
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
// A clipboard serial is opaque uint32 metadata: zero is valid initially or
// after wraparound. The native agent separately verifies station access when
// Windows returns zero; the write still compares it under OpenClipboard.
const sequence=value=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
const categories=['text/plain','image','files','other'];

export function validateWorkbenchClipboardText(text,{allowEmpty=false}={}){
  if(typeof text!=='string'||text.length>MAX_WORKBENCH_CLIPBOARD_CHARS||(!allowEmpty&&!text.length)||
    /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))
    throw fail('Copy plain text within the 65536-character limit.','WORKBENCH_CLIPBOARD_TEXT',400);
  return text;
}
export function validateWorkbenchClipboardSequence(value){
  if(!sequence(value))throw fail('The clipboard version is unavailable.','WORKBENCH_CLIPBOARD_SEQUENCE',400);
  return value;
}
export function validateWorkbenchClipboardState(value){
  if(!plain(value)||Object.keys(value).some(key=>!['sequence','hasText','formats'].includes(key))||
    !sequence(value.sequence)||typeof value.hasText!=='boolean'||!Array.isArray(value.formats)||value.formats.length>4||
    new Set(value.formats).size!==value.formats.length||value.formats.some(format=>!categories.includes(format))||
    value.hasText!==value.formats.includes('text/plain'))
    throw fail('The VM clipboard state could not be verified.','WORKBENCH_CLIPBOARD_RESPONSE');
  return structuredClone(value);
}
export function validateWorkbenchClipboardSnapshot(value){
  if(!plain(value)||Object.keys(value).some(key=>!['sequence','hasText','formats','characters','text','sha256'].includes(key))||
    !sequence(value.sequence)||typeof value.hasText!=='boolean'||!Array.isArray(value.formats)||value.formats.length>4||
    new Set(value.formats).size!==value.formats.length||value.formats.some(format=>!categories.includes(format))||
    !Number.isInteger(value.characters)||value.characters<0||value.characters>MAX_WORKBENCH_CLIPBOARD_CHARS)
    throw fail('The VM clipboard response could not be verified.','WORKBENCH_CLIPBOARD_RESPONSE');
  if(value.hasText){
    const text=validateWorkbenchClipboardText(value.text,{allowEmpty:true});
    if(!value.formats.includes('text/plain')||value.characters!==text.length||value.sha256!==hash(text))
      throw fail('The VM clipboard text did not match its receipt.','WORKBENCH_CLIPBOARD_RESPONSE');
  }else if('text' in value||'sha256' in value||value.characters!==0||value.formats.includes('text/plain'))
    throw fail('The VM clipboard format response was invalid.','WORKBENCH_CLIPBOARD_RESPONSE');
  return structuredClone(value);
}
function hostSnapshot(value){
  if(!plain(value)||!Array.isArray(value.formats)||value.formats.length>128||
    value.formats.some(format=>typeof format!=='string'||format.length>256))
    throw fail('The computer clipboard is unavailable.','WORKBENCH_CLIPBOARD_HOST');
  const formats=[...new Set(value.formats)].sort(),hasText=formats.includes('text/plain');
  if(hasText&&(typeof value.text!=='string'||value.text.length>4*1024*1024))
    throw fail('The computer clipboard exceeds the transfer inspection limit.','WORKBENCH_CLIPBOARD_HOST');
  const text=hasText?value.text:null;
  return {hasText,text,formats,fingerprint:hash(JSON.stringify({formats,text}))};
}
function supported(snapshot,where){
  if(!snapshot.hasText||!snapshot.text.length)
    throw fail(`${where} clipboard has no plain text to copy.`,snapshot.formats?.length?'WORKBENCH_CLIPBOARD_FORMAT':'WORKBENCH_CLIPBOARD_EMPTY');
}
function checkAgent(value,kind,expected){
  if(value?.online!==true||value.paired!==true||typeof value.agentId!=='string'||!value.agentId||
    !Number.isInteger(value.guestSessionId)||value.guestSessionId<=0||!value.capabilities?.includes(kind)||
    expected&&(value.agentId!==expected.agentId||value.guestSessionId!==expected.guestSessionId))
    throw fail('The VM clipboard agent is unavailable or changed.','WORKBENCH_CLIPBOARD_UNAVAILABLE',503);
}

/** Private desktop coordinator. Host clipboard text never leaves this process.
 * Both manual buttons and an explicitly configured synchronization controller
 * may call transfer; automatic callers supply a current owner/focus guard.
 * readHostClipboard/writeHostText are synchronous Electron clipboard adapters. */
export function createWorkbenchClipboardTransfer({getWorkbench,readHostClipboard,writeHostText,getGuestState=workbench=>workbench.status()}={}){
  if([getWorkbench,readHostClipboard,writeHostText,getGuestState].some(fn=>typeof fn!=='function'))
    throw TypeError('Workbench clipboard requires scoped runtime and native clipboard adapters.');
  const transfer=async function transfer(request,{guard=()=>{}}={}){
    if(!plain(request)||Object.keys(request).some(key=>!['direction','controlToken'].includes(key))||
      !['toGuest','fromGuest'].includes(request.direction)||typeof guard!=='function')
      throw fail('Choose a Workbench clipboard direction.','WORKBENCH_CLIPBOARD_ARGUMENTS',400);
    const workbench=getWorkbench();
    if(typeof workbench?.consoleControl?.run!=='function'||typeof workbench.bridge!=='function')
      throw fail('The VM clipboard is unavailable.','WORKBENCH_CLIPBOARD_UNAVAILABLE',503);
    return workbench.consoleControl.run(async assertCurrent=>{
      let bridge;
      const check=async()=>{assertCurrent();if(await guard()===false)throw fail('Clipboard sharing is paused outside the current Workbench window.','WORKBENCH_CLIPBOARD_PAUSED');assertCurrent();if(getWorkbench()!==workbench||bridge&&workbench.bridge()!==bridge)throw fail('Workbench changed during clipboard transfer.','WORKBENCH_CLIPBOARD_CHANGED');};
      const readHost=()=>{try{return hostSnapshot(readHostClipboard())}catch{throw fail('The computer clipboard could not be inspected.','WORKBENCH_CLIPBOARD_HOST');}};
      await check();const state=await getGuestState(workbench);await check();
      if(state.canRunNativeApps!==true)throw fail('A running paired VM is required for clipboard sharing.','WORKBENCH_CLIPBOARD_UNAVAILABLE',503);
      bridge=workbench.bridge();const agent=state.guest?.agent;
      checkAgent(agent,request.direction==='toGuest'?'clipboard_state':'clipboard_read');
      if(request.direction==='toGuest')checkAgent(agent,'clipboard_write');
      const before=readHost();await check();
      if(request.direction==='toGuest'){supported(before,'Your computer');validateWorkbenchClipboardText(before.text);}
      const perform=async(kind,args)=>{
        await check();const receipt=await bridge.request(kind,args,{timeoutMs:6000,expectedAgent:agent});await check();
        if(receipt?.status!=='completed')throw fail('The VM has not confirmed this clipboard transfer. No retry was sent.','WORKBENCH_CLIPBOARD_UNCONFIRMED');
        if(receipt.kind!==kind||receipt.agentId!==agent.agentId||receipt.guestSessionId!==agent.guestSessionId)
          throw fail('The VM clipboard response identity changed.','WORKBENCH_CLIPBOARD_RESPONSE');
        const current=await bridge.agentStatus();await check();checkAgent(current,kind,agent);
        return receipt;
      };
      const read=await perform(request.direction==='toGuest'?'clipboard_state':'clipboard_read',{});
      const guest=request.direction==='toGuest'?validateWorkbenchClipboardState(read.result):validateWorkbenchClipboardSnapshot(read.result);
      const after=readHost();await check();
      if(after.fingerprint!==before.fingerprint)throw fail('Your computer clipboard changed during transfer. Copy again.','WORKBENCH_CLIPBOARD_CHANGED');
      let characters,guestSequence=guest.sequence;
      if(request.direction==='toGuest'){
        const written=await perform('clipboard_write',{text:before.text,expectedSequence:guest.sequence});
        const value=written.result;
        if(!plain(value)||Object.keys(value).some(key=>!['written','sequence','characters','sha256'].includes(key))||
          value.written!==true||!sequence(value.sequence)||value.characters!==before.text.length||value.sha256!==hash(before.text))
          throw fail('The VM clipboard write was not confirmed. No retry was sent.','WORKBENCH_CLIPBOARD_UNCONFIRMED');
        characters=before.text.length;guestSequence=value.sequence;
      }else{
        supported(guest,'The VM');await check();
        if(readHost().fingerprint!==before.fingerprint)
          throw fail('Your computer clipboard changed before transfer completed.','WORKBENCH_CLIPBOARD_CHANGED');
        // No host clipboard clearing or write occurs before the full guest
        // receipt, stable host fingerprint, pairing and owner checks succeed.
        try{writeHostText(guest.text)}catch{throw fail('The computer clipboard could not accept the text.','WORKBENCH_CLIPBOARD_HOST');}
        characters=guest.text.length;
      }
      return {copied:true,direction:request.direction,format:'text/plain',characters,guestSequence,pasted:false,
        consoleControl:workbench.consoleControl.status()};
    },request.controlToken);
  };
  // Metadata-only polling avoids moving clipboard text through the shared
  // folder when its sequence has not changed. Never expose this internal
  // adapter as an unscoped host-clipboard read operation.
  transfer.state=async(request={}, {guard=()=>{}}={})=>{
    if(!plain(request)||Object.keys(request).some(key=>key!=='controlToken')||typeof guard!=='function')
      throw fail('Choose a scoped Workbench clipboard state request.','WORKBENCH_CLIPBOARD_ARGUMENTS',400);
    const workbench=getWorkbench();
    if(typeof workbench?.consoleControl?.run!=='function'||typeof workbench.bridge!=='function')
      throw fail('The VM clipboard is unavailable.','WORKBENCH_CLIPBOARD_UNAVAILABLE',503);
    return workbench.consoleControl.run(async assertCurrent=>{
      let bridge;
      const check=async()=>{assertCurrent();if(await guard()===false)throw fail('Clipboard sharing is paused.','WORKBENCH_CLIPBOARD_PAUSED');assertCurrent();if(getWorkbench()!==workbench||bridge&&workbench.bridge()!==bridge)throw fail('Workbench changed during clipboard inspection.','WORKBENCH_CLIPBOARD_CHANGED');};
      await check();const state=await getGuestState(workbench);await check();
      if(!state.canRunNativeApps)throw fail('A running paired VM is required.','WORKBENCH_CLIPBOARD_UNAVAILABLE',503);
      bridge=workbench.bridge();const agent=state.guest?.agent;checkAgent(agent,'clipboard_state');
      const receipt=await bridge.request('clipboard_state',{}, {timeoutMs:6000,expectedAgent:agent});await check();
      if(receipt?.status!=='completed'||receipt.kind!=='clipboard_state'||receipt.agentId!==agent.agentId||receipt.guestSessionId!==agent.guestSessionId)
        throw fail('The VM clipboard state has not been confirmed.','WORKBENCH_CLIPBOARD_RESPONSE');
      const current=await bridge.agentStatus();await check();checkAgent(current,'clipboard_state',agent);
      return {...validateWorkbenchClipboardState(receipt.result),consoleControl:workbench.consoleControl.status()};
    },request.controlToken);
  };
  return transfer;
}

export function createWorkbenchClipboardHandler({trustedSender,...options}={}){
  if(typeof trustedSender!=='function')throw TypeError('Workbench clipboard requires a trusted desktop sender.');
  const transfer=createWorkbenchClipboardTransfer(options);
  return (event,request)=>{
    if(!trustedSender(event))throw fail('Workbench clipboard requests must come from BLACKICE.','WORKBENCH_CLIPBOARD_SENDER',403);
    return transfer(request);
  };
}
