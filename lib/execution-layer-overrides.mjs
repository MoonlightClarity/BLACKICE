import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const fail=(message,status=400)=>Object.assign(new Error(message),{status,code:status===409?'EXECUTION_LAYER_CONFLICT':'EXECUTION_LAYER_INVALID'});
const nameValid=id=>typeof id==='string'&&/^[a-z][a-z0-9_-]{1,99}$/.test(id);
const textValid=text=>typeof text==='string'&&text.length<=24000&&!text.includes('\\0');
const blank=()=>({version:1,revision:0,overrides:{},custom:[]});
function validate(state){
 if(!state||state.version!==1||!Number.isSafeInteger(state.revision)||state.revision<0
  ||!state.overrides||typeof state.overrides!=='object'||Array.isArray(state.overrides)
  ||!Array.isArray(state.custom)||state.custom.length>80||Object.keys(state.overrides).length>250)
  throw fail('Invalid execution-layer configuration.',503);
 for(const [id,row] of Object.entries(state.overrides))
  if(!nameValid(id)||!row||typeof row!=='object'||typeof row.enabled!=='boolean'
     ||row.text!==undefined&&!textValid(row.text)
     ||row.role!==undefined&&!['developer','prompt'].includes(row.role)
     ||row.title!==undefined&&(typeof row.title!=='string'||row.title.length>120)
     ||row.source!==undefined&&(typeof row.source!=='string'||row.source.length>300))throw fail('Invalid execution-layer override: '+id,503);
 const ids=new Set();
 for(const row of state.custom){
  if(!nameValid(row.id)||!row.id.startsWith('custom-')||ids.has(row.id)
    ||typeof row.title!=='string'||!row.title.trim()||row.title.length>120
    ||!['developer','prompt'].includes(row.role)||!textValid(row.text)||!row.text.trim())
    throw fail('Invalid custom execution layer.',503);
  ids.add(row.id);
 }
 return state;
}
/** Owner-editable model guidance, separate from noneditable host admission/enforcement. */
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
 project(id,text){
  const override=this.state.overrides[id];
  if(override?.enabled===false)return{enabled:false,text:'',mode:'disabled'};
  if(override&&typeof override.text==='string')return{enabled:true,text:override.text,mode:'replacement'};
  return{enabled:true,text,mode:'default'};
 }
 additions(role){return this.state.custom.filter(row=>row.role===role).map(row=>({...row,source:'Owner-added execution layer'}));}
 list(definitions=[]){
  const visible=new Map();
  for(const entry of definitions){
   if(!nameValid(entry.id)||typeof entry.text!=='string'||!['developer','prompt'].includes(entry.role)
      ||visible.has(entry.id))continue;
   const applied=this.project(entry.id,entry.text);
   visible.set(entry.id,{id:entry.id,title:String(entry.title||entry.id),source:String(entry.source||'runtime'),
     role:entry.role,defaultText:entry.text,text:applied.text,mode:applied.mode,enabled:applied.enabled,custom:false});
  }
  for(const [id,override] of Object.entries(this.state.overrides))
   if(!visible.has(id))visible.set(id,{id,title:override.title||id,source:override.source||'Previous observed runtime layer',role:override.role||'prompt',defaultText:null,
     text:override.enabled===false?'':override.text??'',mode:override.enabled===false?'disabled':'replacement',enabled:override.enabled,custom:false,unobserved:true});
  for(const custom of this.state.custom)
   visible.set(custom.id,{...custom,defaultText:null,mode:'custom',enabled:true,custom:true,source:'Owner-added execution layer'});
  return{version:1,revision:this.revision,layers:[...visible.values()]};
 }
 async save(value,definitions=[]){
  if(!this.ready)await this.init();
  const work=async()=>{
   if(!value||typeof value!=='object'||Array.isArray(value)
     ||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision!==this.revision)
    throw fail('Execution layers changed. Reload the current revision before saving.',409);
   const {action,id}=value;
   if(!['replace','disable','reset','add','delete'].includes(action))throw fail('Unsupported execution-layer edit.');
   const known=new Set(definitions.map(row=>row.id));
   const next=structuredClone(this.state);
   let affected=id;
   if(action==='add'){
    if(!['developer','prompt'].includes(value.role)||!textValid(value.text)||!value.text.trim()
      ||typeof value.title!=='string'||!value.title.trim()||value.title.length>120)
     throw fail('Add a title, target role and nonempty instruction text.');
    affected='custom-'+randomUUID().replaceAll('-','');
    next.custom.push({id:affected,title:value.title.trim(),role:value.role,text:value.text});
   }else if(next.custom.some(row=>row.id===id)){
    const position=next.custom.findIndex(row=>row.id===id);
    if(action==='delete')next.custom.splice(position,1);
    else if(action==='replace'){
     if(!textValid(value.text)||!value.text.trim())throw fail('Supply nonempty layer text.');
     next.custom[position].text=value.text;
    }else throw fail('Custom layers support replace and delete only.');
   }else{
    if(!nameValid(id)||!known.has(id)&&!Object.hasOwn(next.overrides,id))throw fail('Unknown layer. Inspect an execution before editing it.',404);
    const origin=definitions.find(layer=>layer.id===id);
    const metadata=origin?{title:String(origin.title||id).slice(0,120),source:String(origin.source||'runtime').slice(0,300),role:origin.role}:{};
    if(action==='replace'){
     if(!textValid(value.text)||!value.text.trim())throw fail('Supply nonempty layer text.');
     next.overrides[id]={...next.overrides[id],...metadata,enabled:true,text:value.text};
    }else if(action==='disable'||action==='delete')next.overrides[id]={...next.overrides[id],...metadata,enabled:false};
    else if(action==='reset')delete next.overrides[id];
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
