import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';

const fail=(message,code='WORKBENCH_CAPTURE_INVALID')=>Object.assign(Error(message),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const maxBytes=12*1024*1024,locks=new Map();
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let i=0;i<8;i++)value=value>>>1^(value&1?0xedb88320:0);return value>>>0;});
const crc32=bytes=>{let crc=0xffffffff;for(const value of bytes)crc=crc>>>8^crcTable[(crc^value)&255];return (crc^0xffffffff)>>>0;};
const paeth=(a,b,c)=>{const p=a+b-c,x=Math.abs(p-a),y=Math.abs(p-b),z=Math.abs(p-c);return x<=y&&x<=z?a:y<=z?b:c;};

export function boundWorkbenchNativeHealth(frame){
  const h=frame?.nativeHealth;
  if(!h||h.available!==true||!Number.isSafeInteger(frame.sequence)||frame.sequence<1||h.sequence!==frame.sequence||
    h.meaning!=='decoded-display-sample-not-vm-power-state'||![true,false,null].includes(h.dark)||!['dark','not-dark','unknown'].includes(h.classification)||
    !Number.isSafeInteger(h.sampledPixels)||h.sampledPixels<1||h.sampledPixels>256||!Number.isSafeInteger(h.distinctColors)||h.distinctColors<1||h.distinctColors>h.sampledPixels||
    !Number.isFinite(h.blackFraction)||h.blackFraction<0||h.blackFraction>1||!Number.isSafeInteger(h.frameAgeMs)||h.frameAgeMs<0)return null;
  return {available:true,sequence:h.sequence,dark:h.dark,classification:h.classification,sampledPixels:h.sampledPixels,blackFraction:h.blackFraction,distinctColors:h.distinctColors,frameAgeMs:h.frameAgeMs,meaning:h.meaning};
}

/** Inspect the exact PNG returned to the model, including nonzero filter rows. */
export function inspectWorkbenchPng(bytes,{width,height}={}){
  if(!Buffer.isBuffer(bytes)||bytes.length<57||bytes.length>maxBytes||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw fail('The guest capture is not a bounded PNG.');
  let at=8,header,ended=false;const compressed=[];
  while(at<bytes.length){
    if(at+12>bytes.length)throw fail('The guest PNG is incomplete.');
    const n=bytes.readUInt32BE(at),end=at+12+n;if(end>bytes.length)throw fail('The guest PNG is incomplete.');
    const type=bytes.toString('ascii',at+4,at+8),data=bytes.subarray(at+8,at+8+n);
    if(crc32(bytes.subarray(at+4,at+8+n))!==bytes.readUInt32BE(at+8+n))throw fail('The guest PNG checksum is invalid.');
    if(!header&&type!=='IHDR')throw fail('The guest PNG header is missing.');
    if(type==='IHDR'){
      if(header||n!==13)throw fail('The guest PNG header is invalid.');
      header={width:data.readUInt32BE(0),height:data.readUInt32BE(4),depth:data[8],color:data[9]};
      if(![header.width,header.height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=4096)||header.depth!==8||![2,6].includes(header.color)||data[10]!==0||data[11]!==0||data[12]!==0||width!==undefined&&width!==header.width||height!==undefined&&height!==header.height)throw fail('The PNG dimensions or pixel format do not match the guest capture.');
    }else if(type==='IDAT')compressed.push(data);
    else if(type==='IEND'){if(n!==0||end!==bytes.length)throw fail('The guest PNG end marker is invalid.');ended=true;}
    else if(!(bytes[at+4]&32))throw fail('The guest PNG uses an unsupported critical chunk.');
    at=end;
  }
  if(!ended||!compressed.length)throw fail('The guest PNG has no complete image.');
  const channels=header.color===6?4:3,stride=header.width*channels,expected=(stride+1)*header.height;
  let raw;try{raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected});}catch{throw fail('The guest PNG pixels could not be decoded.');}
  if(raw.length!==expected)throw fail('The guest PNG pixel count is invalid.');
  let previous=Buffer.alloc(stride),row=Buffer.alloc(stride),nonblack=0,transparent=0,nonOpaque=0;
  for(let y=0;y<header.height;y++){
    const start=y*(stride+1),filter=raw[start];if(filter>4)throw fail('The guest PNG row filter is invalid.');
    for(let x=0;x<stride;x++){
      const left=x>=channels?row[x-channels]:0,up=previous[x],corner=x>=channels?previous[x-channels]:0;
      row[x]=(raw[start+1+x]+(filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):filter===4?paeth(left,up,corner):0))&255;
    }
    for(let x=0;x<stride;x+=channels){if(row[x]||row[x+1]||row[x+2])nonblack++;if(channels===4){if(row[x+3]===0)transparent++;if(row[x+3]!==255)nonOpaque++;}}
    [previous,row]=[row,previous];
  }
  const total=header.width*header.height;
  return {width:header.width,height:header.height,pngSha256:sha(bytes),pngBytes:bytes.length,pixelHealth:{basis:'captured-png-rgb',classification:nonblack?'nonblack':'black',allBlack:nonblack===0,blackPixels:total-nonblack,nonblackPixels:nonblack,totalPixels:total,blackFraction:(total-nonblack)/total,transparentPixels:transparent,nonOpaquePixels:nonOpaque,meaning:'image-pixels-not-VM-power-or-vision-delivery'}};
}

const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
async function ordinaryChain(folder){
  const resolved=path.resolve(folder),parsed=path.parse(resolved),parts=resolved.slice(parsed.root.length).split(path.sep).filter(Boolean),records=[];let current=parsed.root;
  for(const part of ['',...parts]){
    if(part)current=path.join(current,part);const stat=await fs.lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('Capture storage requires ordinary workspace directories.','WORKBENCH_CAPTURE_PATH');
    records.push({file:current,stat});
  }
  return records;
}
async function checkChain(records){for(const {file,stat}of records){const now=await fs.lstat(file);if(!now.isDirectory()||now.isSymbolicLink()||!same(stat,now))throw fail('Capture storage changed during the operation.','WORKBENCH_CAPTURE_PATH');}}
async function ensureChild(folder,name){
  const before=await ordinaryChain(folder),child=path.join(folder,name);try{await fs.mkdir(child,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  await checkChain(before);await ordinaryChain(child);return child;
}
async function readOrdinary(file,limit){
  const before=await fs.lstat(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>limit)throw fail('The retained capture is not an ordinary bounded file.','WORKBENCH_CAPTURE_ARTIFACT');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const opened=await handle.stat();if(!same(before,opened)||opened.size!==before.size||!opened.isFile()||opened.nlink!==1)throw fail('Retained capture identity changed.','WORKBENCH_CAPTURE_ARTIFACT');
    const buffer=Buffer.alloc(limit+1);let length=0;
    while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
    const closed=await handle.stat(),after=await fs.lstat(file);
    if(length>limit||!same(opened,closed)||opened.size!==closed.size||opened.mtimeMs!==closed.mtimeMs||!same(opened,after)||after.isSymbolicLink()||after.size!==length||after.mtimeMs!==opened.mtimeMs)throw fail('Retained capture changed while reading.','WORKBENCH_CAPTURE_ARTIFACT');
    return buffer.subarray(0,length);
  }finally{await handle.close();}
}
async function createOrRead(file,bytes){
  let handle;try{handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);await handle.writeFile(bytes);await handle.sync();}catch(error){if(error.code!=='EEXIST')throw error;}finally{await handle?.close();}
  return readOrdinary(file,Math.max(bytes.length,4096));
}

/** Explicit retention only. Paths are derived from trusted configuration and
 * task scope; no caller can choose a destination or replace existing bytes. */
export async function retainWorkbenchCapture({workspace,scope,bytes,info,assertCurrent=()=>{}}){
  if(typeof workspace!=='string'||!path.isAbsolute(workspace)||typeof scope!=='string'||!scope||scope.length>300)throw fail('A configured workspace and task scope are required.','WORKBENCH_CAPTURE_PATH');
  const verified=inspectWorkbenchPng(bytes,info);if(verified.pngSha256!==info.pngSha256)throw fail('Capture bytes changed before retention.','WORKBENCH_CAPTURE_ARTIFACT');
  const scopeHash=sha(scope),key=path.join(path.resolve(workspace),scopeHash,info.pngSha256),prior=locks.get(key)||Promise.resolve();
  const operation=prior.catch(()=>{}).then(async()=>{
    assertCurrent();await ordinaryChain(workspace);const bridge=await ensureChild(workspace,'.blackice-workbench'),captures=await ensureChild(bridge,'agent-captures'),folder=await ensureChild(captures,scopeHash),chain=await ordinaryChain(folder);
    assertCurrent();const manifest=Buffer.from(JSON.stringify({version:1,scopeHash,kind:'workbench-capture'}));
    const stored=await createOrRead(path.join(folder,'scope.json'),manifest);
    if(!stored.equals(manifest))throw fail('This capture directory belongs to a different task scope.','WORKBENCH_CAPTURE_SCOPE');
    await checkChain(chain);assertCurrent();const file=path.join(folder,info.pngSha256+'.png'),readback=await createOrRead(file,bytes);
    await checkChain(chain);assertCurrent();if(!readback.equals(bytes)||sha(readback)!==info.pngSha256)throw fail('Retained capture failed exact readback. Existing bytes were preserved.','WORKBENCH_CAPTURE_ARTIFACT');
    const relative=path.relative(path.resolve(workspace),file);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw fail('The capture escaped its configured workspace.','WORKBENCH_CAPTURE_PATH');
    return {retained:true,scopeHash,hostPath:file,guestRelativePath:relative.split(path.sep).join('\\'),sha256:info.pngSha256,width:info.width,height:info.height,bytes:bytes.length,readBackVerified:true};
  });
  locks.set(key,operation);try{return await operation;}finally{if(locks.get(key)===operation)locks.delete(key);}
}

/** Read only the exact task-scoped artifact retained by the capture adapter.
 * A serialized artifact path is a claim to check, never a path to follow. */
export async function readRetainedWorkbenchCapture({workspace,scope,artifact,assertCurrent=()=>{}}){
  if(typeof workspace!=='string'||!path.isAbsolute(workspace)||typeof scope!=='string'||!scope||scope.length>300)throw fail('A configured workspace and task scope are required.','WORKBENCH_CAPTURE_PATH');
  const scopeHash=sha(scope);
  if(!artifact||artifact.retained!==true||artifact.readBackVerified!==true||artifact.scopeHash!==scopeHash||!/^[a-f0-9]{64}$/.test(artifact.sha256||'')||!Number.isSafeInteger(artifact.bytes)||artifact.bytes<57||artifact.bytes>maxBytes||![artifact.width,artifact.height].every(value=>Number.isSafeInteger(value)&&value>0&&value<=4096))throw fail('The retained capture declaration is invalid.','WORKBENCH_CAPTURE_ARTIFACT');
  const root=path.resolve(workspace),folder=path.join(root,'.blackice-workbench','agent-captures',scopeHash),file=path.join(folder,artifact.sha256+'.png');
  if(typeof artifact.hostPath!=='string'||path.resolve(artifact.hostPath)!==file||typeof artifact.guestRelativePath!=='string'||path.resolve(root,artifact.guestRelativePath.replace(/[\\/]/g,path.sep))!==file)throw fail('The retained capture path differs from its derived task scope.','WORKBENCH_CAPTURE_PATH');
  assertCurrent();const chain=await ordinaryChain(folder);await checkChain(chain);assertCurrent();
  const manifest=await readOrdinary(path.join(folder,'scope.json'),4096),expected=Buffer.from(JSON.stringify({version:1,scopeHash,kind:'workbench-capture'}));
  if(!manifest.equals(expected))throw fail('The retained capture manifest belongs to another task.','WORKBENCH_CAPTURE_SCOPE');
  const bytes=await readOrdinary(file,artifact.bytes);await checkChain(chain);assertCurrent();
  const info=inspectWorkbenchPng(bytes,{width:artifact.width,height:artifact.height});
  if(bytes.length!==artifact.bytes||info.pngSha256!==artifact.sha256)throw fail('The retained capture no longer matches its exact receipt.','WORKBENCH_CAPTURE_ARTIFACT');
  return {bytes,info};
}
