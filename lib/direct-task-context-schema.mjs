// One explicit context field is retained in request identity and stripped before adapters.
export const supportsTaskContext = name => !['blackice_task_contract','blackice_task_context','blackice_native_task_context'].includes(name);
export function withTaskContext(spec) {
  const next=structuredClone(spec);
  next.properties={...(next.properties||{}),taskContext:{type:'string',minLength:1,maxLength:256,description:'Host-issued context for this exact task and authenticated owner. Required to opt this call into protected task execution. Never infer it from the grant or another conversation.'}};
  for(const key of ['oneOf','anyOf'])if(next[key])next[key]=next[key].map(withTaskContext);
  return next;
}
