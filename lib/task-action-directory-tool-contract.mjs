// Pure model-tool contract. Internal/human Directory edit and handle APIs do not use this boundary.
const own=(value,key)=>Object.hasOwn(value,key);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const equal=(left,right)=>JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=(message,code='DIRECTORY_TOOL_ARGUMENTS')=>Object.assign(new Error(message+' No changes were made.'),{code,status:409,actionDispatched:false});
const definitions=[
 {action:'read',required:[],optional:['id']},
 {action:'plan',required:['actions'],optional:['revision']},
 {action:'decompose',required:['id','actions','claim'],optional:['revision']},
 {action:'focus',required:['id'],optional:['revision']},
 {action:'refine',required:['id','claim','doneChecks'],optional:['dropCheckIds','alternatives','revision'],overrides:{dropCheckIds:{maxItems:0}}},
 {action:'refine',required:['id','claim','dropCheckIds','alternatives'],optional:['doneChecks','revision'],overrides:{dropCheckIds:{minItems:1},alternatives:{minItems:1}}},
 {action:'note',required:['id','claim','receipts'],optional:['checkResults','revision'],overrides:{receipts:{minItems:1}}},
 {action:'observe',required:['id','claim','receipts','outcome'],optional:['candidateRows','checkResults','revision'],overrides:{receipts:{minItems:1}}},
 {action:'block',required:['id','claim','blocker','receipts'],optional:['revision'],overrides:{blocker:{enum:['prerequisite-unavailable','search-limit-reached']},receipts:{minItems:1}}},
 {action:'block',required:['id','claim','blocker'],optional:['receipts','revision'],overrides:{blocker:{enum:['no-viable-route']}}},
 {action:'block',required:['id','claim','blocker'],optional:['revision'],overrides:{blocker:{enum:['unresolved-effect']}}},
];
const supported=new Set(['type','properties','additionalProperties','required','items','minItems','maxItems','uniqueItems','minLength','maxLength','minimum','maximum','pattern','enum','const','description','title','oneOf']);
function inspectSchema(schema,where){
 if(!object(schema))throw fail('Unsupported schema at '+where+'.','DIRECTORY_TOOL_SCHEMA');
 for(const key of Object.keys(schema))if(!supported.has(key))throw fail('Unsupported schema keyword '+JSON.stringify(key)+' at '+where+'.','DIRECTORY_TOOL_SCHEMA');
 if(schema.type!==undefined&&!['object','array','string','integer','boolean'].includes(schema.type))throw fail('Unsupported schema type at '+where+'.','DIRECTORY_TOOL_SCHEMA');
 if(schema.pattern!==undefined)new RegExp(schema.pattern);
 if(schema.properties)for(const [key,value]of Object.entries(schema.properties))inspectSchema(value,where+'.'+key);
 if(schema.items)inspectSchema(schema.items,where+'[]');
 if(schema.oneOf)for(const [index,value]of schema.oneOf.entries())inspectSchema(value,where+'.oneOf['+index+']');
}
function structuralIssue(value,schema,where){
 if(schema.type==='object'&&!object(value))return where+' must be an object.';
 if(schema.type==='array'&&!Array.isArray(value))return where+' must be an array.';
 if(schema.type==='string'&&typeof value!=='string')return where+' must be a string.';
 if(schema.type==='integer'&&!Number.isSafeInteger(value))return where+' must be an integer.';
 if(schema.type==='boolean'&&typeof value!=='boolean')return where+' must be a boolean.';
 if(schema.enum&&!schema.enum.some(item=>equal(item,value)))return where+' must be one of '+schema.enum.map(x=>JSON.stringify(x)).join(', ')+'.';
 if(own(schema,'const')&&!equal(schema.const,value))return where+' must be '+JSON.stringify(schema.const)+'.';
 if(typeof value==='number'){
  if(schema.minimum!==undefined&&value<schema.minimum)return where+' must be at least '+schema.minimum+'.';
  if(schema.maximum!==undefined&&value>schema.maximum)return where+' must be at most '+schema.maximum+'.';
 }
 if(typeof value==='string'){
  if(schema.minLength!==undefined&&value.length<schema.minLength)return where+' is shorter than '+schema.minLength+' characters.';
  if(schema.maxLength!==undefined&&value.length>schema.maxLength)return where+' exceeds '+schema.maxLength+' characters.';
  if(schema.pattern&&!new RegExp(schema.pattern).test(value))return where+' does not match its declared format.';
 }
 if(Array.isArray(value)){
  if(schema.minItems!==undefined&&value.length<schema.minItems)return where+' needs at least '+schema.minItems+' item(s).';
  if(schema.maxItems!==undefined&&value.length>schema.maxItems)return where+' permits at most '+schema.maxItems+' item(s).';
  if(schema.uniqueItems&&new Set(value.map(x=>JSON.stringify(canonical(x)))).size!==value.length)return where+' must not repeat items.';
  if(schema.items)for(let i=0;i<value.length;i++){const error=structuralIssue(value[i],schema.items,where+'['+i+']');if(error)return error;}
 }
 if(object(value)){
  for(const key of schema.required||[])if(!own(value,key))return where+' requires field '+JSON.stringify(key)+'.';
  const properties=schema.properties||{};
  const extra=Object.keys(value).filter(key=>!own(properties,key));
  if(schema.additionalProperties===false&&extra.length)return where+' does not accept field(s) '+extra.map(key=>JSON.stringify(key)).join(', ')+'. Allowed: '+Object.keys(properties).join(', ')+'.';
  for(const key of Object.keys(value))if(own(properties,key)){const error=structuralIssue(value[key],properties[key],where+'.'+key);if(error)return error;}
 }
 if(schema.oneOf){
  const outcomes=schema.oneOf.map(item=>structuralIssue(value,item,where)),matching=outcomes.filter(item=>item===null);
  if(matching.length!==1)return where+' must match exactly one action variant. '+outcomes.filter(Boolean).join(' ');
 }
 return null;
}

/** The existing nested schemas are copied, never mutated or frozen in their owning modules. */
export function createDirectoryToolContract(baseTool){
 if(baseTool?.name!=='relay_directory_action'||baseTool.type!=='function'||!object(baseTool.inputSchema?.properties))
  throw fail('An actual Directory tool definition is required.','DIRECTORY_TOOL_SCHEMA');
 const fields=structuredClone(baseTool.inputSchema.properties),names=[...new Set(definitions.map(row=>row.action))];
 if(!equal(fields.action?.enum,names))throw fail('The Directory action enum differs from this explicit contract.','DIRECTORY_TOOL_SCHEMA');
 const configured=new Set(['action',...definitions.flatMap(row=>[...row.required,...row.optional])]);
 if(Object.keys(fields).some(key=>!configured.has(key))||[...configured].some(key=>!own(fields,key)))
  throw fail('Directory fields differ from the configured action contract.','DIRECTORY_TOOL_SCHEMA');
 const variants=definitions.map(row=>{
  const keys=['action',...row.required,...row.optional];
  return {type:'object',additionalProperties:false,required:['action',...row.required],
   properties:Object.fromEntries(keys.map(key=>[key,key==='action'?{type:'string',const:row.action}:{...fields[key],...(row.overrides?.[key]||{})}]))};
 });
 const usage=definitions.map(row=>row.action+': '+['action',...row.required,...row.optional.map(key=>key+'?')].join(', ')).join('; ');
 const tool=freeze({...structuredClone(baseTool),
  description:baseTool.description+' Supply only fields for the selected action. Read takes action alone or an optional id to inspect one recursive subtree. Decompose takes a focused parent id, concrete child actions and the reason to split it; call decompose again on a decomposed parent to replan blocked branches. A ? marks an optional field: '+usage+'. For refine, adding checks and retiring checks are separate variants; retiring requires alternatives. unresolved-effect uses the ledger receipts, so omit receipts for that blocker. For a NEW action, a minimal valid plan is {"action":"plan","actions":[{"id":"fix","objective":"Specific work to perform","dependsOn":[]}]}. Every plan action requires id, objective and dependsOn, even when there are no dependencies. Plan is not observe: claims and verification receipts belong in observe, not in plan actions. Decompose example: {"action":"decompose","id":"repair","claim":"Separate diagnosis, implementation and verification","actions":[{"id":"diagnose","objective":"Inspect failures","dependsOn":[]},{"id":"implement","objective":"Fix the verified causes","dependsOn":["diagnose"]}]}. Recursively decompose a complex child when needed. Parents wait for child outcomes and must be explicitly synthesized, not auto-completed.',
  inputSchema:{type:'object',additionalProperties:false,required:['action'],properties:fields,oneOf:variants}});
 inspectSchema(tool.inputSchema,'relay_directory_action');
 const parseModelArguments=(args,{qualifyingAction=false}={})=>{
  if(!object(args)||!own(args,'action')||typeof args.action!=='string'||!names.includes(args.action))
   throw fail('Use an own string action: '+names.join(', ')+'.','DIRECTORY_TOOL_ACTION');
  const candidates=variants.filter(variant=>variant.properties.action.const===args.action);
  const issues=candidates.map(variant=>structuralIssue(args,variant,'Action '+args.action));
  if(issues.filter(issue=>issue===null).length!==1)
   throw fail(issues.filter(Boolean).join(' '));
  if(own(args,'candidateRows')&&!qualifyingAction)
   throw fail('Field "candidateRows" is only consumed by observe on an action with a qualifying contract.');
  return args;
 };
 return Object.freeze({tool,parseModelArguments});
}
