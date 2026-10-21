import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectionToolHandler} from '../lib/mcp.mjs';
import {signedBrowserInstructions} from '../lib/signed-browser.mjs';

function managerFixture(onCall){
 const catalog=['request_human_help','await_human_help','windows','screenshot'].map(name=>({name,inputSchema:{type:'object',additionalProperties:true}}));
 const config={id:'browseros-neo',name:'BrowserOS Neo',enabled:true,connected:true},client={tools:catalog,connected:true};
 return{signedBrowser:{connectionId:config.id},configs:new Map([[config.id,config]]),clients:new Map([[config.id,client]]),list:()=>[config],connect:async()=>client,redact:String,call:async(id,name,args,options)=>{options.onDispatch?.();return onCall(id,name,args);}};
}

test('discovered native human-help and window tools remain available with native interaction requirements',async()=>{
 const calls=[];
 const manager=managerFixture(async(id,name,args)=>{calls.push({id,name,args});return{content:[{type:'text',text:'Native interaction requested.'}]};});
 const gateway=createConnectionToolHandler({manager});
 assert.deepEqual(calls,[]);
 for(const name of ['request_human_help','await_human_help']){
  const value=await gateway({name:'relay_connections',arguments:{action:'call',connectionId:'browseros-neo',name,arguments:{reason:'login'}}});
  assert.equal(value.success,true);assert.equal(value.receipt.actionDispatched,true);assert.equal(value.receipt.outcome,'completed');
 }
 const createWindow=await gateway({name:'relay_connections',arguments:{action:'call',connectionId:'browseros-neo',name:'windows',arguments:{action:'create'}}});
 assert.equal(createWindow.success,true);
 assert.deepEqual(calls.map(call=>({name:call.name,args:call.args})),[{name:'request_human_help',args:{reason:'login'}},{name:'await_human_help',args:{reason:'login'}},{name:'windows',args:{action:'create'}}]);
 const instructions=signedBrowserInstructions({available:true,connectionId:'browseros-neo'});
 assert.match(instructions,/native human-help tools when the server advertises them/);
 assert.match(instructions,/may show browser UI or require user interaction/);
 assert.match(instructions,/native encryption, profile locks, browser connection consent and website authentication/);
 assert.doesNotMatch(instructions,/do not call BrowserOS request_human_help|finite background interface|fullPage:false/);
});

for(const failedResult of [false,true])test(`native capture reports a dispatched ${failedResult?'tool failure':'timeout'} without replay or publishing`,async()=>{
 const calls=[];
 const manager=managerFixture(async(_id,name,args)=>{calls.push({name,args});if(failedResult)return{isError:true,content:[{type:'text',text:'Capture failed.'}]};throw Object.assign(Error('Connected tool timed out.'),{code:'MCP_TIMEOUT'});});
 const gateway=createConnectionToolHandler({manager});
 const args={page:7,fullPage:true,size:{width:2200,height:1400}};
 const result=await gateway({name:'relay_connections',arguments:{action:'call',connectionId:'browseros-neo',name:'screenshot',arguments:args}});
 assert.equal(result.success,false);assert.match(result.contentItems[0].text,failedResult?/Capture failed/:/timed out/);
 assert.equal(result.receipt.actionDispatched,true);assert.equal(result.receipt.outcome,failedResult?'tool-error':'unknown');
 assert.deepEqual(calls,[{name:'screenshot',args}]);
});
