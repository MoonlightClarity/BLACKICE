import {createHash} from 'node:crypto';
import {readRetainedWorkbenchCapture} from './historical-guest-capture.mjs';

export const PLANNING_REVIEW_MEDIA_LIMITS=Object.freeze({images:2,bytes:12*1024*1024});
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b);
const fail=message=>Object.assign(new Error(message),{code:'PLANNING_MEDIA_BINDING'});
const argsOf=value=>{if(typeof value==='string')try{return JSON.parse(value);}catch{return null;}return value;};
export function validatePlanningImageDelivery(value){
  const allowed=['version','sourceId','sourceHash','runId','planRef','count','images','omittedCaptureCount','status'];
  if(!value||Object.keys(value).some(key=>!allowed.includes(key))||value.version!==1||!['prepared','supplied'].includes(value.status)||typeof value.sourceId!=='string'||value.sourceId.length>240||!/^[a-f0-9]{64}$/.test(value.sourceHash||'')||typeof value.runId!=='string'||value.runId.length>120||!Number.isSafeInteger(value.count)||value.count<0||value.count>2||!Array.isArray(value.images)||value.images.length>2||!Number.isSafeInteger(value.omittedCaptureCount)||value.omittedCaptureCount<0)throw fail('Invalid bounded image-delivery evidence.');
  const ref=value.planRef;
  if(!ref||Object.keys(ref).sort().join(',')!=='cycleId,nodeId,nodeRevision,requestId,responseId'||!Number.isSafeInteger(ref.nodeRevision)||ref.nodeRevision<1||['cycleId','nodeId','requestId','responseId'].some(key=>typeof ref[key]!=='string'||!ref[key]||ref[key].length>240))throw fail('Image delivery needs the exact adopted Plan.');
  const fields=['captureCallId','nodeId','capturedAt','receiptSha256','basis','sequence','sha256','scopeHash','width','height','bytes','available','delivered','ordinal','code'];
  for(const image of value.images)if(!image||Object.keys(image).some(key=>!fields.includes(key))||typeof image.captureCallId!=='string'||!image.captureCallId||image.captureCallId.length>300||typeof image.nodeId!=='string'||image.nodeId.length>120||!Number.isFinite(Date.parse(image.capturedAt))||image.basis!=='native-decoded-surface'||['receiptSha256','sha256','scopeHash'].some(key=>!/^[a-f0-9]{64}$/.test(image[key]||''))||![image.width,image.height].every(number=>Number.isSafeInteger(number)&&number>0&&number<=4096)||!Number.isSafeInteger(image.bytes)||image.bytes<57||image.bytes>PLANNING_REVIEW_MEDIA_LIMITS.bytes||!Number.isSafeInteger(image.sequence)||image.sequence<1||typeof image.delivered!=='boolean'||image.available!==undefined&&typeof image.available!=='boolean'||image.ordinal!==undefined&&(!Number.isSafeInteger(image.ordinal)||image.ordinal<1||image.ordinal>2)||image.code!==undefined&&!/^[A-Z_]{1,100}$/.test(image.code))throw fail('Image delivery contains invalid capture metadata.');
  if(value.images.filter(image=>image.delivered).length!==value.count||JSON.stringify(value).length>12000)throw fail('Image-delivery count differs from its bounded evidence.');
  return structuredClone(value);
}

/** Only completed native adapter captures with the host's matching successful tool
 * settlement are candidates. Model prose, artifact registrations and arbitrary
 * files cannot create visual evidence. */
export function retainedPlanningCaptures(run,planRef){
  if(!run||!same(run.responseCycle?.planRef||run.viability?.planRef,planRef))throw fail('Visual evidence belongs to another adopted Plan.');
  const settled=new Set((run.events||[]).filter(event=>event.runId===run.id&&event.data?.type==='tool.result'&&event.data.tool==='relay_workbench'&&event.data.action==='capture'&&event.data.success===true&&event.data.status==='completed'&&typeof event.data.callId==='string').map(event=>event.nodeId+'\0'+event.data.callId));
  const records=[];
  for(const event of run.events||[]){
    const item=event.data?.item,args=argsOf(item?.arguments);
    if(event.runId!==run.id||event.data?.type!=='item'||item?.type!=='dynamicToolCall'||(item.tool||item.name)!=='relay_workbench'||item.success!==true||item.status!=='completed'||args?.action!=='capture'||args.retain!==true||!settled.has(event.nodeId+'\0'+item.id)||!Number.isFinite(Date.parse(event.at)))continue;
    let metadata;try{metadata=JSON.parse(item.contentItems.find(part=>part.type==='inputText'&&typeof part.text==='string'&&part.text.startsWith('{'))?.text);}catch{continue;}
    const artifact=metadata?.artifact;
    if(metadata?.basis!=='native-decoded-surface'||artifact?.retained!==true||artifact.readBackVerified!==true||metadata.pngSha256!==artifact.sha256||metadata.width!==artifact.width||metadata.height!==artifact.height||metadata.pngBytes!==artifact.bytes||!/^[a-f0-9]{64}$/.test(artifact.sha256||'')||!Number.isSafeInteger(metadata.sequence)||metadata.sequence<1)continue;
    const descriptor={captureCallId:item.id,nodeId:event.nodeId,capturedAt:event.at,receiptSha256:hash(event),basis:metadata.basis,sequence:metadata.sequence,sha256:artifact.sha256,scopeHash:artifact.scopeHash,width:artifact.width,height:artifact.height,bytes:artifact.bytes};
    const previous=records.find(value=>value.descriptor.captureCallId===item.id&&value.descriptor.nodeId===event.nodeId);
    if(previous){if(!same(previous.descriptor,descriptor))throw fail('A capture identity names conflicting visual evidence.');continue;}
    records.push({descriptor,artifact});
  }
  const selected=[],seen=new Set();let total=0;
  for(const item of records.sort((a,b)=>Date.parse(b.descriptor.capturedAt)-Date.parse(a.descriptor.capturedAt))){
    if(seen.has(item.descriptor.sha256))continue;seen.add(item.descriptor.sha256);
    if(selected.length>=PLANNING_REVIEW_MEDIA_LIMITS.images||!Number.isSafeInteger(item.descriptor.bytes)||item.descriptor.bytes<57||total+item.descriptor.bytes>PLANNING_REVIEW_MEDIA_LIMITS.bytes)continue;
    total+=item.descriptor.bytes;selected.push(item);
  }
  return {selected:selected.reverse(),omittedCaptureCount:Math.max(0,records.length-selected.length)};
}

export const planningMediaSourceId=cycleId=>'cycle:execution:'+cycleId+':visual-evidence';
export async function preparePlanningReviewMedia({run,planRef,workspace,assertCurrent=()=>{}}){
  const {selected,omittedCaptureCount}=retainedPlanningCaptures(run,planRef);
  if(!selected.length)return null;
  const images=[];
  for(const {descriptor,artifact} of selected){
    try{await readRetainedWorkbenchCapture({workspace,scope:run.taskId||run.id,artifact,assertCurrent});images.push({...descriptor,available:true});}
    catch(error){assertCurrent();images.push({...descriptor,available:false,code:/^(WORKBENCH_CAPTURE_[A-Z_]+)$/.test(error.code||'')?error.code:'PLANNING_MEDIA_UNAVAILABLE'});}
  }
  const body={version:1,kind:'retained-workbench-images',runId:run.id,planRef,images,omittedCaptureCount,meaning:'Captured pixels for analytical visual assessment; metadata is not a visual judgment or an effect receipt.'},text=JSON.stringify(body);
  return {id:planningMediaSourceId(planRef.cycleId),kind:'tool_receipt',title:'Retained guest images for final review',text,contentHash:hash(text)};
}

/** Re-read exact bytes immediately before a provider call. Nothing here probes
 * the VM or supplies a file chosen by the response worker. */
export async function loadPlanningReviewMedia({run,planRef,workspace,source,assertCurrent=()=>{}}){
  if(!source||source.id!==planningMediaSourceId(planRef.cycleId)||source.kind!=='tool_receipt'||source.contentHash!==hash(source.text))throw fail('The visual evidence source changed.');
  const manifest=JSON.parse(source.text);
  if(manifest.version!==1||manifest.kind!=='retained-workbench-images'||manifest.runId!==run.id||!same(manifest.planRef,planRef)||!Array.isArray(manifest.images)||manifest.images.length>PLANNING_REVIEW_MEDIA_LIMITS.images)throw fail('The visual evidence source belongs to another execution.');
  const captures=retainedPlanningCaptures(run,planRef),inputImages=[],images=[];
  for(const declared of manifest.images){
    const candidate=captures.selected.find(item=>same(item.descriptor,Object.fromEntries(Object.keys(item.descriptor).map(key=>[key,declared[key]]))));
    if(!candidate)throw fail('The image does not match a current-run capture receipt.');
    if(declared.available!==true){images.push({...declared,delivered:false});continue;}
    try{
      const {bytes}=await readRetainedWorkbenchCapture({workspace,scope:run.taskId||run.id,artifact:candidate.artifact,assertCurrent});
      inputImages.push({imageUrl:'data:image/png;base64,'+bytes.toString('base64')});
      images.push({...candidate.descriptor,delivered:true,ordinal:inputImages.length});
    }catch(error){assertCurrent();images.push({...candidate.descriptor,delivered:false,code:/^(WORKBENCH_CAPTURE_[A-Z_]+)$/.test(error.code||'')?error.code:'PLANNING_MEDIA_UNAVAILABLE'});}
  }
  return {inputImages,delivery:validatePlanningImageDelivery({version:1,status:'prepared',sourceId:source.id,sourceHash:source.contentHash,runId:run.id,planRef,count:inputImages.length,images,omittedCaptureCount:manifest.omittedCaptureCount})};
}
