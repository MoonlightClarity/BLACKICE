import { randomUUID } from 'node:crypto';

const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const area=value=>value&&typeof value==='object'&&!Array.isArray(value)&&integer(value.x,0,32768)&&integer(value.y,0,32768)&&integer(value.width,80,10000)&&integer(value.height,60,10000);

export function createNativeWindowsCapability(host,surface) {
  return {host,reveal:options=>surface.reveal(options),observe:options=>surface.observe(options),changed:()=>surface.changed()};
}

/** Request observed Applications geometry from BLACKICE's trusted renderer.
 * Agent callers never choose coordinates or supply JavaScript to the renderer.
 */
export class NativeAppSurface {
  constructor({getWindow,ensureVisible,trustedSender,timeoutMs=15000}={}) {
    this.getWindow=getWindow;this.ensureVisible=ensureVisible;this.trustedSender=trustedSender;this.timeoutMs=timeoutMs;this.pending=new Map();
  }
  async reveal({signal}={}) {
    return this.request('reveal',{signal});
  }
  async observe({signal,generation}={}) {
    if(signal?.aborted)throw Error('Opening Applications was cancelled.');
    if(!integer(generation,0,Number.MAX_SAFE_INTEGER))throw Error('Use the Applications generation returned by reveal.');
    const window=this.getWindow?.();
    if(!window||window.isDestroyed?.()||window.isVisible?.()===false)return {surface:'applications',visible:false,generation,observedAt:new Date().toISOString()};
    return this.request('observe',{signal,generation});
  }
  async request(action,{signal,generation}={}) {
    if(signal?.aborted)throw Error('Opening Applications was cancelled.');
    const requestId=randomUUID(),startedAt=Date.now();
    return new Promise((resolve,reject)=>{
      let timer;
      const finish=(error,result)=>{if(!this.pending.has(requestId))return;this.pending.get(requestId)?.cleanup?.();this.pending.delete(requestId);clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
      const abort=()=>finish(Error('Opening Applications was cancelled.'));
      const pending={finish,startedAt,window:null,action,generation};this.pending.set(requestId,pending);
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>finish(Error('Applications did not return a visible panel. Open the BLACKICE desktop and try again.')),this.timeoutMs);
      void Promise.resolve().then(()=>action==='reveal'?this.ensureVisible?.():undefined).then(async()=>{
        if(!this.pending.has(requestId))return;
        const window=this.getWindow?.();
        if(!window||window.isDestroyed?.()||window.isVisible?.()===false)throw Error('The BLACKICE desktop window is unavailable.');
        pending.window=window;
        if(window.webContents?.isLoadingMainFrame?.())await new Promise((ready,failed)=>{
          const clean=()=>{window.webContents.removeListener('did-finish-load',done);window.webContents.removeListener('did-fail-load',fail);};
          const done=()=>{clean();ready();};
          const fail=()=>{clean();failed(Error('The BLACKICE interface did not load.'));};
          pending.cleanup=clean;
          window.webContents.once('did-finish-load',done);window.webContents.once('did-fail-load',fail);
        });
        if(this.pending.has(requestId))window.webContents.send('relay:native-apps-reveal',{requestId,action,...(action==='observe'?{generation}:{})});
      }).catch(error=>finish(error));
    });
  }
  acknowledge(event,value) {
    if(!this.trustedSender?.(event))throw Error('Applications geometry must come from BLACKICE.');
    const pending=value&&typeof value==='object'&&!Array.isArray(value)?this.pending.get(value.requestId):null;
    if(!pending)return {accepted:false};
    if(pending.window!==this.getWindow?.()||pending.window.isDestroyed?.()||pending.window.isVisible?.()===false){pending.finish(Error('The BLACKICE desktop changed before Applications was ready.'));return {accepted:false};}
    if(typeof value.error==='string'){pending.finish(Error(value.error.slice(0,1000)));return {accepted:true};}
    const observed=Date.parse(value.observedAt);
    if(value.surface!=='applications'||!integer(value.generation,0,Number.MAX_SAFE_INTEGER)||typeof value.visible!=='boolean'||(pending.action==='reveal'&&!value.visible)||(value.visible&&!area(value.bounds))||!Number.isFinite(observed)||observed<pending.startedAt-1000||Date.now()-observed>3000||observed>Date.now()+1000){
      pending.finish(Error('Applications did not return fresh visible panel bounds.'));return {accepted:false};
    }
    const visible=value.visible&&(pending.action!=='observe'||value.generation===pending.generation);
    pending.finish(null,{surface:'applications',visible,generation:value.generation,...(visible?{bounds:{x:value.bounds.x,y:value.bounds.y,width:value.bounds.width,height:value.bounds.height}}:{}),observedAt:value.observedAt});
    return {accepted:true};
  }
  changed() {
    const window=this.getWindow?.();
    if(window&&!window.isDestroyed?.())window.webContents.send('relay:native-apps-changed');
  }
  close() {for(const pending of [...this.pending.values()])pending.finish(Error('BLACKICE is closing.'));}
}
