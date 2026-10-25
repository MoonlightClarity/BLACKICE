/** Saved assignments describe work. Additional metadata from older or newer
 * clients is retained without changing execution settings or capabilities. */
export function validateWorkerAssignment(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Use a concrete worker assignment.');
  for(const field of ['scope','result','doneWhen'])
    if(typeof value[field]!=='string'||!value[field].trim()||value[field].includes('\0')||value[field].length>(field==='scope'?3000:1000))
      throw Error('Worker assignments need a bounded work scope, expected result and observable completion check.');
  if(!Array.isArray(value.inputs)||value.inputs.length>200||value.inputs.some(input=>
    typeof input!=='string'||!input.trim()||input.length>1000||input.includes('\0')))
    throw Error('Worker assignments need at most 200 nonempty inputs of 1–1,000 characters.');
  return value;
}

export function workerAssignmentDescription(assignment) {
  return Object.fromEntries(['scope','inputs','result','doneWhen']
    .filter(field=>assignment?.[field]!==undefined).map(field=>[field,assignment[field]]));
}
