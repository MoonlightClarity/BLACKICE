import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {instructionAuditText,renderInstructionAudit} from '../public/next/workspaces/instruction-audit.mjs';
import {createInstructionSettings} from '../public/next/workspaces/settings-instructions.mjs';
import {createIdentitySettings} from '../public/next/workspaces/settings-identity.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createHarnessServer} from '../server.mjs';
import {createHash} from 'node:crypto';

const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const audit=(content='Act on the requested outcome.')=>({
  version:1,captureStage:'adapter-prepared',capturedAt:'2026-11-20T23:00:00Z',
  sections:[{id:'soul',title:'SOUL.md',source:'identity/SOUL.md',role:'user',revision:3,reason:'Active execution identity',text:content,characters:content.length,sha256:'a'.repeat(64),status:'accepted'}],
  totals:{characters:content.length,sections:1},tools:{count:1,names:['relay_workspace'],sha256:'b'.repeat(64)},
  notes:['Provider-owned instructions are outside this capture.']
});
const snapshot=(id,content)=>({runId:id,status:'completed',nodes:[{nodeId:'agent',name:'Agent',audit:audit(content)}]});
const core=()=>{const content='Profile saved execution instructions.';return{content,text:content,revision:0,hash:createHash('sha256').update(content).digest('hex'),source:'initial-default',path:'instructions/core.md',characters:content.length,updatedAt:'2026-11-20T23:00:00Z'};};
const index=(runs=[])=>({version:'2.40.68',core:core(),runs});
const identity=kind=>({kind,revision:1,content:kind+' saved',hash:'a'.repeat(64),diskHash:'a'.repeat(64),path:kind+'.md'});

test('readable export preserves complete captured text and labels missing historic snapshots',()=>{
  const content='Keep <tag> and quotes "exactly".\n\n'+('Long source paragraph. '.repeat(1100))+'\nFinal source line.';
  const actual=instructionAuditText(snapshot('turn-a',content));
  assert.ok(actual.includes(content),'Full captured text must not be shortened to an excerpt.');
  assert.match(actual,/Layer: Prompt layer/);
  assert.match(actual,/Source: identity\/SOUL.md/);
  assert.match(actual,/Revision: 3/);
  assert.match(actual,/Provider-owned instructions are outside this capture/);
  const old=instructionAuditText({runId:'old',nodes:[{nodeId:'agent',audit:null}]});
  assert.match(old,/no saved instruction snapshot/);
  assert.doesNotMatch(old,/Built-in execution mechanics/,'Never substitute current configuration for a historical snapshot.');
});

test('audit labels excerpts and shows delivered skill totals and repeated deliveries',t=>{
  const f=planningDOM(t),captured=audit('Leading and trailing SOUL excerpt.');
  captured.sections[0].truncated=true;
  const skill='Use the configured source.';
  captured.sections.push({id:'loaded-skill',title:'Loaded skill',source:'Owner skill: example',role:'tool',text:skill,characters:skill.length,status:'delivered',deliveries:2});
  Object.assign(captured.totals,{characters:captured.sections[0].text.length+skill.length,promptInstructionCharacters:captured.sections[0].text.length,toolInstructionCharacters:skill.length,sections:2});
  renderInstructionAudit(f.mount,captured);
  assert.match(f.$('details summary').textContent,/Excerpt — middle omitted/,'Excerpt status must be visible before expansion.');
  assert.match(f.mount.textContent,new RegExp('Delivered skill instructions: '+skill.length+' characters'));
  assert.match(f.mount.textContent,/Deliveries2/);
  const exported=instructionAuditText({runId:'excerpt',nodes:[{nodeId:'agent',audit:captured}]});
  assert.match(exported,/Scope: Excerpt — middle omitted/);
  assert.match(exported,/Deliveries: 2/);
  assert.match(exported,new RegExp('Delivered skill instructions: '+skill.length+' characters'));
});

test('tool definitions stay separate from delivered skill content and system instructions',t=>{
  const f=planningDOM(t),captured=audit();
  const definition='Open the selected page.\nParameter url: Address to open.';
  const skill='Follow the active owner procedure.';
  captured.sections.push({id:'browser-description',title:'relay_browser definition',source:'Saved native tool catalog',role:'tool',layer:'tool-definition',providerField:'dynamicTools',reason:'Native session catalog captured at dispatch',text:definition,characters:definition.length,status:'attached'},
    {id:'loaded-skill',title:'Loaded skill',source:'Owner skill: browser',role:'tool',layer:'tool',text:skill,characters:skill.length,status:'delivered'});
  Object.assign(captured.totals,{characters:captured.sections[0].text.length+definition.length+skill.length,toolDefinitionCharacters:definition.length,toolInstructionCharacters:skill.length,sections:3});
  renderInstructionAudit(f.mount,captured);
  const groups=[...f.mount.querySelectorAll('.next-instruction-layer')];
  const definitions=groups.find(group=>group.querySelector('h3').textContent==='Tool definitions');
  const delivered=groups.find(group=>group.querySelector('h3').textContent==='Delivered skill instructions');
  assert.ok(definitions);assert.ok(delivered);
  assert.ok(definitions.textContent.includes(definition));assert.ok(!definitions.textContent.includes(skill));
  assert.ok(delivered.textContent.includes(skill));assert.ok(!delivered.textContent.includes(definition));
  assert.match(definitions.textContent,/Saved native tool catalog/);assert.match(definitions.textContent,/Request fielddynamicTools/);
  assert.match(f.mount.textContent,new RegExp('Tool definitions: '+definition.length+' characters'));
  const exported=instructionAuditText({runId:'tools',nodes:[{nodeId:'agent',audit:captured}]});
  assert.match(exported,/Layer: Tool definitions/);
  assert.match(exported,/Layer: Delivered skill instructions/);
  assert.match(exported,/Request field: dynamicTools/);
  assert.ok(exported.includes(definition));assert.ok(exported.includes(skill));
  assert.ok(!exported.includes('Layer: Developer / system layer'));assert.ok(!exported.includes('Layer: System layer'));
});

test('audit rendering keeps HTML-shaped instructions inert and preserves provenance',t=>{
  const f=planningDOM(t),content='<img src=x onerror="alert(1)">\nDo not collapse this source.';
  renderInstructionAudit(f.mount,audit(content));
  assert.equal(f.$('img'),null);
  assert.equal(f.$('.next-instruction-text').textContent,content);
  assert.match(f.mount.textContent,/SOUL.md/);
  assert.match(f.mount.textContent,/identity\/SOUL.md/);
  assert.match(f.mount.textContent,/Active execution identity/);
  assert.equal(f.$('details').open,false,'Instruction bodies begin collapsed.');
});

test('Config contains SOUL and USER only; switching preserves unsaved drafts without writing Runtime',async t=>{
  const f=planningDOM(t),calls=[];
  const api=async(route,method='GET')=>{
    calls.push({route,method});
    if(route==='/api/identity/soul')return identity('soul');
    if(route==='/api/identity/user')return identity('user');
    throw Error('Unexpected route: '+route);
  };
  const panel=createIdentitySettings({mount:f.mount,api});
  t.after(()=>panel.destroy());panel.enter();await settle();
  assert.deepEqual(calls.map(row=>row.route),['/api/identity/soul']);
  assert.equal(f.$('#next-identity-instructions'),null);
  assert.equal(f.$('#next-identity-tools'),null);
  assert.equal(f.$('#next-developer-layer-text'),null);
  await f.input('#next-identity-content','Unsaved SOUL draft');
  await f.click('#next-identity-user');await settle();
  assert.equal(f.$('#next-identity-user').getAttribute('aria-selected'),'true');
  await f.click('#next-identity-soul');
  assert.equal(f.$('#next-identity-content').value,'Unsaved SOUL draft');
  assert.ok(calls.every(row=>row.method==='GET'),'Config navigation must never edit Runtime instructions.');
});

test('late audit responses cannot overwrite another selected turn',async t=>{
  const f=planningDOM(t),a=deferred(),b=deferred(),calls=[];
  const api=async(route,method,payload,options)=>{
    calls.push({route,signal:options?.signal});
    if(route==='/api/instructions')return index([{id:'a',title:'First',captured:true},{id:'b',title:'Second',captured:true}]);
    if(route==='/api/instructions/core')return core();
    if(route==='/api/runs/a/instructions')return a.promise;
    if(route==='/api/runs/b/instructions')return b.promise;
    throw Error(route);
  };
  const panel=createInstructionSettings({mount:f.mount,api});
  t.after(()=>panel.destroy());panel.enter();await settle();
  await f.input('#next-instructions-run-id','b');await f.$('#next-instructions-audit-form').dispatch('submit');
  b.resolve(snapshot('b','Correct second turn'));await settle();
  a.resolve(snapshot('a','Stale first turn'));await settle();
  assert.match(f.mount.textContent,/Correct second turn/);
  assert.doesNotMatch(f.mount.textContent,/Stale first turn/);
  assert.equal(calls.find(row=>row.route==='/api/runs/a/instructions').signal.aborted,true);
  panel.leave();
  assert.equal(calls.find(row=>row.route==='/api/runs/b/instructions').signal.aborted,true);
});

test('missing historical snapshots stay unavailable and cannot be exported as current text',async t=>{
  const f=planningDOM(t);
  const panel=createInstructionSettings({mount:f.mount,api:async route=>route==='/api/instructions/core'?core():route==='/api/instructions'?
    index([{id:'old',title:'Old run',captured:false}]):{runId:'old',status:'completed',nodes:[{nodeId:'agent',name:'Agent',audit:null}]}});
  t.after(()=>panel.destroy());panel.enter();await settle();
  assert.match(f.$('#next-instructions-content').textContent,/no saved instruction snapshot/);
  assert.equal(f.$('#next-instructions-download').disabled,true);
  assert.doesNotMatch(f.$('#next-instructions-content').textContent,/Built-in execution mechanics/);
  assert.equal(f.$('#next-instructions-text').value,core().content);
});

test('delegated workers have separate readable sections and complete exports',t=>{
  const f=planningDOM(t),parent=audit('Parent mechanics');
  parent.delegates=[{id:'worker-one',nodeId:'delegate-1',label:'Independent reviewer',audit:audit('Worker-specific instructions')},
    {id:'worker-missing',label:'Uncaptured worker',audit:null}];
  const original=structuredClone(parent),record={runId:'delegated',nodes:[{nodeId:'agent',name:'Agent',audit:parent}]};
  const result=instructionAuditText(record);
  assert.match(result,/DELEGATED WORKER: Independent reviewer/);
  assert.match(result,/Worker-specific instructions/);
  assert.match(result,/This delegated worker has no saved instruction snapshot/);
  renderInstructionAudit(f.mount,parent);
  assert.equal(f.mount.querySelectorAll('.next-instruction-worker').length,2);
  assert.match(f.$('.next-instruction-worker').textContent,/Separate instruction snapshot/);
  assert.deepEqual(parent,original,'Reading and exporting do not fold worker sources into parent totals.');
});


test('planning preparations remain distinct from parent and delegated worker captures',t=>{
  const f=planningDOM(t),parent=audit('Parent execution instructions.');
  const preparation='<script>Do not execute this.</script>\nExact planning procedure.';
  parent.preparations=[{id:'preparation-one',label:'Task planning',audit:audit(preparation)},
    {id:'preparation-missing',label:'Earlier uncaptured preparation',audit:null}];
  parent.delegates=[{id:'worker',label:'Review',audit:audit('Worker procedure.')}];
  const original=structuredClone(parent);
  renderInstructionAudit(f.mount,parent);
  const preparations=[...f.mount.querySelectorAll('.next-instruction-preparation')];
  assert.equal(preparations.length,2);
  assert.match(preparations[0].querySelector('summary').textContent,/Planning preparation · Task planning/);
  assert.equal(preparations[0].querySelector('.next-instruction-text').textContent,preparation);
  assert.equal(f.$('script'),null);
  assert.match(preparations[1].textContent,/This planning preparation has no saved instruction snapshot/);
  assert.equal(f.mount.querySelectorAll('.next-instruction-worker').length,1);
  const exported=instructionAuditText({runId:'prepared',nodes:[{nodeId:'agent',audit:parent}]});
  assert.match(exported,/PLANNING PREPARATION: Task planning/);
  assert.ok(exported.includes(preparation));
  assert.match(exported,/DELEGATED WORKER: Review/);
  assert.match(exported,/This planning preparation has no saved instruction snapshot/);
  assert.deepEqual(parent,original,'Nested preparation text never changes parent totals or other snapshots.');
});

test('context summaries stay separate from planning and preserve the main snapshot revision',t=>{
  const f=planningDOM(t),main=audit('Main execution instructions.'),planning=audit('Planning preparation instructions.'),summary=audit('Context compaction instructions.');
  main.sections[0].revision=7;planning.sections[0].revision=8;summary.sections[0].revision=9;
  main.preparations=[{id:'planning',label:'Plan request',audit:planning},
    {id:'summary',kind:'context-summary',label:'Compact retained context',audit:summary}];
  const original=structuredClone(main);
  renderInstructionAudit(f.mount,main);
  const nested=[...f.mount.querySelectorAll('.next-instruction-nested')];
  assert.equal(nested.length,2);
  const planned=nested.find(item=>item.querySelector('summary').textContent.startsWith('Planning preparation'));
  const compacted=nested.find(item=>item.querySelector('summary').textContent.startsWith('Context summary'));
  assert.ok(planned);assert.ok(compacted);assert.notEqual(planned,compacted);
  assert.ok(planned.textContent.includes(planning.sections[0].text));assert.ok(!planned.textContent.includes(summary.sections[0].text));
  assert.ok(compacted.textContent.includes(summary.sections[0].text));assert.ok(!compacted.textContent.includes(planning.sections[0].text));
  assert.match(f.$('.next-instruction-layer').textContent,/Revision7/);
  const exported=instructionAuditText({runId:'context-summary',nodes:[{nodeId:'agent',audit:main}]});
  assert.match(exported,/PLANNING PREPARATION: Plan request/);
  assert.match(exported,/CONTEXT SUMMARY: Compact retained context/);
  assert.doesNotMatch(exported,/PLANNING PREPARATION: Compact retained context/);
  assert.match(exported.split('PLANNING PREPARATION:')[0],/Revision: 7/);
  assert.equal(main.sections[0].revision,7);assert.deepEqual(main,original,'Reading internal captures does not replace or mutate the main execution snapshot.');
});

class QuietRuntime extends EventEmitter {
  status(){return{connected:true,authenticated:true,defaultModel:'fixture-model',activeTurns:0};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){throw Error('This audit test must never launch a model.');}
}

test('real audit HTTP routes return captured sources without returning task/profile payloads',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-instruction-ui-'));
  const cwd=path.join(directory,'workspace');await mkdir(cwd);
  const app=await createHarnessServer({runtime:new QuietRuntime(),port:0,dataDir:path.join(directory,'data'),defaultCwd:cwd});
  const url=await app.listen();
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const initial=await fetch(url),cookie=initial.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const get=route=>fetch(new URL(route,url),{headers:{Cookie:cookie}});
  assert.equal((await get('/api/instructions/developer-layer')).status,404,'the global override route is retired');
  const forbidden=await fetch(new URL('/api/instructions/developer-layer',url),{method:'PUT',
    headers:{Cookie:cookie,Origin:new URL(url).origin,'Content-Type':'application/json'},
    body:JSON.stringify({content:'SHOULD_NOT_BE_WRITTEN'})});
  assert.equal(forbidden.status,404,'the removed override cannot accept a write');
  const current=await get('/api/instructions');assert.equal(current.status,200);
  const config=await current.json(),saved=await (await get('/api/instructions/core')).json();
  assert.deepEqual(config.core,saved);assert.equal(saved.text,saved.content);assert.equal(saved.revision,0);assert.equal(saved.source,'initial-default');
  assert.equal(saved.hash,createHash('sha256').update(saved.content).digest('hex'));assert.ok(Array.isArray(config.runs));
  const source=audit('Saved instruction text');
  app.engine.runs.set('fixture-instructions',{id:'fixture-instructions',createdAt:'2026-11-20T23:00:00Z',status:'completed',settled:true,
    input:'PRIVATE TASK BODY',output:'PRIVATE RESULT',events:[],workflow:{nodes:[{id:'agent',name:'Agent'}],edges:[]},
    nodes:{agent:{status:'completed',instructionAudit:source,output:'PRIVATE NODE OUTPUT'}}});
  const captured=await get('/api/runs/fixture-instructions/instructions');assert.equal(captured.status,200);
  const payload=await captured.json();assert.deepEqual(payload.nodes[0].audit,source);
  assert.equal(payload.runId,'fixture-instructions');
  assert.doesNotMatch(JSON.stringify(payload),/PRIVATE TASK|PRIVATE RESULT|PRIVATE NODE/);
  app.engine.runs.get('fixture-instructions').nodes.agent.instructionAudit=null;
  const old=await (await get('/api/runs/fixture-instructions/instructions')).json();assert.equal(old.nodes[0].audit,null);
  for(const route of ['/next/workspaces/runtime.mjs','/next/runtime.css','/next/workspaces/instruction-audit.mjs','/next/instruction-audit.css']){
    const result=await get(route);assert.equal(result.status,200,route);assert.ok((await result.text()).length>30);
  }
  for(const route of ['/next/workspaces/settings-instruction-editor.mjs','/next/workspaces/settings-instructions.mjs',
   '/next/workspaces/settings-execution-layers.mjs','/next/workspaces/settings-tool-descriptions.mjs'])
    assert.equal((await get(route)).status,404,'retired duplicate editor route: '+route);
  app.engine.runs.delete('fixture-instructions');
});

test('instruction audits remain readable without an obsolete Developer/System override',async t=>{
  const f=planningDOM(t),run=snapshot('layer-test','Task prompt'),calls=[];
  run.nodes[0].audit.sections.push({id:'core',title:'System instructions',source:'Saved canonical instruction record',
    role:'developer',layer:'developer',text:'Exact saved core',status:'accepted'});
  const settings=createInstructionSettings({mount:f.mount,api:async(route,method)=>{
    calls.push({route,method});
    if(route==='/api/instructions/core')return core();
    if(route==='/api/instructions')return index([{id:run.runId,captured:true}]);
    if(route==='/api/runs/layer-test/instructions')return run;
    throw Error(route);
  }});
  t.after(()=>settings.destroy());settings.enter();await settle();
  assert.equal(f.$('#next-developer-layer-text'),null);
  assert.match(f.$('#next-instructions-content').textContent,/Exact saved core/);
  assert.ok(calls.every(call=>call.method==='GET'));
});
