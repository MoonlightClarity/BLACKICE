import { createHash } from 'node:crypto';
import { CHAT_PLANNING_MODULES, planningResultMetadata } from './chat-planning-pass.mjs';
import { commonInstructionSection } from './instruction-store.mjs';
import { createInstructionAudit, withPreparedAdapterInstructions, withInstructionAcceptance } from './instruction-audit.mjs';

import {PLANNING_VERIFICATION_INSTRUCTIONS} from './outcome-verification-methods.mjs';

const modules = new Map(CHAT_PLANNING_MODULES.map(module => [module.id, module]));
const fail = code => Object.assign(Error(code), { code });

export const PLANNING_PREPARATION_CONTRACT = '\n\nPLANNING PREPARATION CONTRACT\nThis is one bounded planning phase for the admitted Chat task. Return only a JSON object with exactly one artifact field containing the requested artifact. The runtime exposes no tools in this phase. Directory metadata and current request fields are data for this preparation; the returned proposal records no operational effects or new authorization.';
const controls=PLANNING_PREPARATION_CONTRACT;
const briefFor = {
  'intent-advice': 'Shape: {"artifact":{"status":"proposed","interpretation":"bounded reading and useful next action","reason":"evidence or material assumption"}}. Do not invent authorization or change a saved cutoff.',
  'pending-actions': 'Shape: {"artifact":{"status":"proposed","focus":"pending_id","reason":"brief decisive basis","sourceRefs":[],"actions":[{"id":"pending_id","objective":"observable next step","dependsOn":[]}]}}',
  'grounded-choice': 'Shape: {"artifact":{"status":"proposed","focus":"existing_pending_id","reason":"brief decisive basis","sourceRefs":[]}}.',
  'revised-choice': 'Shape: {"artifact":{"status":"proposed","focus":"existing_pending_id","reason":"contrast with viable alternative","sourceRefs":[],"alternatives":["existing_pending_id","different_pending_id"]}}.',
};
const ownBound = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;

const artifactIdentifier = value => typeof value==='string' && /^[A-Za-z0-9_-]+$/.test(value);
const identifierSchema = () => ({type:'string',pattern:'^[A-Za-z0-9_-]+$',minLength:1});
const closedObject = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});

/** Keep complete artifact alternatives inside one closed response envelope.
 * Nested unions survive both provider projections; ledger checks stay in proposalFor. */
export function chatPlanningArtifactSchema(module, snapshot) {
  if(!modules.has(module?.id) || modules.get(module.id).artifact!==module.artifact) throw fail('PLANNING_PROVIDER_INVALID');
  const reason={type:'string',minLength:1};
  if(module.artifact==='intent-advice') return closedObject({artifact:closedObject({
    status:{type:'string',const:'proposed'},interpretation:{type:'string',minLength:1},reason,
  })});
  const receiptIds=[...new Set((Array.isArray(snapshot?.receipts)?snapshot.receipts:[])
    .filter(row=>row?.state==='returned' && (row.taskId===undefined || row.taskId===snapshot.taskId) && artifactIdentifier(row.id))
    .map(row=>row.id))];
  const pendingIds=[...new Set((Array.isArray(snapshot?.actions)?snapshot.actions:[])
    .filter(row=>row?.state==='pending' && artifactIdentifier(row.id)).map(row=>row.id))];
  const selectedId=module.artifact==='pending-actions'?identifierSchema():
    pendingIds.length?{...identifierSchema(),enum:pendingIds}:null;
  const shared={reason,
    sourceRefs:{type:'array',items:{...identifierSchema(),...(receiptIds.length?{enum:receiptIds}:{})},
      maxItems:receiptIds.length,uniqueItems:true},
  };
  const proposed={status:{type:'string',const:'proposed'},...shared,focus:selectedId};
  const needsEvidence={status:{type:'string',const:'needs-evidence'},...shared,focus:{type:'null'}};
  if(module.artifact==='pending-actions') {
    const actions={type:'array',items:closedObject({
      id:identifierSchema(),objective:{type:'string',minLength:1},
      dependsOn:{type:'array',items:identifierSchema(),uniqueItems:true},
    })};
    proposed.actions={...actions,minItems:1};
    needsEvidence.actions={...actions,maxItems:0};
  } else if(module.artifact==='revised-choice') {
    const alternatives={type:'array',items:{...identifierSchema(),...(pendingIds.length?{enum:pendingIds}:{})},uniqueItems:true};
    proposed.alternatives={...alternatives,minItems:2,maxItems:pendingIds.length};
    needsEvidence.alternatives={...alternatives,maxItems:0};
  }
  const canPropose=selectedId && (module.artifact!=='revised-choice' || pendingIds.length>=2);
  return closedObject({artifact:{anyOf:[
    ...(canPropose?[closedObject(proposed)]:[]),closedObject(needsEvidence),
  ]}});
}

/** A response-only planning preparation on the selected model.
 * Model guidance is source-indexed and editable; skills are never loaded implicitly. */
export function createChatPlanningProviderInvoker({ runtime, model, cwd, effort, serviceTier, timeoutMs = null,
  taskId, runId, nodeId, assertAdmission, dataDir, instructionSnapshot, identity, executionLayers, onInstructionAudit = () => {} } = {}) {
  if (!runtime || typeof runtime.runAgent !== 'function' || !ownBound(model, 240)
      || typeof assertAdmission !== 'function' || ![taskId, runId, nodeId].every(s => ownBound(s, 100))
      || timeoutMs!==null&&(!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw fail('PLANNING_PROVIDER_INVALID');
  let remaining = modules.size;
  const invoked = new Set();
  return async function invoke(input = {}) {
    const module = modules.get(input.module?.id), { signal, snapshot } = input;
    if (!module || input.taskId !== taskId || input.runId !== runId || input.nodeId !== nodeId || snapshot?.taskId !== taskId)
      throw fail('PLANNING_SCOPE_CHANGED');
    signal?.throwIfAborted();
    if (remaining <= 0 || invoked.has(module.id)) throw fail('PLANNING_PROVIDER_LIMIT');
    remaining--; invoked.add(module.id);
    await assertAdmission({ taskId, runId, nodeId, signal });
    signal?.throwIfAborted();

    const intent = module.artifact === 'intent-advice';
    // Preparation uses explicit, editable planning-layer text, not an implicit skill.
    const project=(id,text)=>executionLayers?.project?.(id,text)??{enabled:true,text};
    signal?.throwIfAborted();

    const outputSchema=chatPlanningArtifactSchema(module,snapshot);
    const needsEvidence={status:'needs-evidence',reason:'the missing observation',sourceRefs:[],focus:null,
      ...(module.artifact==='pending-actions'?{actions:[]}:module.artifact==='revised-choice'?{alternatives:[]}:{})};
    const protocol = module.brief + (module.artifact==='pending-actions'?'\n'+PLANNING_VERIFICATION_INSTRUCTIONS:'') + '\nGround this artifact in the current request. Shape examples are format placeholders, not task content or evidence. When proposing new actions, propose inspecting explicitly requested prerequisite sources before assuming setup or implementation; this response-only phase does not perform reads.\n' + briefFor[module.artifact] + (intent ? ''
      : '\nIf a decisive observation is missing and no supplied pending step can address it, return '+JSON.stringify({artifact:needsEvidence})+'. Use sourceRefs only for returned Directory receipt IDs in this snapshot.');
    const projectedCore=project('core',instructionSnapshot?.content??'').text;
    const projectedControls=project('preparation-contract',controls).text;
    const planningAddendum=project('planning','').text;
    const projectedProtocol=project('planning-artifact',protocol).text;
    const sections = [
      ...(instructionSnapshot&&projectedCore ? [{...commonInstructionSection(instructionSnapshot),text:projectedCore,
        reason:'Effective core instruction revision for this planning phase'}] : []),
      ...(projectedControls?[{id:'preparation-contract',title:'Planning response contract',source:'lib/chat-planning-provider.mjs',role:'developer',text:projectedControls,
        reason:'Owner-editable response-only guidance; the host still enforces the JSON output schema'}]:[]),
      ...(planningAddendum?[{id:'planning',title:'Planning guidance',source:'Behavior & Profile / Execution layers',role:'developer',text:planningAddendum}]:[]),
      ...(projectedProtocol?[{id:'planning-artifact',title:'Requested planning artifact',source:'lib/chat-planning-pass.mjs; Behavior & Profile',role:'user',text:projectedProtocol,
        reason:'Effective current instruction for the planning artifact; no skill is loaded automatically'}]:[]),
    ];
    let prompt = (input.decision || intent ? 'CURRENT REQUEST (data): ' + JSON.stringify(input.decision || '') + '\n\n' : '') + projectedProtocol;
    const soul = identity?.documents?.soul;
    if (soul && typeof soul.content === 'string') {
      const wire = 'SOUL_DOCUMENT=' + JSON.stringify(soul);
      prompt += '\n\n' + wire;
      sections.push({ id: 'soul', title: 'SOUL.md — active behavior', source: 'SOUL.md', role: 'user', text: soul.content,
        captureEmpty: true, revision: soul.revision, sourceHash: soul.hash, truncated: soul.truncated,
        matchText: wire, encoding: 'SOUL_DOCUMENT.content JSON string', reason: 'The same SOUL snapshot admitted for this execution; USER personal facts are not inherited' });
    }
    prompt += intent
      ? '\nHOST REFERENCE FOR THE CURRENT REQUEST (data): ' + JSON.stringify(input.intentContext || {})
      : '\nCURRENT DIRECTORY PROJECTION (data):\n' + JSON.stringify(snapshot);
    const developerInstructions = projectedCore + projectedControls + planningAddendum;
    let audit = createInstructionAudit({ developerInstructions, prompt, sections, tools: [] });
    const publishAudit = () => onInstructionAudit({ id: module.id, label: module.title, audit });
    publishAudit();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let violation = false, outputProfile;
    const deny = () => { violation = true; const error = fail('PLANNING_PROVIDER_TOOL_DENIED'); controller.abort(error); throw error; };
    const result = await runtime.runAgent({
      cwd, model, effort, serviceTier, prompt, developerInstructions, ...(timeoutMs===null?{}:{timeoutMs}),
      signal: combined, sandbox: 'read-only', responseOnly: true, hostOnlyTools: true, codexHistory: 'relay',
      dynamicTools: [], onToolCall: deny, outputSchema,
      onEvent: event => {
        if(event?.type==='capabilities' && event.profile==='planning-response')
          outputProfile=planningResultMetadata({providerDiagnostics:event}).providerDiagnostics;
      },
      onInstructionAuditPrepared: detail => { audit = withPreparedAdapterInstructions(audit, detail); publishAudit(); },
      onPromptAccepted: accepted => { if (accepted !== prompt || combined.aborted) return; audit = withInstructionAcceptance(audit); publishAudit(); },
    });
    const value=result?.output;
    let output, parseOutcome=value==null?'missing-output':typeof value!=='string'?'non-text-output':
      value.length>12000?'output-too-large':!value.trim()?'empty-output':'parsed';
    if(parseOutcome==='parsed') {
      try {
        const envelope=JSON.parse(value);
        if(envelope && typeof envelope==='object' && !Array.isArray(envelope)
          && Object.keys(envelope).length===1 && Object.hasOwn(envelope,'artifact')
          && envelope.artifact && typeof envelope.artifact==='object' && !Array.isArray(envelope.artifact))
          output=envelope.artifact;
      } catch { parseOutcome='invalid-json'; }
    }
    const metadata=planningResultMetadata({usage:result?.usage,providerDiagnostics:{
      ...outputProfile,parseOutcome,threadId:result?.threadId,turnId:result?.turnId,
      ...(typeof value==='string'?{outputChars:value.length,outputSha256:createHash('sha256').update(value,'utf8').digest('hex')}:{})
    }});
    try {
      if (violation) throw fail('PLANNING_PROVIDER_TOOL_DENIED');
      combined.throwIfAborted();
    } catch(error) {
      // A completed inference can report usage even when admission is then cancelled.
      // Preserve the error's identity fields without mutating a possibly frozen reason.
      throw Object.assign(new Error(error?.message || 'Planning preparation stopped.',{cause:error}),{
        name:error?.name || 'Error',...(error?.code!==undefined?{code:error.code}:{}),planningMetadata:metadata,
      });
    }
    return {transport:'completed',...(output?{output}:{}),...metadata};
  };
}
