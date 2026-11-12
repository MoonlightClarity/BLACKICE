/** Compact discovery only. Admission always uses the original canonical schema. */
export function planningConnectorSchema(name,schema){
 if(name!=='blackice_planning_graph_write')return schema;
 const properties=structuredClone(schema.properties);
 for(const [key,spec]of Object.entries(properties)){
  if(key==='values'||JSON.stringify(spec).length<=1600)continue;
  if(!['object','array'].includes(spec.type))continue;
  properties[key]={type:spec.type,...(spec.type==='array'?{items:{type:'object',additionalProperties:true}}:{additionalProperties:true}),
   description:'Structured '+key+'. Before authoring, read blackice_planning_graph_read with action schema, writeAction record_response, field '+key+' and a fresh requestId. The exact canonical schema is enforced.'};
 }
 properties.action.description='Use action, not operation. Every call needs requestId. record_response requires graphRequestId, nodeId, expectedNodeRevision and values. Use graph_read action schema for exact per-action requirements.';
 return {type:'object',properties,required:['requestId','action'],additionalProperties:false,
  description:'Compact discovery projection; canonical action-specific validation is unchanged. Read exact action schema through blackice_planning_graph_read action schema.'};
}
/** Field names only: never echo rejected values, identifiers or unknown keys. */
export function planningArgumentDiagnostic(name,args,schema,valid){
 if(!['blackice_planning_graph_read','blackice_planning_graph_write'].includes(name))return '';
 const value=args&&typeof args==='object'&&!Array.isArray(args)?args:{};
 const variant=schema.oneOf?.find(row=>row.properties.action.const===value.action);
 const spec=variant||schema,parts=[];
 const missing=(spec.required||[]).filter(key=>!Object.hasOwn(value,key));
 if(missing.length)parts.push('Missing required fields: '+missing.join(', ')+'.');
 if(Object.keys(value).some(key=>!Object.hasOwn(spec.properties||{},key)))parts.push('Unexpected fields are present; use only the declared fields for this action.');
 const bad=Object.keys(spec.properties||{}).filter(key=>Object.hasOwn(value,key)&&!valid(value[key],spec.properties[key]));
 if(bad.length)parts.push('Invalid fields: '+bad.slice(0,8).join(', ')+'.');
 if(Object.hasOwn(value,'operation'))parts.push('Use action, not operation.');
 if(Object.hasOwn(value,'response'))parts.push('Put module response text fields under values, not response.');
 parts.push('Inspect blackice_planning_graph_read with requestId, action:"schema", writeAction:"record_response" (or the intended write action); optional field selects one exact field schema.');
 return ' '+parts.join(' ');
}
