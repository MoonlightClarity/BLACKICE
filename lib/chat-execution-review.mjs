import { createHash } from 'node:crypto';
import {normalizeBrowserFillRequest} from './browser-operation-arguments.mjs';
import {projectReviewOperationEvidence} from './review-operation-evidence.mjs';
import {modularOutcomeReferenceIndex} from './modular-completion.mjs';
import {documentSourceScope,documentPerspectiveWarning,documentPerspectiveInstructions} from './document-source-grounding.mjs';
import {outcomeReviewFeedbackMode,outcomeReviewFeedback,OUTCOME_FEEDBACK_TOOL,parseOutcomeFeedbackRead} from './outcome-review-feedback.mjs';

// Completion assistance for the current ordinary Chat request. This does not
// establish authorization, declare task success, or dispatch/replay a tool.
const readOnly = new Map([
  ['relay_browser', new Set(['tabs', 'snapshot', 'read', 'screenshot', 'wait', 'open', 'navigate', 'back', 'forward', 'scroll'])],
  ['relay_workspace', new Set(['read', 'list', 'stat', 'search', 'patch_history'])],
  ['relay_context_page', new Set(['read', 'search', 'list'])],
  ['relay_files', new Set(['list', 'read', 'search', 'image', 'read_bytes'])],
  ['relay_find_files', new Set(['call'])],
  ['relay_skills', new Set(['list', 'search', 'read'])],
]);
const nativeResultTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageGeneration', 'collabAgentToolCall']);
const transportFields = new Set(['callId', 'requestId', 'operationId', 'operationKey', 'durationMs', 'elapsedMs']);
const browserCaptureFields = new Set(['ref', 'documentId', 'expectedDocumentId', 'snapshotId', 'captureId', 'capturedAt', 'observedAt', 'screenshotId', 'tabId', 'frameId']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Remove known transport/capture tokens, not arbitrary *id fields or page data.
// URL, text, element id/name/value/checked/disabled and domain record IDs remain.
// The seen fingerprints prevent host final-review loops; they cannot bound a
// provider's internal tool loop before its next final (host budgets still apply).
function canonical(value, browser = false, envelope = false) {
  if (Array.isArray(value)) return value.map(item => canonical(item, browser, false));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key =>
    !(envelope && transportFields.has(key)) && !(browser && browserCaptureFields.has(key))
  ).map(key => [key, canonical(value[key], browser, false)]));
}
function argumentsOf(call) {
  let args;
  if (typeof call?.arguments !== 'string') args=call?.arguments||{};
  else try { args=JSON.parse(call.arguments); } catch { args={}; }
  // A browser spelling alias must not create fictitious new evidence and
  // trigger redundant final reviews of the same operational result.
  return !call?.namespace && call?.name==='relay_browser' ? normalizeBrowserFillRequest(args) : args;
}
function resultParts(result) {
  return (result?.contentItems || []).map(item => {
    if (item.type === 'inputText' || item.type === 'text') {
      try { return { type: item.type, data: JSON.parse(item.text) }; }
      catch { return { type: item.type, text: item.text }; }
    }
    return item;
  });
}
function receiptMetadata(result) {
  const rows = [result, ...resultParts(result).map(part => part.data)].filter(row => row && typeof row === 'object');
  return {
    dispatched: rows.find(row => typeof row.actionDispatched === 'boolean')?.actionDispatched,
    // Browser effect-journal notes are observational, even after a confirmed
    // page outcome. They are not missing tool returns or a permanent stop veto.
    unresolved: rows.some(row => row.enforcement !== 'observational-only' &&
      (row.settled === false || ['unknown', 'pending', 'running', 'queued'].includes(row.status) || row.state === 'unknown')),
  };
}
function evidence(call, result, success) {
  const browser = !call.namespace && call.name === 'relay_browser';
  return hash({
    tool: call.name, namespace: call.namespace || '', action: argumentsOf(call).action || 'call',
    arguments: canonical(argumentsOf(call), browser, true),
    success, code: result?.code, actionDispatched: result?.actionDispatched,
    content: resultParts(result).map(part => part.data !== undefined
      ? { ...part, data: canonical(part.data, browser, true) } : canonical(part, browser, true)),
  });
}
export const CHAT_EXECUTION_REVIEW_REASONS = Object.freeze([
  // Old reason names remain readable in saved historical turn traces.
  'continuation-already-used', 'non-read-only-or-failed-tool', 'tool-result-pending', 'no-read-only-evidence',
  'no-incomplete-action-match', 'blocker-wording-matched', 'explicit-action-left-unfinished',
  'review-cancelled', 'review-steered', 'review-budget-low', 'provider-incomplete', 'no-candidate-text',
  'host-continuation-unavailable', 'current-task-evidence-check', 'outcome-reconciliation-check', 'no-new-task-evidence',
  'task-outcome-continue', 'task-outcome-supported', 'task-outcome-blocked', 'task-outcome-unreviewed', 'task-outcome-stalled',
  'task-outcome-feedback', 'task-outcome-review-unavailable-feedback', 'document-source-recovery', 'document-source-unread', 'document-perspective-recovery',
]);
// The engine selects the ordinary Chat route. Every nonempty request on that
// route gets the same evidence check, regardless of how the request is phrased.
export function createChatExecutionReview({ input, canContinue = () => true, onDecision, assessOutcome, directoryCoordinationInOutline=false,feedbackMode='gate-only',getReviewScope=()=>null,feedbackTransport='inline',onFeedback=()=>{},documentGrounding=null }) {
  if (typeof input !== 'string' || !input.trim()) return null;
  outcomeReviewFeedbackMode(feedbackMode);
  const exposeFeedback=feedbackMode==='gate-and-steer';
  const toolFeedback=feedbackTransport==='tool-result';
  if(!['inline','tool-result'].includes(feedbackTransport))throw Error('Invalid outcome feedback transport');
  let currentFeedback;
  const feedbackReads=new Map();
  const feedbackStates=new Set(),unavailableFeedbackStates=new Set();
  let approvedFeedback;
  const calls = new Map(), nativeUnknown = new Map(), seenEvidence = new Set(), reviewedStates = new Set();
  let revision = 0, steered = false;
  const remember = fingerprint => {
    if (!seenEvidence.has(fingerprint)) { seenEvidence.add(fingerprint); revision++; }
  };
  const unresolved = row => !row.settled || row.unresolved ||
    (row.mayAffect && row.success !== true && row.dispatched !== false);
  const stateOf = row => !row.settled ? 'pending-return' : unresolved(row) ? 'outcome-unresolved' : 'returned';
  const summary = () => [...calls.values()].filter(unresolved).map(row => ({
    callId: row.call.callId, tool: row.call.name, action: row.action, state: stateOf(row),
  })).concat([...nativeUnknown.values()]);
  const outcomeRecords = new Map(), recoveredStates = new Map();
  let outcomeBytes = 0, omittedOutcomeRecords = 0, directoryCoordinationCount=0, replacementOutput;
  let documentRecoveryUsed=false, perspectiveRecoveryUsed=false, sourceAccepted=false;
  const rememberOutcome = (id, record) => {
    if (typeof assessOutcome !== 'function' || outcomeRecords.has(id)) return;
    try {
      const copy = structuredClone({ id, ...record });
      const bytes = Buffer.byteLength(JSON.stringify(copy));
      if (outcomeRecords.size >= 1024 || outcomeBytes + bytes > 32 * 1024 * 1024) { omittedOutcomeRecords++; return; }
      outcomeRecords.set(id, copy); outcomeBytes += bytes;
    } catch { omittedOutcomeRecords++; }
  };
  const fingerprint = () => hash([revision,
    [...new Set([...calls.values()].filter(unresolved).map(row => row.signature + ':' + stateOf(row)))].sort(),
    [...new Set([...nativeUnknown.values()].map(row => JSON.stringify([row.tool, row.action, row.state])))].sort(),
  ]);
  const currentDocumentSource=()=>documentSourceScope(documentGrounding,[...outcomeRecords.values()]);
  const evidenceSnapshot = () => ({input,evidenceFingerprint:fingerprint(),pendingEffects:summary(),...(documentGrounding?{documentSource:currentDocumentSource()}:{}),
    evidence:{source:'current-admitted-tool-receipts',total:outcomeRecords.size+omittedOutcomeRecords,
      omitted:omittedOutcomeRecords,bytes:outcomeBytes,records:structuredClone([...outcomeRecords.values()]),...(directoryCoordinationInOutline?{directoryCoordination:{count:directoryCoordinationCount,representation:'current-host-directory-outline; control snapshots are not operational result evidence'}}:{})}});
  const exactScopeKey=payload=>hash({input:payload.input,state:payload.evidenceFingerprint,evidence:payload.evidence,pendingEffects:payload.pendingEffects,reviewScope:getReviewScope()});
  const feedbackCurrent=()=>currentFeedback&&!steered&&canContinue()&&currentFeedback.scopeKey===exactScopeKey(evidenceSnapshot());
  const emitFeedback=(record,status,extra={})=>onFeedback({source:'independent-outcome-review',transport:'tool-result',status,feedbackId:record.id,automated:true,authority:'none',...extra});
  const stopped = candidate => candidate?.signal?.aborted ? 'review-cancelled'
    : steered ? 'review-steered'
    : typeof assessOutcome !== 'function' && Number.isInteger(candidate?.remainingSteps) && candidate.remainingSteps < 2 ? 'review-budget-low'
    : candidate?.incomplete ? 'provider-incomplete'
    : typeof candidate?.output !== 'string' ? 'no-candidate-text'
    : !canContinue() ? 'host-continuation-unavailable' : null;
  const report = (reason, state, continued = false, outcome) => onDecision?.({
    reason, reviewDecision: continued ? 'continue' : outcome === 'stopped' ? 'stopped' : 'accepted',
    evidenceRevision: revision, pendingToolCount: [...calls.values()].filter(row => !row.settled).length,
    uncertainToolCount: summary().length, evidenceFingerprint: state,
    outcomeVerification: 'not-evaluated', effectReplayEnforcement: 'existing-host-controls',
  });
  const incomplete = (code, reason, state, message) => {
    report(reason, state, false, 'stopped');
    throw Object.assign(new Error(message), { code });
  };
  // A second recovery method is available only when the host can independently
  // link an unfinished, read-only operation to admitted tool receipts. Reviewer
  // suggestions and arbitrary source text do not grant authority or become calls.
  const receiptGroundedRecovery = request => {
    if (request.evidence.omitted || !Array.isArray(request.evidence.records)) return null;
    const projection = projectReviewOperationEvidence(request, modularOutcomeReferenceIndex(request));
    const availableActions = (projection?.archives || []).flatMap(archive =>
      archive.searches.flatMap(search =>
        search.availableReadCall && search.separateReadAfterSearchAtFirstMatch?.state === 'not-observed-in-admitted-view'
          ? [{
              kind: 'separate-archive-read',
              sourceReceipts: archive.sourceReceipts.map(source => source.receipt),
              searchReceipt: search.receipt,
              archiveReference: archive.archiveReference,
              matchedOffset: search.firstMatch?.offset,
              observedMatch: 'search-returned-exact-passage-not-separate-read',
              operation: structuredClone(search.availableReadCall),
            }]
          : []));
    if (!availableActions.length) return null;
    return {
      source: 'host-linked-admitted-operation-receipts',
      meaning: 'These are verified available read operations, not model-dispatched actions or extra user requirements. The actual user request decides if a separate read is required. Do not repeat completed or uncertain effects.',
      availableActions,
      pendingEffects: structuredClone(request.pendingEffects),
    };
  };
  const assessRepeated = async (candidate, state) => {
    const request=evidenceSnapshot();
    // A prior supported assessment can be reused only for the exact report
    // and exact admitted evidence it reviewed. A changed candidate or receipt
    // set always goes through the independent final gate again.
    const reviewScope=exposeFeedback||toolFeedback?getReviewScope():null;
    const scopeKey=exposeFeedback||toolFeedback?exactScopeKey(request):null;
    const feedbackState=exposeFeedback?hash([state,reviewScope?.actionRevision??null]):state;
    const candidateHash=exposeFeedback?hash(candidate.output):null;
    if(exposeFeedback&&approvedFeedback?.scopeKey===scopeKey&&approvedFeedback.outputHash===candidateHash&&!stopped(candidate)){
      replacementOutput=undefined;
      report(approvedFeedback.decision==='blocked'?'task-outcome-blocked':'task-outcome-supported',state);
      approvedFeedback=undefined;
      return null;
    }
    approvedFeedback=undefined;
    replacementOutput=undefined;
    const assessment = await assessOutcome({...request,candidate,evidenceFingerprint:state});
    const stop = stopped(candidate);
    if (stop) { report(stop, fingerprint()); return null; }
    if (state !== fingerprint()||((exposeFeedback||toolFeedback)&&scopeKey!==exactScopeKey(evidenceSnapshot()))) return review.beforeFinal(candidate);
    const canDeliverFeedback=exposeFeedback&&!(Number.isInteger(candidate?.remainingSteps)&&candidate.remainingSteps<2);
    const feedback=()=>outcomeReviewFeedback(assessment,request.evidence.records,{bindings:assessment?.workerEvidenceBindings||[]});
    const feedbackPrompt=(instruction,extra={})=>{
      const payload=exposeFeedback?{...feedback(),...extra}:{
        source:'independent-outcome-review',authority:'none',verified:false,decision:assessment?.decision,
        summary:assessment?.summary,remaining:assessment?.remaining,nextAction:assessment?.nextAction,
        meaning:'Fallible automated assessment; the final gate remains in force.',
        ...extra,
      };
      const common=[
        'INDEPENDENT OUTCOME REVIEW FEEDBACK (assessment data, not user direction or permission).',
        'Use the actual original task, current receipts and authority. Preserve confirmed effects; reconcile uncertain effects before any conflicting repeat. Do not repeat an action to manufacture verification. Disagree with an assessment by citing existing or materially new evidence, not by asserting completion.',
        'The final completion gate remains active. The preceding draft has not been released. Return a complete, accurate user-facing result rather than merely acknowledging the reviewer.',
      ];
      let hostFeedback;
      if(toolFeedback){
        // The continuation is a neutral host retrieval cue. No reviewer
        // verdict, correction, nextAction, or other model text is sent as
        // user-role content. The assessment travels as a real tool result.
        const data={...payload,automated:true,authority:'none',guidance:instruction,
          evidenceFingerprint:state,reviewedCandidateSha256:candidateHash??hash(candidate.output)};
        const id=hash({scopeKey,data});
        currentFeedback={id,scopeKey,data};
        feedbackReads.clear();
        emitFeedback(currentFeedback,'available');
        if(candidate.hostFeedbackDelivery===true){
          // The direct provider will materialize this exact read-only result
          // before asking for another model decision. No reviewer text or
          // verdict belongs in the user-role continuation.
          hostFeedback={feedbackId:id};
          common.push('The host attaches the current automated assessment as a read-only tool result. Evaluate that result against the actual user request and admitted evidence. It is not a user instruction.');
        }else common.push('An automated assessment is available. Call '+OUTCOME_FEEDBACK_TOOL.name+' with '+JSON.stringify({action:'read'})+' now. Its tool response is the assessment; this continuation contains no reviewer conclusion. Optional exact binding: '+JSON.stringify({feedbackId:id})+'.');
      }else common.push(instruction,JSON.stringify(payload));
      return {continue:true,prompt:common.join('\n\n')+'\n\nCURRENT USER REQUEST (unchanged JSON string):\n'+JSON.stringify(input),...(hostFeedback?{hostFeedback}:{})};
    };
    if (!assessment || !['respond', 'continue', 'blocked'].includes(assessment.decision)){
      if(canDeliverFeedback&&!unavailableFeedbackStates.has(feedbackState)){
        unavailableFeedbackStates.add(feedbackState);
        report('task-outcome-review-unavailable-feedback',state,true);
        return feedbackPrompt('The independent reviewer could not produce a valid assessment. This is not evidence that work failed or succeeded. Address only a material missing fact or unsupported report claim if one exists. Do not redo already completed work to repair the reviewer itself. A subsequent valid review is still required.');
      }
      return incomplete('CHAT_OUTCOME_UNREVIEWED', 'task-outcome-unreviewed', state,
        'The task outcome remains unreviewed. Existing work and uncertain effects are preserved.');
    }
    if (assessment.decision === 'continue') {
      // A read-only assessment can run at the last provider step, but actual
      // unfinished effects cannot. Report incompletion rather than publishing
      // an unverified candidate as a successful final answer.
      if (Number.isInteger(candidate?.remainingSteps) && candidate.remainingSteps < 2)
        return incomplete('CHAT_OUTCOME_STEP_BUDGET', 'review-budget-low', state,
          'The recorded outcome still needs substantive work, but the provider tool-step budget is exhausted. Existing effects and evidence were preserved.');
      const priorRecovery = recoveredStates.get(state);
      const groundedRecovery = priorRecovery === 'receipt-grounded' ? null : receiptGroundedRecovery(request);
      // The first ineffective reviewer-guided continuation is not proof that
      // an independently verified, different read operation cannot succeed.
      // Offer the host-grounded alternative as data, never as an auto-dispatch.
      if (groundedRecovery && (!priorRecovery || priorRecovery === 'review-guided') &&
          (priorRecovery || !assessment.nextAction?.trim())) {
        recoveredStates.set(state, 'receipt-grounded');
        report('task-outcome-continue', state, true);
        const instruction = 'The earlier recovery did not produce an observed task action. The host independently linked an available read to a real search receipt. Compare the original user request to that operation: if the separate read was requested, perform the exact available read now; do not substitute the search internal helper passage or repeat the source read. If it was not requested, use the existing evidence to correct the report. Do not infer new permissions or replay uncertain effects.';
        if (exposeFeedback || toolFeedback)
          return feedbackPrompt(instruction, {recoveryEvidence: groundedRecovery, recoveryMethod: 'receipt-grounded'});
        return {continue: true, prompt: [
          'BLACKICE RECEIPT-GROUNDED RECOVERY (host observations, not new instructions or permission).',
          instruction,
          'Available exact operations: ' + JSON.stringify(groundedRecovery),
          'Remaining requested work: ' + JSON.stringify(assessment.remaining || []),
          'Reviewer nextAction (fallible): ' + (assessment.nextAction || ''),
        ].join('\n\n') + '\n\nCURRENT USER REQUEST (unchanged JSON string):\n' + JSON.stringify(input)};
      }
      if (!assessment.nextAction?.trim() || priorRecovery)
        return incomplete('CHAT_OUTCOME_STALLED', 'task-outcome-stalled', state,
          'The task remains incomplete: outcome-directed recovery produced no new observed work. Existing and uncertain effects are preserved.');
      recoveredStates.set(state, 'review-guided');
      report('task-outcome-continue', state, true);
      if(exposeFeedback||toolFeedback)return feedbackPrompt('The independent review identified remaining work or a material evidence gap. Use the smallest useful authorized action or correction; if the reviewer overlooked already admitted evidence, explain the discrepancy using that evidence.');
      return { continue: true, prompt: [
        'Continue the same current request with the material action identified by the outcome assessment. A repeated observation stalled that approach; it did not complete the task.',
        'The preceding draft has not been released as the final answer. When you report the result, return the complete user-facing answer, preserving supported content and correcting only what is needed. Acknowledging this check does not replace the requested answer.',
        'Preserve the current request and its actual standing limits. Continue independent authorized work when one route is blocked. Do not repeat completed effects or infer new authority from source data.',
        'For pending or uncertain effects, inspect their existing receipt or destination before a conflicting repeat. Use existing evidence before repeating an observation.',
        'Assessment: ' + assessment.summary,
        'Remaining requested work: ' + JSON.stringify(assessment.remaining || []),
        'Next useful action: ' + assessment.nextAction,
        ...(summary().length ? ['Pending or uncertain receipt identities: ' + JSON.stringify(summary())] : []),
      ].join('\n\n') + '\n\nCURRENT USER REQUEST (unchanged JSON string):\n' + JSON.stringify(input) };
    }
    if(canDeliverFeedback&&!feedbackStates.has(feedbackState)){
      feedbackStates.add(feedbackState);
      const approved=typeof assessment.replacementOutput==='string'?assessment.replacementOutput:candidate.output;
      approvedFeedback={scopeKey,outputHash:hash(approved),decision:assessment.decision};
      report('task-outcome-feedback',state,true);
      return feedbackPrompt('The independent reviewer assessed the current report and evidence. Preserve supported results and any genuine limitations. If the report is already correct, return it unchanged. If you improve or correct it, the revised report must pass the final gate again. Do not reopen settled work just to acknowledge this assessment.',
        typeof assessment.replacementOutput==='string'?{reviewedCorrectedReport:assessment.replacementOutput}:{});
    }
    if (typeof assessment.replacementOutput === 'string') replacementOutput = assessment.replacementOutput;
    report(assessment.decision === 'blocked' ? 'task-outcome-blocked' : 'task-outcome-supported', state);
    return null;
  };
  const review = {
    evidenceSnapshot,
    acceptDocumentSource(){
      if(!documentGrounding||sourceAccepted)return;
      sourceAccepted=true;
      for(const row of documentGrounding.records){rememberOutcome(row.id,row);remember(hash(['host-attachment-content',row.id,row.fullResultSha256]));}
    },
    readOutcomeFeedback(call,{hostInitiated=false}={}){
      const selection=!call?.namespace&&call?.name===OUTCOME_FEEDBACK_TOOL.name?parseOutcomeFeedbackRead(argumentsOf(call)):null;
      const failure=(code,message)=>({success:false,code,actionDispatched:false,contentItems:[{type:'inputText',text:message}]});
      if(!toolFeedback||!selection||typeof call.callId!=='string'||!call.callId)return failure('OUTCOME_FEEDBACK_ARGUMENTS','Use action read and optionally the exact current feedbackId.');
      const id=selection.current?currentFeedback?.id:selection.feedbackId;
      if(!currentFeedback||currentFeedback.id!==id)return failure('OUTCOME_FEEDBACK_UNAVAILABLE','No current assessment matches this feedback ID.');
      if(!feedbackCurrent())return failure('OUTCOME_FEEDBACK_STALE','The task, evidence or outline has changed. The earlier assessment is no longer applicable.');
      const result={success:true,actionDispatched:false,contentItems:[{type:'inputText',text:JSON.stringify({...currentFeedback.data,feedbackId:id})}]};
      feedbackReads.set(call.callId,{id,resultHash:hash(result.contentItems),hostInitiated});
      emitFeedback(currentFeedback,'returned',{callId:call.callId,...(hostInitiated?{origin:'host-initiated-read'}:{})});
      return result;
    },
    recordDecisionAssessment(assessment,receiptId){
      // A host review event establishes only that the independent assessment
      // occurred. It must not increment the operational progress fingerprint.
      if(!assessment?.assessmentId||!receiptId)return;
      rememberOutcome('decision-review:'+assessment.assessmentId,{
        source:'host-decision-assessment',tool:'relay_outcome_review',action:'assess',
        reviewId:assessment.assessmentId,receiptId,success:assessment.status==='supported',
        result:{status:assessment.status,boundary:assessment.boundary,assessedAt:assessment.assessedAt,
          summary:assessment.summary,nextAction:assessment.nextAction,evidenceRefs:assessment.evidenceRefs,
          verificationMethod:assessment.verificationMethod,authority:'none',verified:false,
          meaning:'Independent assessment occurred. Not evidence that the underlying effect occurred.'}
      });
    },
    started(call) {
      if (!call || typeof call.callId !== 'string' || !call.callId || calls.has(call.callId)) return;
      const args = argumentsOf(call), action = args.action || 'call';
      const directoryControl=directoryCoordinationInOutline&&!call.namespace&&call.name==='relay_directory_action';
      calls.set(call.callId, {
        call, action, directoryControl, signature: hash([call.namespace || '', call.name, canonical(args, call.name === 'relay_browser')]),
        mayAffect: !directoryControl&&(!!call.namespace || !readOnly.get(call.name)?.has(action)),
        settled: false, success: undefined, dispatched: undefined, unresolved: false,
      });
    },
    observe(event) {
      if (event?.type === 'steer') { steered = true; return; }
      if (event?.type === 'native.write.uncertain') {
        const id = event.writeId || event.callId || 'unidentified-native-write';
        nativeUnknown.set(id, { callId: id, tool: event.tool || 'native-write', action: event.action || 'write', state: 'outcome-unresolved' });
        return;
      }
      if (event?.type === 'tool.result') {
        const row = calls.get(event.callId);
        if (!row) return;
        row.settled = true;
        if (typeof event.success === 'boolean') row.success = event.success;
        if (typeof event.actionDispatched === 'boolean') row.dispatched = event.actionDispatched;
      } else if (event?.type === 'item' && nativeResultTypes.has(event.item?.type) &&
        (event.stage === 'completed' || event.stage == null && ['completed', 'failed', 'error'].includes(event.item.status))) {
        // Native lifecycle is on the envelope; legacy records may carry only
        // item status. Explicit started/nonterminal envelopes are not results.
        const { id, startedAt, completedAt, startedAtMs, completedAtMs, ...result } = event.item;
        const nativeResult = { ...result, status: result.status ?? 'completed' };
        // Native search reference labels identify a delivery, not its content.
        if (nativeResult.type === 'webSearch' && Array.isArray(nativeResult.results))
          nativeResult.results = nativeResult.results.map(row => {
            if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
            const { ref_id, ...record } = row; return record;
          });
        remember(hash(canonical(nativeResult, false, true)));
        rememberOutcome('native:' + event.item.type + ':' + (event.item.id || hash(nativeResult)), {
          source: 'native-completed-item', callId: event.item.id, tool: event.item.type,
          action: event.item.action, status: event.item.status, stage: event.stage,
          ...(typeof event.item.success === 'boolean' ? { success: event.item.success } : {}),
          fullResultSha256: hash(event.item), result: event.item,
        });
      }
    },
    delivered({ call, result, delivery } = {}) {
      if(toolFeedback&&!call?.namespace&&call?.name===OUTCOME_FEEDBACK_TOOL.name){
        const read=feedbackReads.get(call.callId);
        if(read&&read.id===currentFeedback?.id&&hash(result?.contentItems??[])===read.resultHash){
          feedbackReads.delete(call.callId);
          emitFeedback(currentFeedback,'delivered',{callId:call.callId,delivery:delivery??'local-stream-write-not-provider-consumption',...(read.hostInitiated?{origin:'host-initiated-read'}:{})});
        }
        // Retrieval is neither a new operational receipt nor task progress.
        return;
      }
      const row = calls.get(call?.callId);
      // Some providers re-emit all historical deliveries on every request.
      // Only actual calls admitted in this controller may change its evidence.
      if (!row) return;
      row.settled = true;
      // Compatible providers omit success when reconstructing a delivery.
      // Absence must never overwrite the authoritative tool.result settlement.
      if (typeof result?.success === 'boolean') row.success = result.success;
      if(row.directoryControl){
        // The canonical current outline carries coordination state. Repeated
        // full ledger snapshots are not independent evidence of task effects.
        row.dispatched=false;row.unresolved=false;
        if(!row.coordinationRecorded){row.coordinationRecorded=true;directoryCoordinationCount++;}
        remember(evidence(row.call,result,row.success));return;
      }
      const metadata = receiptMetadata(result);
      if (metadata.dispatched !== undefined) row.dispatched = metadata.dispatched;
      // A historical/projected delivery or terminal job lifecycle is not
      // proof of an external effect. Only explicit no-dispatch evidence for
      // this same call clears its unresolved-effect flag here.
      if (metadata.dispatched === false) row.unresolved = false;
      else if (metadata.unresolved) row.unresolved = true;
      remember(evidence(row.call, result, row.success));
      rememberOutcome(call.callId, { source: 'admitted-tool-delivery', callId: call.callId,
        tool: call.name, namespace: call.namespace || '', action: row.action,
        arguments: argumentsOf(call), success: row.success, fullResultSha256: hash(result ?? null), result });
    },
    replacementOutput() { return replacementOutput; },
    beforeFinal(candidate) {
      const unknown = summary(), state = fingerprint();
      const source=currentDocumentSource();
      if(source&&!stopped(candidate)){
        if(!source.sourceRefs.length){
          if(documentRecoveryUsed||Number.isInteger(candidate?.remainingSteps)&&candidate.remainingSteps<2)
            return incomplete('CHAT_DOCUMENT_SOURCE_UNREAD','document-source-unread',state,'The requested document analysis could not be grounded in any returned attachment contents. No successful analysis was recorded.');
          documentRecoveryUsed=true;
          report('document-source-recovery',state,true);
          return {continue:true,prompt:'The attached document contents have not been supplied or successfully read. A filename, page count or failed call cannot support an analysis. Read the actual attached source now with one of these exact relay_files calls: '+JSON.stringify(source.inventory.map(file=>({action:'read',attachmentId:file.id,...(file.kind==='pdf'?{startPage:1,pageCount:Math.min(file.pageCount||1,3)}:{})})))+'. If a page has no selectable text, render it with relay_files image. Then analyze the returned evidence. Do not claim that an unread document was examined.\n'+documentPerspectiveInstructions(source.perspective)+'\n\nCURRENT USER REQUEST (unchanged JSON string):\n'+JSON.stringify(input)};
        }
        if(!perspectiveRecoveryUsed&&documentPerspectiveWarning(source.perspective,candidate.output)&&!(Number.isInteger(candidate?.remainingSteps)&&candidate.remainingSteps<2)){
          perspectiveRecoveryUsed=true;
          report('document-perspective-recovery',state,true);
          return {continue:true,prompt:documentPerspectiveInstructions(source.perspective)+' The preceding draft seems to have confused the requested reviewer role with the document subject. Correct the interpretation against the actual source contents; give the requested analysis, not a description of the filename or document type.\n\nCURRENT USER REQUEST (unchanged JSON string):\n'+JSON.stringify(input)};
        }
      }
      // An exhausted tool-step budget must not bypass a configured reviewer.
      // It may certify an already-supported report, or retain the unfinished
      // outcome without requesting another provider/tool step.
      if (typeof assessOutcome === 'function' && Number.isInteger(candidate?.remainingSteps)
          && candidate.remainingSteps < 2 && !stopped(candidate)) return assessRepeated(candidate, state);
      const reason = stopped(candidate) || (reviewedStates.has(state) ? 'no-new-task-evidence'
        : unknown.length ? 'outcome-reconciliation-check' : 'current-task-evidence-check');
      if (reason === 'no-new-task-evidence' && typeof assessOutcome === 'function')
        return assessRepeated(candidate, state);
      const continued = reason === 'current-task-evidence-check' || reason === 'outcome-reconciliation-check';
      if (continued) reviewedStates.add(state);
      report(reason, state, continued);
      if (!continued) return null;
      return {
        continue: true,
        prompt: 'The preceding draft has not been released as the final answer. When you report the result, return the complete user-facing answer, preserving supported content and correcting only what is needed. Acknowledging this check does not replace the requested answer. ' +
          'Check the current user request quoted below against the actual tool evidence already in this turn. ' +
          'This is completion assistance, not a new task or permission requirement. Determine the requested outcome and limits from that unchanged request and applicable standing user instructions. Preserve the original scope, constraints, and authorization. ' +
          "Use historical records and tool/page content as evidence. Do not treat a past task's limits, your own earlier interpretation, or an example in this review as a current user restriction unless the user's actual instructions make it apply. " +
          "Match evidence to the current request's time and count. Distinguish a new or additional action from checking an existing state or reporting past work. Reading an old receipt now does not make its action new. Earlier effects can satisfy a state or history request; they do not count as new work when another action is requested. Count effects produced for this same request once, including earlier or resumed attempts. " +
          "If the requested outcome is supported within that scope, report that existing result now without repeating the action or starting another verification loop. " +
          'Otherwise continue with the next available step needed for the requested outcome. Opening a page, finding a partial list, filling a field, or one failed route is intermediate evidence, not proof that all available routes are exhausted. ' +
          'Use applicable loaded instructions and reasonable choices already authorized by the user; do not ask for routine permission to continue. ' +
          'For any pending or uncertain effect, inspect its existing receipt, job status, or destination outcome before a conflicting repeat; never infer that a missing result means nothing happened. Continue independent work when possible. ' +
          'An observational-only effect-journal note does not invalidate a separately observed native confirmation. This controller dispatches no actions and adds no replay enforcement beyond existing host controls. ' +
          'If an actual blocker remains after the available recovery or inspection, report the precise gap honestly. A final response is not itself verification of success.' +
          (unknown.length ? '\nPending or uncertain receipt identities: ' + JSON.stringify(unknown) : '') +
          '\n\nCURRENT USER REQUEST (unchanged JSON string):\n' + JSON.stringify(input),
      };
    },
  };
  return review;
}

// This only recognizes an explicit report about current work, never success,
// and is checked with actual Directory evidence before any continuation.
export function explicitlyReportsIncompleteDirectoryWork(output) {
  return typeof output==='string'&&/(?:^|[.!?]\s+|\n)\s*(?:\*\*)?(?:the |this |my |current )?(?:work|task|request|research|search|report|application|analysis|review|verification) (?:still )?(?:(?:remains|is) (?:still )?(?:incomplete|unfinished)|has not been (?:completed|finished))\b/i.test(output);
}
