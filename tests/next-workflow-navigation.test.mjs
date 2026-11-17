import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createSwarmWorkspace} from '../public/next/workspaces/swarm.mjs';
import {readFile} from 'node:fs/promises';
test('Swarm exposes existing reusable workflow manager without starting work',async t=>{
 const d=planningDOM(t),calls=[],navigation=[];
 const panel=createSwarmWorkspace({mount:d.mount,api:async(route,method='GET')=>{calls.push({route,method});return {projects:[]};},events:{subscribe:()=>()=>{}},onNavigate:(...args)=>navigation.push(args)});
 t.after(()=>panel.destroy());panel.enter();await new Promise(r=>setImmediate(r));
 await d.click('.swarm-workflows');assert.deepEqual(navigation,[['workflows']]);assert.equal(calls.some(x=>x.method!=='GET'),false);
});
test('workflow manager describes immediate and scheduled use without changing run controls',async()=>{
 const source=await readFile(new URL('../public/next/workspaces/workflow-execution.mjs',import.meta.url),'utf8');
 assert.match(source,/Run one now, or use it in a cronjob/);
 assert.match(source,/id="next-workflow-start">Run workflow/);
});
