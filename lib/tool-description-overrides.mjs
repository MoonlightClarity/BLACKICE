import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {applyToolSchemaAnnotations,toolSchemaAnnotationDelta,toolSchemaStructureMatches,validateToolSchemaAnnotations} from './model-tool-schema-annotations.mjs';

const MAX_DESCRIPTION=12000,MAX_SCHEMA=100000;
const TOOL_NAME=/^[a-z][a-z0-9_]{1,99}$/;
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const invalid=(message,status=400)=>Object.assign(new Error(message),{status,...(status===422?{code:'TOOL_SCHEMA_EXECUTION_MISMATCH'}:{})});
const safeSchema=value=>plain(value)&&value.type==='object'&&plain(value.properties)
  &&JSON.stringify(value).length<=MAX_SCHEMA
  &&!JSON.stringify(value).includes('"__proto__"');
const effectiveSchema=(tool,active)=>{
 if(!active)return tool.inputSchema;
 if(active.schemaAnnotations!==undefined)
  return applyToolSchemaAnnotations(tool.inputSchema,active.schemaAnnotations);
 if(active.inputSchema!==undefined){
  // Legacy full-schema records can change model documentation, never the native contract.
  try{return applyToolSchemaAnnotations(tool.inputSchema,toolSchemaAnnotationDelta(tool.inputSchema,active.inputSchema));}
  catch{return tool.inputSchema;}
 }
 return tool.inputSchema;
};
const normalize=value=>{
 if(typeof value==='string')return{description:value,enabled:true};
 if(!plain(value))throw invalid('Invalid saved tool record.');
 const record={};
 if(value.description!==undefined)record.description=value.description;
 if(value.enabled!==undefined)record.enabled=value.enabled;
 if(value.inputSchema!==undefined)record.inputSchema=value.inputSchema;
 if(value.schemaAnnotations!==undefined)record.schemaAnnotations=validateToolSchemaAnnotations(value.schemaAnnotations);
 if(record.description!==undefined&&(typeof record.description!=='string'||!record.description.trim()
  ||record.description.length>MAX_DESCRIPTION||record.description.includes('\0')))
  throw invalid('Invalid saved tool description.');
 if(record.enabled!==undefined&&typeof record.enabled!=='boolean')
  throw invalid('Invalid tool visibility.');
 if(record.inputSchema!==undefined&&!safeSchema(record.inputSchema))
  throw invalid('Invalid model-facing tool schema.');
 return record;
};
function validated(value){
 if(!plain(value)||value.version!==1||!Number.isSafeInteger(value.revision)
   ||value.revision<0||!plain(value.overrides))throw invalid('Invalid saved tool-definition catalog.');
 const overrides=Object.create(null);
 for(const [name,entry] of Object.entries(value.overrides)){
  if(!TOOL_NAME.test(name))throw invalid('Invalid tool name: '+name);
  overrides[name]=normalize(entry);
 }
 return{version:1,revision:value.revision,overrides};
}
/** Canonical editable model-facing definitions, not executable tool implementations. */
export class ToolDescriptionOverrides{
 constructor({dataDir}){
  if(typeof dataDir!=='string'||!dataDir)throw new TypeError('Tool definitions require a data directory.');
  this.file=path.join(dataDir,'tool-descriptions.json');
  this.state={version:1,revision:0,overrides:Object.create(null)};
  this.ready=false;this.queue=Promise.resolve();
 }
 async init(){
  if(this.ready)return this;
  let data;
  try{data=await fs.readFile(this.file,'utf8');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(data!==undefined)this.state=validated(JSON.parse(data));
  this.ready=true;return this;
 }
 get revision(){return this.state.revision;}
 isDisabled(name){return this.state.overrides[name]?.enabled===false;}
 editedDescriptionNames(){return Object.entries(this.state.overrides)
  .filter(([,entry])=>entry?.description!==undefined||entry?.schemaAnnotations?.length>0
    ||entry?.inputSchema!==undefined).map(([name])=>name);}
 project(tools){
  if(!Array.isArray(tools))return[];
  return tools.flatMap(tool=>{
   const active=this.state.overrides[tool?.name];
   if(active?.enabled===false)return[];
   if(!active||!Object.keys(active).length)return[tool];
   return[{...tool,
    ...(active.description!==undefined?{description:active.description}:{}),
    ...(active.schemaAnnotations!==undefined||active.inputSchema!==undefined
      ?{inputSchema:effectiveSchema(tool,active)}:{})}];
  });
 }
 list(definitions=[]){
  const unique=new Map();
  for(const tool of definitions){
   if(!TOOL_NAME.test(tool?.name||'')||typeof tool.description!=='string'||unique.has(tool.name))continue;
   const active=this.state.overrides[tool.name];
   unique.set(tool.name,{
    name:tool.name,defaultDescription:tool.description,description:active?.description??tool.description,
    defaultSchema:tool.inputSchema??null,inputSchema:effectiveSchema(tool,active)??null,
    overridden:!!active&&Object.keys(active).length>0,
    enabled:active?.enabled!==false,source:'Host-registered model tool',
    schemaMode:'editable-documentation',
    ...(active?.inputSchema!==undefined&&!toolSchemaStructureMatches(tool.inputSchema,active.inputSchema)
     ?{schemaWarning:'Legacy schema differs from the executable tool contract and is not applied.'}:{})
   });
  }
  return{version:1,revision:this.revision,tools:[...unique.values()].sort((a,b)=>a.name.localeCompare(b.name))};
 }
 async save({name,description,enabled,inputSchema,action,expectedRevision}={},definitions=[]){
  if(!this.ready)await this.init();
  const task=async()=>{
   const available=new Set(definitions.map(tool=>tool?.name));
   if(!TOOL_NAME.test(name||'')||!available.has(name))throw invalid('Tool is not in the model tool catalog.',404);
   if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==this.revision)
    throw invalid('Tool definitions changed. Reload before saving.',409);
   if(description===null||action==='reset'){
    const next=validated({version:1,revision:this.revision+1,
      overrides:Object.fromEntries(Object.entries(this.state.overrides).filter(([id])=>id!==name))});
    await this.persist(next);return this.list(definitions);
   }
   const updates={};
   if(description!==undefined)updates.description=description;
   if(enabled!==undefined)updates.enabled=enabled;
   if(inputSchema!==undefined){
    if(!safeSchema(inputSchema))throw invalid('Model-facing input schema must be an object with properties.',400);
    const definition=definitions.find(tool=>tool?.name===name&&toolSchemaStructureMatches(tool.inputSchema,inputSchema));
    if(!definition)throw invalid('Schema changes executable fields, action choices or validation rules. Edit the native handler and its schema together; Runtime can edit documentation fields.',422);
    updates.schemaAnnotations=toolSchemaAnnotationDelta(definition.inputSchema,inputSchema);
   }
   if(action==='disable')updates.enabled=false;
   if(action==='enable')updates.enabled=true;
   normalize(updates);
   const prior=this.state.overrides[name]||{};
   const merged={...prior,...updates};
   if(updates.schemaAnnotations!==undefined)delete merged.inputSchema;
   if(!Object.keys(updates).length||JSON.stringify(merged)===JSON.stringify(prior))return this.list(definitions);
   const next=validated({version:1,revision:this.revision+1,
     overrides:{...this.state.overrides,[name]:merged}});
   await this.persist(next);return this.list(definitions);
  };
  const result=this.queue.then(task);this.queue=result.then(()=>{},()=>{});
  return result;
 }
 async persist(next){
  const tmp=this.file+'.'+randomUUID()+'.tmp';
  await fs.mkdir(path.dirname(this.file),{recursive:true});
  try{await fs.writeFile(tmp,JSON.stringify(next,null,2)+'\n',{encoding:'utf8',flag:'wx'});
   await fs.rename(tmp,this.file);}
  catch(error){await fs.rm(tmp,{force:true}).catch(()=>{});throw error;}
  this.state=next;
 }
}
