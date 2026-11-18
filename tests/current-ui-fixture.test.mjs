import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFixture} from './next-fixture-server.mjs';
test('current UI fixture serves release Skills without loading a removed memory store',async t=>{
 const fixture=makeFixture();await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));await fixture.close();});
 const base='http://127.0.0.1:'+fixture.server.address().port;
 const get=route=>fetch(base+route);
 assert.equal((await get('/api/knowledge')).status,404);
 const catalog=await (await get('/api/skills')).json();assert.ok(catalog.entries.some(x=>x.id==='builtin-decomposition'));
 const detail=await (await get('/api/skills/builtin-decomposition')).json();assert.equal(detail.immutable,true);
 assert.deepEqual((await (await get('/api/skills/folders')).json()).folders,[]);
 assert.equal((await get('/next/core/folder-tree.mjs')).status,200);
 assert.equal(typeof fixture.close,'function');assert.equal('knowledge'in fixture,false);
});
