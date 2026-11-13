const fail=message=>{throw Object.assign(Error(message),{status:400,code:'VISUAL_INVALID'});};
export const VISUAL_COLLECTIONS=['items','links','groups','notes','regions'];
const safeId=id=>typeof id==='string'&&/^[A-Za-z][\w-]{0,39}$/.test(id);

/** Document edits are atomic, revision-guarded by the store, and never execute code. */
export function applyVisualEdits(document,operations){
 if(!Array.isArray(operations)||!operations.length||operations.length>80)fail('Use 1–80 visual edit operations.');
 const next=structuredClone(document);
 for(const operation of operations){
  if(!operation||Object.keys(operation).some(k=>!['op','collection','id','value','row','column'].includes(k)))fail('Unsupported edit fields.');
  const {op,collection,id,value}=operation;
  if(op==='set_document'){
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['title','summary','layout','width','height'].includes(k)))fail('Set document title, summary or layout only.');
   Object.assign(next,value);continue;
  }
  if(op==='set_cell'){
   const {row,column}=operation;if(!Number.isInteger(row)||row<0||!Number.isInteger(column)||column<0||!next.grid?.rows[row]||column>=next.grid.columns.length||typeof value!=='string')fail('Choose an existing grid cell.');next.grid.rows[row][column]=value;continue;
  }
  if(!VISUAL_COLLECTIONS.includes(collection)||!safeId(id))fail('Choose an object collection and stable ID.');
  const objects=next[collection]??=[];if(!Array.isArray(objects))fail('Invalid object collection.');const index=objects.findIndex(object=>object.id===id);
  if(op==='remove'){if(index<0)fail('Object not found.');objects.splice(index,1);continue;}
  if(!['add','update'].includes(op)||!value||typeof value!=='object'||Array.isArray(value)||Object.hasOwn(value,'id')||Object.keys(value).some(k=>['__proto__','constructor','prototype'].includes(k)))fail('Use add/update with object fields; IDs cannot be overwritten.');
  if(op==='add'){if(index>=0)fail('Object already exists.');objects.push({...value,id});}
  else{if(index<0)fail('Object not found.');Object.assign(objects[index],value);}
 }
 return next;
}

/** Field-level deltas retain the old and new meaning, separate from actor metadata. */
export function visualChanges(before,after){
 const changes=[];
 for(const key of ['version','title','summary','kind','layout','width','height','grid','svg'])if(JSON.stringify(before?.[key])!==JSON.stringify(after?.[key]))changes.push({field:key,before:before?.[key]??null,after:after?.[key]??null});
 for(const collection of VISUAL_COLLECTIONS){
  const old=new Map((before?.[collection]||[]).map((v,i)=>[v.id||`index:${i}`,v])),current=new Map((after?.[collection]||[]).map((v,i)=>[v.id||`index:${i}`,v]));
  for(const id of new Set([...old.keys(),...current.keys()])){
   const a=old.get(id),b=current.get(id);if(!a||!b){changes.push({collection,id,before:a??null,after:b??null});continue;}
   for(const field of new Set([...Object.keys(a),...Object.keys(b)]))if(JSON.stringify(a[field])!==JSON.stringify(b[field]))changes.push({collection,id,field,before:a[field]??null,after:b[field]??null});
  }
 }
 return changes;
}

export function visualPatch(before,after){
 const changes=visualChanges(before,after),operations=[];
 for(const change of changes){
  if(!change.collection){
   if(['title','summary','width','height','layout'].includes(change.field)){if(change.after===null)return null;operations.push({op:'set_document',value:{[change.field]:change.after}});}
   else if(change.field==='grid'&&before.grid&&after.grid&&JSON.stringify(before.grid.columns)===JSON.stringify(after.grid.columns)&&before.grid.rows.length===after.grid.rows.length&&before.grid.x===after.grid.x&&before.grid.y===after.grid.y){for(let row=0;row<after.grid.rows.length;row++)for(let column=0;column<after.grid.columns.length;column++)if(before.grid.rows[row][column]!==after.grid.rows[row][column])operations.push({op:'set_cell',row,column,value:after.grid.rows[row][column]});}
   else return null;
  }else{
   if(!safeId(change.id))return null;
   if(change.field){if(change.after===null)return null;operations.push({op:'update',collection:change.collection,id:change.id,value:{[change.field]:change.after}});}
   else if(change.after===null)operations.push({op:'remove',collection:change.collection,id:change.id});
   else{const {id,...value}=change.after;operations.push({op:'add',collection:change.collection,id,value});}
  }
 }
 return operations.length<=80?operations:null;
}
