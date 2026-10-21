import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopToolHandler,desktopToolForContainment,DESKTOP_TOOL} from '../lib/desktop-tools.mjs';
test('contained mode exposes only native inspection and blocks native mutations before provider calls',async()=>{
 const calls=[];const desktop={status:()=>({enabled:true}),perform:async args=>{calls.push(args.action);return{windows:[]};}};
 const handler=createDesktopToolHandler({desktop,contained:true});
 for(const action of ['invoke','set_value','toggle','select','expand','collapse','scroll','scroll_into_view','focus']) await assert.rejects(handler({name:'relay_desktop',arguments:{action,ref:'observed-native-control'}}),/read-only inspection|Physical input is disabled/);
 assert.equal(calls.length,0);assert.equal((await handler({name:'relay_desktop',arguments:{action:'windows'}})).success,true);assert.deepEqual(calls,['windows']);
 const tool=desktopToolForContainment(true);assert.deepEqual(tool.inputSchema.properties.action.enum,['screenshot','windows','inspect','get_text','wait']);assert.match(tool.description,/Read-only inspection/);assert.ok(!DESKTOP_TOOL.inputSchema.properties.action.enum.includes('invoke'),'uncontained and legacy callers do not gain mutation');assert.deepEqual(desktopToolForContainment(false),tool);
});
