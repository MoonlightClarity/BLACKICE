import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const phases = ['proposed', 'queued', 'delivered', 'accepted', 'completed'];
const dispositions = ['approved', 'not_ready', 'blocked', 'out_of_scope', 'contradicted'];
const epistemics = ['observed', 'derived', 'inferred', 'unknown'];
const authorities = ['source', 'unit', 'integration', 'packaged', 'live_worker', 'external'];
const outcomes = ['pass', 'fail', 'unknown'];
const clone = value => structuredClone(value);
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const error = (message, code = 'SWARM_INVALID', status = 400, extra = {}) =>
  Object.assign(new Error(message), { code, status, ...extra });
const id = (value, label = 'ID') => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw error(label + ' must be a stable identifier.');
  return value;
};
const str = (value, label, max = 2000, required = true) => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (required && !value.trim()))
    throw error(label + ' must be ' + (required ? 'nonempty ' : '') + 'text under ' + max + ' characters.');
  return value.trim();
};
const fields = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
    throw error('Unsupported Swarm fields. Reload the current contract before editing.');
};
const choice = (value, list, label) => {
  if (!list.includes(value)) throw error(label + ' must be one of: ' + list.join(', ') + '.');
  return value;
};
const distinct = (values, label, limit = 100) => {
  if (!Array.isArray(values) || values.length > limit) throw error(label + ' must be a bounded list.');
  const result = values.map(value => id(value, label));
  if (new Set(result).size !== result.length) throw error(label + ' contains duplicates.');
  return result;
};
const exact = (actual, expected, label) => {
  if (!Number.isSafeInteger(expected) || actual !== expected)
    throw error(label + ' changed; refresh before editing.', 'SWARM_REVISION_CONFLICT', 409, { currentRevision: actual });
};
const actorStamp = value => {
  fields(value, ['kind', 'id', 'label']);
  return { kind: choice(value.kind, ['human', 'connector', 'native'], 'Actor kind'),
    id: id(value.id, 'Actor identity'), label: str(value.label, 'Actor label', 160) };
};
const isCoordinator = (project, actor) =>
  actor.kind === 'human' || project.coordinator.kind === actor.kind && project.coordinator.id === actor.id;
const coordinatorOnly = (project, actor) => {
  if (!isCoordinator(project, actor)) throw error('Only the recorded coordinator or local human can make this decision.', 'SWARM_COORDINATOR_REQUIRED', 403);
};
const ownerOrHuman = (project, item, actor, operation) => {
  if (actor.kind === 'human') return;
  const owner = project.workers.find(worker => worker.id === item.ownerId);
  if (!owner?.actorId || owner.actorId !== actor.id)
    throw error('Only the bound item owner or local human may ' + operation + '.', 'SWARM_OWNER_REQUIRED', 403);
};
const sourceApplicable = (project, evidence, item) => {
  const source = project.sources.find(value => value.id === evidence.sourceId);
  return Boolean(source && source.revision === evidence.sourceRevision && source.digest === evidence.sourceDigest
    && evidence.requirementRevision === item.requirementRevision);
};
function validateDependencies(project, itemId, dependencies) {
  for (const dep of dependencies) if (dep === itemId || !project.items.some(item => item.id === dep))
    throw error('Dependencies must refer to other work items in this project.');
  const lookup = new Map(project.items.map(item => [item.id, item.dependsOn]));
  lookup.set(itemId, dependencies);
  const visiting = new Set(), done = new Set();
  const visit = target => {
    if (visiting.has(target)) throw error('Swarm dependencies must be acyclic.');
    if (done.has(target)) return;
    visiting.add(target);
    for (const dep of lookup.get(target) || []) visit(dep);
    visiting.delete(target); done.add(target);
  };
  for (const target of lookup.keys()) visit(target);
}
const stamp = () => new Date().toISOString();
const sourceView = source => ({ ...clone(source), integrity: 'saved-content-sha256', originAuthenticated: false });
function itemView(project, item, cache = new Map()) {
  if (cache.has(item.id)) return cache.get(item.id);
  const history = project.evidence.filter(value => value.itemId === item.id);
  const current = history.filter(value => sourceApplicable(project, value, item));
  const stale = history.filter(value => !sourceApplicable(project, value, item));
  const resolved = new Set(project.resolutions.filter(r => r.requirementRevision === item.requirementRevision
    && current.some(ev => ev.id === r.replacementId && ev.outcome === 'pass')).map(r => r.evidenceId));
  const failures = current.filter(e => e.outcome === 'fail' && !resolved.has(e.id));
  // A completed dependency remains a blocker if its supporting claim subsequently goes stale.
  const dependencies = item.dependsOn.filter(dep => {
    const previous = project.items.find(other => other.id === dep);
    return !previous || !itemView(project, previous, cache).completionCurrent;
  });
  const coverage = current.some(ev => ev.outcome === 'pass' && ev.epistemic === 'observed'
    && ev.authority === item.verificationTarget);
  const decision = item.readyDecision?.requirementRevision === item.requirementRevision ? item.readyDecision : null;
  const decisionClaimsCurrent = decision?.disposition !== 'approved' || (decision.evidenceIds.length > 0
    && decision.evidenceIds.every(eid => current.some(e => e.id === eid && e.outcome === 'pass'))
    && decision.evidenceIds.some(eid => current.some(e => e.id === eid && e.outcome === 'pass'
      && e.epistemic === 'observed' && e.authority === item.verificationTarget)));
  const requested = item.readyRequest?.requirementRevision === item.requirementRevision;
  let readiness = 'not_ready';
  if (failures.length) readiness = 'contradicted';
  else if (history.length && !current.length) readiness = 'stale';
  else if (decision && !decisionClaimsCurrent) readiness = 'stale';
  else if (decision && decision.disposition !== 'approved') readiness = decision.disposition;
  else if (dependencies.length) readiness = 'not_ready';
  else if (decision?.disposition === 'approved') readiness = 'ready';
  else if (requested) readiness = 'ready_requested';
  const completionCurrent = item.phase === 'completed' && item.completionRequirementRevision === item.requirementRevision
    && item.integration?.status === 'recorded' && item.integration.requirementRevision === item.requirementRevision
    && item.integration.approvalId === item.readyDecision?.id && readiness === 'ready';
  const view = { ...clone(item), readiness, dependenciesWaiting: dependencies, proof: {
    requiredAuthority: item.verificationTarget, comparableObservedEvidence: coverage,
    assessment: coverage ? 'reported-comparable' : 'unverified',
    note: 'Source content is hashed locally; external origin, worker delivery and claimed observation are not independently authenticated.'
  }, applicableEvidence: current.map(clone), staleEvidence: stale.map(clone), unresolvedFailures: failures.map(e => e.id),
  completionCurrent };
  cache.set(item.id, view);
  return view;
}
function projectView(project) {
  const cache = new Map();
  const items = project.items.map(item => itemView(project, item, cache));
  return { ...clone(project), sources: project.sources.map(sourceView), items,
    summary: { total: project.items.length,
      phases: Object.fromEntries(phases.map(stage => [stage, project.items.filter(item => item.phase === stage).length])),
      ready: items.filter(item => item.readiness === 'ready').length,
      blocked: items.filter(item => ['blocked', 'contradicted', 'stale'].includes(item.readiness)).length } };
}
const initialState = () => ({ version: 1, revision: 0, projects: [], events: [], mutations: [], integrity: '' });

/** Separate Swarm coordination ledger; never executes a task, installs or approves a release.
 * Serialized copy-on-write plus entity CAS supports independent workers without silent lost updates.
 * The hash chain checks saved record integrity, not external evidence authenticity.
 */
export class SwarmBoardStore extends EventEmitter {
  constructor({ dataDir } = {}) {
    super();
    if (typeof dataDir !== 'string' || !dataDir) throw error('Swarm requires a data directory.');
    this.file = path.join(path.resolve(dataDir), 'swarm-board.json');
    this.state = initialState();
    this.tail = Promise.resolve();
    this.ready = null;
    this.closed = false;
  }
  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      try {
        const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
        this.assertIntegrity(data);
        this.state = data;
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw error('Swarm ledger could not be loaded; original evidence was preserved: ' + cause.message,
          'SWARM_STORAGE_INVALID', 500);
      }
      return this;
    })();
    return this.ready;
  }
  assertIntegrity(state) {
    if (!state || state.version !== 1 || !Array.isArray(state.projects) || !Array.isArray(state.events)
      || !Array.isArray(state.mutations) || !Number.isSafeInteger(state.revision)) throw error('Invalid Swarm schema.');
    const body = { ...state }; delete body.integrity;
    if (state.integrity !== sha(body)) throw error('Swarm saved snapshot integrity differs from its digest.');
    let prior = '';
    for (const event of state.events) {
      const body = { ...event }; delete body.hash;
      if (body.prevHash !== prior || event.hash !== sha(body)) throw error('Swarm history chain was altered.');
      prior = event.hash;
    }
  }
  snapshot(projectId = null) {
    if (projectId) return projectView(this.find(this.state, projectId));
    return { version: 1, revision: this.state.revision,
      projects: this.state.projects.map(projectView), eventCount: this.state.events.length,
      storage: { integrity: 'sha256-snapshot-and-event-chain', externalOriginAuthenticated: false } };
  }
  find(state, projectId) {
    const project = state.projects.find(p => p.id === id(projectId, 'Project ID'));
    if (!project) throw error('Swarm project not found.', 'SWARM_NOT_FOUND', 404);
    return project;
  }
  record(state, project, action, actor, detail) {
    const event = { sequence: state.events.length + 1, projectId: project.id, action, at: stamp(), actor: clone(actor),
      detail: clone(detail), prevHash: state.events.at(-1)?.hash || '' };
    event.hash = sha(event);
    state.events.push(event);
    project.updatedAt = event.at;
    project.revision++;
    return event;
  }
  async save(next) {
    const body = { ...next }; delete body.integrity;
    next.integrity = sha(body);
    const data = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw error('Swarm ledger capacity reached; history is not truncated.',
      'SWARM_CAPACITY', 413);
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(tmp, data, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(tmp, this.file);
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  }
  async close() { this.closed = true; await this.tail; }
  async apply(input, actorInput) {
    await this.init();
    const actor = actorStamp(actorInput);
    const request = clone(input);
    fields(request, ['mutationId', 'action', 'projectId', 'expectedProjectRevision',
      'expectedItemRevision', 'expectedSourceRevision', 'itemId', 'sourceId', 'workerId',
      'value', 'note', 'evidenceIds', 'reference', 'evidenceId', 'replacementId']);
    id(request.mutationId, 'Mutation ID');
    choice(request.action, ['create_project', 'edit_project', 'register_worker', 'propose_item',
      'edit_item', 'transition', 'record_source', 'record_evidence', 'resolve_failure',
      'request_ready', 'decide_ready', 'record_integration'], 'Swarm action');
    const key = actor.kind + ':' + actor.id + ':' + request.mutationId;
    const digest = sha(request);
    const update = async () => {
      if (this.closed) throw error('Swarm is closed.', 'SWARM_CLOSED', 503);
      const recorded = this.state.mutations.find(x => x.key === key);
      if (recorded) {
        if (recorded.digest !== digest) throw error('Mutation ID reused with different payload.', 'SWARM_MUTATION_CONFLICT', 409);
        return { duplicate: true, project: this.snapshot(recorded.projectId), eventSequence: recorded.eventSequence };
      }
      const state = clone(this.state), value = request.value || {};
      let project, item, source, detail = {};
      if (request.action === 'create_project') {
        fields(value, ['id', 'name', 'objective']);
        if (state.projects.length >= 60) throw error('Swarm project capacity reached.', 'SWARM_CAPACITY', 413);
        const projectId = id(value.id, 'Project ID');
        if (state.projects.some(p => p.id === projectId)) throw error('Project ID already exists.', 'SWARM_CONFLICT', 409);
        project = { id: projectId, name: str(value.name, 'Project name', 160),
          objective: str(value.objective, 'Project objective', 6000),
          coordinator: actor, revision: 0, workers: [], items: [], sources: [], evidence: [], resolutions: [],
          createdAt: stamp(), updatedAt: stamp() };
        state.projects.push(project);
        detail = { projectId };
      } else {
        project = this.find(state, request.projectId);
        if (request.action === 'edit_project') {
          coordinatorOnly(project, actor); exact(project.revision, request.expectedProjectRevision, 'Project revision');
          fields(value, ['name', 'objective']);
          if (value.name !== undefined) project.name = str(value.name, 'Project name', 160);
          if (value.objective !== undefined) project.objective = str(value.objective, 'Project objective', 6000);
          detail = { changes: Object.keys(value) };
        } else if (request.action === 'register_worker') {
          coordinatorOnly(project, actor); exact(project.revision, request.expectedProjectRevision, 'Project revision');
          fields(value, ['id', 'label', 'scope', 'kind', 'actorId']);
          const workerId = id(value.id, 'Worker ID');
          if (project.workers.some(w => w.id === workerId)) throw error('Worker already exists.', 'SWARM_CONFLICT', 409);
          if (project.workers.length >= 100) throw error('Worker capacity reached.', 'SWARM_CAPACITY', 413);
          project.workers.push({ id: workerId, label: str(value.label, 'Worker label', 160),
            scope: str(value.scope, 'Worker scope', 3000),
            kind: choice(value.kind || 'agent', ['human', 'agent'], 'Worker kind'),
            actorId: value.actorId === undefined ? null : id(value.actorId, 'Bound connector ID'),
            registeredBy: actor });
          detail = { workerId };
        } else if (request.action === 'propose_item') {
          exact(project.revision, request.expectedProjectRevision, 'Project revision');
          fields(value, ['id', 'title', 'scope', 'requirements', 'ownerId', 'dependsOn', 'verificationTarget']);
          const itemId = id(value.id, 'Item ID');
          if (project.items.some(w => w.id === itemId)) throw error('Work item already exists.', 'SWARM_CONFLICT', 409);
          if (project.items.length >= 200) throw error('Work item capacity reached.', 'SWARM_CAPACITY', 413);
          const deps = distinct(value.dependsOn || [], 'Dependencies');
          validateDependencies(project, itemId, deps);
          const ownerId = value.ownerId === null || value.ownerId === undefined ? null : id(value.ownerId, 'Worker ID');
          if (ownerId && !project.workers.some(w => w.id === ownerId)) throw error('Unknown worker owner.');
          item = { id: itemId, title: str(value.title, 'Work item title', 220),
            scope: str(value.scope, 'Work item scope', 3000),
            requirements: str(value.requirements, 'Work item requirements', 4000),
            ownerId, dependsOn: deps,
            verificationTarget: choice(value.verificationTarget || 'integration', authorities, 'Verification target'),
            phase: 'proposed', revision: 1, requirementRevision: 1,
            readyRequest: null, readyDecision: null, readinessHistory: [],
            integration: { status: 'not_started' }, integrationHistory: [],
            completionRequirementRevision: null, phaseHistory: [], requirementHistory: [] };
          project.items.push(item); detail = { itemId };
        } else if (request.action === 'record_source') {
          fields(value, ['id', 'text', 'reference']);
          const sourceId = id(value.id, 'Source ID');
          const content = str(value.text, 'Source text', 12000);
          if (project.sources.some(s => s.id === sourceId)) {
            source = project.sources.find(s => s.id === sourceId);
            exact(source.revision, request.expectedSourceRevision, 'Source revision');
            source.history ||= [];
            if (source.history.length >= 50) throw error('Source revision history capacity reached; old revisions were preserved.', 'SWARM_CAPACITY', 413);
            source.history.push({ revision: source.revision, text: source.text, digest: source.digest,
              reference: source.reference, supersededAt: stamp() });
            source.revision++;
            source.text = content; source.digest = sha(content);
            source.reference = str(value.reference || '', 'Source reference', 1000, false);
          } else {
            exact(project.revision, request.expectedProjectRevision, 'Project revision');
            if (project.sources.length >= 500) throw error('Source capacity reached.', 'SWARM_CAPACITY', 413);
            source = { id: sourceId, text: content, digest: sha(content),
              reference: str(value.reference || '', 'Source reference', 1000, false), revision: 1, history: [] };
            project.sources.push(source);
          }
          detail = { sourceId, sourceRevision: source.revision, digest: source.digest };
        } else {
          item = project.items.find(w => w.id === id(request.itemId, 'Work item ID'));
          if (!item) throw error('Work item not found.', 'SWARM_NOT_FOUND', 404);
          if (request.action !== 'record_evidence' && request.action !== 'resolve_failure')
            exact(item.revision, request.expectedItemRevision, 'Work item revision');
          if (request.action === 'edit_item') {
            coordinatorOnly(project, actor);
            fields(value, ['title', 'scope', 'requirements', 'ownerId', 'dependsOn', 'verificationTarget']);
            const previous = { revision: item.requirementRevision, scope: item.scope,
              requirements: item.requirements, ownerId: item.ownerId, dependsOn: [...item.dependsOn],
              verificationTarget: item.verificationTarget };
            if (value.title !== undefined) item.title = str(value.title, 'Work item title', 220);
            let changed = false;
            for (const field of ['scope', 'requirements']) if (value[field] !== undefined) {
              const next = str(value[field], field, field === 'scope' ? 3000 : 4000);
              if (next !== item[field]) { item[field] = next; changed = true; }
            }
            if (value.ownerId !== undefined) {
              const ownerId = value.ownerId === null ? null : id(value.ownerId, 'Worker ID');
              if (ownerId && !project.workers.some(w => w.id === ownerId)) throw error('Unknown worker owner.');
              if (ownerId !== item.ownerId) { item.ownerId = ownerId; changed = true; }
            }
            if (value.dependsOn !== undefined) {
              const deps = distinct(value.dependsOn, 'Dependencies');
              validateDependencies(project, item.id, deps);
              if (JSON.stringify(deps) !== JSON.stringify(item.dependsOn)) { item.dependsOn = deps; changed = true; }
            }
            if (value.verificationTarget !== undefined) {
              const target = choice(value.verificationTarget, authorities, 'Verification target');
              if (target !== item.verificationTarget) { item.verificationTarget = target; changed = true; }
            }
            if (changed) {
              item.requirementHistory ||= [];
              if (item.requirementHistory.length >= 50) throw error('Requirement history capacity reached; old revisions were preserved.', 'SWARM_CAPACITY', 413);
              item.requirementHistory.push({ ...previous, supersededAt: stamp() });
              item.requirementRevision++;
            }
            detail = { itemId: item.id, changes: Object.keys(value), requirementRevision: item.requirementRevision };
          } else if (request.action === 'transition') {
            fields(value, ['phase', 'reference', 'note']);
            const next = choice(value.phase, phases, 'Coordination phase');
            if (phases.indexOf(next) !== phases.indexOf(item.phase) + 1) throw error('Advance one explicit coordination phase at a time.');
            if (next === 'queued' || next === 'completed') coordinatorOnly(project, actor);
            if (next === 'delivered') {
              if (!value.reference) throw error('A delivery reference is required; this records a report, not proof of receipt.');
              ownerOrHuman(project, item, actor, 'report delivery');
            }
            if (next === 'accepted') {
              if (!project.workers.some(w => w.id === item.ownerId))
                throw error('An owner must be assigned before a worker accepts.');
              ownerOrHuman(project, item, actor, 'accept this assignment');
            }
            if (next === 'completed') {
              const view = itemView(project, item);
              if (view.readiness !== 'ready' || item.integration.status !== 'recorded' || item.integration.requirementRevision !== item.requirementRevision ||
                 item.integration.approvalId !== item.readyDecision?.id ||
                !view.applicableEvidence.some(ev => ev.outcome === 'pass'))
                throw error('Completion needs current approved readiness, a recorded integration and applicable passing evidence.');
              item.completionRequirementRevision = item.requirementRevision;
            }
            item.phase = next;
            item.phaseHistory.push({ phase: next, at: stamp(), actor, reference: value.reference || '',
              note: str(value.note || '', 'Transition note', 2000, false), requirementRevision: item.requirementRevision });
            detail = { itemId: item.id, phase: next, reportedReference: value.reference || null };
          } else if (request.action === 'record_evidence') {
            fields(value, ['id', 'claim', 'epistemic', 'authority', 'outcome', 'sourceId', 'sourceRevision',
              'requirementRevision', 'note']);
            const evidenceId = id(value.id, 'Evidence ID');
            if (project.evidence.some(e => e.id === evidenceId)) throw error('Evidence ID already exists.', 'SWARM_CONFLICT', 409);
            if (project.evidence.length >= 1600) throw error('Evidence capacity reached.', 'SWARM_CAPACITY', 413);
            exact(item.requirementRevision, value.requirementRevision, 'Requirement revision');
            source = project.sources.find(s => s.id === id(value.sourceId, 'Source ID'));
            if (!source) throw error('Source not found.', 'SWARM_NOT_FOUND', 404);
            exact(source.revision, value.sourceRevision, 'Source revision');
            project.evidence.push({ id: evidenceId, itemId: item.id, claim: str(value.claim, 'Evidence claim', 300),
              epistemic: choice(value.epistemic, epistemics, 'Epistemic status'),
              authority: choice(value.authority, authorities, 'Claimed authority'),
              outcome: choice(value.outcome, outcomes, 'Outcome'), sourceId: source.id,
              sourceRevision: source.revision, sourceDigest: source.digest,
              requirementRevision: item.requirementRevision, note: str(value.note || '', 'Evidence note', 2000, false),
              reportedBy: actor, at: stamp(), originAuthenticated: false });
            detail = { itemId: item.id, evidenceId, reportedOutcome: value.outcome };
          } else if (request.action === 'resolve_failure') {
            coordinatorOnly(project, actor);
            fields(value, ['evidenceId', 'replacementId', 'reason']);
            const prior = project.evidence.find(e => e.id === id(value.evidenceId, 'Evidence ID') && e.itemId === item.id);
            const replacement = project.evidence.find(e => e.id === id(value.replacementId, 'Replacement ID') && e.itemId === item.id);
            if (!prior || prior.outcome !== 'fail' || !replacement || replacement.outcome !== 'pass'
              || !sourceApplicable(project, replacement, item)) throw error('Resolve only a failed claim with applicable new passing evidence.');
            if (prior.claim !== replacement.claim) throw error('Replacement must address the same named claim.');
            if (project.evidence.indexOf(replacement) <= project.evidence.indexOf(prior)
              || replacement.epistemic !== 'observed' || replacement.authority !== prior.authority)
              throw error('Resolution needs later observed passing evidence of the same claimed authority, not an older or weaker claim.');
            if (project.resolutions.some(r => r.evidenceId === prior.id && r.requirementRevision === item.requirementRevision))
              throw error('Failure already has a resolution at this revision.', 'SWARM_CONFLICT', 409);
            project.resolutions.push({ evidenceId: prior.id, replacementId: replacement.id, reason: str(value.reason, 'Resolution rationale', 2000),
              requirementRevision: item.requirementRevision, actor, at: stamp() });
            detail = { itemId: item.id, failure: prior.id, replacement: replacement.id };
          } else if (request.action === 'request_ready') {
            fields(value, ['note']);
            ownerOrHuman(project, item, actor, 'request worker readiness');
            item.readyRequest = { requirementRevision: item.requirementRevision,
              note: str(value.note, 'Readiness request', 2000), actor, at: stamp() };
            item.readinessHistory ||= [];
            if (item.readinessHistory.length >= 200) throw error('Readiness history capacity reached; prior decisions were preserved.', 'SWARM_CAPACITY', 413);
            item.readinessHistory.push({ kind: 'request', ...clone(item.readyRequest) });
            detail = { itemId: item.id, requestedBy: actor.id };
          } else if (request.action === 'decide_ready') {
            coordinatorOnly(project, actor);
            fields(value, ['disposition', 'reason', 'evidenceIds']);
            const disposition = choice(value.disposition, dispositions, 'Readiness decision');
            const ids = distinct(value.evidenceIds || [], 'Evidence references', 100);
            const current = project.evidence.filter(ev => ev.itemId === item.id && sourceApplicable(project, ev, item));
            if (ids.some(eid => !current.some(ev => ev.id === eid))) throw error('Readiness decision evidence must apply to this exact requirement and source revision.');
            const view = itemView(project, item);
            if (disposition === 'approved' && (!item.readyRequest || item.readyRequest.requirementRevision !== item.requirementRevision
              || !ids.some(eid => current.some(ev => ev.id === eid && ev.outcome === 'pass'
                && ev.epistemic === 'observed' && ev.authority === item.verificationTarget))
              || ids.some(eid => !current.some(ev => ev.id === eid && ev.outcome === 'pass'))
              || view.unresolvedFailures.length || view.dependenciesWaiting.length))
              throw error('Approval needs a current worker-ready request, dependency closure, no unresolved failures and applicable observed evidence of the required authority.');
            item.readyDecision = { id: randomUUID(), disposition, reason: str(value.reason, 'Readiness rationale', 2000),
              evidenceIds: ids, requirementRevision: item.requirementRevision, at: stamp(), actor };
            item.readinessHistory ||= [];
            if (item.readinessHistory.length >= 200) throw error('Readiness history capacity reached; prior decisions were preserved.', 'SWARM_CAPACITY', 413);
            item.readinessHistory.push({ kind: 'decision', ...clone(item.readyDecision) });
            detail = { itemId: item.id, disposition, evidenceIds: ids };
          } else if (request.action === 'record_integration') {
            fields(value, ['status', 'reference', 'note']);
            const next = choice(value.status, ['proposed', 'recorded', 'rejected'], 'Integration disposition');
            if (next === 'recorded' || next === 'rejected') coordinatorOnly(project, actor);
            if (next === 'recorded' && itemView(project, item).readiness !== 'ready')
              throw error('Integration recording requires coordinator-approved current readiness.');
            if (next === 'recorded' && !value.reference) throw error('An exact integration reference is required.');
            item.integration = { status: next, reference: str(value.reference || '', 'Integration reference', 2000, false),
              note: str(value.note || '', 'Integration note', 2000, false),
              requirementRevision: item.requirementRevision,
               approvalId: next === 'recorded' ? item.readyDecision?.id || null : null,
               actor, at: stamp(), independentlyVerified: false };
            item.integrationHistory ||= [];
            if (item.integrationHistory.length >= 100) throw error('Integration history capacity reached; prior integration records were preserved.', 'SWARM_CAPACITY', 413);
            item.integrationHistory.push(clone(item.integration));
            detail = { itemId: item.id, status: next, reportedReference: value.reference || null };
          }
          if (request.action !== 'record_evidence' && request.action !== 'resolve_failure') item.revision++;
        }
      }
      if (state.events.length >= 5000 || state.mutations.length >= 5000)
        throw error('Swarm history capacity reached; no audit entries are silently removed.', 'SWARM_CAPACITY', 413);
      const event = this.record(state, project, request.action, actor, detail);
      state.mutations.push({ key, digest, projectId: project.id, eventSequence: event.sequence });
      state.revision++;
      await this.save(state);
      this.state = state;
      const result = { duplicate: false, eventSequence: event.sequence, project: projectView(project) };
      this.emit('updated', { projectId: project.id, revision: project.revision, action: request.action, eventSequence: event.sequence });
      return result;
    };
    const pending = this.tail.then(update);
    this.tail = pending.catch(() => {});
    return pending;
  }
}
