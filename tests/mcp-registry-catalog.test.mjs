
import test from 'node:test';import assert from 'node:assert/strict';import {searchMCPRegistry} from '../lib/mcp-registry-catalog.mjs';
test('catalog searches the fixed public registry and projects setup metadata only',async()=>{
 let called;
 const result=await searchMCPRegistry({query:' git ',cursor:'page',fetchImpl:async(url,options)=>{called=String(url);assert.equal(options.redirect,'error');return new Response(JSON.stringify({servers:[{server:{name:'example/git',description:'tools',websiteUrl:'javascript:bad',remotes:[null,{type:'streamable-http',url:'https://tools.example/mcp'},{type:'streamable-http',url:'https://user:secret@host.test'}],packages:[null]}}],metadata:{nextCursor:'next'}}));}});
 assert.match(called,/registry.modelcontextprotocol.io/);assert.match(called,/search=git/);assert.match(called,/cursor=page/);
 assert.deepEqual(result.servers[0].endpoints,['https://tools.example/mcp']);assert.equal(result.servers[0].website,'');assert.equal(result.nextCursor,'next');
});
test('catalog bounds invalid input and upstream errors',async()=>{
 await assert.rejects(searchMCPRegistry({query:'x'.repeat(257)}));
 await assert.rejects(searchMCPRegistry({fetchImpl:async()=>new Response('',{status:503})}),/unavailable/);
 await assert.rejects(searchMCPRegistry({fetchImpl:async()=>new Response('{}')}),/Invalid/);
});
