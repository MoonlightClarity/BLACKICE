import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { engineAtCapacity } from './inbox.mjs';
import { externalRetryHold as findExternalRetryHold } from './external-retry.mjs';
import { PROJECT_MANAGEMENT_FIELDS, projectManagement, projectStepMetadata, projectMethodReference, projectContext, projectMethodContext, projectSummary } from './project-management.mjs';

const copy = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'PROJECT_ERROR' });
const stamp = () => new Date().toISOString();
const projectStates = new Set(['draft', 'running', 'paused', 'completed', 'needs_attention']);
const taskStates = new Set(['pending', 'running', 'verifying', 'completed', 'blocked']);
const activePhase = phase => phase && ['dispatching', 'running'].includes(phase.status);
const text = (value, label, max, required = true) => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || required && !value.trim()) throw fail(`${label} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`);
  return value.trim();
};
const identifier = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw fail('Use a valid project or task identifier.'); return value; };
const repairs = value => { if (!Number.isInteger(value) || value < 0 || value > 3) throw fail('Choose zero to three repair attempts.'); return value; };
const sameFolder = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const clip = (value, max = 12000) => String(value || '').slice(0, max);
const reviewContext = (phase, criteria, available = 7000) => {
  const budget = Math.max(0, Math.min(7000, available));
  const report = phase.verdict || { status: phase.status, error: clip(phase.error, 1000), verdictError: clip(phase.verdictError, 1000), output: clip(phase.output, 4500) }, raw = JSON.stringify(report);
  if (raw.length <= budget) return raw;
  // Exact criterion text is already supplied in the task. Keep every failed
  // criterion identifiable instead of cutting off later failures in a long review.
  const failed = phase.verdict?.criteria?.filter(check => !check.passed) || [];
  let summaryLimit = 1000, evidenceLimit = Math.floor(4000 / Math.max(failed.length, 1));
  while (summaryLimit || evidenceLimit) {
    const compact = JSON.stringify({ runId: phase.runId, status: phase.status, summary: clip(phase.verdict?.summary, summaryLimit), failedCriteria: failed.map(check => ({ criterionNumber: criteria.indexOf(check.criterion) + 1, evidence: clip(check.evidence, evidenceLimit) })), ...(phase.error ? { error: clip(phase.error, summaryLimit) } : {}), ...(phase.verdictError ? { verdictError: clip(phase.verdictError, summaryLimit) } : {}), ...(!phase.verdict && phase.output ? { output: clip(phase.output, evidenceLimit) } : {}), note: 'Criterion numbers refer to the ordered acceptance criteria above. Full evidence remains in the prior review run.' });
    if (compact.length <= budget) return compact;
    summaryLimit = Math.floor(summaryLimit / 2); evidenceLimit = Math.floor(evidenceLimit / 2);
  }
  const minimal = JSON.stringify({ runId: phase.runId, status: phase.status, ...(phase.verdict ? { failedCriterionNumbers: failed.map(check => criteria.indexOf(check.criterion) + 1) } : { error: clip(phase.verdictError || phase.error || phase.output, 500) }) });
  if (minimal.length > budget) throw fail('Previous review evidence does not fit the execution input limit. Shorten the project definition before another attempt.');
  return minimal;
};
export const PROJECT_LIMITS = Object.freeze({ projects: 40, tasks: 100, criteria: 20, bytes: 24 * 1024 * 1024, attempts: 40, maxRepairs: 3 });
export const VERIFICATION_LIMITATION = 'Agent-reported verification of the listed criteria and evidence; this is not a guarantee of overall correctness.';

/** A verifier must account for every saved criterion. Never infer success from a turn ending. */
export function parseProjectVerdict(output, criteria) {
  let raw = String(output || '').trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(raw); if (fence) raw = fence[1];
  let value; try { value = JSON.parse(raw); } catch { throw fail('The verifier did not return a valid JSON verdict. Inspect its response before retrying.', 422); }
  if (!object(value) || typeof value.passed !== 'boolean' || !Array.isArray(value.criteria) || value.criteria.length !== criteria.length) throw fail('The verifier must report a verdict for every acceptance criterion.', 422);
  const summary = text(value.summary, 'Verification summary', 2000), seen = new Set();
  const checks = value.criteria.map(check => {
    if (!object(check) || typeof check.passed !== 'boolean') throw fail('Each verification criterion needs an explicit true or false verdict.', 422);
    const criterion = text(check.criterion, 'Verification criterion', 1000), evidence = text(check.evidence, 'Verification evidence', 3000);
    if (!criteria.includes(criterion) || seen.has(criterion)) throw fail('The verifier verdict must match each saved acceptance criterion exactly once.', 422);
    seen.add(criterion); return { criterion, passed: check.passed, evidence };
  });
  if (value.passed !== checks.every(check => check.passed)) throw fail('The verifier summary disagrees with its individual criterion verdicts.', 422);
  return { passed: value.passed, summary, criteria: criteria.map(criterion => checks.find(check => check.criterion === criterion)) };
}

/** Durable project DAGs and a bounded implement -> independent verifier -> repair loop. */
export class ProjectStore extends EventEmitter {
  constructor({ dataDir, engine, pollMs = 250, isPaused = () => false } = {}) {
    super();
    if (!dataDir || !engine?.startRun || !engine?.listRuns) throw fail('Projects require durable storage and an execution engine.');
    this.file = path.join(path.resolve(dataDir), 'projects.json'); this.engine = engine; this.pollMs = pollMs; this.isPaused = isPaused;
    this.state = { version: 1, projects: [] }; this.tail = Promise.resolve(); this.ready = null; this.initialized = false; this.closed = false; this.lastError = null; this.timer = null; this.recovered = false; this.pauseEpochs = new Map(); this.stopLatches = new Set();
    this.onEngine = event => { if (event.type === 'execution.settings' || event.type === 'run.updated' && event.data?.settled === true) this.kick(); };
  }
  init() { return this.ready ||= (async () => {
    await fs.mkdir(path.dirname(this.file), { recursive: true }); let loaded;
    const read = async file => { if ((await fs.stat(file)).size > PROJECT_LIMITS.bytes) throw fail('Project storage exceeds its limit.'); return this.validateState(JSON.parse(await fs.readFile(file, 'utf8'))); };
    try { loaded = await read(this.file); } catch (cause) {
      try { loaded = await read(`${this.file}.bak`); this.recovered = true; if (cause.code !== 'ENOENT') await fs.rename(this.file, `${this.file}.corrupt-${randomUUID()}`); }
      catch (backup) { if (cause.code !== 'ENOENT' || backup.code !== 'ENOENT') throw fail(`Cannot load projects: ${cause.message}. Existing files were preserved.`, 500); }
    }
    if (loaded) this.state = loaded;
    const next = copy(this.state);
    for (const project of next.projects) {
      let changed = this.reconcileProject(project, { restarting: true });
      if (project.status === 'running') { project.status = 'paused'; project.pauseReason = 'BLACKICE restarted. Inspect saved run receipts, then resume this project. Work is not replayed automatically.'; changed = true; }
      if (changed) this.touch(project);
    }
    await this.save(next); this.initialized = true; this.engine.on?.('event', this.onEngine); this.kick(); return this;
  })(); }
  validateState(value) {
    if (!object(value) || value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > PROJECT_LIMITS.projects) throw fail('Invalid project storage.');
    const ids = new Set();
    for (const project of value.projects) {
      identifier(project.id); if (ids.has(project.id) || !projectStates.has(project.status) || !Number.isSafeInteger(project.revision) || project.revision < 1) throw fail('Invalid saved project.'); ids.add(project.id);
      this.definition(project);
      for (const task of project.tasks) {
        if (!taskStates.has(task.status) || !Number.isInteger(task.round) || task.round < 0 || task.round > task.maxRepairs || !Array.isArray(task.attempts) || task.attempts.length > PROJECT_LIMITS.attempts) throw fail('Invalid saved project task.');
        for (const [index, attempt] of task.attempts.entries()) {
          if (attempt.mode !== undefined && attempt.mode !== 'review_only') throw fail('Invalid project attempt mode.');
          if (attempt.mode === 'review_only') {
            const source = task.attempts.find((item, sourceIndex) => sourceIndex < index && item.number === attempt.sourceAttempt);
            if (!source || source.mode === 'review_only' || source.implementation?.status !== 'completed' || !source.implementation.runId || JSON.stringify(source.implementation) !== JSON.stringify(attempt.implementation) || !attempt.verification || attempt.verification.requestId === attempt.implementation.requestId || task.attempts.slice(0, index).some(item => item.verification?.requestId === attempt.verification.requestId)) throw fail('A review-only attempt must retain its original completed implementation and use a separate new reviewer.');
          }
          for (const phase of [attempt.implementation, attempt.verification].filter(Boolean)) {
            identifier(phase.requestId); if (!['prepared', 'dispatching', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(phase.status) || phase.status === 'prepared' && (attempt.mode !== 'review_only' || phase !== attempt.verification) || !object(phase.request) || phase.request.requestId !== phase.requestId || phase.request.workflow?.id !== phase.requestId) throw fail('Invalid project execution receipt.');
          }
        }
        if (task.status === 'completed') {
          const attempt = task.attempts.at(-1), implementation = attempt?.implementation, review = attempt?.verification;
          if (implementation?.status !== 'completed' || review?.status !== 'completed' || !implementation.runId || !review.runId || implementation.runId === review.runId || implementation.requestId === review.requestId) throw fail('A saved completed task requires separate implementation and review receipts.');
          identifier(implementation.runId); identifier(review.runId);
          const verdict = parseProjectVerdict(JSON.stringify(review.verdict), task.acceptanceCriteria), verified = parseProjectVerdict(JSON.stringify(task.verification), task.acceptanceCriteria);
          if (!verdict.passed || JSON.stringify(verdict) !== JSON.stringify(verified) || task.verification.runId !== review.runId || task.verification.requestId !== review.requestId) throw fail('A saved completed task requires matching passing acceptance evidence.');
        }
      }
      if (project.status === 'completed' && project.tasks.some(task => task.status !== 'completed')) throw fail('A saved completed project contains unfinished tasks.');
    }
    return value;
  }
  definition(value) {
    if (!object(value)) throw fail('A project definition is required.');
    const cwd = text(value.cwd, 'Working folder', 32760); if (!path.isAbsolute(cwd)) throw fail('Choose an absolute working folder.');
    const definition = { name: text(value.name, 'Project name', 160), objective: text(value.objective, 'Project objective', 8000), cwd: path.resolve(cwd), model: text(value.model ?? 'default', 'Model', 400), verifierModel: text(value.verifierModel ?? value.model ?? 'default', 'Verifier model', 400), maxRepairs: repairs(value.maxRepairs ?? 2), context: projectContext(value.context), method: projectMethodReference(value.method) };
    definition.methodContext = projectMethodContext(value.methodContext, definition.context, definition.method);
    if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > PROJECT_LIMITS.tasks) throw fail('Give the project one to 100 tasks.');
    const ids = new Set(); definition.tasks = value.tasks.map((task, index) => {
      if (!object(task)) throw fail('A project task must be an object.');
      const id = identifier(task.id || `task-${index + 1}`); if (ids.has(id)) throw fail('Project task IDs must be unique.'); ids.add(id);
      if (!Array.isArray(task.acceptanceCriteria) || !task.acceptanceCriteria.length || task.acceptanceCriteria.length > PROJECT_LIMITS.criteria) throw fail('Each task needs one to 20 checkable acceptance criteria.');
      const acceptanceCriteria = task.acceptanceCriteria.map(item => text(item, 'Acceptance criterion', 1000)); if (new Set(acceptanceCriteria).size !== acceptanceCriteria.length) throw fail('Remove duplicate acceptance criteria.');
      const dependsOn = task.dependsOn ?? []; if (!Array.isArray(dependsOn) || dependsOn.some(item => typeof item !== 'string') || new Set(dependsOn).size !== dependsOn.length) throw fail('Task dependencies must be unique task IDs.');
      return { id, title: text(task.title, 'Task title', 300), instructions: text(task.instructions, 'Task instructions', 12000), acceptanceCriteria, dependsOn: [...dependsOn], model: text(task.model ?? definition.model, 'Task model', 400), verifierModel: text(task.verifierModel ?? definition.verifierModel, 'Verifier model', 400), maxRepairs: repairs(task.maxRepairs ?? definition.maxRepairs), ...projectStepMetadata(task) };
    });
    const seen = new Set(), visiting = new Set(), visit = id => {
      if (visiting.has(id)) throw fail('Project task dependencies must not contain a cycle.'); if (seen.has(id)) return; visiting.add(id);
      for (const dependency of definition.tasks.find(task => task.id === id).dependsOn) { if (!ids.has(dependency) || dependency === id) throw fail('Every dependency must refer to another task in this project.'); visit(dependency); }
      visiting.delete(id); seen.add(id);
    }; for (const id of ids) visit(id);
    return { ...definition, ...projectManagement(value, definition.tasks) };
  }
  assertOpen() { if (!this.initialized || this.closed) throw fail('Projects are not available while BLACKICE is starting or closing.', 503); }
  mutation(operation) { try { this.assertOpen(); } catch (cause) { return Promise.reject(cause); } const pending = this.tail.catch(() => {}).then(operation); this.tail = pending; return pending; }
  async save(next) {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const data = JSON.stringify(next); if (Buffer.byteLength(data) > PROJECT_LIMITS.bytes) throw fail('Project history is full. Existing receipts were preserved.', 507);
      try { const previous = await fs.readFile(this.file, 'utf8'); this.validateState(JSON.parse(previous)); await fs.writeFile(`${this.file}.bak`, previous, { mode: 0o600 }); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      const handle = await fs.open(temp, 'wx', 0o600); try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, this.file); this.state = next; this.lastError = null; this.emit('updated', this.status());
    } catch (cause) { this.lastError = cause.message; this.emit('updated', this.status()); throw cause; }
    finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }
  globalPauseReason() { const paused = this.isPaused(); return paused ? typeof paused === 'string' ? paused : 'Project execution is paused by the application.' : null; }
  status() { const projects = this.state.projects; return { count: projects.length, running: projects.filter(item => item.status === 'running').length, paused: projects.filter(item => item.status === 'paused').length, completed: projects.filter(item => item.status === 'completed').length, needsAttention: projects.filter(item => item.status === 'needs_attention').length, healthy: !this.lastError, error: this.lastError, blockedReason: this.globalPauseReason(), recovered: this.recovered }; }
  present(project) { const value = { ...copy(project), methodContext: project.methodContext ?? '', ...projectManagement(project, project.tasks) }; value.summary = projectSummary(value, { blockedReason: this.globalPauseReason() }); return value; }
  list({ cwd } = {}) { return this.state.projects.filter(project => !cwd || sameFolder(cwd, project.cwd)).map(project => this.present(project)); }
  get(id) { const project = this.state.projects.find(item => item.id === id); if (!project) throw fail('Project not found.', 404); return this.present(project); }
  snapshot(options = {}) { return { status: this.status(), projects: this.list(options) }; }
  find(next, id) { const project = next.projects.find(item => item.id === id); if (!project) throw fail('Project not found.', 404); return project; }
  touch(project) { project.revision++; project.updatedAt = stamp(); }
  create(value) { return this.mutation(async () => {
    if (this.state.projects.length >= PROJECT_LIMITS.projects) throw fail('Use at most 40 saved projects.', 507);
    const definition = this.definition(value); if (!(await fs.stat(definition.cwd)).isDirectory()) throw fail('Choose an existing working folder.');
    const project = { ...definition, id: randomUUID(), revision: 1, status: 'draft', pauseReason: null, createdAt: stamp(), updatedAt: stamp(), verificationLimitation: VERIFICATION_LIMITATION };
    project.tasks = definition.tasks.map(task => ({ ...task, status: 'pending', round: 0, cycle: 1, attempts: [], error: null }));
    const next = copy(this.state); next.projects.push(project); await this.save(next); return this.get(project.id);
  }); }
  update(id, value) { return this.mutation(async () => {
    const next = copy(this.state), project = this.find(next, id);
    if (!object(value) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) throw fail('Provide a positive expectedRevision from the saved project.', 409);
    if (value.expectedRevision !== project.revision) throw fail('This project changed. Reload its latest revision before saving.', 409);
    const metadataOnly = Object.keys(value).every(key => key === 'expectedRevision' || PROJECT_MANAGEMENT_FIELDS.includes(key));
    if (metadataOnly) {
      // Shared coordination remains editable while runs settle. It never changes
      // execution status, the accepted task graph, or any saved evidence.
      project.name = text(value.name ?? project.name, 'Project name', 160);
      Object.assign(project, projectManagement({ ...project, ...value }, project.tasks));
    } else {
      if (project.tasks.some(task => task.attempts.length)) throw fail('An executed project keeps its original criteria and task graph. Create a new project for a changed plan.', 409);
      if (!['draft', 'paused', 'needs_attention'].includes(project.status)) throw fail('Pause the project before editing it.', 409);
      const definition = this.definition({ ...project, ...value }); if (!(await fs.stat(definition.cwd)).isDirectory()) throw fail('Choose an existing working folder.');
      Object.assign(project, definition); project.tasks = definition.tasks.map(task => ({ ...task, status: 'pending', round: 0, cycle: 1, attempts: [], error: null }));
    }
    this.touch(project); await this.save(next); return this.get(id);
  }); }
  start(id) { const epoch = this.pauseEpochs.get(id) || 0; return this.mutation(async () => {
    const next = copy(this.state), project = this.find(next, id); if (project.status === 'completed') return this.get(id);
    if (project.status === 'needs_attention' && !this.readyTask(project)) throw fail('Retry a blocked task before resuming this project.', 409);
    project.status = 'running'; project.pauseReason = null; this.touch(project); await this.save(next); if (epoch === (this.pauseEpochs.get(id) || 0)) this.stopLatches.delete(id); this.kick(); return this.get(id);
  }); }
  pause(id, reason = 'Paused by you. Active work may finish; no new project phase will start.') {
    // Stop new admissions immediately, including a phase waiting for its durable intent write.
    try { this.assertOpen(); this.get(id); reason = text(reason, 'Pause reason', 1000); } catch (cause) { return Promise.reject(cause); }
    this.pauseEpochs.set(id, (this.pauseEpochs.get(id) || 0) + 1); this.stopLatches.add(id);
    return this.mutation(async () => {
    const next = copy(this.state), project = this.find(next, id); if (project.status === 'completed') return this.get(id);
    project.status = 'paused'; project.pauseReason = text(reason, 'Pause reason', 1000); this.touch(project); await this.save(next); return this.get(id);
  }); }
  retryTask(id, taskId) { return this.mutation(async () => {
    const next = copy(this.state), project = this.find(next, id), task = project.tasks.find(item => item.id === taskId); if (!task) throw fail('Project task not found.', 404);
    if (task.status !== 'blocked') throw fail('Only a blocked task can be explicitly retried.', 409);
    const runs = this.engine.listRuns(); this.assertAttemptsSettled(task, runs);
    const hold = this.externalRetryHold(task, runs);
    if (hold) {
      const before = JSON.stringify([task.retryHold, task.error]); this.blockExternalRetry(task, hold);
      if (before !== JSON.stringify([task.retryHold, task.error])) { this.touch(project); await this.save(next); }
      throw Object.assign(fail(task.error, 409), { code: hold.code, runId: hold.runId });
    }
    if (task.attempts.length >= PROJECT_LIMITS.attempts) throw fail('This task has reached its saved attempt limit. Create a new project to continue.', 507);
    task.status = 'pending'; task.error = null; task.round = 0; task.cycle++; project.status = 'paused'; project.pauseReason = 'The task is ready to retry. Resume the project when ready.';
    this.touch(project); await this.save(next); return this.get(id);
  }); }
  reviewTask(id, taskId) { return this.mutation(async () => {
    const next = copy(this.state), project = this.find(next, id), task = project.tasks.find(item => item.id === taskId); if (!task) throw fail('Project task not found.', 404);
    if (task.status !== 'blocked') throw fail('Only a blocked task can prepare a new independent review.', 409);
    const runs = this.engine.listRuns(); this.assertAttemptsSettled(task, runs);
    if (this.activeTask(project)) throw fail('Wait for the current project task to finish before preparing a review.', 409);
    if (!task.dependsOn.every(id => project.tasks.find(item => item.id === id)?.status === 'completed')) throw fail('The task prerequisites must have passing review before another review can be prepared.', 409);
    if (task.attempts.length >= PROJECT_LIMITS.attempts) throw fail('This task has reached its saved attempt limit. Create a new project to continue.', 507);
    const source = this.reviewSource(task), hold = this.externalRetryHold(task, runs); if (hold) task.retryHold = hold;
    task.cycle++; task.round = 0;
    const attempt = { number: task.attempts.length + 1, cycle: task.cycle, round: 0, mode: 'review_only', sourceAttempt: source.number, implementation: copy(source.implementation) };
    task.attempts.push(attempt); attempt.verification = this.intent(project, task, 'verification'); attempt.verification.status = 'prepared';
    task.status = 'verifying'; task.error = null; delete task.verification; delete task.completedAt;
    project.status = 'paused'; project.pauseReason = 'An independent review is prepared for the original implementation. Resume the project to review it without repeating implementation or delivery.';
    this.touch(project); await this.save(next); return this.get(id);
  }); }
  readyTask(project) { return project.tasks.find(task => task.status === 'pending' && task.dependsOn.every(id => project.tasks.find(item => item.id === id)?.status === 'completed')); }
  hasPendingWork() { return !this.closed && !this.globalPauseReason() && !this.lastError && this.state.projects.some(project => project.status === 'running' && !this.stopLatches.has(project.id) && (this.readyTask(project) || project.tasks.some(task => ['running', 'verifying'].includes(task.status)))); }
  kick(delay = 0) {
    if (this.closed || !this.initialized || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.poll().catch(() => {}).finally(() => { if (!this.closed && !this.lastError && this.state.projects.some(project => project.status === 'running')) this.kick(this.pollMs); }); }, delay); this.timer.unref?.();
  }
  activeTask(project) { return project.tasks.find(task => ['running', 'verifying'].includes(task.status)); }
  phaseOf(task) { const attempt = task.attempts.at(-1); return task.status === 'verifying' ? attempt?.verification : attempt?.implementation; }
  attemptRunIds(task, runs = this.engine.listRuns()) {
    const phases = task.attempts.flatMap(attempt => [attempt.implementation, attempt.verification].filter(Boolean)), requests = new Set(phases.map(phase => phase.requestId)), runIds = new Set(phases.map(phase => phase.runId).filter(Boolean));
    for (const run of runs) if (requests.has(run.metadata?.clientRequestId)) runIds.add(run.id);
    return [...runIds];
  }
  assertAttemptsSettled(task, runs = this.engine.listRuns()) {
    const runIds = new Set(this.attemptRunIds(task, runs)), active = runs.some(run => runIds.has(run.id) && (run.settled === false || ['queued', 'running', 'waiting'].includes(run.status))), leased = [...runIds].some(runId => this.engine.executions?.has?.(runId));
    if (active || leased) throw Object.assign(fail('An original implementation or review is still active or stopping. Wait for its actual run to settle before retrying this task.', 409), { code: 'PROJECT_ATTEMPT_ACTIVE' });
  }
  reviewSource(task) {
    for (const attempt of [...task.attempts].reverse()) {
      const phase = attempt.implementation; if (!phase) throw fail('No completed implementation receipt is available for independent review.', 409);
      const run = this.runFor(phase);
      // A hold can interrupt a saved repair before its admission. Only an
      // explicitly recorded non-admission permits returning to the earlier result.
      if (phase.notAdmitted === true && phase.status === 'interrupted' && !phase.runId && !run) continue;
      if (phase.status !== 'completed' || !phase.runId || !phase.requestId || phase.request?.requestId !== phase.requestId || phase.request?.workflow?.id !== phase.requestId || run && (run.id !== phase.runId || run.status !== 'completed')) throw fail('Independent review requires the most recent executed implementation to have a matching completed receipt. Inspect its original run first.', 409);
      identifier(phase.runId); identifier(phase.requestId);
      const source = attempt.mode === 'review_only' ? task.attempts.find(item => item.number === attempt.sourceAttempt && item.mode !== 'review_only') : attempt;
      if (!source || JSON.stringify(source.implementation) !== JSON.stringify(phase)) throw fail('The original implementation receipt does not match this review history.', 409);
      return source;
    }
    throw fail('No completed implementation receipt is available for independent review.', 409);
  }
  externalRetryHold(task, runs = this.engine.listRuns()) {
    return findExternalRetryHold({ existing: task.retryHold, runIds: this.attemptRunIds(task, runs), runs });
  }
  blockExternalRetry(task, hold, detail = '') { task.retryHold = hold; this.block(task, `${hold.message} Original run: ${hold.runId}.${detail ? ` ${clip(detail, 500)}` : ''}`); }
  runFor(phase) {
    const runs = this.engine.listRuns(), bound = phase.runId && runs.find(run => run.id === phase.runId);
    if (bound && bound.metadata?.clientRequestId !== phase.requestId) throw fail('The saved run belongs to a different project execution request. Inspect its evidence before retrying.', 409);
    const matches = runs.filter(run => run.metadata?.clientRequestId === phase.requestId);
    if (matches.length > 1) throw fail('More than one run matches this project receipt. Inspect the run history before retrying.', 409); return matches[0];
  }
  block(task, message) { task.status = 'blocked'; task.error = clip(message, 2000); }
  settleProject(project) {
    const status = project.status;
    if (!['draft', 'completed'].includes(status) && project.tasks.every(task => task.status === 'completed')) { project.status = 'completed'; project.finishedAt = stamp(); project.pauseReason = null; }
    else if (status === 'running' && !this.activeTask(project) && !this.readyTask(project)) { project.status = 'needs_attention'; project.pauseReason = 'A task is blocked. Review its verification evidence and retry it when ready; dependent tasks remain pending.'; }
    return project.status !== status;
  }
  reconcileProject(project, { restarting = false } = {}) {
    const runs = this.engine.listRuns(); let observed = false;
    // Retain the original task's ledger before its run can leave recent history.
    // A hold blocks a fresh implementation, while independent review may still
    // inspect a completed result without replaying the external action.
    for (const task of project.tasks) { const hold = this.externalRetryHold(task, runs); if (hold && !task.retryHold) { task.retryHold = hold; if (task.status === 'blocked') this.blockExternalRetry(task, hold, task.error); observed = true; } }
    const task = this.activeTask(project); if (!task) return this.settleProject(project) || observed;
    const phase = this.phaseOf(task); if (!phase || !activePhase(phase)) return observed;
    let run; try { run = this.runFor(phase); } catch (cause) { phase.status = 'interrupted'; phase.error = cause.message; task.retryHold ? this.blockExternalRetry(task, task.retryHold, cause.message) : this.block(task, cause.message); this.settleProject(project); return true; }
    if (!run) {
      if (!restarting && phase.status === 'dispatching') return observed;
      phase.status = 'interrupted'; phase.error = 'The saved project phase has no matching run receipt. Inspect the workspace before explicitly retrying.'; task.retryHold ? this.blockExternalRetry(task, task.retryHold, phase.error) : this.block(task, phase.error); this.settleProject(project); return true;
    }
    let changed = phase.runId !== run.id; phase.runId = run.id;
    if (run.settled === false || ['queued', 'running', 'waiting'].includes(run.status)) { if (phase.status !== 'running') changed = true; phase.status = 'running'; return changed || observed; }
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) return changed || observed;
    const rawOutput = String(run.nodes?.agent?.output ?? run.output ?? '');
    phase.status = run.status; phase.finishedAt = run.finishedAt || stamp(); phase.output = clip(rawOutput); phase.outputTruncated = rawOutput.length > phase.output.length; phase.error = run.error ? clip(run.error, 2000) : null;
    if (run.status !== 'completed') { const detail = `${task.status === 'verifying' ? 'Verification' : 'Implementation'} run ${run.status}: ${phase.error || 'Inspect the saved run before retrying.'}`; task.retryHold ? this.blockExternalRetry(task, task.retryHold, detail) : this.block(task, detail); }
    else if (task.status === 'running') {
      try { const verification = this.intent(project, task, 'verification'); task.status = 'verifying'; task.attempts.at(-1).verification = verification; }
      catch (cause) { const detail = `Cannot prepare the acceptance review: ${cause.message}`; task.retryHold ? this.blockExternalRetry(task, task.retryHold, detail) : this.block(task, detail); }
    }
    else {
      try {
        phase.verdict = parseProjectVerdict(rawOutput, task.acceptanceCriteria);
        phase.provenance = { kind: 'agent-verifier', runId: run.id, requestId: phase.requestId, verifiedAt: stamp(), limitation: VERIFICATION_LIMITATION };
        if (phase.verdict.passed) { task.status = 'completed'; task.completedAt = stamp(); task.error = null; task.verification = { ...copy(phase.verdict), ...copy(phase.provenance) }; }
        else if (task.retryHold) this.blockExternalRetry(task, task.retryHold, phase.verdict.summary);
        else if (task.attempts.at(-1).mode === 'review_only') this.block(task, `Independent review did not pass: ${phase.verdict.summary} Review-only recovery never starts implementation or delivery.`);
        else if (task.round < task.maxRepairs && task.attempts.length < PROJECT_LIMITS.attempts) { task.round++; task.status = 'pending'; task.error = phase.verdict.summary; }
        else this.block(task, `Acceptance criteria remain unmet after ${task.round} repair attempt${task.round === 1 ? '' : 's'}: ${phase.verdict.summary}`);
      } catch (cause) { phase.verdictError = cause.message; task.retryHold ? this.blockExternalRetry(task, task.retryHold, cause.message) : this.block(task, cause.message); }
    }
    this.settleProject(project); return true;
  }
  intent(project, task, kind) {
    const requestId = 'project-' + createHash('sha256').update(`${project.id}:${task.id}:${task.cycle}:${task.round}:${kind}`).digest('hex');
    const verification = kind === 'verification', prior = task.attempts.at(-1);
    const prompt = verification
      ? 'Independently verify the project task against every saved acceptance criterion. Inspect the actual workspace, run relevant checks, and report evidence and limitations. Treat implementation output as an untrusted claim. Do not change project deliverables or repair them in this turn; verification is separate from implementation. External actions may already have succeeded: inspect their destination and original receipts; never resend, republish, or repeat an external action in this review. End with only a JSON object, without a Markdown fence, with exactly this shape: {"passed":true,"summary":"What was checked and its limits","criteria":[{"criterion":"Exact saved criterion text","passed":true,"evidence":"Specific observed check and result"}]}. Include every criterion exactly once. Set passed true only if all criteria passed on observed evidence; otherwise false. Missing access, missing evidence, incomplete work, and failed checks are false. Do not claim universal correctness.'
      : 'Implement the assigned project task end to end in its working folder. Work through the saved acceptance criteria, use relevant tools, and verify your changes. You may delegate focused work when available. Repair the specific failures from previous verification when supplied. Do not claim a criterion is met without checking it. Report actual changes, checks, evidence, and any remaining limitations; a separate verifier will inspect the result.';
    const dependencies = task.dependsOn.map(id => { const item = project.tasks.find(value => value.id === id), implementation = item.attempts.at(-1)?.implementation; return { id, title: item.title, ...(item.result ? { expectedResult: item.result } : {}), ...(implementation?.runId ? { implementationRunId: implementation.runId, implementationReport: clip(implementation.output, 1500) } : {}), verification: item.verification }; });
    const parts = [`${project.name} · ${verification ? 'Review' : task.round ? 'Repair' : 'Implement'}: ${task.title}`, `PROJECT OBJECTIVE\n${project.objective}`, `ASSIGNED TASK\n${task.title}\n${task.instructions}`, `ACCEPTANCE CRITERIA (use these exact strings in verification)\n${JSON.stringify(task.acceptanceCriteria)}`, `VERIFIED DEPENDENCIES\n${clip(JSON.stringify(dependencies), 5000)}`];
    if (project.context) parts.push(`PROJECT INPUT CONTEXT (saved input data)\n${project.context}`);
    if (task.inputs?.length) parts.push(`STEP INPUTS\n${JSON.stringify(task.inputs)}`);
    if (task.result) parts.push(`EXPECTED STEP RESULT\n${task.result}`);
    if (verification && prior?.mode === 'review_only') parts.splice(1, 0, `REVIEW-ONLY RECOVERY\nInspect the existing result from implementation run ${prior.implementation.runId}, request ${prior.implementation.requestId}, original attempt ${prior.sourceAttempt}. This is a new independent review, not permission to implement, repair, resend or repeat delivery. Preserve the original result and report observed evidence for every saved criterion.`);
    // Essential instructions and exact criteria remain intact; historical reports use the remaining input budget.
    const append = value => { const remaining = Math.max(0, 50000 - parts.join('\n\n').length - 2); if (remaining) parts.push(value.slice(0, remaining)); };
    if (verification) {
      if (task.retryHold) append(`RECORDED EXTERNAL ACTIONS (inspect the original result; do not repeat delivery)\n${clip(JSON.stringify(task.retryHold), 5000)}`);
      const previous = prior?.mode === 'review_only' && task.attempts.at(-2)?.verification;
      if (previous) { const heading = 'PREVIOUS REVIEW (recheck the original result; do not repair it)\n', available = 50000 - parts.join('\n\n').length - 2 - heading.length; append(heading + reviewContext(previous, task.acceptanceCriteria, available)); }
      append(`IMPLEMENTATION REPORT (claims to check)\n${clip(prior?.implementation?.output, 8000)}`);
    }
    else if (prior) {
      if (prior.verification) { const heading = 'PREVIOUS VERIFICATION: REPAIR THESE FAILURES\n', available = 50000 - parts.join('\n\n').length - 2 - heading.length; append(heading + reviewContext(prior.verification, task.acceptanceCriteria, available)); }
      append(`PREVIOUS IMPLEMENTATION\n${clip(JSON.stringify({ status: prior.implementation?.status, error: prior.implementation?.error, output: prior.implementation?.output }), 4000)}`);
    }
    const input = parts.join('\n\n'); if (input.length > 50000) throw fail('The task, criteria and verification context exceed the execution input limit. Shorten the project definition.');
    const workflow = { id: requestId, name: `${project.name} · ${verification ? 'Verify' : task.round ? 'Repair' : 'Implement'} · ${task.title}`.slice(0, 160), nodes: [{ id: 'input', type: 'input', name: 'Project task' }, { id: 'agent', type: 'agent', name: verification ? 'Independent verifier' : 'Project implementer', model: verification ? task.verifierModel : task.model, prompt }, { id: 'output', type: 'output', name: verification ? 'Verification verdict' : 'Implementation report' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { cwd: project.cwd, maxParallel: 1 } };
    return { requestId, status: 'dispatching', runId: null, createdAt: stamp(), request: { requestId, workflow, input: { task: input, cwd: project.cwd } } };
  }
  poll() { return this.mutation(async () => {
    let next = copy(this.state), changed = false;
    for (const project of next.projects) if (this.reconcileProject(project)) { this.touch(project); changed = true; }
    if (changed) await this.save(next);
    if (this.globalPauseReason() || this.lastError || this.engine.closed) return this.snapshot();
    for (const current of this.state.projects.filter(project => project.status === 'running')) {
      if (this.closed || this.globalPauseReason()) break;
      if (this.stopLatches.has(current.id)) continue;
      if (engineAtCapacity(this.engine)) break;
      next = copy(this.state); let project = this.find(next, current.id), task = this.activeTask(project);
      if (!task) {
        task = this.readyTask(project); if (!task) { this.settleProject(project); this.touch(project); await this.save(next); continue; }
        const hold = this.externalRetryHold(task); if (hold) { this.blockExternalRetry(task, hold); this.settleProject(project); this.touch(project); await this.save(next); continue; }
        if (task.attempts.length >= PROJECT_LIMITS.attempts) { this.block(task, 'The saved attempt limit was reached.'); this.settleProject(project); this.touch(project); await this.save(next); continue; }
        let implementation;
        try { implementation = this.intent(project, task, 'implementation'); }
        catch (cause) { this.block(task, `Cannot prepare the task: ${cause.message}`); this.settleProject(project); this.touch(project); await this.save(next); continue; }
        task.status = 'running'; task.attempts.push({ number: task.attempts.length + 1, cycle: task.cycle, round: task.round, implementation }); this.touch(project); await this.save(next);
      }
      next = copy(this.state); project = this.find(next, current.id); task = this.activeTask(project); if (!task) continue;
      let phase = this.phaseOf(task);
      if (task.status === 'verifying' && task.attempts.at(-1).mode === 'review_only' && ['prepared', 'dispatching'].includes(phase?.status)) {
        try { if (!this.runFor(phase)) { this.assertAttemptsSettled(task); this.reviewSource(task); } }
        catch (cause) {
          if (cause.code === 'PROJECT_ATTEMPT_ACTIVE') { project.status = 'paused'; project.pauseReason = cause.message; }
          else { phase.status = 'interrupted'; phase.error = cause.message; task.retryHold ? this.blockExternalRetry(task, task.retryHold, cause.message) : this.block(task, cause.message); this.settleProject(project); }
          this.touch(project); await this.save(next); continue;
        }
      }
      if (phase?.status === 'prepared' && task.status === 'verifying' && task.attempts.at(-1).mode === 'review_only') {
        if (this.closed || this.stopLatches.has(project.id) || this.globalPauseReason()) continue;
        phase.status = 'dispatching'; this.touch(project); await this.save(next);
        next = copy(this.state); project = this.find(next, current.id); task = this.activeTask(project); phase = task && this.phaseOf(task);
      }
      if (!phase || phase.status !== 'dispatching') continue;
      if (this.closed || this.stopLatches.has(project.id) || this.globalPauseReason()) continue;
      if (task.status === 'running') {
        let admitted, receiptError; try { admitted = this.runFor(phase); } catch (cause) { receiptError = cause.message; }
        if (receiptError) { phase.status = 'interrupted'; phase.error = receiptError; const hold = this.externalRetryHold(task); hold ? this.blockExternalRetry(task, hold, receiptError) : this.block(task, receiptError); this.settleProject(project); this.touch(project); await this.save(next); continue; }
        if (admitted) {
          // An acknowledgement or bind can be lost after actual admission.
          // Follow that exact run; a later hold must not replace its receipts
          // with a fresh execution or prevent independent review of its result.
          if (this.reconcileProject(project)) { this.touch(project); await this.save(next); }
          task = this.activeTask(project); if (task?.status !== 'verifying') continue;
          phase = this.phaseOf(task); if (!phase || phase.status !== 'dispatching') continue;
        } else {
          const hold = this.externalRetryHold(task);
          if (hold) { phase.status = 'interrupted'; phase.notAdmitted = true; phase.error = hold.message; phase.finishedAt = stamp(); this.blockExternalRetry(task, hold); this.settleProject(project); this.touch(project); await this.save(next); continue; }
        }
      }
      if (this.closed || this.stopLatches.has(project.id) || this.globalPauseReason()) continue;
      // Preparing the dispatch is a durable write. Recheck after that await so
      // a newly acquired original lease cannot overlap this separate reviewer.
      if (task.status === 'verifying' && task.attempts.at(-1).mode === 'review_only') {
        try { if (!this.runFor(phase)) { this.assertAttemptsSettled(task); this.reviewSource(task); } }
        catch (cause) {
          if (cause.code === 'PROJECT_ATTEMPT_ACTIVE') { phase.status = 'prepared'; project.status = 'paused'; project.pauseReason = cause.message; }
          else { phase.status = 'interrupted'; phase.error = cause.message; task.retryHold ? this.blockExternalRetry(task, task.retryHold, cause.message) : this.block(task, cause.message); this.settleProject(project); }
          this.touch(project); await this.save(next); continue;
        }
      }
      // The intent is already durable. Engine request IDs recover admission if its acknowledgement or our bind write fails.
      try {
        const run = await this.engine.startRun(copy(phase.request)); next = copy(this.state); const live = this.find(next, project.id), liveTask = live.tasks.find(item => item.id === task.id), livePhase = this.phaseOf(liveTask);
        livePhase.runId = run.id; livePhase.status = 'running'; this.touch(live); await this.save(next);
      } catch (cause) {
        const saved = this.find(this.state, project.id), savedTask = saved.tasks.find(item => item.id === task.id), savedPhase = this.phaseOf(savedTask); let admitted;
        try { admitted = this.runFor(savedPhase); } catch { /* The persisted intent remains authoritative for inspection. */ }
        if (admitted) { next = copy(this.state); const live = this.find(next, project.id), livePhase = this.phaseOf(live.tasks.find(item => item.id === task.id)); livePhase.runId = admitted.id; livePhase.status = 'running'; this.touch(live); await this.save(next); }
        else if (cause.status === 409 && engineAtCapacity(this.engine)) continue;
        else { next = copy(this.state); const live = this.find(next, project.id), liveTask = live.tasks.find(item => item.id === task.id), livePhase = this.phaseOf(liveTask); livePhase.status = 'failed'; livePhase.error = clip(cause.message, 2000); this.block(liveTask, cause.message); this.settleProject(live); this.touch(live); await this.save(next); }
      }
    }
    return this.snapshot();
  }); }
  close() { if (this.closePromise) return this.closePromise; this.closed = true; clearTimeout(this.timer); this.timer = null; this.engine.off?.('event', this.onEngine); return this.closePromise = (async () => { await this.tail.catch(() => {}); if (this.lastError) throw fail(`Projects could not finish saving: ${this.lastError}`, 500); })(); }
}
