import fs from 'node:fs';
function edit(file,pairs){
 let source=fs.readFileSync(file,'utf8');
 for(const [from,to] of pairs){
  if(!source.includes(from))throw Error(file+' missing expected source: '+from.slice(0,100));
  // Replace the first exact preimage. Duplicate schema phrases may be present in unrelated branches.
  source=source.replace(from,()=>to);
 }
 fs.writeFileSync(file,source);
 console.log('UPDATED',file);
}
edit('lib/chat-planning-pass.mjs',[
 ["brief: 'Propose at most eight pending actions with IDs, objectives and dependencies, and identify one focus. This phase records no execution.'",
  "brief: 'Propose the pending actions needed for the task with IDs, objectives and dependencies, and identify one focus. This phase records no execution. Avoid unnecessary actions, but do not impose an arbitrary count ceiling.'"],
 ["const identifier = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);",
  "const identifier = value => typeof value==='string' && /^[A-Za-z0-9_-]+$/.test(value);"],
 ["const bounded = (value,max) => typeof value==='string' && value.trim().length>0 && value.length<=max;",
  "const bounded = value => typeof value==='string' && value.trim().length>0;"],
 ["const recordKey = /^[A-Z][A-Z0-9_]{0,79}$/;",
  "const recordKey = /^[A-Z][A-Z0-9_]*$/;"],
 ["if (!Array.isArray(values) || values.length>8 || !values.every(identifier) || new Set(values).size!==values.length)",
  "if (!Array.isArray(values) || !values.every(identifier) || new Set(values).size!==values.length)"],
 ["  if (!values.every(id=>snapshot.receipts?.some(receipt=>receipt.id===id && receipt.taskId===snapshot.taskId && receipt.state==='returned')))",
  "  const valid=new Set((snapshot.receipts||[]).filter(receipt=>receipt.taskId===snapshot.taskId&&receipt.state==='returned').map(receipt=>receipt.id));\n  if (!values.every(id=>valid.has(id)))"],
 ["if (!Array.isArray(output.actions) || !output.actions.length || output.actions.length>8)",
  "if (!Array.isArray(output.actions) || !output.actions.length)"],
 ["|| action.dependsOn.length>8 || !action.dependsOn.every(identifier)",
  "|| !action.dependsOn.every(identifier)"],
 ["    const visit=(id,ancestors)=>{\n      if (ancestors.has(id)) throw artifactError('actions.dependencyCycle');\n      const action=pending.get(id);\n      if (!action) { if (!picked(snapshot,id)) throw artifactError('actions.unknownDependency'); return; }\n      for (const dep of action.dependsOn) visit(dep,new Set([...ancestors,id]));\n    };\n    for (const id of ids) visit(id,new Set());",
  "    const degree=new Map([...pending].map(([id,action])=>[id,action.dependsOn.filter(dep=>pending.has(dep)).length]));\n    const dependents=new Map();\n    for (const [id,action]of pending)for(const dep of action.dependsOn){\n      if(!pending.has(dep)&&!picked(snapshot,dep))throw artifactError('actions.unknownDependency');\n      if(!dependents.has(dep))dependents.set(dep,[]);dependents.get(dep).push(id);\n    }\n    const queue=[...pending.keys()].filter(id=>degree.get(id)===0);let visited=0;\n    for(let i=0;i<queue.length;i++){visited++;for(const next of dependents.get(queue[i])||[])if(degree.has(next)){\n      degree.set(next,degree.get(next)-1);if(degree.get(next)===0)queue.push(next);\n    }}\n    if(visited!==pending.size)throw artifactError('actions.dependencyCycle');"],
 ["if (!Array.isArray(output.alternatives) || output.alternatives.length<2 || output.alternatives.length>4",
  "if (!Array.isArray(output.alternatives) || output.alternatives.length<2"],
 ["  const actions=Array.isArray(snapshot.actions)?snapshot.actions.slice(0,32):[];",
  "  const actions=Array.isArray(snapshot.actions)?snapshot.actions:[];"],
 ["  const receipts=Array.isArray(snapshot.receipts)?snapshot.receipts.filter(row=>row?.taskId===snapshot.taskId).slice(-32):[];",
  "  const receipts=Array.isArray(snapshot.receipts)?snapshot.receipts.filter(row=>row?.taskId===snapshot.taskId):[];"],
 ["objective:typeof snapshot.objective==='string'?snapshot.objective.slice(0,2000):''",
  "objective:typeof snapshot.objective==='string'?snapshot.objective:''"],
]);
edit('lib/chat-planning-provider.mjs',[
 ["const artifactIdentifier = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);",
  "const artifactIdentifier = value => typeof value==='string' && /^[A-Za-z0-9_-]+$/.test(value);"],
 ["const identifierSchema = () => ({type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$',minLength:1,maxLength:100});",
  "const identifierSchema = () => ({type:'string',pattern:'^[A-Za-z0-9_-]+$',minLength:1});"],
 ["const reason={type:'string',minLength:1,maxLength:500};",
  "const reason={type:'string',minLength:1};"],
 ["interpretation:{type:'string',minLength:1,maxLength:800}",
  "interpretation:{type:'string',minLength:1}"],
 [".slice(-32).map(row=>row.id))];",".map(row=>row.id))];"],
 [".slice(0,32).filter(row=>row?.state==='pending'",".filter(row=>row?.state==='pending'"],
 ["maxItems:Math.min(8,receiptIds.length),uniqueItems:true",
  "maxItems:receiptIds.length,uniqueItems:true"],
 ["objective:{type:'string',minLength:1,maxLength:300}",
  "objective:{type:'string',minLength:1}"],
 ["dependsOn:{type:'array',items:identifierSchema(),maxItems:8,uniqueItems:true}",
  "dependsOn:{type:'array',items:identifierSchema(),uniqueItems:true}"],
 ["proposed.actions={...actions,minItems:1,maxItems:8};",
  "proposed.actions={...actions,minItems:1};"],
 ["proposed.alternatives={...alternatives,minItems:2,maxItems:Math.min(4,pendingIds.length)};",
  "proposed.alternatives={...alternatives,minItems:2,maxItems:pendingIds.length};"],
]);
