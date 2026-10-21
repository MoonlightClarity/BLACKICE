import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {taskTitle} from '../public/task-title.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {conversationSummaries} from '../public/conversation-model.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {TaskInbox} from '../lib/inbox.mjs';

const outlined='## Goal\n\nBuild a chess game with SVG pieces\n\n## Context\n\nUse the current workspace.\n\n## Checks\n\nCheck legal moves.';
class Engine extends EventEmitter {runs=new Map();executions=new Map();listRuns(){return [...this.runs.values()].map(item=>structuredClone(item));}getRun(id){return structuredClone(this.runs.get(id));}startRun(){assert.fail('Capturing a prompt must not start work.');}executionStatus(){return{capacity:null,unlimited:true,activeRunIds:[],activeRunCount:0,availableSlots:null};}}
async function directory(t,resources){const dir=await mkdtemp(path.join(tmpdir(),'relay-outline-title-'));t.after(async()=>{for(const resource of resources)await resource.close();assert.equal(path.dirname(dir),path.resolve(tmpdir()));assert.match(path.basename(dir),/^relay-outline-title-/);await rm(dir,{recursive:true,force:true});});return dir;}

test('outline task labels use the goal rather than a generic heading and preserve ordinary task names',()=>{
 for(const title of ['Build a chess game with SVG pieces','Fix project_name/config.json','Inspect C:\\work\\build_cache','Compare α and β'])assert.equal(taskTitle(title),title);
 assert.equal(taskTitle(outlined),'Build a chess game with SVG pieces');
 assert.equal(taskTitle('**Goal:**\n\n- [ ] Fix the [login](https://example.invalid) regression'),'Fix the login regression');
 assert.equal(taskTitle('## Build\n\nTask: Ship the working game'),'Ship the working game');
 assert.equal(taskTitle('\r\n# A meaningful project name ###\r\nDetails'),'A meaningful project name');
 assert.equal(taskTitle('  ',{fallback:'Conversation'}),'Conversation');
 assert.equal(taskTitle('😀😀😀',{max:3}),'😀');
});

test('structured requests keep their exact message while workflow and sidebar labels use the actual task',()=>{
 const input=outlined,workflow=createMissionWorkflow({id:'outline',task:input});
 assert.equal(workflow.name,'Build a chess game with SVG pieces');
 const item={id:'outline-0',taskId:'outline-0',input,workflow,createdAt:'2026-10-17T12:00:00Z',status:'completed'};
 assert.equal(conversationSummaries([item])[0].title,workflow.name);assert.equal(item.input,outlined);
});

test('derived outline titles survive conversation restart and never replace an explicit rename',async t=>{
 const resources=[],dataDir=await directory(t,resources),engine=new Engine(),archive=await new ConversationArchive({dataDir,engine}).init();resources.push(archive);
 const run={id:'outline-0',taskId:'outline-0',createdAt:'2026-10-17T12:00:00Z',input:outlined,workflow:createMissionWorkflow({id:'outline',task:outlined}),status:'completed',settled:true,nodes:{agent:{status:'completed',output:'Done'}},output:'Done',events:[]};
 engine.runs.set(run.id,run);await archive.capture(run);assert.equal(archive.list()[0].title,'Build a chess game with SVG pieces');
 await archive.rename(run.id,'My game');await archive.close();const restored=await new ConversationArchive({dataDir,engine:new Engine()}).init();resources.push(restored);
 assert.equal(restored.list()[0].title,'My game');assert.equal((await restored.get(run.id)).input,outlined);assert.equal((await restored.family(run.id)).title,'My game');
});

test('Inbox stores meaningful outline labels and freezes the authored prompt through restart',async t=>{
 const resources=[],dataDir=await directory(t,resources),cwd=path.join(dataDir,'workspace');await mkdir(cwd);const engine=new Engine(),options={dataDir,engine},inbox=await new TaskInbox(options).init();resources.push(inbox);
 const workflow=createMissionWorkflow({id:'inbox-outline',task:outlined,cwd}),item=await inbox.add({input:outlined,workflow,cwd});
 assert.equal(item.title,'Build a chess game with SVG pieces');assert.equal(item.input,outlined);
 const named=await inbox.add({input:outlined,workflow,cwd,title:'My saved brief'});assert.equal(named.title,'My saved brief');await inbox.close();
 const restored=await new TaskInbox(options).init();resources.push(restored);assert.equal(restored.get(item.id).title,item.title);assert.equal(restored.get(item.id).input,outlined);assert.equal(restored.get(named.id).title,named.title);
});
