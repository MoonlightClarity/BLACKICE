import {createHash, randomUUID} from 'node:crypto';
import {observeGoalToolOutcome, repeatedUnproductiveOperations, assessGoalProgress, detectNoProgressDispatchLoop, detectUnknownEffectReplay, inFlightEffectSignature} from './goal-recovery-policy.mjs';

const ACTIVE_RUN = new Set(['queued', 'running', 'waiting']);
const ENABLED = new Set(['active', 'waiting']);
const clone = value => structuredClone(value);
const fail = (message, code = 'GOAL_INVALID', status = 400) => Object.assign(new Error(message), {code, status});
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = () => new Date().toISOString();
const rootOf = run => run.taskId || run.id;
const text = (value, label, max = 50000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw fail(`${label} must contain 1 to ${max.toLocaleString('en-US')} characters.`);
  return value.trim();
};

const browserProgressByRun = new WeakMap();

function observeGoalBrowserState(run, args, result) {
  if (!args || !['open', 'navigate', 'snapshot', 'read', 'fill', 'select'].includes(args.action)) return;
  let page;
  try {
    page = JSON.parse(result.contentItems?.find(item => item.type === 'inputText')?.text);
    if (result.success === false && result.code === 'BROWSER_REF_STALE' && page.actionDispatched === false)
      page = page.recovery?.observation;
    else if (result.success !== true) return;
  } catch { return; }
  if (!page?.tabId || !Array.isArray(page.frames) || page.protectedContent) return;
  let state = browserProgressByRun.get(run);
  if (!state) browserProgressByRun.set(run, state = {pages: new Map(), advances: []});
  const previous = state.pages.get(page.tabId);
  const controls = page.frames.flatMap(frame => (frame.elements || []).map(element => ({...element, frameUrl: frame.url})));
  const target = controls.find(control => control.ref === args.ref);
  const before = previous?.controls.find(control => control.ref === args.ref);
  const value = args.action === 'fill' ? args.text : args.value;
  if (['fill', 'select'].includes(args.action) && result.success === true && previous?.url === page.url
    && previous.documentId === page.documentId && before && target && before.frameUrl === target.frameUrl
    && before.name === target.name && before.tag === target.tag && before.type === target.type
    && typeof before.value === 'string' && typeof value === 'string' && value.trim()
    && target.value === value && before.value !== value && target.name && target.type !== 'password') {
    const key = digest(['browser-field', page.url, target.frameUrl, target.name, target.tag, target.type, value]);
    state.advances = [...state.advances, {key, name: target.name, value}].slice(-32);
    state.lastAdvanceAt = Date.now();
  }
  state.pages.set(page.tabId, {url: page.url, documentId: page.documentId, controls});
}
/** The goal is conversation metadata, not another task/plan/operation store. */
export function validateGoalInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Enter an objective for goal mode.');
  if (Object.keys(value).some(key => !['objective', 'maxTurns', 'maxMinutes'].includes(key))) throw fail('Unknown goal option.');
  const objective = text(value.objective, 'Goal objective');
  const maxTurns = value.maxTurns ?? null, maxMinutes = value.maxMinutes ?? null;
  if (maxTurns !== null && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) throw fail('Goal turn limit must be a positive whole number, or null for unlimited.');
  if (maxMinutes !== null && (!Number.isFinite(maxMinutes) || maxMinutes <= 0)) throw fail('Goal time limit must be positive, or null for unlimited.');
  return {objective, maxTurns, maxMinutes};
}

export const GOAL_TOOL = {
  type: 'function',
  name: 'relay_goal',
  description: 'Read this conversation’s persistent goal, record concrete progress, or report completion with evidence. Completion takes effect only after this same turn settles successfully. This tool does not start another worker or grant permission.',
  inputSchema: {type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: {type: 'string', enum: ['read', 'progress', 'complete', 'wait', 'effects', 'reconcile']},
    receiptId: {type: ['string','null'], maxLength: 100},
    signature: {type: 'string', maxLength: 64},
    observedAt: {type: 'string', maxLength: 100},
    expectedResolutionCount: {type: 'integer', minimum: 0},
    outcome: {type: 'string', enum: ['occurred','not_occurred','unknown']},
    retryReason: {type: 'string', maxLength: 2000, description: 'Only for an outcome still unknown: explain why a deliberate repeat is justified by the user objective, available evidence and cost of waiting. This records judgment, never proof of absence, and does not execute anything.'},
    goalId: {type: 'string', maxLength: 100},
    summary: {type: 'string', maxLength: 4000},
    evidence: {type: 'string', maxLength: 12000},
    nextAction: {type: 'string', maxLength: 2000, description: 'Concrete authorized operation to execute next, including its destination or source when known.'},
    milestone: {type: 'string', maxLength: 1000, description: 'Stable identifier for a verified goal-advancing state change, such as a destination plus resolved prerequisite. Searches and target switches are not milestones.'},
    blockedBranch: {type: 'string', maxLength: 2000, description: 'Smallest deferred operation and its observed prerequisite, if one remains.'},
    waitUntil: {type: 'string', description: 'An observed retry/availability time in ISO 8601 format. Do not use waiting to avoid ordinary work.'},
    waitForRunId: {type: 'string', maxLength: 100, description: 'An actual running BLACKICE execution to observe, never an invented handle.'},
  }},
};

export class ConversationGoals {
  constructor({engine, conversations, autoStart = true, continuationDelayMs = 750, retryDelayMs = 30000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout}) {
    this.engine = engine; this.conversations = conversations; this.delay = continuationDelayMs; this.retryDelay = retryDelayMs;
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer; this.started = autoStart;
    this.chains = new Map(); this.timers = new Map(); this.epochs = new Map(); this.userHolds = new Map(); this.errors = new Map(); this.pending = new Set(); this.closed = false;
  }
  async init() {
    this.engine.goals = this;
    this.listener = event => {
      if (event.type === 'agent.event' && event.data?.type === 'steer' && event.data.accepted === true) {
        const run = this.engine.runs.get(event.runId);
        if (run) {
          const rootId = rootOf(run);
          delete run.goalCompletion; this.invalidate(rootId);
          this.track(this.enqueue(rootId, async () => {
            const goal = this.raw(rootId);
            if (!goal || !ENABLED.has(goal.status)) return;
            delete run.goalCompletion;
            await this.save(rootId, {...goal, generation: goal.generation + 1, status: 'active', waitUntil: null, waitForRunId: null,
              lastReason: 'A new user direction was accepted. Completion will be checked against it.'});
            await this.engine.persist();
          }), rootId);
        }
        return;
      }
      if (event.type !== 'run.updated' || !event.data?.id) return;
      const run = event.data, rootId = rootOf(run), goal = this.raw(rootId);
      if (!goal) {
        if (run.settled === true && this.conversations.states[rootId]?.goalCleanupPending)
          this.track(this.enqueue(rootId, () => this.cleanup(rootId)), rootId);
        return;
      }
      this.publish(rootId);
      if (run.settled === true) this.track(this.enqueue(rootId, () => this.settled(rootId, run)), rootId);
    };
    this.engine.on('event', this.listener);
    for (const [rootId, metadata] of Object.entries(this.conversations.states)) {
      const goal = metadata?.goal;
      if (goal?.status === 'paused' && goal.pauseRequest && !goal.pauseRequest.settled) {
        let target = this.engine.runs.get(goal.pauseRequest.runId);
        if (!target) {
          try { target = (await this.conversations.family(rootId)).runs.find(run => run.id === goal.pauseRequest.runId); } catch {}
        }
        if (target?.settled === true) await this.save(rootId, {...goal, pauseRequest: {...goal.pauseRequest, settled: true, settledAt: timestamp()}, lastSettledRunId: target.id});
        else await this.save(rootId, {...goal, pauseRequest: {...goal.pauseRequest, recoveryUnverified: true}, lastReason: 'The saved pause target cannot be verified as settled. Inspect its saved receipts before resuming; no effects were replayed.'});
        continue;
      }
      if (!goal || !ENABLED.has(goal.status)) continue;
      // Never replay a turn whose dispatch or external effects may have been
      // interrupted. Its existing run receipts remain the recovery authority.
      let family;
      try { family = await this.conversations.family(goal.currentRunId || rootId); } catch {}
      const latest = family?.runs.at(-1);
      if (!latest || goal.dispatch || latest.settled !== true || latest.status === 'failed' || latest.status === 'cancelled') {
        await this.save(rootId, {...goal, status: 'interrupted', lastReason: 'BLACKICE stopped before this goal reached a clean turn boundary. Resume continues from saved receipts and checks uncertain effects first.', dispatch: null});
      } else {
        if (goal.currentRunId !== latest.id) await this.save(rootId, {...goal, currentRunId: latest.id});
        if (goal.lastSettledRunId !== latest.id) await this.settled(rootId, latest);
        else this.schedule(rootId);
      }
    }
    return this;
  }
  start() {
    if (this.closed) return;
    this.started = true;
    for (const [id, row] of Object.entries(this.conversations.states)) if (row.goal && ENABLED.has(row.goal.status)) this.schedule(id);
  }
  track(promise, rootId) {
    const observed = this.raw(rootId), generation = observed?.generation, goalId = observed?.id, epoch = this.epochs.get(rootId) || 0;
    const tracked = promise.catch(async error => {
      if (rootId) {
        await this.enqueue(rootId, async () => {
          const goal = this.raw(rootId);
          if (!goal || goal.id !== goalId || goal.generation !== generation || epoch !== (this.epochs.get(rootId) || 0)) return;
          this.invalidate(rootId);
          const reason = 'Goal continuation could not proceed: ' + error.message;
          try { await this.save(rootId, {...goal, status: 'blocked', lastReason: reason}); } catch {}
          this.errors.set(rootId, reason); this.publish(rootId);
        });
      }
      this.engine.emit('event', {type: 'goal.error', at: timestamp(), data: {conversationId: rootId || null, error: error.message, code: error.code || 'GOAL_CONTINUATION_FAILED'}});
    });
    this.pending.add(tracked);
    tracked.finally(() => this.pending.delete(tracked)).catch(() => {});
    return tracked;
  }
  enqueue(rootId, operation) {
    const promise = (this.chains.get(rootId) || Promise.resolve()).catch(() => {}).then(operation);
    this.chains.set(rootId, promise);
    promise.finally(() => { if (this.chains.get(rootId) === promise) this.chains.delete(rootId); }).catch(() => {});
    return promise;
  }
  raw(rootId) { return this.conversations.states[rootId]?.goal || null; }
  forRun(run) { return this.raw(rootOf(run)); }
  view(rootId) {
    const goal = this.raw(rootId); if (!goal) return null;
    const live = [...this.engine.runs.values()].find(run => rootOf(run) === rootId && (ACTIVE_RUN.has(run.status) || run.settled === false));
    const {dispatch, ...publicGoal} = clone(goal);
    if (publicGoal.pauseRequest) {
      const pausedRun = this.engine.runs.get(publicGoal.pauseRequest.runId);
      publicGoal.pauseRequest.settled = goal.pauseRequest.settled === true || pausedRun?.settled === true;
      publicGoal.pauseRequest.status = publicGoal.pauseRequest.settled ? 'paused' : goal.pauseRequest.recoveryUnverified ? 'unverified' : 'pausing';
      if (publicGoal.pauseRequest.settled) publicGoal.lastReason = 'Paused. Saved work is retained. Resume checks uncertain effects before continuing; no completed checkpoint is implied.';
    }
    return {...publicGoal, ...(this.errors.has(rootId) ? {status: 'blocked', lastReason: this.errors.get(rootId), error: this.errors.get(rootId)} : {}), conversationId: rootId, running: Boolean(live && live.status === 'running'), runStatus: live?.status || null,
      currentRunId: live?.id || goal.currentRunId || null, unlimited: goal.maxTurns === null && goal.maxMinutes === null};
  }
  async resolve(id) {
    if (this.conversations.states[id]?.goal && (this.conversations.entries.has(id) || this.engine.runs.has(id))) return id;
    return (await this.conversations.family(id)).rootId;
  }
  async get(id) { return this.view(await this.resolve(id)); }
  async effectReceipts(id) {
    const rootId = await this.resolve(id);
    return clone(this.conversations.states[rootId]?.goalUnresolvedEffects || []);
  }
  async resolveEffect(id, value, sourceRun = null) {
    const rootId = await this.resolve(id);
    if (!value || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.signature || '') ||
        typeof value.observedAt !== 'string' || !Number.isSafeInteger(value.expectedResolutionCount) || value.expectedResolutionCount < 0 || !['occurred','not_occurred','unknown'].includes(value.outcome))
      throw fail('Supply the observed signature, timestamp and outcome.', 'GOAL_EFFECT_IDENTITY_REQUIRED');
    const evidence = text(value.evidence, 'Reconciliation evidence', 4000);
    const retryReason = sourceRun && value.outcome === 'unknown' && value.retryReason !== undefined
      ? text(value.retryReason, 'Reason for deliberate retry despite uncertainty', 2000) : null;
    return this.enqueue(rootId, async () => {
      if (sourceRun && (rootOf(sourceRun) !== rootId || !this.recoveryRunCurrent(sourceRun) || value.goalId !== this.boundGoal(sourceRun).id))
        throw fail('The current goal changed. Read it before reconciling.', 'GOAL_CHANGED', 409);
      if ((this.inFlightGoalEffects?.get(rootId)?.size || 0) || (this.pendingUnresolvedEffects?.get(rootId) || []).length || [...this.engine.runs.values()].some(run => run !== sourceRun && rootOf(run) === rootId && (ACTIVE_RUN.has(run.status) || run.settled === false)))
        throw fail('Wait for active work and pending uncertainty to settle before reconciliation.', 'GOAL_EFFECT_ACTIVE', 409);
      const records = this.conversations.states[rootId]?.goalUnresolvedEffects || [];
      const index = records.findIndex(row => row.signature === value.signature && row.at === value.observedAt && (row.id || null) === (value.receiptId || null) && (row.resolutions || []).length === value.expectedResolutionCount && (!row.resolution || row.resolution.outcome === 'unknown'));
      if (index < 0) throw fail('The observed unresolved receipt changed or was already resolved. Inspect it again.', 'GOAL_EFFECT_STALE', 409);
      if (retryReason && (records[index].resolution?.deliberateRetry || (records[index].resolutions || []).some(row => row.deliberateRetry) || (records[index].retryAttempts || []).length))
        throw fail('This unknown receipt already had a deliberate retry authorization. It cannot be renewed. Inspect the destination for new outcome evidence or continue independent work.', 'GOAL_EFFECT_RETRY_USED', 409);
      const resolution = {outcome:value.outcome, evidence, at:timestamp(), source:sourceRun?'agent':'operator',
        ...(sourceRun?{runId:sourceRun.id}:{}), ...(retryReason?{retryReason, deliberateRetry:true}: {})};
      const updated = records.map((row,i) => i === index ? {...row, resolution, resolutions:[...(row.resolutions || []),resolution]} : row);
      await this.conversations.changeState(rootId, {goalUnresolvedEffects:updated});
      return {receipt:clone(updated[index]), replayed:false};
    });
  }
  publish(rootId) {
    const goal = this.view(rootId);
    this.engine.emit('event', {type: 'goal.updated', runId: goal?.currentRunId || null, at: timestamp(), data: {conversationId: rootId, goal}});
  }
  async save(rootId, value, extra = {}) {
    const previous = this.raw(rootId), goal = value ? {...clone(value), revision: (previous?.revision || 0) + 1, updatedAt: timestamp()} : null;
    await this.conversations.changeState(rootId, {goal, ...extra});
    this.publish(rootId); return goal;
  }
  invalidate(rootId) {
    this.epochs.set(rootId, (this.epochs.get(rootId) || 0) + 1);
    if (this.timers.has(rootId)) this.clearTimer(this.timers.get(rootId));
    this.timers.delete(rootId);
  }
  holdForUserInput(id) {
    const source = this.engine.runs.get(id) || this.conversations.entries.get(id);
    const rootId = source ? this.conversations.entries.has(id) ? this.conversations.rootIdFor(source) : rootOf(source) : id;
    this.invalidate(rootId); this.userHolds.set(rootId, (this.userHolds.get(rootId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const remaining = (this.userHolds.get(rootId) || 1) - 1;
      if (remaining > 0) this.userHolds.set(rootId, remaining); else this.userHolds.delete(rootId);
      this.schedule(rootId);
    };
  }
  create(objective) {
    const input = validateGoalInput(objective), at = timestamp();
    return {id: randomUUID(), generation: 1, revision: 0, ...input, status: 'active', turns: 0, totalTurns: 0,
      createdAt: at, activatedAt: at, updatedAt: at, lastReason: 'Working toward the goal.', currentRunId: null,
      lastSettledRunId: null, repeatedFailures: 0, noProgressTurns: 0, completionEvidence: null, dispatch: null};
  }
  async control(id, body = {}) {
    const rootId = await this.resolve(id);
    const action = body.action || 'set';
    if (!['set', 'update', 'pause', 'pause_after_turn', 'resume', 'clear'].includes(action)) throw fail('Choose set, update, pause, pause_after_turn, resume, or clear.');
    if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(body.requestId))) throw fail('Invalid goal request ID.');
    const requestHash = digest(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'requestId').sort(([a], [b]) => a.localeCompare(b))));
    // User steering wins even while a continuation is awaiting archive IO.
    this.invalidate(rootId);
    return this.enqueue(rootId, async () => {
      if (this.closed || this.engine.closed) throw fail('BLACKICE is closing.', 'GOAL_CLOSED', 503);
      const receipts = this.conversations.states[rootId]?.goalControlReceipts || [];
      const receipt = body.requestId && receipts.find(row => row.requestId === body.requestId);
      if (receipt) {
        if (receipt.requestHash !== requestHash) throw fail('This goal request ID was already used for different input.', 'GOAL_REQUEST_CONFLICT', 409);
        const goal = this.view(rootId); if (goal && ENABLED.has(goal.status)) this.schedule(rootId);
        return {goal, replayed: true, ...(receipt.runId && this.engine.runs.has(receipt.runId) ? {run: this.engine.getRun(receipt.runId)} : {})};
      }
      let goal = this.raw(rootId);
      if(['set','update','resume'].includes(action)&&this.conversations.states[rootId]?.autonomy?.enabled)
        throw fail('Disable autonomous operation before starting Goal Mode; saved calibration remains intact.','GOAL_AUTONOMY_CONFLICT',409);
      // Progress/settlement receipts change revision but not the user's control intent.
      // Reconcile only an exact observed Pause/Resume target atomically in this queue.
      // Never retry mutations or infer a missing snapshot, and never rebase edits.
      const observed = body.expectedControl;
      const controlUnchanged = ['pause','resume'].includes(action) && goal && observed &&
        Number.isSafeInteger(body.expectedRevision) && body.expectedRevision < goal.revision &&
        typeof observed.goalId === 'string' && observed.goalId === goal.id &&
        Number.isSafeInteger(observed.generation) && observed.generation === goal.generation &&
        observed.status === goal.status && Object.hasOwn(observed, 'runId') &&
        observed.runId === (goal.currentRunId || null);
      if (body.expectedRevision !== undefined && body.expectedRevision !== (goal?.revision || 0) && !controlUnchanged)
        throw fail('The goal changed. Read its current revision and try again.', 'GOAL_REVISION_CONFLICT', 409);
      if (action !== 'set' && action !== 'clear' && !goal) throw fail('This conversation has no goal.', 'GOAL_NOT_FOUND', 404);
      const pauseRun = action === 'pause' ? [...this.engine.runs.values()].find(run => rootOf(run) === rootId && (ACTIVE_RUN.has(run.status) || run.settled === false)) : null;
      if (body.pauseRunId !== undefined && pauseRun?.id !== body.pauseRunId) throw fail('The active turn changed. Refresh before pausing.', 'GOAL_PAUSE_TARGET', 409);
      if (action === 'set') goal = this.create({objective: body.objective, maxTurns: body.maxTurns, maxMinutes: body.maxMinutes});
      else if (action === 'update') {
        const input = validateGoalInput({objective: body.objective ?? goal.objective, maxTurns: body.maxTurns === undefined ? goal.maxTurns : body.maxTurns, maxMinutes: body.maxMinutes === undefined ? goal.maxMinutes : body.maxMinutes});
        goal = {...goal, ...input, generation: goal.generation + 1, status: ENABLED.has(goal.status) ? 'active' : goal.status === 'completed' ? 'paused' : goal.status,
          dispatch: null, waitUntil: null, waitForRunId: null, completionEvidence: null, completedAt: null, noProgressTurns: 0,
          lastReason: 'Goal updated. The next turn uses this objective.'};
      } else if (action === 'pause' || action === 'pause_after_turn') goal = {...goal, generation: goal.generation + 1, status: 'paused', dispatch: null,
        ...(pauseRun ? {pauseRequest: {runId: pauseRun.id, at: timestamp(), mode: 'interrupt-and-preserve'}} : {pauseRequest: goal.pauseRequest || null}),
        lastReason: action === 'pause_after_turn' ? 'Automatic continuation paused. The current turn can finish.' : pauseRun ? 'Pausing current execution. Saved work and uncertain effects are preserved; waiting for the current turn to settle.' : 'Paused by you.'};
      else if (action === 'resume' && this.view(rootId)?.pauseRequest && this.view(rootId).pauseRequest.settled !== true) throw fail(this.view(rootId).pauseRequest.status === 'unverified' ? 'The saved pause target has no verified settlement. Inspect its saved receipts before resuming.' : 'Current execution is still pausing. Wait for its saved effects to settle before resuming.', 'GOAL_PAUSE_PENDING', 409);
      else if (action === 'resume') goal = {...goal, pauseRequest: null, generation: goal.generation + 1, status: 'active', turns: 0, activatedAt: timestamp(), dispatch: null, waitUntil: null, waitForRunId: null, repeatedFailures: 0, noProgressTurns: 0, completionEvidence: null, lastReason: 'Resuming the saved goal and conversation.'};
      else if (action === 'clear') goal = null;
      const record = body.requestId ? {requestId: body.requestId, requestHash, action, at: timestamp(), ...(pauseRun ? {pauseRunId: pauseRun.id} : {})} : null;
      this.errors.delete(rootId);
      await this.save(rootId, goal, {...(record ? {goalControlReceipts: [...receipts, record].slice(-32)} : {}), ...(action === 'clear' ? {goalCleanupPending: true} : {})});
      // Save the exact pause target before interruption. Replayed controls only read
      // their receipt and never interrupt another execution or replay external work.
      if (pauseRun && ACTIVE_RUN.has(pauseRun.status)) this.engine.cancelRun(pauseRun.id);
      if (action === 'clear') await this.cleanup(rootId);
      let run = null;
      if (goal && ENABLED.has(goal.status) && ['set', 'resume', 'update'].includes(action)) run = await this.dispatch(rootId, {execution: body});
      if (record && run) {
        const current = this.conversations.states[rootId].goalControlReceipts.map(row => row.requestId === record.requestId ? {...row, runId: run.id} : row);
        await this.conversations.changeState(rootId, {goalControlReceipts: current});
      }
      return {goal: this.view(rootId), ...(run ? {run} : {})};
    }).catch(error => { this.schedule(rootId); throw error; });
  }
  prepareRun(run) {
    if (run.goalRequest) run.goalInitialEpoch = this.epochs.get(rootOf(run)) || 0;
  }
  async admitRun(run) {
    const rootId = rootOf(run);
    return this.enqueue(rootId, async () => {
      let goal = this.raw(rootId);
      if (run.goalRequest && run.goalInitialEpoch === (this.epochs.get(rootId) || 0)) goal = this.create(run.goalRequest);
      if (run.goalDispatch && (!goal || !ENABLED.has(goal.status) || this.userHolds.has(rootId) || run.goalDispatch.goalId !== goal.id || run.goalDispatch.generation !== goal.generation || run.goalDispatch.epoch !== (this.epochs.get(rootId) || 0)))
        throw fail('A newer goal control or user message superseded this automatic continuation.', 'GOAL_DISPATCH_SUPERSEDED', 409);
      if (!goal || !ENABLED.has(goal.status)) return;
      if (!run.goalDispatch) this.invalidate(rootId);
      run.goal = {id: goal.id, generation: goal.generation, objective: goal.objective, automatic: Boolean(run.goalDispatch)};
      const counted = goal.currentRunId !== run.id;
      goal = {...goal, status: 'active', currentRunId: run.id, dispatch: null, waitUntil: null, waitForRunId: null,
        turns: goal.turns + (counted ? 1 : 0), totalTurns: (goal.totalTurns || 0) + (counted ? 1 : 0), lastReason: 'Working toward the goal.'};
      await this.save(rootId, goal);
    });
  }
  boundGoal(run) {
    const goal = this.forRun(run);
    return goal && run.goal?.id === goal.id && run.goal.generation === goal.generation ? goal : null;
  }
  recoveryRunCurrent(run) {
    const goal = this.boundGoal(run);
    return Boolean(goal && ENABLED.has(goal.status) && this.engine.runs.get(run.id) === run
      && ACTIVE_RUN.has(run.status) && run.settled !== true && !run.abortController?.signal?.aborted);
  }
  retainsResources(run) {
    const goal = this.forRun(run);
    return Boolean(goal && goal.status !== 'completed');
  }
  instructions(run) {
    const goal = this.forRun(run); if (!goal || !ENABLED.has(goal.status)) return '';
    return '\n\nPERSISTENT CONVERSATION GOAL\n' + JSON.stringify({id: goal.id, objective: goal.objective, turns: goal.turns, maxTurns: goal.maxTurns, maxMinutes: goal.maxMinutes}) +
      '\nKeep working toward the entire objective in this same conversation. An ordinary final response is a progress checkpoint, not completion of the goal. Preserve the selected model, task, plan, prior evidence, browser pages, and accepted user directions. Act on the current evidence within this turn. When a tool fails, use its recovery observation or change approach before repeating it. Read the host error CODE and effect-dispatch status literally: a host-side uninspected, precondition or stale-ref refusal is NOT evidence of a website CAPTCHA. Inspect the actual control or missing history via a read-only operation, then choose a newly supported input action. After repeated unchanged refusals, change the method or work another branch; do not bypass a host refusal using coordinates or keys. If a branch remains blocked, defer the smallest affected operation and act on an independent branch. Treat missing information as a cue to inspect validation and check reliable sources or permitted alternatives. Only defer once those checks establish a specific remaining prerequisite. Before repeating an external action, inspect its saved result and current state. Do not repeat already completed effects.\n' +
      'Use relay_goal read for the current goal. Use effects to inspect uncertain receipts and reconcile to record current destination evidence against an exact receipt. Keep unknown outcomes unknown; if a deliberate repeat is justified by the user objective and the cost of waiting, explain it in retryReason. This permits one attempt in this turn and never executes a replay by itself. Do not ask the user to perform routine reconciliation. Make reasonable supported inferences; missing profile evidence is not proof that a qualification is absent, and employer preferences are not automatically hard gates. When handing off across turns, record the observed result and the concrete next operation in nextAction, plus blockedBranch if applicable. Cite the exact field name and verified value for browser field changes so the runtime can associate the evidence with the observed edit. Use milestone for a verified change toward the outcome, such as resolving a named prerequisite or verifying a completed effect. Tool calls, searches, switching targets, and rewriting a status are activity. Before switching away from prepared work, inspect the precise obstacle, try a distinct feasible recovery, and keep the prepared state. Execute the next operation now when possible. Call relay_goal complete only when the entire objective is satisfied, with a substantive summary and evidence naming actual tests, artifacts, or observed results. A confident final paragraph or a partial step is not proof of completion. For a writing/reasoning deliverable, identify the completed result and its coverage. Completion is accepted only after this turn finishes successfully. Use wait only for an observed running job or real future retry time, with evidence; do independent useful work first. User messages take priority. Respect Pause, Stop and Clear.\n';
  }
  wrapTools(run, nodeId, handler) {
    return async (call, context) => {
      const recoveryRefusal = () => {
        if (call.name === GOAL_TOOL.name || !run.goal) return null;
        const rootId = rootOf(run);
        const receipts = this.conversations?.states?.[rootId]?.goalUnresolvedEffects || [];
        const permitsRetry = row => row.resolution?.outcome === 'not_occurred'
          || row.resolution?.outcome === 'unknown' && row.resolution?.deliberateRetry === true && row.resolution?.runId === run.id && !row.resolution?.retryUsedAt;
        const safe = new Set(receipts.filter(permitsRetry).map(row => row.signature));
        const blocking = receipts.filter(row => !permitsRetry(row));
        for (const row of blocking) safe.delete(row.signature);
        const history = [...blocking,
          ...(this.pendingUnresolvedEffects?.get(rootId) || []),
          ...(this.raw(rootId)?.lastToolEvidence || []).filter(row => !safe.has(row.signature)),
          ...(run.goalEvidence || []).filter(row => !safe.has(row.signature))];
        return detectUnknownEffectReplay(history, call)
          || detectNoProgressDispatchLoop(history, call, {
            after: browserProgressByRun.get(run)?.lastAdvanceAt || 0,
          });
      };
      const refusal = recoveryRefusal();
      if (refusal) return {success:false, code:refusal.code, actionDispatched:false,
          contentItems:[{type:'inputText',text:'GOAL RECOVERY: ' + refusal.guidance}]};
      const rootId = rootOf(run), signature = run.goal ? inFlightEffectSignature(call) : null;
      let reservations;
      if (signature) {
        this.inFlightGoalEffects ||= new Map();
        reservations = this.inFlightGoalEffects.get(rootId) || new Set();
        if (reservations.has(signature)) return {success:false,code:'GOAL_EFFECT_IN_FLIGHT',actionDispatched:false,contentItems:[{type:'inputText',text:'An identical action is still in flight. Wait for its result and inspect it before deciding what to do next.'}]};
        reservations.add(signature); this.inFlightGoalEffects.set(rootId,reservations);
      }
      try {
      let result;
      try {
        let deliberateRetry = false;
        if (signature) await this.enqueue(rootId, async () => {
          // Reconciliation may have been persisting when the optimistic check ran.
          // Recheck authoritative evidence in the same queue that consumes the permit.
          const refusal = recoveryRefusal();
          if (refusal) throw Object.assign(fail(refusal.guidance,refusal.code,409),{actionDispatched:false});
          const records=this.conversations.states[rootId]?.goalUnresolvedEffects || [];
          const approved=row=>row.signature===signature && row.resolution?.outcome==='unknown' && row.resolution?.deliberateRetry===true && row.resolution.runId===run.id && !row.resolution.retryUsedAt;
          if(records.some(approved)) {
            if (!this.recoveryRunCurrent(run)) throw Object.assign(fail('The recovery turn or goal changed. Inspect current state before continuing.','GOAL_CHANGED',409),{actionDispatched:false});
            deliberateRetry = true;
            const usedAt=timestamp();
            try { await this.conversations.changeState(rootId,{goalUnresolvedEffects:records.map(row=>approved(row)?{...row,resolution:{...row.resolution,retryUsedAt:usedAt},retryAttempts:[...(row.retryAttempts||[]),{runId:run.id,at:usedAt}]}:row)}); }
            catch(error) { throw Object.assign(error,{actionDispatched:false}); }
          }
        });
        if (deliberateRetry && !this.recoveryRunCurrent(run)) throw Object.assign(fail('The recovery turn or goal changed before dispatch.','GOAL_CHANGED',409),{actionDispatched:false});
        result = await handler(call, context);
      }
      catch (error) {
        if (!signature) throw error;
        result = {success:false,code:error?.code || 'GOAL_EFFECT_HANDLER_FAILED',
          ...(error?.actionDispatched === false ? {actionDispatched:false} : {}),
          contentItems:[{type:'inputText',text:String(error?.message || error)}]};
      }
      if (call.name !== GOAL_TOOL.name && run.goal) {
        let args; try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; } catch {}
        const excerpt = (result?.contentItems || []).filter(row => row.type === 'inputText').map(row => row.text).join('\n').slice(0, 1400);
        const observed = observeGoalToolOutcome(call, result);
        const earlier = run.goalEvidence || [];
        run.goalEvidence = [...earlier, {...observed, at: timestamp(), summary: excerpt}].slice(-16);
        if (observed.kind === 'uncertain_external_effect') {
          const rootId = rootOf(run);
          const receipt = {id:randomUUID(), tool: observed.tool, action: observed.action, kind: observed.kind,
            code: observed.code, signature: observed.signature, actionDispatched: observed.actionDispatched, at: timestamp(), runId:run.id,
            target: String(args?.url || args?.path || args?.tabId || args?.target || '').slice(0, 500)};
          this.pendingUnresolvedEffects ||= new Map();
          const pending = this.pendingUnresolvedEffects.get(rootId) || [];
          if (!pending.some(row => row.signature === receipt.signature)) pending.push(receipt);
          this.pendingUnresolvedEffects.set(rootId, pending);
          await this.enqueue(rootId, async () => {
            const saved = this.conversations.states[rootId]?.goalUnresolvedEffects || [];
            if (!saved.some(row => row.signature === receipt.signature && !row.resolution))
              await this.conversations.changeState(rootId, {goalUnresolvedEffects: [...saved, receipt]});
            this.pendingUnresolvedEffects.set(rootId, (this.pendingUnresolvedEffects.get(rootId) || []).filter(row => row.signature !== receipt.signature));
          });
        }
        if (call.name === 'relay_browser') observeGoalBrowserState(run, args, result);
        // Later operations invalidate a completion candidate based on earlier state.
        delete run.goalCompletion;
        if (call.name === 'relay_browser' && result?.success === true && ['open', 'navigate', 'search'].includes(args?.action)) {
          const switches = run.goalDestinationChanges = (run.goalDestinationChanges || 0) + 1;
          if (switches % 4 === 0) return {...result, contentItems: [...(result.contentItems || []), {
            type: 'inputText',
            text: 'Goal steering: Several destination changes produced no recorded milestone. Revisit the most advanced unfinished branch now. Identify the exact remaining prerequisite, try a different supported method, and verify the changed state before opening more destinations. Preserve uncertain external effects and reconcile them before retrying.',
          }]};
        }
        const previous = this.raw(rootOf(run))?.lastToolEvidence || [];
        const repeats = repeatedUnproductiveOperations([...previous, ...earlier], [observed]);
        const repeatGuidance = repeats.length && (earlier.length || this.raw(rootOf(run))?.noProgressTurns)
          ? 'The same operation returned the same unproductive result. Inspect what changed, choose a different supported operation or target condition, and do not claim progress from the repeated call.' : '';
        if (observed.guidance || repeatGuidance) return {...result, contentItems: [...(result.contentItems || []),
          {type: 'inputText', text: 'GOAL RECOVERY (' + observed.kind + '): ' + [observed.guidance, repeatGuidance].filter(Boolean).join(' ')}]};
      }
      return result;
      } finally {
        if (signature) { reservations.delete(signature); if (!reservations.size) this.inFlightGoalEffects.delete(rootId); }
      }
    };
  }
  async handle(run, nodeId, call) {
    const reply = value => ({success: true, contentItems: [{type: 'inputText', text: JSON.stringify(value)}]});
    try {
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || typeof args !== 'object' || !GOAL_TOOL.inputSchema.properties.action.enum.includes(args.action)) throw fail('Choose read, effects, reconcile, progress, complete, or wait.');
      const rootId = rootOf(run);
      if (args.action === 'read') return reply({goal: this.view(rootId)});
      if (args.action === 'effects') return reply({receipts:await this.effectReceipts(rootId)});
      if (args.action === 'reconcile') return reply(await this.resolveEffect(rootId,args,run));
      return await this.enqueue(rootId, async () => {
        const goal = this.boundGoal(run);
        if (!goal || args.goalId !== goal.id || !ENABLED.has(goal.status)) throw fail('This goal changed or was paused. Read its current state; an old turn cannot complete a new goal.', 'GOAL_CHANGED', 409);
        const summary = text(args.summary, 'Progress summary', 4000);
        const evidence = args.evidence === undefined ? '' : text(args.evidence, 'Goal evidence', 12000);
        if (['complete', 'wait'].includes(args.action) && evidence.length < 20) throw fail('Record concrete evidence naming the observed result, verification, or completed deliverable. A short completion label is insufficient.', 'GOAL_EVIDENCE_REQUIRED');
        const nextAction = args.nextAction === undefined ? null : text(args.nextAction, 'Next action', 2000);
        const blockedBranch = args.blockedBranch === undefined ? null : text(args.blockedBranch, 'Blocked branch', 2000);
        const milestone = args.milestone === undefined ? null : text(args.milestone, 'Milestone', 1000);
        if (milestone && !evidence) throw fail('A milestone requires evidence of the observed state change.');
        const observedKeys = new Set(goal.milestones || []);
        const observedMilestone = browserProgressByRun.get(run)?.advances.find(({key, name, value}) =>
          !observedKeys.has(key) && evidence.includes(name) && evidence.includes(value))?.key;
        const record = {summary, evidence, nextAction, blockedBranch, milestone, observedMilestone, runId: run.id, nodeId, at: timestamp()};
        if (args.action === 'complete') {
          run.goalCompletion = {...record, goalId: goal.id, generation: goal.generation, tools: clone(run.goalEvidence || [])};
          await this.engine.persist();
          await this.save(rootId, {...goal, lastReason: 'Completion evidence recorded; finishing this turn.'});
          return reply({accepted: true, completionPending: true, goal: this.view(rootId)});
        }
        let waitState = {};
        if (args.action === 'wait') {
          let waitUntil = null, waitForRunId = null;
          if (args.waitForRunId) {
            const waiting = this.engine.runs.get(args.waitForRunId);
            if (!waiting || waiting.id === run.id || waiting.settled === true || !ACTIVE_RUN.has(waiting.status)) throw fail('Wait requires an observed running execution other than this turn.');
            waitForRunId = waiting.id;
          } else {
            const due = Date.parse(args.waitUntil);
            if (!Number.isFinite(due) || due <= this.now()) throw fail('Use an actual future retry time or an observed running execution.');
            waitUntil = new Date(due).toISOString();
          }
          waitState = {status: 'waiting', waitUntil, waitForRunId};
        }
        // An invented or repeated text milestone never erases destination churn.
        if (observedMilestone && run.goalProgress?.observedMilestone !== observedMilestone) run.goalDestinationChanges = 0;
        run.goalProgress = record; delete run.goalCompletion;
        await this.save(rootId, {...goal, ...waitState, lastReason: summary, lastEvidence: record});
        return reply({goal: this.view(rootId), milestoneAssessment: milestone
          ? observedMilestone ? 'host_observed_intermediate' : 'agent_report_unverified'
          : 'none', note: 'A self-reported milestone is not proof of completion or a verified external effect.'});
      });
    } catch (error) {
      return {success: false, code: error.code || 'GOAL_INVALID', contentItems: [{type: 'inputText', text: error.message}]};
    }
  }
  async settled(rootId, run) {
    let goal = this.raw(rootId);
    if (goal?.status === 'paused' && goal.pauseRequest?.runId === run.id && run.settled === true && !goal.pauseRequest.settled) {
      await this.save(rootId, {...goal, pauseRequest: {...goal.pauseRequest, settled: true, settledAt: timestamp()}, lastSettledRunId: run.id});
      return;
    }
    if (!goal || !ENABLED.has(goal.status) || goal.lastSettledRunId === run.id || this.closed) return;
    // A superseded automatic turn never became currentRunId. Its settlement
    // must still wake the updated goal after the old admission releases the chat.
    if (run.errorCode === 'GOAL_DISPATCH_SUPERSEDED') { this.schedule(rootId); return; }
    if (goal.currentRunId && goal.currentRunId !== run.id) return;
    const binding = this.boundGoal(run);
    if (run.status === 'cancelled') {
      await this.save(rootId, {...goal, status: 'paused', generation: goal.generation + 1, dispatch: null, lastSettledRunId: run.id, lastReason: 'Stopped by you. Resume when you want to continue.'});
      return;
    }
    const candidate = run.goalCompletion;
    if (run.status === 'completed' && binding && candidate?.goalId === goal.id && candidate.generation === goal.generation) {
      await this.save(rootId, {...goal, status: 'completed', completedAt: timestamp(), lastSettledRunId: run.id, completionEvidence: candidate, lastReason: candidate.summary, dispatch: null});
      await this.cleanup(rootId);
      return;
    }
    goal = {...goal, currentRunId: run.id, lastSettledRunId: run.id, dispatch: null};
    if (run.status === 'failed') {
      const error = String(run.errorCode || run.error || 'Execution failed').slice(0, 2000);
      const failureKey = digest(error), repeatedFailures = goal.failureKey === failureKey ? (goal.repeatedFailures || 0) + 1 : 1;
      const blocked = repeatedFailures >= 3;
      goal = {...goal, failureKey, repeatedFailures, status: blocked ? 'blocked' : 'waiting',
        waitUntil: blocked ? null : new Date(this.now() + this.retryDelay * repeatedFailures).toISOString(), waitForRunId: null,
        lastReason: blocked ? `The same execution failure occurred ${repeatedFailures} times: ${error}. Saved work is preserved; Resume retries from the current state.` : `Retrying after an observed execution failure: ${error}`};
    } else {
      const milestones = goal.milestones || [];
      const report = run.goalProgress;
      const assessment = assessGoalProgress(goal, run);
      const milestone = assessment.observedMilestone;
      const progress = assessment.progress;
      const noProgressTurns = progress ? 0 : (goal.noProgressTurns || 0) + 1;
      // No immediate milestone is not a blocker when a different viable
      // operation is being tried. Stop a demonstrated repeat loop, or a
      // bounded series of alternatives that never changes the outcome.
      const repeating = assessment.repeated.length > 0 || assessment.repeatedNextAction;
      const stalled = binding && noProgressTurns >= 3
        && (repeating || !assessment.newAction || noProgressTurns >= 7);
      goal = {...goal, repeatedFailures: 0, failureKey: null, noProgressTurns,
        previousProgressEvidence: report?.evidence || goal.previousProgressEvidence,
        milestones: progress && milestone ? [...milestones, milestone].slice(-100) : milestones,
        lastMilestone: progress && milestone ? report : goal.lastMilestone,
        lastReportedMilestone: report?.milestone && report?.evidence && !report?.observedMilestone
          ? report : goal.lastReportedMilestone,
        lastProgressBasis: assessment.progressKind,
        previousNextAction: report?.nextAction || goal.previousNextAction || null,
        status: stalled ? 'blocked' : goal.status === 'waiting' ? 'waiting' : 'active',
        lastReason: stalled
          ? 'Automatic execution reached a demonstrated no-progress boundary. This is NOT proof the goal is impossible. Preserve the work and inspect the last failed or repeated action before resuming with a materially different approach.'
          : progress ? (report?.summary || 'A new stage was recorded; its evidence basis is ' + assessment.progressKind)
          : 'No new verified outcome this turn. ' + (repeating ? 'The same operation or next-action proposal repeated without a changed result. ' : '') + (report?.nextAction ? 'Candidate next action: ' + report.nextAction : 'Inspect the current branch and try a distinct viable action.')} ;
    }
    goal = {...goal, lastToolEvidence: (run.goalEvidence || []).map(({tool, action, kind, code, signature, scope, actionDispatched, resultDigest, success, at}) =>
      ({tool, action, kind, code, signature, scope, actionDispatched, resultDigest, success, at})).slice(-16)};
    await this.save(rootId, goal);
    if (ENABLED.has(goal.status)) this.schedule(rootId);
  }
  schedule(rootId, delay = this.delay) {
    if (!this.started || this.closed || this.engine.closed || this.userHolds.has(rootId) || this.errors.has(rootId) || this.timers.has(rootId) || !ENABLED.has(this.raw(rootId)?.status)) return;
    const timer = this.setTimer(() => {
      this.timers.delete(rootId);
      this.track(this.enqueue(rootId, () => this.dispatch(rootId)), rootId);
    }, Math.max(0, delay));
    timer?.unref?.(); this.timers.set(rootId, timer);
  }
  async dispatch(rootId, {execution = {}} = {}) {
    let goal = this.raw(rootId);
    if (!this.started || !goal || !ENABLED.has(goal.status) || this.userHolds.has(rootId) || this.closed || this.engine.closed) return null;
    const epoch = this.epochs.get(rootId) || 0;
    const family = await this.conversations.family(goal.currentRunId || rootId);
    goal = this.raw(rootId);
    if (!goal || !ENABLED.has(goal.status) || epoch !== (this.epochs.get(rootId) || 0) || this.closed) return null;
    if (family.state !== 'active') {
      await this.save(rootId, {...goal, status: 'paused', lastReason: 'This conversation is archived or deleted.'}); return null;
    }
    const latest = family.runs.at(-1);
    if (!latest) return null;
    if (this.engine.conversationBusy(latest) || latest.settled !== true) return null;
    if (goal.waitForRunId) {
      const waiting = this.engine.runs.get(goal.waitForRunId);
      if (waiting && (waiting.settled !== true || ACTIVE_RUN.has(waiting.status))) { this.schedule(rootId, 1000); return null; }
      // A lost handle after restart cannot establish completion of external work.
      if (!waiting) { await this.save(rootId, {...goal, status: 'interrupted', lastReason: 'The saved wait handle is unavailable. Resume checks the current operation before continuing.'}); return null; }
    }
    if (goal.waitUntil && Date.parse(goal.waitUntil) > this.now()) { this.schedule(rootId, Math.min(60000, Date.parse(goal.waitUntil) - this.now())); return null; }
    if (goal.maxTurns !== null && goal.turns >= goal.maxTurns || goal.maxMinutes !== null && this.now() - Date.parse(goal.activatedAt) >= goal.maxMinutes * 60000) {
      await this.save(rootId, {...goal, status: 'budget_exhausted', lastReason: 'The limit you set has been reached. Resume starts a fresh allowance; saved progress remains.'}); return null;
    }
    if (this.engine.executionStatus().availableSlots === 0) { this.schedule(rootId, 1000); return null; }
    const node = latest.workflow?.nodes.find(item => item.id === latest.workflow?.planning?.coordinatorNodeId && item.type === 'agent') || latest.workflow?.nodes.find(item => item.type === 'agent');
    if (!node) { await this.save(rootId, {...goal, status: 'blocked', lastReason: 'This conversation has no runnable agent.'}); return null; }
    if (!this.engine.runs.has(latest.id)) this.engine.restoreArchivedRun(latest);
    const prior = latest.nodes?.[node.id];
    const threadModel = prior?.threadId ? await this.engine.runtime.savedThreadModel?.(prior.threadId) : undefined;
    if (epoch !== (this.epochs.get(rootId) || 0) || this.closed) return null;
    const requestId = `goal_${digest([goal.id, goal.generation, latest.id]).slice(0, 48)}`;
    await this.save(rootId, {...goal, dispatch: {requestId, sourceRunId: latest.id, generation: goal.generation}});
    // Hold the conversation dispatch queue across this final read/start window.
    goal = this.raw(rootId);
    if (!goal || !ENABLED.has(goal.status) || epoch !== (this.epochs.get(rootId) || 0) || this.closed) return null;
    const checkpoint = goal.lastEvidence?.runId === latest.id ? goal.lastEvidence : null;
    const lastTool = latest.goalEvidence?.at(-1);
    const failure = [...(latest.goalEvidence || [])].reverse().find(row => row.success === false) || null;
    const repeating = repeatedUnproductiveOperations(goal.lastToolEvidence || [], latest.goalEvidence || []);
    const candidateNext = checkpoint?.nextAction || '';
    const unverified = goal.lastProgressBasis === 'unverified' && goal.noProgressTurns > 0;
    const message = ['Resume autonomous execution for the saved conversation goal:', goal.objective,
      'Preserve the full original scope and accepted user directions. Check saved results before retrying any uncertain operation; do not repeat completed effects.',
      goal.lastMilestone && goal.lastMilestone.runId !== checkpoint?.runId ? 'Most recent verified milestone: ' + goal.lastMilestone.summary + '. ' + goal.lastMilestone.evidence : '',
      goal.lastReportedMilestone && goal.lastReportedMilestone.runId !== checkpoint?.runId ? 'Most recent reported milestone (not independently verified): ' + goal.lastReportedMilestone.milestone + '. ' + goal.lastReportedMilestone.evidence : '',
      checkpoint?.summary ? 'Latest checkpoint: ' + checkpoint.summary : '',
      checkpoint?.evidence ? 'Recorded evidence: ' + checkpoint.evidence : '',
      checkpoint?.blockedBranch ? 'Deferred branch: ' + checkpoint.blockedBranch : '',
      goal.noProgressTurns ? 'Previous turn activity did NOT establish independently observed goal progress. Return to the most advanced unfinished branch, inspect the exact failure and its effect status, then execute a DIFFERENT feasible action rather than repeating a promise to continue. Preserve unknown effects, and record the new state. New searches and target changes are not outcomes.' : '',
      repeating.length ? 'Do not repeat this unchanged unproductive operation without new destination evidence or a changed precondition: ' + repeating.map(row => row.tool + ' ' + (row.action || '')).join('; ') : '',
      failure ? 'Last failed operation: ' + failure.tool + ' ' + (failure.action || '') + ' ' + (failure.code || '') + '. Classification: ' + (failure.kind || 'unknown') + '. ' + (failure.kind === 'uncertain_external_effect'
        ? 'An effect may already have occurred; reconcile current destination/receipt read-only before ANY retry, mark unresolved effects UNKNOWN, and work a distinct branch.'
        : failure.kind === 'recoverable_no_dispatch' ? 'Nothing was dispatched; use the recorded recovery observation or change the tool precondition/route.'
        : 'Check the failed capability and use a different supported evidence source or alternative route.') : '',
      unverified && candidateNext ? 'The previous next-action proposal has not yet proved progress. Check whether it was attempted and what changed; if unchanged, choose and actually execute an alternative rather than repeating: ' + candidateNext
        : candidateNext ? 'Execute the recorded next operation if it is still supported: ' + candidateNext
        : 'Choose and execute a concrete operation from current evidence. If a branch is blocked, recover it or work on an independent branch.',
      'Record new evidence and the next operation in relay_goal, or complete the objective with evidence.'].filter(Boolean).join('\n\n');
    const choices = Object.fromEntries(['model', 'effort', 'serviceTier', 'context', 'prompt', 'planningOntology', 'planningMode', 'planningExecutionMode', 'directoryMode', 'subagentsMode'].filter(key => execution[key] !== undefined).map(key => [key, execution[key]]));
    try {
      return this.engine.continueRun(latest.id, {nodeId: node.id, message, requestId, ...choices}, {historyRuns: family.runs, threadModel, goalDispatch: {goalId: goal.id, generation: goal.generation, epoch}});
    } catch (error) {
      await this.save(rootId, {...this.raw(rootId), dispatch: null, lastReason: error.message});
      if (error.code === 'CHAT_BUSY' || error.code === 'EXECUTION_CAPACITY') this.schedule(rootId, 1000);
      else await this.save(rootId, {...this.raw(rootId), status: 'blocked', lastReason: error.message});
      return null;
    }
  }
  async pauseAll(reason = 'Paused with Stop all.') {
    const roots = Object.entries(this.conversations.states).filter(([, row]) => row.goal && ENABLED.has(row.goal.status)).map(([id]) => id);
    for (const id of roots) this.invalidate(id);
    await Promise.all(roots.map(id => this.enqueue(id, async () => {
      const goal = this.raw(id); if (goal && ENABLED.has(goal.status)) await this.save(id, {...goal, status: 'paused', generation: goal.generation + 1, dispatch: null, lastReason: reason});
    })));
    return {paused: roots.length};
  }
  async cleanup(rootId) {
    const family = await this.conversations.family(rootId);
    if (family.runs.some(run => ACTIVE_RUN.has(run.status) || run.settled === false)) return;
    // A preserved page may still carry an earlier runId until next observed use.
    // Final cleanup must include those exact owners, not only the final turn.
    if (typeof this.engine.browser?.releaseOwner === 'function') {
      for (const run of family.runs) for (const node of run.workflow?.nodes || []) if (node.type === 'agent')
        await this.engine.browser.releaseOwner({taskId: rootId, runId: run.id, nodeId: node.id}, {status: 'completed'});
    }
    if (this.conversations.states[rootId]?.goalCleanupPending) await this.conversations.changeState(rootId, {goalCleanupPending: false});
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.engine.off('event', this.listener);
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    await Promise.allSettled([...this.chains.values(), ...this.pending]);
  }
}
