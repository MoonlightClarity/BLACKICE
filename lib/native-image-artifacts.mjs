import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const MAX_BYTES=32*1024*1024;
const contained=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const format=bytes=>bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'jpg':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'webp':null;

/** Native image results can contain megabytes of encoded pixels. Keep files and
 * compact receipts, never encoded image bodies in saved execution events. */
export function safeNativeImageItem(item) {
 return {type:'imageGeneration',id:String(item.id||'').slice(0,200),status:String(item.status||'').slice(0,100),
  ...(typeof item.savedPath==='string'?{savedPath:item.savedPath.slice(0,32768)}:{}),
  ...(typeof item.transparentBackground==='boolean'?{transparentBackground:item.transparentBackground}:{}),
  ...(item.failure?{failure:typeof item.failure.type==='string'?{type:item.failure.type.slice(0,100)}:{type:'image_generation_failed'}}:{}),
  result:item.status==='completed'?'Generated image bytes are saved separately.':'Image generation has not completed.'};
}

export async function preserveNativeImage({item,cwd,threadId}={}) {
 if(item?.status!=='completed')return null;
 let bytes;
 if(typeof item.savedPath==='string'&&path.isAbsolute(item.savedPath)){
  const handle=await fs.open(item.savedPath,'r');
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size<12||stat.size>MAX_BYTES)throw Error('The generated image file has an unsupported size.');bytes=await handle.readFile();}finally{await handle.close();}
 }else if(typeof item.result==='string'){
  const encoded=item.result.replace(/^data:image\/(?:png|jpeg|webp);base64,/,'');
  if(encoded.length>Math.ceil(MAX_BYTES*4/3)+4||!encoded.length||!/^[A-Za-z0-9+/=\r\n]+$/.test(encoded))throw Error('Codex did not return a saved image or supported image bytes.');
  bytes=Buffer.from(encoded,'base64');
 }
 if(!bytes||bytes.length<12||bytes.length>MAX_BYTES)throw Error('Codex did not return usable generated image bytes.');
 const extension=format(bytes);if(!extension)throw Error('The generated result is not a supported raster image.');
 const root=await fs.realpath(cwd),directory=path.join(root,'generated-images');await fs.mkdir(directory,{recursive:true});
 const canonicalDirectory=await fs.realpath(directory);if(!contained(root,canonicalDirectory))throw Error('The generated image folder resolves outside the working folder.');
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const identity=createHash('sha256').update(String(threadId)+'\n'+String(item.id)+'\n'+sha256).digest('hex').slice(0,24);
 const destination=path.join(canonicalDirectory,'image-'+identity+'.'+extension);
 try{await fs.writeFile(destination,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;const prior=await fs.readFile(destination);if(!prior.equals(bytes))throw Error('The generated image destination already contains different bytes.');}
 return {path:destination,fileName:path.basename(destination),size:bytes.length,sha256,contentType:'image/'+(extension==='jpg'?'jpeg':extension)};
}

export const nativeImageLink=artifact=>'[Generated image](<'+artifact.path.replaceAll('\\','/')+'>)';
