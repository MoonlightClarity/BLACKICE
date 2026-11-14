import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const edits=new Map();function edit(file,from,to){if(!edits.has(file))edits.set(file,[]);edits.get(file).push({from,to});}
edit('public/next/chat/render.mjs',
  'Autonomous goal</strong><span id="next-chat-goal-status"',
  'Goal Mode</strong><span id="next-chat-goal-status"');
edit('public/next/chat/render.mjs',
  'aria-label="Autonomous goal"','aria-label="Persistent Goal Mode"');
edit('public/next/chat/render.mjs',
  '<button id="next-chat-goal-edit" type="button">Calibrate</button>',
  '<button id="next-chat-goal-edit" type="button">Edit goal</button>');
edit('public/next/chat/render.mjs',
  '<button id="next-chat-goal-toggle" class="next-chat-goal-toggle" type="button" role="switch" aria-checked="false">Autonomy: Off</button><span class="next-chat-spacer">',
  '<button id="next-chat-autonomy-toggle" class="next-chat-goal-toggle" type="button" role="switch" aria-checked="false">Autonomy: Off</button><button id="next-chat-autonomy-settings" class="next-chat-autonomy-settings" type="button" title="Calibrate autonomous operation">Calibrate</button><button id="next-chat-goal-toggle" class="next-chat-goal-toggle" type="button" role="switch" aria-checked="false">Goal: Off</button><span class="next-chat-spacer">');
edit('public/next/chat/render.mjs',
  '<h2 id="next-chat-goal-title">Turn on autonomy</h2><p>Calibrate BLACKICE in regular chat first. When you turn autonomy on, it continues the same conversation using your earlier directions, selected model, and tools. No separate chat is created.</p>',
  '<h2 id="next-chat-goal-title">Create Goal</h2><p>Goal Mode tracks one explicit objective and its completion evidence. This is separate from autonomous operation and its model allowlist.</p>');
edit('public/next/chat/render.mjs',
  '<p class="next-help">Autonomy is Off by default. Turn it Off from the chat to pause execution and retain the goal, conversation and progress. Turn it On again to resume. The turn limit is optional; leaving it blank means no limit.</p>',
  '<p class="next-help">Goal Mode is optional and independent of autonomous operation. Turning it off retains the saved goal and progress.</p>');
edit('public/next/chat/render.mjs',
  '<button id="next-chat-goal-save" type="submit" class="next-primary">Turn on autonomy</button>',
  '<button id="next-chat-goal-save" type="submit" class="next-primary">Save Goal</button>');
edit('public/next/chat/render.mjs',
  '</form></dialog><dialog id="next-chat-trash-dialog"',
  '</form></dialog><dialog id="next-chat-autonomy-dialog" class="next-chat-management-dialog next-chat-goal-dialog" aria-labelledby="next-chat-autonomy-title"><form id="next-chat-autonomy-form"><h2 id="next-chat-autonomy-title">Autonomous operation</h2><p>This mode is independent of Goal Mode. BLACKICE may continue the conversation, select permitted models, and delegate work. Calibration guides its decisions.</p><label class="next-label">Calibration (optional)<textarea id="next-chat-autonomy-calibration" class="next-field" rows="4" maxlength="12000" placeholder="How should BLACKICE make decisions and use your time and model quotas?"></textarea></label><label class="next-label">Model whitelist (required)<input id="next-chat-autonomy-search" class="next-field" type="search" placeholder="Filter available models" aria-label="Filter autonomous models"></label><div id="next-chat-autonomy-models" class="next-chat-autonomy-models" role="group" aria-label="Models permitted for autonomy"></div><p class="next-help">Only selected models may be used for autonomous continuations or delegated workers. Model suitability and capabilities are judged by the model-selection skill, not hardcoded restrictions.</p><p id="next-chat-autonomy-error" role="alert" hidden></p><div class="next-chat-dialog-actions"><button id="next-chat-autonomy-cancel" type="button">Cancel</button><button id="next-chat-autonomy-save" type="submit" class="next-primary">Enable autonomy</button></div></form></dialog><dialog id="next-chat-trash-dialog"');
edit('public/next/chat/render.mjs',
  "goalToggle:find('next-chat-goal-toggle'),goalCard:",
  "autonomyToggle:find('next-chat-autonomy-toggle'),autonomySettings:find('next-chat-autonomy-settings'),autonomyDialog:find('next-chat-autonomy-dialog'),autonomyForm:find('next-chat-autonomy-form'),autonomyCalibration:find('next-chat-autonomy-calibration'),autonomySearch:find('next-chat-autonomy-search'),autonomyModels:find('next-chat-autonomy-models'),autonomyError:find('next-chat-autonomy-error'),autonomyCancel:find('next-chat-autonomy-cancel'),autonomySave:find('next-chat-autonomy-save'),\n    goalToggle:find('next-chat-goal-toggle'),goalCard:");
edit('public/next/chat/goals.mjs',
  "view.goalToggle.textContent=enabled?'Autonomy: On':'Autonomy: Off';",
  "view.goalToggle.textContent=enabled?'Goal: On':'Goal: Off';");
edit('public/next/chat/goals.mjs',
  "view.goalToggle.title=readError|| (pausePending?'Waiting for the current turn to stop before autonomy can resume.':enabled?'Turn autonomy off; stop automatic continuation and retain this chat and goal.':goal&&RESUMABLE.has(goal.status)?'Resume this saved autonomous goal in the same chat.':'Calibrate this conversation and turn autonomous execution on.');",
  "view.goalToggle.title=readError|| (pausePending?'Waiting for the current Goal turn to stop.':enabled?'Pause Goal Mode, retaining its saved objective and progress.':goal&&RESUMABLE.has(goal.status)?'Resume this saved Goal Mode in the same chat.':'Create an explicit persistent goal for this conversation.');");
edit('public/next/chat/goals.mjs',
  "view.goalTitle.textContent=goal&&goal.status!=='completed'?'Calibrate autonomous goal':'Turn on autonomy';",
  "view.goalTitle.textContent=goal&&goal.status!=='completed'?'Edit Goal':'Create Goal';");
edit('public/next/chat/goals.mjs',
  "view.goalSave.textContent=goal&&goal.status!=='completed'?'Save calibration':'Turn on autonomy';",
  "view.goalSave.textContent=goal&&goal.status!=='completed'?'Save Goal':'Create Goal';");
edit('public/next/chat/goals.mjs',
  "notify(current?current.label+' · '+current.progress+': '+current.objective:'No goal is set. Use /goal followed by an objective, or choose Goal.');",
  "notify(current?current.label+' · '+current.progress+': '+current.objective:'No Goal Mode objective is set. Use /goal followed by an objective.');");

edit('public/next/chat/chat.mjs',
  "import {createGoalControls,parseGoalCommand} from './goals.mjs';",
  "import {createGoalControls,parseGoalCommand} from './goals.mjs';\nimport {createAutonomyControls} from './autonomy.mjs';");
edit('public/next/chat/chat.mjs',
  "let goalControls=null;",
  "let goalControls=null,autonomyControls=null;");
edit('public/next/chat/chat.mjs',
  "||goalControls?.isBusy();",
  "||goalControls?.isBusy()||autonomyControls?.isBusy();");
edit('public/next/chat/chat.mjs',
  "goalControls?.update({conversationId:root(),running:state.runs.some(run=>run.status==='running'&&run.settled!==true),readonly:bucket!=='active',busy:state.pending||state.managing||state.loading});",
  "goalControls?.update({conversationId:root(),running:state.runs.some(run=>run.status==='running'&&run.settled!==true),readonly:bucket!=='active',busy:state.pending||state.managing||state.loading});\n    autonomyControls?.update({conversationId:root(),readonly:bucket!=='active',busy:state.pending||state.managing||state.loading});");
edit('public/next/chat/chat.mjs',
  "  let attachmentsUI;\n  try {",
  "  autonomyControls=createAutonomyControls({view,api,notify,onError:showError,onChange:updateHead,\n    getStatus:()=>runtimeStatus,\n    getContext:()=>({runId:state.runs.at(-1)?.id,model:state.options.model}),\n    onResult:async(result,owner)=>{\n      if(state.destroyed||!state.active||root()!==owner||state.pending||!state.selected)return;\n      const item=result?.run?.id?{...state.selected,runId:result.run.id,latestRunId:result.run.id}:state.selected;\n      await open(item,{refresh:true});\n    }});\n  let attachmentsUI;\n  try {");
edit('public/next/chat/chat.mjs',
  "if(goalControls.handleEvent(event))return;",
  "if(goalControls.handleEvent(event))return;\n    if(autonomyControls.handleEvent(event))return;");
edit('public/next/chat/chat.mjs',
  "goalControls.close();",
  "goalControls.close();autonomyControls.close();");
edit('public/next/chat/chat.mjs',
  "goalControls.destroy();contextControls.destroy();",
  "goalControls.destroy();autonomyControls.destroy();contextControls.destroy();");
edit('server.mjs',
  "'chat/chat.mjs','chat/visuals.mjs','chat/model.mjs','chat/render.mjs','chat/send.mjs','chat/goals.mjs','chat/planning-timeline.mjs',",
  "'chat/chat.mjs','chat/visuals.mjs','chat/model.mjs','chat/render.mjs','chat/send.mjs','chat/goals.mjs','chat/autonomy.mjs','chat/planning-timeline.mjs',");
const planned=[];
for(const [rel,changes] of edits){
 const file=join(root,rel);const original=readFileSync(file,'utf8');let data=original;
 for(const {from,to} of changes){
  let at=data.indexOf(from);
  if(at<0){
    if(rel==='public/next/chat/goals.mjs' && from.startsWith('notify(current?')){process.stdout.write('Optional skip older message variant\n');continue;}
    throw Error('Missing '+rel+': '+from.slice(0,160));
  }
  if(data.indexOf(from,at+1)>=0)throw Error('Duplicate '+rel+': '+from.slice(0,100));
  data=data.slice(0,at)+to+data.slice(at+from.length);
 }
 planned.push({rel,file,original,data});
}
for(const {rel,file,original,data} of planned){if(original!==data){writeFileSync(file,data,'utf8');process.stdout.write(rel+' updated\n');}}
