/** Public response contracts and projections; no execution or truth certification. */
import { VIABILITY_TEMPLATE, validateViabilityRequirements, evaluateViabilityResponse, planningReadableFindingIssues, validatePlanningReadableFindings } from './task-viability-model.mjs';
import { RESPONSE_CYCLE_CONTAINER_TEMPLATE, RESPONSE_CYCLE_TEMPLATES, RESPONSE_CYCLE_STAGES, responseCycleStage, parseResponseCycleResponse, evaluateResponseCycleStage, analyticalSubproblem } from './response-cycle-model.mjs';
export const PLANNING_BROWSER_VERSION = 1;
export const PLANNING_BROWSER_LIMITS = Object.freeze({
  requests: 500, nodes: 500, depth: 32, edges: 2000, responses: 1500,
  attempts: 1500, sources: 200, history: 200, fieldChars: 8000,
  responseChars: 120000, sourceChars: 40000, bytes: 32 * 1024 * 1024
});
export const PLANNING_LINK_KINDS = Object.freeze(['depends_on','consumes','supports','challenges','informs','knowledge']);
const field = (id,label,description,grounding='prospective') =>
  Object.freeze({id,label,description,prompt:description,required:true,grounding});
const template = (kind,label,description,fields) => Object.freeze({kind,label,description,fields:Object.freeze(fields)});
export const PLANNING_MODULE_TEMPLATES = Object.freeze([
  RESPONSE_CYCLE_CONTAINER_TEMPLATE,
  ...RESPONSE_CYCLE_TEMPLATES,
  template('frame','Reframe the problem','Expose the assumed objective and a materially different framing.',[
    field('objective','Desired outcome','State the actual outcome and whose decision it serves.','required'),
    field('constraints','Real constraints','Separate explicit constraints from inherited methods or conventions.','required'),
    field('alternativeFrame','Alternative framing','Consider a different plausible cause, recipient or unit of analysis only if it matters to the requested outcome; otherwise explain why the supplied framing is sufficient.'),
    field('keyAssumption','Pivotal assumption','Name an assumption only if changing it could alter the useful work. Distinguish stipulated premises from unsupported real-world claims, and state when no material extra assumption is needed.'),
    field('decisiveUnknown','Decision-changing unknown','Identify an unknown only if resolving it could change the requested outcome or satisfy a real constraint at the needed accuracy. Otherwise state that no decision-changing unknown remains. Given fictional or synthetic premises do not require external reality checks.')
  ]),
  template('inquiry','Discriminating inquiry','Ask a question that separates plausible explanations.',[
    field('question','Bounded question','State one answerable question and the decision it can change.'),
    field('competingExplanations','Competing explanations','Describe the strongest materially different explanations, not synonyms.'),
    field('discriminatingObservation','Discriminating observation','Specify what observable result would favor one explanation over another.'),
    field('smallestUsefulCheck','Smallest useful check','Identify the least costly check that can change the decision.'),
    field('findings','Actual findings','Report what was observed, distinguishing it from the expected result.','required'),
    field('remainingUncertainty','Remaining uncertainty','Name any uncertainty that still matters at the accuracy the task needs, or state that no material uncertainty remains. Stop when additional checking cannot change the requested outcome or satisfy an unmet real constraint.')
  ]),
  template('evidence','Evaluate evidence','Test what the source supports and what it does not.',[
    field('claim','Claim under examination','State the exact claim being supported or challenged.'),
    field('sourceAssessment','Source assessment','Assess access, origin, relevance and limitations of the actual source.','required'),
    field('support','Supported inference','Explain what the observed evidence supports and the link to the claim.','required'),
    field('contradictions','Contrary evidence','Identify a material contrary observation or decision-changing gap in the available record, or state that none remains at the required accuracy.','required'),
    field('limits','Limits of inference','Explain what cannot be concluded and what would change that limit.')
  ]),
  template('comparison','Compare alternatives','Compare real alternatives using the same decision criteria.',[
    field('criteria','Decision criteria','State the criteria and their source before selecting a winner.','required'),
    field('strongestOptions','Strongest alternatives','Describe the strongest feasible alternatives on comparable terms.','required'),
    field('tradeoffs','Material tradeoffs','Explain the gains, losses and uncertainties that distinguish the alternatives.','required'),
    field('opportunityCost','Displaced opportunity','Identify the best use of effort or resources displaced by each serious choice.'),
    field('choiceSensitivity','Choice sensitivity','State which plausible change would reverse the comparison.')
  ]),
  template('decision','Challenge a decision','Make the alternative, opportunity cost and reversal test explicit.',[
    field('recommendation','Recommendation','Choose a bounded next action and connect it to the requested outcome.','required'),
    field('strongestAlternative','Strongest alternative','Give the strongest materially different alternative and why it remains plausible.','required'),
    field('opportunityCost','Opportunity cost','Identify the best alternative use of the same effort that this choice displaces.'),
    field('keyAssumption','Pivotal assumption','State the assumption on which this choice most depends.'),
    field('discriminatingObservation','Discriminating observation','Specify an observation that distinguishes this choice from its strongest alternative.'),
    field('reversalCondition','Reversal condition','State what evidence or change would cause you to revise the decision.')
  ]),
  template('action','Observe an action','Keep the requested effect, attempted operation and observed result distinct.',[
    field('requestedOutcome','Requested effect','State the authorized effect the action is intended to produce.','required'),
    field('procedure','Bounded procedure','Describe the actual bounded operation and its real prerequisites.'),
    field('observedResult','Observed result','Report the actual result rather than a plan or a successful tool invocation.','required'),
    field('verification','Outcome check','Describe the observed check of the requested effect and its limits.','required'),
    field('remainingDependency','Remaining dependency','Name remaining work, uncertain effects or blockers without declaring them complete.')
  ]),
  template('synthesis','Synthesize and challenge','Integrate actual outputs while retaining their strongest challenge.',[
    field('answer','Answer to the request','Answer the original question at the level supported by the recorded work.','required'),
    field('convergingEvidence','Converging evidence','Connect the independent findings that support this answer.','required'),
    field('strongestChallenge','Strongest challenge','Present the strongest material challenge and how it affects the answer.','required'),
    field('unresolved','Unresolved issues','Identify consequential conflicts or gaps rather than hiding them in a summary.'),
    field('implications','Implications','Explain the resulting next action and the observation that should prompt reconsideration.')
  ])
]);
export function planningBrowserError(message,code='PLANNING_BROWSER_INVALID',status=400) {
  return Object.assign(new Error(message),{code,status});
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const text = (value,label,max,required=false) => {
  if(typeof value !== 'string'||value.includes('\0')||value.length>max||required&&!value.trim())
    throw planningBrowserError(label+' must be '+(required?'nonempty ':'')+'text of at most '+max+' characters.');
  return value.trim();
};
const allowed = (value,keys,label) => {
  if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))
    throw planningBrowserError(label+' contains unsupported fields.');
};
export function planningModuleTemplate(kind) {
  const found=PLANNING_MODULE_TEMPLATES.find(item=>item.kind===kind);
  if(!found)throw planningBrowserError('Choose a declared response module kind.');
  return found;
}
export function validateModuleValues(kind,values={}) {
  const schema=planningModuleTemplate(kind);
  allowed(values,schema.fields.map(item=>item.id),'Response values');
  const normalized={};
  for(const [id,value]of Object.entries(values))normalized[id]=text(value,'Response field '+id,PLANNING_BROWSER_LIMITS.fieldChars);
  return {values:normalized,missingFields:schema.fields.filter(item=>item.required&&!normalized[item.id]).map(item=>item.id)};
}
export function parseModuleResponse(output,kind,{sources}={}) {
  if (['inference','plan','think','respond'].includes(kind)) return parseResponseCycleResponse(output,kind,{sources});
  let value=output;
  if(typeof output==='string'){
    if(output.length>PLANNING_BROWSER_LIMITS.responseChars)throw planningBrowserError('Response exceeds its storage bound.');
    let source=output.trim();
    const fence=/^~~~json\s*\n([\s\S]*?)\n~~~$/i.exec(source)||/^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(source);
    if(fence)source=fence[1];
    try{value=JSON.parse(source);}catch{throw planningBrowserError('Return one JSON object with values, grounding, openQuestions and challengeResponses.','PLANNING_RESPONSE_PARSE');}
  }
  allowed(value,['values','grounding','openQuestions','challengeResponses',...(kind==='viability'?['requirements']:[])],'Public module response');
  const checked=validateModuleValues(kind,value.values??{});
  const grounding=value.grounding??[];
  if(!Array.isArray(grounding)||grounding.length>100)throw planningBrowserError('Grounding must contain at most 100 field/source links.');
  const fieldIds=new Set(planningModuleTemplate(kind).fields.map(item=>item.id));
  const seen=new Set();
  const links=grounding.map(item=>{
    allowed(item,['field','sourceId'],'Grounding link');
    if(!fieldIds.has(item.field))throw planningBrowserError('Grounding names an undeclared response field.');
    const sourceId=text(item.sourceId,'Grounding source ID',300,true),key=item.field+'\0'+sourceId;
    if(seen.has(key))throw planningBrowserError('Grounding links must be unique.');
    seen.add(key);return {field:item.field,sourceId};
  });
  const questions=value.openQuestions??[];
  if(!Array.isArray(questions)||questions.length>40)throw planningBrowserError('Use at most 40 open questions.');
  const challenges=value.challengeResponses??[];
  if(!Array.isArray(challenges)||challenges.length>100)throw planningBrowserError('Use at most 100 challenge responses.');
  const challengeIds=new Set();
  const result={...checked,...(kind==='viability'?{requirements:validateViabilityRequirements(value.requirements)}:{}),grounding:links,
    openQuestions:questions.map(item=>text(item,'Open question',2000,true)),
    challengeResponses:challenges.map(item=>{
      allowed(item,['edgeId','disposition','note'],'Challenge response');
      if(!['addressed','open'].includes(item.disposition))throw planningBrowserError('A challenge response is addressed or open.');
      if(challengeIds.has(item.edgeId))throw planningBrowserError('Challenge responses must name distinct edges.');challengeIds.add(item.edgeId);
      return {edgeId:text(item.edgeId,'Challenge ID',160,true),disposition:item.disposition,note:text(item.note,'Challenge response note',4000,true)};
    })};
  return sources===undefined?result:validatePlanningReadableFindings(result,sources);
}
export function planningRequestSources(request) {
  const origin=clone(request.provenance||{kind:'unrecorded'});
  const objectiveSource={id:'request:'+request.id,kind:origin.kind==='human'?'user_request':'request_objective',title:'Requested outcome',text:request.objective||'',provenance:origin,verified:false};
  const all=[objectiveSource],liveSources=request.sources||[],liveIds=new Set(liveSources.map(source=>source.id));
  for(const response of request.responses||[]){
    const module=request.nodes?.find(node=>node.id===response.nodeId);
    all.push({id:'response:'+response.id,kind:'response',title:(module?.title||planningModuleTemplate(response.kind).label)+' · revision '+response.revision,
      text:JSON.stringify(planningResponseBody(response)),responseId:response.id,revision:response.revision,provenance:response.provenance});
    // Historical snapshots remain inspectable on their responses. Host-owned
    // readiness inputs must disappear when removed from the actual source set.
    all.push(...(response.sources||[]).filter(source=>!(/^(?:viability|cycle):/.test(source.id||''))||liveIds.has(source.id)));
  }
  for(const edge of request.edges||[])if(edge.kind==='knowledge'&&edge.knowledge)
    all.push({id:'knowledge:'+edge.knowledge.id+':'+edge.knowledge.revision,kind:'knowledge',title:edge.knowledge.title,
      text:edge.knowledge.content,revision:edge.knowledge.revision,provenance:edge.knowledge.provenance});
  // Current source content always wins over older captured response snapshots.
  all.push(...liveSources);
  const sources=new Map(all.filter(item=>item&&typeof item.id==='string').map(item=>[item.id,item]));
  // The immutable request has authoritative authorship; an older response snapshot
  // must not promote an unknown or external objective to a human instruction.
  sources.set(objectiveSource.id,objectiveSource);
  return [...sources.values()].map(clone);
}

/** Stored public content only; execution metadata can never be supplied as an answer. */
export function planningResponseBody(response) {
  const keys=['values','grounding','openQuestions','challengeResponses','requirements','checks','subproblems','childResults','acceptanceCriteria','steps','inferences','criterionResults','coverage'];
  return Object.fromEntries(keys.filter(key=>Object.hasOwn(response,key)).map(key=>[key,clone(response[key])]));
}

/** A stage sees its bounded problem, upstream results and its own later execution records. */
export function planningNodeSources(request,nodeId) {
  const cycles=request.responseCycle?.cycles||[],cycle=cycles.find(item=>Object.values(item.stageNodeIds||{}).includes(nodeId));
  const stage=cycle&&Object.entries(cycle.stageNodeIds).find(([,id])=>id===nodeId)?.[0];
  const permitted=Array.isArray(cycle?.sourceIds)?new Set(cycle.sourceIds):null;
  return planningRequestSources(request).filter(source=>{
    if(permitted?.has(source.id))return true;
    if(!source.id.startsWith('cycle:'))return !permitted||source.kind==='response'||permitted.has(source.id)||source.id==='request:'+request.id||source.id.startsWith('viability:answer:');
    if(!cycle)return false;
    if(source.id==='cycle:context:'+cycle.id)return true;
    if(source.id.startsWith('cycle:child:'+nodeId+':'))return true;
    return ['think','respond'].includes(stage)&&source.id.startsWith('cycle:execution:'+cycle.id+':');
  });
}

function workflowRequirementIdentity(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
/** Current typed handoffs remain proposed work, never analytical-child results or effect receipts. */
function planningWorkflowContext(request, cycle, latest) {
  const cycles=request.responseCycle.cycles, byId=new Map(cycles.map(item=>[item.id,item]));
  let owner=cycle;const seen=new Set();
  while(owner&&!owner.linkedRunId&&owner.parentCycleId&&!seen.has(owner.id)){seen.add(owner.id);owner=byId.get(owner.parentCycleId);}
  if(!owner?.linkedRunId)owner=null;
  const scope=new Map([[cycle.id,true]]);let changed=true;
  while(changed){changed=false;for(const child of cycles)if(!scope.has(child.id)&&scope.has(child.parentCycleId)&&analyticalSubproblem(child.request)&&(!child.linkedRunId||child.linkedRunId===owner?.linkedRunId)){scope.set(child.id,scope.get(child.parentCycleId)&&child.required!==false);changed=true;}}
  const workflowRequests=[];
  for(const item of cycles.filter(item=>scope.has(item.id))){
    const nodeId=item.stageNodeIds.inference,response=latest.get(nodeId);
    for(const work of response?.subproblems||[])if(!analyticalSubproblem(work))workflowRequests.push({...clone(work),origin:{cycleId:item.id,nodeId,responseId:response.id,responseRevision:response.revision,key:work.key},sourceId:'response:'+response.id,requiredForPlan:scope.get(item.id)&&work.required!==false});
  }
  const requiredAcceptanceCriteria=clone(cycle.acceptanceCriteria||[]), byCriterion=new Map(requiredAcceptanceCriteria.map(item=>[item.id,item])),workflowCriterionConflicts=[];
  for(const work of workflowRequests.filter(item=>item.requiredForPlan))for(const criterion of work.acceptanceCriteria){
    const prior=byCriterion.get(criterion.id);
    if(prior&&workflowRequirementIdentity(prior)!==workflowRequirementIdentity(criterion))workflowCriterionConflicts.push(criterion.id);
    else if(!prior){const value=clone(criterion);byCriterion.set(value.id,value);requiredAcceptanceCriteria.push(value);}
  }
  return {workflowRequests,requiredAcceptanceCriteria,workflowCriterionConflicts:[...new Set(workflowCriterionConflicts)],workflowOwner:owner?{cycleId:owner.id,runId:owner.linkedRunId,execution:clone(owner.execution||{})}:null};
}

export function planningCycleStageContext(request,nodeId,responses) {
  const cycle=request.responseCycle?.cycles?.find(item=>Object.values(item.stageNodeIds||{}).includes(nodeId));
  if(!cycle)return null;
  const stageId=Object.entries(cycle.stageNodeIds).find(([,id])=>id===nodeId)?.[0],position=RESPONSE_CYCLE_STAGES.findIndex(stage=>stage.id===stageId);
  const latest=responses||latestByNode(request.responses),get=id=>latest.get(id);
  const prerequisites=RESPONSE_CYCLE_STAGES.slice(0,position).map(stage=>{
    const id=cycle.stageNodeIds[stage.id],response=get(id);
    return {stageId:stage.id,nodeId:id,responseId:response?.id,responseRevision:response?.revision,sourceId:response?'response:'+response.id:null,state:response?'recorded':'empty',analysisReady:Boolean(response),dispatchReady:Boolean(response)};
  });
  const children=(request.responseCycle.cycles||[]).filter(item=>item.parentStageId===nodeId&&analyticalSubproblem(item.request)).map(child=>{
    const response=get(child.stageNodeIds.respond);
    return {key:child.key||child.id,cycleId:child.id,required:child.required!==false,state:child.state||'pending',analysisReady:child.state==='completed',dispatchReady:child.state==='completed',sourceId:'cycle:child:'+nodeId+':'+child.id,responseId:response?.id,responseRevision:response?.revision,...(child.request?{request:clone(child.request)}:{})};
  });
  const plan=get(cycle.stageNodeIds.plan),think=get(cycle.stageNodeIds.think),workflow=planningWorkflowContext(request,cycle,latest);
  return {cycleId:cycle.id,stageId,title:cycle.title,objective:cycle.objective,acceptanceCriteria:plan?.acceptanceCriteria||cycle.acceptanceCriteria||[],...workflow,criterionResults:think?.criterionResults||[],prerequisites,children,recoveryIssue:request.viability?.recoveryIssue||null,
    recursion:{depth:cycle.depth,cycleCount:request.responseCycle.cycles.length,...request.responseCycle.limits},effectReceipts:cycle.effectReceipts||[],execution:cycle.execution||null};
}
const latestByNode = records => {
  const map=new Map();
  for(const record of records||[])if(!map.has(record.nodeId)||record.revision>(map.get(record.nodeId).revision||0))map.set(record.nodeId,record);
  return map;
};
export function projectPlanningRequest(value) {
  const request=clone(value);request.edges=(request.edges||[]).filter(edge=>edge.kind!=='contains');
  const rawNodes=request.nodes||[],byId=new Map(rawNodes.map(node=>[node.id,node]));
  const responses=latestByNode(request.responses),children=new Map(rawNodes.map(node=>[node.id,[]]));
  for(const node of rawNodes)if(node.parentId&&children.has(node.parentId))children.get(node.parentId).push(node.id);
  const assignments=request.assignments||[],attempts=request.attempts||[],memo=new Map();
  const assignmentFor=node=>{
    const direct=assignments.find(item=>item.nodeId===node.id);
    if(direct)return clone(direct);
    let parent=node.parentId,seen=new Set();
    while(parent&&!seen.has(parent)){seen.add(parent);const found=assignments.find(item=>item.nodeId===parent&&item.scope==='subtree');if(found)return {...clone(found),inherited:true};parent=byId.get(parent)?.parentId;}
    return null;
  };
  const readinessFor=(nodeId,visiting=new Set())=>{
    if(memo.has(nodeId))return memo.get(nodeId);
    if(visiting.has('response:'+nodeId))return {state:'blocked',blockedDependencies:[nodeId],missingFields:[],missingGrounding:[],staleInputs:[],openChallenges:[],unresolvedChildren:[],responseRecorded:false,verifiedAction:false};
    const nextVisit=new Set(visiting);nextVisit.add('response:'+nodeId);
    const node=byId.get(nodeId),response=responses.get(nodeId),schema=planningModuleTemplate(node.kind);
    if(node.kind==='cycle'){
      const unresolved=(children.get(node.id)||[]).filter(id=>!subtreeReady(id,nextVisit));
      const result={state:unresolved.length?'pending':'ready',missingFields:[],missingGrounding:[],invalidGrounding:[],staleInputs:[],blockedDependencies:[],openChallenges:[],openQuestions:[],unresolvedChildren:unresolved,responseRecorded:false,verifiedAction:false,container:true};
      memo.set(nodeId,result);return result;
    }
    const readableIssues=planningReadableFindingIssues(response,response?.sources||[]).map(issue=>issue.path+': '+issue.message);
    const missingFields=schema.fields.filter(field=>field.required&&!response?.values?.[field.id]?.trim()).map(field=>field.id);
    const admissible=new Set((response?.sources||[]).filter(source=>typeof source.text==='string'&&source.text.trim()||source.kind==='artifact'&&/^[a-f0-9]{64}$/.test(source.contentHash||'')).map(source=>source.id));
    const invalidGrounding=(response?.grounding||[]).filter(link=>!admissible.has(link.sourceId));
    const grounded=new Set((response?.grounding||[]).filter(link=>admissible.has(link.sourceId)).map(link=>link.field));
    const missingGrounding=schema.fields.filter(field=>field.grounding==='required'&&response?.values?.[field.id]?.trim()&&!grounded.has(field.id)).map(field=>field.id);
    const staleInputs=[];
    if(response&&response.nodeRevision!==node.revision)staleInputs.push({kind:'module_revision',expected:response.nodeRevision,current:node.revision});
    const edges=(request.edges||[]).filter(edge=>edge.from===nodeId);
    for(const edge of edges.filter(edge=>edge.kind==='consumes'&&edge.freshness!=='pinned')){
      const current=responses.get(edge.to);
      if(current&&(current.id!==edge.sourceResponseId||current.revision!==edge.sourceResponseRevision))
        staleInputs.push({kind:'producer_changed',edgeId:edge.id,nodeId:edge.to,responseId:edge.sourceResponseId,currentResponseId:current.id});
    }
    for(const input of response?.inputs||[]){
      if(input.freshness==='pinned')continue;
      for(const captured of [input,...(input.subtree||[])]){
        const current=responses.get(captured.nodeId);
        if(current&&(current.id!==captured.responseId||current.revision!==captured.responseRevision)&&!staleInputs.some(item=>item.edgeId===input.edgeId&&item.nodeId===captured.nodeId))
          staleInputs.push({kind:'consumed_response_changed',edgeId:input.edgeId,nodeId:captured.nodeId,responseId:captured.responseId,currentResponseId:current.id});
      }
    }
    const blockedDependencies=[];
    for(const edge of edges.filter(edge=>['depends_on','consumes'].includes(edge.kind))){
      if(edge.kind==='consumes'&&edge.freshness==='pinned'){
        if(!(request.responses||[]).some(item=>item.id===edge.sourceResponseId&&item.revision===edge.sourceResponseRevision&&item.nodeId===edge.to))blockedDependencies.push(edge.to);
      }else if(!byId.has(edge.to)||(edge.kind==='depends_on'?!subtreeReady(edge.to,nextVisit):(()=>{const prior=readinessFor(edge.to,nextVisit);return prior.state!=='ready'&&!(node.cycleId&&prior.cycle?.analysisReady);})()))blockedDependencies.push(edge.to);
    }
    const challenges=(request.edges||[]).filter(edge=>edge.kind==='challenges'&&edge.to===nodeId);
    const openChallenges=challenges.filter(edge=>{
      const answer=response?.challengeResponses?.find(item=>item.edgeId===edge.id&&item.disposition==='addressed'&&item.note?.trim());
      const challenger=responses.get(edge.from);
      return !answer||!challenger||!(response?.sources||[]).some(source=>source.id==='response:'+challenger.id);
    }).map(edge=>edge.id);
    const viability=node.kind==='viability'?evaluateViabilityResponse(response,planningNodeSources(value,nodeId),{workflowNodeIds:value.viability?.workflowNodeIds||null}):null;
    if(viability&&value.viability?.recoveryIssue){viability.state='needs_evidence';viability.analysisReady=false;viability.issues=[value.viability.recoveryIssue.message];viability.analysisIssues=[...viability.issues];}
    const ownAttempts=attempts.filter(item=>item.nodeId===nodeId);
    const running=ownAttempts.find(item=>item.status==='running');
    const last=ownAttempts.at(-1);
    let state=running?'running':staleInputs.length?'stale':blockedDependencies.length?'blocked':!response?'empty':missingFields.length?'missing_fields':missingGrounding.length||invalidGrounding.length?'needs_grounding':openChallenges.length?'challenged':'ready';
    if(!running&&last&&['failed','cancelled'].includes(last.status)&&(!response||Date.parse(last.finishedAt||last.startedAt)>Date.parse(response.provenance?.at||0)))state=last.status;
    // Keep generic structural, dependency and challenge gates separate from unresolved source inspection.
    const unresolvedViabilityAnalysis=state==='ready'&&viability?.analysisReady===true&&!readableIssues.length&&!value.viability?.recoveryIssue;
    if(viability&&state==='ready'&&viability.state!=='ready')state=viability.state;
    if(state==='ready'&&readableIssues.length)state='needs_evidence';
    const cycleContext=planningCycleStageContext(value,nodeId,responses);
    let cycle=null;
    if(cycleContext){
      cycleContext.prerequisites=cycleContext.prerequisites.map(item=>{const prior=readinessFor(item.nodeId,nextVisit);return {...item,state:prior.state,analysisReady:prior.cycle?.analysisReady??prior.state==='ready',dispatchReady:prior.cycle?.dispatchReady??prior.state==='ready'};});
      cycleContext.children=cycleContext.children.map(item=>{const child=value.responseCycle.cycles.find(child=>child.id===item.cycleId),childResponse=readinessFor(child.stageNodeIds.respond,nextVisit),complete=childResponse.cycle?.analysisReady===true&&child.state==='completed';return {...item,state:complete?'completed':['failed','cancelled'].includes(child.state)?child.state:childResponse.state,analysisReady:complete,dispatchReady:complete&&childResponse.cycle?.dispatchReady===true,workflowHandoff:childResponse.cycle?.workflowHandoff||null,outcome:childResponse.cycle?.outcome||'unresolved'};});
      cycle=evaluateResponseCycleStage(cycleContext.stageId,response,{...cycleContext,sources:planningNodeSources(value,nodeId),nodeRevision:node.revision,workflowNodeIds:value.viability?.workflowNodeIds||null});
      if(!['ready','awaiting_input'].includes(state)&&!unresolvedViabilityAnalysis){cycle.analysisReady=false;cycle.dispatchReady=false;cycle.state=state;}
      if(!running&&['ready','awaiting_input','needs_evidence'].includes(state)&&!cycle.analysisReady)state=cycle.state;
    }
    const result={state,...(viability?{viability}:{}),...(cycle?{cycle}:{}),issues:readableIssues,missingFields,missingGrounding,invalidGrounding,staleInputs,blockedDependencies:[...new Set(blockedDependencies)],openChallenges,openQuestions:clone(response?.openQuestions||[]),unresolvedChildren:[],responseRecorded:Boolean(response),verifiedAction:false,
      ...(running?{attemptId:running.id}:{}),assurance:'A recorded response and valid source links do not independently verify its claims.'};
    memo.set(nodeId,result);return result;
  };
  // A dependency waits for a branch. A consumes link reads the named response,
  // allowing a child to use its parent's framing without waiting for itself.
  const subtreeReady=(nodeId,seen=new Set())=>{
    if(seen.has('branch:'+nodeId)||!byId.has(nodeId))return false;
    const next=new Set(seen);next.add('branch:'+nodeId);
    return readinessFor(nodeId,next).state==='ready'&&(children.get(nodeId)||[]).every(child=>subtreeReady(child,next));
  };
  request.nodes=rawNodes.map(node=>({...node,children:children.get(node.id)||[],assignment:assignmentFor(node),response:responses.get(node.id)?clone(responses.get(node.id)):null,readiness:readinessFor(node.id)}));
  for(const node of request.nodes){
    node.readiness.unresolvedChildren=node.children.filter(id=>!subtreeReady(id));
    node.readiness.subtreeReady=subtreeReady(node.id);
  }
  request.sources=planningRequestSources(value);
  request.edges=[...(request.edges||[]),...rawNodes.filter(node=>node.parentId).map(node=>({id:'contains:'+node.parentId+':'+node.id,kind:'contains',from:node.parentId,to:node.id,derived:true}))];
  request.summary={nodes:request.nodes.length,responses:request.responses?.length||0,running:request.nodes.filter(node=>node.readiness.state==='running').length,ready:request.nodes.filter(node=>node.readiness.state==='ready').length,open:request.nodes.filter(node=>node.readiness.state!=='ready').length};
  request.cycles=(request.responseCycle?.cycles||[]).map(cycle=>{
    const container=request.nodes.find(node=>node.id===cycle.id),stages=RESPONSE_CYCLE_STAGES.map(stage=>request.nodes.find(node=>node.id===cycle.stageNodeIds[stage.id])),plan=stages[2],last=stages[4];
    const current=stages.find(node=>node?.readiness.state==='running')||stages.find(node=>!node?.readiness.cycle?.analysisReady);
    const stale=stages.some(node=>node?.readiness.state==='stale'||node?.readiness.cycle?.state==='stale');
    let state=cycle.state||'pending',inheritedCancellation=null;
    if(!['completed','failed','cancelled'].includes(state)&&!stages.some(node=>node?.readiness.state==='running')){
      let parent=cycle.parentCycleId,cancelOwner=cycle.linkedRunId||null;const seen=new Set();
      while(parent&&!seen.has(parent)){seen.add(parent);const ancestor=request.responseCycle.cycles.find(item=>item.id===parent);if(!ancestor||ancestor.linkedRunId&&cancelOwner&&ancestor.linkedRunId!==cancelOwner)break;if(ancestor.linkedRunId)cancelOwner=ancestor.linkedRunId;if(ancestor.state==='cancelled'){inheritedCancellation=ancestor;break;}parent=ancestor.parentCycleId;}
    }
    if(inheritedCancellation)state='cancelled';
    else if(stages.some(node=>node?.readiness.state==='running'))state='running';
    else if(stale&&!['failed','cancelled'].includes(state))state='stale';
    else if(state==='completed'&&!last?.readiness.cycle?.analysisReady)state='needs_review';
    return {...clone(cycle),revision:container?.revision||1,state,planRevision:plan?.revision||null,planResponseId:plan?.response?.id||null,
      progress:{completed:stages.filter(node=>node?.readiness.cycle?.analysisReady).length,total:5,currentStage:current?.cycleStage||null},
      summary:inheritedCancellation?.summary||(['failed','cancelled','stale','needs_evidence','waiting_children'].includes(state)?cycle.summary:null)||last?.response?.values?.answer||plan?.response?.values?.summary||plan?.response?.values?.approach||cycle.summary||cycle.objective};
  });
  return request;
}
export function planningOutlineRows(value) {
  const request=value.nodes?.every(node=>node.readiness)?value:projectPlanningRequest(value);
  const byId=new Map(request.nodes.map(node=>[node.id,node])),children=new Map();
  for(const node of request.nodes){const key=byId.has(node.parentId)?node.parentId:null;if(!children.has(key))children.set(key,[]);children.get(key).push(node);}
  const rows=[],seen=new Set();
  const visit=(node,path,number)=>{if(seen.has(node.id))return;seen.add(node.id);const next=[...path,node.id];rows.push({...clone(node),depth:path.length,path:next,number,children:(children.get(node.id)||[]).map(item=>item.id)});(children.get(node.id)||[]).forEach((child,index)=>visit(child,next,number+'.'+(index+1)));};
  (children.get(null)||[]).forEach((node,index)=>visit(node,[],String(index+1)));
  for(const node of request.nodes)if(!seen.has(node.id))visit(node,[],String(rows.length+1));
  return rows;
}
