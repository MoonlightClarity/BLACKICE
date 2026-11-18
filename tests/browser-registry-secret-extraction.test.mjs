import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ConnectionManager} from '../lib/mcp.mjs';
import {chromeAutoConnectConnection} from '../lib/chrome-browser.mjs';
test('one-time browser extraction preserves sealed credentials without unlocking unrelated registry secrets',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-browser-secret-extraction-')),archive=path.join(root,'connections.json');
 const browser={...chromeAutoConnectConnection(),secret:{encoding:'string',data:'sealed-browser-fixture'}},generic={id:'generic',name:'Generic',transport:'stdio',command:'node',args:[],secret:{encoding:'string',data:'must-not-decrypt'}};
 const bytes=JSON.stringify({version:1,connections:[generic,browser]});await writeFile(archive,bytes);
 const decrypted=[];const manager=new ConnectionManager({dataDir:root,decryptSecret:sealed=>{decrypted.push(sealed);assert.equal(sealed,'sealed-browser-fixture');return JSON.stringify({env:{FIXTURE_KEY:'private-fixture'},headers:{}});}});
 t.after(async()=>{await manager.close();await rm(root,{recursive:true,force:true});});await manager.init();
 assert.deepEqual(decrypted,['sealed-browser-fixture']);assert.equal(manager.secrets.get('chrome-live').env.FIXTURE_KEY,'private-fixture');
 assert.doesNotMatch(JSON.stringify(manager.list()),/private-fixture|sealed-browser-fixture|must-not-decrypt/);
 assert.deepEqual(JSON.parse(await readFile(path.join(root,'browser-connections', 'settings.json'),'utf8')).connections,[browser]);assert.equal(await readFile(archive,'utf8'),bytes);
});
