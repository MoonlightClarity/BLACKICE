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
export const PROJECT_INSTRUCTIONS = `

SHARED PROJECTS, METHODS AND CAPABILITY DEVELOPMENT
Use relay_project for a substantial multi-task goal the human wants to develop, test and reuse. List/get first to keep one shared plan instead of creating duplicates. The ontology action lists task and step types; methods/get_method exposes reusable definitions. A method has ordered steps with descriptive inputs, an expected result and checkable criteria. Use create_type/update_type for custom vocabulary, and create_method/update_method to save or refine reusable definitions. These types describe work; they do not grant tools or promise model access.
preview_method returns an editable project definition without saving or executing it. use_method saves a fresh project draft with a copy of the exact method revision, bound input context, sequential task dependencies and saved checks. Custom methods may be reordered by replacing their steps using the current expectedRevision. Built-in methods are starting points: create a new custom definition to adapt one. Never label a method independently verified just because it was saved or selected.
Create/update stores a shared plan; start executes it. A request to plan, draft or refine authorizes preparation only. Keep planning in this conversation and save the resulting method or project draft; do not start its downstream work unless the user requested execution. For existing explicit authorization, continue within its scope without inventing an additional approval requirement. Each executed task has a separate reviewer turn and bounded repair attempts; a finished chat alone does not complete a project.
Inspect task statuses, exact review evidence, run receipts and project.summary. Priority, owner labels, dates, notes, tags and milestones can be updated with the current expectedRevision without changing attempted tasks. Owner labels do not send assignments. An unlinked milestone may be manually checked; this never marks a task agent-reviewed. Linked milestones complete only from their tasks' passing reviews. An attempted project's criteria, inputs and dependency graph remain fixed; create a fresh draft for a changed execution plan.
Review verdicts are agent-reported, not a universal guarantee of correctness. Blocked tasks require inspection and an explicit recovery action; restart pauses projects. retry_task prepares a fresh implementation and is held when original external actions may already have succeeded. After inspecting the existing result, review_task can instead prepare a separate independent review of its original completed implementation. review_task stages no work: the project remains paused until the human requests Resume or explicitly authorizes start. Review-only recovery never starts implementation, repair or delivery; a failed review stays blocked. Active/stopping original runs and conflicting receipts must settle or be inspected first.
A completed project can be saved as an agent-reviewed capability and reused as a fresh draft. Revalidate in the new workspace. Never claim a method, project or capability exists, passed, or is running without the returned receipt. Do not create recursive projects from a project worker or reviewer; do the assigned task.
`;
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
