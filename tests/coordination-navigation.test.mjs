import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {coordinationNavigation} from '../public/coordination-navigation.mjs';


test('the real server serves navigation assets and the complete Planning, Swarms and Schedules module graphs',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-navigation-http-'));let app,workerCalls=0;
  t.after(async()=>{await app?.close();assert.match(path.basename(directory),/^blackice-navigation-http-/);await rm(directory,{recursive:true,force:true});});
  class Runtime extends EventEmitter{
    status(){return{connected:true,authenticated:true,models:[{model:'navigation-http-fixture'}],defaultModel:'navigation-http-fixture'};}
    async start(){return this.status();}async close(){}
    async runAgent(){workerCalls++;throw Error('Reading navigation assets must never start a worker.');}
  }
  class Desktop extends EventEmitter{status(){return{available:false,enabled:false};}async setEnabled(){return this.status();}}
  app=await createHarnessServer({port:0,dataDir:path.join(directory,'data'),defaultCwd:directory,runtime:new Runtime(),desktop:new Desktop()});
  await app.learning.updateSettings({mode:'manual'});const base=await app.listen(),fetched=new Map();
  async function asset(route,mime){
    const response=await fetch(new URL(route,base));assert.equal(response.status,200,route);assert.match(response.headers.get('content-type')||'',mime,route);
    const source=await response.text(),expected=await readFile(new URL('../public'+route,import.meta.url),'utf8');assert.equal(source,expected,route+' serves its actual source');
    const head=await fetch(new URL(route,base),{method:'HEAD'});assert.equal(head.status,200,'HEAD '+route);assert.equal(head.headers.get('content-type'),response.headers.get('content-type'),'HEAD MIME '+route);assert.equal(await head.text(),'','HEAD body '+route);
    return source;
  }
  async function moduleGraph(route){
    if(fetched.has(route))return;const source=await asset(route,/javascript/);fetched.set(route,source);
    const imports=[...source.matchAll(/\b(?:import|export)\s*(?:[^'";]*?\s*from\s*)?['"](\.[^'"]+)['"]/g)].map(match=>new URL(match[1],new URL(route,base)).pathname);
    for(const dependency of imports)await moduleGraph(dependency);
  }
  for(const root of ['/planning-workspace-ui.mjs','/projects-ui.mjs','/advanced-ui.mjs']){
    await moduleGraph(root);
    assert.match(fetched.get(root),/from\s*['"]\.\/coordination-navigation\.mjs['"]/,'shared navigation import in '+root);
  }
  assert.ok(fetched.has('/coordination-navigation.mjs'),'all workspace imports resolve to the served shared module');
  const css=await asset('/coordination-navigation.css',/css/);assert.match(css,/\.coordination-navigation/);
  const legacy=await fetch(new URL('/legacy/',base),{redirect:'manual'});assert.equal(legacy.status,302);assert.equal(legacy.headers.get('location'),'/');
  const home=await fetch(new URL('/',base)),html=await home.text();assert.equal(home.status,200);assert.match(html,/src="\/next\/app\.mjs"/);
  assert.equal(workerCalls,0);
});

test('coordination navigation names the same destinations with exactly one current area',()=>{
  for(const current of ['planning','swarms','schedules']){
    const html=coordinationNavigation(current);
    assert.deepEqual([...html.matchAll(/data-action="([^"]+)"/g)].map(match=>match[1]),['planning','projects','operations']);
    assert.equal([...html.matchAll(/aria-current="page" disabled/g)].length,1);
    assert.match(html,/aria-label="Planning, swarms and schedules"/);
    assert.doesNotMatch(html,/data-op="run"|data-project="start"|type="submit"/);
  }
});

test('five classic workspace tabs remain reachable alongside on-demand peer work areas',async()=>{
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/coordination-navigation.css',import.meta.url),'utf8');
  const tabs=/<nav role="tablist" aria-label="Workspace mode">([\s\S]*?)<\/nav>/.exec(app)[1];
  assert.deepEqual([...tabs.matchAll(/data-mode="([^"]+)"/g)].map(match=>match[1]),['view','observe','planning','tasks','configure']);
  assert.doesNotMatch(app,/class="workspace-projects"|class="workspace-schedules"/);
  const menu=/<details class="workspace-menu">([\s\S]*?)<\/details>/.exec(app)[1];
  assert.match(menu,/<button data-action="projects">Swarms<\/button>/);
  assert.match(menu,/<button data-action="planning">Planning workspace<\/button>/);
  assert.match(menu,/<button data-action="operations">Tasks &amp; schedules<\/button>/);
  for(const area of ['planning','swarms','schedules']){
    const chooser=coordinationNavigation(area),details=/<details\b([^>]*)>/.exec(chooser);
    assert.ok(details,'work-area chooser is a keyboard-operable native disclosure');
    assert.doesNotMatch(details[1],/\bopen\b/,'peer destinations stay closed until requested');
    assert.match(chooser,/aria-label="Work area: (Planning|Swarms|Schedules)"/);
  }
  assert.match(css,/summary:focus-visible/);
});
