import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {ProjectStore} from '../lib/projects.mjs';
import {CapabilityStore} from '../lib/capabilities.mjs';
import {MethodStore} from '../lib/methods.mjs';
import {createProjectToolHandler,PROJECT_TOOL} from '../lib/project-tools.mjs';

const graph=id=>({id,name:'Project tool integration',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Coordinator',model:'fixture-model',prompt:'Follow the user request.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}});
const payload=response=>JSON.parse(response.contentItems[0].text);
test('an agent creates the shared project through its attached tool without executing it; saved native catalogs stay truthful',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-project-tool-')),cwd=path.join(root,'workspace');await mkdir(cwd);const calls=[];
  class Runtime extends EventEmitter{
    status(){return{connected:true,authenticated:true,defaultModel:'fixture-model'};}
    async runAgent(options){
      calls.push(options);
      if(calls.length===1){
        assert.ok(options.dynamicTools.some(tool=>tool.name===PROJECT_TOOL.name));
        assert.match(options.developerInstructions,/relay_project/);
        assert.match(options.developerInstructions,/planning|plan/i);
        const methods=await options.onToolCall({name:PROJECT_TOOL.name,arguments:{action:'methods'}});assert.equal(methods.success,true);assert.ok(payload(methods).methods.some(method=>method.id==='research-brief'),'the ordinary agent receives the shared method store through its actual engine handler');
        const created=await options.onToolCall({name:PROJECT_TOOL.name,arguments:{action:'create',project:{name:'Shared goal',objective:'Check an isolated result.',tasks:[{id:'check',title:'Check result',instructions:'Inspect output.',acceptanceCriteria:['A result was inspected.']}]}}});
        assert.equal(created.success,true);const project=payload(created);assert.equal(project.cwd,cwd);assert.equal(project.status,'draft');
        return{output:project.id,threadId:'native-project-parent',codexHistory:'codex'};
      }
      assert.ok(!options.dynamicTools.some(tool=>tool.name===PROJECT_TOOL.name));
      assert.ok(!options.developerInstructions.includes('"name":"relay_project"'));
      return{output:'No orchestration capability attached.',threadId:'native-project-parent',codexHistory:'codex'};
    }
  }
  const engine=await new HarnessEngine({runtime:new Runtime(),dataDir:path.join(root,'data'),defaultCwd:cwd}).init();
  const projects=await new ProjectStore({dataDir:path.join(root,'data'),engine}).init(),capabilities=await new CapabilityStore({dataDir:path.join(root,'data'),projects}).init(),methods=await new MethodStore({dataDir:path.join(root,'data'),projects}).init();
  engine.projects=projects;engine.capabilities=capabilities;engine.methods=methods;
  t.after(async()=>{await methods.close();await projects.close();await capabilities.close();await engine.close();assert.match(path.basename(root),/^blackice-project-tool-/);await rm(root,{recursive:true,force:true});});
  const first=engine.startRun({workflow:graph('ordinary-chat'),input:'Create a project draft.'});await engine.executions.get(first.id);
  const finished=engine.getRun(first.id);assert.equal(finished.status,'completed',finished.error);assert.equal(projects.get(finished.nodes.agent.output).status,'draft');assert.equal(calls.length,1,'draft creation does not launch any project workers');
  // Simulate a native conversation created before relay_project was introduced.
  engine.runs.get(first.id).nodes.agent.toolNames=finished.nodes.agent.toolNames.filter(name=>name!==PROJECT_TOOL.name);
  const continued=engine.continueRun(first.id,{nodeId:'agent',message:'Continue the older native session.'});await engine.executions.get(continued.id);
  assert.equal(engine.getRun(continued.id).status,'completed');assert.equal(calls[1].threadId,'native-project-parent');
  const worker=engine.startRun({workflow:graph('project-worker-receipt'),input:'Do the assigned task without orchestration.'});await engine.executions.get(worker.id);
  assert.equal(engine.getRun(worker.id).status,'completed');assert.equal(calls.length,3);
});

test('project tool reports bad arguments, unavailable records and stopped callers as failed outcomes',async()=>{
  const controller=new AbortController(),projects={get:()=>{throw Error('Project not found.');}},handler=createProjectToolHandler({projects,capabilities:{},cwd:path.resolve('.'),signal:controller.signal});
  for(const call of [{name:'wrong',arguments:{}},{name:PROJECT_TOOL.name,arguments:'{'},{name:PROJECT_TOOL.name,arguments:[]},{name:PROJECT_TOOL.name,arguments:{action:'get',id:'missing'}}]){
    const response=await handler(call);assert.equal(response.success,false);assert.equal(typeof payload(response).error,'string');
  }
  controller.abort();const stopped=await handler({name:PROJECT_TOOL.name,arguments:{action:'get',id:'missing'}});assert.equal(stopped.success,false);assert.match(payload(stopped).error,/stopped/i);
});

test('review_task prepares a real project review without execution until an explicit start and retains the original implementation',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-project-tool-')),cwd=path.join(root,'workspace'),calls=[];await mkdir(cwd);
  class Runtime extends EventEmitter{
    status(){return{connected:true,authenticated:true,defaultModel:'fixture-model'};}
    async runAgent(options){
      calls.push(options);const review=options.prompt.includes('You are Independent verifier.\n');
      if(!review){const written=await options.onToolCall({name:'relay_workspace',arguments:{action:'write',path:'marker.txt',text:'draft\n'}});assert.equal(written.success,true);return{output:'Wrote the original draft marker.'};}
      const observed=await options.onToolCall({name:'relay_workspace',arguments:{action:'read',path:'marker.txt'}});assert.equal(observed.success,true);const content=JSON.parse(observed.contentItems[0].text).content,passed=content.replace(/^\d+: ?/gm,'').trim()==='accepted';
      return{output:JSON.stringify({passed,summary:'Read the existing marker without changing it.',criteria:[{criterion:'marker.txt contains accepted',passed,evidence:`Observed ${content.trim()}.`}]})};
    }
  }
  const engine=await new HarnessEngine({runtime:new Runtime(),dataDir:path.join(root,'data'),defaultCwd:cwd}).init(),projects=await new ProjectStore({dataDir:path.join(root,'data'),engine}).init();const savedStart=engine.startRun.bind(engine);engine.startRun=request=>savedStart({...request,planningMode:'off'});clearTimeout(projects.timer);projects.timer=null;projects.kick=()=>{};
  t.after(async()=>{await projects.close();await engine.close();assert.match(path.basename(root),/^blackice-project-tool-/);await rm(root,{recursive:true,force:true});});
  const project=await projects.create({name:'Review existing marker',objective:'Check a marker without repeating implementation.',cwd,maxRepairs:0,tasks:[{id:'marker',title:'Marker',instructions:'Write marker.txt and inspect it.',acceptanceCriteria:['marker.txt contains accepted']}]});
  await projects.start(project.id);await projects.poll();await engine.executions.get(projects.get(project.id).tasks[0].attempts[0].implementation.runId);await projects.poll();await engine.executions.get(projects.get(project.id).tasks[0].attempts[0].verification.runId);await projects.poll();const original=projects.get(project.id).tasks[0].attempts[0];assert.equal(calls.length,2);
  await writeFile(path.join(cwd,'marker.txt'),'accepted\n');const handler=createProjectToolHandler({projects,capabilities:{},cwd}),describe=payload(await handler({name:PROJECT_TOOL.name,arguments:{action:'describe'}}));assert.ok(describe.tool.inputSchema.properties.action.enum.includes('review_task'));assert.ok(describe.notes.some(note=>note.includes('review_task')&&note.includes('starts no work')));
  const staged=await handler({name:PROJECT_TOOL.name,arguments:JSON.stringify({action:'review_task',id:project.id,taskId:'marker'})});assert.equal(staged.success,true);const prepared=payload(staged);assert.equal(prepared.status,'paused');assert.equal(prepared.tasks[0].attempts[1].verification.status,'prepared');assert.deepEqual(prepared.tasks[0].attempts[1].implementation,original.implementation);await projects.poll();assert.equal(calls.length,2);
  const repeated=await handler({name:PROJECT_TOOL.name,arguments:{action:'review_task',id:project.id,taskId:'marker'}});assert.equal(repeated.success,false);assert.match(payload(repeated).error,/Only a blocked task/);
  assert.equal((await handler({name:PROJECT_TOOL.name,arguments:{action:'start',id:project.id}})).success,true);await projects.poll();await engine.executions.get(projects.get(project.id).tasks[0].attempts[1].verification.runId);await projects.poll();const finished=projects.get(project.id);assert.equal(finished.status,'completed',JSON.stringify(finished.tasks[0]));assert.equal(calls.length,3);assert.equal(finished.tasks[0].attempts[1].implementation.runId,original.implementation.runId);assert.notEqual(finished.tasks[0].verification.runId,original.verification.runId);assert.equal(calls.filter(call=>call.prompt.includes('You are Project implementer.\n')).length,1);
});
