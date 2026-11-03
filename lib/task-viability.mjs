import { createHash } from 'node:crypto';
import { planningNodeSources,planningCycleStageContext } from '../public/planning-browser-model.mjs';
import { evaluateViabilityResponse } from '../public/task-viability-model.mjs';
import { createKnowledgeToolHandler, KNOWLEDGE_LIMITS } from './knowledge.mjs';
import { workbenchAgentToolForAuthorization } from './workbench-agent-tools.mjs';

const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const fail = (message, code = 'TASK_VIABILITY_REQUIRED', status = 409, detail = {}) => Object.assign(new Error(message), { code, status, ...detail });
const text = value => typeof value === 'string' ? value : '';
const userRequestRows = rows => (Array.isArray(rows) ? rows : []).filter(row => row?.source === 'user-request' && typeof row.runId === 'string' && typeof row.text === 'string').map(row => ({
  source: 'user-request', runId: row.runId, text: row.text,
  ...Object.fromEntries(['key','at','messageIndex','textLength','textOffset','truncated'].filter(key => row[key] !== undefined).map(key => [key, clone(row[key])]))
}));
function boundedContinuityRow(record, budget) {
  const body = text(record.text), item = { ...record, text: body, textLength: Math.max(Number(record.textLength) || 0, body.length), textOffset: Number(record.textOffset) || 0, truncated: record.truncated === true };
  if (canonical(item).length <= budget) return item;
  item.truncated = true;
  let low = 0, high = Math.min(body.length, Math.max(0, budget));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (canonical({ ...item, text: body.slice(0, middle) }).length <= budget) low = middle; else high = middle - 1;
  }
  item.text = body.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
  return canonical(item).length <= budget ? item : null;
}
function boundedContinuityRows(rows, budget) {
  const result = []; let remaining = budget - 2;
  for (const [index, row] of rows.entries()) {
    const item = boundedContinuityRow(row, Math.floor(remaining / (rows.length - index)) - 1);
    if (item) { result.push(item); remaining -= canonical(item).length + 1; }
  }
  return result;
}
function continuitySnapshot(userRequests, observations, history) {
  const unique = new Map();
  for (const row of userRequestRows(userRequests)) {
    const key = row.key || row.runId + (Number.isSafeInteger(row.messageIndex) && row.messageIndex >= 0 ? ':message:' + row.messageIndex : '');
    const old = unique.get(key);
    if (!old || (old.truncated && !row.truncated) || row.text.length > old.text.length) unique.set(key, row);
  }
  const users = [...unique.values()].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || (a.messageIndex ?? -1) - (b.messageIndex ?? -1));
  const selectedUsers = users.length > 16 ? [users[0], ...users.slice(-15)] : users;
  const orderedObservations = ['tool-receipt','task-state','agent-output'].flatMap(source => observations.filter(row => row.source === source));
  const result = { version: 1, userRequests: boundedContinuityRows(selectedUsers, 12000), userRequestCount: users.length,
    observations: boundedContinuityRows(orderedObservations.slice(0, 30), 18000), observationCount: orderedObservations.length, history, truncated: false };
  result.truncated = Boolean(history.queryTruncated || history.search?.truncated || history.search?.historyWindowTruncated || history.reads?.some(row => row.truncated)
    || result.userRequests.length < users.length || result.observations.length < orderedObservations.length || [...result.userRequests, ...result.observations].some(row => row.truncated));
  // The captured source must remain one bounded, parseable data record even
  // when a retained provider result carries unusually large metadata.
  while (canonical(result).length > 36000 && result.observations.length) { result.observations.pop(); result.truncated = true; }
  return result;
}
const NODE = 'viability';
const readinessNodeId = request => request.viability?.nodeId || NODE;
const actor = { type: 'host', id: 'task-readiness' };
const reference = request => {
  const node = request.nodes.find(item => item.id === readinessNodeId(request));
  return { requestId: request.id, responseId: node?.response?.id || null, nodeRevision: node?.revision || null, fingerprint: request.viability?.fingerprint || null };
};
export function viabilityDefinition(value) {
  return { input: text(value.input).trim(), cwd: value.cwd, workflow: clone(value.workflow), attachmentIds: [...(value.attachmentIds || [])].sort(),
    ...(value.workbench === true ? { workbench: true } : {}),
    ...(object(value.continuity) ? { continuity: clone(value.continuity) } : {}) };
}
export function viabilityFingerprint(value) { return hash(viabilityDefinition(value)); }
export function viabilityQuestions(request) {
  if (request.viability?.recoveryIssue?.message) return request.viability.recoveryIssue.message;
  const node = request.nodes.find(item => item.id === readinessNodeId(request)), readiness = node?.readiness?.viability;
  if (readiness?.state === 'needs_evidence' && readiness.issues?.length) return readiness.issues.join('\n') + '\nRecover the relevant source evidence before treating a personal fact as missing.';
  const facts = readiness?.blockingFacts || [];
  if (!facts.length) return readiness?.state === 'stale' ? 'The task inputs changed while the readiness check was running. Refresh the check before continuing.' : 'The readiness check needs usable source evidence before dependent work can continue.';
  return facts.map(fact => fact.resolution==='blocked'?'Blocked: '+fact.label+'. '+fact.diagnostic+'\nAffected work: '+fact.consequence+'\nRemedy: '+fact.remedy:fact.question + (fact.consequence ? '\nThis enables ' + fact.consequence.replace(/^[A-Z]/, letter => letter.toLowerCase()) : '')).join('\n\n');
}

/** One graph-backed assessment used by ordinary requests and unattended work. */
export class TaskViability {
  constructor({ store, runner, engine, attachments, identity, getSettings = () => ({}), conversations, onUpdated = () => {} } = {}) {
    if (!store?.runtimeWriter || !runner?.start) throw fail('Task readiness needs the Planning graph and response runtime.', 'TASK_VIABILITY_CONFIG', 500);
    Object.assign(this, { store, runner, engine, attachments, identity, getSettings, conversations, onUpdated });
    this.writer = store.runtimeWriter(); this.queues = new Map(); this.closed = false;
  }
  serialize(id, work) {
    if (this.closed) return Promise.reject(fail('Task readiness is closed.', 'TASK_VIABILITY_CLOSED', 503));
    const next = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(id, next); next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => {}); return next;
  }
  async captureContinuity(run, { signal } = {}) {
    signal?.throwIfAborted();
    if (run.metadata?.managedBy === 'operations') return undefined;
    const explicit = userRequestRows(run.priorUserRequests);
    if (explicit.length) return continuitySnapshot(explicit, [], { status: 'explicit-continuation' });
    if (!this.engine?.listRuns) return undefined;
    const query = text(run.input).slice(0, KNOWLEDGE_LIMITS.queryChars), userRequests = [], observations = [];
    const history = { status: 'captured', query, queryTruncated: query.length < text(run.input).length, reads: [] };
    try {
      // Search and reads share one retained-run snapshot. Later source refresh
      // renders this capture instead of silently changing the assessed task.
      const runs = clone(await this.engine.listRuns()); signal?.throwIfAborted();
      const handler = createKnowledgeToolHandler({ getRuns: () => runs, cwd: run.cwd, runId: run.id, signal });
      const read = async args => JSON.parse((await handler({ name: 'relay_history', arguments: args })).contentItems.find(item => item.type === 'inputText').text);
      const found = await read({ action: 'search', query, limit: 6 });
      history.search = { ...found, results: found.results.map(row => ({ id: row.id, partialMatch: row.partialMatch, matchedTerms: row.matchedTerms, missingTerms: row.missingTerms })) };
      for (const match of found.results) {
        const captured = await read({ action: 'read', id: match.id, query, limit: 3 }), prior = captured.run, original = runs.find(row => row.id === prior.id);
        history.reads.push({ runId: prior.id, status: text(prior.status).slice(0, 100), createdAt: text(prior.createdAt).slice(0, 100), priorUserRequestCount: prior.priorUserRequestCount, toolReceiptCount: prior.toolReceiptCount, matchingToolReceipts: prior.matchingToolReceipts, truncated: captured.truncated });
        userRequests.push(...userRequestRows(prior.priorUserRequests), { source: 'user-request', key: prior.id, runId: prior.id, at: prior.createdAt, messageIndex: -1, text: prior.input,
          textLength: text(original?.input).length, truncated: prior.input.length < text(original?.input).length });
        observations.push(...(prior.toolReceipts || []).map(row => ({ ...row, source: 'tool-receipt' })));
        if (prior.taskGoal) observations.push({ ...prior.taskGoal, source: 'task-state', runId: prior.id });
        if (prior.output) observations.push({ source: 'agent-output', runId: prior.id, at: prior.finishedAt, text: prior.output,
          textLength: text(original?.output).length, truncated: prior.output.length < text(original?.output).length });
        for (const node of prior.nodes || []) if (node.output && node.output !== prior.output) observations.push({ source: 'agent-output', runId: prior.id, nodeId: node.id, status: node.status, text: node.output,
          textLength: text(original?.nodes?.[node.id]?.output).length, truncated: node.output.length < text(original?.nodes?.[node.id]?.output).length });
      }
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') throw error;
      history.status = userRequests.length ? 'partial' : 'unavailable';
      history.error = { message: text(error.message).slice(0, 1000), ...(error.code ? { code: text(error.code).slice(0, 120) } : {}) };
    }
    return continuitySnapshot(userRequests, observations, history);
  }
  async sources(definition, { signal } = {}) {
    const records = [], append = (id, kind, title, value, extra = {}) => {
      const body = text(value); const chunks = Math.max(1, Math.ceil(body.length / 38000));
      if (chunks > 8 || records.length + chunks > 100) throw fail('The supplied task records exceed the bounded readiness context. Select the relevant records before checking.', 'TASK_VIABILITY_SOURCE_CAPACITY', 413);
      for (let part = 0; part < chunks; part++) {
        const content = body.slice(part * 38000, (part + 1) * 38000);
        records.push({ id: id + (chunks > 1 ? ':' + part : ''), kind, title: title.slice(0, 230), text: content, contentHash: hash(content), ...extra });
      }
    };
    append('viability:task', 'user_input', 'Requested task', definition.input);
    append('viability:workflow', 'source', 'Actual workflow and available agent assignments', canonical(definition.workflow));
    if (this.engine?.workbench) {
      // Capability discovery is host evidence, not a claim that guest work ran.
      // Never infer a control grant from prompt text or include private tokens.
      // Ordinary planning must not wait on an unrelated cold Hyper-V/SMB probe.
      // Keep the real tool catalog discoverable; an explicit VM task still
      // collects its actual guest/viewer state before dependent operations.
      let guest={availability:'not-probed',reason:'No VM task control grant was attached. Query the attached status tool when VM state is relevant; this is not evidence of an unavailable VM or a blocker for independent work.'},viewer;
      if(definition.workbench===true){
      try {
        const state = await this.engine.workbench.status();
        signal?.throwIfAborted();
        const privileges=state.guest?.agent?.privileges;
        guest = { vmName: state.vmName, running: state.guest?.running === true,
          paired: state.guest?.agent?.paired === true, guestExecutionAvailable: state.canRunNativeApps === true,
          hostRights:{canManageVM:typeof state.capability?.canManageVM==='boolean'?state.capability.canManageVM:null,processElevated:typeof state.capability?.processElevated==='boolean'?state.capability.processElevated:null,meaning:'Host rights do not elevate the guest.'},
          guestPrivileges:privileges?.basis==='interactive-guest-agent-token'&&typeof privileges.administratorToken==='boolean'?{known:true,basis:privileges.basis,administratorToken:privileges.administratorToken}:{known:false,basis:'not-reported'},
          consoleControl:state.consoleControl?{owner:state.consoleControl.owner,revision:state.consoleControl.revision}:{owner:'unknown',revision:null} };
        if(typeof this.engine.workbench.guestNativeConsoleStatus==='function'){
          try{
            const observed=await this.engine.workbench.guestNativeConsoleStatus();signal?.throwIfAborted();
            viewer=Object.fromEntries(['backendAttached','openAvailable','attached','connected','displayReady','windowVisible','uncertain'].filter(key=>typeof observed?.[key]==='boolean').map(key=>[key,observed[key]]));
            if(typeof observed?.code==='string')viewer.code=observed.code.slice(0,120);
          }catch(error){if(signal?.aborted||error.name==='AbortError'||error.code==='ABORT_ERR')throw error;viewer={uncertain:true,code:String(error.code||'WORKBENCH_VIEWER_STATUS_UNAVAILABLE').slice(0,120)};}
        }
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') throw error;
        guest = { availability: 'unverified', reason: String(error.code || 'WORKBENCH_STATUS_UNAVAILABLE').slice(0, 120) };
      }
      }
      const actions=workbenchAgentToolForAuthorization(definition.workbench === true
        ? { scope: 'configured-vm', control: 'agent', source: 'explicit-user-task' } : undefined,this.engine.workbench).inputSchema.properties.action.enum;
      append('viability:workbench', 'source', 'Configured VM tools and task control authorization', canonical({
        tool: 'relay_workbench', scope: 'The existing configured Workbench guest VM only; guest scripts never execute on the host.',
        actions,
        guest,...(viewer?{viewer,viewerMeaning:'A closed viewer with an attached authorized opener can be a model-repairable prerequisite; inspect actual status and use only the attached operation. This snapshot opens nothing.'}:{}), explicitTaskControlGrant: definition.workbench === true,
        guestBrowserWork: 'An explicitly requested guest browser task can install and configure a browser inside this VM through relay_workbench. The contained host browser restriction does not prohibit that guest task.',
        evidence: 'Inspect status and actual guest job completion receipts. Process launch alone does not prove installation, configuration, or verification.',
        proofCapabilities:{
          version:1,meaning:'Host-described proof contracts, not completed checks or guaranteed model vision. Match prospective criteria to observations the attached workflow can actually obtain.',
          guestScript:{action:'verify_guest_script',contractExposed:actions.includes('verify_guest_script'),requiresCurrentAdoptedPlan:true,
            observations:'Read actual guest state or guest-accessible shared files and emit keyed primitive JSON. Predeclare current criterion assertions and poll the exact contained job for its terminal host-validated receipt.',
            operators:['equals','notEmpty','includes'],
            limits:'The receipt attests the captured script and comparisons. A literal success value, model-authored usability Boolean or exit zero does not establish the requested effect; this family does not observe host ownership or perform semantic image inspection.'},
          hostControl:{action:'verify_control_state',contractExposed:actions.includes('verify_control_state'),requiresCurrentAdoptedPlan:true,
            criterionSource:'Only the reserved host-owned restoration obligation supplied by the current handoff contract and status.handoffReadiness.eligibleDeferredControlCriteria.',
            paths:['control.owner','control.revision','control.authorizedReturn','control.featuresRestored'],
            timing:'Observe after actual authorized USER handback; only the host-owned obligation may be deferred before handback.'},
          nativeCapture:{action:'capture',contractExposed:actions.includes('capture'),retention:'retain:true returns the exact PNG and scoped artifact path, SHA256, dimensions, byte count and exact readback verification.',
            producesEffectReceipt:false,
            visualEvidence:'Inspect actual returned or retained pixels through an attached image-capable reader. Metadata, nonblack pixel counts or a window title alone do not establish a recognizable usable application.',
            preciseReadback:'When a separate exact file check matters, a guest verifier may independently read the retained shared PNG and compare its actual hash, size or dimensions with the host capture. That proves file observations; visual usability remains an evidence-based judgment.',
            planning:'Separate qualitative visual evidence from concrete file-readback effects when independently meaningful. Do not invent extra effects merely to obtain receipts or hardcode native-usability assertions.'}
        }
      }));
    }
    if (object(definition.continuity)) append('viability:continuity', 'source', 'Captured task continuity: user requests and separate observations', canonical(definition.continuity));
    if (this.identity?.read || this.identity?.snapshot) {
      let user;
      try {
        user = this.identity.read ? await this.identity.read('user') : (await this.identity.snapshot({ budgetChars: 120000 })).documents?.user;
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') throw error;
        throw fail('The saved user facts could not be read. Restore access to that record before deciding which personal facts are missing.', 'TASK_VIABILITY_SOURCE_UNREADABLE');
      }
      if (user?.warning) throw fail('The saved user facts need repair before their current contents can be used for readiness: ' + user.warning, 'TASK_VIABILITY_SOURCE_UNREADABLE');
      if (user?.truncated) throw fail('The saved user facts are incomplete. Read the full record before treating an absent personal fact as missing.', 'TASK_VIABILITY_SOURCE_INCOMPLETE');
      if (user?.content?.trim()) append('viability:profile', 'source', 'Previously recorded user facts', user.content);
    }
    for (const id of definition.attachmentIds || []) {
      signal?.throwIfAborted();
      try {
      const entry = await this.attachments?.get(id);
      if (!entry) throw fail('A supplied attachment is unavailable. Restore the file before checking the task.', 'TASK_VIABILITY_SOURCE_MISSING');
      if (['text', 'document', 'file'].includes(entry.kind)) {
        // Parse the ORIGINAL uploaded document before any model-led feasibility
        // decision. Historical opaque DOCX records are also readable here.
        const result = await this.attachments.text(id, { signal });
        if (!text(result.text).trim()) throw fail('The supplied file “' + entry.name + '” has no usable text. Restore its intended contents before deciding which facts are missing.', 'TASK_VIABILITY_SOURCE_INCOMPLETE');
        const wordSource = result.entry?.kind === 'document'
          ? 'Original attachment SHA256: ' + entry.sha256 + '\nReader: ' + result.entry.reader + '\nSource format: ' + result.entry.format + '\n\n' : '';
        append('viability:attachment:' + id, 'artifact', entry.name, wordSource + result.text);
      } else if (entry.kind === 'pdf') {
        let startPage = 1, count = 0; const parts = [];
        do {
          const result = await this.attachments.read(id, { startPage, pageCount: 5, signal });
          for (const page of result.pages || []) {
            if (!text(page.text).trim()) throw fail('A supplied PDF page has no usable extracted text. Inspect its rendered page before treating an essential fact as missing.', 'TASK_VIABILITY_SOURCE_INCOMPLETE');
            if (page.nextChar != null) throw fail('A PDF page was only partially read. Recover its complete relevant evidence before checking readiness.', 'TASK_VIABILITY_SOURCE_INCOMPLETE');
            parts.push('Page ' + (page.page || page.number || startPage) + '\n' + text(page.text));
          }
          if (!result.pages?.length) throw fail('This PDF has no usable extracted text. Read its rendered pages before treating a personal fact as missing.', 'TASK_VIABILITY_SOURCE_INCOMPLETE');
          startPage = result.nextPage; count++;
          if (count >= 20 && startPage) throw fail('This PDF exceeds the bounded readiness scan. Select its relevant pages first.', 'TASK_VIABILITY_SOURCE_CAPACITY', 413);
        } while (startPage);
        append('viability:attachment:' + id, 'artifact', entry.name, parts.join('\n\n'));
      } else throw fail('The supplied file “' + entry.name + '” needs its supported reader before task readiness can be assessed. Its contents have not been inspected, so no personal fact is being treated as missing.', 'TASK_VIABILITY_SOURCE_INCOMPLETE');
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.code?.startsWith('TASK_VIABILITY_SOURCE')) throw error;
        throw fail('A supplied attachment could not be read or verified. Restore that file before deciding which essential facts are missing.', 'TASK_VIABILITY_SOURCE_UNREADABLE');
      }
    }
    return records;
  }
  async ensure({ scope, scopeId, conversationId, definition, linkedRunId, deploymentId, pendingIntent, signal, requestId, beforeAssess }) {
    const fingerprint = viabilityFingerprint(definition), id = requestId || 'viability-' + hash([scope, scopeId, fingerprint]).slice(0,64);
    let request;
    try { request = await this.store.get(id); } catch (error) {
      if (error.code !== 'PLANNING_REQUEST_NOT_FOUND') throw error;
      const title=definition.input.trim().replace(/\s+/g,' ').slice(0,170);
      request = await this.store.create({ id, conversationId, title: (scope === 'deployment' ? 'Schedule · ' : '') + title, objective: definition.input.slice(0,12000), cwd: definition.cwd, clientRequestId: 'create-' + id }, { actor });
    }
    const readinessPrompt = 'Use the captured task, upstream Inference, actual workflow, supplied records, prior user facts and subsequent answers. Return the structured required fields and requirement findings. This readiness analysis has no action tools; assess the scheduled workflow as the operational owner from its captured workflow and authorized context. Do not treat this analysis worker’s limitations or the absence of first-run evidence as a missing user fact. Ask only for consequential facts that remain genuinely unavailable after these sources are checked.';
    const readinessNode = request.nodes.find(node => node.id === NODE);
    if (!readinessNode) request = await this.store.addNode(id, { id: NODE, kind: 'viability', title: 'Check essential facts and a plausible route', prompt: readinessPrompt }, { actor, clientRequestId: 'module-' + id });
    else if (readinessNode.kind === 'viability' && readinessNode.prompt === 'Use the captured task, actual workflow, supplied records, prior user facts and subsequent answers. Return the structured required fields and requirement findings. Ask only for consequential facts that remain genuinely unavailable after these sources are checked.' && typeof this.store.updateNode === 'function') {
      request = await this.store.updateNode(id, NODE, { prompt: readinessPrompt }, { actor, expectedNodeRevision: readinessNode.revision, clientRequestId: 'inference-first-' + id });
    }
    const selected = definition.workflow.nodes.find(node => node.type === 'agent'), settings = this.getSettings() || {};
    const executionProfile = request.viability?.executionProfile || { model: selected?.model || settings.defaultModel || 'default', effort: selected?.effort || settings.defaultEffort || 'default', serviceTier: selected?.serviceTier || settings.defaultServiceTier || 'default' };
    const binding = { scope, scopeId, nodeId: NODE, fingerprint, definition: viabilityDefinition(definition), executionProfile, workflowNodeIds: definition.workflow.nodes.filter(node => node.type === 'agent').map(node => node.id),
      ...(linkedRunId ? { linkedRunId } : {}), ...(deploymentId ? { deploymentId } : {}), ...(pendingIntent ? { pendingIntent } : {}) };
    if (request.viability && request.viability.fingerprint !== fingerprint) throw fail('The stored readiness check belongs to different task inputs.', 'TASK_VIABILITY_STALE');
    request = await this.writer.configureViability(id, { viability: binding });
    request = await this.refreshSources(request, definition, { signal });
    if (beforeAssess) { await beforeAssess(request, definition); request = await this.store.get(request.id); }
    return request;
  }
  async refreshSources(request, definition, { signal } = {}) {
    try {
      const sources = await this.sources(definition, { signal });
      return await this.writer.configureViability(request.id, { viability: { recoveryIssue: null }, sources, replaceBaseSources: true });
    } catch (error) {
      if (!error.code?.startsWith('TASK_VIABILITY_SOURCE')) throw error;
      return this.writer.configureViability(request.id, { viability: { recoveryIssue: { code: error.code, message: error.message } }, sources: [], replaceBaseSources: true });
    }
  }
  assess(requestId, options = {}) { return this.serialize(requestId, () => this.assessCurrent(requestId, options)); }
  async assessCurrent(requestId, { model, effort, serviceTier, signal } = {}) {
      let request = await this.store.get(requestId), node = request.nodes.find(item => item.id === readinessNodeId(request));
      if (request.viability?.recoveryIssue) return request;
      if (node?.readiness.state === 'ready') return request;
      const inputs = hash({ revision: node.revision, sources: planningNodeSources(request,readinessNodeId(request)).filter(source => source.kind !== 'response'), fingerprint: request.viability?.fingerprint });
      const prior = (request.attempts || []).find(attempt => attempt.nodeId === readinessNodeId(request) && attempt.clientRequestId === 'check-' + inputs);
      if (prior && prior.status !== 'running') return request; // Failed or blocked results are not silently replayed.
      const settings = this.getSettings() || {}, profile = request.viability?.executionProfile || {};
      signal?.throwIfAborted();
      const claim = await this.runner.start({ requestId, nodeId: readinessNodeId(request), expectedNodeRevision: node.revision, clientRequestId: 'check-' + inputs,
        model: model || profile.model || settings.defaultModel || 'default', effort: effort || profile.effort || settings.defaultEffort || 'default', serviceTier: serviceTier || profile.serviceTier || settings.defaultServiceTier || 'default', automatic: false, signal });
      await this.runner.wait(requestId, claim.attempt.id, { signal });
      request = await this.store.get(requestId); this.onUpdated({ type: 'planning.browser.updated', data: { requestId, revision: request.revision }, at: new Date().toISOString() });
      return request;
  }
  async forRun(run, { signal, beforeAssess, assessManaged = false } = {}) {
    if (run.metadata?.managedBy === 'operations') {
      const definition = this.engine.operations?.readinessDefinitionForInbox(run.metadata.inboxId);
      if (!definition) throw fail('The scheduled task has no matching durable admission record.', 'TASK_VIABILITY_REQUIRED');
      const checked=await this.assertDeployment(definition),request=await this.store.get(checked.requestId),response=request.nodes.find(item=>item.id===readinessNodeId(request)).response;
      if (!assessManaged || run.planningMode === 'off') return { ...checked, skipped: true, managed: true, state:'ready', blockedNodeIds: [], context:canonical({values:response.values,requirements:response.requirements}) };
    }
    if (run.planningMode === 'off') return { skipped: true, blockedNodeIds: [] };
    const grant = run.workbenchAuthorization;
    const definition = { input: run.input, cwd: run.cwd, workflow: run.workflow, attachmentIds: run.attachmentIds || [],
      ...(grant?.scope === 'configured-vm' && grant.control === 'agent' && grant.source === 'explicit-user-task' ? { workbench: true } : {}) };
    const pending = { id: 'request-' + run.id, kind: 'continue_request', runId: run.id, state: 'waiting', createdAt: new Date().toISOString() };
    let request, prepared = false,skipAssessment=false;
    if (run.viability?.requestId) {
      request = await this.store.get(run.viability.requestId);
      const continuedDefinition = { ...definition, input: run.viability.baseInput || request.objective,
        ...(object(request.viability?.definition?.continuity) ? { continuity: clone(request.viability.definition.continuity) } : {}) };
      request = await this.refreshSources(request, continuedDefinition, { signal });
      if (request.viability.fingerprint !== viabilityFingerprint(continuedDefinition)) {
        request = await this.ensure({ scope: 'request', scopeId: run.id, conversationId: run.taskId || run.id,
          definition: { ...continuedDefinition, input: continuedDefinition.input + '\n\nLatest user message:\n' + run.input }, linkedRunId: run.id, pendingIntent: pending, signal });
      } else if (run.viability.resumeChecked && !request.viability.recoveryIssue && request.nodes.find(item => item.id === readinessNodeId(request))?.readiness.state === 'ready') {
        if (beforeAssess) { skipAssessment=(await beforeAssess(request, request.viability.definition))?.skipAssessment===true; request = await this.store.get(request.id); prepared = true; }
        if (request.nodes.find(item => item.id === readinessNodeId(request))?.readiness.state === 'ready') return { ...reference(request), state: 'ready', blockedNodeIds: [], context: canonical({ values: request.nodes.find(item => item.id === readinessNodeId(request)).response.values, requirements: request.nodes.find(item => item.id === readinessNodeId(request)).response.requirements }) };
      } else {
      // A continuation supplies an actual user message to the existing graph.
      request = await this.writer.configureViability(request.id, { viability: { linkedRunId: run.id, pendingIntent: pending }, sources: run.viability.resumeChecked ? [] : [{ id: 'viability:answer:' + run.id, kind: 'user_input', title: 'User follow-up', text: run.input, contentHash: hash(run.input) }] });
      }
    } else {
      const continuity = await this.captureContinuity(run, { signal });
      request = await this.ensure({ scope: 'request', scopeId: run.id, conversationId: run.taskId || run.id,
        definition: { ...definition, ...(continuity ? { continuity } : {}) }, linkedRunId: run.id, pendingIntent: pending, signal });
    }
    if (beforeAssess && !prepared) { skipAssessment=(await beforeAssess(request, request.viability.definition))?.skipAssessment===true; request = await this.store.get(request.id); }
    const selected = run.workflow.nodes.find(node => node.type === 'agent');
    if(!skipAssessment)request = await this.assess(request.id, { model: selected?.model, effort: selected?.effort, serviceTier: selected?.serviceTier, signal });
    request = await this.refreshSources(request, request.viability.definition, { signal });
    const node = request.nodes.find(item => item.id === readinessNodeId(request)), readiness = node.readiness.viability;
    if (!request.viability.recoveryIssue && node.readiness.state === 'ready') {
      await this.writer.configureViability(request.id, { completeIntentId: request.viability.pendingIntent?.id, viability: { pendingIntent: null } });
      return { ...reference(request), state: 'ready', blockedNodeIds: [], context: canonical({ values: node.response.values, requirements: node.response.requirements }) };
    }
    const actualIds = run.workflow.nodes.filter(item => item.type === 'agent').map(item => item.id);
    let held = [...new Set((readiness?.blockingFacts || []).flatMap(fact => fact.dependentNodeIds || []))];
    if (!held.length || held.some(id => !actualIds.includes(id)) || !['awaiting_input','blocked'].includes(node.readiness.state)) held = actualIds;
    return { ...reference(request), state: request.viability.recoveryIssue ? 'needs_evidence' : node.readiness.state, blockedNodeIds: held, question: viabilityQuestions(request), context: node.response ? canonical({ values: node.response.values, requirements: node.response.requirements }) : '', awaitingInput: true };
  }
  async prepareDeploymentInference(request, definition, deployment, { signal } = {}) {
    const planner = this.engine?.responseCycle;
    if (!planner?.createCycle || !planner?.drive || !planner?.serialize || !planner?.linkInputs) return request;
    let current = await this.store.get(request.id);
    let cycleId = current.responseCycle?.rootCycleId || null;
    let cycle = current.cycles?.find(item => item.id === cycleId)
      || current.responseCycle?.cycles?.find(item => item.id === cycleId);
    if (!cycle?.stageNodeIds?.inference || !cycle.stageNodeIds?.feasibility) {
      const title = text(definition.input).trim().replace(/\s+/g, ' ').slice(0, 170) || 'Scheduled task';
      const created = await planner.createCycle(request.id, {
        title,
        purpose: current.objective,
        planningExecutionMode: 'automatic',
        clientRequestId: 'deployment-inference-' + hash([deployment.id, request.id]).slice(0, 32)
      }, { internal: true, ...(!cycleId ? { feasibilityNodeId: readinessNodeId(current) } : {}) });
      cycleId = created.cycleAction.cycleId;
      current = await this.store.get(request.id);
      if (current.responseCycle?.rootCycleId !== cycleId) {
        current = await planner.writer.configureResponseCycle(request.id, { rootPatch: { rootCycleId: cycleId } });
      }
    }
    return planner.serialize(request.id, async () => {
      current = await this.store.get(request.id);
      cycle = current.cycles?.find(item => item.id === cycleId)
        || current.responseCycle?.cycles?.find(item => item.id === cycleId);
      if (!cycle?.stageNodeIds?.inference || !cycle.stageNodeIds?.feasibility) {
        throw fail('The schedule readiness check could not prepare its Inference stage.', 'TASK_VIABILITY_INFERENCE_FAILED', 503);
      }
      if (readinessNodeId(current) !== cycle.stageNodeIds.feasibility) {
        current = await this.writer.configureViability(request.id, { viability: { nodeId: cycle.stageNodeIds.feasibility } });
      }
      current = await planner.drive(request.id, cycleId, {
        through: 'inference', signal, budget: planner.budget(current),
        runKey: 'deployment-preflight-' + deployment.id
      });
      cycle = current.cycles?.find(item => item.id === cycleId)
        || current.responseCycle?.cycles?.find(item => item.id === cycleId);
      const inference = current.nodes.find(item => item.id === cycle?.stageNodeIds?.inference);
      if (!inference?.readiness?.cycle?.analysisReady) {
        throw fail(cycle?.summary || 'The schedule readiness check could not complete its Inference stage.', 'TASK_VIABILITY_INFERENCE_FAILED', 503);
      }
      return planner.linkInputs(current, cycle, 'feasibility');
    });
  }
  async checkDeployment(operations, id, { intent = null, signal, beforeAssess } = {}) {
    const deployment = operations.getDeployment(id), definition = viabilityDefinition(deployment), pendingIntent = intent ? { id: 'deployment-' + id + '-' + deployment.revision, kind: intent, deploymentId: id, expectedRevision: deployment.revision, state: 'waiting', createdAt: new Date().toISOString() } : null;
    const prepare = async (request, currentDefinition) => {
      if (beforeAssess) await beforeAssess(request, currentDefinition);
      await this.prepareDeploymentInference(request, currentDefinition, deployment, { signal });
    };
    const request = await this.ensure({ scope: 'deployment', scopeId: id, conversationId: 'schedule-' + id, definition, deploymentId: id, ...(pendingIntent ? { pendingIntent } : {}), signal, beforeAssess: prepare });
    const selected = definition.workflow.nodes.find(node => node.type === 'agent');
    const checked = await this.assess(request.id, { model: selected?.model, effort: selected?.effort, serviceTier: selected?.serviceTier, signal });
    if (intent) return checked;
    const current = operations.getDeployment(id), response = checked.nodes.find(item => item.id === readinessNodeId(checked))?.response;
    if (viabilityFingerprint(current) !== checked.viability.fingerprint) throw fail('The schedule inputs changed during its readiness check.', 'TASK_VIABILITY_STALE');
    const ready = !checked.viability.recoveryIssue && checked.nodes.find(item => item.id === readinessNodeId(checked))?.readiness.state === 'ready';
    const saved = await operations.update(id, { expectedRevision: current.revision, enabled: current.enabled && ready, ...(response ? { viabilityRef: reference(checked) } : {}) }, { actor: 'local-session' });
    return { ...checked, viabilityAction: { deployment: saved } };
  }
  async assertDeployment(definition) {
    const ref = definition.viabilityRef;
    if (!ref?.requestId || !ref.responseId) throw fail('Check task readiness before enabling or starting this schedule. Save a disabled draft, then run its readiness check.', 'TASK_VIABILITY_REQUIRED');
    let request = await this.store.get(ref.requestId);
    request = await this.refreshSources(request, viabilityDefinition(definition));
    return this.assertBound(request, definition);
  }
  assertBound(request, definition) {
    const ref = definition.viabilityRef;
    const node = request.nodes.find(item => item.id === readinessNodeId(request));
    if (request.viability?.scope !== 'deployment' || request.viability.scopeId !== definition.id || request.viability.deploymentId !== definition.id || request.viability.recoveryIssue || request.viability.fingerprint !== viabilityFingerprint(definition) || node?.response?.id !== ref.responseId || node.readiness.state !== 'ready') throw fail('The schedule inputs or required facts changed. Refresh its readiness check before enabling or starting it.', 'TASK_VIABILITY_STALE', 409, { planningRequestId: request.id });
    const checked = evaluateViabilityResponse(node.response, planningNodeSources(request,readinessNodeId(request)), { workflowNodeIds: definition.workflow.nodes.filter(item => item.type === 'agent').map(item => item.id),upstreamResponses:planningCycleStageContext(request,node.id)?.prerequisites||[] });
    if (checked.state !== 'ready') throw fail(viabilityQuestions(request), 'TASK_VIABILITY_BLOCKED', 409, { planningRequestId: request.id });
    return reference(request);
  }
  async withDeployment(definition, operation) {
    await this.assertDeployment(definition);
    return this.writer.withViabilityRequest(definition.viabilityRef.requestId, request => {
      this.assertBound(request, definition);
      return operation();
    });
  }
  async saveDeployment(operations, value, { id, actor: source = 'unspecified', signal } = {}) {
    const enabledRequested = value.enabled ?? (id ? operations.getDeployment(id).enabled : false);
    if (enabledRequested !== true) return id ? operations.update(id, value, { actor: source }) : operations.create(value, { actor: source });
    const draft = id ? await operations.update(id, { ...value, enabled: false }, { actor: source }) : await operations.create({ ...value, enabled: false }, { actor: source });
    const request = await this.checkDeployment(operations, draft.id, { intent: 'enable_deployment', signal });
    const node = request.nodes.find(item => item.id === readinessNodeId(request));
    if (request.viability.recoveryIssue || node.readiness.state !== 'ready') {
      const linked = node.response ? await operations.update(draft.id, { expectedRevision: draft.revision, enabled: false, viabilityRef: reference(request) }, { actor: source }) : draft;
      if (linked.revision !== draft.revision) await this.writer.configureViability(request.id, { completeIntentId: request.viability.pendingIntent?.id, viability: { pendingIntent: { ...request.viability.pendingIntent, expectedRevision: linked.revision } } });
      return { ...linked, readiness: { state: request.viability.recoveryIssue ? 'needs_evidence' : node.readiness.state, requestId: request.id, question: viabilityQuestions(request) } };
    }
    const enabled = await operations.update(draft.id, { expectedRevision: draft.revision, enabled: true, viabilityRef: reference(request) }, { actor: source });
    await this.writer.configureViability(request.id, { completeIntentId: request.viability.pendingIntent?.id, viability: { pendingIntent: null } }); return enabled;
  }
  answer(requestId, value, options = {}) { return this.serialize(requestId, () => this.answerCurrent(requestId, value, options)); }
  async answerCurrent(requestId, value, { operations, signal, actor: answerActor, receipt, deferContinuation = false } = {}) {
    const allowed = ['requirementId','answer','expectedNodeRevision','expectedResponseId','clientRequestId'];
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || typeof value.answer !== 'string' || !value.answer.trim() || value.answer.length > 12000 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value.clientRequestId || '')) throw fail('Supply the exact question, current response and a nonempty factual answer.', 'TASK_VIABILITY_ANSWER_INVALID', 400);
    const receiptKey = hash([requestId, value.clientRequestId]);
    let request = await this.store.get(requestId), node = request.nodes.find(item => item.id === readinessNodeId(request)), old = (request.viability?.answers || []).find(item => item.id === receiptKey);
    const authoredBy = ['agent','external-agent'].includes(answerActor?.type) ? { type: answerActor.type, id: answerActor.id } : null;
    const fingerprint = hash(authoredBy ? { value, authoredBy } : value);
    if (old && old.fingerprint !== fingerprint) throw fail('This answer request ID already names different input.', 'TASK_VIABILITY_IDEMPOTENCY_CONFLICT');
    if (request.viability?.definition) {
      request = await this.refreshSources(request, request.viability.definition, { signal });
      node = request.nodes.find(item => item.id === readinessNodeId(request));
    }
    if (!old) {
      if (node?.revision !== value.expectedNodeRevision || node?.response?.id !== value.expectedResponseId) throw fail('The question or its source response changed. Review it before answering.', 'TASK_VIABILITY_ANSWER_CONFLICT');
      if (node.readiness.viability?.state !== 'awaiting_input' || !node.readiness.viability.blockingFacts.some(fact => fact.id === value.requirementId)) throw fail('This requirement is no longer an unresolved essential fact.', 'TASK_VIABILITY_ANSWER_CONFLICT');
      const label = node.readiness.viability.blockingFacts.find(fact => fact.id === value.requirementId)?.label || value.requirementId;
      request = await this.writer.configureViability(requestId, { expectedRevision: request.revision, viability: { answers: [...(request.viability.answers || []), { id: receiptKey, fingerprint, requirementId: value.requirementId, ...(authoredBy ? { authoredBy, ...(receipt ? { receipt: clone(receipt) } : {}) } : {}) }].slice(-100) },
        sources: [{ id: 'viability:answer:' + receiptKey, kind: authoredBy ? 'source' : 'user_input', title: (authoredBy?.type === 'agent' ? 'Supervising model answer: ' : authoredBy ? 'Connected agent answer: ' : 'User answer: ') + label, text: value.answer.trim(), contentHash: hash(value.answer.trim()) }] });
    }
    request = await this.assessCurrent(requestId, { signal });
    if (request.viability?.definition) request = await this.refreshSources(request, request.viability.definition, { signal });
    if (request.viability.recoveryIssue || request.nodes.find(item => item.id === readinessNodeId(request))?.readiness.state !== 'ready') return request;
    if (deferContinuation) return request;
    const intent = request.viability.pendingIntent;
    let action = old && request.viability.lastActionReceiptId === receiptKey ? request.viability.lastAction || null : null;
    if (intent?.kind === 'enable_deployment') {
      if (!operations) throw fail('Schedule storage is unavailable.', 'TASK_VIABILITY_OPERATIONS_UNAVAILABLE', 503);
      const current = operations.getDeployment(intent.deploymentId);
      const alreadyApplied = current.enabled && current.revision === intent.expectedRevision + 1 && current.viabilityRef?.requestId === request.id && current.viabilityRef?.responseId === reference(request).responseId;
      if (current.revision !== intent.expectedRevision && !alreadyApplied) throw fail('The schedule draft changed after this question. Review its current inputs before enabling.', 'TASK_VIABILITY_STALE');
      const deployment = alreadyApplied ? current : await operations.update(current.id, { expectedRevision: current.revision, enabled: true, viabilityRef: reference(request) }, { actor: 'local-session' });
      action = { deployment };
    } else if (intent?.kind === 'continue_request') {
      let previous;
      try { previous = this.engine.getRun(intent.runId); } catch {
        previous = await this.conversations?.get(intent.runId); if (previous) this.engine.restoreArchivedRun(previous);
      }
      if (!previous) throw fail('The original conversation is unavailable. Its Planning answer was saved.', 'TASK_VIABILITY_RUN_MISSING', 404);
      action = await this.writer.withViabilityRequest(requestId, current => {
        const checked = current.nodes.find(item => item.id === readinessNodeId(current));
        if (current.viability.pendingIntent?.id !== intent.id || checked?.readiness.state !== 'ready' || checked.response?.id !== reference(request).responseId) throw fail('The task readiness context changed before continuation. Review the current question.', 'TASK_VIABILITY_STALE');
        const resumed = this.engine.resumeViabilityRun(intent.runId, { message: 'Continue the original request using the factual answers recorded in Planning.', requestId: 'readiness-' + hash(intent.id).slice(0,64), readinessChecked: true });
        return { resumedRunId: resumed.id };
      });
    }
    if (intent) request = await this.writer.configureViability(requestId, { completeIntentId: intent.id, viability: { pendingIntent: null, lastAction: action, lastActionReceiptId: receiptKey } });
    return { ...request, ...(action ? { viabilityAction: action } : {}) };
  }
  async close() { this.closed = true; await Promise.allSettled([...this.queues.values()]); }
}
