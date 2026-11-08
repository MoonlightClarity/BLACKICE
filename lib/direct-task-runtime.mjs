import {createHash, randomUUID} from 'node:crypto';
import {DirectTaskOutcomes, semanticOutcomeKey} from './direct-task-outcomes.mjs';
import {createBrowserToolHandler} from './browser.mjs';
import {connectorBrowserOwner} from './connector-browser-owner.mjs';
import {normalizeContractEvidence} from './planning-contract-evidence.mjs';
import {receiptBindingsForCriterion} from '../public/planning-contract-model.mjs';

const fail=(message,code='DIRECT_TASK_UNVERIFIED')=>Object.assign(new Error(message),{code,status:409,actionDispatched:false});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function observedSemanticIdentity(descriptor, identityFields) {
  const commit=descriptor?.commit;
  if(descriptor?.effect!=='commit'||!commit?.destinationKey||!Array.isArray(identityFields)||!identityFields.length) throw fail('Bind an observed native form submission and stable business identity fields.');
  const names=[...new Set(identityFields)].sort();
  const fields=names.map(name=>{
    const matches=(commit.identityDigests||[]).filter(v=>v.name===name&&/^[a-f0-9]{64}$/.test(v.digest));
    if(matches.length!==1) throw fail('A selected business identity field is missing or ambiguous.');
    return matches[0];
  });
  return {effect:'destination-commit',resource:commit.destinationKey,subject:hash(fields)};
}
/** Uses native host descriptors and receipt extraction; never accepts caller proof. */
export class DirectTaskRuntime {
  constructor({dataDir,browser,outcomes,reauthorize=null,withPlanSnapshot=null}={}) {
    this.browser=browser;this.reauthorize=reauthorize;this.withPlanSnapshot=withPlanSnapshot;this.proofs=new Map();
    this.outcomes=outcomes||new DirectTaskOutcomes({dataDir,resolveEvidence:({ownerId,taskId,evidenceId})=>this.proofs.get(JSON.stringify([ownerId,taskId,evidenceId]))});
  }
  async syncCanonicalPlan({ownerId,taskId,signal}) {
    if(!this.withPlanSnapshot)return null;
    return this.withPlanSnapshot({ownerId,taskId,signal},snapshot=>snapshot?this.outcomes.syncPlanSnapshot({ownerId,taskId,...snapshot}):null);
  }
  async canonicalAdmission({ownerId,taskId,signal},callback,host={}) {
    const apply=async snapshot=>{
      if(snapshot)await this.outcomes.syncPlanSnapshot({ownerId,taskId,...snapshot});
      return callback();
    };
    if(host.canonicalSnapshot)return apply(host.canonicalSnapshot);
    return this.withPlanSnapshot?this.withPlanSnapshot({ownerId,taskId,signal},apply):apply(null);
  }
  async validatedContext(args){try{return await this.outcomes.validateContext(args);}catch(error){throw Object.assign(error,{actionDispatched:false});}}
  authorizeRepeat(args){return this.outcomes.authorizeRepeat(args);}
  issueContext(args){return this.outcomes.issueContext(args);}
  readContext(args){return this.outcomes.readContext(args);}
  revokeContext(args){return this.outcomes.revokeContext(args);}
  async rejectUnsupportedContext({ownerId,taskContext,tool}){
    await this.outcomes.readContext({ownerId,taskContext});
    throw fail('Protected task context has no trusted effect adapter for '+tool+'. No action was dispatched.','DIRECT_TASK_ADAPTER_UNSUPPORTED');
  }
  async contextScope({ownerId,context,descriptor}){
    const task=await this.outcomes.read({ownerId,taskId:context.taskId});
    const work=task.contract.workItems.find(w=>w.id===context.workItemId);
    if(!work?.effects.includes(descriptor.effect))throw fail('The task context does not permit this observed effect class.','DIRECT_TASK_SCOPE');
    const targets=descriptor.resources.filter(r=>!r.scopeOnly && (descriptor.effect==='observe'||r.access==='write'));
    if(!(descriptor.effect==='observe'&&work.resourceKeys.includes('discovery')) && !targets.every(r=>[r.key,...(r.scopeKeys||[])].some(k=>work.resourceKeys.includes(k))))throw fail('The actual resource is outside this explicit task context.','DIRECT_TASK_SCOPE');
  }
  async executeScoped({ownerId,client,taskContext,adapterId,handler,call,signal}){
    const preliminary=await this.outcomes.readContext({ownerId,taskContext});
    await this.syncCanonicalPlan({ownerId,taskId:preliminary.taskId,signal});
    const context=await this.validatedContext({ownerId,taskContext,adapterId});
    const descriptor=await handler.describeOperation(call,{signal});
    if(descriptor.effect!=='observe')throw fail('This protected adapter has no semantic outcome implementation for mutations. No action was dispatched.','DIRECT_TASK_ADAPTER_UNSUPPORTED');
    await this.contextScope({ownerId,context,descriptor});
    const result=await handler(call,{signal,operationDescriptor:descriptor,onOperationDispatch:async(_actual,host)=>this.canonicalAdmission({ownerId,taskId:context.taskId,signal},async()=>{
      await this.validatedContext({ownerId,taskContext,adapterId,expectedContextGeneration:context.generation});
      if(this.reauthorize)await this.reauthorize(client,['planning:write',adapterId==='relay_workspace'?'files:read':'browser:read']);
      signal?.throwIfAborted();
    },host)});
    result.contentItems.push({type:'inputText',text:JSON.stringify({taskVerification:{taskId:context.taskId,taskBound:true,status:result.success?'observed':'observation-failed',successDelta:null,reason:'A scoped observation is not proof of a new business outcome.'}})});
    return result;
  }
  create(args){return this.outcomes.create(args);}
  async read(args){await this.syncCanonicalPlan(args);return this.outcomes.read(args);}
  update(args){return this.outcomes.update(args);}
  async measure(args){await this.syncCanonicalPlan(args);return this.outcomes.measure(args);}
  close(){return this.outcomes.close();}
  handler(ownerId,signal,client){return createBrowserToolHandler({browser:this.browser,owner:connectorBrowserOwner(ownerId),signal,maxCalls:1,beforeDispatch:async()=>{if(this.reauthorize)await this.reauthorize(client);signal?.throwIfAborted();}});}
  receiptIdentityMatches(receipt,identityFields) {
    const fields=receipt.format==='dom-text'?receipt.outcomeFields:receipt.identity?.map(i=>i.formField);
    return Array.isArray(fields)&&JSON.stringify([...new Set(fields)].sort())===JSON.stringify([...new Set(identityFields)].sort());
  }
  async retainBaseline({ownerId,taskId,binding,descriptor}){
    const id='baseline:'+binding.bindingId;
    if((await this.outcomes.readOperations({ownerId,taskId})).some(o=>o.id===id))return;
    await this.outcomes.retainOperation({ownerId,taskId,operation:{id,operationId:id,workItemId:binding.workItemId,bindingId:binding.bindingId,baseline:true,deliveryState:'observed',effectState:'unknown',commit:descriptor.commit,resources:descriptor.resources,startedAt:new Date().toISOString()}});
  }
  async bind(args, context = {}) {
    args = {...args, signal:context.signal || args.signal};
    const {ownerId,taskId,tabId,criterionId,workItemId,identityFields,ref,expectedUrl,expectedDocumentId,signal}=args;
    await this.syncCanonicalPlan({ownerId,taskId,signal});
    const handler=this.handler(ownerId,signal,context.client);
    const call={name:'relay_browser',arguments:{action:'click',browser:'relay',tabId,ref,expectedUrl,expectedDocumentId}};
    const descriptor=await handler.describeOperation(call,{signal});
    const semantic=observedSemanticIdentity(descriptor,identityFields),bindingId=semanticOutcomeKey(semantic);
    const task=await this.outcomes.read({ownerId,taskId});
    const criterion=task.contract.criteria.find(c=>c.id===criterionId);
    const receipts=receiptBindingsForCriterion(criterion).filter(r=>descriptor.resources.some(resource=>[resource.key,...(resource.scopeKeys||[])].includes(r.resourceKey)));
    // Extraction identity must cover exactly the declared business identity. A shared endpoint
    // must include the target/requisition/order identity, not just the person submitting.
    if(!receipts.length||receipts.some(receipt=>!this.receiptIdentityMatches(receipt,identityFields)))throw fail('Receipt identity fields must exactly match business identity fields.');
    const binding=await this.outcomes.bind({ownerId,taskId,bindingId,semantic,identityFields,criterionId,workItemId,tabId});
    await this.retainBaseline({ownerId,taskId,binding,descriptor});
    await this.outcomes.bindTab({ownerId,taskId,tabId,bindingId});
    return binding;
  }
  async evidence({ownerId,taskId,binding,handler,call,descriptor,result,phase,operationId,signal}) {
    const task=await this.outcomes.read({ownerId,taskId});
    const activeCriteria=task.contract.criteria.filter(c=>c.id===binding.criterionId);
    // Receipt format changes cannot silently redefine the established business identity.
    for(const criterion of activeCriteria)for(const receipt of receiptBindingsForCriterion(criterion))
      if(descriptor.resources.some(resource=>[resource.key,...(resource.scopeKeys||[])].includes(receipt.resourceKey)) && !this.receiptIdentityMatches(receipt,binding.identityFields))
        throw fail('Refined receipt identity differs from the established business identity policy.','DIRECT_OUTCOME_IDENTITY_POLICY');
    const operations=await this.outcomes.readOperations({ownerId,taskId});
    const related=operations.filter(o=>o.bindingId===binding.bindingId);
    // Raw adapter facts remain immutable and retain their ORIGINAL native effect key.
    // Semantic projections are separate; evolving receipt mappings cannot re-label old facts.
    const commitments=related.filter(o=>o.commit).map(o=>({...o,evidence:related.filter(sidecar=>sidecar.nativeReceipt && sidecar.nativeEffectKey===o.commit.effectKey).flatMap(sidecar=>sidecar.evidence)}));
    const native=await handler.normalizeOperationResult(result,{call,descriptor,signal,
      criteria:activeCriteria,
      commitments:commitments.filter(o=>!o.baseline),
      baselineCommitments:phase==='baseline'?commitments.filter(o=>o.baseline):[]});
    const accepted=[];
    const candidates=(native.evidence||[]).filter(e=>e.kind==='external-confirmation'&&e.confirmation?.effectKey);
    const meanings=new Map();
    for(const proof of candidates){const set=meanings.get(proof.confirmation.effectKey)||new Set();set.add(JSON.stringify(proof.confirmation));meanings.set(proof.confirmation.effectKey,set);}
    for(const raw of candidates) {
      if(meanings.get(raw.confirmation.effectKey).size!==1)continue;
      const rawMatches=related.filter(o=>o.commit?.effectKey===raw.confirmation.effectKey);
      if(!rawMatches.length || raw.validation?.adapter!=='relay_browser')continue;
      // Native normalized proof contains bounded digests/receipt metadata, never full forms or HTML.
      await this.outcomes.retainOperation({ownerId,taskId,operation:{id:'native-proof:'+hash([binding.bindingId,raw]),bindingId:binding.bindingId,nativeReceipt:true,nativeEffectKey:raw.confirmation.effectKey,evidence:[raw]}});
      if(phase==='outcome' && raw.confirmation.status==='absent' && !related.some(o=>o.baselineEvidence) && raw.validation?.source!=='host-correlated-native-form-text')continue;
      if(phase==='outcome' && related.some(o=>o.baselineEvidence && o.evidence.some(old=>
        old.digest===raw.digest || old.validation?.recordSourceDigest && old.validation.recordSourceDigest===raw.validation?.recordSourceDigest)))continue;
      if(raw.kind!=='external-confirmation'||!raw.confirmation?.effectKey)continue;
      const matches=related.filter(o=>o.commit?.effectKey===raw.confirmation.effectKey);
      if(!matches.length||raw.validation?.adapter!=='relay_browser')continue;
      // Only the native adapter may correlate observed destination records to actual form identity.
      const semantic=observedSemanticIdentity({effect:'commit',commit:matches[0].commit},binding.identityFields);
      if(semanticOutcomeKey(semantic)!==(binding.baseSemanticKey||binding.semanticKey))continue;
      const issuerOutcomeKey=typeof raw.validation?.rawOutcomeId==='string' && raw.validation.destinationKey===binding.semantic.resource
        ?hash([binding.baseSemanticKey||binding.semanticKey,raw.validation.rawOutcomeId]):null;
      const proof=normalizeContractEvidence({...raw,resourceKey:binding.semantic.resource,
        ...(issuerOutcomeKey?{validation:{...raw.validation,issuerOutcomeKey}}:{}),
        confirmation:{...raw.confirmation,...(binding.occurrence&&issuerOutcomeKey?{outcomeId:'issuer:'+issuerOutcomeKey}:{}),effectKey:binding.semanticKey,prior:phase==='baseline'||raw.confirmation.prior===true}},
        {operationId,workItemId:binding.workItemId,at:new Date().toISOString()});
      if(phase==='baseline')await this.outcomes.retainOperation({ownerId,taskId,operation:{id:'baseline-proof:'+proof.id,bindingId:binding.bindingId,baselineEvidence:true,evidence:[raw]}});
      const key=JSON.stringify([ownerId,taskId,proof.id]);this.proofs.set(key,proof);
      try{accepted.push(await this.outcomes.observe({ownerId,taskId,bindingId:binding.bindingId,evidenceId:proof.id,phase}));}
      finally{this.proofs.delete(key);}
    }
    return {accepted:accepted.length,measurement:await this.outcomes.measure({ownerId,taskId}),effectState:accepted.length?(accepted.at(-1).state?.state||'UNKNOWN').toLowerCase():'unknown'};
  }
  async reconcile({ownerId,taskId,tabId,bindingId,phase='outcome',signal,client,taskContext,observationHandler}, context = {}) {
    signal ||= context.signal;
    await this.syncCanonicalPlan({ownerId,taskId,signal});
    const current=await this.outcomes.resolveBinding({ownerId,tabId});
    if(!current||current.taskId!==taskId||current.binding.bindingId!==bindingId)throw fail('Select the current task-bound tab and semantic binding.');
    if(phase==='baseline' && current.binding.baseline.state!=='UNKNOWN')return {accepted:0,existing:true,baseline:current.binding.baseline,measurement:await this.outcomes.measure({ownerId,taskId})};
    const handler=observationHandler||this.handler(ownerId,signal,client||context.client),call={name:'relay_browser',arguments:{action:'read',browser:'relay',tabId}};
    const scope=await this.outcomes.readScope({ownerId,taskId,workItemId:current.binding.workItemId});
    const explicit=taskContext?await this.validatedContext({ownerId,taskContext,adapterId:'relay_browser'}):null;
    const descriptor=await handler.describeOperation(call,{signal}),result=await handler(call,{signal,operationDescriptor:descriptor,onOperationDispatch:async(_actual,host)=>this.canonicalAdmission({ownerId,taskId,signal},async()=>{
      await this.outcomes.validateScope({ownerId,taskId,workItemId:current.binding.workItemId,expectedScopeGeneration:scope.generation});
      if(explicit)await this.validatedContext({ownerId,taskContext,adapterId:'relay_browser',expectedContextGeneration:explicit.generation});
      if(this.reauthorize)await this.reauthorize(client||context.client,['planning:write','browser:read']);
    },host)});
    if(!result.success)throw fail('The host destination read failed or lost authorization. No outcome was reconciled; inspect the read failure before continuing.','DIRECT_TASK_RECONCILIATION_FAILED');
    return this.evidence({ownerId,taskId,binding:current.binding,handler,call,descriptor,result,phase,operationId:'reconcile:'+randomUUID(),signal});
  }
  async execute({ownerId,operationId,handler,call,signal,client,taskContext,observationHandler,nativeAttachment}) {
    const preliminary=taskContext?await this.outcomes.readContext({ownerId,taskContext}):call.arguments.tabId?await this.outcomes.resolveBinding({ownerId,tabId:call.arguments.tabId}):null;
    if(preliminary)await this.syncCanonicalPlan({ownerId,taskId:preliminary.taskId,signal});
    const explicit=taskContext?await this.validatedContext({ownerId,taskContext,adapterId:'relay_browser'}):null;
    let current=call.arguments.tabId?await this.outcomes.resolveBinding({ownerId,tabId:call.arguments.tabId}):null;
    if(explicit && current && (current.taskId!==explicit.taskId||current.binding.workItemId!==explicit.workItemId||current.binding.criterionId!==explicit.criterionId))throw fail('The tab is bound to a different task context. Explicitly bind the intended task first.','DIRECT_TASK_CONTEXT_MISMATCH');
    if(explicit && !current && explicit.binding && call.arguments.tabId){
      await this.outcomes.bindTab({ownerId,taskId:explicit.taskId,tabId:call.arguments.tabId,bindingId:explicit.binding.bindingId,expectedContext:null});
      current=await this.outcomes.resolveBinding({ownerId,tabId:call.arguments.tabId});
    }
    const scope=current?await this.outcomes.readScope({ownerId,taskId:current.taskId,workItemId:current.binding.workItemId}):null;
    const descriptor=await handler.describeOperation(call,{signal});
    if(explicit && descriptor.effect==='opaque')throw fail('This protected browser action has no reliable host effect classification. No action was dispatched.','DIRECT_TASK_OPAQUE');
    if(explicit)await this.contextScope({ownerId,context:explicit,descriptor});
    const ordinary=async()=>{
      const result=await handler(call,(explicit||current)?{signal,operationDescriptor:descriptor,onOperationDispatch:async(_actual,host)=>this.canonicalAdmission({ownerId,taskId:explicit?.taskId||current.taskId,signal},async()=>{
        if(current)await this.outcomes.validateScope({ownerId,taskId:current.taskId,workItemId:current.binding.workItemId,expectedScopeGeneration:scope.generation});
        if(explicit)await this.validatedContext({ownerId,taskContext,adapterId:'relay_browser',expectedContextGeneration:explicit.generation});
        if(this.reauthorize)await this.reauthorize(client,['planning:write',descriptor.effect==='observe'?'browser:read':'browser:write']);
      },host)}:{signal});
      if(result.success && descriptor.effect==='observe' && current?.unresolved){
        const verification=await this.evidence({ownerId,taskId:current.taskId,binding:current.binding,handler,call,descriptor,result,phase:'outcome',operationId:operationId||'reconcile:'+randomUUID(),signal});
        result.contentItems.push({type:'inputText',text:JSON.stringify({taskVerification:{taskId:current.taskId,taskBound:true,...verification}})});
      }
      return result;
    };
    // Reads and ordinary reversible interaction remain available for discovery/reconciliation.
    if(!current){
      if(descriptor.effect==='commit')throw fail('Create and bind a measurable task contract before a native destination commit.','DIRECT_TASK_REQUIRED');
      return ordinary();
    }
    const {taskId}=current; let {binding}=current;
    if(descriptor.effect==='opaque')throw fail('This action has no reliable host effect classification; it cannot safely execute in a protected task.','DIRECT_TASK_OPAQUE');
    if(descriptor.effect!=='commit')return ordinary();
    const semantic=observedSemanticIdentity(descriptor,binding.identityFields);
    if(semanticOutcomeKey(semantic)!==(binding.baseSemanticKey||binding.semanticKey)){
      const bindingId=semanticOutcomeKey(semantic);
      binding=await this.outcomes.bind({ownerId,taskId,bindingId,semantic,identityFields:binding.identityFields,criterionId:binding.criterionId,workItemId:binding.workItemId,tabId:call.arguments.tabId});
      await this.retainBaseline({ownerId,taskId,binding,descriptor});
      await this.outcomes.bindTab({ownerId,taskId,tabId:call.arguments.tabId,bindingId,expectedContext:{taskId:current.taskId,bindingId:current.binding.bindingId}});
    }
    // An initial authorized attempt need not prove issuer absence. The ledger
    // distinguishes no recorded effect from known uncertainty and confirmed effects.
    // Existing supported observations can strengthen evidence without a mandatory extra read.
    const task=await this.outcomes.read({ownerId,taskId}),work=task.contract.workItems.find(w=>w.id===binding.workItemId);
    if(!work?.effects?.includes('commit'))throw fail('The bound work item does not permit a commit.');
    const writes=descriptor.resources.filter(r=>!r.scopeOnly&&r.access==='write');
    if(!writes.every(r=>[r.key,...(r.scopeKeys||[])].some(k=>work.resourceKeys.includes(k))))throw fail('The observed write target lies outside the bound work item resource scope.','DIRECT_TASK_SCOPE');
    // Claim happens only in the browser host's final fresh-descriptor dispatch guard.
    let admitted=false;
    const result=await handler(call,{signal,operationDescriptor:descriptor,operationId,onOperationDispatch:async(_actual,host)=>this.canonicalAdmission({ownerId,taskId,signal},async()=>{
      if(explicit&&this.reauthorize)await this.reauthorize(client,['planning:write','browser:write']);
      const admission=await this.outcomes.admit({ownerId,taskId,bindingId:binding.bindingId,operationId,tabId:call.arguments.tabId,expectedScopeGeneration:scope.generation,...(nativeAttachment?{nativeAttachment}:{}),...(explicit?{taskContext,adapterId:'relay_browser',expectedContextGeneration:explicit.generation}:{})});
      if(!admission.admitted)throw fail('Destination commit blocked: '+admission.reason,admission.reason);
      admitted=true;
      await this.outcomes.retainOperation({ownerId,taskId,operation:{id:operationId,operationId,bindingId:binding.bindingId,workItemId:binding.workItemId,deliveryState:'dispatched',effectState:'unknown',commit:descriptor.commit,resources:descriptor.resources,startedAt:new Date().toISOString()}});
    },host)});
    if(admitted){
      const verification=await this.evidence({ownerId,taskId,binding,handler,call,descriptor,result,phase:'outcome',operationId,signal});
      result.contentItems.push({type:'inputText',text:JSON.stringify({taskVerification:{taskId,taskBound:true,...verification}})});
    }
    return result;
  }
}
