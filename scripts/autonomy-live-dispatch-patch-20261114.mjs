// Exact single-occurrence source transforms for the isolated autonomy candidate.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha=s=>createHash('sha256').update(s).digest('hex');
const transforms=new Map();
function edit(file,from,to){
  if(!transforms.has(file))transforms.set(file,[]);
  transforms.get(file).push({from,to});
}
edit('lib/engine.mjs',
  "import {GOAL_TOOL, validateGoalInput} from './conversation-goals.mjs';",
  "import {GOAL_TOOL, validateGoalInput} from './conversation-goals.mjs';\nimport {AUTONOMY_TOOL} from './conversation-autonomy.mjs';\nimport {requireAutonomyModel} from './autonomy-model-allowlist.mjs';"
);
edit('lib/engine.mjs','SUBAGENT_TOOL,SUBAGENT_V5_TOOL','SUBAGENT_TOOL,SUBAGENT_V6_TOOL,SUBAGENT_V5_TOOL');
edit('lib/engine.mjs',
  "&& !run.goal?.automatic && !run.goalDispatch",
  "&& !run.goal?.automatic && !run.goalDispatch && !run.autonomy?.automatic && !run.autonomyDispatch"
);
edit('lib/engine.mjs',
  "continueRun(id, value, {historyRuns=[],threadModel,goalDispatch}={}) {",
  "continueRun(id, value, {historyRuns=[],threadModel,goalDispatch,autonomyDispatch}={}) {"
);
edit('lib/engine.mjs',
  "const goalUpgrade = Boolean(this.goals?.forRun(previous) && oldProvider === 'codex' && nextProvider === 'codex' && !prior.toolNames?.includes(GOAL_TOOL.name));",
  "const goalUpgrade = Boolean(this.goals?.forRun(previous) && oldProvider === 'codex' && nextProvider === 'codex' && !prior.toolNames?.includes(GOAL_TOOL.name));\n    const autonomyUpgrade = Boolean(this.autonomy?.forRun(previous) && oldProvider === 'codex' && nextProvider === 'codex' && !prior.toolNames?.includes(AUTONOMY_TOOL.name));"
);
edit('lib/engine.mjs',
  "const handoff=goalUpgrade || executionModeChange",
  "const handoff=autonomyUpgrade || goalUpgrade || executionModeChange"
);
edit('lib/engine.mjs',
  "...(goalDispatch ? {goalDispatch:clone(goalDispatch)} : {}),",
  "...(goalDispatch ? {goalDispatch:clone(goalDispatch)} : {}),\n      ...(autonomyDispatch ? {autonomyDispatch:clone(autonomyDispatch)} : {}),"
);
edit('lib/engine.mjs',
  "reason:goalUpgrade?'goal-mode-capability':",
  "reason:autonomyUpgrade?'autonomy-mode-capability':goalUpgrade?'goal-mode-capability':"
);
edit('lib/engine.mjs',
  "this.goals?.prepareRun(run);",
  "this.goals?.prepareRun(run);"
); // no-op
edit('lib/engine.mjs',
  "await this.goals?.admitRun(run); await this.persist(); return this.execute(run, controller);",
  "await this.goals?.admitRun(run); await this.autonomy?.admitRun(run); await this.persist(); return this.execute(run, controller);"
);
edit('lib/engine.mjs',
  "subagentSchemaVersion >= SUBAGENT_SCHEMA_VERSION ? SUBAGENT_TOOL : subagentSchemaVersion >= 5 ? SUBAGENT_V5_TOOL",
  "subagentSchemaVersion >= SUBAGENT_SCHEMA_VERSION ? SUBAGENT_TOOL : subagentSchemaVersion >= 6 ? SUBAGENT_V6_TOOL : subagentSchemaVersion >= 5 ? SUBAGENT_V5_TOOL"
);
edit('lib/engine.mjs',
  "model: node.model === 'default' ? undefined : node.model, effort: node.effort, serviceTier: node.serviceTier,\n            contextOptions:",
  "model: node.model === 'default' ? undefined : node.model, effort: node.effort, serviceTier: node.serviceTier,\n             allowTaskModel: subagentSchemaVersion >= 7,\n             selectWorkerModel: ({task,inheritedModel}) => {\n               const selection=task.model??inheritedModel??this.runtime.status().defaultModel;\n               const policy=this.autonomy?.policyForRun(run);\n               return policy?.modelAllowlist\n                 ? requireAutonomyModel({allowlist:policy.modelAllowlist,requestedModel:selection,\n                     ...(this.runtime.status()?.models?.length?{catalog:this.runtime.status().models}:{})})\n                 : selection;\n             },\n             contextOptions:"
);
edit('lib/engine.mjs',
  "const conversationGoalTool = !scopedWorker && this.goals && (this.goals.forRun(run) || priorTools?.includes(GOAL_TOOL.name));",
  "const conversationGoalTool = !scopedWorker && this.goals && (this.goals.forRun(run) || priorTools?.includes(GOAL_TOOL.name));\n        const conversationAutonomyTool = !scopedWorker && this.autonomy && (this.autonomy.forRun(run) || priorTools?.includes(AUTONOMY_TOOL.name));\n        if (conversationAutonomyTool) appendHarness(this.autonomy.instructions(run));"
);
edit('lib/engine.mjs',
  "...(conversationGoalTool ? [GOAL_TOOL] : []), ...(nativePlanning?.tools||[])",
  "...(conversationGoalTool ? [GOAL_TOOL] : []), ...(conversationAutonomyTool ? [AUTONOMY_TOOL] : []), ...(nativePlanning?.tools||[])"
);
edit('lib/engine.mjs',
  "if (call.name === GOAL_TOOL.name && conversationGoalTool && dynamicTools.some(tool => tool.name === GOAL_TOOL.name)) return this.goals.handle(run, node.id, call);",
  "if (call.name === GOAL_TOOL.name && conversationGoalTool && dynamicTools.some(tool => tool.name === GOAL_TOOL.name)) return this.goals.handle(run, node.id, call);\n          if (call.name === AUTONOMY_TOOL.name && conversationAutonomyTool && dynamicTools.some(tool => tool.name === AUTONOMY_TOOL.name)) return this.autonomy.handle(run,node.id,call);"
);
edit('lib/engine.mjs',
  "const executePreparedAgent=async options=>{\n          if(!usesDirectory(run.input,run.executionModes.directoryMode))return this.runtime.runAgent(options);",
  "const executePreparedAgent=async options=>{\n           if (run.autonomyDispatch) {\n             const policy=this.autonomy?.policyForRun(run);\n             if (!policy?.enabled || policy.generation!==run.autonomyDispatch.generation)\n               throw Object.assign(Error('Autonomous model dispatch was superseded.'),{code:'AUTONOMY_DISPATCH_SUPERSEDED',status:409});\n             requireAutonomyModel({allowlist:policy.modelAllowlist,\n               requestedModel:options.model??this.runtime.status().defaultModel,\n               ...(this.runtime.status()?.models?.length?{catalog:this.runtime.status().models}:{})});\n           }\n           if(!usesDirectory(run.input,run.executionModes.directoryMode))return this.runtime.runAgent(options);"
);
edit('lib/engine.mjs',
  "const retainedGoal = this.goals?.retainsResources(run) === true;",
  "const retainedGoal = this.goals?.retainsResources(run) === true || Boolean(this.autonomy?.forRun(run));"
);

edit('lib/subagents.mjs',
  "export const SUBAGENT_SCHEMA_VERSION = 6;",
  "export const SUBAGENT_V6_TOOL=structuredClone(SUBAGENT_TOOL);\nSUBAGENT_TOOL.inputSchema.properties.tasks.items.properties.model={type:'string',minLength:1,maxLength:400,description:'Optional exact worker model from this conversation’s user-selected autonomy allowlist. Omit to inherit the coordinator model.'};\nSUBAGENT_TOOL.description+=' New sessions may select an exact model per worker; when autonomy is enabled the host enforces the user model allowlist at each worker launch.';\nexport const SUBAGENT_SCHEMA_VERSION = 7;"
);
edit('lib/subagents.mjs',
  "onAdmission = () => {},\n} = {}) {",
  "onAdmission = () => {}, allowTaskModel = false, selectWorkerModel = null,\n} = {}) {"
);
edit('lib/subagents.mjs',
  "const { task } = job, began = Date.now();",
  "const { task } = job, began = Date.now();\n    let selectedWorkerModel = null;"
);
edit('lib/subagents.mjs',
  "reportRuntime(true);\n      const result = await runtime.runAgent({\n        cwd, prompt, model, effort,",
  "reportRuntime(true);\n      selectedWorkerModel=selectWorkerModel ? await selectWorkerModel({task,inheritedModel:model}) : task.model??model;\n      const result = await runtime.runAgent({\n        cwd, prompt, model:selectedWorkerModel, effort,"
);
edit('lib/subagents.mjs',
  "if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).some(key => !['id', 'prompt', 'dependsOn', 'stepId', 'canWrite', 'readOnly'].includes(key))",
  "if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).some(key => !['id', 'prompt', 'dependsOn', 'stepId', 'canWrite', 'readOnly', ...(allowTaskModel?['model']:[])].includes(key))"
);
edit('lib/subagents.mjs',
  "if (task.readOnly !== undefined && typeof task.readOnly !== 'boolean') throw new Error('readOnly must be a boolean; omit it to inherit the parent boundary.');",
  "if (task.readOnly !== undefined && typeof task.readOnly !== 'boolean') throw new Error('readOnly must be a boolean; omit it to inherit the parent boundary.');\n        if(task.model!==undefined&&(typeof task.model!=='string'||!task.model.trim()||task.model.length>400))throw Error('Choose a valid explicit worker model.');"
);

edit('server.mjs',
  "import { ConversationGoals } from './lib/conversation-goals.mjs';",
  "import { ConversationGoals } from './lib/conversation-goals.mjs';\nimport {ConversationAutonomy} from './lib/conversation-autonomy.mjs';\nimport {handleConversationAutonomyHttp} from './lib/conversation-autonomy-http.mjs';"
);
edit('server.mjs',
  "const goals = await new ConversationGoals({ engine, conversations, autoStart: false }).init();",
  "const goals = await new ConversationGoals({ engine, conversations, autoStart: false }).init();\n  const autonomy=await new ConversationAutonomy({engine,conversations,autoStart:false}).init();"
);
edit('server.mjs',
  "if(await handleConversationGoalsHttp({req,res,pathname,goals,body,json,mutations:fileMutations}))return;",
  "if(await handleConversationGoalsHttp({req,res,pathname,goals,body,json,mutations:fileMutations}))return;\n       if(await handleConversationAutonomyHttp({req,res,pathname,autonomy,body,json,mutations:fileMutations}))return;"
);
edit('server.mjs',
  "const releaseGoalInput = goals.holdForUserInput(runMatch[1]);",
  "const releaseGoalInput = goals.holdForUserInput(runMatch[1]);"
); // no-op, autonomy service supersedes pending loops at admission
edit('server.mjs',
  "goals.start();",
  "goals.start();\n  autonomy.start();"
);
edit('server.mjs',
  "await cleanup(() => goals.close());",
  "await cleanup(() => goals.close());\n    await cleanup(() => autonomy.close());"
);
edit('server.mjs',
  "attempt(()=>goals.pauseAll('All chats stopped.'));",
  "attempt(()=>goals.pauseAll('All chats stopped.'));\n        attempt(()=>autonomy.pauseAll('All chats stopped.'));"
);

const manifest=[];
for(const [relative,steps] of transforms){
  const file=join(root,...relative.split('/'));
  const original=readFileSync(file,'utf8');
  let source=original;
  for(const {from,to} of steps){
    if(from===to)continue;
    const first=source.indexOf(from);
    if(first<0 || source.indexOf(from,first+1)>=0)
      throw Error('Not exactly one match for '+relative+': '+from.slice(0,130));
    source=source.slice(0,first)+to+source.slice(first+from.length);
  }
  // Check all files before writing any for exact transformations.
  manifest.push({relative,file,original,source});
}
for(const row of manifest){
  if(row.original!==row.source)writeFileSync(row.file,row.source,'utf8');
  process.stdout.write(JSON.stringify({file:row.relative,before:sha(row.original),after:sha(row.source)})+'\n');
}
