import {createHash, randomUUID} from 'node:crypto';

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
    action: {type: 'string', enum: ['read', 'progress', 'complete', 'wait']},
    goalId: {type: 'string', maxLength: 100},
    summary: {type: 'string', maxLength: 4000},
    evidence: {type: 'string', maxLength: 12000},
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
  retainsResources(run) {
    const goal = this.forRun(run);
    return Boolean(goal && goal.status !== 'completed');
  }
  instructions(run) {
    const goal = this.forRun(run); if (!goal || !ENABLED.has(goal.status)) return '';
    return '\n\nPERSISTENT CONVERSATION GOAL\n' + JSON.stringify({id: goal.id, objective: goal.objective, turns: goal.turns, maxTurns: goal.maxTurns, maxMinutes: goal.maxMinutes}) +
      '\nKeep working toward the entire objective in this same conversation. An ordinary final response is a progress checkpoint, not completion of the goal. Preserve the selected model, task, plan, prior evidence, browser pages, and accepted user directions. Resolve ordinary ambiguity with judgment; do not pause for optional questions, difficulty, or missing perfection. Before repeating an external action, inspect its saved result and current state. Do not repeat already completed effects.\n' +
      'Use relay_goal read for the current goal. Report concrete progress with summary and evidence when useful. Call relay_goal complete only when the entire objective is satisfied, with a substantive summary and evidence naming actual tests, artifacts, or observed results. A confident final paragraph or a partial step is not proof of completion. For a writing/reasoning deliverable, identify the completed result and its coverage. Completion is accepted only after this turn finishes successfully. Use wait only for an observed running job or real future retry time, with evidence; do independent useful work first. User messages take priority. Respect Pause, Stop and Clear.\n';
  }
  wrapTools(run, nodeId, handler) {
    return async (call, context) => {
      const result = await handler(call, context);
      if (call.name !== GOAL_TOOL.name && run.goal) {
        let args; try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; } catch {}
        const excerpt = (result?.contentItems || []).filter(row => row.type === 'inputText').map(row => row.text).join('\n').slice(0, 1400);
        run.goalEvidence = [...(run.goalEvidence || []), {tool: call.name, action: args?.action || null, success: result?.success !== false, at: timestamp(), summary: excerpt}].slice(-16);
        run.goalToolCount = (run.goalToolCount || 0) + 1;
        // Later operations invalidate a completion candidate based on earlier state.
        delete run.goalCompletion;
      }
      return result;
    };
  }
  async handle(run, nodeId, call) {
    const reply = value => ({success: true, contentItems: [{type: 'inputText', text: JSON.stringify(value)}]});
    try {
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || typeof args !== 'object' || !GOAL_TOOL.inputSchema.properties.action.enum.includes(args.action)) throw fail('Choose read, progress, complete, or wait.');
      const rootId = rootOf(run);
      if (args.action === 'read') return reply({goal: this.view(rootId)});
      return await this.enqueue(rootId, async () => {
        const goal = this.boundGoal(run);
        if (!goal || args.goalId !== goal.id || !ENABLED.has(goal.status)) throw fail('This goal changed or was paused. Read its current state; an old turn cannot complete a new goal.', 'GOAL_CHANGED', 409);
        const summary = text(args.summary, 'Progress summary', 4000);
        const evidence = args.evidence === undefined ? '' : text(args.evidence, 'Goal evidence', 12000);
        if (['complete', 'wait'].includes(args.action) && evidence.length < 20) throw fail('Record concrete evidence naming the observed result, verification, or completed deliverable. A short completion label is insufficient.', 'GOAL_EVIDENCE_REQUIRED');
        const record = {summary, evidence, runId: run.id, nodeId, at: timestamp()};
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
        run.goalProgress = record; delete run.goalCompletion;
        await this.save(rootId, {...goal, ...waitState, lastReason: summary, lastEvidence: record});
        return reply({goal: this.view(rootId)});
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
      const progress = Boolean(run.goalToolCount || run.goalProgress?.evidence);
      const noProgressTurns = progress ? 0 : (goal.noProgressTurns || 0) + 1;
      // Three actual empty goal turns are evidence of a stalled runtime, not
      // an inference that an ambiguous or difficult task should stop.
      const stalled = binding && noProgressTurns >= 3;
      goal = {...goal, repeatedFailures: 0, failureKey: null, noProgressTurns,
        status: stalled ? 'blocked' : goal.status === 'waiting' ? 'waiting' : 'active',
        lastReason: stalled ? 'Three consecutive turns produced no tool work or recorded progress. The goal is preserved; Resume after adjusting the model or objective.' : run.goalProgress?.summary || 'The goal is still open. Continuing with the next useful action.'};
    }
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
    const message = ['Continue working toward the saved conversation goal:', goal.objective,
      'Preserve the full original scope and accepted user directions. Check saved results before retrying any uncertain operation; do not repeat completed effects.',
      'Take the next useful action, then record progress or complete the goal with relay_goal and concrete evidence. An ordinary reply does not complete the goal.',
      goal.lastReason ? 'Latest checkpoint: ' + goal.lastReason : ''].filter(Boolean).join('\n\n');
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
