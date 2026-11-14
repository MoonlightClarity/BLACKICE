import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const edits=new Map();
function edit(file,from,to){if(!edits.has(file))edits.set(file,[]);edits.get(file).push({from,to});}
edit('lib/engine.mjs',"(this.nativeVisualTools?.catalog||[]),GOAL_TOOL,NATIVE_AGENT_TOOL","(this.nativeVisualTools?.catalog||[]),GOAL_TOOL,AUTONOMY_TOOL,NATIVE_AGENT_TOOL");
edit('lib/engine.mjs',"const goalTrackedToolCall=this.goals?.wrapTools(run,node.id,onToolCall)||onToolCall;",
"const goalTrackedToolCall=this.goals?.wrapTools(run,node.id,onToolCall)||onToolCall;\n        const autonomyTrackedToolCall=this.autonomy?.wrapTools(run,node.id,goalTrackedToolCall)||goalTrackedToolCall;");
edit('lib/engine.mjs',"const recordedToolCall=async (call,context) => {","const recordedToolCall=async (call,context) => {"); // intentionally no-op (locator check)
edit('lib/engine.mjs',"onToolCall:recordedToolCall","onToolCall:autonomyTrackedToolCall"); // watch for other occurrences; one
edit('lib/conversation-autonomy.mjs',
"forRun(run){const row=this.raw(rootOf(run));return row?.enabled?row:null;}",
"forRun(run){const row=this.raw(rootOf(run));return row?.enabled?row:null;}");
edit('lib/conversation-autonomy.mjs',
"return row?.enabled?row:run.autonomy?.automatic&&row?row:null;",
"return row?.enabled?row:run.autonomy?.automatic&&row?row:null;");
edit('lib/conversation-autonomy.mjs',
"    this.invalidate(root);\n    return this.enqueue(root,async()=>{",
"    if(action!=='select_model')this.invalidate(root);\n    return this.enqueue(root,async()=>{");
edit('lib/conversation-autonomy.mjs',
"      if(action==='enable'){\n        const catalog=",
"      if(['enable','resume'].includes(action) && ['active','waiting'].includes(this.conversations.states[root]?.goal?.status))\n        throw fail('Pause the existing Goal Mode before enabling autonomy; saved goals remain intact.','AUTONOMY_GOAL_CONFLICT',409);\n      if(action==='enable'){\n        const catalog=");
edit('lib/conversation-autonomy.mjs',
"      return {autonomy:this.view(root)};\n    });",
"      return {autonomy:this.view(root)};\n    }).catch(error=>{this.schedule(root);throw error;});");
edit('lib/conversation-autonomy.mjs',
"  async handle(run,nodeId,call){",
"  wrapTools(run,nodeId,handler){\n    return async(call,context)=>{\n      const result=await handler(call,context);\n      if(call?.name!==AUTONOMY_TOOL.name&&this.policyForRun(run)?.enabled){\n        run.autonomyToolCount=(run.autonomyToolCount||0)+1;\n      }\n      return result;\n    };\n  }\n  async handle(run,nodeId,call){");
edit('lib/conversation-goals.mjs',
"      let goal = this.raw(rootId);\n      // Progress/settlement receipts",
"      let goal = this.raw(rootId);\n      if(['set','update','resume'].includes(action)&&this.conversations.states[rootId]?.autonomy?.enabled)\n        throw fail('Disable autonomous operation before starting Goal Mode; saved calibration remains intact.','GOAL_AUTONOMY_CONFLICT',409);\n      // Progress/settlement receipts");
const out=[];
for(const [relative,changes] of edits){
 const file=join(root,relative),original=readFileSync(file,'utf8');let current=original;
 for(const {from,to} of changes){
  if(from===to)continue;
  const at=current.indexOf(from);
  if(at<0||current.indexOf(from,at+1)>=0)throw Error('Expected one occurrence '+relative+' '+from.slice(0,100));
  current=current.slice(0,at)+to+current.slice(at+from.length);
 }
 out.push({relative,file,original,current});
}
for(const {relative,file,original,current} of out){if(original!==current)writeFileSync(file,current,'utf8');process.stdout.write(relative+' updated\n');}
