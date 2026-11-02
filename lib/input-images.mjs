const maximumImages=2,maximumBytes=12*1024*1024,prefix='data:image/png;base64,';
const invalid=()=>Object.assign(Error('Image inputs must contain at most two bounded PNG data images, totalling at most 12 MiB.'),{code:'INVALID_INPUT_IMAGES'});
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let i=0;i<8;i++)value=value>>>1^(value&1?0xedb88320:0);return value>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const value of bytes)crc=crc>>>8^crcTable[(crc^value)&255];return (crc^0xffffffff)>>>0;}
function validatePng(bytes){
  if(bytes.length<57||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw invalid();
  let at=8,header=false,body=false,ended=false;
  while(at<bytes.length){
    if(at+12>bytes.length)throw invalid();const length=bytes.readUInt32BE(at),end=at+length+12;
    if(end>bytes.length)throw invalid();const type=bytes.toString('ascii',at+4,at+8),data=bytes.subarray(at+8,at+8+length);
    if(!/^[A-Za-z]{4}$/.test(type)||crc32(bytes.subarray(at+4,at+8+length))!==bytes.readUInt32BE(at+8+length)||!header&&type!=='IHDR')throw invalid();
    if(type==='IHDR'){
      if(header||length!==13||![data.readUInt32BE(0),data.readUInt32BE(4)].every(v=>v>0&&v<=4096)||data[8]!==8||![2,6].includes(data[9])||data[10]!==0||data[11]!==0||data[12]!==0)throw invalid();
      header=true;
    }else if(type==='IDAT'){if(ended)throw invalid();body=true;}
    else if(type==='IEND'){if(length!==0||end!==bytes.length||!body)throw invalid();ended=true;}
    else if(!(bytes[at+4]&32)&&type!=='PLTE')throw invalid();
    at=end;
  }
  if(!ended)throw invalid();
}

/** Transport-only PNG inputs. Callers must independently bind evidence provenance. */
export function normalizeInputImages(inputImages){
  if(inputImages===undefined)return [];
  if(!Array.isArray(inputImages)||inputImages.length>maximumImages||Array.from({length:inputImages.length},(_,i)=>!Object.hasOwn(inputImages,i)).some(Boolean))throw invalid();
  let total=0;
  return inputImages.map(image=>{
    if(!image||typeof image!=='object'||Array.isArray(image)||Object.keys(image).length!==1||!Object.hasOwn(image,'imageUrl')||typeof image.imageUrl!=='string'||!image.imageUrl.startsWith(prefix)||image.imageUrl.length>prefix.length+Math.ceil(maximumBytes/3)*4)throw invalid();
    const base64=image.imageUrl.slice(prefix.length);
    if(!base64.length||base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw invalid();
    const bytes=Buffer.from(base64,'base64');total+=bytes.length;
    if(total>maximumBytes||bytes.toString('base64')!==base64)throw invalid();
    validatePng(bytes);return {imageUrl:prefix+base64};
  });
}

/** Reject explicit model exclusions; unknown metadata is not a vision promise. */
export function assertInputImagesSupported(images,model){
  if(!images?.length)return;
  if(model?.supportsVision===false||model?.vision===false||Array.isArray(model?.inputModalities)&&model.inputModalities.length>0&&!model.inputModalities.some(value=>typeof value==='string'&&value.toLowerCase()==='image'))throw Object.assign(Error('The selected model explicitly does not support image input. Choose a model that supports images.'),{code:'INPUT_IMAGES_UNSUPPORTED'});
}

/** Strip echoed image payloads before events/history; never use this on the wire. */
export function redactInputImageData(value,inputImages=[]){
  const known=inputImages.flatMap(image=>typeof image?.imageUrl==='string'&&image.imageUrl.startsWith(prefix)?[image.imageUrl,image.imageUrl.slice(prefix.length)]:[]).filter(Boolean);
  const payloads=known.filter(value=>!value.startsWith(prefix));
  const walk=item=>{
    if(typeof item==='string'){let text=item;for(const secret of known)text=text.replaceAll(secret,'[image data omitted]');if(payloads.length)text=text.replace(/[A-Za-z0-9+/]{32,}={0,2}/g,part=>payloads.some(payload=>payload.includes(part))?'[image data omitted]':part);return text.replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,'[image data omitted]');}
    if(Array.isArray(item))return item.map(walk);
    if(item&&typeof item==='object'){
      if(['image','image_url','input_image','inputImage','localImage'].includes(item.type))return {type:'text',text:'[image data omitted]'};
      return Object.fromEntries(Object.entries(item).map(([key,entry])=>[key,walk(entry)]));
    }
    return item;
  };
  return walk(value);
}
