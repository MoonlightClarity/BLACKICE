import test from 'node:test';
import assert from 'node:assert/strict';
import { CHROME_BROWSER_INSTRUCTIONS, CHROME_BROWSER_CONNECTION_ID, chromeAutoConnectConnection, chromeBackgroundOpen, chromeBackgroundArguments, chromeBrowserStatus, isManagedChromeConnection, registerChromeBrowser } from '../lib/chrome-browser.mjs';
import { parseConnectionImport } from '../lib/connection-import.mjs';

function fixture({ config, result = { content: [{type:'text',text:'## Pages\n1: https://private.fixture.test/ Private title'}] }, error, tools = [{name:'list_pages'}] } = {}) {
  let configurations=config ? [structuredClone(config)] : [];
  const operations=[], clients=new Map();
  const manager={clients, list(){operations.push(['list']);return configurations.map(config=>({...config,connected:!!clients.get(config.id)?.connected}));}, async init(){operations.push(['init']);}, async save(input){operations.push(['save',input]);configurations.push({...input});}, async connect(id,{signal}={}){operations.push(['connect',id]);if(error)throw error;const client={connected:true,tools}; clients.set(id,client);return client;}, async call(id,name,args,options){operations.push(['call',id,name,args,options]);return result;}};
  return{manager,operations};
}

test('Chrome configuration uses official autoConnect through Relay stdio without browser launch or profile-copy flags',()=>{
  const config=chromeAutoConnectConnection();
  assert.equal(config.transport,'stdio');assert.equal(config.command,'npx');assert.equal(config.id,CHROME_BROWSER_CONNECTION_ID);
  assert.deepEqual(config.args,['-y','chrome-devtools-mcp@latest','--autoConnect','--channel=stable','--no-usage-statistics','--no-performance-crux']);
  assert.equal(config.timeoutMs,60000);assert.equal(parseConnectionImport({connections:[config]}).candidates[0].args.includes('--autoConnect'),true);
  assert.doesNotMatch(config.args.join(' '),/headless|isolated|user-data-dir|browser-url|remote-debugging-port/);
});

test('Chrome background policy clamps only the actual foreground switches and preserves caller arguments',()=>{
  const open={url:'https://example.test/',background:false,timeout:1000};
  assert.deepEqual(chromeBackgroundArguments('new_page',open),{...open,background:true});assert.equal(open.background,false);
  assert.deepEqual(chromeBackgroundArguments('new_page',{...open,isolatedContext:'fresh-profile'}),{...open,background:true},'existing-session path must not create a signed-out isolated profile');
  assert.deepEqual(chromeBackgroundArguments('select_page',{pageId:3,bringToFront:true}),{pageId:3,bringToFront:false});
  assert.deepEqual(chromeBackgroundArguments('fill',{uid:'1_2',value:'fixture'}),{uid:'1_2',value:'fixture'});
  assert.deepEqual(chromeBackgroundOpen('https://example.test'),{name:'new_page',arguments:{url:'https://example.test/',background:true}});
  assert.throws(()=>chromeBackgroundOpen('file:///C:/private'),{code:'BROWSER_VALIDATION'});
  assert.match(CHROME_BROWSER_INSTRUCTIONS,/omit isolatedContext/);assert.match(CHROME_BROWSER_INSTRUCTIONS,/bringToFront:false/);assert.match(CHROME_BROWSER_INSTRUCTIONS,/does not prove sign-in/);
});

test('Only Relay managed exact Chrome autoConnect configurations receive the background policy',()=>{
  const config=chromeAutoConnectConnection();assert.equal(isManagedChromeConnection(config),true);
  for(const altered of [{...config,id:'custom-browser'},{...config,command:'another-server'},{...config,args:[...config.args,'--browser-url=http://localhost:9222']},{...config,args:['-y','chrome-devtools-mcp@latest']},{...config,args:[...config.args,'--user-data-dir=C:/different-profile']}])assert.equal(isManagedChromeConnection(altered),false);
  assert.equal(isManagedChromeConnection({...config,command:'C:\\Program Files\\nodejs\\npx.cmd'}),true);
});

test('Status refreshes perform no initialization, save, connect, browser probing or profile reads',()=>{
  const{manager,operations}=fixture({config:chromeAutoConnectConnection()});
  const status=chromeBrowserStatus({connections:manager});
  assert.equal(status.state,'disconnected');assert.equal(status.accountAuthenticated,'unknown');assert.equal(status.background,true);
  assert.deepEqual(operations,[['list']]);assert.equal(status.setup.url,'chrome://inspect/#remote-debugging');assert.match(status.setup.nativeConnectionPrompt,/each new debugging session/);
});

test('Explicit Connect saves once, verifies the browser with list_pages, and discards page details',async()=>{
  const{manager,operations}=fixture();
  const result=await registerChromeBrowser({connections:manager});
  assert.equal(result.state,'connected');assert.equal(result.browserConnected,true);assert.equal(result.accountAuthenticated,'unknown');assert.ok(result.verifiedAt);
  assert.doesNotMatch(JSON.stringify(result),/private.fixture|Private title/);
  assert.equal(operations.filter(([name])=>name==='save').length,1);
  assert.deepEqual(operations.find(([name])=>name==='call'),['call',CHROME_BROWSER_CONNECTION_ID,'list_pages',{}, {signal:undefined,browserSetup:true}]);
  await registerChromeBrowser({connections:manager});assert.equal(operations.filter(([name])=>name==='save').length,1,'existing matching config is preserved');
  manager.clients.clear();assert.equal(chromeBrowserStatus({connections:manager}).browserConnected,false,'disconnect invalidates the previous verification');
});

test('An MCP catalog connection alone never claims that Chrome or its account is connected',async()=>{
  const{manager}=fixture({config:chromeAutoConnectConnection()});await manager.connect(CHROME_BROWSER_CONNECTION_ID);
  const status=chromeBrowserStatus({connections:manager});assert.equal(status.serverConnected,true);assert.equal(status.browserConnected,false);assert.equal(status.state,'server-connected');
});

test('Explicit Connect preserves conflicting or disabled configurations without starting any process',async()=>{
  for(const config of [{...chromeAutoConnectConnection(),command:'custom-server'}, {...chromeAutoConnectConnection(),enabled:false}]){
    const{manager,operations}=fixture({config});const before=manager.list();operations.length=0;
    await assert.rejects(registerChromeBrowser({connections:manager}),{code:config.enabled===false?'CHROME_CONNECTION_DISABLED':'CHROME_CONNECTION_CONFLICT'});
    assert.deepEqual(manager.list(),before);assert.equal(operations.some(([name])=>['save','connect','call'].includes(name)),false);
  }
});

test('Chrome handshake failures return bounded setup guidance without propagating private results or exception text',async()=>{
  for(const options of [{error:new Error('private.fixture.test secret-ish detail')},{result:{isError:true,content:[{type:'text',text:'private.fixture.test private response'}]}},{result:{content:[]}}]){
    const{manager}=fixture(options);
    await assert.rejects(registerChromeBrowser({connections:manager}),error=>{assert.equal(error.code,'CHROME_SETUP_REQUIRED');assert.doesNotMatch(error.message,/private.fixture|secret-ish/);assert.ok(error.message.length<300);return true;});
    assert.equal(chromeBrowserStatus({connections:manager}).browserConnected,false);
  }
});

test('Chrome setup cancellation is preserved and a mismatched tool catalog does not imply browser readiness',async()=>{
  const{manager,operations}=fixture();const controller=new AbortController();controller.abort();
  await assert.rejects(registerChromeBrowser({connections:manager,signal:controller.signal}),{name:'AbortError'});assert.deepEqual(operations,[]);
  const wrong=fixture({tools:[{name:'different_tool'}]});await assert.rejects(registerChromeBrowser({connections:wrong.manager}),{code:'CHROME_TOOL_CATALOG'});
  assert.equal(wrong.operations.some(([name])=>name==='call'),false);
});
