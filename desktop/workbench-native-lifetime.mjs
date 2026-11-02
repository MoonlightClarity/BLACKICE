/** A separate Workbench remains owned by BLACKICE when its launcher is hidden.
 * Explicit application shutdown bypasses this handler and closes its helper. */
export function createWorkbenchLauncherCloseHandler({shouldRetain,background,ordinary,onError=()=>{}}){
  let pending=null;
  return event=>{
    if(!shouldRetain())return ordinary(event);
    event.preventDefault();
    if(!pending)pending=Promise.resolve().then(background).catch(onError).finally(()=>{pending=null});
    return pending;
  };
}
