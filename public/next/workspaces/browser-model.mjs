/** A native contained-browser frame is a concrete document, not a guessed URL.
 * Never send mouse or keyboard actions against a stale or unknown identity.
 */
export function browserFrame(value, tabId) {
  if (!value || value.tabId !== tabId
      || typeof value.url !== 'string' || !value.url || value.url.length > 20000
      || typeof value.documentId !== 'string' || !value.documentId || value.documentId.length > 256
      || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
      || value.width < 1 || value.height < 1 || value.width > 8192 || value.height > 8192
      || typeof value.imageUrl !== 'string' || value.imageUrl.length > 16 * 1024 * 1024
      || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.imageUrl)) return null;
  return {
    tabId, url:value.url, documentId:value.documentId,
    width:value.width, height:value.height, imageUrl:value.imageUrl,
  };
}
export function pagePoint(frame, point, bounds) {
  if (!frame || !bounds
    || ![bounds.left,bounds.top,bounds.width,bounds.height,point?.clientX,point?.clientY].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) return null;
  const x=(point.clientX-bounds.left)/bounds.width*frame.width;
  const y=(point.clientY-bounds.top)/bounds.height*frame.height;
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null;
  return {x:Math.floor(x),y:Math.floor(y)};
}
export function browserInputGuard(frame, selected) {
  if (!frame || frame.tabId!==selected || typeof frame.documentId!=='string' || !frame.documentId || !frame.url)
    throw Error('Refresh the exact browser page before interacting.');
  return {tabId:selected,expectedUrl:frame.url,expectedDocumentId:frame.documentId};
}
export function wheelPixels(event,frame){
  if (!frame || ![0,1,2].includes(event?.deltaMode)
      || !Number.isFinite(event?.deltaX) || !Number.isFinite(event?.deltaY)) return null;
  const xUnit=event.deltaMode===1?16:event.deltaMode===2?frame.width:1;
  const yUnit=event.deltaMode===1?16:event.deltaMode===2?frame.height:1;
  const deltaX=event.deltaX*xUnit,deltaY=event.deltaY*yUnit;
  if (![deltaX,deltaY].every(v=>Number.isFinite(v)&&Math.abs(v)<=32000)
      || (!deltaX&&!deltaY)) return null;
  return {deltaX,deltaY};
}
export function pendingDialog(value,tabId) {
  if(!value || value.tabId!==tabId || !['javascript_dialog','file_chooser','http_auth'].includes(value.kind)
    || !['pending','blocked'].includes(value.status)
    || typeof value.id!=='string' || !value.id || value.id.length>256
    || typeof value.url!=='string' || !value.url || value.url.length>20000
    || typeof value.documentId!=='string' || !value.documentId || value.documentId.length>256) return null;
  return {
    id:value.id,kind:value.kind,status:value.status,tabId,
    url:value.url,documentId:value.documentId,
    message:String(value.message||'').slice(0,4096),
    ...(value.kind==='javascript_dialog'?{
      dialogType:String(value.dialogType||'').slice(0,60),
      defaultPrompt:String(value.defaultPrompt||'').slice(0,4096),
    }:{}),
    ...(value.kind==='file_chooser'?{multiple:value.multiple===true}:{}),
  };
}
