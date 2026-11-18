import test from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../lib/mcp.mjs';
import {executeConnectedBrowser} from '../lib/mcp.mjs';
import {chromeAutoConnectConnection} from '../lib/chrome-browser.mjs';
import {BROWSER_TOOL,createBrowserToolHandler} from '../lib/browser.mjs';
function fixture(configs, catalogs = new Map()) {
  const effects = [], clients = new Map();
  const manager = {
    configs: new Map(configs.map(config => [config.id, config])), clients, redact: String,
    list: () => configs.map(config => ({ ...config, connected: clients.has(config.id) })),
    init: async () => {},
    tools: async (id, { query = '' } = {}) => {
      effects.push(['discover', id]);
      const tools = catalogs.get(id) || [{ name: 'lookup_note', inputSchema: { type: 'object' } }];
      clients.set(id, { tools, connected: true });
      return { tools: tools.filter(tool => tool.name.includes(query)), total: tools.length };
    },
    connect: async id => { effects.push(['connect', id]); return clients.get(id); },
    call: async (id, name, args, options = {}) => { effects.push(['call', id, name]); options.onDispatch?.(); return { content: [{ type: 'text', text: 'Verified integration result' }] }; },
  };
  return { manager, effects };
}


test('generic connection gateway is absent while the contained browser retains its current target',()=>{
 for(const name of ['CONNECTION_TOOL','CONTAINED_CONNECTION_TOOL','createConnectionToolHandler'])assert.equal(Object.hasOwn(registry,name),false);
 assert.deepEqual(BROWSER_TOOL.inputSchema.properties.browser.enum,['relay']);
});
test('contained browser failure dispatches no native adapter and never falls back to an external integration',async()=>{
 let pages=0;const {manager,effects}=fixture([chromeAutoConnectConnection()]);
 const handler=createBrowserToolHandler({browser:{status:()=>({available:false,contained:false}),perform:async()=>{pages++;}},connections:manager});
 const result=await handler({name:'relay_browser',arguments:{action:'open',url:'https://example.test/'}});
 assert.equal(result.code,'BROWSER_UNAVAILABLE');assert.equal(pages,0);assert.deepEqual(effects,[]);
});
test('explicit specialized browser calls retain discovery, exact arguments and truthful dispatch',async()=>{
 const config={id:'browseros-neo',name:'BrowserOS Neo',enabled:true};
 const {manager,effects}=fixture([config],new Map([[config.id,[{name:'tabs'}]]]));
 const discovery=await executeConnectedBrowser({manager,action:'tools',connectionId:config.id});assert.equal(discovery.success,true);
 const result=await executeConnectedBrowser({manager,action:'call',connectionId:config.id,name:'tabs',arguments:{action:'list'}});
 assert.equal(result.success,true);assert.equal(result.receipt.actionDispatched,true);
 assert.deepEqual(effects,[['discover',config.id],['connect',config.id],['call',config.id,'tabs']]);
});
