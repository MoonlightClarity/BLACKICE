import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const fail=(message,status=400)=>Object.assign(new Error(message),{status,code:status===409?'EXECUTION_LAYER_CONFLICT':'EXECUTION_LAYER_INVALID'});
const nameValid=id=>typeof id==='string'&&/^[a-z][a-z0-9_-]{1,99}$/.test(id);
// Old receipt identifiers cannot become independent instruction overrides.
const receiptOnlyId=id=>typeof id==='string'&&(/^(?:skill-|loaded-skill-|inherited-skill-|runtime-)/.test(id)||['task-method-discovery','task-file-routing','response-only-contract','workflow-instructions'].includes(id));
const textValid=text=>typeof text==='string'&&text.length<=24000&&!text.includes('\0');
const labelValid=(value,max=300)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!value.includes('\0');
const roleValid=value=>value==='developer'||value==='prompt';
const orderValid=value=>Number.isSafeInteger(value)&&value>=-10000&&value<=10000;
const blank=()=>({version:1,revision:0,overrides:{},custom:[]});
function validate(state){
 if(!state||state.version!==1||!Number.isSafeInteger(state.revision)||state.revision<0
  ||!state.overrides||typeof state.overrides!=='object'||Array.isArray(state.overrides)
  ||!Array.isArray(state.custom)||state.custom.length>80||Object.keys(state.overrides).length>250)
  throw fail('Invalid execution-layer configuration.',503);
 for(const [id,row] of Object.entries(state.overrides)){
  if(!nameValid(id)||!row||typeof row!=='object'||Array.isArray(row)
   ||row.enabled!==undefined&&typeof row.enabled!=='boolean'
   ||row.text!==undefined&&!textValid(row.text)
   ||row.role!==undefined&&!roleValid(row.role)
   ||row.title!==undefined&&!labelValid(row.title,120)
   ||row.source!==undefined&&!labelValid(row.source,300)
   ||row.sourceLabel!==undefined&&!labelValid(row.sourceLabel,300)
   ||row.description!==undefined&&(typeof row.description!=='string'||row.description.length>1200)
   ||row.order!==undefined&&!orderValid(row.order))
    throw fail('Invalid execution-layer override: '+id,503);
 }
 const ids=new Set();
 for(const row of state.custom){
  if(!nameValid(row.id)||!row.id.startsWith('custom-')||ids.has(row.id)
    ||!labelValid(row.title,120)||!roleValid(row.role)||!textValid(row.text)||!row.text.trim()
    ||row.enabled!==undefined&&typeof row.enabled!=='boolean'
    ||row.sourceLabel!==undefined&&!labelValid(row.sourceLabel,300)
    ||row.description!==undefined&&(typeof row.description!=='string'||row.description.length>1200)
    ||row.order!==undefined&&!orderValid(row.order))
    throw fail('Invalid custom execution layer.',503);
  ids.add(row.id);
 }
 return state;
}
const byOrder=(a,b)=>(a.order??0)-(b.order??0)||String(a.id).localeCompare(String(b.id));
/** Editable model instruction layers. Never modify historical snapshots, tool schemas or host admission gates. */
export class ExecutionLayerOverrides{
 constructor({dataDir}={}){
  if(typeof dataDir!=='string'||!dataDir)throw new TypeError('Execution layers need a data directory.');
  this.file=path.join(dataDir,'execution-layers.json');
  this.state=blank();this.ready=false;this.queue=Promise.resolve();
 }
 async init(){
  if(this.ready)return this;
  try{this.state=validate(JSON.parse(await fs.readFile(this.file,'utf8')));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  this.ready=true;return this;
 }
 get revision(){return this.state.revision;}
 metadata(id){
  if(receiptOnlyId(id))return {};
  const item=this.state.custom.find(row=>row.id===id)||this.state.overrides[id];
  return item?{title:item.title,sourceLabel:item.sourceLabel,description:item.description}:{};
 }
 project(id,text,role='developer'){
  if(receiptOnlyId(id))return {enabled:true,text,mode:'default',role,order:0};
  const custom=this.state.custom.find(row=>row.id===id);
  const row=custom||this.state.overrides[id];
  if(row?.enabled===false)return{enabled:false,text:'',mode:'disabled',role:row.role??role,order:row.order??0};
  if(custom)return{enabled:true,text:custom.text,mode:'custom',role:custom.role,order:custom.order??0};
  if(row&&typeof row.text==='string')
   return{enabled:true,text:row.text,mode:'replacement',role:row.role??role,order:row.order??0};
  return{enabled:true,text,mode:'default',role:row?.role??role,order:row?.order??0};
 }
 additions(role){
  return this.state.custom.filter(row=>row.role===role&&row.enabled!==false)
   .map(row=>({...row,source:row.sourceLabel??'Owner-added execution layer'})).sort(byOrder);
 }
 list(definitions=[]){
  const visible=new Map();
  let i=0;
  for(const entry of definitions){
   if(!nameValid(entry.id)||receiptOnlyId(entry.id)||typeof entry.text!=='string'||!roleValid(entry.role)||visible.has(entry.id))continue;
   const override=this.state.overrides[entry.id];
   const applied=this.project(entry.id,entry.text,entry.role);
   visible.set(entry.id,{
    id:entry.id,sourceRevision:entry.sourceRevision,sourceHash:entry.sourceHash,title:override?.title??entry.title??entry.id,
    description:override?.description??'',source:override?.sourceLabel??entry.source??'runtime',origin:entry.source??'runtime',
    role:applied.role,defaultRole:entry.role,defaultTitle:entry.title??entry.id,
    defaultText:entry.text,text:applied.text,
    ...(applied.enabled?{}:{inactiveText:typeof override?.text==='string'?override.text:entry.text}),
    mode:applied.mode,enabled:applied.enabled,
    order:override?.order??i,custom:false,unobserved:false,
    overridden:!!override,hasCurrentSource:typeof entry.text==='string'
   });
   i++;
  }
  // Unregistered legacy overrides are not active catalog rows. Preserve their
  // bytes for owner recovery; only reset/delete may remove one explicitly.
  for(const custom of this.state.custom)
   visible.set(custom.id,{
    ...custom,description:custom.description??'',defaultText:null,defaultRole:custom.role,
    defaultTitle:custom.title,mode:custom.enabled===false?'disabled':'custom',
    enabled:custom.enabled!==false,order:custom.order??i++,custom:true,
    overridden:true,unobserved:false,source:custom.sourceLabel??'Owner-added execution layer',hasCurrentSource:true
   });
  return{version:1,revision:this.revision,layers:[...visible.values()].sort(byOrder)};
 }
 async save(value,definitions=[]){
  if(!this.ready)await this.init();
  const work=async()=>{
   if(!value||typeof value!=='object'||Array.isArray(value)
    ||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision!==this.revision)
    throw fail('Execution layers changed. Reload the current revision before saving.',409);
   const {action,id}=value;
   if(!['replace','disable','enable','reset','add','create','delete','update'].includes(action))
    throw fail('Unsupported execution-layer edit.');
   const next=structuredClone(this.state);
   const known=receiptOnlyId(id)?undefined:definitions.find(row=>row.id===id);
   const index=next.custom.findIndex(row=>row.id===id);
   let affected=id;
   const checkEditable=(form,{creating=false}={})=>{
    const allowed=creating?['title','description','role','text','enabled','order','sourceLabel']:['title','description','role','text','enabled','order','sourceLabel'];
    if(!form||typeof form!=='object'||Object.keys(form).some(key=>!allowed.includes(key)))
     throw fail('Use editable instruction fields only.');
    if(form.title!==undefined&&!labelValid(form.title,120))throw fail('Title must contain 1–120 characters.');
    if(form.sourceLabel!==undefined&&!labelValid(form.sourceLabel,300))throw fail('Source label must contain 1–300 characters.');
    if(form.description!==undefined&&(typeof form.description!=='string'||form.description.length>1200))
     throw fail('Description must contain at most 1200 characters.');
    if(form.role!==undefined&&!roleValid(form.role))throw fail('Role must be developer or prompt.');
    if(form.text!==undefined&&(!textValid(form.text)||!form.text.trim()))throw fail('Instruction text must contain 1–24000 characters.');
    if(form.enabled!==undefined&&typeof form.enabled!=='boolean')throw fail('Enabled must be Boolean.');
    if(form.order!==undefined&&!orderValid(form.order))throw fail('Order must be an integer from -10000 to 10000.');
   };
   if(action==='add'||action==='create'){
    const row={title:value.title,role:value.role,text:value.text,
     description:value.description??'',sourceLabel:value.sourceLabel??'Owner-added execution layer',enabled:value.enabled!==false,
     order:value.order??(definitions.length+next.custom.length)};
    checkEditable(row,{creating:true});
    if(!labelValid(row.title,120)||!roleValid(row.role)||!textValid(row.text)||!row.text.trim())
     throw fail('A custom layer requires title, role and instruction text.');
    affected='custom-'+randomUUID().replaceAll('-','');
    next.custom.push({id:affected,...row});
   }else if(index>=0){
    const row=next.custom[index];
    if(action==='delete')next.custom.splice(index,1);
    else if(action==='replace'){checkEditable({text:value.text});row.text=value.text;}
    else if(action==='update'){
     const changes=value.fields??{};
     checkEditable(changes);
     Object.assign(row,changes);
    }else if(action==='disable')row.enabled=false;
    else if(action==='enable')row.enabled=true;
    else throw fail('Custom layers support editing, enabling and deleting, not built-in restoration.');
   }else{
    if(!nameValid(id)||!known&&!Object.hasOwn(next.overrides,id))
     throw fail('Unknown live runtime layer. Historical receipts are read-only.',404);
    if(!known){
     if(action!=='reset'&&action!=='delete')throw fail('This historical layer is retired. Reset or delete its obsolete override.',404);
     delete next.overrides[id];
    }
    else if(action==='reset'){delete next.overrides[id];}
    else {
     const origin=known?{title:String(known.title??id).slice(0,120),
      source:String(known.source??'runtime').slice(0,300),role:known.role}:{};
     const row={...origin,...next.overrides[id]};
     if(action==='replace'){checkEditable({text:value.text});row.text=value.text;row.enabled=true;}
     if(action==='update'){const changes=value.fields??{};checkEditable(changes);Object.assign(row,changes);}
     if(action==='disable'||action==='delete')row.enabled=false;
     if(action==='enable')row.enabled=true;
     next.overrides[id]=row;
    }
   }
   next.revision++;
   validate(next);
   const tmp=this.file+'.'+randomUUID()+'.tmp';
   await fs.mkdir(path.dirname(this.file),{recursive:true});
   try{await fs.writeFile(tmp,JSON.stringify(next,null,2)+'\n',{flag:'wx'});await fs.rename(tmp,this.file);}
   catch(error){await fs.rm(tmp,{force:true}).catch(()=>{});throw error;}
   this.state=next;
   return{...this.list(definitions),affected};
  };
  const result=this.queue.then(work);this.queue=result.then(()=>{},()=>{});
  return result;
 }
}
