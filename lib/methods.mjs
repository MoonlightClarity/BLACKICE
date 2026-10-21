import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BUILTIN_METHODS, BUILTIN_TASK_TYPES, BUILTIN_STEP_TYPES, METHOD_LIMITS, methodId, methodText, validateMethod, validateMethodOutline, methodStepsFromOutline, normalizeMethodSteps, validateMethodActionAlignment } from './process-ontology.mjs';
import { createMethodSearchIndex, validateMethodCatalog } from './method-catalog.mjs';

const copy = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'METHOD_ERROR' });
const now = () => new Date().toISOString();
const definitionFields = ['name', 'description', 'taskType', 'inputs', 'steps', 'outline', 'catalog'];
const fields = (value, allowed) => {
  if (!object(value)) throw fail('Provide an object with the requested method fields.');
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw fail(`Unsupported method field: ${unknown[0]}.`);
};
const revision = (expected, current) => {
  if (!Number.isSafeInteger(expected) || expected < 1) throw fail('Provide a positive expectedRevision from the saved record.');
  if (expected !== current) throw fail('This record changed. Reload its latest revision before saving.', 409);
};
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const taskMethodOptions = (value = {}) => {
  fields(value, ['name', 'description', 'catalog', 'methodSteps']);
  return { name: methodText(value.name ?? 'Reusable task method', 'Method name', 160), description: methodText(value.description ?? 'Reusable structure from a task outline. Review task-specific step text and adapt branches, inputs and checks for each new request.', 'Method description', 2000, false), ...(value.catalog === undefined ? {} : { catalog: validateMethodCatalog(value.catalog) }), ...(value.methodSteps === undefined ? {} : { methodSteps: normalizeMethodSteps(value.methodSteps, { branched: true }) }) };
};
const sourceIdentity = (taskId, revision) => {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(taskId) || !Number.isSafeInteger(revision) || revision < 1) throw fail('Saving a task method requires its saved task ID and positive revision.');
  return { taskId, revision };
};
const validateSourceTask = value => {
  fields(value, ['taskId', 'revision', 'fingerprint', 'requestFingerprint', 'outlineFingerprint']);
  sourceIdentity(value.taskId, value.revision);
  for (const key of ['fingerprint', 'requestFingerprint']) if (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key])) throw fail('Invalid saved task-method receipt.');
  if (value.outlineFingerprint !== undefined && (typeof value.outlineFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.outlineFingerprint))) throw fail('Invalid saved task-method outline receipt.');
};
const check = signal => { if (signal?.aborted) throw Object.assign(new Error('Task stopped before saving the method.'), { name: 'AbortError', code: 'METHOD_SAVE_ABORTED', status: 409 }); };
const savedTaskMethod = (state, source, names) => {
  const requestFingerprint = fingerprint(names);
  const method = state.methods.find(item => item.sourceTask?.taskId === source.taskId && item.sourceTask.revision === source.revision && item.sourceTask.requestFingerprint === requestFingerprint);
  return method ? { method: copy(method), created: false, sourceTask: copy(method.sourceTask) } : null;
};

/** Prepare a reviewable blueprint without task inputs or execution results. */
export function taskPlanMethodDraft(state, options = {}, { sourceMethod } = {}) {
  const { methodSteps, ...names } = taskMethodOptions(options);
  if (!object(state) || !Array.isArray(state.steps) || !state.steps.length) throw Object.assign(fail('The task has no saved action steps yet. Record its plan before saving a reusable method.', 409), { code: 'METHOD_OUTLINE_UNAVAILABLE' });
  const stableFields = ['id', 'title', 'parentId', 'kind', 'dependsOn', 'condition', 'stepType', 'result', 'doneWhen'];
  const nodes = state.steps.map(step => {
    if (!object(step)) throw fail('The saved task contains an invalid plan node.');
    const node = Object.fromEntries(stableFields.filter(key => Object.hasOwn(step, key)).map(key => [key, copy(step[key])]));
    // Old flat plans did not require acceptance criteria. This is a draft
    // criterion to adapt, never evidence that the old task was checked.
    const legacyCriteria = state.planVersion !== 1 || Array.isArray(state.plan?.legacyCriteriaIds) && state.plan.legacyCriteriaIds.includes(node.id);
    if ((!node.kind || node.kind === 'action') && node.doneWhen === undefined && legacyCriteria) node.doneWhen = `Draft criterion: the result of “${methodText(node.title, 'Step title', 300)}” is available and checked against the new request.`;
    return node;
  });
  const outline = validateMethodOutline({ layout: state.plan?.layout ?? 'sequence', steps: nodes });
  let steps = methodSteps ?? methodStepsFromOutline(outline);
  // A saved reference is useful only for its exact revision. Keep the deep
  // action definition when its source row still matches; changed/composed
  // actions require explicit authored methodSteps instead of stale prompts.
  if (!methodSteps && sourceMethod && sourceMethod.id === state.plan?.method?.id && sourceMethod.revision === state.plan.method.revision) {
    const actions = outline.steps.filter(step => step.kind === 'action'), sourceActions = sourceMethod.outline?.steps.filter(step => step.kind === 'action') ?? sourceMethod.steps;
    const alignedOrder = actions.length === sourceActions.length && actions.every((action, index) => action.id === sourceActions[index].id);
    if (alignedOrder) steps = steps.map((draft, index) => {
      const action = actions[index], definition = sourceMethod.steps.find(step => step.id === action.id), source = sourceActions[index];
      const sourceType = sourceMethod.outline ? source.stepType : definition?.type, sourceResult = sourceMethod.outline ? source.result : definition?.result;
      if (!definition || action.title !== definition.title || action.stepType !== sourceType || action.result !== sourceResult || !definition.checks.includes(action.doneWhen)) return draft;
      const sameStructure = sourceMethod.outline
        ? outline.layout === sourceMethod.outline.layout && (action.parentId ?? null) === (source.parentId ?? null) && JSON.stringify(action.dependsOn ?? []) === JSON.stringify(source.dependsOn ?? []) && action.condition === source.condition && action.doneWhen === source.doneWhen
        : outline.layout === 'sequence' && !action.parentId && !(action.dependsOn?.length) && action.condition === undefined;
      return sameStructure ? copy(definition) : draft;
    });
  }
  validateMethodActionAlignment(outline, steps);
  return { ...names, taskType: methodId(state.plan?.taskType ?? 'general', 'Task type'), inputs: [], steps, outline };
}

/** A reusable authoring library. Only ProjectStore owns execution and evidence. */
export class MethodStore extends EventEmitter {
  constructor({ dataDir, projects } = {}) {
    super(); if (!dataDir || !projects?.definition || !projects?.create) throw Error('Methods require local storage and the project store.');
    this.file = path.join(dataDir, 'methods.json'); this.projects = projects;
    this.state = { version: 1, methods: [], types: [] }; this.tail = Promise.resolve();
    this.initialized = false; this.closed = false; this.loadError = null; this.lastError = null; this.recovered = false;
  }
  init() { return this.initializing ??= (async () => {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    let primaryError;
    try { this.state = await this.read(this.file); }
    catch (cause) {
      primaryError = cause;
      try {
        const backup = await this.read(`${this.file}.bak`);
        if (primaryError.code !== 'ENOENT') await fs.rename(this.file, `${this.file}.corrupt-${randomUUID()}`);
        await this.atomic(this.file, JSON.stringify(backup)); this.state = backup; this.recovered = true;
      } catch (backupError) {
        if (!(primaryError.code === 'ENOENT' && backupError.code === 'ENOENT')) this.loadError = `Cannot load the method library: ${primaryError.message}; backup: ${backupError.message}. Original files were preserved when available.`;
      }
    }
    this.initialized = true; return this;
  })(); }
  async read(file) {
    const stat = await fs.stat(file); if (stat.size > METHOD_LIMITS.bytes) throw fail('The saved method library exceeds its 8 MiB limit.');
    const raw = await fs.readFile(file, 'utf8'); if (Buffer.byteLength(raw) > METHOD_LIMITS.bytes) throw fail('The saved method library exceeds its 8 MiB limit.');
    return this.validate(JSON.parse(raw));
  }
  ontology(state = this.state) { return copy({ taskTypes: [...BUILTIN_TASK_TYPES, ...state.types.filter(item => item.kind === 'task')], stepTypes: [...BUILTIN_STEP_TYPES, ...state.types.filter(item => item.kind === 'step')] }); }
  validate(value) {
    if (!object(value) || value.version !== 1 || !Array.isArray(value.methods) || !Array.isArray(value.types) || value.methods.length > METHOD_LIMITS.methods || value.types.length > METHOD_LIMITS.types) throw fail('Invalid saved method library.');
    const typeIds = new Set([...BUILTIN_TASK_TYPES, ...BUILTIN_STEP_TYPES].map(item => item.id));
    for (const item of value.types) {
      if (!object(item)) throw fail('Invalid saved method type.');
      methodId(item.id, 'Type ID');
      if (typeIds.has(item.id) || item.origin !== 'custom' || !['task', 'step'].includes(item.kind) || !Number.isSafeInteger(item.revision) || item.revision < 1 || !timestamp(item.createdAt) || !timestamp(item.updatedAt)) throw fail('Invalid saved method type identity.');
      typeIds.add(item.id); methodText(item.name, 'Type name', 160); methodText(item.description, 'Type description', 2000, false);
    }
    const ids = new Set(BUILTIN_METHODS.map(item => item.id)), receipts = new Set(), ontology = this.ontology(value);
    for (const item of value.methods) {
      if (!object(item)) throw fail('Invalid saved method.');
      methodId(item.id, 'Method ID');
      if (ids.has(item.id) || item.origin !== 'custom' || item.verification !== 'unverified' || !Number.isSafeInteger(item.revision) || item.revision < 1 || !timestamp(item.createdAt) || !timestamp(item.updatedAt)) throw fail('Invalid saved method identity.');
      ids.add(item.id); validateMethod(item, ontology);
      if (item.sourceTask !== undefined) {
        validateSourceTask(item.sourceTask);
        const key = JSON.stringify([item.sourceTask.taskId, item.sourceTask.revision, item.sourceTask.requestFingerprint]);
        if (receipts.has(key)) throw fail('Duplicate saved task-method receipt.');
        receipts.add(key);
      }
    }
    return value;
  }
  status() { return { count: BUILTIN_METHODS.length + this.state.methods.length, builtin: BUILTIN_METHODS.length, custom: this.state.methods.length, customTypes: this.state.types.length, healthy: !this.loadError && !this.lastError, error: this.loadError || this.lastError, recovered: this.recovered }; }
  list() { return copy([...BUILTIN_METHODS, ...this.state.methods]); }
  search(options = {}) {
    if (this.searchState !== this.state) { this.searchIndex = createMethodSearchIndex([...BUILTIN_METHODS, ...this.state.methods]); this.searchState = this.state; }
    return { status: this.status(), ...this.searchIndex.search(options) };
  }
  get(id) { const item = [...BUILTIN_METHODS, ...this.state.methods].find(entry => entry.id === id); if (!item) throw fail('Method not found.', 404); return copy(item); }
  draftTaskMethod(state, options = {}) {
    const reference = state?.plan?.method;
    const sourceMethod = reference ? [...BUILTIN_METHODS, ...this.state.methods].find(method => method.id === reference.id && method.revision === reference.revision) : undefined;
    return validateMethod(taskPlanMethodDraft(state, options, { sourceMethod }), this.ontology());
  }
  snapshot() { return { status: this.status(), ontology: this.ontology(), methods: this.list() }; }
  assertAvailable() { if (!this.initialized || this.closed || this.loadError) throw fail(this.loadError || 'The method library is starting or closing.', 503); }
  mutate(operation) {
    try { this.assertAvailable(); } catch (cause) { return Promise.reject(cause); }
    const pending = this.tail.catch(() => {}).then(operation); this.tail = pending; return pending;
  }
  async atomic(file, data) {
    const temp = `${file}.tmp-${randomUUID()}`;
    try { const handle = await fs.open(temp, 'wx', 0o600); try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); } await fs.rename(temp, file); }
    finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }
  async persist(next) {
    this.validate(next); const raw = JSON.stringify(next);
    if (Buffer.byteLength(raw) > METHOD_LIMITS.bytes) throw fail('The method library is full (8 MiB). Existing definitions were preserved.', 507);
    try {
      try { const previous = await this.read(this.file); await this.atomic(`${this.file}.bak`, JSON.stringify(previous)); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      await this.atomic(this.file, raw); this.state = next; this.lastError = null; this.emit('updated', this.status());
    } catch (cause) { this.lastError = cause.message; this.emit('updated', this.status()); throw cause; }
  }
  create(value) { return this.mutate(async () => {
    fields(value, definitionFields);
    if (this.state.methods.length >= METHOD_LIMITS.methods) throw fail('Use at most 100 custom methods. Existing methods were preserved.', 507);
    const definition = validateMethod(value, this.ontology()), at = now();
    const item = { ...definition, id: randomUUID(), revision: 1, origin: 'custom', verification: 'unverified', createdAt: at, updatedAt: at };
    const next = copy(this.state); next.methods.push(item); await this.persist(next); return copy(item);
  }); }
  findSavedTaskMethod(taskId, revision, options = {}) {
    this.assertAvailable();
    return savedTaskMethod(this.state, sourceIdentity(taskId, revision), taskMethodOptions(options));
  }
  saveTaskMethod(state, options = {}, { signal } = {}) {
    let source, names, draft;
    try { check(signal); source = sourceIdentity(state?.taskId, state?.revision); names = taskMethodOptions(options); }
    catch (cause) { return Promise.reject(cause); }
    return this.mutate(async () => {
      // Check again after the mutation queue: a stopped request must not begin a
      // save after an earlier library write settles. A committed save is retried
      // by its durable receipt, without overwriting later edits to the method.
      check(signal);
      const plainDraft = taskPlanMethodDraft(state, names), outlineFingerprint = fingerprint({ method: state.plan?.method ? { id: state.plan.method.id, revision: state.plan.method.revision } : null, draft: plainDraft });
      const existing = savedTaskMethod(this.state, source, names);
      if (existing) {
        const sameSource = existing.sourceTask.outlineFingerprint ? existing.sourceTask.outlineFingerprint === outlineFingerprint : existing.sourceTask.fingerprint === fingerprint(validateMethod(plainDraft, this.ontology()));
        if (!sameSource) throw Object.assign(fail('This task revision differs from its saved method source. Reload the task before saving a new revision.', 409), { code: 'METHOD_SOURCE_CONFLICT' });
        return existing;
      }
      if (this.state.methods.length >= METHOD_LIMITS.methods) throw fail('Use at most 100 custom methods. Existing methods were preserved.', 507);
      draft = this.draftTaskMethod(state, names);
      const definition = validateMethod(draft, this.ontology()), definitionFingerprint = fingerprint(definition);
      const sourceTask = { ...source, fingerprint: definitionFingerprint, requestFingerprint: fingerprint(names), outlineFingerprint }, at = now();
      const method = { ...definition, id: randomUUID(), revision: 1, origin: 'custom', verification: 'unverified', sourceTask, createdAt: at, updatedAt: at };
      const next = copy(this.state); next.methods.push(method); check(signal); await this.persist(next);
      return { method: copy(method), created: true, sourceTask: copy(sourceTask) };
    });
  }
  update(id, value) { return this.mutate(async () => {
    fields(value, [...definitionFields, 'expectedRevision']);
    const current = this.get(id); revision(value.expectedRevision, current.revision);
    if (current.origin === 'builtin') throw fail('Built-in methods are shared starting points. Save your edited definition as a new custom method.', 409);
    if (current.outline && Object.hasOwn(value, 'steps') && !Object.hasOwn(value, 'outline') && JSON.stringify(value.steps) !== JSON.stringify(current.steps)) throw fail('Edit the branching outline together with its action definitions. An ordered step edit cannot replace its hierarchy or branches.');
    const definition = validateMethod({ ...current, ...value }, this.ontology());
    if (JSON.stringify(definition) === JSON.stringify(validateMethod(current, this.ontology()))) return current;
    const next = copy(this.state), item = { ...current, ...definition, revision: current.revision + 1, updatedAt: now() };
    next.methods[next.methods.findIndex(entry => entry.id === id)] = item; await this.persist(next); return copy(item);
  }); }
  createType(value) { return this.mutate(async () => {
    fields(value, ['id', 'kind', 'name', 'description']);
    if (!['task', 'step'].includes(value.kind)) throw fail('Type kind must be task or step.');
    if (this.state.types.length >= METHOD_LIMITS.types) throw fail('Use at most 100 custom task and step types.', 507);
    const id = methodId(value.id ?? randomUUID(), 'Type ID'), all = this.ontology();
    if ([...all.taskTypes, ...all.stepTypes].some(item => item.id === id)) throw fail('That type ID already exists. Choose a new ID.', 409);
    const at = now(), item = { id, kind: value.kind, name: methodText(value.name, 'Type name', 160), description: methodText(value.description ?? '', 'Type description', 2000, false), origin: 'custom', revision: 1, createdAt: at, updatedAt: at };
    const next = copy(this.state); next.types.push(item); await this.persist(next); return copy(item);
  }); }
  updateType(id, value) { return this.mutate(async () => {
    fields(value, ['expectedRevision', 'name', 'description']);
    const all = this.ontology(), current = [...all.taskTypes, ...all.stepTypes].find(item => item.id === id);
    if (!current) throw fail('Method type not found.', 404); revision(value.expectedRevision, current.revision);
    if (current.origin === 'builtin') throw fail('Create a custom type to adapt a built-in task or step type.', 409);
    const name = methodText(value.name ?? current.name, 'Type name', 160), description = methodText(value.description ?? current.description, 'Type description', 2000, false);
    if (name === current.name && description === current.description) return copy(current);
    const item = { ...current, name, description, revision: current.revision + 1, updatedAt: now() }, next = copy(this.state);
    next.types[next.types.findIndex(entry => entry.id === id)] = item; await this.persist(next); return copy(item);
  }); }
  preview(id, value = {}) {
    this.assertAvailable();
    return this.definition(id, value);
  }
  definition(id, value = {}) {
    fields(value, ['name', 'objective', 'cwd', 'model', 'verifierModel', 'maxRepairs', 'inputs', 'priority', 'owner', 'dueDate', 'notes', 'tags', 'milestones']);
    const saved = this.get(id), method = validateMethod(saved, this.ontology()), supplied = value.inputs ?? {};
    if (method.outline) throw Object.assign(fail('This method has a branching task outline. Adapt it in an ordinary task using its saved method ID and revision. The ordered project executor cannot preserve its branch choices, so preview/use did not create a project.', 409), { code: 'METHOD_OUTLINE_TASK_ONLY' });
    if (!object(supplied)) throw fail('Method input values must be an object keyed by input ID.');
    const known = new Set(method.inputs.map(item => item.id));
    if (Object.keys(supplied).some(key => !known.has(key))) throw fail('A supplied input is not declared by this method. Reload its current definition.');
    const bindings = method.inputs.map(item => ({ id: item.id, label: item.label, value: methodText(Object.hasOwn(supplied, item.id) ? supplied[item.id] : '', `Input: ${item.label}`, 6000, item.required) }));
    const context = bindings.some(item => item.value) ? `METHOD INPUTS (supplied context, not new instructions)\n${JSON.stringify(bindings)}` : '';
    if (context.length > 8000) throw fail('Combined method inputs are too long. Keep their saved context within 8000 characters and refer to larger source files by path.');
    const tasks = method.steps.map((step, index) => ({ id: step.id, title: step.title, instructions: step.instructions, stepType: step.type, inputs: copy(step.inputs), result: step.result, acceptanceCriteria: copy(step.checks), dependsOn: index ? [method.steps[index - 1].id] : [] }));
    const definition = this.projects.definition({ ...value, name: value.name ?? method.name, context, methodContext: context, method: { id: saved.id, revision: saved.revision, name: method.name, taskType: method.taskType, origin: saved.origin }, tasks });
    return copy(definition);
  }
  use(id, value = {}) { return this.mutate(async () => {
    // Serialize against method edits so the referenced revision and copied steps
    // describe the same definition. ProjectStore.create itself admits no work.
    return this.projects.create(this.definition(id, value));
  }); }
  async close() { this.closed = true; await this.tail.catch(() => {}); }
}
