/** Ordinary app close keeps a managed native parent alive, without desktop release. */
export const nativeOwnershipPossible = host => Boolean(host?.attached || host?.sessionActive || host?.ownershipPossible);

export function assertNativeParentUnowned(host) {
  if (nativeOwnershipPossible(host)) throw Object.assign(Error('BLACKICE retains the hidden native application parent while its applications remain managed.'), {code:'NATIVE_APP_PARENT_RETAINED',nativeReleaseBlocked:true});
}

export function createNativeParentRetainer({host,background}) {
  let pending = null;
  return () => {
    if(pending)return pending;
    pending=Promise.resolve().then(async()=>{
      if(!nativeOwnershipPossible(host))return {retained:false};
      // Empty modal regions / hide the native stage before hiding its parent.
      // A failed hide retains the live visible parent rather than releasing it.
      const receipt=await host.visibleState(false);
      if(receipt?.visible!==false&&nativeOwnershipPossible(host))throw Error('The native application surface could not be confirmed hidden; its parent remains open.');
      if(!nativeOwnershipPossible(host))return {retained:false};
      await background();return {retained:true,hidden:true};
    }).finally(()=>{pending=null;});
    return pending;
  };
}

export function createNativeParentCloseHandler({ host, retain, closeWindow, onAllowed = () => {}, onRetained = () => {}, onError = () => {} }) {
  let releasing = false;
  return event => {
    if (!nativeOwnershipPossible(host)) { onAllowed(); return; }
    event.preventDefault();
    if (releasing) return;
    releasing = true;
    void retain().then(result=>result.retained?onRetained():closeWindow()).catch(onError).finally(() => { releasing = false; });
  };
}

/** Owned/uncertain sessions never enter shutdown or acquire an exit watchdog. */
export function createNativeSafeQuitHandler({ host, retain, shutdown, onReleased, onRetained, onBlocked, onFailure, onTimeout, onTimeoutBlocked = () => {},
  timeoutMs = 25000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null;
  return event => {
    event.preventDefault();
    if (pending) return pending;
    let timer;
    pending = Promise.resolve().then(async()=>{
      if(nativeOwnershipPossible(host)){
        const result=await retain();if(result.retained){onRetained();return;}
      }
      timer=setTimer(()=>{
        if(nativeOwnershipPossible(host)){onTimeoutBlocked();return;}
        void onTimeout();
      },timeoutMs);
      await shutdown();assertNativeParentUnowned(host);return onReleased();
    }).catch(error=>nativeOwnershipPossible(host)||error.nativeReleaseBlocked?onBlocked(error):onFailure(error))
      .finally(()=>{if(timer!==undefined)clearTimer(timer);pending=null;});
    return pending;
  };
}
