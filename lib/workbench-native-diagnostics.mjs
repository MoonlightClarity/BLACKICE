const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const integer=(value,max=Number.MAX_SAFE_INTEGER,min=0)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const states=new Set(('INITIAL NEGO NLA AAD MCS_CREATE_REQUEST MCS_CREATE_RESPONSE MCS_ERECT_DOMAIN MCS_ATTACH_USER MCS_ATTACH_USER_CONFIRM MCS_CHANNEL_JOIN_REQUEST MCS_CHANNEL_JOIN_RESPONSE RDP_SECURITY_COMMENCEMENT SECURE_SETTINGS_EXCHANGE CONNECT_TIME_AUTO_DETECT_REQUEST CONNECT_TIME_AUTO_DETECT_RESPONSE LICENSING MULTITRANSPORT_BOOTSTRAPPING_REQUEST MULTITRANSPORT_BOOTSTRAPPING_RESPONSE CAPABILITIES_EXCHANGE_DEMAND_ACTIVE CAPABILITIES_EXCHANGE_MONITOR_LAYOUT CAPABILITIES_EXCHANGE_CONFIRM_ACTIVE FINALIZATION_SYNC FINALIZATION_COOPERATE FINALIZATION_REQUEST_CONTROL FINALIZATION_PERSISTENT_KEY_LIST FINALIZATION_FONT_LIST FINALIZATION_CLIENT_SYNC FINALIZATION_CLIENT_COOPERATE FINALIZATION_CLIENT_GRANTED_CONTROL FINALIZATION_CLIENT_FONT_MAP ACTIVE').split(' ').map(state=>'CONNECTION_STATE_'+state));
export const nativeAttemptAvailabilityMeaning='new-attempt-availability-not-connection-readiness';

/** Deliberately excludes paths, handles, usernames, tokens, stderr and pixels. */
export function nativeConnectionDiagnostics(value){
  if(!object(value))return null;
  const result={};
  for(const key of ['prepared','connected','digestReady','certificateVerified'])if(typeof value[key]==='boolean')result[key]=value[key];
  for(const key of ['coreError','selectedProtocol','nlaAuthRequests','deniedAuthRequests','decodedFrames','refreshRequests'])if(integer(value[key],key==='coreError'?0xffffffff:Number.MAX_SAFE_INTEGER))result[key]=value[key];
  if(object(value.connectionProgress)){
    const progress={};
    if(states.has(value.connectionProgress.state))progress.state=value.connectionProgress.state;
    for(const key of ['tlsStarted','tlsFinished'])if(typeof value.connectionProgress[key]==='boolean')progress[key]=value.connectionProgress[key];
    for(const key of ['stateChanges','preConnectCalls','postConnectCalls','readCalls','readCompletions','readBytes','writeCalls','writeCompletions','writeBytes','lastReadAtMonotonicMs','lastWriteAtMonotonicMs'])if(integer(value.connectionProgress[key]))progress[key]=value.connectionProgress[key];
    if(Object.keys(progress).length)result.connectionProgress=progress;
  }
  if(object(value.surface)){
    const surface={};
    for(const key of ['sequence','width','height','frameAtMonotonicMs','firstFrameAtMonotonicMs'])if(integer(value.surface[key],['width','height'].includes(key)?4096:Number.MAX_SAFE_INTEGER))surface[key]=value.surface[key];
    if(Object.keys(surface).length)result.surface=surface;
  }
  return Object.keys(result).length?result:null;
}
export function nativeCleanupReceipt(value){
  if(!object(value)||!['confirmed','exited','started','forced'].every(key=>typeof value[key]==='boolean')||value.confirmed!==value.exited)return null;
  return {confirmed:value.confirmed,exited:value.exited,started:value.started,forced:value.forced,
    exitCode:integer(value.exitCode,0xffffffff,-0x80000000)?value.exitCode:null,
    signal:['SIGTERM','SIGKILL','SIGABRT','SIGINT','SIGHUP','SIGBREAK'].includes(value.signal)?value.signal:null};
}
export function nativeConnectionAttempt(value){
  if(!object(value)||!['connected','failed','uncertain'].includes(value.status)||!/^[A-Z0-9_]{1,80}$/.test(value.code||'')||typeof value.acknowledged!=='boolean'||typeof value.uncertain!=='boolean')return null;
  const cleanup=nativeCleanupReceipt(value.cleanup),diagnostics=nativeConnectionDiagnostics(value.diagnostics);
  const explicitRetryAllowed=value.status==='failed'&&value.code==='CONNECT_FAILED'&&value.acknowledged&&!value.uncertain&&cleanup?.confirmed===true;
  return {status:value.status,code:value.code,acknowledged:value.acknowledged,uncertain:value.uncertain,
    ...(diagnostics?{diagnostics}:{}),...(cleanup?{cleanup}:{}),explicitRetryAllowed,
    retryRecommendation:explicitRetryAllowed?'one-fresh-explicit-attempt':'inspect-before-retry',retryLimitEnforced:false,
    ...(typeof value.at==='string'&&value.at.length<=30&&Number.isFinite(Date.parse(value.at))?{at:value.at}:{})};
}
