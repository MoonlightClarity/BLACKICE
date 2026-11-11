import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderPlanningDirectExecution} from '../public/planning-workspace-ui.mjs';
test('direct projection disclosure labels stale UNKNOWN evidence without claiming canonical completion',()=>{
 const state={directExecution:{provenance:'host-direct-outcome-store',authority:'evidence-projection-only',sourceStatus:'stale',source:{revision:2},currentSource:{revision:3},bindings:[{effectState:'UNKNOWN',unresolvedEffect:true}],measurement:{criteria:[{id:'<img src=x onerror=alert(1)>',observedCount:0,targetCount:1,reason:'Only host confirmed outcomes count.'}]},operations:[{id:'dispatch'}]}};
 const html=renderPlanningDirectExecution(state);
 for(const value of ['Direct execution evidence','Historical plan snapshot','UNKNOWN','Canonical completion is unchanged','not current revision 3','not a successful execution claim','&lt;img'])assert.ok(html.includes(value),value);
 assert.ok(!html.includes('<img'));
 assert.equal(renderPlanningDirectExecution({}),'');
 assert.equal(renderPlanningDirectExecution({directExecution:{...state.directExecution,provenance:'caller'}}),'');
 const source=readFileSync(new URL('../public/next/workspaces/planning.mjs',import.meta.url),'utf8');
 assert.ok(source.includes('renderPlanningDirectExecution(draft.latest)'));
});
