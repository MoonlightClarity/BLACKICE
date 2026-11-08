import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizePlanContract } from '../public/planning-contract-model.mjs';
import { normalizeContractEvidence } from './planning-contract-evidence.mjs';
import { contractWorkItemSignature } from './planning-contract-runtime.mjs';

const clone = value => structuredClone(value);
const fail = (message, code = 'DIRECT_OUTCOME_INVALID') => Object.assign(new Error(message), { code, status: 409 });
const text = (value, name, max = 2048) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw fail('Invalid ' + name);
  return value;
};
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const key = (...parts) => hash(JSON.stringify(parts));
const now = () => new Date().toISOString();
export function semanticOutcomeKey(semantic) {
  if (!semantic || Object.keys(semantic).sort().join(',') !== 'effect,resource,subject') throw fail('Semantic identity requires exactly effect, resource and host-derived subject.');
  return 'semantic:' + hash(canonical({ effect: text(semantic.effect,'effect'), resource: text(semantic.resource,'resource',4096), subject: text(semantic.subject,'host-derived subject',4096) }));
}
function normalizedEvidence(record) {
  if (!record || typeof record !== 'object') throw fail('Host evidence is unavailable.', 'DIRECT_OUTCOME_EVIDENCE_UNAVAILABLE');
  const { id, operationId, workItemId, at, ...input } = record;
  const normalized = normalizeContractEvidence(input, {operationId,workItemId,at});
  if (id !== normalized.id) throw fail('Host evidence identity does not match its contents.');
  return normalized;
}

/**
 * Host-owned outcome journal. Never expose observe/retainOperation as caller proof APIs.
 * resolveEvidence must resolve only verified native adapter evidence, already correlated
 * to the original operation and mapped to a host-derived semantic business identity.
 */
export class DirectTaskOutcomes {
  constructor({ dataDir, resolveEvidence = null, io = fs } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw fail('Use an absolute outcome directory.');
    this.directory = path.join(dataDir, 'direct-task-outcomes'); this.file = path.join(this.directory,'journal.json');
    this.lock = path.join(this.directory,'owner.lock'); this.io = io; this.resolveEvidence = resolveEvidence;
    this.token = randomUUID(); this.tail = Promise.resolve(); this.ready = null; this.closed = false; this.owned = false; this.storageError = null;
    this.state = {version:1,tasks:{},outcomes:{},evidence:{},contexts:{},taskContexts:{},nativeAttachments:{}};
  }
  async init() {
    return this.ready ||= (async () => {
      await this.io.mkdir(this.directory,{recursive:true});
      const info = await this.io.lstat(this.directory); if (!info.isDirectory() || info.isSymbolicLink()) throw fail('Unsafe outcome directory.');
      try {
        const h = await this.io.open(this.lock,'wx',0o600);
        try { await h.writeFile(JSON.stringify({pid:process.pid,token:this.token})); await h.sync(); } finally { await h.close(); }
        this.owned = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Never steal a live or ambiguous owner; restart recovery is explicit.
        let owner; try { owner = JSON.parse(await this.io.readFile(this.lock,'utf8')); } catch { throw fail('Outcome lock requires recovery.','DIRECT_OUTCOME_LOCKED'); }
        let dead = false; if (Number.isSafeInteger(owner.pid) && owner.pid > 0) { try { process.kill(owner.pid,0); } catch(e) { dead = e.code === 'ESRCH'; } }
        if (!dead) throw fail('Outcome journal already has an owner.','DIRECT_OUTCOME_LOCKED');
        // Exclusive recovery lock prevents two processes reclaiming the same stale lock.
        const recovery = this.lock + '.recovery'; let handle;
        try {
          handle = await this.io.open(recovery,'wx',0o600);
          const again = JSON.parse(await this.io.readFile(this.lock,'utf8'));
          if (again.pid !== owner.pid || again.token !== owner.token) throw fail('Outcome lock changed.','DIRECT_OUTCOME_LOCKED');
          await this.io.unlink(this.lock);
          const h = await this.io.open(this.lock,'wx',0o600);
          try { await h.writeFile(JSON.stringify({pid:process.pid,token:this.token})); await h.sync(); } finally { await h.close(); }
          this.owned = true;
        } finally { if (handle) { await handle.close(); await this.io.unlink(recovery); } }
      }
      try {
        let raw; try { const info = await this.io.lstat(this.file); if (!info.isFile() || info.isSymbolicLink() || info.size > 16*1024*1024) throw fail('Unsafe outcome journal.'); raw = await this.io.readFile(this.file,'utf8'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
        if (raw) { const value=JSON.parse(raw); value.contexts ||= {}; value.taskContexts ||= {}; value.nativeAttachments ||= {}; this.validate(value); this.state=value; }
        // Pending UNKNOWN claims deliberately survive restart unchanged.
        return this;
      } catch(e) { this.storageError=e; await this.release(); throw e; }
    })();
  }
  validate(value) {
    if (!value || value.version!==1 || !value.tasks || !value.outcomes || !value.evidence) throw fail('Invalid outcome journal.','DIRECT_OUTCOME_STORAGE');
    if(!value.contexts || typeof value.contexts!=='object' || Array.isArray(value.contexts))throw fail('Invalid task contexts.');
    for(const [id,c] of Object.entries(value.contexts)){if(id!==key(c.ownerId,c.tabId)||!value.tasks[key(c.ownerId,c.taskId)]?.bindings[c.bindingId])throw fail('Invalid task context binding.');}
    if(!value.taskContexts || typeof value.taskContexts!=='object' || Array.isArray(value.taskContexts))throw fail('Invalid explicit contexts.');
    for(const [id,c] of Object.entries(value.taskContexts)){
      text(c.ownerId,'context owner',240);text(c.taskId,'context task',240);text(c.workItemId,'context work',240);text(c.criterionId,'context criterion',240);
      const t=value.tasks[key(c.ownerId,c.taskId)];
      if(id!==c.taskContext || !/^taskctx_[a-f0-9-]{36}$/.test(id) || !t || !Number.isSafeInteger(c.generation) || c.generation<1 || !/^[a-f0-9]{64}$/.test(c.contractDigest) ||
        !Array.isArray(c.adapters) || !c.adapters.length || c.adapters.some(a=>!['relay_browser','relay_workspace'].includes(a)) ||
        !Array.isArray(c.identityFields) || c.identityFields.some(v=>typeof v!=='string') ||
        !(c.bindingId===null || typeof c.bindingId==='string' && t.bindings[c.bindingId]) ||
        c.bindingId && (t.bindings[c.bindingId].workItemId!==c.workItemId || t.bindings[c.bindingId].criterionId!==c.criterionId || canonical(t.bindings[c.bindingId].identityFields)!==canonical(c.identityFields)) ||
        !c.bindingId && c.identityFields.length || c.invalidatedAt!==undefined && typeof c.invalidatedAt!=='string' ||
        !(c.revokedAt===null || typeof c.revokedAt==='string'))throw fail('Invalid explicit context record.');
    }
    if(!value.nativeAttachments || typeof value.nativeAttachments!=='object' || Array.isArray(value.nativeAttachments))throw fail('Invalid native attachments.');
    for(const [id,a] of Object.entries(value.nativeAttachments)){
      const c=value.taskContexts[a.taskContext];
      if(id!==key(a.nativeTaskId) || !c || c.ownerId!==a.ownerId || c.taskId!==a.taskId ||
        !Number.isSafeInteger(a.nativeRevision)||a.nativeRevision<1 || !Number.isSafeInteger(a.generation)||a.generation<1 ||
        !Number.isSafeInteger(a.contextGeneration)||a.contextGeneration<1 || a.client?.id!==a.ownerId || !Array.isArray(a.client.scopes))
        throw fail('Invalid native attachment record.');
    }
    for (const [id,t] of Object.entries(value.tasks)) {
      if (id!==key(t.ownerId,t.taskId) || !Number.isSafeInteger(t.revision) || !t.bindings || !Array.isArray(t.operations)) throw fail('Invalid task journal.');
      normalizePlanContract(t.contract);
      if(t.source && (t.source.kind!=='task-state-v14'||typeof t.source.taskId!=='string'||!Number.isSafeInteger(t.source.revision)||t.source.revision<1||!/^[a-f0-9]{64}$/.test(t.source.contractDigest||'')))throw fail('Invalid canonical source journal.');
      if(t.scopes && Object.values(t.scopes).some(scope=>!Number.isSafeInteger(scope.generation)||scope.generation<1||!/^[a-f0-9]{64}$/.test(scope.signature||'')))throw fail('Invalid canonical scope journal.');
      for (const b of Object.values(t.bindings)) if ((b.occurrence ? b.baseSemanticKey!==semanticOutcomeKey(b.semantic) || b.semanticKey!=='occurrence:'+key(t.ownerId,b.baseSemanticKey,b.occurrence.userInstructionRef) || b.occurrence.provenance!=='authenticated-caller-attestation' || !b.occurrence.userInstructionQuote || !b.occurrence.reason || b.baseline.basis!=='authorized-occurrence' : b.semanticKey!==semanticOutcomeKey(b.semantic)) || !['UNKNOWN','ABSENT','CONFIRMED'].includes(b.baseline.state)) throw fail('Invalid binding journal.');
    }
    for (const [id,o] of Object.entries(value.outcomes)) if(id!==key(o.ownerId,o.semanticKey) || !['UNKNOWN','ABSENT','CONFIRMED'].includes(o.state)) throw fail('Invalid outcome record.');
    for (const [id,e] of Object.entries(value.evidence)) if(id!==key(e.ownerId,e.record.id) || normalizedEvidence(e.record).id!==e.record.id) throw fail('Invalid evidence record.');
  }
  async assertOwner() {
    const owner=JSON.parse(await this.io.readFile(this.lock,'utf8'));
    if(!this.owned || owner.pid!==process.pid || owner.token!==this.token) throw fail('Outcome journal ownership changed.','DIRECT_OUTCOME_LOCKED');
  }
  async release() {
    if(!this.owned)return;
    try {await this.assertOwner();await this.io.unlink(this.lock);} finally {this.owned=false;}
  }
  serial(fn) {
    if(this.closed)return Promise.reject(fail('Outcome journal is closed.'));
    const work=this.tail.catch(()=>{}).then(async()=>{await this.init();if(this.storageError)throw this.storageError;await this.assertOwner();return fn();});
    this.tail=work;return work;
  }
  async save(next) {
    this.validate(next);const bytes=JSON.stringify(next);if(Buffer.byteLength(bytes)>16*1024*1024)throw fail('Outcome journal is full; evidence was preserved.');
    const temp=this.file+'.'+randomUUID()+'.tmp';let h;
    try {
      await this.assertOwner();h=await this.io.open(temp,'wx',0o600);await h.writeFile(bytes);await h.sync();await h.close();h=null;
      await this.assertOwner();await this.io.rename(temp,this.file);this.state=next;
    } catch(e) {this.storageError=fail('Outcome persistence is uncertain; no effect may be admitted.','DIRECT_OUTCOME_STORAGE');this.storageError.cause=e;throw this.storageError;}
    finally {await h?.close().catch(()=>{});await this.io.unlink(temp).catch(()=>{});}
  }
  task(state,ownerId,taskId) {
    text(ownerId,'owner',240);text(taskId,'task',240);const t=state.tasks[key(ownerId,taskId)];
    if(!t)throw fail('Task is unavailable.','DIRECT_OUTCOME_NOT_FOUND');return t;
  }
  binding(state,args) { const t=this.task(state,args.ownerId,args.taskId),b=t.bindings[args.bindingId];if(!b)throw fail('Binding is unavailable.','DIRECT_OUTCOME_NOT_FOUND');return {t,b}; }
  async create({ownerId,taskId,contract}) {
    text(ownerId,'owner',240);text(taskId,'task',240);const normalized=normalizePlanContract(contract);
    return this.serial(async()=>{const id=key(ownerId,taskId),old=this.state.tasks[id];if(old){if(canonical(old.contract)!==canonical(normalized))throw fail('Task already has a different contract.');return clone(old);}
      const next=clone(this.state),t={ownerId,taskId,contract:normalized,revision:1,createdAt:now(),bindings:{},operations:[]};next.tasks[id]=t;await this.save(next);return clone(t);});
  }
  read({ownerId,taskId}) {return this.serial(()=>clone(this.task(this.state,ownerId,taskId)));}
  update({ownerId,taskId,contract,expectedRevision}) {
    const normalized=normalizePlanContract(contract);
    return this.serial(async()=>{const next=clone(this.state),t=this.task(next,ownerId,taskId);if(t.revision!==expectedRevision)throw fail('Task revision changed.');
      if(t.source)throw fail('Edit the saved canonical source plan, not its execution snapshot.','DIRECT_PLAN_SOURCE_AUTHORITY');
      if(Object.keys(t.bindings).length)throw fail('Bound contract cannot be retrofitted; retain original evidence and create a new task.');
      if(canonical(t.contract)!==canonical(normalized))for(const c of Object.values(next.taskContexts))if(c.ownerId===ownerId&&c.taskId===taskId)c.invalidatedAt ||= now();
      t.contract=normalized;t.revision++;await this.save(next);return clone(t);});
  }
  // Host-only canonical snapshots. The source adapter holds the native task transaction.
  readPlanSource({ownerId,taskId}) {
    text(ownerId,'owner',240);text(taskId,'task',240);
    return this.serial(()=>clone(this.state.tasks[key(ownerId,taskId)]?.source||null));
  }
  syncPlanSnapshot({ownerId,taskId,contract,source}) {
    text(ownerId,'owner',240);text(taskId,'task',240);
    const normalized=normalizePlanContract(contract);
    if(!source || source.kind!=='task-state-v14' || !Number.isSafeInteger(source.revision) || source.revision<1 ||
      !Number.isSafeInteger(source.planEpoch) || source.planEpoch<1 || !/^[a-f0-9]{64}$/.test(source.contractDigest||''))throw fail('Invalid canonical source snapshot.');
    text(source.taskId,'source task',240);
    if(source.contractDigest!==hash(canonical(normalized)))throw fail('Canonical source digest differs from snapshot.');
    return this.serial(async()=>{
      const next=clone(this.state),id=key(ownerId,taskId);
      let t=next.tasks[id];
      if(t?.source && (t.source.taskId!==source.taskId||t.source.kind!==source.kind))throw fail('Canonical source association is immutable.','DIRECT_PLAN_SOURCE_CHANGED');
      if(t?.source && source.revision<t.source.revision)throw fail('Canonical source revision regressed.','DIRECT_PLAN_SOURCE_STALE');
      if(t?.source && source.revision===t.source.revision){
        if(canonical(t.contract)!==canonical(normalized)||canonical(t.source)!==canonical(source))throw fail('Canonical revision changed contents.','DIRECT_PLAN_SOURCE_CHANGED');
        return clone(t);
      }
      if(!t)t=next.tasks[id]={ownerId,taskId,contract:normalized,revision:0,createdAt:now(),bindings:{},operations:[]};
      const previous=t.contract,scopes={...(t.scopes||{})};
      for(const work of [...previous.workItems,...normalized.workItems]){
        const signature=contractWorkItemSignature(normalized,work.id),oldSignature=contractWorkItemSignature(previous,work.id);
        const old=scopes[work.id]||{generation:1,signature:oldSignature};
        scopes[work.id]={signature,generation:old.generation+(old.signature===signature?0:1)};
      }
      // Never move old facts to a different criterion meaning. Retire removed scopes
      // without deleting their operations/outcomes; goal changes require new context.
      for(const old of previous.criteria){
        const fresh=normalized.criteria.find(c=>c.id===old.id);
        const retained=Object.values(t.bindings).some(b=>b.criterionId===old.id);
        if(retained && fresh && (fresh.kind!==old.kind || fresh.resourceKey && Object.values(t.bindings).some(b=>b.criterionId===old.id && b.semantic.resource!==fresh.resourceKey)))
          throw fail('An evidenced criterion cannot change business meaning. Preserve its ID and add a separate criterion.','DIRECT_PLAN_SEMANTIC_CHANGE');
      }
      t.sourceHistory ||= [];
      if(t.source && canonical(previous)!==canonical(normalized))t.sourceHistory.push({...clone(t.source),at:now()});
      // Compact source metadata only; immutable operations/evidence never roll off.
      t.sourceHistory=t.sourceHistory.slice(-256);
      t.source=clone(source);t.contract=normalized;t.scopes=scopes;t.revision++;
      for(const c of Object.values(next.taskContexts))if(c.ownerId===ownerId&&c.taskId===taskId){
        const signature=contractWorkItemSignature(normalized,c.workItemId),oldSignature=contractWorkItemSignature(previous,c.workItemId);
        if(signature!==oldSignature)c.generation++;
        c.contractDigest=hash(canonical(normalized));c.scopeSignature=signature;
        if(!normalized.workItems.find(w=>w.id===c.workItemId)?.criterionIds.includes(c.criterionId))c.invalidatedAt ||= now();
      }
      await this.save(next);return clone(t);
    });
  }
  readScope({ownerId,taskId,workItemId}) {
    return this.serial(()=>{const t=this.task(this.state,ownerId,taskId);return clone(t.scopes?.[workItemId]||{generation:1,signature:contractWorkItemSignature(t.contract,workItemId)});});
  }
  validateScope({ownerId,taskId,workItemId,expectedScopeGeneration}) {
    return this.serial(()=>{const t=this.task(this.state,ownerId,taskId),scope=t.scopes?.[workItemId]||{generation:1};
      if(scope.generation!==expectedScopeGeneration || !t.contract.workItems.some(w=>w.id===workItemId))throw fail('Canonical work changed before dispatch. Reobserve the current plan.','DIRECT_PLAN_SCOPE_CHANGED');
      return true;});
  }
  bind({ownerId,taskId,bindingId,semantic,identityFields=[],criterionId,workItemId,tabId}) {
    text(bindingId,'binding',240);if(['__proto__','constructor','prototype'].includes(bindingId))throw fail('Invalid binding ID.');text(tabId,'tab',240);text(criterionId,'criterion',240);text(workItemId,'work item',240);
    if(!Array.isArray(identityFields)||identityFields.length>20)throw fail('Invalid identity field selection.');
    identityFields=[...new Set(identityFields.map(v=>text(v,'identity field',256)))].sort();const semanticKey=semanticOutcomeKey(semantic);
    return this.serial(async()=>{
      const next=clone(this.state),t=this.task(next,ownerId,taskId),criterion=t.contract.criteria.find(c=>c.id===criterionId),work=t.contract.workItems.find(w=>w.id===workItemId);
      if(!criterion || criterion.kind!=='external-confirmation' || !work?.criterionIds?.includes(criterionId))throw fail('Binding must identify an external-confirmation criterion and its work item.');
      if(criterion.resourceKey && criterion.resourceKey!==semantic.resource)throw fail('Binding resource differs from criterion.');
      // Immutable persisted bindings are the owner/resource identity-policy journal.
      for(const priorTask of Object.values(next.tasks))if(priorTask.ownerId===ownerId)
        for(const priorBinding of Object.values(priorTask.bindings))
          if(priorBinding.semantic.resource===semantic.resource && canonical([...priorBinding.identityFields].sort())!==canonical(identityFields))
            throw fail('The established identity field policy for this destination cannot change across tasks.','DIRECT_OUTCOME_IDENTITY_POLICY');
      const spec={bindingId,semantic:clone(semantic),semanticKey,identityFields,criterionId,workItemId,tabId};
      const old=t.bindings[bindingId];if(old){for(const k of Object.keys(spec).filter(k=>k!=='tabId'))if(canonical(old[k])!==canonical(spec[k]))throw fail('Binding identity is immutable.');return clone(old);}
      const shared=next.outcomes[key(ownerId,semanticKey)];
      const b={...spec,baseline:{state:shared?.state==='CONFIRMED'?'CONFIRMED':'UNKNOWN',evidenceId:shared?.state==='CONFIRMED'?shared.evidenceId:null},createdAt:now(),claim:null,newOutcome:null};
      t.bindings[bindingId]=b;t.revision++;await this.save(next);return clone(b);
    });
  }
  bindTab({ownerId,taskId,tabId,bindingId,expectedContext}) {
    text(tabId,'tab',240);
    return this.serial(async()=>{
      const next=clone(this.state),{b}=this.binding(next,{ownerId,taskId,bindingId}),id=key(ownerId,tabId),previous=next.contexts[id];
      if(expectedContext===null && previous)throw fail('Task context appeared before explicit attachment.','DIRECT_OUTCOME_CONTEXT_CHANGED');
      if(expectedContext!==undefined && expectedContext!==null){
        if(!expectedContext || Object.keys(expectedContext).sort().join(',')!=='bindingId,taskId')throw fail('Use an exact expected task context.');
        text(expectedContext.taskId,'expected task',240);text(expectedContext.bindingId,'expected binding',240);
        if(!previous || previous.taskId!==expectedContext.taskId || previous.bindingId!==expectedContext.bindingId)
          throw fail('Task context changed before automatic target switching.','DIRECT_OUTCOME_CONTEXT_CHANGED');
      }
      if(previous && (previous.taskId!==taskId || previous.bindingId!==bindingId)){
        const old=this.binding(next,previous).b,claim=next.outcomes[key(ownerId,old.semanticKey)]?.claim;
        const sameScope=previous.taskId===taskId && old.workItemId===b.workItemId && old.criterionId===b.criterionId && canonical(old.identityFields)===canonical(b.identityFields);
        const pendingTask=previous.taskId!==taskId && Object.values(next.outcomes).some(o=>o.ownerId===ownerId&&o.claim?.taskId===previous.taskId);
        if(pendingTask || claim&&!sameScope)throw fail('Cannot replace task scope while its effects remain unresolved.','DIRECT_OUTCOME_UNCERTAIN');
        // Same-scope independent targets retain old UNKNOWN claims and reserve target capacity.
      }
      next.contexts[id]={ownerId,taskId,tabId,bindingId};await this.save(next);return {taskId,binding:clone(b)};
    });
  }
  resolveBinding({ownerId,tabId}) {
    text(ownerId,'owner',240);text(tabId,'tab',240);
    return this.serial(()=>{const c=this.state.contexts[key(ownerId,tabId)];if(!c)return null;const b=this.binding(this.state,c).b,claim=this.state.outcomes[key(ownerId,b.semanticKey)]?.claim;return {taskId:c.taskId,binding:clone(b),unresolved:Boolean(claim&&claim.taskId===c.taskId&&claim.bindingId===b.bindingId)};});
  }

  context(state,{ownerId,taskContext,adapterId,expectedContextGeneration,allowInvalid=false}) {
    text(ownerId,'owner',240);text(taskContext,'task context',100);
    const c=state.taskContexts[taskContext];
    if(!c || c.ownerId!==ownerId)throw fail('Task context is unavailable.','DIRECT_CONTEXT_NOT_FOUND');
    const t=this.task(state,ownerId,c.taskId);
    if(!allowInvalid){
      if(c.revokedAt)throw fail('Task context was revoked.','DIRECT_CONTEXT_REVOKED');
      if(c.invalidatedAt || c.contractDigest!==hash(canonical(t.contract)))throw fail('Task contract changed; issue a fresh context.','DIRECT_CONTEXT_STALE');
      if(expectedContextGeneration!==undefined && c.generation!==expectedContextGeneration)throw fail('Task context generation changed.','DIRECT_CONTEXT_STALE');
      if(adapterId!==undefined && !c.adapters.includes(adapterId))throw fail('Adapter is not supported by this context.','DIRECT_CONTEXT_ADAPTER');
      const w=t.contract.workItems.find(w=>w.id===c.workItemId);
      if(!w?.criterionIds.includes(c.criterionId))throw fail('Context work scope changed.','DIRECT_CONTEXT_STALE');
    }
    return {c,t};
  }

  // Host-only: the native bridge verifies saved task revision/inactivity and explicit authority.
  attachNativeTask({ownerId,taskContext,nativeTaskId,nativeRevision,client}) {
    text(nativeTaskId,'native task',240);
    if(!Number.isSafeInteger(nativeRevision)||nativeRevision<1)throw fail('Use the exact saved native task revision.');
    if(!client || client.id!==ownerId || !Array.isArray(client.scopes) || client.scopes.some(s=>!['read','files:read','files:write','commands:run','browser:read','browser:write','planning:write'].includes(s)))
      throw fail('Use an authenticated owner-scoped native attachment.','DIRECT_CONTEXT_PRINCIPAL');
    const retained={id:ownerId,scopes:[...new Set(client.scopes)].sort(),
      ...(typeof client.kind==='string'?{kind:text(client.kind,'client kind',100)}:{}),
      ...(typeof client.label==='string'?{label:text(client.label,'client label',160)}:{}),
      ...(typeof client.grantId==='string'?{grantId:text(client.grantId,'grant ID',240)}:{})};
    return this.serial(async()=>{
      const next=clone(this.state),{c}=this.context(next,{ownerId,taskContext}),id=key(nativeTaskId),old=next.nativeAttachments[id];
      if(old && old.ownerId!==ownerId)throw fail('Native task already belongs to another explicit principal.','DIRECT_CONTEXT_PRINCIPAL');
      if(old && !old.detachedAt && old.taskContext===taskContext && old.nativeRevision===nativeRevision && canonical(old.client)===canonical(retained))return clone(old);
      const oldContext=old?next.taskContexts[old.taskContext]:null;
      const sameScope=oldContext && oldContext.taskId===c.taskId && oldContext.workItemId===c.workItemId && oldContext.criterionId===c.criterionId && canonical(oldContext.identityFields)===canonical(c.identityFields);
      if(old && !sameScope && Object.values(next.outcomes).some(o=>o.ownerId===ownerId&&o.claim?.taskId===old.taskId))
        throw fail('Reconcile the attached task uncertain effects before replacement.','DIRECT_OUTCOME_UNCERTAIN');
      if(!old && Object.keys(next.nativeAttachments).length>=4096)throw fail('Native attachment journal is full.');
      const mapping={nativeTaskId,nativeRevision,ownerId,taskContext,contextGeneration:c.generation,contractDigest:c.contractDigest,taskId:c.taskId,generation:(old?.generation||0)+1,client:retained,attachedAt:now(),history:old?[...(old.history||[]),Object.fromEntries(Object.entries(old).filter(([k])=>k!=='history'))]:[]};
      next.nativeAttachments[id]=mapping;await this.save(next);return clone(mapping);
    });
  }
  detachNativeTask({ownerId,nativeTaskId,expectedGeneration}) {
    text(nativeTaskId,'native task',240);
    if(!Number.isSafeInteger(expectedGeneration)||expectedGeneration<1)throw fail('Use the exact native attachment generation.','DIRECT_CONTEXT_ATTACHMENT_CHANGED');
    return this.serial(async()=>{
      const next=clone(this.state),id=key(nativeTaskId),old=next.nativeAttachments[id];
      if(!old || old.ownerId!==ownerId)throw fail('Native attachment is not owned by this principal.','DIRECT_CONTEXT_PRINCIPAL');
      if(old.generation!==expectedGeneration || old.detachedAt)throw fail('Native attachment changed; read it again.','DIRECT_CONTEXT_ATTACHMENT_CHANGED');
      const {history=[],...prior}=old;
      const mapping={...old,generation:old.generation+1,detachedAt:now(),history:[...history,prior]};
      next.nativeAttachments[id]=mapping;await this.save(next);return clone(mapping);
    });
  }
  readNativeAttachment({nativeTaskId}) {
    text(nativeTaskId,'native task',240);
    return this.serial(()=>{const mapping=this.state.nativeAttachments[key(nativeTaskId)];return clone(mapping&&!mapping.detachedAt?mapping:null);});
  }


  authorizeRepeat({ownerId,taskId,bindingId,userInstructionRef,userInstructionQuote,reason,acknowledgeUncertainty=false,uncertaintyStatement=null,tabId}) {
    text(userInstructionRef,'user instruction reference',1000);text(userInstructionQuote,'quoted user instruction',8000);text(reason,'repeat reason',2000);
    if(typeof acknowledgeUncertainty!=='boolean')throw fail('Use explicit uncertainty acknowledgement.');
    if(uncertaintyStatement!==null)text(uncertaintyStatement,'uncertainty statement',4000);
    if(tabId!==undefined)text(tabId,'tab',240);
    return this.serial(async()=>{
      const next=clone(this.state),{t,b:source}=this.binding(next,{ownerId,taskId,bindingId});
      const baseSemanticKey=semanticOutcomeKey(source.semantic),semanticKey='occurrence:'+key(ownerId,baseSemanticKey,userInstructionRef);
      const occurrenceBindingId=semanticKey;
      const attestation={userInstructionRef,userInstructionQuote,reason,acknowledgeUncertainty,uncertaintyStatement,provenance:'authenticated-caller-attestation'};
      for(const priorTask of Object.values(next.tasks))if(priorTask.ownerId===ownerId){
        const existing=Object.values(priorTask.bindings).find(b=>b.semanticKey===semanticKey);
        if(existing){
          if(priorTask.taskId!==taskId)throw fail('This user instruction already authorizes an occurrence in another owned task; recover that task instead of duplicating it.','DIRECT_REPEAT_ALREADY_BOUND');
          const {createdAt,...prior}=existing.occurrence;
          if(canonical(prior)!==canonical(attestation))throw fail('The same instruction reference cannot change its recorded repeat authorization.','DIRECT_REPEAT_PROVENANCE_CONFLICT');
          if(tabId!==undefined){
            const current=next.contexts[key(ownerId,tabId)];
            if(!current || current.taskId!==taskId || semanticOutcomeKey(this.binding(next,current).b.semantic)!==baseSemanticKey)throw fail('Select the current same-task target before authorizing its repeat.','DIRECT_REPEAT_TARGET');
            next.contexts[key(ownerId,tabId)]={ownerId,taskId,tabId,bindingId:existing.bindingId};await this.save(next);
          }
          return clone(existing);
        }
      }
      const priorRecords=[];
      for(const priorTask of Object.values(next.tasks))if(priorTask.ownerId===ownerId)for(const b of Object.values(priorTask.bindings))
        if(semanticOutcomeKey(b.semantic)===baseSemanticKey){const outcome=next.outcomes[key(ownerId,b.semanticKey)];if(outcome&&(outcome.state==='CONFIRMED'||outcome.claim))priorRecords.push(outcome);}
      if(!priorRecords.length)throw fail('There is no prior confirmed or uncertain effect requiring a deliberate repeat.','DIRECT_REPEAT_NOT_REQUIRED');
      if(priorRecords.some(o=>o.claim) && (!acknowledgeUncertainty || !uncertaintyStatement))
        throw fail('The earlier effect is uncertain. Record that uncertainty and the actual user instruction authorizing another occurrence; do not fabricate user acknowledgement.','DIRECT_REPEAT_UNCERTAINTY');
      if(tabId!==undefined){
        const current=next.contexts[key(ownerId,tabId)];
        if(!current || current.taskId!==taskId || semanticOutcomeKey(this.binding(next,current).b.semantic)!==baseSemanticKey)throw fail('Select the current same-task target before authorizing its repeat.','DIRECT_REPEAT_TARGET');
      }
      const shared=next.outcomes[key(ownerId,semanticKey)];
      if(shared)throw fail('Existing occurrence state cannot be reset. Recover its original instruction binding.','DIRECT_REPEAT_ALREADY_BOUND');
      const occurrence={...attestation,createdAt:now()};
      const b={bindingId:occurrenceBindingId,semantic:clone(source.semantic),semanticKey,baseSemanticKey,identityFields:clone(source.identityFields),criterionId:source.criterionId,workItemId:source.workItemId,tabId:tabId||source.tabId,
        baseline:{state:'ABSENT',basis:'authorized-occurrence',evidenceId:null,at:occurrence.createdAt},
        occurrence,createdAt:occurrence.createdAt,claim:null,newOutcome:null};
      t.bindings[b.bindingId]=b;t.revision++;
      // This is absence of dispatch for this new authorized occurrence, NOT issuer absence.
      next.outcomes[key(ownerId,semanticKey)]={ownerId,semanticKey,state:'ABSENT',claim:null,evidenceId:null,basis:'authorized-occurrence'};
      if(tabId!==undefined)next.contexts[key(ownerId,tabId)]={ownerId,taskId,tabId,bindingId:b.bindingId};
      await this.save(next);return clone(b);
    });
  }

  issueContext({ownerId,taskId,expectedRevision,workItemId,criterionId,adapters,bindingId=null}) {
    text(workItemId,'work item',240);text(criterionId,'criterion',240);
    if(!Array.isArray(adapters)||!adapters.length||adapters.length>2||new Set(adapters).size!==adapters.length||adapters.some(a=>!['relay_browser','relay_workspace'].includes(a)))throw fail('Select supported host adapters.','DIRECT_CONTEXT_ADAPTER');
    if(bindingId!==null)text(bindingId,'binding',240);
    return this.serial(async()=>{
      const next=clone(this.state),t=this.task(next,ownerId,taskId);
      if(t.revision!==expectedRevision)throw fail('Read the current task revision before issuing context.','DIRECT_CONTEXT_STALE');
      if(!t.contract.workItems.find(w=>w.id===workItemId)?.criterionIds.includes(criterionId))throw fail('Context must select a criterion of its work item.');
      const b=bindingId===null?null:t.bindings[bindingId];
      if(bindingId!==null && (!b || b.workItemId!==workItemId || b.criterionId!==criterionId))throw fail('Context binding differs from requested work scope.');
      if(Object.keys(next.taskContexts).length>=4096)throw fail('Task context journal is full.');
      const c={taskContext:'taskctx_'+randomUUID(),ownerId,taskId,contractDigest:hash(canonical(t.contract)),generation:1,workItemId,criterionId,
        adapters:[...adapters].sort(),bindingId,identityFields:b?[...b.identityFields]:[],createdAt:now(),revokedAt:null};
      next.taskContexts[c.taskContext]=c;await this.save(next);return clone(c);
    });
  }
  readContext({ownerId,taskContext}) {
    return this.serial(()=>{const {c,t}=this.context(this.state,{ownerId,taskContext,allowInvalid:true});return {...clone(c),valid:!c.revokedAt&&!c.invalidatedAt&&c.contractDigest===hash(canonical(t.contract)),binding:c.bindingId?clone(t.bindings[c.bindingId]):null};});
  }
  validateContext(args) {
    return this.serial(()=>{const {c,t}=this.context(this.state,args);return {...clone(c),binding:c.bindingId?clone(t.bindings[c.bindingId]):null};});
  }
  revokeContext({ownerId,taskContext,expectedGeneration}) {
    return this.serial(async()=>{
      const next=clone(this.state),{c}=this.context(next,{ownerId,taskContext,allowInvalid:true});
      if(c.generation!==expectedGeneration)throw fail('Task context generation changed.','DIRECT_CONTEXT_STALE');
      if(!c.revokedAt){c.revokedAt=now();c.generation++;await this.save(next);}
      return clone(c);
    });
  }

  admit({ownerId,taskId,bindingId,operationId,readOnly=false,tabId,taskContext,adapterId,expectedContextGeneration,nativeAttachment,expectedScopeGeneration}) {
    text(operationId,'operation',512);if(typeof readOnly!=='boolean')throw fail('Use host-classified readOnly.');
    return this.serial(async()=>{
      const next=clone(this.state),{t,b}=this.binding(next,{ownerId,taskId,bindingId});
      if(expectedScopeGeneration!==undefined && (t.scopes?.[b.workItemId]?.generation||1)!==expectedScopeGeneration)throw fail('Canonical work changed before admission.','DIRECT_PLAN_SCOPE_CHANGED');
      if(taskContext!==undefined){
        if(!adapterId)throw fail('Host adapter identity is required.','DIRECT_CONTEXT_ADAPTER');
        const {c}=this.context(next,{ownerId,taskContext,adapterId,expectedContextGeneration});
        if(c.taskId!==taskId || c.workItemId!==b.workItemId || c.criterionId!==b.criterionId)throw fail('Context does not cover this binding.','DIRECT_CONTEXT_SCOPE');
        if(!readOnly && (!c.bindingId || canonical(c.identityFields)!==canonical(b.identityFields)))throw fail('Context has no verified business identity policy.','DIRECT_CONTEXT_SCOPE');
      }
      if(nativeAttachment!==undefined){
        if(!nativeAttachment || Object.keys(nativeAttachment).sort().join(',')!=='generation,nativeTaskId' ||
          !Number.isSafeInteger(nativeAttachment.generation) || nativeAttachment.generation<1)
          throw fail('Use an exact native attachment generation.','DIRECT_CONTEXT_ATTACHMENT_CHANGED');
        text(nativeAttachment.nativeTaskId,'native task',240);
        const mapping=next.nativeAttachments[key(nativeAttachment.nativeTaskId)];
        if(!taskContext || !mapping || mapping.detachedAt || mapping.ownerId!==ownerId || mapping.taskId!==taskId ||
          mapping.taskContext!==taskContext || mapping.generation!==nativeAttachment.generation)
          throw fail('Native task attachment changed before dispatch.','DIRECT_CONTEXT_ATTACHMENT_CHANGED');
      }
      if(readOnly)return {admitted:true,observationOnly:true};
      if(tabId!==undefined){
        text(tabId,'tab',240);const context=next.contexts[key(ownerId,tabId)];
        if(!context || context.taskId!==taskId || context.bindingId!==bindingId)return {admitted:false,reason:'TASK_CONTEXT_CHANGED'};
      }
      const id=key(ownerId,b.semanticKey),shared=next.outcomes[id];
      if(shared?.state==='CONFIRMED')return {admitted:false,reason:'ALREADY_CONFIRMED',outcome:clone(shared)};
      if(shared?.claim)return {admitted:false,reason:'UNKNOWN_EFFECT',outcome:clone(shared)};
      const progress=criterionId=>{
        const bindings=Object.values(t.bindings).filter(item=>item.criterionId===criterionId);
        const completed=new Set(bindings.map(item=>item.newOutcome?.outcomeId).filter(Boolean)).size;
        const pending=new Set(bindings.filter(item=>{
          const outcome=next.outcomes[key(ownerId,item.semanticKey)],claim=outcome?.claim;
          return claim?.taskId===taskId && claim.bindingId===item.bindingId || outcome?.repeatAmbiguity===true && item.claim?.taskId===taskId && !item.newOutcome;
        }).map(item=>item.semanticKey)).size;
        const criterion=t.contract.criteria.find(item=>item.id===criterionId);
        return {completed,pending,target:criterion?.targetCount||1,satisfied:criterion?.kind==='external-confirmation'&&completed>=(criterion.targetCount||1)};
      };
      const work=t.contract.workItems.find(item=>item.id===b.workItemId);
      if(!work || !work.criterionIds.includes(b.criterionId) || !work.effects.includes('commit') || work.dependsOn.some(id=>{
        const dependency=t.contract.workItems.find(item=>item.id===id);
        return !dependency || !dependency.criterionIds.every(id=>progress(id).satisfied);
      }))return {admitted:false,reason:'PREREQUISITES_UNSATISFIED'};
      const count=progress(b.criterionId);
      if(count.completed>=count.target)return {admitted:false,reason:'TARGET_SATISFIED'};
      if(count.completed+count.pending>=count.target)return {admitted:false,reason:'TARGET_CAPACITY'};
      if(b.baseline.state!=='ABSENT' || shared?.state!=='ABSENT'){
        if(b.baseline.state==='UNKNOWN' && (!shared || shared.state==='ABSENT'&&!shared.claim))
          b.baseline={...b.baseline,basis:'no-recorded-host-effect'};
        else return {admitted:false,reason:'BASELINE_UNKNOWN'};
      }
      const claim={operationId,taskId,bindingId,at:now(),historyCoverage:b.baseline.state==='ABSENT'&&!b.occurrence?'issuer-absence-established':'not-established',
        novelty:b.occurrence?'distinct-recorded-issuer-outcome':b.baseline.state==='ABSENT'?'issuer-absence-established':'within-recorded-history'};
      next.outcomes[id]={ownerId,semanticKey:b.semanticKey,state:'UNKNOWN',claim,evidenceId:shared?.evidenceId||null};b.claim=claim;t.revision++;
      await this.save(next);return {admitted:true,semanticKey:b.semanticKey,claim:clone(claim)};
    });
  }
  // Host-only resolver, not inline evidence supplied by a connector caller.
  observe({ownerId,taskId,bindingId,evidenceId,phase='outcome'}) {
    text(evidenceId,'evidence ID',256);if(!['baseline','outcome'].includes(phase))throw fail('Invalid evidence phase.');
    return this.serial(async()=>{
      if(typeof this.resolveEvidence!=='function')throw fail('Host evidence resolver unavailable.','DIRECT_OUTCOME_EVIDENCE_UNAVAILABLE');
      const evidence=normalizedEvidence(await this.resolveEvidence({ownerId,taskId,evidenceId}));
      if(evidence.id!==evidenceId)throw fail('Resolved evidence ID differs.');
      const next=clone(this.state),{t,b}=this.binding(next,{ownerId,taskId,bindingId}),confirmation=evidence.confirmation;
      if(evidence.kind!=='external-confirmation'||evidence.resourceKey!==b.semantic.resource||confirmation.effectKey!==b.semanticKey||evidence.workItemId!==b.workItemId)throw fail('Evidence does not match bound semantic identity/resource/work item.');
      const eid=key(ownerId,evidence.id),previous=next.evidence[eid];
      if(previous){if(canonical(previous.record)!==canonical(evidence))throw fail('Evidence replay changed its observation.');return {accepted:true,replayed:true,state:clone(next.outcomes[key(ownerId,b.semanticKey)]||null)};}
      const id=key(ownerId,b.semanticKey),shared=next.outcomes[id],claim=shared?.claim;
      if(claim && evidence.at<claim.at)throw fail('Evidence predates the uncertain effect.');
      if(phase==='baseline' && b.claim)throw fail('Baseline is immutable after admission.');
      if(phase==='baseline' && claim)throw fail('Another task has an unresolved effect; reconcile it first.');
      next.evidence[eid]={ownerId,record:clone(evidence)};
      if(phase==='baseline'){
        if(b.baseline.state!=='UNKNOWN')throw fail('Baseline is already established.');
        b.baseline={state:confirmation.status==='confirmed'?'CONFIRMED':'ABSENT',evidenceId:evidence.id,at:evidence.at};
      }
      const equivalentPending=b.occurrence && Object.values(next.tasks).some(task=>task.ownerId===ownerId && Object.values(task.bindings).some(other=>
        other.semanticKey!==b.semanticKey && semanticOutcomeKey(other.semantic)===b.baseSemanticKey && next.outcomes[key(ownerId,other.semanticKey)]?.claim));
      const issuerOutcomeKey=/^[a-f0-9]{64}$/.test(evidence.validation?.issuerOutcomeKey||'')?evidence.validation.issuerOutcomeKey:null;
      const priorIssuer=o=>{
        if(o.issuerOutcomeKey)return o.issuerOutcomeKey;
        const saved=next.evidence[key(ownerId,o.evidenceId)]?.record,raw=saved?.validation?.rawOutcomeId;
        if(saved?.validation?.adapter!=='relay_browser' || typeof raw!=='string' || !raw)return null;
        let base=o.baseSemanticKey;
        if(!base)for(const task of Object.values(next.tasks))if(task.ownerId===ownerId){const prior=Object.values(task.bindings).find(v=>v.semanticKey===o.semanticKey);if(prior){base=semanticOutcomeKey(prior.semantic);break;}}
        return base?key(base,raw):null;
      };
      const sameIssuer=o=>o.state==='CONFIRMED' && (o.outcomeId===confirmation.outcomeId || issuerOutcomeKey && priorIssuer(o)===issuerOutcomeKey);
      const alreadyElsewhere=Object.values(next.outcomes).some(o=>o.ownerId===ownerId && o.semanticKey!==b.semanticKey && sameIssuer(o));
      if(shared?.state==='CONFIRMED'){
        // Reobserve only the same actual issuer record after earlier ambiguity resolves.
        if(b.occurrence && shared.repeatAmbiguity && !equivalentPending && phase==='outcome' && confirmation.status==='confirmed' && confirmation.prior===false && confirmation.outcomeId===shared.outcomeId && b.claim?.taskId===taskId){
          if(!alreadyElsewhere)b.newOutcome={outcomeId:confirmation.outcomeId,evidenceId:evidence.id,at:evidence.at,historyCoverage:b.baseline.state==='ABSENT'&&!b.occurrence?'issuer-absence-established':'not-established',novelty:b.occurrence?'distinct-recorded-issuer-outcome':b.baseline.state==='ABSENT'?'issuer-absence-established':'within-recorded-history'};
          shared.repeatAmbiguity=false;if(!alreadyElsewhere)shared.originTaskId=taskId;
        }
      } else if(confirmation.status==='absent'){
        next.outcomes[id]={ownerId,semanticKey:b.semanticKey,state:'ABSENT',claim:null,evidenceId:evidence.id};
      } else {
        const isNew=!equivalentPending && phase==='outcome' && claim?.taskId===taskId && claim.bindingId===bindingId && (b.baseline.state==='ABSENT'||b.baseline.basis==='no-recorded-host-effect') && confirmation.prior===false;
        const already=Object.values(next.outcomes).some(o=>o.ownerId===ownerId && sameIssuer(o));
        next.outcomes[id]={ownerId,semanticKey:b.semanticKey,state:'CONFIRMED',claim:null,evidenceId:evidence.id,outcomeId:confirmation.outcomeId,baseSemanticKey:semanticOutcomeKey(b.semantic),...(issuerOutcomeKey?{issuerOutcomeKey}:{}),confirmedAt:evidence.at,originTaskId:isNew&&!already?taskId:null,...(b.occurrence?{repeatAmbiguity:Boolean(equivalentPending)}:{})};
        if(isNew&&!already)b.newOutcome={outcomeId:confirmation.outcomeId,evidenceId:evidence.id,at:evidence.at,historyCoverage:b.baseline.state==='ABSENT'&&!b.occurrence?'issuer-absence-established':'not-established',novelty:b.occurrence?'distinct-recorded-issuer-outcome':b.baseline.state==='ABSENT'?'issuer-absence-established':'within-recorded-history'};
      }
      const observationConflict=shared?.state==='CONFIRMED' && (confirmation.status==='absent'||confirmation.outcomeId!==shared.outcomeId)
        ?{kind:'current-observation-differs-from-historical-confirmation',evidenceId:evidence.id,status:confirmation.status,historicalOutcomeId:shared.outcomeId,observedOutcomeId:confirmation.outcomeId||null}:null;
      if(observationConflict){b.observationConflicts ||= [];b.observationConflicts.push(observationConflict);}
      t.revision++;await this.save(next);return {accepted:true,replayed:false,state:clone(next.outcomes[id]),...(observationConflict?{observationConflict}:{})};
    });
  }
  retainOperation({ownerId,taskId,operation}) {
    if(!operation || typeof operation!=='object'||Array.isArray(operation)||Buffer.byteLength(JSON.stringify(operation))>65536)throw fail('Use bounded host operation metadata.');
    text(operation.id,'operation ID',512);
    return this.serial(async()=>{const next=clone(this.state),t=this.task(next,ownerId,taskId),prior=t.operations.find(o=>o.id===operation.id);
      if(prior){if(canonical(prior)!==canonical(operation))throw fail('Operation identity already retained.');return clone(prior);}
      if(t.operations.length>=512)throw fail('Task operation context is full; old evidence was retained.');
      t.operations.push(clone(operation));t.revision++;await this.save(next);return clone(operation);});
  }
  readOperations({ownerId,taskId}) {return this.serial(()=>clone(this.task(this.state,ownerId,taskId).operations));}
  measure({ownerId,taskId}) {return this.serial(()=>{
    const t=this.task(this.state,ownerId,taskId),criteria=t.contract.criteria.map(c=>{
      const bindings=Object.values(t.bindings).filter(b=>b.criterionId===c.id),outcomes=new Set(bindings.map(b=>b.newOutcome?.outcomeId).filter(Boolean));
      const targetCount=c.targetCount||1,observedCount=outcomes.size;
      return {id:c.id,targetCount,observedCount,satisfied:c.kind==='external-confirmation'&&observedCount>=targetCount,evidenceIds:bindings.map(b=>b.newOutcome?.evidenceId).filter(Boolean),outcomes:bindings.filter(b=>b.newOutcome).map(b=>({outcomeId:b.newOutcome.outcomeId,novelty:b.newOutcome.novelty||(b.baseline.state==='ABSENT'?'issuer-absence-established':'within-recorded-history'),historyCoverage:b.newOutcome.historyCoverage||(b.baseline.state==='ABSENT'?'issuer-absence-established':'not-established')})),observationConflicts:bindings.flatMap(b=>b.observationConflicts||[]),unknownBaselines:bindings.filter(b=>b.baseline.state==='UNKNOWN').length,authorizedOccurrenceCount:bindings.filter(b=>b.occurrence).length,repeatAmbiguities:bindings.filter(b=>this.state.outcomes[key(ownerId,b.semanticKey)]?.repeatAmbiguity).length,unresolvedEffects:bindings.filter(b=>this.state.outcomes[key(ownerId,b.semanticKey)]?.claim).length,reason:c.kind==='external-confirmation'?'Only distinct host-confirmed outcomes with adequate evidence count. Authorized occurrence baselines record new intent, not issuer absence; explicit acknowledgement alone never proves new progress.':'This component does not evaluate non-effect criteria.'};
    });return {taskId,revision:t.revision,criteria,satisfied:criteria.every(c=>c.satisfied)};});}
  async close(){this.closed=true;await this.tail.catch(()=>{});if(this.ready)await this.ready.catch(()=>{});await this.release();}
}
