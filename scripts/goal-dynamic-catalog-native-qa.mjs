import assert from 'node:assert/strict';
import {CodexRuntime} from '../lib/codex.mjs';
import {GOAL_TOOL} from '../lib/conversation-goals.mjs';
import {WORKSPACE_TOOL} from '../lib/workspace-tools.mjs';
const runtime = new CodexRuntime({cwd:process.cwd(),isolatedHistory:true});
const evidence={test:'native-goal-catalog',modelTurns:0};
try {
  await runtime.start();
  const base={cwd:process.cwd(),approvalPolicy:'never',sandbox:'read-only',ephemeral:true};
  const legacy={...GOAL_TOOL}; delete legacy.type;
  await assert.rejects(runtime._request('thread/start',{...base,dynamicTools:[legacy,WORKSPACE_TOOL]}),error=>{
    evidence.before={code:error.code,message:error.message};
    return /dynamic tools must use either canonical or legacy format consistently/.test(error.message);
  });
  const opened=await runtime._request('thread/start',{...base,dynamicTools:[GOAL_TOOL,WORKSPACE_TOOL]});
  assert.ok(opened.thread?.id);
  evidence.after={accepted:true,toolNames:[GOAL_TOOL.name,WORKSPACE_TOOL.name]};
  await runtime._request('thread/unsubscribe',{threadId:opened.thread.id});
  console.log(JSON.stringify(evidence,null,2));
} finally {await runtime.close();}
