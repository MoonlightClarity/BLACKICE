import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const MAX_ITEMS=1000, MAX_DEPTH=32, MAX_BYTES=2*1024*1024, MAX_RECEIPTS=100;
const fail=(message,code='USER_TODO_INVALID',status=400)=>Object.assign(new Error(message),{code,status});
const id=value=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value))throw fail('Use a valid TODO ID.');return value;};
const title=value=>{if(typeof value!=='string'||!value.trim()||value.includes('\0')||Buffer.byteLength(value,'utf8')>1000)throw fail('Title must be nonempty text of at most 1000 UTF-8 bytes.');return value;};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const keys=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('Use only the supported TODO fields.');};
function validateMutation(value){
 const fields={create:['id','parentId','title','completed','position'],update:['id','title','completed'],move:['id','parentId','position'],remove:['id']};
 const actionFields=Object.hasOwn(fields,value?.action)?fields[value.action]:[];
 keys(value,['expectedRevision','requestId','action',...actionFields]);
 if(!Object.hasOwn(fields,value.action)||!integer(value.expectedRevision))throw fail('Choose an action and exact expectedRevision.');
 if(value.requestId!==undefined)id(value.requestId);
 if(value.action!=='create'||value.id!==undefined)id(value.id);
 if(value.action==='create'||value.title!==undefined)title(value.title);
 if(value.completed!==undefined&&typeof value.completed!=='boolean')throw fail('Completion must be true or false.');
 if(value.parentId!==undefined&&value.parentId!==null)id(value.parentId);
 if(value.position!==undefined&&!integer(value.position))throw fail('Position must be a nonnegative sibling index.');
 if(value.action==='update'&&value.title===undefined&&value.completed===undefined)throw fail('Update title or completion.');
 if(value.action==='move'&&!Object.hasOwn(value,'parentId'))throw fail('Move requires parentId (null for root).');
 return structuredClone(value);
}
function validateDocument(document){
 keys(document,['version','revision','items','receipts']);
 if(document.version!==1||!integer(document.revision)||!Array.isArray(document.items)||document.items.length>MAX_ITEMS||!Array.isArray(document.receipts)||document.receipts.length>MAX_RECEIPTS)throw fail('Invalid saved TODO document.');
 const byId=new Map();
 for(const item of document.items){
  keys(item,['id','parentId','title','completed','position']);id(item.id);title(item.title);
  if(byId.has(item.id)||typeof item.completed!=='boolean'||!integer(item.position)||item.parentId!==null&&typeof item.parentId!=='string')throw fail('Invalid saved TODO item.');
  byId.set(item.id,item);
 }
 const groups=new Map();
 for(const item of document.items){
  const seen=new Set([item.id]);let parent=item.parentId,depth=1;
  while(parent!==null){if(!byId.has(parent)||seen.has(parent))throw fail('Invalid parent or cycle in TODO hierarchy.');seen.add(parent);if(++depth>MAX_DEPTH)throw fail('TODO nesting is limited to 32 levels.');parent=byId.get(parent).parentId;}
  const group=groups.get(item.parentId)||[];group.push(item.position);groups.set(item.parentId,group);
 }
 for(const positions of groups.values())if(positions.sort((a,b)=>a-b).some((n,i)=>n!==i))throw fail('Sibling positions must be unique and contiguous.');
 const requests=new Set();
 for(const receipt of document.receipts){keys(receipt,['requestId','hash']);id(receipt.requestId);if(requests.has(receipt.requestId)||typeof receipt.hash!=='string'||!/^[a-f0-9]{64}$/.test(receipt.hash))throw fail('Invalid mutation receipt.');requests.add(receipt.requestId);}
 return document;
}
const visible=document=>{
 const items=[];const visit=parent=>{for(const item of document.items.filter(x=>x.parentId===parent).sort((a,b)=>a.position-b.position)){items.push({...item});visit(item.id);}};
 visit(null);return{revision:document.revision,items};
};
function place(items,item,parentId,position){
 const siblings=items.filter(x=>x.id!==item.id&&x.parentId===parentId).sort((a,b)=>a.position-b.position);
 const index=position===undefined?siblings.length:position;
 if(index>siblings.length)throw fail('Position exceeds the destination sibling count.');
 const oldParent=item.parentId;
 items.filter(x=>x.id!==item.id&&x.parentId===oldParent).sort((a,b)=>a.position-b.position).forEach((x,i)=>{x.position=i;});
 item.parentId=parentId;siblings.splice(index,0,item);siblings.forEach((x,i)=>{x.position=i;});
}
export class UserTodoStore {
 constructor({dataDir}){this.dataDir=dataDir;this.file=path.join(dataDir,'user-todos.json');this.lockFile=this.file+'.lock';this.tail=Promise.resolve();this.closed=false;}
 async init(){await fs.mkdir(this.dataDir,{recursive:true});await this.load();return this;}
 async load(){
  try{const handle=await fs.open(this.file,'r');try{if((await handle.stat()).size>MAX_BYTES)throw fail('TODO file exceeds 2 MiB.');return validateDocument(JSON.parse(await handle.readFile('utf8')));}finally{await handle.close();}}
  catch(error){if(error.code==='ENOENT')return{version:1,revision:0,items:[],receipts:[]};throw fail('Cannot load TODOs; existing file preserved: '+error.message,'USER_TODO_LOAD_FAILED',500);}
 }
 async snapshot(){await this.tail.catch(()=>{});return visible(await this.load());}
 apply(value,{source}={}){
  let args;try{if(source!=='human')throw fail('Only the trusted human TODO editor may change items.','USER_TODO_HUMAN_REQUIRED',403);args=validateMutation(value);}catch(error){return Promise.reject(error);}
  if(this.closed)return Promise.reject(fail('TODO store is closed.','USER_TODO_CLOSED',503));
  const pending=this.tail.catch(()=>{}).then(async()=>{
   let lock;try{lock=await fs.open(this.lockFile,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fail('Another TODO save is in progress. Reload before retrying.','USER_TODO_CONFLICT',409);throw error;}
   const temporary=this.file+'.'+randomUUID()+'.tmp';
   try{
    const doc=await this.load();
    const canonical=JSON.stringify(Object.fromEntries(Object.keys(args).filter(k=>k!=='requestId').sort().map(k=>[k,args[k]])));
    const hash=createHash('sha256').update(canonical).digest('hex');
    const receipt=args.requestId&&doc.receipts.find(x=>x.requestId===args.requestId);
    if(receipt){if(receipt.hash!==hash)throw fail('This request ID was used for different content.','USER_TODO_CONFLICT',409);return visible(doc);}
    if(args.expectedRevision!==doc.revision)throw fail('TODOs changed. Reload the current revision.','USER_TODO_CONFLICT',409);
    if(doc.revision===Number.MAX_SAFE_INTEGER)throw fail('TODO revision limit reached.');
    const item=doc.items.find(x=>x.id===args.id);
    if(args.action==='create'){
     if(item)throw fail('TODO ID already exists.','USER_TODO_CONFLICT',409);
     if(doc.items.length>=MAX_ITEMS)throw fail('At most 1000 TODO items are supported.');
     const parent=args.parentId??null;if(parent!==null&&!doc.items.some(x=>x.id===parent))throw fail('Parent TODO not found.','USER_TODO_NOT_FOUND',404);
     const created={id:args.id||randomUUID(),parentId:parent,title:args.title,completed:args.completed??false,position:0};
     doc.items.push(created);place(doc.items,created,parent,args.position);
    }else{
     if(!item)throw fail('TODO not found.','USER_TODO_NOT_FOUND',404);
     if(args.action==='update'){if(args.title!==undefined)item.title=args.title;if(args.completed!==undefined)item.completed=args.completed;}
     if(args.action==='move'){if(args.parentId!==null&&!doc.items.some(x=>x.id===args.parentId))throw fail('Parent TODO not found.','USER_TODO_NOT_FOUND',404);place(doc.items,item,args.parentId,args.position);}
     if(args.action==='remove'){
      const removed=new Set([item.id]);let changed=true;while(changed){changed=false;for(const row of doc.items)if(removed.has(row.parentId)&&!removed.has(row.id)){removed.add(row.id);changed=true;}}
      doc.items=doc.items.filter(x=>!removed.has(x.id));
      doc.items.filter(x=>x.parentId===item.parentId).sort((a,b)=>a.position-b.position).forEach((x,i)=>{x.position=i;});
     }
    }
    doc.revision++;if(args.requestId){doc.receipts.push({requestId:args.requestId,hash});doc.receipts=doc.receipts.slice(-MAX_RECEIPTS);}
    validateDocument(doc);
    const text=JSON.stringify(doc,null,2);if(Buffer.byteLength(text,'utf8')>MAX_BYTES)throw fail('TODO file exceeds 2 MiB.');
    const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
    await fs.rename(temporary,this.file);return visible(doc);
   }finally{await fs.unlink(temporary).catch(()=>{});await lock.close();await fs.unlink(this.lockFile);}
  });this.tail=pending;return pending;
 }
 async close(){this.closed=true;await this.tail.catch(()=>{});}
}
