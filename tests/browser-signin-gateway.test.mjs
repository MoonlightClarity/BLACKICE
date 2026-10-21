import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectionToolHandler} from '../lib/mcp.mjs';
import {signedBrowserInstructions} from '../lib/signed-browser.mjs';

test('native Neo human-help tools cannot foreground or interrupt the user from an agent call',async()=>{
 let refreshed=0,called=0;
 const manager={
  signedBrowser:{connectionId:'browseros-neo'},
  refreshSignedBrowser:async()=>{refreshed++;return{available:true};},
  call:async()=>{called++;return{content:[{type:'text',text:'ok'}]};},
  redact:text=>text,
 };
 const gateway=createConnectionToolHandler({manager});
 for(const name of ['request_human_help','await_human_help']){
  const value=await gateway({name:'relay_connections',arguments:{action:'call',connectionId:'browseros-neo',name,arguments:{reason:'login'}}});
  assert.equal(value.success,false);
  assert.match(value.contentItems[0].text,/External Neo interaction is disabled/);
  assert.match(value.contentItems[0].text,/inside Observe/);
 }
 const createWindow=await gateway({name:'relay_connections',arguments:{action:'call',connectionId:'browseros-neo',name:'windows',arguments:{action:'create'}}});
 assert.equal(createWindow.success,false);
 assert.match(createWindow.contentItems[0].text,/External Neo interaction is disabled/);
 assert.equal(refreshed,0,'do not trigger a browser launch just to deny an intrusive action');
 assert.equal(called,0);
 const text=signedBrowserInstructions({available:true,connectionId:'browseros-neo'});
 assert.match(text,/do not call BrowserOS request_human_help/);
 assert.match(text,/only the user's explicit click may reveal BrowserOS/);
});

for(const failedResult of [false,true])test(`a retired native capture with a configured ${failedResult?'failure':'timeout'} cannot execute`,async()=>{
 const calls=[];
 const run={name:'run',description:'browser.pages.list() and browser.cdp(method) and browser.windows(opts)',inputSchema:{type:'object',properties:{code:{type:'string'},timeout:{type:'number'}}}};
 const manager={signedBrowser:{connectionId:'browseros-neo'},clients:new Map([['browseros-neo',{tools:[run]}]]),redact:text=>text,refreshSignedBrowser:async()=>({available:true}),call:async(_id,name)=>{calls.push(name);if(failedResult)return{isError:true,content:[{type:'text',text:'Capture failed.'}]};throw Error('Connected tool timed out.');}};
 const gateway=createConnectionToolHandler({manager});
 const result=await gateway({name:'relay_connections',arguments:{action:'call',connectionId:'browseros-neo',name:'screenshot',arguments:{page:7,fullPage:false,size:{width:1024,height:768}}}});
 assert.equal(result.success,false);assert.match(result.contentItems[0].text,/External Neo interaction is disabled/);
 assert.deepEqual(calls,[]);
});
