/** Let the renderer veto closing before any service is torn down.
 * A veto is cancellation, never permission to discard an editor draft. */
export function createQuitWindowGate({getWindow}) {
 let pending=null;
 return ()=>{
  if(pending)return pending;
  const window=getWindow();
  if(!window||window.isDestroyed())return Promise.resolve(true);
  pending=new Promise((resolve,reject)=>{
   const contents=window.webContents;
   const cleanup=()=>{window.removeListener('closed',closed);contents.removeListener('will-prevent-unload',blocked);};
   const closed=()=>{cleanup();resolve(true);};
   const blocked=()=>{cleanup();resolve(false);};
   window.once('closed',closed);contents.once('will-prevent-unload',blocked);
   try{window.close();}catch(error){cleanup();reject(error);}
  }).finally(()=>{pending=null;});
  return pending;
 };
}
