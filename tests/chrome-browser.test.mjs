import test from 'node:test';
import assert from 'node:assert/strict';
import { CHROME_BROWSER_INSTRUCTIONS, CHROME_BROWSER_CONNECTION_ID, chromeAutoConnectConnection, chromeBackgroundOpen, chromeBackgroundArguments, chromeBrowserStatus, isManagedChromeConnection, isChromeBrowserConnection, registerChromeBrowser } from '../lib/chrome-browser.mjs';
import { parseConnectionImport } from '../lib/connection-import.mjs';

function fixture({ config, result = { content: [{type:'text',text:'## Pages\n1: https://private.fixture.test/ Private title'}] }, error, tools = [{name:'list_pages'}] } = {}) {
  let configurations=config ? [structuredClone(config)] : [];
  const operations=[], clients=new Map();
  const manager={clients, list(){operations.push(['list']);return configurations.map(config=>({...config,connected:!!clients.get(config.id)?.connected}));}, async init(){operations.push(['init']);}, async save(input){operations.push(['save',input]);configurations=[...configurations.filter(config=>config.id!==input.id),{...input}];}, async connect(id,{signal}={}){operations.push(['connect',id]);if(error)throw error;const client={connected:true,tools}; clients.set(id,client);return client;}, async call(id,name,args,options){operations.push(['call',id,name,args,options]);return result;}};
  return{manager,operations};
}

test('Chrome configuration uses official autoConnect through Relay stdio without browser launch or profile-copy flags',()=>{
  const config=chromeAutoConnectConnection();
  assert.equal(config.transport,'stdio');assert.equal(config.command,'npx');assert.equal(config.id,CHROME_BROWSER_CONNECTION_ID);
  assert.deepEqual(config.args,['-y','chrome-devtools-mcp@1.11.0','--autoConnect','--channel=stable','--no-usage-statistics','--no-performance-crux']);
  assert.equal(config.timeoutMs,60000);assert.equal(parseConnectionImport({connections:[config]}).candidates[0].args.includes('--autoConnect'),true);
  assert.doesNotMatch(config.args.join(' '),/headless|isolated|user-data-dir|browser-url|remote-debugging-port/);
});

test('Chrome defaults background behavior and preserves explicit foreground and isolation choices',()=>{
  const open={url:'https://example.test/',background:false,timeout:1000};
  assert.deepEqual(chromeBackgroundArguments('new_page',open),open);assert.equal(open.background,false);
  assert.deepEqual(chromeBackgroundArguments('new_page',{url:open.url}),{url:open.url,background:true});
  assert.deepEqual(chromeBackgroundArguments('new_page',{...open,isolatedContext:'fresh-profile'}),{...open,isolatedContext:'fresh-profile'},'explicit isolation is a caller choice');
  assert.deepEqual(chromeBackgroundArguments('select_page',{pageId:3,bringToFront:true}),{pageId:3,bringToFront:true});
  assert.deepEqual(chromeBackgroundArguments('fill',{uid:'1_2',value:'fixture'}),{uid:'1_2',value:'fixture'});
  assert.deepEqual(chromeBackgroundOpen('https://example.test'),{name:'new_page',arguments:{url:'https://example.test/',background:true}});
  assert.throws(()=>chromeBackgroundOpen('file:///C:/private'),{code:'BROWSER_VALIDATION'});
  assert.match(CHROME_BROWSER_INSTRUCTIONS,/omit isolatedContext/);assert.match(CHROME_BROWSER_INSTRUCTIONS,/bringToFront:false/);assert.match(CHROME_BROWSER_INSTRUCTIONS,/does not prove sign-in/);
});

test('only exact managed Chrome autoConnect configurations use the live-session attach state',()=>{
  const config=chromeAutoConnectConnection();assert.equal(isManagedChromeConnection(config),true);
  for(const altered of [{...config,id:'custom-browser'},{...config,command:'another-server'},{...config,args:[...config.args,'--browser-url=http://localhost:9222']},{...config,args:['-y','chrome-devtools-mcp@latest']},{...config,args:[...config.args,'--user-data-dir=C:/different-profile']}])assert.equal(isManagedChromeConnection(altered),false);
  assert.equal(isManagedChromeConnection({...config,command:'C:\\Program Files\\nodejs\\npx.cmd'}),true);
});

test('official native profile launchers are identified separately from the managed live session',()=>{
  const live=chromeAutoConnectConnection();
  const profile={...live,id:'browser-profile-0123456789abcdef',args:['-y','chrome-devtools-mcp@latest','--executablePath=C:/Browser/chrome.exe','--userDataDir=C:/Profiles/imported']};
  assert.equal(isChromeBrowserConnection(live),true);assert.equal(isChromeBrowserConnection(profile),true);assert.equal(isManagedChromeConnection(profile),false);
  assert.equal(isChromeBrowserConnection({...profile,command:'C:\\Tools\\chrome-devtools-mcp.cmd',args:profile.args.slice(2)}),true);
  for(const config of [{...profile,command:'unrelated-server'},{...profile,args:['-y','unrelated-mcp','chrome-devtools-mcp is mentioned in data']},{id:profile.id,transport:'http',url:'http://127.0.0.1:1234/mcp'}])assert.equal(isChromeBrowserConnection(config),false);
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

test('only explicit Connect upgrades the exact legacy generated package and preserves the selected channel',async()=>{
  const config=chromeAutoConnectConnection({channel:'beta',command:'C:\\Program Files\\nodejs\\npx.cmd',timeoutMs:90000});
  config.args[1]='chrome-devtools-mcp@latest';
  const {manager,operations}=fixture({config});
  assert.equal(chromeBrowserStatus({connections:manager}).state,'disconnected');
  assert.deepEqual(operations,[['list']]);assert.equal(manager.list()[0].args[1],'chrome-devtools-mcp@latest');
  await registerChromeBrowser({connections:manager});
  const saved=operations.filter(([name])=>name==='save');assert.equal(saved.length,1);
  assert.deepEqual(saved[0][1].args,['-y','chrome-devtools-mcp@1.11.0','--autoConnect','--channel=beta','--no-usage-statistics','--no-performance-crux']);
  assert.equal(saved[0][1].command,config.command);assert.equal(saved[0][1].timeoutMs,90000);
  await registerChromeBrowser({connections:manager});assert.equal(operations.filter(([name])=>name==='save').length,1);
});

test('Explicit Connect preserves conflicting or disabled configurations without starting any process',async()=>{
  const legacy=chromeAutoConnectConnection();legacy.args[1]='chrome-devtools-mcp@latest';
  const otherVersion=chromeAutoConnectConnection();otherVersion.args[1]='chrome-devtools-mcp@1.12.0';
  for(const config of [{...chromeAutoConnectConnection(),command:'custom-server'}, {...chromeAutoConnectConnection(),enabled:false}, {...legacy,enabled:false}, {...legacy,args:[...legacy.args,'--browser-url=http://localhost:9222']}, otherVersion]){
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
