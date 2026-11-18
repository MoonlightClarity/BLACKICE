import test from 'node:test';
import assert from 'node:assert/strict';
import * as task from '../lib/task-state.mjs';
import {assertCurrentNativeCatalog} from '../lib/engine.mjs';
test('only the current task catalog is exported and execution preference leaves schema fields intact',()=>{
 assert.ok(!Object.keys(task).some(name=>/LEGACY|PREVIOUS|_V\d|ForVersion/.test(name)));
 assert.equal(task.currentTaskTool({executionGuardrails:true}),task.TASK_TOOL);
 assert.equal(task.currentTaskWorkerTool({executionGuardrails:true}),task.TASK_WORKER_TOOL);
 assert.deepEqual(task.currentTaskTool().inputSchema,task.TASK_TOOL.inputSchema);
});
test('unsupported task schemas never reach storage',()=>{
 const store=new Proxy({},{get(){assert.fail('Unsupported schema must not access task data');}});
 for(const schemaVersion of [1,6,13,15])assert.throws(()=>task.createTaskToolHandler({store,taskId:'task',schemaVersion}),{code:'TASK_SCHEMA_UNSUPPORTED'});
});
test('native task admission rejects old schemas without changing saved run records',()=>{
 const run={workflow:{nodes:[{id:'a',type:'agent',model:'native'}]},nodes:{a:{threadId:'thread',nativeCatalogVersion:1,toolNames:['relay_task'],taskSchemaVersion:13}}};
 const before=structuredClone(run);assert.throws(()=>assertCurrentNativeCatalog(run),{code:'NATIVE_CATALOG_UNSUPPORTED'});assert.deepEqual(run,before);
 run.nodes.a.taskSchemaVersion=14;assert.doesNotThrow(()=>assertCurrentNativeCatalog(run));
});
