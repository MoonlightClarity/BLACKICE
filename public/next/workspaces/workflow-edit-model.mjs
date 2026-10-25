/** Immutable, bounded edits to a saved workflow's descriptive stage fields.
 * Never rewire edges, regenerate node IDs, or drop unknown engine metadata.
 */
export const WORKFLOW_REASONING_EFFORTS = Object.freeze(['default','none','minimal','low','medium','high','xhigh','max','ultra']);
export const WORKFLOW_PLANNING_MODES = Object.freeze(['maximal','on','auto','off']);
export const WORKFLOW_PLAN_DETAILS = Object.freeze(['compact','balanced','detailed']);
const workflowReasoning=new Set(WORKFLOW_REASONING_EFFORTS);
const workflowPlanning=new Set(WORKFLOW_PLANNING_MODES);
const workflowDetails=new Set(WORKFLOW_PLAN_DETAILS);

export function applyWorkflowStageEdits(workflow, {name, nodes = {}, workflowSettings} = {}) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)
      || typeof workflow.id !== 'string'
      || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges))
    throw Error('Choose a saved workflow before editing.');
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes))
    throw Error('Stage edits must be keyed by existing node IDs.');
  const updatedName = name === undefined ? String(workflow.name || 'Untitled workflow').trim() : String(name).trim();
  if (!updatedName || updatedName.length > 160)
    throw Error('Enter a workflow name of 1–160 characters.');
  const seen = new Set();
  const changed = workflow.nodes.map(node => {
    if (!node || typeof node.id !== 'string' || seen.has(node.id))
      throw Error('The saved workflow has invalid or duplicate stage IDs.');
    seen.add(node.id);
    if (!Object.hasOwn(nodes,node.id)) return node;
    const input = nodes[node.id];
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw Error('Each stage edit must be an object.');
    const stageName = input.name === undefined ? String(node.name || node.id).trim() : String(input.name).trim();
    if (!stageName || stageName.length > 120)
      throw Error('Enter a stage name of 1–120 characters.');
    const next = { ...node, name: stageName };
    const agentFields=['prompt','model','effort','serviceTier','desktop','context','assignment'];
    if (node.type!=='agent'&&agentFields.some(field=>Object.hasOwn(input,field)))
      throw Error('Only agent stages can change instructions, model and reasoning options.');
    if (Object.hasOwn(input,'prompt')) {
      if (typeof input.prompt !== 'string' || input.prompt.length > 20000)
        throw Error('Agent instructions must be text of at most 20,000 characters.');
      next.prompt = input.prompt;
    }
    if (Object.hasOwn(input,'model')) {
      if (input.model===null)delete next.model;
      else if (typeof input.model==='string'&&input.model.trim().length>=1
        &&input.model.trim().length<=400&&!/[\r\n\0]/.test(input.model))
        next.model=input.model.trim();
      else throw Error('Enter a model identifier of 1–400 characters.');
    }
    if (Object.hasOwn(input,'effort')) {
      if (input.effort===null)delete next.effort;
      else if(workflowReasoning.has(input.effort))next.effort=input.effort;
      else throw Error('Choose a supported reasoning effort.');
    }
    if (Object.hasOwn(input,'serviceTier')) {
      if (input.serviceTier===null)delete next.serviceTier;
      else if(['default','fast'].includes(input.serviceTier))next.serviceTier=input.serviceTier;
      else throw Error('Choose Standard or Fast service tier.');
    }
    if (Object.hasOwn(input,'desktop')) {
      if (input.desktop===null)delete next.desktop;
      else if(typeof input.desktop==='boolean')next.desktop=input.desktop;
      else throw Error('Desktop access must be enabled or disabled.');
    }
    if (Object.hasOwn(input,'assignment')) {
      if(input.assignment===null)delete next.assignment;
      else {
        const edit=input.assignment;
        if(!edit||typeof edit!=='object'||Array.isArray(edit))throw Error('Worker assignment must be an object.');
        const assignment={...(node.assignment||{}),...edit};
        for(const [field,label,max] of [['scope','scope',3000],['result','expected result',1000],['doneWhen','completion criteria',1000]]){
          const value=assignment[field];
          if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))
            throw Error('Worker '+label+' must be nonempty text of at most '+max+' characters.');
          assignment[field]=value.trim();
        }
        if(!Array.isArray(assignment.inputs)||assignment.inputs.length>200||assignment.inputs.some(value=>
          typeof value!=='string'||!value.trim()||value.length>1000||value.includes('\0')))
          throw Error('Worker inputs must contain at most 200 nonempty entries of 1–1,000 characters.');
        assignment.inputs=assignment.inputs.map(value=>value.trim());
        next.assignment=assignment;
      }
    }
    if (Object.hasOwn(input,'context')) {
      if(input.context===null)delete next.context;
      else {
        const context=input.context;
        if(!context||typeof context!=='object'||Array.isArray(context)
          ||!['model','900k','custom'].includes(context.preset))
          throw Error('Choose a supported context window preset.');
        if(context.autoCompact!==undefined&&typeof context.autoCompact!=='boolean')
          throw Error('Automatic compaction must be enabled or disabled.');
        if(context.preset==='custom'&&(!Number.isSafeInteger(context.windowTokens)
          ||context.windowTokens<4096||context.windowTokens>4000000))
          throw Error('Custom context window must be 4,096–4,000,000 tokens.');
        next.context={...(node.context&&typeof node.context==='object'?node.context:{}),
          ...context,windowTokens:context.preset==='900k'?900000
            :context.preset==='custom'?context.windowTokens:null};
      }
    }
    return next;
  });
  if (Object.keys(nodes).some(id => !seen.has(id)))
    throw Error('The stage selection changed. Refresh the saved workflow before editing.');
  let settings=workflow.settings;
  if(workflowSettings!==undefined){
    if(!workflowSettings||typeof workflowSettings!=='object'||Array.isArray(workflowSettings))
      throw Error('Workflow settings must be an object.');
    settings={...(workflow.settings||{})};
    for(const [field,value] of Object.entries(workflowSettings)){
      if(field==='maxParallel'){
        if(value!==null&&(!Number.isSafeInteger(value)||value<1||value>1000))
          throw Error('Maximum parallel stages must be 1–1,000, or blank for no limit.');
        settings.maxParallel=value;
      }else if(field==='planningMode'){
        if(value===null)delete settings.planningMode;
        else if(workflowPlanning.has(value))settings.planningMode=value;
        else throw Error('Choose a supported task planning mode.');
      }else if(field==='planDetail'){
        if(value===null)delete settings.planDetail;
        else if(workflowDetails.has(value))settings.planDetail=value;
        else throw Error('Choose compact, balanced or detailed planning.');
      }else throw Error('This workflow setting is not editable in V2.');
    }
  }
  return { ...workflow, name: updatedName, nodes: changed, edges: workflow.edges,
    ...(workflowSettings===undefined?{}:{settings}) };
}

/** A snapshot for detecting independently changed workflow data before save.
 * The backend does not expose a revisioned conditional write yet.
 */
export function workflowSnapshot(workflow) {
  return JSON.stringify(workflow || null);
}
