const string = { type: 'string' };
const strings = (maxItems = 20) => ({ type: 'array', items: string, maxItems });
const repairs = { type: 'integer', minimum: 0, maximum: 3 };
const expectedRevision = { type: 'integer', minimum: 1 };
const milestone = { type: 'object', properties: { id: string, title: string, taskIds: strings(100), dueDate: string, done: { type: 'boolean' } }, required: ['title'], additionalProperties: false };
const management = { priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, owner: string, dueDate: string, notes: string, tags: strings(12), milestones: { type: 'array', items: milestone, maxItems: 30 } };
const methodReference = { type: 'object', properties: { id: string, revision: expectedRevision, name: string, taskType: string, origin: { type: 'string', enum: ['builtin', 'custom'] } }, required: ['id', 'revision', 'name', 'taskType', 'origin'], additionalProperties: false };
const task = { type: 'object', properties: { id: string, title: string, instructions: string, acceptanceCriteria: { ...strings(), minItems: 1 }, dependsOn: strings(100), model: string, verifierModel: string, maxRepairs: repairs, stepType: string, inputs: strings(), result: string }, required: ['title', 'instructions', 'acceptanceCriteria'], additionalProperties: false };
const project = { type: 'object', properties: { name: string, objective: string, cwd: string, model: string, verifierModel: string, maxRepairs: repairs, tasks: { type: 'array', items: task, minItems: 1, maxItems: 100 }, expectedRevision, context: string, method: methodReference, ...management }, additionalProperties: false };
const methodInput = { type: 'object', properties: { id: string, label: string, description: string, required: { type: 'boolean' } }, required: ['id', 'label'], additionalProperties: false };
const methodStep = { type: 'object', properties: { id: string, title: string, type: string, instructions: string, inputs: strings(), result: string, checks: { ...strings(), minItems: 1 } }, required: ['title', 'instructions', 'result', 'checks'], additionalProperties: false };
const method = { type: 'object', properties: { name: string, description: string, taskType: string, inputs: { type: 'array', items: methodInput, maxItems: 20 }, steps: { type: 'array', items: methodStep, minItems: 1, maxItems: 50 }, expectedRevision }, additionalProperties: false };
const ontologyType = { type: 'object', properties: { id: string, kind: { type: 'string', enum: ['task', 'step'] }, name: string, description: string, expectedRevision }, additionalProperties: false };
const options = { type: 'object', properties: { name: string, objective: string, cwd: string, model: string, verifierModel: string, maxRepairs: repairs, inputs: { type: 'object', additionalProperties: string }, ...management }, additionalProperties: false };
export const PROJECT_TOOL = {
  type: 'function', name: 'relay_project',
  description: 'Shared human-agent projects and reusable methods. Inspect the task/step ontology, draft or refine ordered methods with inputs/results/checks, and use them to save project drafts. Track milestones, ownership labels, priority, dates, blockers and actual run/review evidence. Create, preview, update and reuse never execute project tasks. Start only when execution is requested. Tasks use the existing implementation→independent review→bounded repair engine. review_task stages a paused review of the original completed implementation; an explicit start resumes it without repeating delivery. Capabilities retain historical agent-reviewed evidence; all reused plans begin unverified.',
  inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['describe', 'list', 'get', 'create', 'update', 'start', 'pause', 'retry_task', 'review_task', 'ontology', 'create_type', 'update_type', 'methods', 'get_method', 'create_method', 'update_method', 'preview_method', 'use_method', 'capabilities', 'save_capability', 'use_capability'] }, id: string, taskId: string, reason: string, project, projectId: string, name: string, description: string, cwd: string, objective: string, method, type: ontologyType, options }, required: ['action'], additionalProperties: false }
};
export const PROJECT_INSTRUCTIONS = "\n\nSHARED PROJECTS\nList/get existing projects and use the current revision for changes. create/update, preview_method, use_method and use_capability prepare or save; start executes. Execution includes implementation, independent review and bounded repair. Saved definitions and reused capabilities are unverified in the new context.\nAn attempted project's criteria, inputs and dependencies are fixed; use a fresh draft to change its execution plan. Metadata remains editable with its current revision. Owner labels do not send assignments; manual unlinked milestones do not mark tasks reviewed.\nretry_task prepares a fresh implementation and can be held for unresolved prior effects. review_task instead stages a paused review of the original completed implementation; start resumes that review without repeating delivery. Inspect the actual status and receipts before choosing recovery. Project workers and reviewers perform their assigned task without creating recursive projects.\n";
export function createProjectToolHandler({ projects, capabilities, methods, cwd, signal }) {
  return async call => {
    try {
      if (signal?.aborted) throw Error('Task stopped.');
      if (call.name !== PROJECT_TOOL.name) throw Error('Unknown project tool.');
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Project arguments are required.');
      if (Object.keys(args).some(key => !Object.hasOwn(PROJECT_TOOL.inputSchema.properties, key))) throw Error('Unsupported project tool argument. Read relay_project describe for the supported fields.');
      const library = () => { if (!methods) throw Error('The method library is not available in this session.'); return methods; };
      const methodOptions = () => ({ ...args.options, cwd: args.options?.cwd || cwd });
      const orderedMethod = () => {
        if (!args.method || typeof args.method !== 'object' || Array.isArray(args.method)) throw Error('A method object is required.');
        // Saved native threads retain this exact ordered-method catalog. Richer
        // library output must not let an undeclared input silently pass through.
        if (Object.keys(args.method).some(key => !Object.hasOwn(method.properties, key))) throw Object.assign(Error('relay_project accepts ordered method fields only. Save a branching task outline with relay_task save_method or the task workspace.'), { code: 'METHOD_SCHEMA_UNSUPPORTED', status: 400 });
        return args.method;
      };
      let result;
      switch (args.action) {
        case 'describe': result = { tool: PROJECT_TOOL, notes: [
          'Use ontology for saved task and step types. create_type and update_type take a type object; edits require its expectedRevision.',
          'methods lists definitions; get_method uses id. create_method and update_method take a method object; edits require expectedRevision. Built-ins are adapted by creating a custom definition.',
          'Methods with an outline retain nested, parallel and conditional paths. Read their exact saved ID/revision and adapt them in an ordinary task with relay_task. This ordered project tool cannot preview or use those outlines as projects.',
          'preview_method and use_method take id and options {name,objective,cwd,inputs:{inputId:value},model?,verifierModel?,maxRepairs?}. Preview returns a definition only; use saves a draft. Neither starts work.',
          'Task IDs must be unique; dependencies form a directed acyclic graph.',
          'Every task needs explicit, checkable acceptanceCriteria. Each gets an implementation run and separate review run.',
          'maxRepairs bounds repair rounds. Invalid/missing review JSON cannot pass. Runtime failures require inspection.',
          'Starting a paused project resumes remaining work. Pausing prevents new starts and retains active receipts.',
          'Metadata-only update permits name, priority, owner, dueDate, notes, tags and milestones with expectedRevision during execution. Manual unlinked milestones are separate from agent-reviewed task progress.',
          'retry_task prepares a fresh implementation. review_task instead prepares a paused independent review of the original completed implementation; it starts no work until an explicitly requested start/Resume, never repeats implementation or delivery, and failed review stays blocked. External-action holds remain saved.',
          'Capabilities retain historical evidence. use_capability creates an unverified draft and starts no work.'
        ] }; break;
        case 'list': result = projects.snapshot(); break;
        case 'get': result = projects.get(args.id); break;
        case 'create': result = await projects.create({ ...args.project, cwd: args.project?.cwd || cwd }); break;
        case 'update': result = await projects.update(args.id, args.project); break;
        case 'start': result = await projects.start(args.id); break;
        case 'pause': result = await projects.pause(args.id, args.reason); break;
        case 'retry_task': result = await projects.retryTask(args.id, args.taskId); break;
        case 'review_task': result = await projects.reviewTask(args.id, args.taskId); break;
        case 'ontology': result = { status: library().status(), ...library().ontology() }; break;
        case 'create_type': result = await library().createType(args.type); break;
        case 'update_type': result = await library().updateType(args.id, args.type); break;
        case 'methods': {
          result = library().snapshot();
          if (JSON.stringify(result).length > 128000) {
            const compactType = ({ id, kind, name, description, revision, origin }) => ({ id, kind, name, description: String(description || '').slice(0, 160), revision, origin });
            result = { status: result.status, ontology: { taskTypes: result.ontology.taskTypes.map(compactType), stepTypes: result.ontology.stepTypes.map(compactType) }, methods: result.methods.map(({ id, name, revision }) => ({ id, name, revision })), catalogFormat: 'complete-name-index', note: 'This catalog includes every saved method ID, exact name and revision. Full procedures load separately with get_method and id. New relay_task schemas support bounded methodQuery search and domain/phase/output filters; this saved project tool keeps its original input fields.' };
            if (JSON.stringify(result).length > 128000) throw Object.assign(Error('The complete method name index exceeds this saved tool response size. Use current relay_task describe search, or get_method with a known exact ID.'), { code: 'METHOD_CATALOG_LIMIT', status: 413 });
          }
          break;
        }
        case 'get_method': {
          result = library().get(args.id);
          if (JSON.stringify(result).length > 128000) throw Object.assign(Error('This complete method exceeds the project tool response size. Read its exact ID and revision with relay_task describe; that tool returns explicit step pages without truncation.'), { code: 'METHOD_CATALOG_LIMIT', status: 413 });
          break;
        }
        case 'create_method': result = await library().create(orderedMethod()); break;
        case 'update_method': result = await library().update(args.id, orderedMethod()); break;
        case 'preview_method': result = library().preview(args.id, methodOptions()); break;
        case 'use_method': result = await library().use(args.id, methodOptions()); break;
        case 'capabilities': result = { capabilities: capabilities.list(), status: capabilities.status() }; break;
        case 'save_capability': result = await capabilities.save({ projectId: args.projectId || args.id, name: args.name, description: args.description }); break;
        case 'use_capability': result = await capabilities.use(args.id, { name: args.name, cwd: args.cwd || cwd, objective: args.objective }); break;
        default: throw Error('Choose an action from relay_project describe.');
      }
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.status ? { status: error.status } : {}) }) }] }; }
  };
}
