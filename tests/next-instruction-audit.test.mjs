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
import {BLACKICE_HARNESS_INSTRUCTIONS} from '../lib/harness-identity.mjs';

const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const audit=(content='Act on the requested outcome.')=>({
  version:1,captureStage:'adapter-prepared',capturedAt:'2026-11-20T23:00:00Z',
  sections:[{id:'soul',title:'SOUL.md',source:'identity/SOUL.md',role:'user',revision:3,reason:'Active execution identity',text:content,characters:content.length,sha256:'a'.repeat(64),status:'accepted'}],
  totals:{characters:content.length,sections:1},tools:{count:1,names:['relay_workspace'],sha256:'b'.repeat(64)},
  notes:['Provider-owned instructions are outside this capture.']
});
const snapshot=(id,content)=>({runId:id,status:'completed',nodes:[{nodeId:'agent',name:'Agent',audit:audit(content)}]});
const index=(runs=[])=>({version:'2.40.68',core:{source:'lib/harness-identity.mjs',text:'Built-in execution mechanics.'},runs});
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

test('Instructions sits beside SOUL and USER without discarding a draft or writing configuration',async t=>{
  const f=planningDOM(t),calls=[];
  const api=async(route,method='GET')=>{
    calls.push({route,method});
    if(route==='/api/identity/soul')return identity('soul');
    if(route==='/api/identity/user')return identity('user');
    if(route==='/api/instructions')return index([{id:'captured',title:'Captured turn',captured:true}]);
    if(route==='/api/runs/captured/instructions')return snapshot('captured','Captured SOUL revision 3.');
    throw Error('Unexpected route: '+route);
  };
  const panel=createIdentitySettings({mount:f.mount,api});
  t.after(()=>panel.destroy());panel.enter();await settle();
  assert.deepEqual(calls.map(row=>row.route),['/api/identity/soul'],'Audit sources load only after selecting Instructions.');
  await f.input('#next-identity-content','Unsaved SOUL draft');
  await f.click('#next-identity-instructions');await settle();
  assert.equal(f.$('#next-identity-instructions').getAttribute('aria-selected'),'true');
  assert.equal(f.$('#next-identity-editor').hidden,true);
  assert.equal(f.$('#next-identity-instructions-panel').hidden,false);
  assert.match(f.$('#next-identity-instructions-panel').textContent,/Captured SOUL revision 3/);
  await f.key(f.$('#next-identity-instructions'),'ArrowLeft');await settle();
  assert.equal(f.$('#next-identity-user').getAttribute('aria-selected'),'true');
  await f.click('#next-identity-soul');
  assert.equal(f.$('#next-identity-content').value,'Unsaved SOUL draft');
  assert.ok(calls.every(row=>row.method==='GET'),'Inspecting instructions never saves defaults or edits identity.');
});

test('late audit responses cannot overwrite another selected turn',async t=>{
  const f=planningDOM(t),a=deferred(),b=deferred(),calls=[];
  const api=async(route,method,payload,options)=>{
    calls.push({route,signal:options?.signal});
    if(route==='/api/instructions')return index([{id:'a',title:'First',captured:true},{id:'b',title:'Second',captured:true}]);
    if(route==='/api/runs/a/instructions')return a.promise;
    if(route==='/api/runs/b/instructions')return b.promise;
    throw Error(route);
  };
  const panel=createInstructionSettings({mount:f.mount,api});
  t.after(()=>panel.destroy());panel.enter();await settle();
  await f.input('#next-instructions-run-id','b');await f.$('form').dispatch('submit');
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
  const panel=createInstructionSettings({mount:f.mount,api:async route=>route==='/api/instructions'?
    index([{id:'old',title:'Old run',captured:false}]):{runId:'old',status:'completed',nodes:[{nodeId:'agent',name:'Agent',audit:null}]}});
  t.after(()=>panel.destroy());panel.enter();await settle();
  assert.match(f.$('#next-instructions-content').textContent,/no saved instruction snapshot/);
  assert.equal(f.$('#next-instructions-download').disabled,true);
  assert.doesNotMatch(f.$('#next-instructions-content').textContent,/Built-in execution mechanics/);
  assert.match(f.$('#next-instructions-core').textContent,/current configuration/);
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
  assert.match(f.$('.next-instruction-worker').textContent,/separate instruction snapshot/);
  assert.deepEqual(parent,original,'Reading and exporting do not fold worker sources into parent totals.');
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
  const current=await get('/api/instructions');assert.equal(current.status,200);
  const config=await current.json();assert.equal(config.core.text,BLACKICE_HARNESS_INSTRUCTIONS);assert.ok(Array.isArray(config.runs));
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
  for(const route of ['/next/workspaces/settings-instructions.mjs','/next/workspaces/instruction-audit.mjs','/next/instruction-audit.css']){
    const result=await get(route);assert.equal(result.status,200,route);assert.ok((await result.text()).length>30);
  }
  app.engine.runs.delete('fixture-instructions');
});
