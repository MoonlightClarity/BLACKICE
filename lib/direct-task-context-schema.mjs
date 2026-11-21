// One explicit context field is retained in request identity and stripped before adapters.
export const supportsTaskContext = name => !['blackice_task_contract','blackice_task_context','blackice_native_task_context'].includes(name);
export function withTaskContext(spec) {
  const next=structuredClone(spec);
  next.properties={...(next.properties||{}),taskContext:{type:'string',minLength:1,maxLength:256,description:"Optional taskContext returned by blackice_task_context issue for this task. Browser calls retain it as metadata; non-browser adapters can use it for task-scoped execution. Omit when no context was issued."}};
  for(const key of ['oneOf','anyOf'])if(next[key])next[key]=next[key].map(withTaskContext);
  return next;
}
