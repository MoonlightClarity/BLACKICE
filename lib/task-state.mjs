import { promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { projectContractTaskState } from './planning-contract-delivery.mjs';
import { PLAN_CONTRACT_SCHEMA, CONTRACT_RECEIPT_BINDING_SCHEMA, CONTRACT_INSTRUCTIONS, normalizePlanContract, validatePlanContractFeasibility, isPlanContractTask, assertCommitPrerequisites, receiptBindingsForCriterion } from '../public/planning-contract-model.mjs';
import { readContractJournal, contractRuntimeView, validateContractPlanTransition, applyContractTaskAction, hasPendingBrowserReceipt } from './planning-contract-runtime.mjs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TASK_PLAN_VERSION, TASK_PLAN_LIMITS, TASK_PLAN_STATUSES, TASK_PLAN_DETAILS, runtimeTaskPlan, normalizeTaskPlan, taskPlanProgress, taskPlanAvailability } from './task-plan.mjs';
import { applyPlanningEdits, replaceOwnedPlan, planningScope } from './planning-edits.mjs';
import { bindWorkflowPlan, executionReadiness } from './planning-runtime.mjs';
import { planningModeOf, validatePlanningOutline, ADVISORY_PLANNING_INSTRUCTIONS } from './planning-policy.mjs';
import { validateDocumentAnalysisOutline } from './document-analysis-policy.mjs';
import { PlanningAwareness } from './planning-awareness.mjs';
import { EXECUTION_LIMITS, executionReceipt, appendExecutionReceipt, executionView, compactExecution } from './planning-execution.mjs';
import { checkPlanningEvidenceLength } from './planning-evidence.mjs';
import { archiveTaskRevisions, readArchivedTaskRevisions } from './task-state-history-archive.mjs';
import { validateSequentialPlanTransition, planningSequenceStatus } from './planning-sequence.mjs';
import { appendPlanningReview, compactPlanningReviewRecords, normalizePlanningReview, recordPlanningOutcome, validateSavedPlanningReviews } from './planning-review.mjs';
import { applyPlanningDocumentOperations, projectPlanningDocument, validateSavedPlanningDocument } from './planning-document.mjs';
import { USER_AGENCY_CHECKPOINT_SCHEMA } from '../public/planning-user-agency.mjs';

export const TASK_LIMITS = Object.freeze({ artifacts: 40, revisions: 30, stateChars: 432000, agentStateChars: 410000, artifactBytes: 128 * 1024 * 1024, downloadBytes: 32 * 1024 * 1024, textPreviewBytes: 2 * 1024 * 1024, imagePreviewBytes: 10 * 1024 * 1024, contextChars: 12000 });
const stamp = () => new Date().toISOString();
const copy = value => structuredClone(value);
const projectState = state => ({ ...projectPlanningDocument(state), availableWork: taskPlanAvailability(state) });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'INVALID_TASK_STATE', status = 400) => Object.assign(new Error(message), { code, status });
const outcomeCriterionIdentity = ({ id, label, description, kind, accuracy, targetCount = 1 }) =>
  JSON.stringify({ id, label, description, kind, accuracy, targetCount });
function assertAdoptedGoal(state, goal) {
  if (state.contractAdoption && goal !== state.contract.goal)
    throw fail('Keep the adopted goal when refining work. A changed goal needs a human edit or a newly accepted Plan.', 'TASK_CONTRACT_GOAL_CHANGE', 409);
}
const check = signal => { if (signal?.aborted) throw Object.assign(fail('Task state operation cancelled.', 'ABORT_ERR'), { name: 'AbortError' }); };
export const delegatedPlanNodeId = (nodeId, workerId) => 'delegate-' + createHash('sha256').update(`${nodeId}\0${workerId}`).digest('hex').slice(0, 24);
const identifier = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)) throw fail('Use a valid task identifier.'); return value; };
const text = (value, name, max, required = false) => { if (typeof value !== 'string' || value.includes('\0') || value.length > max || required && !value.trim()) throw fail(`${name} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`); return value.trim(); };
function emailDestination(value) {
  const invalid = () => fail('External destination must be an absolute HTTP(S) URL or one email address, optionally prefixed with mailto:. Keep subject and body in content; omit headers, query, fragment and additional recipients.');
  const raw = text(value, 'External destination', 2048, true);
  if (/[\s\u0000-\u001f\u007f]/.test(value)) throw invalid();
  let address = raw;
  if (/^mailto:/i.test(raw)) {
    if (raw.slice(7).startsWith('//') || /[?#]/.test(raw.slice(7))) throw invalid();
    try { address = decodeURIComponent(raw.slice(7)); } catch { throw invalid(); }
  }
  if (/[\s\u0000-\u001f\u007f]/.test(address)) throw invalid();
  const match = /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+)@([A-Za-z0-9.-]+)$/.exec(address);
  if (!match || match[1].length > 64 || match[2].length > 253 || match[1].startsWith('.') || match[1].endsWith('.') || match[1].includes('..') || match[2].split('.').some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) throw invalid();
  // Preserve the potentially case-sensitive mailbox name. This normalization
  // applies only to new prepare input, never to saved receipt fingerprints.
  return `mailto:${encodeURIComponent(match[1])}@${match[2].toLowerCase()}`;
}
function emailMessageReference(value) {
  const invalid = () => fail('Email confirmation requires one mid: URI derived from the observed RFC Message-ID, without angle brackets, URI authority, path, query, fragment, whitespace or controls. Percent-encode reserved Message-ID characters.');
  const raw = text(value, 'Email message reference', 2048, true);
  if (value !== raw || !/^mid:/i.test(raw) || /[\s\u0000-\u001f\u007f/?#]/.test(raw.slice(4))) throw invalid();
  let decoded;
  try { decoded = decodeURIComponent(raw.slice(4)); } catch { throw invalid(); }
  const match = /^([^@]+)@(.+)$/.exec(decoded);
  const dotAtom = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  if (!match || !dotAtom.test(match[1]) || !(dotAtom.test(match[2]) || /^\[[\x21-\x5a\x5e-\x7e]*\]$/.test(match[2]))) throw invalid();
  // Message-ID is opaque and can be case-sensitive. Decode once and re-encode
  // each side of its separator; a percent-encoded slash stays identity data,
  // never the content-id path supported by other forms of the mid scheme.
  const canonical = `mid:${encodeURIComponent(match[1])}@${encodeURIComponent(match[2])}`;
  if (canonical.length > 2048) throw invalid();
  return { url: canonical, referenceKind: 'email-message', emailMessageId: `<${decoded}>` };
}
const strings = (value, name, max = 8) => { if (!Array.isArray(value) || value.length > max) throw fail(`${name} must have at most ${max} entries.`); return value.map(item => text(item, name, 700, true)); };
function provenance(value = {}, source = 'agent') {
  const result = { source, at: stamp() };
  for (const key of ['runId', 'nodeId']) if (value[key] !== undefined) result[key] = identifier(value[key]);
  if (value.actor !== undefined) {
    if (!object(value.actor) || !['external-agent', 'human-client'].includes(value.actor.type) || Object.keys(value.actor).some(key => !['type', 'id', 'name'].includes(key))) throw fail('Use a verified client actor identity.');
    result.actor = { type: value.actor.type, id: identifier(value.actor.id), ...(value.actor.name === undefined ? {} : { name: text(value.actor.name, 'Client name', 120, true) }) };
  }
  return result;
}
function normalizeSteps(steps) {
  if (!Array.isArray(steps)) throw fail('Plan milestones must be an array.');
  const ids = new Set(), result = []; let active = 0, serializedChars = 2;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!object(step)) throw fail('A plan step must be an object.');
    const id = identifier(step.id || `step-${index + 1}`), title = text(step.title, 'Step title', 300, true), status = step.status || 'pending';
    if (ids.has(id)) throw fail('Plan step identifiers must be unique.'); ids.add(id);
    if (!['pending', 'active', 'blocked', 'done'].includes(status)) throw fail('Step status must be pending, active, blocked or done.');
    if (status === 'active' && ++active > 1) throw fail('Keep one current plan step active at a time.');
    const doneWhen = step.doneWhen === undefined ? undefined : text(step.doneWhen, 'Done when', 1000, true);
    if (step.evidence !== undefined) checkPlanningEvidenceLength(step.evidence);
    const evidence = step.evidence === undefined ? undefined : text(step.evidence, 'Milestone evidence', 2000);
    const blockedReason = step.blockedReason === undefined ? undefined : text(step.blockedReason, 'Blocked reason', 1000, true);
    if (status === 'blocked' && !blockedReason) throw fail('A blocked milestone needs a reason describing what prevents the next action.');
    const normalized = { id, title, status, ...(step.note === undefined ? {} : { note: text(step.note, 'Step note', 700) }), ...(doneWhen === undefined ? {} : { doneWhen }), ...(evidence === undefined ? {} : { evidence }), ...(status === 'blocked' ? { blockedReason } : {}) };
    // A byte-shaped storage budget, rather than a milestone count, bounds validation
    // and allocation even when a caller supplies an enormous array.
    serializedChars += JSON.stringify(normalized).length + (index ? 1 : 0);
    if (serializedChars > TASK_LIMITS.stateChars) throw fail('This plan exceeds the saved continuity size limit. Shorten milestone details.', 'TASK_STATE_LIMIT', 413);
    result.push(normalized);
  }
  return result;
}
function checkpoint(value, previousGoal) {
  if (!object(value)) throw fail('A checkpoint must be an object.');
  return { kind: 'agent', goal: text(value.goal ?? previousGoal, 'Goal', 2000, true), decisions: strings(value.decisions || [], 'Decisions'), completed: strings(value.completed || [], 'Completed work'), nextSteps: strings(value.nextSteps || [], 'Next steps'), openQuestions: strings(value.openQuestions || [], 'Open questions'), ...(value.nextAction === undefined ? {} : { nextAction: text(value.nextAction, 'Next action', 1000, true) }) };
}
const progress = steps => ({ total: steps.length, done: steps.filter(step => step.status === 'done').length, current: steps.find(step => step.status === 'active') || steps.find(step => step.status === 'blocked') || steps.find(step => step.status === 'pending') || null, source: 'agent-reported-plan' });
const focusSignature = steps => { const current = progress(steps).current; return current ? JSON.stringify([current.id, current.title, current.status, current.doneWhen || '']) : ''; };
const taskFocusSignature = state => { const current = taskPlanProgress(state).current; return current ? JSON.stringify([current.id, current.title, current.status, current.doneWhen || '']) : ''; };
function supersedeCheckpointAction(value, previous, current) {
  const next = { ...value, supersededNextAction: { text: text(value.nextAction, 'Superseded next action', 1000, true), reason: 'plan-focus-changed', previousStepId: previous?.id || null, currentStepId: current?.id || null } };
  delete next.nextAction;
  return next;
}
function replaceSteps(state, steps) {
  if (focusSignature(state.steps) !== focusSignature(steps) && state.checkpoint?.nextAction !== undefined) {
    // Retain one prior recovery instruction for re-evaluation, without making
    // it the current action or a permit to replay an external effect.
    state.checkpoint = supersedeCheckpointAction(state.checkpoint, progress(state.steps).current, progress(steps).current);
  }
  state.steps = steps; return state;
}
function replaceBranchingPlan(state, planned) {
  const next = { ...state, ...planned };
  if (taskFocusSignature(state) !== taskFocusSignature(next) && next.checkpoint?.nextAction !== undefined) {
    next.checkpoint = supersedeCheckpointAction(next.checkpoint, taskPlanProgress(state).current, taskPlanProgress(next).current);
  }
  return next;
}
async function atomic(file, content, signal, beforePublish = async () => {}) {
  check(signal); const temporary = `${file}.${randomUUID()}.tmp`;
  try { const handle = await fs.open(temporary, 'wx', 0o600); try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); } check(signal); await beforePublish(); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
const lockBusy = () => fail('This task is being updated elsewhere or its lock cannot be safely recovered. Read its latest state and retry.', 'TASK_STATE_BUSY', 409);
const ownerDead = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
async function publishTaskLock(file, token, signal) {
  check(signal); const temporary = `${file}.${randomUUID()}.tmp`; let handle, published = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); check(signal);
    // Exclusive hard-link publication never exposes an empty ownership record.
    await fs.link(temporary, file); published = true; return handle;
  } finally { if (!published) await handle?.close(); await fs.rm(temporary, { force: true }).catch(() => {}); }
}
async function releaseTaskLock(file, handle, token) {
  await handle.close();
  try { if (JSON.parse(await fs.readFile(file, 'utf8')).token === token) await fs.unlink(file); } catch {}
}
async function acquireTaskLock(file, token, signal, depth = 0) {
  check(signal); if (depth > 16) throw lockBusy();
  try { return await publishTaskLock(file, token, signal); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  let raw, owner;
  try { const info = await fs.stat(file); if (!info.isFile() || info.size > 65536) throw lockBusy(); raw = await fs.readFile(file, 'utf8'); owner = JSON.parse(raw); } catch { throw lockBusy(); }
  // Age is never evidence that a writer has died. Inaccessible and legacy locks
  // stay closed; a live slow hash/write cannot lose ownership after a timeout.
  if (!ownerDead(owner.pid) || typeof owner.token !== 'string' || !owner.token) throw lockBusy();
  // Contenders for the same dead generation serialize on a shared claim. A
  // crashed reclaimer's claim is recovered through its own dead generation.
  const claim = `${file}.reclaim-${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`, handle = await acquireTaskLock(claim, token, signal, depth + 1);
  try {
    let current; try { current = await fs.readFile(file, 'utf8'); } catch { throw lockBusy(); }
    if (current !== raw || !ownerDead(owner.pid)) throw lockBusy();
    check(signal); await fs.unlink(file);
    try { return await publishTaskLock(file, token, signal); } catch (error) { if (error.code === 'EEXIST') throw lockBusy(); throw error; }
  } finally { await releaseTaskLock(claim, handle, token); }
}
const imageType = bytes => bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : /^GIF8[79]a/.test(bytes.subarray(0,6).toString('ascii')) ? 'image/gif' : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : null;
const isText = bytes => { if (bytes.includes(0)) return false; try { new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }); return true; } catch { return false; } };
async function verifyFile(file, { signal, maxBytes = TASK_LIMITS.artifactBytes, includeBytes = false } = {}) {
  check(signal); let realPath, initial;
  try { realPath = await fs.realpath(file); initial = await fs.stat(realPath); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw fail('This file no longer exists. Check and register the current deliverable again.', 'ARTIFACT_MISSING', 404); throw error; }
  if (!initial.isFile()) throw fail('An artifact must be an existing regular file.', 'ARTIFACT_NOT_FILE');
  if (initial.size > maxBytes) throw fail('The artifact exceeds the file size limit.', 'ARTIFACT_TOO_LARGE', 413);
  const handle = await fs.open(realPath, 'r');
  try {
    const before = await handle.stat(); if (!before.isFile()) throw fail('An artifact must be an existing regular file.', 'ARTIFACT_NOT_FILE');
    if (before.size > maxBytes) throw fail(`This file exceeds the ${Math.floor(maxBytes / 1048576)} MB file limit.`, 'ARTIFACT_TOO_LARGE', 413);
    const digest = createHash('sha256'), buffer = Buffer.alloc(256 * 1024), chunks = []; let position = 0, sample = Buffer.alloc(0);
    while (true) { check(signal); const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; position += bytesRead; if (position > maxBytes) throw fail('The artifact grew beyond the file limit.', 'ARTIFACT_TOO_LARGE', 413); const chunk = buffer.subarray(0, bytesRead); digest.update(chunk); if (!sample.length) sample = Buffer.from(chunk.subarray(0, 8192)); if (includeBytes) chunks.push(Buffer.from(chunk)); }
    const after = await handle.stat(); check(signal);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || position !== before.size) throw fail('The file changed while being checked. Register it again after writing finishes.', 'ARTIFACT_CHANGED', 409);
    const mimeType = imageType(sample), previewKind = mimeType ? 'image' : isText(sample) ? 'text' : 'download';
    return { path: realPath, size: before.size, sha256: digest.digest('hex'), modifiedAt: before.mtime.toISOString(), mimeType: mimeType || (previewKind === 'text' ? 'text/plain; charset=utf-8' : path.extname(realPath).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream'), previewKind, ...(includeBytes ? { buffer: Buffer.concat(chunks) } : {}) };
  } finally { await handle.close(); }
}

/** Durable task continuity. Plan completion is agent-reported; file existence and hashes are checked by Relay. */
export class TaskStateStore {
  constructor({ dataDir, maxRevisions = TASK_LIMITS.revisions } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw fail('An absolute task-state data directory is required.');
    this.directory = path.join(dataDir, 'task-state'); this.maxRevisions = Math.max(2, Math.min(100, Math.floor(Number(maxRevisions) || TASK_LIMITS.revisions))); this.queues = new Map(); this.lockOwners = new Map(); this.listeners = new Map(); this.planCatalog = new Map(); this.initialized = null; this.closed = false;
    this.awareness = new PlanningAwareness();
  }
  init() { return this.initialized ||= fs.mkdir(this.directory, { recursive: true }).then(() => this); }
  file(taskId) { return path.join(this.directory, `${identifier(taskId)}.json`); }
  executionFile(taskId) { return path.join(this.directory, `${identifier(taskId)}.execution.json`); }
  async loadExecution(taskId) {
    try {
      const file = this.executionFile(taskId), info = await fs.stat(file);
      if (info.size > EXECUTION_LIMITS.bytes) throw new Error('Execution journal exceeds its bound.');
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value.taskId !== taskId) throw new Error('Execution journal belongs to a different task.');
      // The reducer validates the version and bounded collection structure.
      return appendExecutionReceipt(value, null).state;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async executionSnapshot(taskId) {
    const healthObservedAt = new Date().toISOString();
    try { const view = executionView(await this.loadExecution(identifier(taskId))); return view ? { ...view, healthObservedAt } : null; }
    catch { return { unavailable: true, code: 'PLANNING_EXECUTION_UNAVAILABLE', healthObservedAt, note: 'Runtime receipts could not be read. Their saved bytes were preserved; verify actual effects before repeating any operation.' }; }
  }
  recordToolReceipt(taskId, event, context) {
    const receipt = executionReceipt(event, context);
    if (!receipt) return Promise.resolve(null);
    return this.enqueue(taskId, async () => {
      await this.load(taskId); // Do not create a journal for an unknown task.
      const appended = appendExecutionReceipt(await this.loadExecution(taskId), receipt);
      if (!appended.duplicate) {
        appended.state.taskId = taskId;
        const bytes = JSON.stringify(appended.state);
        if (bytes.length > EXECUTION_LIMITS.bytes) throw new Error('Execution journal exceeds its bound.');
        await atomic(this.executionFile(taskId), bytes);
      }
      return { receipt: appended.receipt, notice: appended.notice, duplicate: appended.duplicate, observations: executionView(appended.state) };
    });
  }
  async load(taskId, missing = false) {
    const parse = async file => {
      const stat = await fs.stat(file); if (stat.size > 12 * 1024 * 1024) throw fail('Task state exceeds its bounded history limit.', 'TASK_STATE_DAMAGED', 500);
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value.version !== 1 || value.taskId !== taskId || !Array.isArray(value.history) || !value.history.length || value.history.some(item => item.taskId !== taskId || !Number.isSafeInteger(item.revision) || !Array.isArray(item.steps) || !Array.isArray(item.artifacts))) throw fail('Task state is damaged. The saved files were preserved.', 'TASK_STATE_DAMAGED', 500);
      for (const state of value.history) { validateSavedPlanningReviews(state); validateSavedPlanningDocument(state); if (state.contract !== undefined) { normalizePlanContract(state.contract, { allowEpoch: true }); if (state.steps.length) throw fail('Canonical work items cannot contain legacy atomic leaves.', 'TASK_STATE_DAMAGED', 500); } }
      for (const state of value.history) if (state.checkpoint?.supersededNextAction !== undefined) {
        const action = state.checkpoint.supersededNextAction;
        if (!object(action) || Object.keys(action).some(key => !['text', 'reason', 'previousStepId', 'currentStepId'].includes(key)) || action.reason !== 'plan-focus-changed' || typeof action.text !== 'string' || !action.text.trim() || action.text.length > 1000 || action.text.includes('\0') || ['previousStepId', 'currentStepId'].some(key => action[key] !== null && (typeof action[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(action[key])))) throw fail('Saved superseded checkpoint context is damaged. Existing files were preserved.', 'TASK_STATE_DAMAGED', 500);
      }
      for (const state of value.history) if (state.planVersion !== undefined && !isPlanContractTask(state)) {
        if (state.planVersion !== TASK_PLAN_VERSION || !object(state.plan) || !['runtime', 'agent', 'human', 'workflow'].includes(state.plan.origin) || !['sequence', 'parallel', 'choice'].includes(state.plan.layout) || !TASK_PLAN_DETAILS.includes(state.plan.detail) || state.steps.length > TASK_PLAN_LIMITS.nodes || state.plan.origin === 'runtime' && state.steps.length || ['agent', 'human', 'workflow'].includes(state.plan.origin) && !state.steps.length) throw fail('Saved task planning data is damaged. Existing files were preserved.', 'TASK_STATE_DAMAGED', 500);
        try { taskPlanProgress(state); } catch { throw fail('Saved task planning relationships are damaged. Existing files were preserved.', 'TASK_STATE_DAMAGED', 500); }
      }
      return value;
    };
    try { return await parse(this.file(taskId)); }
    catch (error) {
      let backupError;
      try {
        const recovered = await parse(`${this.file(taskId)}.bak`), latest = recovered.history.at(-1);
        // The backup is the previous revision. A newer primary may have granted
        // an external send permit before it was lost. Never roll that unknown
        // effect back into a prepared permit, including when the backup predates
        // the first receipt. Carry the guard through subsequent ordinary writes.
        latest.externalRecovery = { required: true, source: 'task-state-backup', recoveredRevision: latest.revision, note: 'The newer primary state is unreadable or missing. External outcomes and attempt counts may be incomplete; inspect the destination and reconcile before sending.' };
        if (latest.externalActions) latest.externalActions = latest.externalActions.map(receipt => {
          if (receipt.status === 'confirmed') return receipt;
          const uncertain = { ...receipt, status: 'uncertain', recoveredFromBackup: true, attemptsMayBeIncomplete: true };
          delete uncertain.recoveryReconciledAt; return uncertain;
        });
        Object.defineProperty(recovered, 'recoveredFromBackup', { value: true });
        return recovered;
      } catch (failure) { backupError = failure; }
      // A missing primary is not a new task when any saved backup still exists.
      // In particular, never replace damaged continuity with a fresh revision 1.
      if (error.code === 'ENOENT' && backupError.code === 'ENOENT') {
        if (missing) return null;
        throw fail('Task state was not found.', 'TASK_STATE_MISSING', 404);
      }
      throw fail('Task state could not be read. Existing files were preserved.', 'TASK_STATE_DAMAGED', 500);
    }
  }
  enqueue(taskId, operation, signal) {
    if (this.closed) return Promise.reject(fail('Task state is closed.', 'TASK_STATE_CLOSED', 503)); identifier(taskId);
    const prior = this.queues.get(taskId) || Promise.resolve();
    const current = prior.catch(() => {}).then(async () => {
      await this.init(); check(signal); const lock = `${this.file(taskId)}.lock`, token = randomUUID(), deadline = Date.now() + 5000; let handle;
      while (true) { try { handle = await acquireTaskLock(lock, token, signal); break; } catch (error) { if (error.code !== 'TASK_STATE_BUSY') throw error; check(signal); if (Date.now() > deadline) throw error; await delay(15, undefined, signal ? { signal } : undefined); } }
      this.lockOwners.set(taskId, token);
      try { check(signal); return await operation(); } finally { if (this.lockOwners.get(taskId) === token) this.lockOwners.delete(taskId); await releaseTaskLock(lock, handle, token); }
    }); this.queues.set(taskId, current); current.then(() => { if (this.queues.get(taskId) === current) this.queues.delete(taskId); }, () => { if (this.queues.get(taskId) === current) this.queues.delete(taskId); }); return current;
  }
  async commit(record, state, actor, source, signal, { reviewCommit = false } = {}) {
    // The unreadable primary may already have published N+1 to another client.
    // First recovery publication skips that lost revision so clients can adopt
    // its guarded truth instead of dismissing an equally numbered receipt.
    check(signal); const previous = record?.history.at(-1);
    let next = { ...copy(state), revision: (previous?.revision || 0) + (record?.recoveredFromBackup ? 2 : 1), createdAt: previous?.createdAt || stamp(), updatedAt: stamp(), provenance: provenance(actor, source), progress: taskPlanProgress(state) };
    const budget = source === 'agent' && !reviewCommit ? TASK_LIMITS.agentStateChars : TASK_LIMITS.stateChars;
    next = compactPlanningReviewRecords(next, budget, { keepLatestReview: reviewCommit });
    const actualChars = JSON.stringify(next).length;
    if (actualChars > budget) throw Object.assign(fail(`Task continuity needs ${actualChars} JSON characters; its budget is ${budget}. Shorten unfinished plan or checkpoint notes, preserving recorded results and external receipts.`, 'TASK_STATE_LIMIT', 413), { actualChars, maxChars: budget });
    // The primary file is a bounded hot window. Spill evicted revisions to
    // immutable, hash-checked archives before replacing the primary; never
    // discard detailed evidence merely because the live plan has grown.
    const candidates = [...(record?.history || []), next], history = candidates.slice(-this.maxRevisions);
    const maxBytes = 10 * 1024 * 1024;
    const encode = () => JSON.stringify({ version: 1, taskId: state.taskId, history });
    let serialized = encode(), actualBytes = Buffer.byteLength(serialized, 'utf8');
    while (actualBytes > maxBytes && history.length > 1) {
      history.shift();
      serialized = encode();
      actualBytes = Buffer.byteLength(serialized, 'utf8');
    }
    if (actualBytes > maxBytes) throw Object.assign(fail(`Task history needs ${actualBytes} UTF-8 bytes; its budget is ${maxBytes}. Existing task files were preserved.`, 'TASK_STATE_LIMIT', 413), { actualBytes, maxBytes });
    const evicted = candidates.slice(0, candidates.length - history.length);
    const assertOwnership = async () => {
      check(signal); const token = this.lockOwners.get(state.taskId); let owner;
      try { owner = JSON.parse(await fs.readFile(`${this.file(state.taskId)}.lock`, 'utf8')); } catch {}
      if (!token || owner?.token !== token || owner?.pid !== process.pid) throw fail('The task write lock changed. Existing state was preserved; read it before continuing.', 'TASK_STATE_LOCK_LOST', 409);
    };
    await assertOwnership();
    if (evicted.length) await archiveTaskRevisions(path.dirname(this.directory), state.taskId, evicted, { signal, assertOwnership });
    if (record) await atomic(`${this.file(state.taskId)}.bak`, JSON.stringify(record), signal, assertOwnership);
    await atomic(this.file(state.taskId), serialized, signal, assertOwnership);
    this.planCatalog.delete(state.taskId);
    const published = projectState(next);
    this.awareness.emit(state.taskId);
    for (const listener of this.listeners.get(state.taskId) || []) { try { listener(copy(published)); } catch {} }
    return published;
  }
  ensure({ taskId, runId, nodeId, cwd, goal = '', defaultPlan = false, planDetail = 'balanced', schemaVersion }, { signal } = {}) {
    taskId ||= runId; identifier(taskId); if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('Task workspace must be an absolute path.');
    return this.enqueue(taskId, async () => {
      const saved = await this.load(taskId, true), previous = saved?.history.at(-1);
      if (previous && path.resolve(previous.cwd) !== path.resolve(cwd)) throw fail('Continue this task in its original working folder.', 'TASK_WORKSPACE_MISMATCH', 409);
      if (previous) return projectState(previous);
      return this.commit(null, { taskId, cwd: path.resolve(cwd), goal: text(goal, 'Goal', 2000), steps: [], checkpoint: null, artifacts: [], ...(schemaVersion === 14 ? { taskSchemaVersion: 14 } : {}), ...(defaultPlan ? runtimeTaskPlan(planDetail) : {}) }, { runId, nodeId }, 'runtime', signal);
    }, signal);
  }
  /** Create a standalone shared plan atomically; this never creates a runtime execution. */
  createPlanningDocument(taskId, value, { expectedRevision, cwd, source = 'external-agent', actor, signal, executionGuardrails = false } = {}) {
    identifier(taskId);
    if (expectedRevision !== 0 || !object(value) || Object.keys(value).some(key => !['goal', 'plan', 'steps', 'userAgency'].includes(key)))
      throw fail('Explicit plan creation requires expectedRevision 0 and goal, steps, optional plan and userAgency.');
    if (!['external-agent', 'human'].includes(source) || !actor || (source === 'external-agent' ? actor.type !== 'external-agent' : actor.type !== 'human-client'))
      throw fail('Standalone creation requires a verified planning client author.');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('The configured Planning workspace must be an absolute path.');
    const goal = text(value.goal, 'Goal', 2000, true), author = provenance({ actor }, source);
    return this.enqueue(taskId, async () => {
      const saved = await this.load(taskId, true);
      if (saved) throw Object.assign(fail('This task already exists. Read its current revision before editing.', 'TASK_STATE_CONFLICT', 409), { currentRevision: saved.history.at(-1).revision });
      const planned = normalizeTaskPlan({ plan: value.plan, steps: value.steps }, { actor: { source, actor }, executionGuardrails });
      validatePlanningOutline(planned, { source, executionGuardrails });
      let next = { taskId, cwd: path.resolve(cwd), goal, checkpoint: null, artifacts: [], ...planned,
        standalonePlan: { version: 1, kind: 'standalone', createdBy: author } };
      if (value.userAgency !== undefined) next = applyPlanningDocumentOperations(next, { operations: [{ type: 'agency_checkpoint', userAgency: value.userAgency }] }, { source, actor }).state;
      return this.commit(null, next, { actor }, source, signal);
    }, signal);
  }
  /** Atomic canonical standalone creation. Intent only: no worker or outcome journal is created. */
  createCanonicalPlanningDocument(taskId, value, { expectedRevision, cwd, source = 'external-agent', actor, signal } = {}) {
    identifier(taskId);
    if (expectedRevision !== 0 || !object(value) || Object.keys(value).some(key => !['contract', 'userAgency'].includes(key)))
      throw fail('Canonical creation requires expectedRevision 0, contract and optional userAgency.');
    if (!['external-agent', 'human'].includes(source) || !actor || (source === 'external-agent' ? actor.type !== 'external-agent' : actor.type !== 'human-client'))
      throw fail('Standalone creation requires a verified planning client author.');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('The configured Planning workspace must be an absolute path.');
    const contract = validatePlanContractFeasibility(normalizePlanContract(value.contract)), author = provenance({ actor }, source);
    return this.enqueue(taskId, async () => {
      const saved = await this.load(taskId, true);
      if (saved) throw Object.assign(fail('This task already exists. Read its current revision before editing.', 'TASK_STATE_CONFLICT', 409), { currentRevision: saved.history.at(-1).revision });
      let next = { taskId, cwd: path.resolve(cwd), goal: contract.goal, steps: [], checkpoint: null, artifacts: [],
        taskSchemaVersion: 14, contract: { ...contract, planEpoch: 1 },
        standalonePlan: { version: 1, kind: 'standalone', createdBy: author } };
      if (value.userAgency !== undefined) next = applyPlanningDocumentOperations(next, { operations: [{ type: 'agency_checkpoint', userAgency: value.userAgency }] }, { source, actor }).state;
      return this.commit(null, next, { actor }, source, signal);
    }, signal);
  }
  async get(taskId, { signal } = {}) {
    await this.init(); check(signal); const state = projectState((await this.load(identifier(taskId))).history.at(-1));
    if (isPlanContractTask(state) || state.taskSchemaVersion === 14) {
      const journal = await readContractJournal(this, taskId), contractRuntime = contractRuntimeView(state, journal), projected = { ...state, contractRuntime };
      return { ...projected, progress: taskPlanProgress(projected), availableWork: taskPlanAvailability(projected) };
    }
    const observed = await this.executionSnapshot(taskId); return observed ? { ...state, executionObservations: observed } : state;
  }
  async history(taskId, { signal, includeArchived = false } = {}) {
    await this.init(); check(signal);
    const id = identifier(taskId), recent = (await this.load(id)).history;
    if (!includeArchived) return recent.map(projectState);
    const archived = await readArchivedTaskRevisions(path.dirname(this.directory), id, { signal });
    const byRevision = new Map(archived.map(state => [state.revision, state]));
    for (const state of recent) {
      const other = byRevision.get(state.revision);
      if (other && JSON.stringify(other) !== JSON.stringify(state)) throw fail('Archived task revision conflicts with the live history.', 'TASK_STATE_DAMAGED', 500);
      byRevision.set(state.revision, state);
    }
    return [...byRevision.values()].sort((a,b) => a.revision - b.revision).map(projectState);
  }
  subscribe(taskId, listener) {
    identifier(taskId); if (typeof listener !== 'function') throw fail('A task listener is required.');
    if (!this.listeners.has(taskId)) this.listeners.set(taskId, new Set());
    this.listeners.get(taskId).add(listener);
    return () => { const listeners = this.listeners.get(taskId); listeners?.delete(listener); if (!listeners?.size) this.listeners.delete(taskId); };
  }
  async listPlans({ query = '', limit = 50, offset = 0, taskIds, queryTaskIds, standaloneOnly = false, signal } = {}) {
    if (typeof query !== 'string' || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw fail('Use a bounded plan query, a limit from 1 to 200, and a nonnegative offset.');
    if (taskIds !== undefined && (!Array.isArray(taskIds) || taskIds.length > 100000)) throw fail('The plan task allowlist must be a bounded array.');
    if (queryTaskIds !== undefined && (!Array.isArray(queryTaskIds) || queryTaskIds.length > 100000)) throw fail('The title-match allowlist must be a bounded array.');
    if (typeof standaloneOnly !== 'boolean') throw fail('Use a Boolean standalone plan filter.');
    const allowed = taskIds && new Set(taskIds.map(identifier));
    const titleMatches = new Set((queryTaskIds || []).map(identifier));
    await this.init(); check(signal);
    const names = await fs.readdir(this.directory), ids = new Set();
    for (const name of names) if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.json(?:\.bak)?$/.test(name)) {
      const taskId = name.replace(/\.json(?:\.bak)?$/, ''); if (!allowed || allowed.has(taskId)) ids.add(taskId);
    }
    const entries = [...ids]; if (entries.length > 100000) throw fail('The plan catalog exceeds its supported scan limit.', 'TASK_PLAN_LIMIT', 413);
    const plans = [], errors = []; let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        check(signal); const taskId = entries[cursor++];
        try {
          const info = await fs.stat(this.file(taskId)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
          const key = info ? `${info.mtimeMs}:${info.ctimeMs}:${info.size}` : null, cached = this.planCatalog.get(taskId);
          let plan;
          if (key && cached?.key === key && cached.plan.contractVersion !== 2) plan = copy(cached.plan);
          else {
            const state = await this.get(taskId, { signal }), progress = state.progress || taskPlanProgress(state);
            plan = { taskId, goal: state.goal, ...(state.standalonePlan ? { standalonePlan: copy(state.standalonePlan) } : {}), revision: state.revision, ...(isPlanContractTask(state) ? { contractVersion: 2, planEpoch: state.contract.planEpoch, journalSeq: state.contractRuntime.journalSeq, workItemCount: state.contract.workItems.length } : {}), createdAt: state.createdAt, updatedAt: state.updatedAt, provenance: state.provenance, planVersion: state.planVersion || null, origin: state.plan?.origin || 'legacy', layout: state.plan?.layout || 'sequence', detail: state.plan?.detail || 'balanced', stepCount: state.steps.length, progress: { total: progress.total, done: progress.done, skipped: progress.skipped || 0, complete: progress.complete === true, ready: state.availableWork.ready, active: state.availableWork.active, waiting: state.availableWork.waiting, current: progress.current ? { id: progress.current.id, title: progress.current.title, status: progress.current.status } : null }, owners: Object.entries(state.execution?.nodes || {}).map(([nodeId, execution]) => ({ nodeId, label: execution.label, scopeStepId: execution.scopeStepId, status: execution.status })) };
            if (key && !state.externalRecovery?.required && !isPlanContractTask(state)) this.planCatalog.set(taskId, { key, plan: copy(plan) });
          }
          if (standaloneOnly && !plan.standalonePlan) continue;
          if (!query.trim() || titleMatches.has(taskId) || `${plan.goal}\n${plan.taskId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) plans.push(plan);
        } catch (error) { check(signal); errors.push({ taskId, code: error.code || 'TASK_STATE_DAMAGED', message: String(error.message || 'The saved plan is unavailable.').slice(0, 500) }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, entries.length) }, worker)); check(signal);
    plans.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.taskId.localeCompare(b.taskId));
    const nextOffset = offset + limit < plans.length ? offset + limit : null;
    return { plans: plans.slice(offset, offset + limit), total: plans.length, offset, limit, nextOffset, hasMore: nextOffset !== null, errors, healthy: errors.length === 0 };
  }
  update(taskId, change, { expectedRevision, runId, nodeId, signal, source = 'agent', actor, schemaVersion, scopeStepId, reviewScopeStepId, reviewCommit = false, executionGuardrails = false } = {}) {
    return this.enqueue(taskId, async () => {
      const saved = await this.load(taskId), previous = saved.history.at(-1);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== previous.revision) throw Object.assign(fail(`Task revision changed. Read the latest state (revision ${previous.revision}) before updating it.`, 'TASK_STATE_CONFLICT', 409), { currentRevision: previous.revision });
      let next = await change(copy(previous));
      if (isPlanContractTask(previous) || isPlanContractTask(next)) await validateContractPlanTransition(this, taskId, previous, next);
      else if (executionGuardrails === true) await validateSequentialPlanTransition(this, taskId, previous, next);
      if (!isPlanContractTask(next)) next = recordPlanningOutcome(previous, next, { runId, nodeId, scopeStepId: reviewScopeStepId || scopeStepId, schemaVersion, source, revision: previous.revision + (saved.recoveredFromBackup ? 2 : 1) });
      if (source === 'agent') next.interruption = null; check(signal); return this.commit(saved, next, { runId, nodeId, actor }, source, signal, { reviewCommit });
    }, signal);
  }
  setContract(taskId, value, options = {}) {
    const fromCurrent = typeof value === 'function';
    const authored = fromCurrent ? null : validatePlanContractFeasibility(normalizePlanContract(value));
    return this.update(taskId, async state => {
      if (options.schemaVersion !== 14) throw fail('The saved task catalog does not expose the canonical contract.', 'TASK_SCHEMA_UNSUPPORTED', 409);
      if (!isPlanContractTask(state) && state.steps.length) throw fail('Use an explicit settled migration for this legacy plan.', 'TASK_CONTRACT_MIGRATION_REQUIRED');
      const contract = fromCurrent ? validatePlanContractFeasibility(normalizePlanContract(await value(state))) : authored;
      assertCommitPrerequisites(contract, (options.adoption || state.contractAdoption)?.commitPrerequisiteIds);
      if (options.scopeStepId || options.worker) {
        const own = state.contract?.workItems.filter(item => item.owner === options.nodeId).map(item => item.id) || [];
        const protectedCriteria = new Set(state.contract?.workItems.filter(item => !own.includes(item.id)).flatMap(item => item.criterionIds) || []);
        const previousCriteria = new Map((state.contract?.criteria || []).map(item => [item.id, item]));
        if (!state.contract || contract.goal !== state.contract?.goal || JSON.stringify(contract.instructions) !== JSON.stringify(state.contract?.instructions)
          || contract.workItems.some(item => own.includes(item.id) && item.owner !== options.nodeId)
          || JSON.stringify(contract.workItems.filter(item => !own.includes(item.id))) !== JSON.stringify(state.contract.workItems.filter(item => !own.includes(item.id)))
          || [...protectedCriteria].some(id => JSON.stringify(contract.criteria.find(item => item.id === id)) !== JSON.stringify(previousCriteria.get(id)))) throw fail('A worker cannot replace another owner, shared criterion or the shared task.', 'TASK_CONTRACT_OWNERSHIP', 403);
      }
      if (state.contractAdoption && !options.adoption && options.source !== 'human') {
        assertAdoptedGoal(state, contract.goal);
        // The host selected these outcomes at adoption. Work and proof details
        // can evolve without changing what the user was promised.
        const proposed = new Map(contract.criteria.map(criterion => [criterion.id, criterion]));
        const required = new Set(state.contractAdoption.requiredCriterionIds || []);
        for (const criterion of state.contract.criteria) {
          if (!required.has(criterion.id)) continue;
          const replacement = proposed.get(criterion.id);
          if (!replacement || outcomeCriterionIdentity(replacement) !== outcomeCriterionIdentity(criterion))
            throw fail('Preserve the inherited outcome criterion "' + criterion.id + '" when refining work. Its work items, resources and receipt bindings can still change.', 'TASK_CONTRACT_CRITERION_CHANGE', 409);
        }
      }
      const previous = state.contract && { ...state.contract }; if (previous) delete previous.planEpoch;
      const changed = !previous || JSON.stringify(previous) !== JSON.stringify(contract);
      const planEpoch = state.contract?.planEpoch ? state.contract.planEpoch + (changed ? 1 : 0) : 1;
      return { ...state, goal: contract.goal, steps: [], taskSchemaVersion: 14, contract: { ...contract, planEpoch },
        ...(options.adoption ? { contractAdoption: copy(options.adoption) } : {}), interruption: null };
    }, options);
  }
  bindContractReceipt(taskId, { workItemId, criterionId, receiptBinding }, options = {}) {
    identifier(workItemId); identifier(criterionId);
    if (!object(receiptBinding)) throw fail('Supply one observed receiptBinding.', 'TASK_CONTRACT_INVALID');
    return this.setContract(taskId, async state => {
      const item = state.contract?.workItems.find(row => row.id === workItemId);
      if (!item || item.owner !== options.nodeId && (options.worker || item.owner !== 'coordinator') || !item.criterionIds.includes(criterionId))
        throw fail('Use the work item you own and its existing receipt criterion.', 'TASK_CONTRACT_OWNERSHIP', 403);
      const criterion = state.contract.criteria.find(row => row.id === criterionId);
      if (criterion?.kind !== 'external-confirmation') throw fail('Only an external-confirmation criterion accepts a receipt binding.', 'TASK_CONTRACT_INVALID');
      const journal = await readContractJournal(this, taskId);
      if (!hasPendingBrowserReceipt(journal, workItemId, criterionId))
        throw fail('No unresolved browser submission belongs to that work item and receipt criterion.', 'TASK_CONTRACT_RECEIPT_NOT_PENDING', 409);
      const bindings = [...receiptBindingsForCriterion(criterion)];
      const matches = bindings.filter(binding => ['format', 'resourceKey', 'record', 'history'].every(field => binding[field] === receiptBinding[field]));
      if (matches.length > 1) throw fail('Several saved receipt mappings overlap that record. Read and refine the exact existing mapping.', 'TASK_CONTRACT_INVALID');
      const prior = matches[0], replacement = copy(receiptBinding);
      if (prior && ['status', 'outcomeId', 'destination', 'identity', 'prior', 'outcomeFields'].every(field => JSON.stringify(prior[field]) === JSON.stringify(replacement[field]))) {
        if (Array.isArray(replacement.confirmedValues)) replacement.confirmedValues = [...new Set([...prior.confirmedValues, ...replacement.confirmedValues])];
        if (replacement.absentValues === undefined || Array.isArray(replacement.absentValues)) {
          const absent = [...new Set([...(prior.absentValues || []), ...(replacement.absentValues || [])])];
          if (absent.length) replacement.absentValues = absent;
        }
      }
      if (prior) bindings[bindings.indexOf(prior)] = replacement; else bindings.push(replacement);
      const next = copy(state.contract); delete next.planEpoch;
      const target = next.criteria.find(row => row.id === criterionId);
      delete target.receiptBinding; delete target.receiptBindings;
      if (bindings.length === 1 && !criterion.receiptBindings) target.receiptBinding = bindings[0];
      else target.receiptBindings = bindings;
      return next;
    }, options);
  }
  assignContractWorkers(taskId, assignments, options = {}) {
    if (!Array.isArray(assignments) || !assignments.length || assignments.length > 8) throw fail('Assign a bounded set of existing work items.', 'TASK_CONTRACT_OWNERSHIP');
    return this.update(taskId, state => {
      if (!isPlanContractTask(state) || state.contract.planEpoch !== options.expectedPlanEpoch) throw fail('Read the current canonical plan before assigning work.', 'TASK_CONTRACT_EPOCH_CONFLICT');
      const ids = new Set();
      for (const assignment of assignments) {
        if (!assignment || ids.has(assignment.workItemId) || typeof assignment.nodeId !== 'string') throw fail('Each worker needs one distinct existing work item.', 'TASK_CONTRACT_OWNERSHIP');
        const item = state.contract.workItems.find(item => item.id === assignment.workItemId);
        if (!item || !['coordinator', options.nodeId].includes(item.owner)) throw fail('Only coordinator-owned work can be assigned; another owner cannot be replaced.', 'TASK_CONTRACT_OWNERSHIP', 403);
        ids.add(item.id); item.owner = identifier(assignment.nodeId);
      }
      state.contract.planEpoch++;
      state.contractAssignments = [...(state.contractAssignments || []), ...assignments.map(item => ({ ...copy(item), runId: options.runId, assignedBy: options.nodeId, planEpoch: state.contract.planEpoch }))].slice(-160);
      return state;
    }, { ...options, schemaVersion: 14 });
  }
  setPlan(taskId, value, options = {}) {
    if (!object(value)) throw fail('A plan is required.');
    if (options.schemaVersion === 14) return this.setContract(taskId, value.contract, options);
    if (object(value.plan) && Object.hasOwn(value.plan, 'steps')) throw fail('Put steps at the top level alongside action, expectedRevision and plan. The plan object contains metadata only; move plan.steps to steps, keep the revision from a fresh read, and retry. Use describe for a complete plan call example.', 'TASK_PLAN_SHAPE_INVALID');
    const branching = options.schemaVersion >= 4 || value.plan !== undefined || value.planVersion === TASK_PLAN_VERSION || Array.isArray(value.steps) && value.steps.length <= TASK_PLAN_LIMITS.nodes && value.steps.some(step => object(step) && ['parentId', 'kind', 'dependsOn', 'selectedChildId', 'skipReason', 'artifactIds'].some(key => step[key] !== undefined));
    const steps = branching ? value.steps : normalizeSteps(value.steps), goal = value.goal === undefined ? undefined : text(value.goal, 'Goal', 2000, true);
    return this.update(taskId, state => {
      if (options.schemaVersion < 4 && state.planVersion === TASK_PLAN_VERSION) throw fail('This task now has a branching outline. The saved flat relay_task catalog cannot replace it. Preserve its steps and use a new task with the current planning tool for structural edits.', 'TASK_SCHEMA_UNSUPPORTED', 409);
      if (branching || state.planVersion === TASK_PLAN_VERSION) {
        if (options.scopeStepId && goal !== undefined && goal !== state.goal) throw fail('The worker cannot replace the shared goal.', 'TASK_PLAN_OWNERSHIP', 403);
        const planned = options.scopeStepId ? replaceOwnedPlan(state, value, options) : normalizeTaskPlan(value, { previous: state, actor: options, artifacts: state.artifacts, executionGuardrails: options.executionGuardrails });
        for (const binding of Object.values(state.execution?.nodes || {})) if (!planned.steps.some(step => step.id === binding.scopeStepId)) throw fail('Keep the live execution assignments. Use focused plan edits instead of replacing other workers.', 'TASK_PLAN_EXECUTION_BOUND', 409);
        validatePlanningOutline(planned, { mode: options.planningMode, previous: state, source: options.source, scopeStepId: options.scopeStepId, schemaVersion: options.schemaVersion, executionGuardrails: options.executionGuardrails });
        validateDocumentAnalysisOutline(planned, { contract: options.documentAnalysisContract, previous: state, mode: options.executionGuardrails === true ? options.planningMode : 'off' });
        return replaceBranchingPlan(state, { ...planned, ...(goal === undefined ? {} : { goal }) });
      }
      const oldSteps = new Map(state.steps.map(step => [step.id, step]));
      const next = steps.map(step => {
        const old = oldSteps.get(step.id), changed = old && (old.status === 'done' && step.status !== 'done' || old.doneWhen !== step.doneWhen);
        if (changed && step.evidence === old.evidence) { const fresh = { ...step }; delete fresh.evidence; return fresh; }
        return step;
      });
      return replaceSteps({ ...state, ...(goal === undefined ? {} : { goal }) }, next);
    }, options);
  }
  setStep(taskId, stepId, value, options = {}) {
    identifier(stepId); if (!object(value) || value.status !== undefined && !TASK_PLAN_STATUSES.includes(value.status)) throw fail('A pending, active, blocked, done or skipped step status is required.');
    const note = value.note === undefined ? undefined : text(value.note, 'Step note', 700);
    const fields = {};
    if (value.evidence !== undefined) checkPlanningEvidenceLength(value.evidence);
    for (const [key, name, max, required] of [['doneWhen', 'Done when', 1000, true], ['evidence', 'Milestone evidence', 2000, false], ['blockedReason', 'Blocked reason', 1000, true]]) if (value[key] !== undefined) fields[key] = text(value[key], name, max, required);
    return this.update(taskId, state => {
      if (!state.steps.some(step => step.id === stepId)) throw fail('That step is not in the saved plan.', 'TASK_STEP_MISSING', 404);
      if (options.scopeStepId && !planningScope(state.steps, options.scopeStepId).has(stepId)) throw fail('This worker may update only its assigned work.', 'TASK_PLAN_OWNERSHIP', 403);
      if (state.planVersion === TASK_PLAN_VERSION) {
        const current = state.steps.find(step => step.id === stepId);
        if (options.schemaVersion < 4 && current.kind !== 'action') throw fail('This is a branching plan group whose status derives from its children. The saved flat task tool can update action steps only.', 'TASK_SCHEMA_UNSUPPORTED', 409);
        if (options.schemaVersion < 2 && value.status === 'done' && current.status !== 'done') throw fail('Completing this action needs an evidence field that the saved task tool version does not expose. Preserve the outline and continue with current task capabilities.', 'TASK_SCHEMA_UNSUPPORTED', 409);
        const changes = { ...fields, ...(value.status === undefined ? {} : { status: value.status }), ...(note === undefined ? {} : { note }) };
        for (const key of ['title', 'skipReason', 'result', 'artifactIds', 'selectedChildId', 'operation', 'reconciliation']) if (value[key] !== undefined) changes[key] = value[key];
        if (!Object.keys(changes).length) throw fail('Supply a step status, detail or selected child to update.');
        const nextSteps = state.steps.map(step => ({ ...step, ...(step.kind !== 'action' ? { status: 'pending' } : {}), ...(step.id === stepId ? changes : {}) }));
        const planned = normalizeTaskPlan({ plan: state.plan, steps: nextSteps }, { previous: state, actor: { ...state.plan.authoredBy, source: state.plan.origin }, artifacts: state.artifacts, executionGuardrails: options.executionGuardrails });
        validatePlanningOutline(planned, { mode: options.planningMode, previous: state, source: options.source, scopeStepId: options.scopeStepId, schemaVersion: options.schemaVersion, executionGuardrails: options.executionGuardrails });
        validateDocumentAnalysisOutline(planned, { contract: options.documentAnalysisContract, previous: state, mode: options.executionGuardrails === true ? options.planningMode : 'off' });
        return replaceBranchingPlan(state, planned);
      }
      if (!['pending', 'active', 'blocked', 'done'].includes(value.status)) throw fail('A pending, active, blocked or done step status is required for this legacy plan.');
      const steps = state.steps.map(step => {
        if (step.id !== stepId) return value.status === 'active' && step.status === 'active' ? { ...step, status: 'pending' } : step;
        const next = { ...step, ...fields, status: value.status, ...(note === undefined ? {} : { note }) };
        if (value.evidence === undefined && (step.status === 'done' && value.status !== 'done' || fields.doneWhen !== undefined && fields.doneWhen !== step.doneWhen)) delete next.evidence;
        return next;
      });
      return replaceSteps(state, normalizeSteps(steps));
    }, options);
  }
  editPlan(taskId, value, options = {}) {
    return this.update(taskId, state => {
      const document = applyPlanningDocumentOperations(state, value, options);
      const planned = document.operations.length ? applyPlanningEdits(document.state, { operations: document.operations }, options) : document.state;
      validatePlanningOutline(planned, { mode: options.planningMode, previous: state, source: options.source, scopeStepId: options.scopeStepId, schemaVersion: options.schemaVersion, executionGuardrails: options.executionGuardrails });
        validateDocumentAnalysisOutline(planned, { contract: options.documentAnalysisContract, previous: state, mode: options.executionGuardrails === true ? options.planningMode : 'off' });
      return replaceBranchingPlan(document.state, planned);
    }, options);
  }
  review(taskId, value, options = {}) {
    if (!(options.schemaVersion >= 10)) throw fail('This saved task catalog does not expose review. Preserve the existing task and use its current supported catalog.', 'TASK_SCHEMA_UNSUPPORTED', 409);
    const review = normalizePlanningReview(value);
    return this.update(taskId, async state => {
      const sequence = await planningSequenceStatus(this, taskId, state, { scopeStepId: options.scopeStepId });
      if (options.executionGuardrails === true && sequence.running.length) throw fail('An owned operation is still running. Wait for its actual result before reassessing the completed work.', 'TASK_PLAN_STEP_IN_FLIGHT', 409);
      if (options.executionGuardrails === true && sequence.unreported.length) throw fail('Save each dispatched operation’s actual result or uncertainty before reviewing. A review cannot stand in for its leaf outcome.', 'TASK_PLAN_RESULT_REQUIRED', 409);
      if (options.executionGuardrails === true && review.decision === 'respond' && (sequence.uncertain.length || !options.scopeStepId && (state.externalActions || []).some(item => item.status === 'uncertain')))
        throw fail('An earlier effect remains uncertain. Reconcile it before reviewing for completion, or record its actual blocker and review the truthful incomplete result.', 'TASK_PLAN_RECONCILIATION_REQUIRED', 409);
      const context = options.getReviewContext ? await options.getReviewContext() : null;
      return appendPlanningReview(state, review, { ...options, context, sequenceSignature: sequence.signature });
    }, { ...options, reviewCommit: true });
  }
  bindWorkflow(taskId, workflow, { runId, nodeStates, signal } = {}) {
    identifier(runId);
    return this.enqueue(taskId, async () => {
      const saved = await this.load(taskId), previous = saved.history.at(-1);
      if (previous.execution?.runId === runId) return projectState(previous);
      if (Object.values(previous.execution?.nodes || {}).some(node => node.status === 'running')) throw fail('A worker from the previous execution still owns this plan. Wait for it to settle.', 'TASK_PLAN_EXECUTION_BUSY', 409);
      return this.commit(saved, bindWorkflowPlan(previous, workflow, { runId, nodeStates }), { runId, nodeId: 'runtime' }, 'runtime', signal);
    }, signal);
  }
  recordExecution(taskId, nodeId, value, { runId, signal } = {}) {
    identifier(nodeId); identifier(runId);
    if (!object(value) || !['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'waiting'].includes(value.status)) throw fail('Use an actual runtime execution status.');
    return this.enqueue(taskId, async () => {
      const saved = await this.load(taskId), previous = saved.history.at(-1), binding = previous.execution?.nodes?.[nodeId];
      if (!binding || previous.execution.runId !== runId) throw fail('This runtime no longer owns the saved assignment.', 'TASK_PLAN_EXECUTION_OWNERSHIP', 409);
      if (value.status === 'running') {
        const readiness = executionReadiness(previous, nodeId);
        if (!readiness.ready) throw fail(readiness.reason || 'The assigned prerequisites are not ready.', 'TASK_PLAN_NOT_READY', 409);
      }
      const updated = { ...binding, status: value.status };
      if (value.status === 'running') { updated.startedAt = stamp(); delete updated.finishedAt; delete updated.error; }
      if (['completed', 'failed', 'cancelled', 'skipped'].includes(value.status)) updated.finishedAt = stamp();
      if (value.error !== undefined) updated.error = text(String(value.error).slice(0, 1000), 'Execution error', 1000);
      const next = { ...previous, execution: { ...previous.execution, nodes: { ...previous.execution.nodes, [nodeId]: updated } } };
      return this.commit(saved, next, { runId, nodeId }, 'runtime', signal);
    }, signal);
  }
  bindDelegates(taskId, tasks, { runId, nodeId, signal } = {}) {
    identifier(runId); identifier(nodeId);
    return this.enqueue(taskId, async () => {
      const saved = await this.load(taskId), previous = saved.history.at(-1), linked = tasks.filter(task => task.stepId);
      if (!linked.length) return projectState(previous);
      const priorExecution = previous.execution?.runId === runId ? previous.execution : undefined;
      if (previous.execution && !priorExecution && Object.values(previous.execution.nodes).some(node => ['queued', 'running', 'waiting'].includes(node.status))) throw fail('A previous runtime still owns this work. Wait for its workers to settle.', 'TASK_PLAN_EXECUTION_OWNERSHIP', 409);
      const execution = copy(priorExecution || { runId, coordinatorNodeId: nodeId, nodes: {} }), assigned = new Set();
      for (const task of linked) {
        identifier(task.stepId);
        if (assigned.has(task.stepId) || !previous.steps.some(step => step.id === task.stepId)) throw fail('Each worker needs a distinct existing plan action or group.', 'TASK_PLAN_OWNERSHIP', 403);
        assigned.add(task.stepId); const subtree = planningScope(previous.steps, task.stepId);
        for (const [ownerId, binding] of Object.entries(execution.nodes)) {
          if (ownerId === nodeId) continue;
          const containsTarget = planningScope(previous.steps, binding.scopeStepId).has(task.stepId);
          if (containsTarget || subtree.has(binding.scopeStepId)) throw fail('Another worker already owns this work. Delegate a separate saved action or group.', 'TASK_PLAN_OWNERSHIP', 403);
        }
        const workerNodeId = delegatedPlanNodeId(nodeId, task.id);
        execution.nodes[workerNodeId] = { scopeStepId: task.stepId, label: task.id, status: 'queued', kind: 'delegate', parentNodeId: nodeId };
      }
      return this.commit(saved, { ...previous, execution }, { runId, nodeId }, 'runtime', signal);
    }, signal);
  }
  checkpoint(taskId, value, options = {}) {
    return this.update(taskId, state => {
      const next = checkpoint(value, state.contractAdoption ? state.contract.goal : state.goal);
      assertAdoptedGoal(state, next.goal);
      state.goal = next.goal;
      state.checkpoint = { ...next, provenance: provenance(options, 'agent') };
      return state;
    }, options);
  }
  externalAction(taskId, value, options = {}) {
    if (!object(value)) throw fail('An external-action receipt is required.');
    const id = identifier(value.receiptId), operation = value.operation;
    if (!['prepare', 'attempt', 'confirm', 'reconcile_absent'].includes(operation)) throw fail('Choose prepare, attempt, confirm or reconcile_absent.');
    const url = (value, name) => {
      const raw = text(value, name, 2048, true); let parsed;
      try { parsed = new URL(raw); } catch { throw fail(`${name} must be an absolute HTTP(S) URL.`); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw fail(`${name} must be an absolute HTTP(S) URL without credentials.`);
      return parsed.href;
    };
    const prepared = operation === 'prepare' ? {
      destination: /^https?:/i.test(text(value.destination, 'External destination', 2048, true)) ? url(value.destination, 'External destination') : emailDestination(value.destination),
      content: text(value.content, 'Exact external content', 12000, true),
      attachmentSha256: value.attachmentSha256 === undefined ? null : value.attachmentSha256,
    } : null;
    if (prepared?.attachmentSha256 !== undefined && prepared.attachmentSha256 !== null && (typeof prepared.attachmentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(prepared.attachmentSha256))) throw fail('Use the checked attachment SHA-256.');
    const fingerprint = prepared ? createHash('sha256').update(JSON.stringify(prepared)).digest('hex') : null;
    const evidence = ['confirm', 'reconcile_absent'].includes(operation) ? text(value.evidence, 'Observed external evidence', 2000, true) : null;
    const emailReference = operation === 'confirm' && typeof value.url === 'string' && /^mid:/i.test(value.url.trim()) ? emailMessageReference(value.url) : null;
    const permalink = operation === 'confirm' ? emailReference?.url || url(value.url, 'Verified result URL') : null;
    return this.update(taskId, state => {
      const receipts = state.externalActions || [], prior = receipts.find(item => item.id === id); let next;
      if (operation === 'prepare') {
        if (prior && prior.fingerprint !== fingerprint) throw fail('This receipt identifies different external content. Preserve it and choose a new receipt only for a separately authorized action.', 'EXTERNAL_ACTION_CONFLICT', 409);
        if (prior) return state;
        if (receipts.some(item => item.fingerprint === fingerprint)) throw fail('Matching external content already has a receipt. Read and reconcile that receipt instead of creating a second action.', 'EXTERNAL_ACTION_CONFLICT', 409);
        if (receipts.length >= 8) throw fail('Use at most eight external-action receipts per task.', 'TASK_STATE_LIMIT', 413);
        next = { id, destination: prepared.destination, contentExcerpt: prepared.content.slice(0, 160), attachmentSha256: prepared.attachmentSha256, fingerprint, status: state.externalRecovery?.required ? 'uncertain' : 'prepared', attempts: 0, preparedAt: stamp(), verification: 'agent-reported-external-evidence', ...(state.externalRecovery?.required ? { recoveredFromBackup: true, attemptsMayBeIncomplete: true } : {}) };
      } else {
        if (!prior) throw fail('Prepare this external action before recording an attempt or result.', 'EXTERNAL_ACTION_MISSING', 409);
        if (operation === 'attempt') {
          if (prior.status !== 'prepared' || state.externalRecovery?.required && !prior.recoveryReconciledAt) throw fail(prior.status === 'confirmed' ? 'This action is already confirmed. Do not send it again.' : 'A prior attempt or recovered backup has an uncertain outcome. Inspect the destination; confirm an existing result or reconcile observed absence before another attempt.', 'EXTERNAL_ACTION_RECONCILE', 409);
          // Persist uncertainty BEFORE the remote side effect. If the process or
          // tool response is lost, recovery cannot silently issue a second send.
          next = { ...prior, status: 'uncertain', attempts: prior.attempts + 1, attemptedAt: stamp(), attemptedBy: provenance(options) };
        } else if (operation === 'confirm') {
          if (emailReference && !prior.destination.startsWith('mailto:')) throw fail('A mid: email confirmation reference is only valid for a prepared mailto: destination. Use the actual HTTP(S) result URL for a web action.');
          if (prior.status === 'confirmed' && prior.url !== permalink) throw fail('This action already has a different confirmed result. Recheck the existing receipt.', 'EXTERNAL_ACTION_CONFLICT', 409);
          next = { ...prior, status: 'confirmed', url: permalink, ...(emailReference || {}), evidence, confirmedAt: prior.confirmedAt || stamp(), confirmedBy: provenance(options), ...(state.externalRecovery?.required ? { recoveryReconciledAt: stamp() } : {}) };
        } else {
          if (prior.status !== 'uncertain') throw fail('Only an uncertain attempt can be reconciled as absent. Confirmed results must never be sent again.', 'EXTERNAL_ACTION_RECONCILE', 409);
          next = { ...prior, status: 'prepared', absenceEvidence: evidence, reconciledAt: stamp(), reconciledBy: provenance(options), ...(state.externalRecovery?.required ? { recoveryReconciledAt: stamp() } : {}) };
        }
      }
      state.externalActions = [...receipts.filter(item => item.id !== id), next]; return state;
    }, options);
  }
  addArtifact(taskId, value, options = {}) {
    if (!object(value)) throw fail('An artifact file is required.'); text(value.path, 'Artifact path', 8000, true); const title = value.title === undefined ? undefined : text(value.title, 'Artifact title', 200, true);
    return this.update(taskId, async state => {
      const file = await verifyFile(path.resolve(state.cwd, value.path), options), previous = state.artifacts.find(item => item.path === file.path);
      if (options.withinWorkspace) { const base = await fs.realpath(state.cwd), relative = path.relative(base, file.path); if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('The linked file resolves outside the working folder.', 'ARTIFACT_OUTSIDE_WORKSPACE'); }
      if (!previous && state.artifacts.length >= TASK_LIMITS.artifacts) throw fail(`Use at most ${TASK_LIMITS.artifacts} deliverable files.`, 'TASK_STATE_LIMIT', 413);
      const artifact = { id: previous?.id || `artifact_${randomUUID()}`, ...file, title: title || path.basename(file.path), fileName: path.basename(file.path), verifiedAt: stamp(), verification: 'filesystem-sha256', provenance: provenance(options, options.source || 'agent') };
      state.artifacts = [...state.artifacts.filter(item => item.id !== artifact.id), artifact]; return state;
    }, options);
  }
  interrupt(taskId, { runId, nodeId, status = 'interrupted', reason = '', includeExecution = true } = {}, { signal } = {}) {
    if (!['interrupted', 'cancelled', 'failed'].includes(status)) throw fail('Interruption status must be interrupted, cancelled or failed.'); text(reason, 'Interruption reason', 1000);
    return this.enqueue(taskId, async () => {
      const saved = await this.load(taskId), state = copy(saved.history.at(-1));
      if (isPlanContractTask(state)) {
        const journal = await readContractJournal(this, taskId), view = contractRuntimeView(state, journal);
        state.interruption = { kind: 'interruption', status, reason, planEpoch: state.contract.planEpoch, journalSeq: journal.journalSeq, source: 'canonical-operation-journal', unresolvedOperationIds: view.unresolved.map(row => row.operationId), provenance: provenance({ runId, nodeId }, 'runtime'), note: 'The actual operation journal is preserved. Ending a turn does not confirm an external outcome or complete a work item.' };
        return this.commit(saved, state, { runId, nodeId }, 'runtime', signal);
      }
      // The outline in this same immutable revision already preserves every
      // node state. Repeating hundreds of long IDs can exhaust the runtime
      // recovery reserve, so structured receipts reference that saved outline.
      const recordedSteps = state.planVersion === TASK_PLAN_VERSION ? { planRevision: state.revision, stepStatesSource: 'outline-in-this-record', ...(!state.steps.length ? { stepStates: [] } : {}) } : { stepStates: state.steps.map(({ id, status }) => ({ id, status })) };
      state.interruption = { kind: 'interruption', status, reason, progress: { done: state.progress.done, total: state.progress.total, currentStepId: state.progress.current?.id || null }, ...recordedSteps, provenance: provenance({ runId, nodeId }, 'runtime'), note: 'Recorded from saved plan states. Completion is agent-reported; no new summary or verification was invented.' };
      const actions = state.planVersion === TASK_PLAN_VERSION ? state.steps.filter(step => step.kind === 'action') : state.steps;
      if (!state.checkpoint || state.checkpoint.kind === 'interruption') state.checkpoint = { kind: 'interruption', goal: state.goal, decisions: [], completed: actions.filter(step => step.status === 'done').slice(0, 8).map(step => step.title), nextSteps: actions.filter(step => !['done', 'skipped'].includes(step.status)).slice(0, 8).map(step => step.title), openQuestions: [], provenance: copy(state.interruption.provenance) };
      const observed = includeExecution && await this.executionSnapshot(taskId);
      if (observed) {
        // Full receipts remain in the independent journal and task read. Stop
        // must not fail because a valid near-limit human plan has little room.
        const reference = { source: 'task-execution-journal', ...(observed.unavailable ? { unavailable: true } : { asOf: observed.updatedAt, total: observed.total, failed: observed.failed, recoveredFailures: observed.recoveredFailures }), note: 'Read executionObservations for tool receipts; these are not milestone or destination confirmation.' };
        if (JSON.stringify(state).length + JSON.stringify(reference).length + 320 < TASK_LIMITS.stateChars) {
          state.interruption.executionObservations = reference;
          if (state.checkpoint.kind === 'interruption') state.checkpoint.executionSource = 'task-execution-journal';
        }
      }
      return this.commit(saved, state, { runId, nodeId }, 'runtime', signal);
    }, signal);
  }
  async getContext(taskId, { maxChars = TASK_LIMITS.contextChars, signal, toolAvailable = true, executionGuardrails = false } = {}) {
    if (!Number.isSafeInteger(maxChars) || maxChars < 512 || maxChars > 32000) throw fail('Task context budget must be from 512 to 32,000 characters.');
    const state = await this.get(taskId, { signal }), savedProgress = taskPlanProgress(state), current = savedProgress.current;
    if (isPlanContractTask(state)) { const summary = { taskId, revision: state.revision, contractVersion: 2, planEpoch: state.contract.planEpoch, goal: state.contract.goal, workItems: state.contractRuntime.workItems, unresolved: state.contractRuntime.unresolved, journalSeq: state.contractRuntime.journalSeq }; const text = JSON.stringify(summary); return '\nCANONICAL TASK CONTINUITY\n' + (text.length <= maxChars ? text : JSON.stringify({ taskId, revision: state.revision, planEpoch: state.contract.planEpoch, journalSeq: state.contractRuntime.journalSeq, excerptOmitted: true, note: 'Read relay_task for the exact canonical contract and bounded runtime view.' })); }
    const uncertain = (state.externalActions || []).filter(item => item.status === 'uncertain'), confirmed = (state.externalActions || []).filter(item => item.status === 'confirmed');
    const compactIds = items => { const ids = items.map(item => item.id).join(', '); return ids.length > 140 ? `${ids.slice(0, 139)}…` : ids; };
    const externalWarning = executionGuardrails !== true ? (uncertain.length ? `Recorded uncertain attempts: ${compactIds(uncertain)}. Preserve their receipts and inspect the destination before repeating the same possible effect.\n` : state.externalRecovery?.required ? 'Recovered external receipt history may omit newer outcomes. Preserve that uncertainty when deciding whether an earlier action needs repeating.\n' : confirmed.length ? `Recorded confirmed effects: ${compactIds(confirmed)}. Preserve those completed actions rather than repeating them.\n` : '') : uncertain.length ? `Uncertain external attempt: ${compactIds(uncertain)}. Inspect the destination before any retry; it may already be published.\n` : state.externalRecovery?.required ? 'External receipt backup recovery: newer outcomes may be missing. Inspect and reconcile the destination before any send.\n' : confirmed.length ? `Confirmed external action: ${compactIds(confirmed)}. Do not send it again; read its saved result URL and continue remaining work.\n` : '';
    const superseded = state.checkpoint?.supersededNextAction;
    const supersededWarning = superseded ? 'Previous action superseded by plan change; re-evaluate before use. Do not replay external effects solely from this superseded action.\n' : '';
    const base = `\n\nSAVED TASK CONTINUITY · revision ${state.revision}\nTask: ${state.taskId}\n${externalWarning}${supersededWarning}Plan origin: ${state.plan?.origin || 'unknown'}; last updated by: ${state.provenance?.source || 'unknown'}.\nMilestones/evidence are agent-reported; predictions are not findings. File hashes check bytes, not correctness. ${toolAvailable ? executionGuardrails === true ? 'Read relay_task before edits.' : 'Optional planning context; chosen edits use the exact current revision. It does not gate tools or a response.' : 'Historical excerpt; task tool unavailable.'}\n`;
    const suffix = toolAvailable ? '[Continuity excerpt shortened; use relay_task read for full state.]' : '[Continuity excerpt shortened; full state remains saved.]';
    const singleLine = value => String(value).replace(/\s+/g, ' ').trim();
    const nextAction = executionGuardrails !== true ? state.checkpoint?.nextAction || current?.title || state.checkpoint?.nextSteps?.[0] : uncertain.length ? `Reconcile external receipts ${compactIds(uncertain)} against the saved destination before any send retry.` : state.externalRecovery?.required ? 'Read recovered external receipts and reconcile the actual destination before any send.' : confirmed.length ? 'Read the confirmed external result receipts, preserve those completed effects and continue only remaining work.' : state.checkpoint?.nextAction || current?.title || state.checkpoint?.nextSteps?.[0];
    const execution = compactExecution(state.executionObservations);
    const critical = [['Plan goal', state.goal], ...(current ? [['Current milestone', `${current.title} (${current.status})`]] : []), ...(current?.result ? [['Planned output', current.result]] : []), ...(current?.doneWhen ? [['Done when', current.doneWhen]] : []), ...(current?.note ? [['Current notes', current.note]] : []), ...(current?.blockedReason ? [['Blocked', current.blockedReason]] : []), ...(current?.evidence ? [['Reported finding', current.evidence]] : []), ...(nextAction ? [['Next action', nextAction]] : []), ...(superseded ? [['Superseded action (historical)', superseded.text]] : []), ...(execution ? [['Runtime receipts (not outcome confirmation)', JSON.stringify(execution)]] : [])].map(([label, value]) => [label, singleLine(value)]);
    const summary = critical.map(([label, value]) => `${label}: ${value}\n`).join('');
    if (base.length + summary.length > maxChars - suffix.length) {
      let budget = Math.max(0, maxChars - base.length - suffix.length - critical.reduce((total, [label]) => total + label.length + 3, 0));
      const excerpt = critical.map(([label, value], index) => {
        const available = Math.max(0, Math.floor(budget / (critical.length - index))), length = Math.min(value.length, available); budget -= length;
        let shortened = value.length <= length ? value : length > 1 ? `${value.slice(0, length - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : length ? '…' : '';
        return `${label}: ${shortened}\n`;
      }).join('');
      return `${base}${excerpt}${suffix}`.slice(0, maxChars);
    }
    // Put the next concrete action ahead of historical detail, so long plans and
    // checkpoints cannot bury the information needed to resume useful work.
    // Saved human notes and criteria are actionable context, including when
    // automatic planning is off. Keep the current work ahead of this bounded
    // outline so a long completed history cannot hide a new instruction.
    const outlineStep = ({ id, title, status, parentId, kind, dependsOn, selectedChildId, condition, branch, operation, reconciliation, skipReason, stepType, doneWhen, result, note, evidence, blockedReason, artifactIds, attempt, pastAttempts, pastAttemptsOmitted }) => ({ id, title, status, parentId, kind, dependsOn, selectedChildId, condition, branch, operation, reconciliation, skipReason, stepType, doneWhen, result, note, evidence, blockedReason, artifactIds, attempt, ...(pastAttempts?.length ? { pastAttempts: pastAttempts.slice(-2), pastAttemptsOmitted: (pastAttemptsOmitted || 0) + Math.max(0, pastAttempts.length - 2) } : {}) });
    const outline = state.planVersion === TASK_PLAN_VERSION ? `Plan: ${JSON.stringify(state.plan)}\nOutline: ${JSON.stringify(state.steps.map(outlineStep))}\n` : `Milestones: ${JSON.stringify(state.steps.map(outlineStep))}\n`;
    const sections = [(state.externalActions || []).length ? `External action receipts (agent-reported): ${JSON.stringify(state.externalActions)}\n` : '',
      state.planningReviews?.length ? `Recent planning reviews (historical; reassess current work before responding): ${JSON.stringify(state.planningReviews.slice(-2))}\n` : '',
      outline, state.checkpoint ? `Checkpoint: ${JSON.stringify({ kind: state.checkpoint.kind, decisions: state.checkpoint.decisions, completed: state.checkpoint.completed, nextSteps: state.checkpoint.nextSteps, openQuestions: state.checkpoint.openQuestions })}\n` : '', state.interruption ? `Interruption: ${JSON.stringify(state.interruption)}\n` : '', `Deliverables: ${JSON.stringify(state.artifacts.map(({ id, title, path, size, sha256 }) => ({ id, title, path, size, sha256 })))}\n`];
    const result = base + summary, details = sections.join('');
    return result.length + details.length <= maxChars ? result + details : result + details.slice(0, Math.max(0, maxChars - result.length - suffix.length)) + suffix;
  }
  async readArtifact(taskId, artifactId, { signal, maxBytes = TASK_LIMITS.downloadBytes } = {}) {
    if (typeof artifactId !== 'string' || !/^artifact_[a-f0-9-]{36}$/.test(artifactId)) throw fail('Use a registered artifact identifier.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > TASK_LIMITS.artifactBytes) throw fail('Invalid artifact read limit.');
    const state = await this.get(taskId, { signal }), artifact = state.artifacts.find(item => item.id === artifactId); if (!artifact) throw fail('This file is not registered for the task.', 'ARTIFACT_MISSING', 404);
    const file = await verifyFile(artifact.path, { signal, maxBytes, includeBytes: true });
    if (file.sha256 !== artifact.sha256 || file.size !== artifact.size || file.path !== artifact.path) throw fail('This file changed after registration. Ask the agent to check and register the current file before previewing it.', 'ARTIFACT_CHANGED', 409);
    return { artifact: copy(artifact), buffer: file.buffer, bytes: file.buffer, contentType: artifact.mimeType, mimeType: artifact.mimeType, fileName: artifact.fileName.replace(/[\r\n"\\]/g, '_'), name: artifact.title, size: artifact.size, sha256: artifact.sha256 };
  }
  async verifyArtifact(taskId, artifactId, { signal } = {}) {
    const state = await this.get(taskId, { signal }), artifact = state.artifacts.find(item => item.id === artifactId); if (!artifact) throw fail('This file is not registered for the task.', 'ARTIFACT_MISSING', 404);
    const file = await verifyFile(artifact.path, { signal }); if (file.sha256 !== artifact.sha256 || file.size !== artifact.size || file.path !== artifact.path) throw fail('This file changed after registration. Check and register it again.', 'ARTIFACT_CHANGED', 409); return copy(artifact);
  }
  async previewArtifact(taskId, artifactId, { signal } = {}) {
    const state = await this.get(taskId, { signal }), artifact = state.artifacts.find(item => item.id === artifactId); if (!artifact) throw fail('This file is not registered for the task.', 'ARTIFACT_MISSING', 404);
    const metadata = { name: artifact.title, mimeType: artifact.mimeType, size: artifact.size, sha256: artifact.sha256, path: artifact.path };
    const previewLimit = artifact.previewKind === 'image' ? TASK_LIMITS.imagePreviewBytes : TASK_LIMITS.textPreviewBytes;
    if (artifact.previewKind === 'download' || artifact.size > previewLimit) { await this.verifyArtifact(taskId, artifactId, { signal }); return { artifact, ...metadata, previewKind: 'download', message: artifact.size > previewLimit ? 'This file is too large for an inline preview. Open or download the original file.' : 'Download this file to open it in its application.' }; }
    const result = await this.readArtifact(taskId, artifactId, { signal, maxBytes: previewLimit });
    if (artifact.previewKind === 'text') { let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(result.buffer); } catch { throw fail('This file does not contain valid UTF-8 text.', 'ARTIFACT_NOT_TEXT'); } return { artifact, ...metadata, previewKind: 'text', content, text: content }; }
    return { ...result, previewKind: 'image' };
  }
  async close() { if (this.closePromise) return this.closePromise; this.closed = true; this.awareness.close(); return this.closePromise = Promise.allSettled([...this.queues.values()]); }
}

export const TASK_SCHEMA_VERSION = 14;
const planIdSchema = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$' };
const canonicalTaskActionFields = Object.freeze({
  read: Object.freeze(['action', 'view', 'offset', 'limit', 'expectedRevision', 'viewHash', 'charCount']),
  describe: Object.freeze(['action']),
  plan: Object.freeze(['action', 'expectedRevision', 'contract']),
  bind_receipt: Object.freeze(['action', 'expectedRevision', 'workItemId', 'criterionId', 'receiptBinding']),
  focus: Object.freeze(['action', 'expectedPlanEpoch', 'workItemId']),
  assess: Object.freeze(['action', 'expectedPlanEpoch', 'workItemId', 'criterionId', 'evidenceIds', 'judgment', 'note', 'userAgency']),
  finding: Object.freeze(['action', 'finding']),
  review: Object.freeze(['action']),
  artifact: Object.freeze(['action', 'expectedRevision', 'path', 'title']),
  checkpoint: Object.freeze(['action', 'expectedRevision', 'goal', 'decisions', 'completed', 'nextSteps', 'openQuestions', 'nextAction']),
});
const canonicalTaskActionGuidance = "Each canonical action has its own top-level fields. Use bind_receipt for an observed mapping on a retained unresolved browser submission. Send only action, expectedRevision, workItemId, criterionId and one receiptBinding. Use the returned recovery revision or read with only action read. The host updates only that criterion's mapping. Then focus the original item and observe the same response again; binding alone does not confirm the submission. plan accepts only action, expectedRevision and contract. Supply authorable canonical intent and omit host-owned contract.planEpoch. Only focus and assess accept expectedPlanEpoch. Read describe.actionFields for the complete allowed field list and omit fields belonging to other actions.";

export const TASK_TOOL = { type: 'function', name: 'relay_task', description: CONTRACT_INSTRUCTIONS + ' ' + canonicalTaskActionGuidance, inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
  action: { type: 'string', enum: Object.keys(canonicalTaskActionFields), description: Object.entries(canonicalTaskActionFields).map(([action, fields]) => action + ': ' + fields.join(', ')).join('; ') + '. For read, expectedRevision, viewHash and charCount are allowed only with view=contract or view=checkpoint.' },
  view: { type: 'string', enum: ['current', 'operations', 'evidence', 'contract', 'checkpoint'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, charCount: { type: 'integer', minimum: 1, maximum: 8000 }, viewHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  expectedRevision: { type: 'integer', minimum: 1, description: "Required for plan, bind_receipt, checkpoint and artifact. For read, allowed only with view=contract or view=checkpoint. Copy the current delivered task revision or the revision in receipt recovery." },
  expectedPlanEpoch: { type: 'integer', minimum: 1, description: "Required only for focus and assess. Copy the current material plan epoch. Omit this field for every other action, including plan." },
  contract: { ...copy(PLAN_CONTRACT_SCHEMA), description: "Complete authorable canonical intent for action plan. Omit host-owned contract.planEpoch from a read contract. Send only action, expectedRevision and contract; expectedPlanEpoch is a top-level token only for focus and assess." },
  receiptBinding: { ...copy(CONTRACT_RECEIPT_BINDING_SCHEMA), description: 'One observed browser receipt mapping for action bind_receipt.' },
  workItemId: copy(planIdSchema), criterionId: copy(planIdSchema), evidenceIds: { type: 'array', maxItems: 100, items: { type: 'string' } },
  judgment: { type: 'string', enum: ['satisfied', 'blocked'] }, note: { type: 'string', maxLength: 2000 },
  userAgency: { ...copy(USER_AGENCY_CHECKPOINT_SCHEMA), description: 'For a blocked judgment on a newly adopted Plan, compare proceeding, deferring or asking for the affected action. A counterparty preference or required field label alone is insufficient. Omit for ordinary assessments.' },
  finding: { type: 'object', additionalProperties: false, required: ['ruleId', 'message', 'evidenceIds'], properties: { ruleId: copy(planIdSchema), message: { type: 'string', minLength: 1, maxLength: 2000 }, evidenceIds: { type: 'array', maxItems: 100, items: { type: 'string' } } } },
  path: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' }, decisions: { type: 'array', items: { type: 'string' } }, completed: { type: 'array', items: { type: 'string' } }, nextSteps: { type: 'array', items: { type: 'string' } }, openQuestions: { type: 'array', items: { type: 'string' } }, nextAction: { type: 'string' },
} } };
export const TASK_WORKER_TOOL = { ...copy(TASK_TOOL), description: TASK_TOOL.description + ' Work only within your actual assignment; structural edits must preserve every other owner.' };

export const TASK_INSTRUCTIONS = '\n\nCANONICAL TASK WORKSPACE\n' + CONTRACT_INSTRUCTIONS + '\nUse plan with a complete canonical contract and the current expectedRevision only for material intent changes. focus uses expectedPlanEpoch and changes execution focus without changing the plan. assess is only a grounded judgment; it cannot create observation or confirmation evidence. review reports host-computed readiness. Ordinary operations append host receipts automatically.\n' + canonicalTaskActionGuidance + '\n';

export const EXTERNAL_WORKER_INSTRUCTIONS = '\nEXTERNAL ACTION OWNERSHIP\nThe coordinator owns the final remote send, post, submit or publication. You may inspect the signed-in destination, check for duplicates, capture/check attachments and prepare draft content within your assignment. Return the actual evidence and any uncertain existing effects to the coordinator. Do not click a final send/publish/submit control or execute the final remote mutation from this worker; do not request another worker to do it. You do not have the coordinator external receipt tool. The coordinator must reconcile prior effects and record its durable attempt immediately before one final send, then inspect the result. A worker report is not proof of publication.\n';
export function delegatedWorkerInstructions({ planningMode = 'on', planningGuardrails = false, executionGuardrails = false } = {}) {
  const scope = '\nWORKER SCOPE\nWork within your assignment, inherited access and user constraints. Coordinate concurrent changes, report real results and inspect an uncertain destination before retrying.\n';
  const planning = planningMode === 'off'
    ? 'Planning Off: no saved-plan or Planning review checkpoint is required.\n'
    : planningGuardrails
      ? 'Forced Planning is active: use an assigned saved concrete step before operational tool calls, reconcile its actual result, and complete the required Planning review. Legacy execution guardrails being off does not disable this requirement.\n'
      : 'Planning is advisory: no saved-plan or Planning review checkpoint is required before tools or your response.\n';
  const external = executionGuardrails ? EXTERNAL_WORKER_INSTRUCTIONS
    : '\nEXTERNAL ACTION POLICY\nThe separate coordinator-only final-send restriction is disabled. Authorized external actions may be performed within your assignment only when destination and tool permissions allow; do not repeat uncertain mutations, and report real receipts.\n';
  return scope + planning + external;
}
// Apply the current user-selected execution preference without changing the task data schema.
function advisoryTaskCatalog(tool) {
  const result = structuredClone(tool);
  result.description = 'Optional compact auditable task context. Planning does not gate tools, workers or final responses while execution guardrails are off. Preserve actual outcomes and use declared fields/revisions for chosen edits.';
  const walk = value => { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) {
    if (key === 'description' && typeof child === 'string' && /Planning On|Planning is On|before.*(?:operational|tool|final)|activate|smallest.*operation|mandatory|eligible leaf|decompos|revisit/i.test(child)) value[key] = 'Optional saved planning metadata. Follow this data schema for chosen edits; it is not an execution or final-response checkpoint.';
    else if (child && typeof child === 'object') walk(child);
  }}; walk(result.inputSchema); return result;
}
export function currentTaskTool({ executionGuardrails = false } = {}) { return executionGuardrails ? TASK_TOOL : advisoryTaskCatalog(TASK_TOOL); }
export function currentTaskWorkerTool({ executionGuardrails = false } = {}) { return executionGuardrails ? TASK_WORKER_TOOL : advisoryTaskCatalog(TASK_WORKER_TOOL); }
export function currentTaskInstructions({ executionGuardrails = false } = {}) { return executionGuardrails ? TASK_INSTRUCTIONS : ADVISORY_PLANNING_INSTRUCTIONS; }

function checkTaskCall(args) {
    const allowed = Object.hasOwn(canonicalTaskActionFields, args.action) ? canonicalTaskActionFields[args.action] : null;
    if (!allowed) throw fail('Use only the fields declared for canonical action ' + String(args.action) + '.', 'TASK_CONTRACT_INVALID');
    const unexpectedFields = Object.keys(args).filter(key => !allowed.includes(key));
    if (unexpectedFields.length) throw fail('Canonical action ' + args.action + ' rejects unexpected fields: ' + unexpectedFields.join(', ') + '. Allowed fields: ' + allowed.join(', ') + '.', 'TASK_CONTRACT_INVALID');
    if (args.action === 'read' && (args.view !== undefined && !['current','operations','evidence','contract','checkpoint'].includes(args.view) || !['contract','checkpoint'].includes(args.view) && ['viewHash','charCount','expectedRevision'].some(key => args[key] !== undefined))) throw fail('Use current, operations, evidence, or a contract/checkpoint read with its declared pinned fields.', 'TASK_CONTRACT_INVALID');
}

export function createTaskToolHandler({ store, taskId, runId, nodeId, task, signal, onEvent = () => {}, maxCalls = null, schemaVersion = TASK_SCHEMA_VERSION, methods, planDetail, planningMode, documentAnalysisContract, scopeStepId, planScopeStepId, reviewScopeStepId, worker = false, getReviewContext, executionGuardrails = false }) {
  if (schemaVersion !== TASK_SCHEMA_VERSION) throw fail('This task schema is unsupported. Start a new task with current capabilities.', 'TASK_SCHEMA_UNSUPPORTED', 409);
  identifier(taskId); planningModeOf(planningMode); if (planDetail !== undefined && !TASK_PLAN_DETAILS.includes(planDetail)) throw fail('Plan detail must be compact, balanced or detailed.'); if (maxCalls !== null && (!Number.isSafeInteger(maxCalls) || maxCalls < 1)) throw fail('The configured task-state call limit must be a positive integer or null.'); let calls = 0;
  return async (call, context = {}) => {
    const active = AbortSignal.any([signal, context.signal].filter(Boolean)); check(active); if (maxCalls !== null && ++calls > maxCalls) throw fail('The configured task-state call limit was reached.', 'TASK_CALL_LIMIT');
    try {
      if (call.name !== 'relay_task') throw fail('Unknown task-state tool.'); let args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; if (!object(args)) throw fail('Task arguments must be an object.'); checkTaskCall(args);
      {
        if (worker && args.action === 'checkpoint') throw fail('The shared continuity checkpoint belongs to the coordinator.', 'TASK_CONTRACT_OWNERSHIP', 403);
        if (args.action === 'describe') return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ schemaVersion: 14, contractVersion: 2, schema: copy(TASK_TOOL.inputSchema), actionFields: copy(canonicalTaskActionFields), note: CONTRACT_INSTRUCTIONS + ' ' + canonicalTaskActionGuidance }) }] };
        if (['plan', 'bind_receipt'].includes(args.action)) {
          const options = { expectedRevision: args.expectedRevision, runId, nodeId, schemaVersion: 14, worker, scopeStepId, signal: active, executionGuardrails };
          if (args.action === 'bind_receipt') await store.bindContractReceipt(taskId, args, options);
          else if (object(args.contract) && Object.hasOwn(args.contract, 'planEpoch')) {
            const { planEpoch, ...authored } = args.contract;
            // The callback runs under the task lock after the revision check.
            await store.setContract(taskId, state => {
              if (!isPlanContractTask(state) || !Number.isSafeInteger(planEpoch) || planEpoch < 1)
                throw fail('Omit planEpoch unless it is the positive epoch copied from the current saved contract.', 'TASK_CONTRACT_INVALID');
              if (planEpoch !== state.contract.planEpoch)
                throw fail('The copied planEpoch differs from the saved plan. Read the current contract before editing.', 'TASK_CONTRACT_EPOCH_CONFLICT', 409);
              return authored;
            }, options);
          } else await store.setContract(taskId, args.contract, options);
          const state = await store.get(taskId, { signal: active });
          onEvent({ type: 'task.state', taskId, state });
          return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(projectContractTaskState(state)) }] };
        }
        if (['read','review','focus','assess','finding'].includes(args.action)) return await applyContractTaskAction({ store, taskId, runId, nodeId, coordinator: !worker, args, signal: active, onEvent });
        const options = { expectedRevision: args.expectedRevision, runId, nodeId, schemaVersion: 14, signal: active, executionGuardrails };
        if (args.action === 'artifact') await store.addArtifact(taskId, args, options);
        else await store.checkpoint(taskId, args, options);
        const state = await store.get(taskId, { signal: active });
        onEvent({ type: 'task.state', taskId, state }); return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(projectContractTaskState(state)) }] };
      }

    } catch (error) {
      if (active.aborted) check(active);
      const details = { ...(typeof error.code === 'string' ? { code: error.code } : {}), ...(Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? { status: error.status } : {}), ...(Number.isSafeInteger(error.currentRevision) && error.currentRevision >= 1 ? { currentRevision: error.currentRevision } : {}), ...(error.code === 'TASK_PLAN_EVIDENCE_TOO_LONG' ? { actualLength: error.actualLength, maxLength: error.maxLength } : {}), ...(error.code === 'TASK_STATE_LIMIT' && Number.isSafeInteger(error.actualChars) ? { actualChars: error.actualChars, maxChars: error.maxChars } : {}), ...(error.code === 'TASK_STATE_LIMIT' && Number.isSafeInteger(error.actualBytes) ? { actualBytes: error.actualBytes, maxBytes: error.maxBytes } : {}) };
      return { success: false, ...details, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: error.message, ...details }) }] };
    }
  };
}
