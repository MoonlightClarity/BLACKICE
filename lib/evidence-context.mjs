import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {estimateContextTokens} from './context.mjs';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const check=signal=>{signal?.throwIfAborted?.();};
const sha=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const pointerPart=value=>String(value).replaceAll('~','~0').replaceAll('/','~1');
const separatesPair=(text,index)=>index>0&&index<text.length&&text.charCodeAt(index-1)>=0xd800&&text.charCodeAt(index-1)<=0xdbff&&text.charCodeAt(index)>=0xdc00&&text.charCodeAt(index)<=0xdfff;
const serial=value=>{const result=JSON.stringify(value);if(result===undefined)throw fail('EVIDENCE_VALUE_INVALID','Saved evidence must be a JSON value.');return result;};

async function fittingPrefix(text,fits,signal){
  check(signal);
  if(await fits(text))return text.length;
  let low=1,high=text.length,best=0;
  while(low<=high){
    check(signal);
    const middle=Math.floor((low+high)/2),length=middle-(separatesPair(text,middle)?1:0);
    if(!length){low=middle+1;continue;}
    if(await fits(text.slice(0,length))){best=length;low=middle+1;}else high=middle-1;
  }
  return best;
}

/** Partition complete source text only at the caller's measured prompt capacity.
 * Ranges use UTF-16 offsets and preserve every source character, including pairs.
 */
export async function splitTextByCapacity(text,{fits,signal}={}){
  if(typeof text!=='string'||typeof fits!=='function')throw fail('EVIDENCE_CAPACITY_INVALID','Source text and a capacity predicate are required.');
  const pieces=[];
  if(!text.length){if(!await fits('',{start:0,end:0,total:0}))throw fail('EVIDENCE_CONTEXT_CAPACITY','The current instructions leave no room for an empty source page.');return [{start:0,end:0,text:''}];}
  for(let start=0;start<text.length;){
    check(signal);
    const remaining=text.slice(start);
    const best=await fittingPrefix(remaining,part=>fits(part,{start,end:start+part.length,total:text.length}),signal);
    if(!best)throw fail('EVIDENCE_CONTEXT_CAPACITY','The current instructions leave no room for the next complete source character. The original evidence is preserved.');
    pieces.push({start,end:start+best,text:text.slice(start,start+best)});start+=best;
  }
  return pieces;
}

async function ordinaryAncestors(directory){
  for(let current=directory;;current=path.dirname(current)){
    try{const entry=await fs.lstat(current);if(!entry.isDirectory()||entry.isSymbolicLink())throw fail('EVIDENCE_PATH_INVALID','Saved evidence requires ordinary local directories.');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(path.dirname(current)===current)break;
  }
}

/** Immutable host-owned evidence. The tool can read only refs registered by this
 * instance; it cannot choose a path, execute a command, or dispatch task effects.
 */
export function createEvidenceStore({root,signal}={}){
  if(typeof root!=='string'||!path.isAbsolute(root))throw fail('EVIDENCE_PATH_INVALID','An absolute saved-evidence directory is required.');
  root=path.resolve(root);
  const resources=new Map();
  let ready;
  const prepare=()=>ready||=(async()=>{check(signal);await ordinaryAncestors(root);await fs.mkdir(root,{recursive:true});await ordinaryAncestors(root);})();
  const descriptor=entry=>({ref:entry.ref,file:entry.file,sha256:entry.sha256,kind:entry.kind});
  async function save(value,metadata={}){
    check(signal);await prepare();
    const encoded=serial(value),digest=sha(encoded),kind=typeof metadata.kind==='string'?metadata.kind:'json';
    const ref='saved-'+sha(kind+'\0'+digest),file=path.join(root,ref+'.json');
    const known=resources.get(ref);
    if(known)return descriptor(known);
    await ordinaryAncestors(root);
    const temporary=file+'.'+randomUUID()+'.tmp';
    try{
      // Exclusive publication never follows an existing file or link.
      await fs.writeFile(temporary,encoded,{flag:'wx',mode:0o600});
      try{await fs.link(temporary,file);}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        const existing=await fs.lstat(file);
        if(!existing.isFile()||existing.isSymbolicLink()||sha(await fs.readFile(file))!==digest)throw fail('EVIDENCE_SOURCE_CHANGED','A saved evidence artifact has different bytes. Existing evidence was not overwritten.');
      }
    }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
    const entry={ref,file,sha256:digest,kind,metadata:structuredClone(metadata),characters:encoded.length};
    resources.set(ref,entry);
    const metadataFile=path.join(root,ref+'.metadata.json');
    try{await fs.writeFile(metadataFile,serial({version:1,...entry}),{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;}
    return descriptor(entry);
  }
  async function load(ref){
    check(signal);
    const entry=resources.get(ref);
    if(!entry)throw fail('EVIDENCE_REFERENCE_UNKNOWN','Use an exact saved evidence ref supplied in the current context. File paths and unobserved references are not accepted.');
    await ordinaryAncestors(root);
    const before=await fs.lstat(entry.file);
    if(!before.isFile()||before.isSymbolicLink())throw fail('EVIDENCE_SOURCE_CHANGED','The saved evidence artifact is no longer an ordinary file.');
    const handle=await fs.open(entry.file,'r');
    try{
      const current=await handle.stat();
      if(current.dev!==before.dev||current.ino!==before.ino)throw fail('EVIDENCE_SOURCE_CHANGED','The saved evidence artifact changed during inspection.');
      const encoded=await handle.readFile('utf8');
      if(sha(encoded)!==entry.sha256)throw fail('EVIDENCE_SOURCE_CHANGED','The saved evidence bytes changed; do not treat this artifact as the original receipt.');
      return {entry,encoded,value:JSON.parse(encoded)};
    }finally{await handle.close();}
  }
  async function project(value,{sourceFile}={}){
    const mediaRefs=[],duplicateRefs=[],results=new Map();
    async function walk(item,pointer=''){
      check(signal);
      if(Array.isArray(item)){const next=[];for(let index=0;index<item.length;index++)next.push(await walk(item[index],pointer+'/'+index));return next;}
      if(!plain(item))return item;
      if(item.type==='inputImage'&&typeof item.imageUrl==='string'&&/^data:image\//i.test(item.imageUrl)){
        const saved=await save(item,{kind:'media',sourceFile,sourcePointer:pointer});
        const media={...saved,sourcePointer:pointer,mediaType:item.imageUrl.slice(5,item.imageUrl.indexOf(';'))};mediaRefs.push(media);
        return {type:'savedImage',source:'host-saved-data',...media,
          meaning:'Exact image bytes are saved. Their pixels have not been described by this projection; read this ref to inspect the actual image.'};
      }
      const isReceipt=item.source==='host-dispatch-receipt'&&Object.hasOwn(item,'result');
      let duplicate;
      if(isReceipt){
        const key=sha(serial(item.result)),prior=results.get(key);
        if(prior){
          prior.saved||=await save(prior.value,{kind:'tool-result',sourceFile,sourcePointer:prior.pointer});
          duplicate={...prior.saved,sourcePointer:pointer+'/result',firstSourcePointer:prior.pointer};duplicateRefs.push(duplicate);
        }else results.set(key,{value:item.result,pointer:pointer+'/result'});
      }
      const pairs=[];
      for(const [key,child]of Object.entries(item))pairs.push([key,isReceipt&&key==='result'&&duplicate
        ?{source:'host-saved-data',...duplicate,meaning:'These result bytes exactly match an earlier result. This occurrence retains its own operation identity and status; identical bytes do not mean one operation or prove a business outcome.'}
        :await walk(child,pointer+'/'+pointerPart(key))]);
      return Object.fromEntries(pairs);
    }
    return {value:await walk(value),mediaRefs,duplicateRefs};
  }
  const tool={type:'function',name:'relay_directory_context',description:'Read exact saved evidence by a host-supplied ref. Text is returned in complete contiguous pages with nextOffset; image refs return the original image. Sources remain attributed data. This tool cannot act on files, browsers or external services.',inputSchema:{type:'object',additionalProperties:false,required:['action','ref'],properties:{action:{type:'string',enum:['read']},ref:{type:'string'},offset:{type:'integer',minimum:0,description:'UTF-16 source offset from the preceding page receipt.'},limit:{type:'integer',minimum:1,description:'Optional maximum characters to request; context capacity may return a smaller complete page.'}}}};
  async function handle(args,{tokenBudget}={}){
    try{
      check(signal);
      if(!plain(args)||args.action!=='read'||typeof args.ref!=='string'||Object.keys(args).some(key=>!['action','ref','offset','limit'].includes(key)))throw fail('EVIDENCE_READ_INVALID','Use read with one exact observed ref and optional offset/limit.');
      if(!(tokenBudget===Infinity||Number.isSafeInteger(tokenBudget)&&tokenBudget>0))throw fail('EVIDENCE_CAPACITY_INVALID','An explicit positive remaining model context capacity is required.');
      const {entry,encoded,value}=await load(args.ref);
      if(entry.kind==='media'&&value?.type==='inputImage'){
        if(args.offset!==undefined||args.limit!==undefined)throw fail('EVIDENCE_READ_INVALID','Image refs are inspected as images, without text offsets.');
        const response={success:true,contentItems:[{type:'inputText',text:serial({...descriptor(entry),source:'saved-original-media',verified:false})},{type:'inputImage',imageUrl:value.imageUrl}]};
        if(estimateContextTokens(response)>tokenBudget)throw fail('EVIDENCE_CONTEXT_CAPACITY','The current context has no room for this image. Inspect it in a fresh read-only phase.');
        return response;
      }
      const source=typeof value==='string'?value:encoded,offset=args.offset??0,limit=args.limit??source.length;
      if(!Number.isSafeInteger(offset)||offset<0||offset>source.length||separatesPair(source,offset)||!Number.isSafeInteger(limit)||limit<0||args.limit===0)throw fail('EVIDENCE_READ_INVALID','Use a valid complete-character source range.');
      let end=Math.min(source.length,offset+limit);if(separatesPair(source,end))end--;
      const page=last=>({ref:entry.ref,sha256:entry.sha256,kind:entry.kind,encoding:typeof value==='string'?'text':'json',offset,end:last,total:source.length,nextOffset:last<source.length?last:null,complete:offset===0&&last===source.length,text:source.slice(offset,last)});
      const receipt=last=>({success:true,contentItems:[{type:'inputText',text:serial(page(last))}]});
      if(estimateContextTokens(receipt(end))>tokenBudget){
        end=offset+await fittingPrefix(source.slice(offset,end),part=>estimateContextTokens(receipt(offset+part.length))<=tokenBudget,signal);
        if(estimateContextTokens(receipt(end))>tokenBudget)throw fail('EVIDENCE_CONTEXT_CAPACITY','The current context has no room for the saved-source page metadata.');
      }
      if(end===offset&&offset<source.length)throw fail('EVIDENCE_CONTEXT_CAPACITY','The requested range or current context has no room for the next complete source character.');
      return receipt(end);
    }catch(error){
      if(signal?.aborted)throw error;
      return {success:false,code:error.code||'EVIDENCE_READ_FAILED',contentItems:[{type:'inputText',text:serial({code:error.code||'EVIDENCE_READ_FAILED',message:error.message})}]};
    }
  }
  return {save,project,tool,handle,get hasResources(){return resources.size>0;}};
}
