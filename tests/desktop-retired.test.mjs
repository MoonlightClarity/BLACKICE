import test from 'node:test';
import assert from 'node:assert/strict';
import {RetiredDesktopController,createRetiredDesktopToolHandler} from '../lib/desktop-retired.mjs';
test('retired desktop cannot attach inspect capture or mutate and owns no native runner',async()=>{
 const desktop=new RetiredDesktopController();assert.equal(desktop.status().retired,true);assert.equal(desktop.runner,undefined);
 assert.throws(()=>desktop.setEnabled(true),{code:'DESKTOP_RETIRED'});
 for(const action of ['windows','inspect','screenshot','invoke','set_value','focus'])await assert.rejects(desktop.perform({action}),e=>e.code==='DESKTOP_RETIRED'&&e.actionDispatched===false);
 assert.equal(desktop.setEnabled(false).enabled,false);
 const reply=await createRetiredDesktopToolHandler()({name:'relay_desktop',arguments:{action:'invoke'}});assert.equal(reply.code,'DESKTOP_RETIRED');assert.equal(JSON.parse(reply.contentItems[0].text).actionDispatched,false);
});
import { readFile } from 'node:fs/promises';
test('desktop launcher never enables retired UIA during bootstrap',async()=>{
 const source=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/harness\.desktop\.setEnabled\(true\)/);
 assert.match(source,/harness = local\.instance;/);
 assert.match(source,/desktopLifecycle\.start\(\)/);
});
