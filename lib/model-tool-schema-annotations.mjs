/** Editable JSON Schema documentation, never a replacement for executable handler contracts.
 * A provider may consume description/title/examples/default without changing native parsing.
 * Structural fields still come from the exact selected runtime tool variant.
 */
const NODE_ANNOTATIONS=new Set(['description','title','$comment','examples','default','deprecated']);
const SCHEMA_MAPS=new Set(['properties','patternProperties','$defs','definitions','dependentSchemas']);
const SCHEMA_ARRAYS=new Set(['allOf','anyOf','oneOf','prefixItems']);
const SCHEMA_CHILDREN=new Set(['items','additionalItems','additionalProperties','unevaluatedProperties',
 'unevaluatedItems','not','if','then','else','propertyNames','contains','contentSchema']);
const poison=new Set(['__proto__','constructor','prototype']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sorted=value=>Array.isArray(value)?value.map(sorted):object(value)?
 Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
const equality=(a,b)=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
const node=value=>value===true||value===false||object(value);
const guardKeys=['type','const','enum','format','pattern'];
const annotationGuard=value=>Object.fromEntries(guardKeys.filter(key=>Object.hasOwn(value,key))
 .map(key=>[key,structuredClone(value[key])]));
const matchesGuard=(guard,candidate)=>{
 if(!guard)return true;
 for(const [key,value] of Object.entries(guard)){
  if(key==='enum'){
   if(!Array.isArray(candidate.enum)||!candidate.enum.some(item=>value.some(expected=>equality(item,expected))))return false;
  }else if(!equality(candidate[key],value))return false;
 }
 return true;
};
const walk=(schema,fn,path=[])=>{
 if(!object(schema))return;
 fn(schema,path);
 for(const [key,value] of Object.entries(schema)){
  if(SCHEMA_MAPS.has(key)&&object(value)){
   for(const [name,child] of Object.entries(value))if(node(child))walk(child,fn,[...path,key,name]);
  }else if(SCHEMA_ARRAYS.has(key)&&Array.isArray(value)){
   for(let i=0;i<value.length;i++)if(node(value[i]))walk(value[i],fn,[...path,key,i]);
  }else if(SCHEMA_CHILDREN.has(key)){
   if(node(value))walk(value,fn,[...path,key]);
   else if(Array.isArray(value))for(let i=0;i<value.length;i++)if(node(value[i]))walk(value[i],fn,[...path,key,i]);
  }else if(key==='dependencies'&&object(value)){
   for(const [name,child] of Object.entries(value))if(node(child))walk(child,fn,[...path,key,name]);
  }
 }
};
function withoutAnnotations(schema){
 if(!object(schema))return schema;
 const copy=structuredClone(schema);
 const strip=(subject)=>{
  for(const key of NODE_ANNOTATIONS)delete subject[key];
 };
 // Nodes are located in the original shape, so remove annotations by paths in reverse order.
 const paths=[];walk(schema,(_,path)=>paths.push(path));
 for(const path of paths.reverse()){
  let target=copy;for(const key of path)target=target?.[key];
  if(object(target))strip(target);
 }
 return copy;
}
const schemaIssue=message=>Object.assign(new Error(message),{code:'TOOL_SCHEMA_EXECUTION_MISMATCH',status:422});
function validPatches(patches){
 if(!Array.isArray(patches)||patches.length>2000)throw schemaIssue('Invalid model-schema documentation changes.');
 if(JSON.stringify(patches).length>100000)throw schemaIssue('Schema documentation exceeds the supported limit.');
 for(const patch of patches){
  if(!object(patch)||!Array.isArray(patch.path)||patch.path.length>64
   ||patch.path.some(key=>!(typeof key==='string'&&key.length<=120&&!poison.has(key)
    ||Number.isSafeInteger(key)&&key>=0&&key<100000))
   ||!NODE_ANNOTATIONS.has(patch.key)||typeof patch.remove!=='boolean'
   ||patch.remove===true&&Object.hasOwn(patch,'value')
   ||patch.remove===false&&!Object.hasOwn(patch,'value')
   ||Object.keys(patch).some(key=>!['path','key','remove','value','guard'].includes(key))
   ||patch.guard!==undefined&&(!object(patch.guard)||Object.keys(patch.guard).some(key=>!guardKeys.includes(key))
     ||JSON.stringify(patch.guard).length>3000
      ||patch.guard.enum!==undefined&&!Array.isArray(patch.guard.enum)))
   throw schemaIssue('Invalid model-schema annotation record.');
  if(!patch.remove){
   if(['title','description','$comment'].includes(patch.key)&&typeof patch.value!=='string')
    throw schemaIssue('Schema title/description/comment must be text.');
   if(patch.key==='examples'&&!Array.isArray(patch.value))
    throw schemaIssue('Schema examples must be an array.');
   if(patch.key==='deprecated'&&typeof patch.value!=='boolean')
    throw schemaIssue('Schema deprecated must be Boolean.');
   try{
    const value=JSON.stringify(patch.value);
    if(value===undefined||value.length>24000||value.includes('\\u0000'))
     throw schemaIssue('Model-schema annotation value is invalid or too long.');
   }catch(error){if(error.code==='TOOL_SCHEMA_EXECUTION_MISMATCH')throw error;
    throw schemaIssue('Model-schema annotation must be JSON.');}
  }
 }
 return patches;
}
export function toolSchemaStructureMatches(canonical,edited){
 return object(canonical)&&object(edited)&&equality(withoutAnnotations(canonical),withoutAnnotations(edited));
}
/** Build a path-indexed documentation delta without copying the host's action/field schema. */
export function toolSchemaAnnotationDelta(canonical,edited){
 if(!toolSchemaStructureMatches(canonical,edited))
  throw schemaIssue('Model-facing input schema changes executable field rules. Edit the native tool handler and its schema together; Runtime can directly edit descriptions, titles, examples and defaults.');
 const patches=[];
 walk(canonical,(base,path)=>{
  let target=edited;for(const key of path)target=target?.[key];
  if(!object(target))return;
  for(const key of NODE_ANNOTATIONS){
   const before=Object.hasOwn(base,key),after=Object.hasOwn(target,key);
   if(before===after&&(!before||equality(base[key],target[key])))continue;
   patches.push({path,key,remove:!after,guard:annotationGuard(base),
     ...(after?{value:structuredClone(target[key])}:{})});
  }
 });
 return validPatches(patches);
}
export function validateToolSchemaAnnotations(patches){return validPatches(patches);}
export function applyToolSchemaAnnotations(schema,patches){
 if(!object(schema)||!Array.isArray(patches)||!patches.length)return schema;
 validPatches(patches);
 const clone=structuredClone(schema);
 for(const patch of patches){
  let target=clone;for(const part of patch.path)target=target?.[part];
  if(!object(target)||!matchesGuard(patch.guard,target))continue; // Don't attach old text to a different action after reordering.
  if(patch.remove)delete target[patch.key];
  else target[patch.key]=structuredClone(patch.value);
 }
 return clone;
}
